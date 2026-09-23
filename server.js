// ─── server.js ──────────────────────────────────────────────

const express = require('express');
const cors = require('cors');
const dotenv = require('dotenv');
const crypto = require('crypto');
const { createClient } = require('@supabase/supabase-js');

dotenv.config();

const app = express();

// ─── CORS ────────────────────────────────────────────────────
app.use(cors());
app.use(express.json({ limit: '3mb' }));
app.use(express.urlencoded({ extended: true, limit: '3mb' }));
app.use(express.static(__dirname));

// ─── SUPABASE ────────────────────────────────────────────────

const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY,
    {
        auth: {
            persistSession: false,
            autoRefreshToken: false,
            detectSessionInUrl: false
        }
    }
);

console.log(
    'Supabase service role key loaded:',
    !!process.env.SUPABASE_SERVICE_ROLE_KEY
);
if (!process.env.SUPABASE_SERVICE_ROLE_KEY) {
    console.error('CRITICAL: SUPABASE_SERVICE_ROLE_KEY is missing — job inserts will hit RLS.');
}

// Diagnostic: verify service role key
try {
    const parts = String(
        process.env.SUPABASE_SERVICE_ROLE_KEY || ''
    ).split('.');

    if (parts.length === 3) {
        let b64 = parts[1].replace(/-/g, '+').replace(/_/g, '/');

        while (b64.length % 4) {
            b64 += '=';
        }

        const payload = JSON.parse(
            Buffer.from(b64, 'base64').toString('utf8')
        );

        console.log(
            'Supabase key role:',
            payload.role || '(unknown)'
        );

        if (payload.role !== 'service_role') {
            console.warn(
                '⚠️ SUPABASE_SERVICE_ROLE_KEY does not look like a service_role key.'
            );
        }
    } else {
        console.warn(
            'SUPABASE_SERVICE_ROLE_KEY does not look like a valid JWT.'
        );
    }
} catch (e) {
    console.warn(
        'Could not decode SUPABASE_SERVICE_ROLE_KEY:',
        e.message
    );
}

// ─── PAYSTACK ────────────────────────────────────────────────

const PAYSTACK_SECRET_KEY = process.env.PAYSTACK_SECRET_KEY;
const PAYSTACK_PUBLIC_KEY = process.env.PAYSTACK_PUBLIC_KEY;

// ─── PLANS ──────────────────────────────────────────────────

const PLANS = {
    free: {
        amount: 0,
        name: 'Free',
        features:
            '25 jobs/mo, 25 clients, 3 staff, 15 invoices/mo, 30 WhatsApp/mo, 10 inventory',
        limits: {
            jobs: 25,
            clients: 25,
            staff: 3,
            invoices: 15,
            whatsapp_messages: 30,
            inventory: 10
        },
        monthly: [
            'jobs',
            'invoices',
            'whatsapp_messages'
        ]
    },

    starter: {
        amount: 1250000,
        name: 'Unlimited',
        features:
            'Unlimited jobs, clients, staff, invoices, WhatsApp & inventory',
        limits: {
            jobs: Infinity,
            clients: Infinity,
            staff: Infinity,
            invoices: Infinity,
            whatsapp_messages: Infinity,
            inventory: Infinity
        },
        monthly: []
    },

    professional: {
        amount: 1750000,
        name: 'Professional',
        features:
            'Unlimited jobs, clients, staff, invoices, WhatsApp & inventory',
        limits: {
            jobs: Infinity,
            clients: Infinity,
            staff: Infinity,
            invoices: Infinity,
            whatsapp_messages: Infinity,
            inventory: Infinity
        },
        monthly: []
    },

    enterprise: {
        amount: 3500000,
        name: 'Enterprise',
        features:
            'Everything in Professional + team access & advanced reporting',
        limits: {
            jobs: Infinity,
            clients: Infinity,
            staff: Infinity,
            invoices: Infinity,
            whatsapp_messages: Infinity,
            inventory: Infinity,
            team_access: true,
            advanced_reporting: true
        },
        monthly: []
    }
};


/*
 * Pay-as-you-go job credits (amount in kobo).
 * After the 25 lifetime free jobs, users buy these packs.
 */
const CREDIT_PACKS = {
    // Primary packs (simplified pricing)
    starter: { name: 'Starter Pack', amount: 500000, jobs: 25 },       // ₦5,000  · ₦200/job
    growth:  { name: 'Growth Pack',  amount: 1200000, jobs: 80 },      // ₦12,000 · ₦150/job
    scale:   { name: 'Scale Pack',   amount: 2500000, jobs: 200 },     // ₦25,000 · ₦125/job
    // Aliases so older clients / bookmarks still work
    business:     { name: 'Growth Pack',  amount: 1200000, jobs: 80 },
    professional: { name: 'Growth Pack',  amount: 1200000, jobs: 80 },
    enterprise:   { name: 'Scale Pack',   amount: 2500000, jobs: 200 }
};

const FRONTEND_URL =
    process.env.FRONTEND_URL ||
    'https://cleancrewapp.com';

// ─── AUTHENTICATION ──────────────────────────────────────────

const authenticate = async (req, res, next) => {
    try {
        const token =
            req.headers.authorization?.split(' ')[1];

        if (!token) {
            return res.status(401).json({
                error: 'Unauthorized'
            });
        }

        const {
            data: { user },
            error
        } = await supabase.auth.getUser(token);

        if (error || !user) {
            return res.status(401).json({
                error: 'Invalid token'
            });
        }

        if (!user.email_confirmed_at) {
            return res.status(403).json({
                error:
                    'Please confirm your email address before accessing the dashboard.',
                requires_confirmation: true
            });
        }

        req.user = user;
        next();
    } catch (error) {
        console.error('Authentication error:', error);

        return res.status(401).json({
            error: 'Authentication failed'
        });
    }
};

// ─── PLAN HELPERS ────────────────────────────────────────────

async function checkPlanLimit(userId, type) {
    const {
        data: sub,
        error: subError
    } = await supabase
        .from('subscriptions')
        .select('plan, status')
        .eq('user_id', userId)
        .maybeSingle();

    if (
        subError &&
        subError.code !== 'PGRST116'
    ) {
        throw new Error(
            'Error checking subscription'
        );
    }

    let planName = sub?.plan || 'free';

    if (!PLANS[planName]) {
        planName = 'free';
    }

    const limit =
        PLANS[planName]?.limits?.[type];

    if (limit === undefined) {
        return {
            allowed: true,
            limit: Infinity,
            plan: planName,
            count: 0
        };
    }

    if (limit === Infinity) {
        return {
            allowed: true,
            limit: Infinity,
            plan: planName,
            count: 0
        };
    }

    // Inventory unlock: free tier = 10 items.
    // Anyone with job credits (> 0) can add more — same as Unlimited sub.
    // Existing items are never removed when credits run out; only new adds are blocked.
    if (type === 'inventory') {
        let credits = 0;
        try {
            credits = await getCreditBalance(userId);
        } catch (eCred) {
            console.warn('inventory limit credit check:', eCred.message || eCred);
            credits = 0;
        }
        if (Number(credits) > 0) {
            return {
                allowed: true,
                limit: Infinity,
                plan: planName,
                count: 0,
                unlock: 'credits'
            };
        }
    }

    const isMonthly =
        (PLANS[planName].monthly || []).includes(type);

    let query;

    if (type === 'whatsapp_messages') {
        query = supabase
            .from('usage_events')
            .select('*', {
                count: 'exact',
                head: true
            })
            .eq('user_id', userId)
            .eq(
                'action_type',
                'whatsapp_sent'
            );
    } else {
        query = supabase
            .from(type)
            .select('*', {
                count: 'exact',
                head: true
            })
            .eq('user_id', userId);
    }

    if (isMonthly) {
        const start = new Date();

        start.setDate(1);
        start.setHours(0, 0, 0, 0);

        query = query.gte(
            'created_at',
            start.toISOString()
        );
    }

    const {
        count,
        error: countError
    } = await query;

    if (countError) {
        if (
            type === 'whatsapp_messages'
        ) {
            console.warn(
                'WhatsApp usage count skipped:',
                countError.message
            );

            return {
                allowed: true,
                limit,
                count: 0,
                plan: planName
            };
        }

        throw new Error(
            'Error counting items'
        );
    }

    const currentCount = count || 0;

    if (currentCount >= limit) {
        const period = isMonthly
            ? ' this month'
            : '';

        return {
            allowed: false,
            limit,
            count: currentCount,
            plan: planName,
            code: 'LIMIT_REACHED',
            message:
                type === 'inventory'
                    ? `Free accounts can track up to ${limit} inventory items. Buy job credits or go Unlimited to add more.`
                    : `You've reached your ${PLANS[planName].name} plan limit of ${limit} ${type.replace(/_/g, ' ')}${period}. Upgrade or buy credits to continue.`
        };
    }

    return {
        allowed: true,
        limit,
        count: currentCount,
        plan: planName
    };
}

async function getUserPlan(userId) {
    const {
        data: sub,
        error
    } = await supabase
        .from('subscriptions')
        .select('plan')
        .eq('user_id', userId)
        .maybeSingle();

    if (
        error &&
        error.code !== 'PGRST116'
    ) {
        throw new Error(
            'Error fetching subscription'
        );
    }

    return sub?.plan || 'free';
}

// ─── CREDIT SYSTEM ──────────────────────────────────────────

/*
 * IMPORTANT:
 *
 * Credit balances are controlled by the backend using the
 * Supabase service-role client.
 *
 * We do NOT depend on usage_events for credits.
 *
 * credit_wallets:
 *     stores current balance
 *
 * credit_transactions:
 *     stores the audit history
 */

// ─── Get credit balance ─────────────────────────────────────

async function getCreditBalance(userId) {
    const {
        data,
        error
    } = await supabase
        .from('credit_wallets')
        .select('balance')
        .eq('user_id', userId)
        .maybeSingle();

    if (error) {
        console.error('getCreditBalance:', error.message);
        // Do not crash the whole dashboard for credits UI
        if (/row-level security|RLS/i.test(error.message || '')) {
            return 0;
        }
        throw new Error(
            'Failed to fetch credit balance: ' +
            error.message
        );
    }

    return Number(data?.balance || 0);
}

// ─── Ensure wallet exists ───────────────────────────────────

async function ensureCreditWallet(userId) {
    const {
        data,
        error
    } = await supabase
        .from('credit_wallets')
        .upsert(
            {
                user_id: userId,
                balance: 0,
                updated_at:
                    new Date().toISOString()
            },
            {
                onConflict: 'user_id',
                ignoreDuplicates: true
            }
        )
        .select('user_id, balance')
        .maybeSingle();

    if (error) {
        throw new Error(
            'Failed to create credit wallet: ' +
            error.message
        );
    }

    return data;
}

// ─── Add credits ─────────────────────────────────────────────

async function addCredits(
    userId,
    amount,
    description,
    reference = null,
    metadata = {}
) {
    amount = Number(amount);

    if (
        !Number.isInteger(amount) ||
        amount <= 0
    ) {
        throw new Error(
            'Credit amount must be a positive integer'
        );
    }

    await ensureCreditWallet(userId);

    // De-dupe Paystack (and any) purchase by reference
    if (reference) {
        const { data: existing } = await supabase
            .from('credit_transactions')
            .select('id, balance_after')
            .eq('type', 'purchase')
            .eq('reference', reference)
            .maybeSingle();

        if (existing) {
            return {
                balance: Number(existing.balance_after || 0),
                amount_added: 0,
                already_processed: true
            };
        }
    }

    const {
        data: wallet,
        error: walletError
    } = await supabase
        .from('credit_wallets')
        .select('balance')
        .eq('user_id', userId)
        .single();

    if (walletError) {
        throw new Error(
            'Failed to fetch credit wallet: ' +
            walletError.message
        );
    }

    const currentBalance = Number(wallet.balance || 0);
    const newBalance = currentBalance + amount;

    const {
        data: updatedWallet,
        error: updateError
    } = await supabase
        .from('credit_wallets')
        .update({
            balance: newBalance,
            updated_at: new Date().toISOString()
        })
        .eq('user_id', userId)
        .select('balance')
        .single();

    if (updateError) {
        throw new Error(
            'Failed to update credit balance: ' +
            updateError.message
        );
    }

    const finalBalance = Number(updatedWallet.balance);

    const { error: txError } = await supabase
        .from('credit_transactions')
        .insert({
            user_id: userId,
            type: 'purchase',
            amount,
            balance_after: finalBalance,
            description,
            reference,
            metadata
        });

    if (txError) {
        if (txError.code === '23505' || /duplicate|unique/i.test(txError.message || '')) {
            return {
                balance: await getCreditBalance(userId),
                amount_added: 0,
                already_processed: true
            };
        }
        console.error(
            'Failed to log credit purchase:',
            txError.message
        );
    }

    return {
        balance: finalBalance,
        amount_added: amount,
        already_processed: false
    };
}

// ─── Consume one credit ─────────────────────────────────────

async function consumeCredit(
    userId,
    description,
    resourceId = null
) {
    /*
     * IMPORTANT:
     *
     * We first check the balance, then perform a conditional
     * update:
     *
     *     balance = balance - 1
     *     WHERE balance > 0
     *
     * This means we never intentionally allow a negative balance.
     */

    await ensureCreditWallet(userId);

    const {
        data: wallet,
        error: walletError
    } = await supabase
        .from('credit_wallets')
        .select('balance')
        .eq('user_id', userId)
        .single();

    if (walletError) {
        throw new Error(
            'Failed to fetch credit wallet: ' +
            walletError.message
        );
    }

    const currentBalance =
        Number(wallet.balance || 0);

    if (currentBalance < 1) {
        return {
            success: false,
            balance: currentBalance,
            message: 'Insufficient credits'
        };
    }

    /*
     * Conditional update.
     *
     * If another request has already consumed the final credit,
     * this update returns no row and we reject the operation.
     */
    const {
        data: updatedWallet,
        error: updateError
    } = await supabase
        .from('credit_wallets')
        .update({
            balance: currentBalance - 1,
            updated_at:
                new Date().toISOString()
        })
        .eq('user_id', userId)
        .eq('balance', currentBalance)
        .gt('balance', 0)
        .select('balance')
        .maybeSingle();

    if (updateError) {
        throw new Error(
            'Failed to consume credit: ' +
            updateError.message
        );
    }

    if (!updatedWallet) {
        return {
            success: false,
            balance:
                await getCreditBalance(userId),
            message:
                'Credit balance changed. Please try again.'
        };
    }

    const newBalance =
        Number(updatedWallet.balance);

    // Log usage.
    const {
        error: txError
    } = await supabase
        .from('credit_transactions')
        .insert({
            user_id: userId,
            type: 'usage',
            amount: -1,
            balance_after: newBalance,
            description,
            metadata: {
                resource_id: resourceId
            }
        });

    if (txError) {
        console.error(
            'Failed to log credit usage:',
            txError.message
        );
    }

    return {
        success: true,
        balance: newBalance
    };
}

// ─── Lifetime free jobs (NOT monthly) ───────────────────────
// Product rule: every account gets 25 free jobs for life.
// After that → job credits (PAYG) or a paid unlimited plan.

const LIFETIME_FREE_JOBS = 25;

/** Insert row; if PostgREST complains about unknown columns, strip them and retry. */
async function insertWithSchemaFallback(table, row, optionalKeys) {
    optionalKeys = optionalKeys || [];
    let attempt = await supabase.from(table).insert(row).select().single();
    if (!attempt.error) return attempt;

    const msg = attempt.error.message || String(attempt.error);
    if (!/column|schema cache|Could not find/i.test(msg)) {
        return attempt;
    }

    const stripped = Object.assign({}, row);
    optionalKeys.forEach(function (k) { delete stripped[k]; });

    // Also strip the specific column named in the error, if any
    const m = msg.match(/'([^']+)' column/i) || msg.match(/column "([^"]+)"/i);
    if (m && m[1]) delete stripped[m[1]];

    // Drop nulls that may map to missing optional columns
    Object.keys(stripped).forEach(function (k) {
        if (stripped[k] === null || stripped[k] === undefined) {
            if (k !== 'user_id') delete stripped[k];
        }
    });

    console.warn('Schema fallback on', table, ':', msg);
    return await supabase.from(table).insert(stripped).select().single();
}

async function updateWithSchemaFallback(table, id, userId, updates, optionalKeys) {
    optionalKeys = optionalKeys || [];
    const clean = Object.assign({}, updates);
    delete clean.id;
    delete clean.user_id;

    let attempt = await supabase
        .from(table)
        .update(clean)
        .eq('id', id)
        .eq('user_id', userId)
        .select()
        .single();

    if (!attempt.error) return attempt;

    const msg = attempt.error.message || String(attempt.error);
    if (!/column|schema cache|Could not find/i.test(msg)) {
        return attempt;
    }

    optionalKeys.forEach(function (k) { delete clean[k]; });
    const m = msg.match(/'([^']+)' column/i) || msg.match(/column "([^"]+)"/i);
    if (m && m[1]) delete clean[m[1]];

    console.warn('Schema fallback update on', table, ':', msg);
    return await supabase
        .from(table)
        .update(clean)
        .eq('id', id)
        .eq('user_id', userId)
        .select()
        .single();
}



async function getLifetimeJobsUsed(userId) {
    const {
        count,
        error
    } = await supabase
        .from('jobs')
        .select('*', {
            count: 'exact',
            head: true
        })
        .eq('user_id', userId);

    if (error) {
        throw error;
    }

    return count || 0;
}

async function getFreeJobsRemaining(userId) {
    const used = await getLifetimeJobsUsed(userId);
    return Math.max(0, LIFETIME_FREE_JOBS - used);
}

/** Starter plan: 50 jobs per calendar month (subscription perk). */
async function getStarterJobsRemainingThisMonth(userId) {
    const start = new Date();
    start.setDate(1);
    start.setHours(0, 0, 0, 0);

    const {
        count,
        error
    } = await supabase
        .from('jobs')
        .select('*', {
            count: 'exact',
            head: true
        })
        .eq('user_id', userId)
        .gte('created_at', start.toISOString());

    if (error) {
        throw error;
    }

    const limit = PLANS.starter.limits.jobs; // 50
    return {
        limit,
        used: count || 0,
        remaining: Math.max(0, limit - (count || 0))
    };
}

// ─── Can create job ─────────────────────────────────────────
// Order:
// 1) Pro / Enterprise (active) → unlimited
// 2) Starter (active) → 50 jobs this month, then credits
// 3) Free lifetime pool (25 total jobs ever) → no credit charge
// 4) Job credits (PAYG)
// 5) Block

async function canCreateJob(userId) {
    const [subResult, usedLifetime, creditBalance] = await Promise.all([
        supabase
            .from('subscriptions')
            .select('plan, status')
            .eq('user_id', userId)
            .maybeSingle(),
        getLifetimeJobsUsed(userId),
        getCreditBalance(userId).catch(function () { return 0; })
    ]);

    const sub = subResult.data;
    const subError = subResult.error;
    if (subError && subError.code !== 'PGRST116') {
        throw new Error('Error checking subscription');
    }

    // Only exact known paid plan names unlock paid limits.
    // Anything else (null, typo, empty) is treated as free.
    let plan = 'free';
    if (sub && sub.plan && PLANS[sub.plan]) {
        plan = sub.plan;
    }
    const status = (sub && sub.status) ? String(sub.status).toLowerCase() : 'active';
    const active = status === 'active' || status === 'trial';

    const freeLeft = Math.max(0, LIFETIME_FREE_JOBS - usedLifetime);

    console.log('[canCreateJob]', {
        userId,
        plan,
        status,
        active,
        usedLifetime,
        freeLeft,
        creditBalance
    });

    // 1) Unlimited plans ONLY when active professional/enterprise
    if (
        active &&
        (plan === 'professional' || plan === 'enterprise')
    ) {
        return {
            allowed: true,
            source: 'subscription',
            plan,
            used: usedLifetime,
            free_remaining: freeLeft,
            credits: creditBalance
        };
    }

    // 2) Starter subscription — monthly included jobs, then credits
    if (active && plan === 'starter') {
        const starter = await getStarterJobsRemainingThisMonth(userId);
        if (starter.remaining > 0) {
            return {
                allowed: true,
                source: 'starter',
                plan: 'starter',
                remaining: starter.remaining,
                limit: starter.limit,
                used: starter.used,
                credits: creditBalance
            };
        }
        if (creditBalance > 0) {
            return {
                allowed: true,
                source: 'credit',
                balance: creditBalance,
                plan: 'starter'
            };
        }
        return {
            allowed: false,
            source: 'none',
            plan: 'starter',
            message:
                "You've used all 50 Starter jobs this month and have no credits left. Buy credits or go Unlimited."
        };
    }

    // 3) Free tier — HARD CAP: 25 jobs lifetime (count of rows in jobs for this user)
    if (usedLifetime < LIFETIME_FREE_JOBS) {
        return {
            allowed: true,
            source: 'free',
            plan: 'free',
            remaining: freeLeft,
            limit: LIFETIME_FREE_JOBS,
            used: usedLifetime,
            credits: creditBalance
        };
    }

    // 4) After free pool exhausted → credits only
    if (creditBalance > 0) {
        return {
            allowed: true,
            source: 'credit',
            balance: creditBalance,
            plan: 'free',
            used: usedLifetime,
            free_remaining: 0
        };
    }

    // 5) Block — no free jobs, no credits, not on paid unlimited
    return {
        allowed: false,
        source: 'none',
        plan: 'free',
        used: usedLifetime,
        free_remaining: 0,
        credits: 0,
        message:
            "You've used all 25 free jobs and have no credits remaining. Buy credits or upgrade to Unlimited (₦12,500/mo)."
    };
}

// ─── TEST ────────────────────────────────────────────────────

app.get('/api/test', (req, res) => {
    res.json({
        message: 'CORS is working!',
        time: new Date().toISOString()
    });
});

// ─── AUTH: SIGNUP ────────────────────────────────────────────

app.post('/api/auth/signup', async (req, res) => {
    try {
        const {
            name,
            email,
            password
        } = req.body;

        if (!name || !email || !password) {
            return res.status(400).json({
                error: 'All fields are required'
            });
        }

        const {
            data: authData,
            error: authError
        } = await supabase.auth.signUp({
            email,
            password,
            options: {
                data: { name },
                emailRedirectTo:
                    `${FRONTEND_URL}/login.html?confirmed=1`
            }
        });

        if (authError) {
            throw authError;
        }

        await supabase
            .from('subscriptions')
            .insert({
                user_id: authData.user.id,
                status: 'active',
                trial_end: null,
                plan: 'free'
            });

        // Create the credit wallet immediately (non-fatal if RLS/DB hiccup).
        try {
            await ensureCreditWallet(authData.user.id);
        } catch (walletErr) {
            console.error(
                'Credit wallet on signup (non-fatal):',
                walletErr.message || walletErr
            );
        }

        res.json({
            success: true,
            user: authData.user,
            requires_confirmation: true,
            message:
                'Please check your email to confirm your account.'
        });

    } catch (error) {
        console.error(
            'Signup error:',
            error
        );

        res.status(400).json({
            error: error.message
        });
    }
});

// ─── AUTH: LOGIN ─────────────────────────────────────────────

app.post('/api/auth/login', async (req, res) => {
    try {
        const {
            email,
            password
        } = req.body;

        if (!email || !password) {
            return res.status(400).json({
                error:
                    'Email and password are required'
            });
        }

        const {
            data: authData,
            error: authError
        } = await supabase.auth.signInWithPassword({
            email,
            password
        });

        if (authError) {
            throw authError;
        }

        if (!authData.user.email_confirmed_at) {
            return res.status(403).json({
                error:
                    'Please confirm your email address before logging in. Check your inbox for the confirmation link.',
                requires_confirmation: true,
                email
            });
        }

        const {
            data: sub
        } = await supabase
            .from('subscriptions')
            .select('*')
            .eq('user_id', authData.user.id)
            .maybeSingle();

        try {
            await ensureCreditWallet(authData.user.id);
        } catch (walletErr) {
            console.error(
                'Credit wallet on login (non-fatal):',
                walletErr.message || walletErr
            );
        }

        res.json({
            token:
                authData.session.access_token,

            refresh_token:
                authData.session.refresh_token,

            expires_in:
                authData.session.expires_in,

            user: {
                id: authData.user.id,
                email:
                    authData.user.email,

                name:
                    authData.user.user_metadata?.name,

                subscription:
                    sub || {
                        status: 'active',
                        plan: 'free'
                    }
            }
        });

    } catch (error) {
        console.error(
            'Login error:',
            error
        );

        res.status(401).json({
            error: error.message
        });
    }
});

// ─── AUTH: REFRESH ───────────────────────────────────────────

app.post('/api/auth/refresh', async (req, res) => {
    try {
        const {
            refresh_token
        } = req.body;

        if (!refresh_token) {
            return res.status(400).json({
                error:
                    'refresh_token is required'
            });
        }

        const {
            data,
            error
        } = await supabase.auth.refreshSession({
            refresh_token
        });

        if (
            error ||
            !data.session
        ) {
            return res.status(401).json({
                error:
                    'Invalid or expired refresh token'
            });
        }

        res.json({
            token:
                data.session.access_token,

            refresh_token:
                data.session.refresh_token,

            expires_in:
                data.session.expires_in
        });

    } catch (error) {
        console.error(
            'Token refresh error:',
            error
        );

        res.status(401).json({
            error: error.message
        });
    }
});

// ─── AUTH: PASSWORD RESET ───────────────────────────────────

app.post(
    '/api/auth/reset-password',
    async (req, res) => {
        try {
            const { email } = req.body;

            if (!email) {
                return res.status(400).json({
                    error: 'Email is required'
                });
            }

            const {
                error
            } = await supabase.auth.resetPasswordForEmail(
                email,
                {
                    redirectTo:
                        `${FRONTEND_URL}/reset-password.html`
                }
            );

            if (error) {
                throw error;
            }

            res.json({
                success: true,
                message:
                    'Password reset email sent'
            });

        } catch (error) {
            console.error(
                'Password reset error:',
                error
            );

            res.status(500).json({
                error: error.message
            });
        }
    }
);

// ─── AUTH: RESEND CONFIRMATION ──────────────────────────────

app.post(
    '/api/auth/resend-confirmation',
    async (req, res) => {
        try {
            const { email } = req.body;

            if (!email) {
                return res.status(400).json({
                    error:
                        'Email is required'
                });
            }

            const {
                error
            } = await supabase.auth.resend({
                type: 'signup',
                email,
                options: {
                    emailRedirectTo:
                        `${FRONTEND_URL}/login.html?confirmed=1`
                }
            });

            if (error) {
                throw error;
            }

            res.json({
                success: true,
                message:
                    'Confirmation email resent successfully. Please check your inbox.'
            });

        } catch (error) {
            console.error(
                'Resend confirmation error:',
                error
            );

            res.status(400).json({
                error: error.message
            });
        }
    }
);

// ─── HEALTH ─────────────────────────────────────────────────

app.get('/api/health', (req, res) => {
    res.json({
        status: 'ok',
        time: new Date().toISOString()
    });
});

// ─── USER ───────────────────────────────────────────────────

app.get('/api/user', authenticate, async (req, res) => {
    try {
        const plan =
            await getUserPlan(req.user.id);

        res.json({
            id: req.user.id,
            email: req.user.email,

            name:
                req.user.user_metadata?.name || '',

            email_confirmed:
                !!req.user.email_confirmed_at,

            plan
        });

    } catch (error) {
        console.error(
            'Get user error:',
            error
        );

        res.status(500).json({
            error: error.message
        });
    }
});

// ─── SUBSCRIPTION STATUS ───────────────────────────────────

app.get(
    '/api/subscription/status',
    authenticate,
    async (req, res) => {
        try {
            const {
                data: sub
            } = await supabase
                .from('subscriptions')
                .select('*')
                .eq(
                    'user_id',
                    req.user.id
                )
                .maybeSingle();

            res.json({
                status:
                    sub?.status || 'active',

                trial_end:
                    sub?.trial_end || null,

                plan:
                    sub?.plan || 'free'
            });

        } catch (error) {
            console.error(
                'Subscription status error:',
                error
            );

            res.status(500).json({
                error: error.message
            });
        }
    }
);

// ─── CREDIT BALANCE ENDPOINT ────────────────────────────────

app.get(
    '/api/credits/balance',
    authenticate,
    async (req, res) => {
        try {
            const balance =
                await getCreditBalance(
                    req.user.id
                );

            res.json({
                balance
            });

        } catch (error) {
            console.error(
                'Credit balance error:',
                error
            );

            res.status(500).json({
                error: error.message
            });
        }
    }
);

// ─── CREDIT TRANSACTIONS ────────────────────────────────────

app.get(
    '/api/credits/transactions',
    authenticate,
    async (req, res) => {
        try {
            const {
                data,
                error
            } = await supabase
                .from('credit_transactions')
                .select('*')
                .eq(
                    'user_id',
                    req.user.id
                )
                .order(
                    'created_at',
                    {
                        ascending: false
                    }
                )
                .limit(100);

            if (error) {
                throw error;
            }

            res.json(data || []);

        } catch (error) {
            console.error(
                'Credit transactions error:',
                error
            );

            res.status(500).json({
                error: error.message
            });
        }
    }
);


// ─── CREDIT PURCHASE (Paystack) ─────────────────────────────

app.post(
    '/api/credits/initialize',
    authenticate,
    async (req, res) => {
        try {
            if (!PAYSTACK_SECRET_KEY) {
                return res.status(500).json({
                    error: 'Paystack is not configured on the server'
                });
            }

            const pack = req.body.pack || 'starter';
            if (!CREDIT_PACKS[pack]) {
                return res.status(400).json({
                    error: 'Invalid credit pack. Use starter, growth, or scale.'
                });
            }

            const packData = CREDIT_PACKS[pack];
            const userId = req.user.id;
            const email = req.user.email;
            const reference =
                `credit_${userId}_${Date.now()}`;

            const response = await fetch(
                'https://api.paystack.co/transaction/initialize',
                {
                    method: 'POST',
                    headers: {
                        Authorization:
                            `Bearer ${PAYSTACK_SECRET_KEY}`,
                        'Content-Type':
                            'application/json'
                    },
                    body: JSON.stringify({
                        email,
                        amount: packData.amount,
                        currency: 'NGN',
                        reference,
                        callback_url:
                            `${FRONTEND_URL}/dashboard.html?credits=1`,
                        metadata: {
                            user_id: userId,
                            type: 'credit_purchase',
                            pack,
                            jobs: packData.jobs,
                            pack_name: packData.name
                        }
                    })
                }
            );

            const data = await response.json();

            if (!data.status) {
                console.error('Paystack credit init failed:', data);
                return res.status(400).json({
                    error:
                        (data.message) ||
                        'Paystack could not start the payment. Check your secret key and that the amount is valid.'
                });
            }

            // Optional local record
            try {
                await supabase.from('transactions').insert({
                    user_id: userId,
                    reference,
                    amount: packData.amount / 100,
                    status: 'pending',
                    type: 'credit_purchase',
                    metadata: {
                        pack,
                        jobs: packData.jobs
                    }
                });
            } catch (txLogErr) {
                console.warn('transactions log skipped:', txLogErr.message || txLogErr);
            }

            res.json({
                authorization_url:
                    data.data.authorization_url,
                access_code:
                    data.data.access_code,
                reference:
                    data.data.reference || reference,
                jobs: packData.jobs,
                amount: packData.amount / 100
            });
        } catch (error) {
            console.error(
                'Credit purchase initialize error:',
                error
            );
            res.status(500).json({
                error: error.message
            });
        }
    }
);


// ─── JOB QUOTA (debug + dashboard) ──────────────────────────

app.get(
    '/api/jobs/quota',
    authenticate,
    async (req, res) => {
        try {
            const userId = req.user.id;
            // Keep this endpoint light — badge should not wait on canCreateJob + extra queries
            const [used, credits] = await Promise.all([
                getLifetimeJobsUsed(userId),
                getCreditBalance(userId).catch(() => 0)
            ]);
            const freeLeft = Math.max(0, LIFETIME_FREE_JOBS - used);

            res.json({
                lifetime_free_limit: LIFETIME_FREE_JOBS,
                jobs_used: used,
                free_jobs_remaining: freeLeft,
                credits: Number(credits) || 0
            });
        } catch (error) {
            console.error('quota error:', error);
            res.status(500).json({ error: error.message });
        }
    }
);

// ─── PAYSTACK INITIALIZE ────────────────────────────────────

app.post(
    '/api/paystack/initialize',
    authenticate,
    async (req, res) => {
        try {
            const {
                plan = 'professional'
            } = req.body;

            const {
                email
            } = req.user;

            const userId =
                req.user.id;

            if (!PLANS[plan]) {
                return res.status(400).json({
                    error:
                        'Invalid plan selected'
                });
            }

            const planData =
                PLANS[plan];

            const reference =
                `cleancrew_${userId}_${Date.now()}`;

            const response =
                await fetch(
                    'https://api.paystack.co/transaction/initialize',
                    {
                        method: 'POST',

                        headers: {
                            Authorization:
                                `Bearer ${PAYSTACK_SECRET_KEY}`,

                            'Content-Type':
                                'application/json'
                        },

                        body: JSON.stringify({
                            email,
                            amount:
                                planData.amount,

                            currency: 'NGN',

                            reference,

                            callback_url:
                                `${FRONTEND_URL}/dashboard.html`,

                            metadata: {
                                user_id:
                                    userId,

                                plan,

                                plan_name:
                                    planData.name,

                                amount:
                                    planData.amount /
                                    100
                            }
                        })
                    }
                );

            const data =
                await response.json();

            if (data.status) {
                await supabase
                    .from('transactions')
                    .insert({
                        user_id: userId,
                        reference,
                        amount:
                            planData.amount /
                            100,

                        plan,
                        status:
                            'pending'
                    });

                return res.json({
                    authorization_url:
                        data.data.authorization_url,

                    reference,
                    plan,

                    amount:
                        planData.amount /
                        100
                });
            }

            res.status(400).json({
                error: data.message
            });

        } catch (error) {
            console.error(
                'Paystack error:',
                error
            );

            res.status(500).json({
                error: error.message
            });
        }
    }
);

// ─── PAYSTACK VERIFY ────────────────────────────────────────

app.post(
    '/api/paystack/verify/:reference',
    authenticate,
    async (req, res) => {
        try {
            const {
                reference
            } = req.params;

            const response =
                await fetch(
                    `https://api.paystack.co/transaction/verify/${reference}`,
                    {
                        headers: {
                            Authorization:
                                `Bearer ${PAYSTACK_SECRET_KEY}`
                        }
                    }
                );

            const data =
                await response.json();

            if (
                data.status &&
                data.data.status ===
                    'success'
            ) {
                const userId =
                    req.user.id;

                const plan =
                    data.data.metadata?.plan ||
                    'professional';

                await supabase
                    .from('subscriptions')
                    .upsert({
                        user_id:
                            userId,

                        status:
                            'active',

                        plan,

                        trial_end:
                            new Date(
                                Date.now() +
                                365 *
                                86400000
                            ).toISOString()
                    });

                await supabase
                    .from('transactions')
                    .update({
                        status:
                            'completed'
                    })
                    .eq(
                        'reference',
                        reference
                    );

                return res.json({
                    success: true,
                    message:
                        'Subscription activated!'
                });
            }

            res.status(400).json({
                error:
                    'Payment verification failed'
            });

        } catch (error) {
            console.error(
                'Verify error:',
                error
            );

            res.status(500).json({
                error: error.message
            });
        }
    }
);

// ─── PAYSTACK WEBHOOK ───────────────────────────────────────

app.post(
    '/api/paystack/webhook',
    async (req, res) => {
        try {
            const hash =
                crypto
                    .createHmac(
                        'sha512',
                        PAYSTACK_SECRET_KEY
                    )
                    .update(
                        JSON.stringify(
                            req.body
                        )
                    )
                    .digest('hex');

            if (
                hash !==
                req.headers[
                    'x-paystack-signature'
                ]
            ) {
                return res
                    .status(401)
                    .send('Unauthorized');
            }

            const event =
                req.body;

            if (
                event.event ===
                'charge.success'
            ) {
                const {
                    reference
                } = event.data;

                const {
                    user_id,
                    plan,
                    type,
                    jobs,
                    pack
                } =
                    event.data.metadata ||
                    {};

                // ─── CREDIT PURCHASE ────────────────

                if (
                    type ===
                        'credit_purchase' &&
                    user_id
                ) {
                    const jobCount =
                        parseInt(
                            jobs,
                            10
                        ) || 25;

                    /*
                     * Prevent accidental duplicate
                     * crediting if Paystack retries
                     * the webhook.
                     *
                     * Check whether this reference
                     * has already been recorded.
                     */
                    const {
                        data:
                            existingTransaction
                    } = await supabase
                        .from(
                            'credit_transactions'
                        )
                        .select('id')
                        .eq(
                            'reference',
                            reference
                        )
                        .eq(
                            'type',
                            'purchase'
                        )
                        .maybeSingle();

                    if (
                        !existingTransaction
                    ) {
                        await addCredits(
                            user_id,
                            jobCount,
                            `Credit pack: ${pack || 'Starter'} (${jobCount} jobs)`,
                            reference,
                            {
                                pack,
                                jobs:
                                    jobCount
                            }
                        );

                        await supabase
                            .from(
                                'transactions'
                            )
                            .update({
                                status:
                                    'completed'
                            })
                            .eq(
                                'reference',
                                reference
                            );

                        console.log(
                            `✅ Credits added: ${jobCount} jobs for user ${user_id}`
                        );
                    } else {
                        console.log(
                            `ℹ️ Credit purchase already processed: ${reference}`
                        );
                    }
                }

                // ─── SUBSCRIPTION ───────────────────

                if (plan && user_id) {
                    await supabase
                        .from('subscriptions')
                        .upsert({
                            user_id,

                            status:
                                'active',

                            plan,

                            trial_end:
                                new Date(
                                    Date.now() +
                                    365 *
                                    86400000
                                ).toISOString()
                        });

                    await supabase
                        .from('transactions')
                        .update({
                            status:
                                'completed'
                        })
                        .eq(
                            'reference',
                            reference
                        );

                    console.log(
                        `✅ Subscription activated for user ${user_id} (${plan})`
                    );
                }
            }

            res.sendStatus(200);

        } catch (error) {
            console.error(
                'Webhook error:',
                error
            );

            res.sendStatus(500);
        }
    }
);

// ─── USAGE / PLAN LIMITS ────────────────────────────────────

app.get(
    '/api/usage/limits',
    authenticate,
    async (req, res) => {
        try {
            const plan =
                await getUserPlan(
                    req.user.id
                );

            const planDef =
                PLANS[plan] ||
                PLANS.free;

            const types = [
                'jobs',
                'clients',
                'staff',
                'invoices',
                'inventory'
            ];

            const usage = {};

            for (const type of types) {
                try {
                    const result =
                        await checkPlanLimit(
                            req.user.id,
                            type
                        );

                    usage[type] = {
                        used:
                            result.count,

                        limit:
                            result.limit ===
                            Infinity
                                ? null
                                : result.limit,

                        allowed:
                            result.allowed
                    };
                } catch (e) {
                    usage[type] = {
                        used: 0,

                        limit:
                            planDef.limits[
                                type
                            ] ?? null,

                        allowed: true
                    };
                }
            }

            res.json({
                plan,

                plan_name:
                    planDef.name,

                features:
                    planDef.features,

                usage
            });

        } catch (error) {
            console.error(
                'Usage limits error:',
                error
            );

            res.status(500).json({
                error: error.message
            });
        }
    }
);

// ─── JOBS ────────────────────────────────────────────────────

app.get(
    '/api/jobs',
    authenticate,
    async (req, res) => {
        try {
            const {
                data,
                error
            } = await supabase
                .from('jobs')
                .select('*')
                .eq(
                    'user_id',
                    req.user.id
                )
                .order(
                    'created_at',
                    {
                        ascending: false
                    }
                );

            if (error) {
                throw error;
            }

            res.json(data);

        } catch (error) {
            console.error(
                'Error fetching jobs:',
                error
            );

            res.status(500).json({
                error: error.message
            });
        }
    }
);

app.post(
    '/api/jobs',
    authenticate,
    async (req, res) => {
        try {
            const userId =
                req.user.id;

            const canCreate =
                await canCreateJob(
                    userId
                );

            if (!canCreate.allowed) {
                return res.status(403).json({
                    error:
                        canCreate.message ||
                        "You've used all 25 free jobs. Buy credits or upgrade to continue.",

                    code:
                        'NO_JOBS_REMAINING',

                    free_used: true,

                    credits_remaining:
                        await getCreditBalance(
                            userId
                        )
                });
            }

            /*
             * IMPORTANT:
             *
             * Do NOT consume the credit before
             * knowing that the job can actually
             * be inserted.
             *
             * For credit users, consume first,
             * then refund if the insert fails.
             */

            let creditConsumed = false;
            let consumedCreditBalance = null;

            if (
                canCreate.source ===
                'credit'
            ) {
                const result =
                    await consumeCredit(
                        userId,
                        `Job creation: ${req.body.client || 'New job'}`
                    );

                if (!result.success) {
                    return res.status(403).json({
                        error:
                            result.message ||
                            'Insufficient credits',

                        code:
                            'INSUFFICIENT_CREDITS'
                    });
                }

                creditConsumed = true;
                consumedCreditBalance =
                    result.balance;
            }

            const mode =
                req.body.mode ||
                req.body.service_type ||
                'cleaning';

            // Only columns the jobs table expects — never spread req.body
            // (unknown fields + wrong client can trigger RLS / schema errors)
            const job = {
                user_id: userId,
                client: req.body.client || '',
                phone: req.body.phone || null,
                service: req.body.service || null,
                amount: req.body.amount != null ? Number(req.body.amount) : 0,
                date: req.body.date || null,
                status: req.body.status || 'pending',
                notes: req.body.notes || null,
                mode,
                service_type: mode,
                items: req.body.items || req.body.laundry_items || [],
                rooms: req.body.rooms != null && req.body.rooms !== ''
                    ? Number(req.body.rooms)
                    : null,
                property_size: req.body.property_size || null,
                number: req.body.number || null,
                staff_cost: req.body.staff_cost != null ? Number(req.body.staff_cost) : undefined,
                materials_cost: req.body.materials_cost != null ? Number(req.body.materials_cost) : undefined,
                other_cost: req.body.other_cost != null ? Number(req.body.other_cost) : undefined,
                location_id: req.body.location_id || null
            };

            // Drop null optional keys that may not exist on older schemas
            Object.keys(job).forEach(function (k) {
                if (job[k] === null || job[k] === undefined) {
                    delete job[k];
                }
            });
            // Always keep user_id
            job.user_id = userId;

            // Prefer full row; always fall back to minimal columns (older schemas / RLS edge cases)
            const minimalJob = {
                user_id: userId,
                client: job.client || 'Customer',
                phone: job.phone || null,
                service: job.service || null,
                amount: job.amount != null ? Number(job.amount) : 0,
                date: job.date || null,
                status: job.status || 'pending',
                notes: job.notes || null
            };
            Object.keys(minimalJob).forEach(function (k) {
                if (minimalJob[k] === null || minimalJob[k] === undefined) delete minimalJob[k];
            });
            minimalJob.user_id = userId;

            let data, error;
            {
                const attempt = await supabase.from('jobs').insert(job).select().single();
                data = attempt.data;
                error = attempt.error;
            }
            if (error) {
                console.warn('Job insert full failed, retry minimal:', error.message || error, error.code || '');
                const retry = await supabase.from('jobs').insert(minimalJob).select().single();
                data = retry.data;
                error = retry.error;
                if (error) {
                    console.error('Job insert failed (minimal):', error.message || error, error.code || '', error.details || '');
                }
            }

            if (error) {
                if (creditConsumed) {
                    try {
                        await addCredits(
                            userId,
                            1,
                            'Refund: failed job creation',
                            null,
                            { reason: 'job_insert_failed' }
                        );
                    } catch (refundError) {
                        console.error(
                            'CRITICAL: Failed to refund credit after job creation failure:',
                            refundError
                        );
                    }
                }

                const msg = error.message || String(error);
                console.error('Job insert failed:', msg, error.code || '', error.details || '');

                // Surface RLS clearly — almost always wrong/missing SERVICE_ROLE key
                if (/row-level security|RLS/i.test(msg)) {
                    console.error(
                        'RLS on jobs insert — user:',
                        userId,
                        '| key role check: ensure SUPABASE_SERVICE_ROLE_KEY is service_role, not anon'
                    );
                    return res.status(500).json({
                        error:
                            'Could not save this job right now. Please try again in a moment. If it keeps failing, contact support on WhatsApp.',
                        code: 'RLS_JOBS_INSERT',
                        detail: msg
                    });
                }

                throw error;
            }

            // Auto-save client from job form (no need to fill Clients tab separately)
            try {
                await ensureClientFromJob(
                    userId,
                    data.client || req.body.client,
                    data.phone || req.body.phone,
                    req.body.location || req.body.client_location || null
                );
            } catch (clientErr) {
                console.warn('Auto client save skipped:', clientErr.message || clientErr);
            }

            // Optional staff assignments: [{ staff_id, role: 'lead'|'crew' }]
            let staffAssignError = null;
            try {
                const assignments = Array.isArray(req.body.staff_assignments)
                    ? req.body.staff_assignments
                    : [];
                if (assignments.length && data && data.id) {
                    await replaceJobStaff(userId, data.id, assignments);
                }
            } catch (staffErr) {
                staffAssignError = staffErr.message || String(staffErr);
                console.error('Job created but staff assign failed:', staffAssignError);
            }

            // Parallel meta (faster response)
            const [free_remaining, credits_remaining] = await Promise.all([
                getFreeJobsRemaining(userId),
                getCreditBalance(userId)
            ]);

            res.json({
                ...data,
                _meta: {
                    source: canCreate.source,
                    free_remaining,
                    credits_remaining,
                    staff_assign_error: staffAssignError
                }
            });

        } catch (error) {
            console.error(
                'Error creating job:',
                error
            );

            res.status(500).json({
                error: error.message
            });
        }
    }
);


// ─── JOB ↔ STAFF ASSIGNMENTS ─────────────────────────────────

async function assertJobOwned(userId, jobId) {
    const { data, error } = await supabase
        .from('jobs')
        .select('id')
        .eq('id', jobId)
        .eq('user_id', userId)
        .maybeSingle();
    if (error) throw error;
    if (!data) {
        const err = new Error('Job not found');
        err.status = 404;
        throw err;
    }
    return data;
}

async function replaceJobStaff(userId, jobId, assignments) {
    await assertJobOwned(userId, jobId);

    const cleaned = (assignments || [])
        .filter(function (a) { return a && a.staff_id; })
        .map(function (a) {
            const role = a.role === 'lead' ? 'lead' : 'crew';
            return { job_id: jobId, staff_id: a.staff_id, role: role };
        });

    const leads = cleaned.filter(function (a) { return a.role === 'lead'; });
    if (cleaned.length && leads.length === 0) {
        cleaned[0].role = 'lead';
    }
    if (leads.length > 1) {
        let seen = false;
        cleaned.forEach(function (a) {
            if (a.role === 'lead') {
                if (seen) a.role = 'crew';
                else seen = true;
            }
        });
    }

    const { error: delErr } = await supabase
        .from('job_staff')
        .delete()
        .eq('job_id', jobId);
    if (delErr) throw delErr;

    if (!cleaned.length) return [];

    const staffIds = cleaned.map(function (a) { return a.staff_id; });
    const { data: ownedStaff, error: stErr } = await supabase
        .from('staff')
        .select('id')
        .eq('user_id', userId)
        .in('id', staffIds);
    if (stErr) throw stErr;
    const allowed = new Set((ownedStaff || []).map(function (s) { return s.id; }));
    const rows = cleaned.filter(function (a) { return allowed.has(a.staff_id); });
    if (!rows.length) return [];

    const { data, error } = await supabase
        .from('job_staff')
        .insert(rows)
        .select();
    if (error) throw error;
    return data || [];
}


async function ensureClientFromJob(userId, clientName, phone, location) {
    const name = (clientName || '').toString().trim();
    if (!name) return null;
    const phoneVal = (phone || '').toString().trim() || null;
    // Location is stored on the client, but NEVER used for duplicate matching
    // (many customers can share the same area / estate)
    const locationVal = (location || '').toString().trim() || null;

    try {
        // Match existing by phone first, then name only — not location
        if (phoneVal) {
            const { data: byPhone } = await supabase
                .from('clients')
                .select('id, name, phone, location')
                .eq('user_id', userId)
                .eq('phone', phoneVal)
                .limit(1);
            if (byPhone && byPhone.length) {
                const patch = {};
                if (phoneVal && !byPhone[0].phone) patch.phone = phoneVal;
                if (locationVal && !byPhone[0].location) patch.location = locationVal;
                if (Object.keys(patch).length) {
                    await supabase.from('clients').update(patch).eq('id', byPhone[0].id).eq('user_id', userId);
                }
                return byPhone[0];
            }
        }

        const { data: byName } = await supabase
            .from('clients')
            .select('id, name, phone, location')
            .eq('user_id', userId)
            .ilike('name', name)
            .limit(1);
        if (byName && byName.length) {
            const patch = {};
            if (phoneVal && !byName[0].phone) patch.phone = phoneVal;
            if (locationVal && !byName[0].location) patch.location = locationVal;
            if (Object.keys(patch).length) {
                await supabase.from('clients').update(patch).eq('id', byName[0].id).eq('user_id', userId);
            }
            return byName[0];
        }

        const row = {
            user_id: userId,
            name: name,
            phone: phoneVal,
            location: locationVal
        };
        const { data, error } = await supabase
            .from('clients')
            .insert(row)
            .select()
            .single();
        if (error) {
            // Retry without location if column missing
            if (/location|column|schema/i.test(error.message || '')) {
                const minimal = { user_id: userId, name: name, phone: phoneVal };
                const retry = await supabase.from('clients').insert(minimal).select().single();
                if (retry.error) {
                    console.warn('ensureClientFromJob insert:', retry.error.message);
                    return null;
                }
                return retry.data;
            }
            console.warn('ensureClientFromJob insert:', error.message);
            return null;
        }
        return data;
    } catch (e) {
        console.warn('ensureClientFromJob:', e.message || e);
        return null;
    }
}


app.get('/api/jobs/:id/staff', authenticate, async (req, res) => {
    try {
        const userId = req.user.id;
        const jobId = req.params.id;
        await assertJobOwned(userId, jobId);
        const { data, error } = await supabase
            .from('job_staff')
            .select('id, job_id, staff_id, role, created_at')
            .eq('job_id', jobId);
        if (error) {
            console.warn('GET job staff:', error.message);
            return res.json([]);
        }
        const rows = data || [];
        if (!rows.length) return res.json([]);

        const ids = rows.map(function (r) { return r.staff_id; });
        const { data: staffRows } = await supabase
            .from('staff')
            .select('id, name, phone, role')
            .eq('user_id', userId)
            .in('id', ids);
        const byId = {};
        (staffRows || []).forEach(function (s) { byId[s.id] = s; });

        res.json(rows.map(function (r) {
            const s = byId[r.staff_id] || {};
            return {
                id: r.id,
                job_id: r.job_id,
                staff_id: r.staff_id,
                role: r.role,
                created_at: r.created_at,
                name: s.name || null,
                phone: s.phone || null,
                staff_role: s.role || null
            };
        }));
    } catch (error) {
        console.error('GET job staff:', error);
        res.status(error.status || 500).json({ error: error.message });
    }
});

app.put('/api/jobs/:id/staff', authenticate, async (req, res) => {
    try {
        const userId = req.user.id;
        const jobId = req.params.id;
        const assignments = Array.isArray(req.body.staff_assignments)
            ? req.body.staff_assignments
            : (Array.isArray(req.body) ? req.body : []);
        const data = await replaceJobStaff(userId, jobId, assignments);
        res.json(data);
    } catch (error) {
        console.error('PUT job staff:', error);
        res.status(error.status || 500).json({ error: error.message });
    }
});

app.get('/api/staff/:id/jobs', authenticate, async (req, res) => {
    try {
        const userId = req.user.id;
        const staffId = req.params.id;
        const { data: st, error: stErr } = await supabase
            .from('staff')
            .select('id, name')
            .eq('id', staffId)
            .eq('user_id', userId)
            .maybeSingle();
        if (stErr) throw stErr;
        if (!st) return res.status(404).json({ error: 'Staff not found' });

        const { data: links, error } = await supabase
            .from('job_staff')
            .select('role, job_id')
            .eq('staff_id', staffId);
        if (error) throw error;

        const jobIds = (links || []).map(function (r) { return r.job_id; }).filter(Boolean);
        if (!jobIds.length) return res.json({ staff: st, jobs: [] });

        const roleByJob = {};
        (links || []).forEach(function (r) { roleByJob[r.job_id] = r.role; });

        const { data: jobs, error: jErr } = await supabase
            .from('jobs')
            .select('id, client, phone, service, amount, date, status, mode, service_type, notes')
            .eq('user_id', userId)
            .in('id', jobIds)
            .order('date', { ascending: false });
        if (jErr) throw jErr;

        const out = (jobs || []).map(function (j) {
            return Object.assign({}, j, { assignment_role: roleByJob[j.id] || 'crew' });
        });
        res.json({ staff: st, jobs: out });
    } catch (error) {
        console.error('GET staff jobs:', error);
        res.status(500).json({ error: error.message });
    }
});

app.get('/api/staff-assignment-counts', authenticate, async (req, res) => {
    try {
        const userId = req.user.id;
        const { data: staffList, error: sErr } = await supabase
            .from('staff')
            .select('id')
            .eq('user_id', userId);
        if (sErr) throw sErr;
        const ids = (staffList || []).map(function (s) { return s.id; });
        if (!ids.length) return res.json({});

        const counts = {};
        ids.forEach(function (id) { counts[String(id)] = 0; });

        const { data: links, error } = await supabase
            .from('job_staff')
            .select('staff_id')
            .in('staff_id', ids);
        if (error) {
            // Table missing or RLS — return zeros so UI still works
            console.warn('staff-assignment-counts:', error.message);
            return res.json(counts);
        }

        (links || []).forEach(function (row) {
            if (row.staff_id) {
                const k = String(row.staff_id);
                counts[k] = (counts[k] || 0) + 1;
            }
        });
        res.json(counts);
    } catch (error) {
        console.error('staff counts:', error);
        res.json({});
    }
});

// ─── CLIENTS ─────────────────────────────────────────────────

app.get(
    '/api/clients',
    authenticate,
    async (req, res) => {
        try {
            const {
                data,
                error
            } = await supabase
                .from('clients')
                .select('*')
                .eq(
                    'user_id',
                    req.user.id
                )
                .order(
                    'created_at',
                    {
                        ascending: false
                    }
                );

            if (error) {
                throw error;
            }

            res.json(data);

        } catch (error) {
            console.error(
                'Error fetching clients:',
                error
            );

            res.status(500).json({
                error: error.message
            });
        }
    }
);

app.post(
    '/api/clients',
    authenticate,
    async (req, res) => {
        try {
            const limitCheck =
                await checkPlanLimit(
                    req.user.id,
                    'clients'
                );

            if (!limitCheck.allowed) {
                return res.status(403).json({
                    error:
                        limitCheck.message,

                    limit:
                        limitCheck.limit,

                    count:
                        limitCheck.count,

                    plan:
                        limitCheck.plan
                });
            }

            const name = (req.body.name || '').toString().trim();
            if (!name) {
                return res.status(400).json({ error: 'Client name is required' });
            }

            const client = {
                user_id: req.user.id,
                name: name,
                phone: (req.body.phone || '').toString().trim() || null,
                email: (req.body.email || '').toString().trim() || null,
                location: (req.body.location || '').toString().trim() || null,
                notes: (req.body.notes || '').toString().trim() || null
            };

            let { data, error } = await supabase
                .from('clients')
                .insert(client)
                .select()
                .single();

            if (error && /location|column|schema/i.test(error.message || '')) {
                const minimal = {
                    user_id: req.user.id,
                    name: client.name,
                    phone: client.phone,
                    email: client.email,
                    notes: client.notes
                };
                const retry = await supabase.from('clients').insert(minimal).select().single();
                data = retry.data;
                error = retry.error;
                if (error) {
                    console.error('Client insert without location failed:', error.message);
                } else {
                    console.warn('clients.location column missing — add it in Supabase to store location');
                }
            }

            if (error) {
                return res.status(400).json({ error: error.message });
            }

            res.json(data);

        } catch (error) {
            console.error(
                'Error creating client:',
                error
            );

            res.status(500).json({
                error: error.message
            });
        }
    }
);


app.put(
    '/api/clients/:id',
    authenticate,
    async (req, res) => {
        try {
            const patch = {};
            ['name', 'phone', 'email', 'location', 'notes'].forEach(function (k) {
                if (req.body[k] !== undefined) {
                    const v = req.body[k];
                    patch[k] = typeof v === 'string' ? v.trim() : v;
                }
            });
            if (!Object.keys(patch).length) {
                return res.status(400).json({ error: 'No fields to update' });
            }
            const { data, error } = await supabase
                .from('clients')
                .update(patch)
                .eq('id', req.params.id)
                .eq('user_id', req.user.id)
                .select()
                .single();
            if (error) {
                if (/location|column|schema/i.test(error.message || '')) {
                    delete patch.location;
                    if (!Object.keys(patch).length) {
                        return res.status(400).json({
                            error: 'Add a location column on clients in Supabase to save location'
                        });
                    }
                    const retry = await supabase
                        .from('clients')
                        .update(patch)
                        .eq('id', req.params.id)
                        .eq('user_id', req.user.id)
                        .select()
                        .single();
                    if (retry.error) {
                        return res.status(400).json({ error: retry.error.message });
                    }
                    return res.json(retry.data);
                }
                return res.status(400).json({ error: error.message });
            }
            res.json(data);
        } catch (error) {
            console.error('Error updating client:', error);
            res.status(500).json({ error: error.message });
        }
    }
);

app.delete(
    '/api/clients/:id',
    authenticate,
    async (req, res) => {
        try {
            const {
                error
            } = await supabase
                .from('clients')
                .delete()
                .eq(
                    'id',
                    req.params.id
                )
                .eq(
                    'user_id',
                    req.user.id
                );

            if (error) {
                throw error;
            }

            res.json({
                success: true
            });

        } catch (error) {
            console.error(
                'Error deleting client:',
                error
            );

            res.status(500).json({
                error: error.message
            });
        }
    }
);

// ─── INVENTORY ───────────────────────────────────────────────


// ─── UPDATE JOB ─────────────────────────────────────────────

app.put(
    '/api/jobs/:id',
    authenticate,
    async (req, res) => {
        try {
            const userId = req.user.id;
            const jobId = req.params.id;

            // Only allow safe fields to be updated
            const allowed = [
                'status',
                'client',
                'service',
                'amount',
                'date',
                'notes',
                'mode',
                'service_type',
                'items',
                'rooms',
                'property_size',
                'phone',
                'address',
                'staff_cost',
                'materials_cost',
                'other_cost'
            ];
            const patch = {};
            allowed.forEach(function (key) {
                if (req.body[key] !== undefined) {
                    patch[key] = req.body[key];
                }
            });

            if (Object.keys(patch).length === 0) {
                return res.status(400).json({
                    error: 'No valid fields to update'
                });
            }

            const {
                data,
                error
            } = await supabase
                .from('jobs')
                .update(patch)
                .eq('id', jobId)
                .eq('user_id', userId)
                .select()
                .single();

            if (error) {
                throw error;
            }

            if (!data) {
                return res.status(404).json({
                    error: 'Job not found'
                });
            }

            // Optional staff re-assignment on job update
            if (Array.isArray(req.body.staff_assignments)) {
                try {
                    await replaceJobStaff(userId, jobId, req.body.staff_assignments);
                } catch (staffErr) {
                    console.error('Job updated but staff assign failed:', staffErr.message || staffErr);
                }
            }

            res.json(data);
        } catch (error) {
            console.error('Error updating job:', error);
            res.status(500).json({
                error: error.message
            });
        }
    }
);

// ─── DELETE JOB ─────────────────────────────────────────────

app.delete(
    '/api/jobs/:id',
    authenticate,
    async (req, res) => {
        try {
            const {
                error
            } = await supabase
                .from('jobs')
                .delete()
                .eq('id', req.params.id)
                .eq('user_id', req.user.id);

            if (error) {
                throw error;
            }

            res.json({ success: true });
        } catch (error) {
            console.error('Error deleting job:', error);
            res.status(500).json({
                error: error.message
            });
        }
    }
);

app.get(
    '/api/inventory',
    authenticate,
    async (req, res) => {
        try {
            const {
                data,
                error
            } = await supabase
                .from('inventory')
                .select('*')
                .eq(
                    'user_id',
                    req.user.id
                )
                .order(
                    'created_at',
                    {
                        ascending: false
                    }
                );

            if (error) {
                throw error;
            }

            res.json(data);

        } catch (error) {
            console.error(
                'Error fetching inventory:',
                error
            );

            res.status(500).json({
                error: error.message
            });
        }
    }
);

app.post(
    '/api/inventory',
    authenticate,
    async (req, res) => {
        try {
            const limitCheck =
                await checkPlanLimit(
                    req.user.id,
                    'inventory'
                );

            if (!limitCheck.allowed) {
                return res.status(403).json({
                    error:
                        limitCheck.message,

                    limit:
                        limitCheck.limit,

                    count:
                        limitCheck.count,

                    plan:
                        limitCheck.plan
                });
            }

            const item = {
                name: req.body.name,
                category: req.body.category || 'cleaning',
                quantity: req.body.quantity,
                min_stock: req.body.min_stock,
                unit: req.body.unit,
                notes: req.body.notes,
                location_id: req.body.location_id || null,
                user_id: req.user.id
            };
            Object.keys(item).forEach(function (k) {
                if (item[k] === undefined) delete item[k];
            });

            const { data, error } = await insertWithSchemaFallback(
                'inventory',
                item,
                ['location_id', 'unit', 'notes', 'min_stock', 'category', 'mode']
            );

            if (error) {
                throw error;
            }

            res.json(data);

        } catch (error) {
            console.error(
                'Error creating inventory item:',
                error
            );

            res.status(500).json({
                error: error.message
            });
        }
    }
);

app.put(
    '/api/inventory/:id',
    authenticate,
    async (req, res) => {
        try {
            const updates = {
                name: req.body.name,
                category: req.body.category,
                quantity: req.body.quantity,
                min_stock: req.body.min_stock,
                unit: req.body.unit,
                notes: req.body.notes,
                location_id: req.body.location_id
            };
            Object.keys(updates).forEach(function (k) {
                if (updates[k] === undefined) delete updates[k];
            });

            const { data, error } = await updateWithSchemaFallback(
                'inventory',
                req.params.id,
                req.user.id,
                updates,
                ['location_id', 'unit', 'notes', 'min_stock', 'category', 'mode']
            );

            if (error) {
                throw error;
            }

            res.json(data);

        } catch (error) {
            console.error(
                'Error updating inventory item:',
                error
            );

            res.status(500).json({
                error: error.message
            });
        }
    }
);

app.delete(
    '/api/inventory/:id',
    authenticate,
    async (req, res) => {
        try {
            const {
                error
            } = await supabase
                .from('inventory')
                .delete()
                .eq(
                    'id',
                    req.params.id
                )
                .eq(
                    'user_id',
                    req.user.id
                );

            if (error) {
                throw error;
            }

            res.json({
                success: true
            });

        } catch (error) {
            console.error(
                'Error deleting inventory item:',
                error
            );

            res.status(500).json({
                error: error.message
            });
        }
    }
);

// ─── INVOICES ────────────────────────────────────────────────


async function ensureJobFromPaidInvoice(userId, inv) {
    if (!inv || !userId) return null;
    const amount = Number(inv.amount_due != null ? inv.amount_due : inv.amount) || 0;
    const paid = Number(inv.amount_paid) || 0;
    const st = String(inv.status || '').toLowerCase();
    const fullyPaid = st === 'paid' || (amount > 0 && paid >= amount);
    if (!fullyPaid) return null;

    // Already linked — mark job completed so it counts in revenue
    if (inv.job_id) {
        try {
            await supabase
                .from('jobs')
                .update({
                    status: 'completed',
                    amount: amount || undefined
                })
                .eq('id', inv.job_id)
                .eq('user_id', userId);
        } catch (e) {
            console.warn('ensureJobFromPaidInvoice update', e.message || e);
        }
        return inv.job_id;
    }

    const job = {
        user_id: userId,
        client: inv.client || 'Customer',
        phone: inv.phone || null,
        service: inv.service || inv.description || 'Invoiced service',
        amount: amount,
        date: (inv.date && String(inv.date).slice(0, 10)) || new Date().toISOString().slice(0, 10),
        status: 'completed',
        notes: 'From paid invoice ' + (inv.invoice_numb || inv.number || inv.id || ''),
        mode: inv.mode || 'cleaning',
        service_type: inv.mode || 'cleaning'
    };
    Object.keys(job).forEach(function (k) {
        if (job[k] === null || job[k] === undefined) delete job[k];
    });
    job.user_id = userId;

    let data, error;
    let attempt = await supabase.from('jobs').insert(job).select().single();
    data = attempt.data;
    error = attempt.error;
    if (error && /column|schema cache|mode|service_type/i.test(error.message || '')) {
        delete job.mode;
        delete job.service_type;
        attempt = await supabase.from('jobs').insert(job).select().single();
        data = attempt.data;
        error = attempt.error;
    }
    if (error) {
        console.warn('ensureJobFromPaidInvoice create', error.message || error);
        return null;
    }

    try {
        await supabase
            .from('invoices')
            .update({ job_id: data.id })
            .eq('id', inv.id)
            .eq('user_id', userId);
    } catch (e2) {
        console.warn('link invoice job_id', e2.message || e2);
    }
    return data.id;
}


app.get(
    '/api/invoices',
    authenticate,
    async (req, res) => {
        try {
            const {
                data,
                error
            } = await supabase
                .from('invoices')
                .select('*')
                .eq(
                    'user_id',
                    req.user.id
                )
                .order(
                    'created_at',
                    {
                        ascending: false
                    }
                );

            if (error) {
                throw error;
            }

            res.json(data);

        } catch (error) {
            console.error(
                'Error fetching invoices:',
                error
            );

            res.status(500).json({
                error: error.message
            });
        }
    }
);

app.post(
    '/api/invoices',
    authenticate,
    async (req, res) => {
        try {
            const limitCheck =
                await checkPlanLimit(
                    req.user.id,
                    'invoices'
                );

            if (!limitCheck.allowed) {
                return res.status(403).json({
                    error:
                        limitCheck.message,

                    limit:
                        limitCheck.limit,

                    count:
                        limitCheck.count,

                    plan:
                        limitCheck.plan
                });
            }

            const amount =
                req.body.amount_due ??
                req.body.amount;

            const docType = (req.body.doc_type === 'quotation' || req.body.doc_type === 'quote')
                ? 'quotation'
                : 'invoice';
            const prefix = docType === 'quotation' ? 'QT' : 'CC';

            const invoice = {
                user_id:
                    req.user.id,

                number:
                    req.body.number ||
                    `${prefix}-${Date.now()
                        .toString()
                        .slice(-6)}`,

                client:
                    req.body.client,

                phone:
                    req.body.phone ||
                    null,

                service:
                    req.body.description ||
                    req.body.service ||
                    'Service',

                description:
                    req.body.description ||
                    req.body.service ||
                    null,

                amount,

                amount_due:
                    amount,

                amount_paid:
                    docType === 'quotation' ? 0 : (req.body.amount_paid ?? 0),

                date:
                    req.body.date,

                status:
                    docType === 'quotation'
                        ? (req.body.quote_status || req.body.status || 'draft')
                        : (req.body.status || 'unpaid'),

                doc_type: docType,

                valid_until:
                    req.body.valid_until || null,

                line_items:
                    Array.isArray(req.body.line_items) ? req.body.line_items : [],

                quote_status:
                    docType === 'quotation'
                        ? (req.body.quote_status || 'draft')
                        : null,

                job_id:
                    req.body.job_id ||
                    null,

                paid_at:
                    docType === 'quotation' ? null : (req.body.paid_at || null)
            };

            const {
                data,
                error
            } = await supabase
                .from('invoices')
                .insert(invoice)
                .select()
                .single();

            if (error) {
                if (/doc_type|valid_until|line_items|quote_status|column/i.test(error.message || '')) {
                    delete invoice.doc_type;
                    delete invoice.valid_until;
                    delete invoice.description;
                    delete invoice.line_items;
                    delete invoice.quote_status;
                    const retry = await supabase.from('invoices').insert(invoice).select().single();
                    if (!retry.error) return res.json(retry.data);
                    return res.status(400).json({ error: (retry.error.message || error.message) + ' — run migrations_quotations.sql' });
                }
                return res.status(400).json({
                    error:
                        error.message
                });
            }

            res.json(data);

        } catch (error) {
            console.error(
                'Error creating invoice:',
                error
            );

            res.status(500).json({
                error: error.message
            });
        }
    }
);

app.put(
    '/api/invoices/:id',
    authenticate,
    async (req, res) => {
        try {
            const userId = req.user.id;
            const invoiceId = req.params.id;

            const invoiceIdClean = String(invoiceId || '').trim();
            if (!invoiceIdClean) {
                return res.status(400).json({ error: 'Missing invoice id' });
            }

            // Lookup by id first, then ownership — clearer errors than a combined filter miss
            let existing = await supabase
                .from('invoices')
                .select('*')
                .eq('id', invoiceIdClean)
                .maybeSingle();

            if (existing.error) throw existing.error;
            if (!existing.data) {
                return res.status(404).json({ error: 'Invoice not found' });
            }
            if (String(existing.data.user_id) !== String(userId)) {
                return res.status(403).json({ error: 'You do not have access to this invoice' });
            }

            const inv = existing.data;
            const statusNow = String(inv.status || '').toLowerCase();
            const amountDueNow = Number(inv.amount_due != null ? inv.amount_due : inv.amount) || 0;
            const amountPaidNow = Number(inv.amount_paid) || 0;
            const isPaid = statusNow === 'paid' || (amountDueNow > 0 && amountPaidNow >= amountDueNow);

            const body = req.body || {};
            const isPaymentUpdate = body.amount_paid !== undefined;

            // Guardrail: no content edits after fully paid — payment adjustments still allowed
            const isQuoteRow = inv.doc_type === 'quotation' ||
                ['draft', 'sent', 'approved', 'expired', 'quotation'].indexOf(statusNow) !== -1;
            if (isPaid && !isQuoteRow && !isPaymentUpdate) {
                return res.status(400).json({
                    error: 'This invoice is paid and cannot be edited. Create a new invoice if you need a correction.'
                });
            }

            // Allowed editable fields only — never invoice number / created_at / user_id / job_id reassignment via bulk body
            const updates = {};
            const changes = [];

            if (body.client !== undefined) {
                const v = String(body.client || '').trim();
                if (v && v !== inv.client) {
                    updates.client = v;
                    changes.push('client: ' + (inv.client || '') + ' → ' + v);
                }
            }
            if (body.phone !== undefined) {
                const v = String(body.phone || '').trim();
                if (v !== String(inv.phone || '').trim()) {
                    updates.phone = v;
                    changes.push('phone updated');
                }
            }
            if (body.amount_due !== undefined || body.amount !== undefined) {
                const v = Number(body.amount_due != null ? body.amount_due : body.amount);
                if (!isNaN(v) && v >= 0) {
                    const prev = amountDueNow;
                    if (v !== prev) {
                        updates.amount_due = v;
                        updates.amount = v;
                        changes.push('amount: ' + prev + ' → ' + v);
                    }
                }
            }
            if (body.date !== undefined && body.date) {
                const v = String(body.date).slice(0, 10);
                const prev = inv.date ? String(inv.date).slice(0, 10) : '';
                if (v !== prev) {
                    updates.date = v;
                    changes.push('date: ' + prev + ' → ' + v);
                }
            }
            // Payment recording: amount_paid + derived status
            if (body.amount_paid !== undefined) {
                const v = Number(body.amount_paid);
                if (!isNaN(v) && v >= 0) {
                    const prev = amountPaidNow;
                    if (v !== prev) {
                        updates.amount_paid = v;
                        changes.push('amount_paid: ' + prev + ' → ' + v);
                    }
                    const due = body.amount_due !== undefined
                        ? Number(body.amount_due)
                        : amountDueNow;
                    let derived = 'unpaid';
                    if (v <= 0) derived = 'unpaid';
                    else if (due > 0 && v >= due) derived = 'paid';
                    else if (v > 0 && v < due) derived = 'partial';
                    else if (v > 0) derived = 'paid';
                    updates.status = derived;
                    if (derived === 'paid') {
                        updates.paid_at = body.paid_at || new Date().toISOString();
                    } else if (body.paid_at === null) {
                        updates.paid_at = null;
                    }
                    changes.push('status: ' + statusNow + ' → ' + derived);
                }
            }
            if (body.paid_at !== undefined && updates.paid_at === undefined) {
                updates.paid_at = body.paid_at || null;
            }
            if (body.status !== undefined || body.quote_status !== undefined) {
                const v = String(body.quote_status || body.status || '').toLowerCase();
                const allowed = ['unpaid', 'partial', 'pending', 'paid', 'overdue', 'cancelled', 'draft', 'sent', 'approved', 'expired', 'quotation'];
                // If amount_paid was sent, status is already derived — don't override with blocked rules
                if (body.amount_paid === undefined && allowed.indexOf(v) !== -1 && v !== statusNow) {
                    // Bare status=paid without amount_paid is not allowed
                    if (v === 'paid') {
                        return res.status(400).json({
                            error: 'Mark as paid using Record payment so amount paid is tracked correctly.'
                        });
                    }
                    updates.status = v;
                    if (['draft', 'sent', 'approved', 'expired', 'converted'].indexOf(v) !== -1) {
                        updates.quote_status = v;
                    }
                    changes.push('status: ' + statusNow + ' → ' + v);
                }
            }
            if (body.line_items !== undefined && Array.isArray(body.line_items)) {
                updates.line_items = body.line_items;
                changes.push('line items updated');
            }
            if (body.quote_status !== undefined && !updates.quote_status) {
                const qs = String(body.quote_status).toLowerCase();
                if (['draft', 'sent', 'approved', 'expired', 'converted'].indexOf(qs) !== -1) {
                    updates.quote_status = qs;
                    updates.status = qs;
                    changes.push('quote_status: ' + qs);
                }
            }
            if (body.description !== undefined || body.service !== undefined) {
                const v = String(body.description != null ? body.description : body.service || '').trim();
                const prev = inv.service || inv.description || '';
                if (v && v !== prev) {
                    updates.service = v;
                    changes.push('description updated');
                }
            }

            // Explicitly strip forbidden fields if client sent them
            // number, invoice_numb, created_at, user_id never applied

            if (!Object.keys(updates).length) {
                return res.json(inv);
            }

            // Lightweight audit trail on the row (no extra table required)
            const stamp = new Date().toISOString();
            const auditLine = '[' + stamp + ' edit] ' + changes.join('; ');
            const prevNotes = inv.audit_log || inv.notes || '';
            updates.updated_at = stamp;
            // Prefer audit_log column if present; also append to a safe field
            updates.audit_log = (prevNotes && String(prevNotes).indexOf('[') === 0 ? prevNotes + '\n' : (prevNotes ? prevNotes + '\n' : '')) + auditLine;
            // If audit_log column doesn't exist, Supabase will error — strip and retry notes-only
            let data, error;
            const attempt = await supabase
                .from('invoices')
                .update(updates)
                .eq('id', invoiceId)
                .eq('user_id', userId)
                .select()
                .single();
            data = attempt.data;
            error = attempt.error;

            if (error && /audit_log|paid_at|amount_paid|column/i.test(error.message || '')) {
                delete updates.audit_log;
                if (/paid_at/i.test(error.message || '')) delete updates.paid_at;
                const retry = await supabase
                    .from('invoices')
                    .update(updates)
                    .eq('id', invoiceId)
                    .eq('user_id', userId)
                    .select()
                    .single();
                data = retry.data;
                error = retry.error;
                if (error && /amount_paid/i.test(error.message || '')) {
                    return res.status(400).json({
                        error: 'amount_paid column missing — run invoice payment migration in Supabase'
                    });
                }
            }

            if (error) throw error;

            // When invoice becomes paid → ensure a completed job exists (revenue)
            try {
                const paidNow = data && (
                    String(data.status || '').toLowerCase() === 'paid' ||
                    (Number(data.amount_paid) > 0 &&
                        Number(data.amount_due != null ? data.amount_due : data.amount) > 0 &&
                        Number(data.amount_paid) >= Number(data.amount_due != null ? data.amount_due : data.amount))
                );
                if (paidNow) {
                    await ensureJobFromPaidInvoice(userId, data);
                    // re-fetch so client gets job_id
                    const refreshed = await supabase
                        .from('invoices')
                        .select('*')
                        .eq('id', invoiceId)
                        .eq('user_id', userId)
                        .maybeSingle();
                    if (refreshed.data) data = refreshed.data;
                }
            } catch (ej) {
                console.warn('paid invoice → job', ej.message || ej);
            }

            res.json(data);
        } catch (error) {
            console.error('Error updating invoice:', error);
            res.status(500).json({ error: error.message });

        }
    }
);

app.delete(
    '/api/invoices/:id',
    authenticate,
    async (req, res) => {
        try {
            const {
                error
            } = await supabase
                .from('invoices')
                .delete()
                .eq(
                    'id',
                    req.params.id
                )
                .eq(
                    'user_id',
                    req.user.id
                );

            if (error) {
                throw error;
            }

            res.json({
                success: true
            });

        } catch (error) {
            console.error(
                'Error deleting invoice:',
                error
            );

            res.status(500).json({
                error: error.message
            });
        }
    }
);

// ─── STAFF ───────────────────────────────────────────────────

app.get(
    '/api/staff',
    authenticate,
    async (req, res) => {
        try {
            const userId = req.user.id;
            const {
                data,
                error
            } = await supabase
                .from('staff')
                .select('*')
                .eq('user_id', userId)
                .order('created_at', { ascending: false });

            if (error) {
                throw error;
            }

            const list = data || [];
            const counts = {};
            list.forEach(function (s) {
                counts[String(s.id)] = 0;
            });

            if (list.length) {
                try {
                    const ids = list.map(function (s) { return s.id; });
                    const { data: links, error: cErr } = await supabase
                        .from('job_staff')
                        .select('staff_id')
                        .in('staff_id', ids);
                    if (!cErr && links) {
                        links.forEach(function (row) {
                            const k = String(row.staff_id);
                            if (counts[k] !== undefined) counts[k] += 1;
                        });
                    } else if (cErr) {
                        console.warn('job_staff counts skipped:', cErr.message);
                    }
                } catch (e) {
                    console.warn('job_staff counts error:', e.message || e);
                }
            }

            const withCounts = list.map(function (s) {
                return Object.assign({}, s, {
                    jobs_assigned: counts[String(s.id)] || 0
                });
            });

            res.json(withCounts);

        } catch (error) {
            console.error(
                'Error fetching staff:',
                error
            );

            res.status(500).json({
                error: error.message
            });
        }
    }
);

app.post(
    '/api/staff',
    authenticate,
    async (req, res) => {
        try {
            const limitCheck =
                await checkPlanLimit(
                    req.user.id,
                    'staff'
                );

            if (!limitCheck.allowed) {
                return res.status(403).json({
                    error:
                        limitCheck.message,

                    limit:
                        limitCheck.limit,

                    count:
                        limitCheck.count,

                    plan:
                        limitCheck.plan
                });
            }

            const name = (req.body.name || req.body.full_name || '').toString().trim();
            if (!name) {
                return res.status(400).json({ error: 'Staff name is required' });
            }

            // Only known columns — spreading req.body can break insert / RLS
            const staff = {
                user_id: req.user.id,
                name: name,
                phone: (req.body.phone || '').toString().trim() || null,
                email: (req.body.email || '').toString().trim() || null,
                role: (req.body.role || 'Cleaner').toString().trim() || 'Cleaner'
            };

            let { data, error } = await supabase
                .from('staff')
                .insert(staff)
                .select()
                .single();

            // Retry without optional columns if schema is minimal
            if (error && /column|schema|email/i.test(error.message || '')) {
                const minimal = {
                    user_id: req.user.id,
                    name: name,
                    phone: staff.phone,
                    role: staff.role
                };
                const retry = await supabase
                    .from('staff')
                    .insert(minimal)
                    .select()
                    .single();
                data = retry.data;
                error = retry.error;
            }

            if (error) {
                console.error('Staff insert error:', error.message, error.code, error.details);
                const msg = error.message || 'Failed to create staff';
                if (/row-level security|RLS/i.test(msg)) {
                    return res.status(500).json({
                        error: 'Could not save staff (database security). Check SUPABASE_SERVICE_ROLE_KEY on Render.',
                        code: 'RLS_STAFF_INSERT',
                        detail: msg
                    });
                }
                return res.status(400).json({ error: msg });
            }

            res.json(data);

        } catch (error) {
            console.error(
                'Error creating staff:',
                error
            );

            res.status(500).json({
                error: error.message
            });
        }
    }
);

app.put(
    '/api/staff/:id',
    authenticate,
    async (req, res) => {
        try {
            const {
                data,
                error
            } = await supabase
                .from('staff')
                .update(req.body)
                .eq(
                    'id',
                    req.params.id
                )
                .eq(
                    'user_id',
                    req.user.id
                )
                .select()
                .single();

            if (error) {
                throw error;
            }

            res.json(data);

        } catch (error) {
            console.error(
                'Error updating staff:',
                error
            );

            res.status(500).json({
                error: error.message
            });
        }
    }
);

app.delete(
    '/api/staff/:id',
    authenticate,
    async (req, res) => {
        try {
            const {
                error
            } = await supabase
                .from('staff')
                .delete()
                .eq(
                    'id',
                    req.params.id
                )
                .eq(
                    'user_id',
                    req.user.id
                );

            if (error) {
                throw error;
            }

            res.json({
                success: true
            });

        } catch (error) {
            console.error(
                'Error deleting staff:',
                error
            );

            res.status(500).json({
                error: error.message
            });
        }
    }
);

// ─── LAUNDRY PRICING ────────────────────────────────────────

app.get(
    '/api/laundry-pricing',
    authenticate,
    async (req, res) => {
        try {
            const {
                data,
                error
            } = await supabase
                .from('laundry_pricing')
                .select('*')
                .eq(
                    'user_id',
                    req.user.id
                )
                .order(
                    'item_name',
                    {
                        ascending: true
                    }
                );

            if (error) {
                throw error;
            }

            res.json(data || []);

        } catch (error) {
            console.error(
                'laundry-pricing list:',
                error
            );

            res.status(500).json({
                error: error.message
            });
        }
    }
);

app.post(
    '/api/laundry-pricing',
    authenticate,
    async (req, res) => {
        try {
            const item_name =
                (
                    req.body.item_name ||
                    ''
                ).trim();

            const price =
                parseFloat(
                    req.body.price
                );

            if (
                !item_name ||
                isNaN(price) ||
                price < 0
            ) {
                return res.status(400).json({
                    error:
                        'item_name and valid price required'
                });
            }

            const {
                data,
                error
            } = await supabase
                .from(
                    'laundry_pricing'
                )
                .upsert(
                    {
                        user_id:
                            req.user.id,

                        item_name,

                        price,

                        updated_at:
                            new Date()
                                .toISOString()
                    },
                    {
                        onConflict:
                            'user_id,item_name'
                    }
                )
                .select()
                .single();

            if (error) {
                throw error;
            }

            res.json(data);

        } catch (error) {
            console.error(
                'laundry-pricing save:',
                error
            );

            res.status(500).json({
                error: error.message
            });
        }
    }
);

app.delete(
    '/api/laundry-pricing/:id',
    authenticate,
    async (req, res) => {
        try {
            const {
                error
            } = await supabase
                .from(
                    'laundry_pricing'
                )
                .delete()
                .eq(
                    'id',
                    req.params.id
                )
                .eq(
                    'user_id',
                    req.user.id
                );

            if (error) {
                throw error;
            }

            res.json({
                success: true
            });

        } catch (error) {
            console.error(
                'laundry-pricing delete:',
                error
            );

            res.status(500).json({
                error: error.message
            });
        }
    }
);

// ─── OWNER PIN ───────────────────────────────────────────────

function hashPin(pin) {
    return crypto
        .createHash('sha256')
        .update(
            String(pin) +
            (
                process.env.PIN_PEPPER ||
                'cleancrew-pin'
            )
        )
        .digest('hex');
}

app.get(
    '/api/owner-pin/status',
    authenticate,
    async (req, res) => {
        try {
            const {
                data,
                error
            } = await supabase
                .from('subscriptions')
                .select(
                    'owner_pin_hash, revenue_locked'
                )
                .eq(
                    'user_id',
                    req.user.id
                )
                .maybeSingle();

            if (error) {
                throw error;
            }

            const hasPin =
                !!(
                    data &&
                    data.owner_pin_hash
                );

            const locked =
                hasPin
                    ? data.revenue_locked !== false
                    : false;

            res.json({
                has_pin:
                    hasPin,

                locked
            });

        } catch (error) {
            console.error(
                'owner-pin status:',
                error
            );

            res.status(500).json({
                error: error.message
            });
        }
    }
);

app.post(
    '/api/owner-pin/set',
    authenticate,
    async (req, res) => {
        try {
            const pin =
                String(
                    req.body.pin || ''
                ).trim();

            const current =
                String(
                    req.body.current_pin ||
                    ''
                ).trim();

            if (!/^\d{4,6}$/.test(pin)) {
                return res.status(400).json({
                    error:
                        'PIN must be 4–6 digits'
                });
            }

            const {
                data: sub,
                error: subErr
            } = await supabase
                .from('subscriptions')
                .select(
                    'user_id, owner_pin_hash, plan, status'
                )
                .eq(
                    'user_id',
                    req.user.id
                )
                .maybeSingle();

            if (subErr) {
                throw subErr;
            }

            if (
                sub &&
                sub.owner_pin_hash
            ) {
                if (
                    !current ||
                    hashPin(current) !==
                        sub.owner_pin_hash
                ) {
                    return res.status(403).json({
                        error:
                            'Current PIN is incorrect. Enter your existing PIN to change it.'
                    });
                }
            }

            const payload = {
                owner_pin_hash:
                    hashPin(pin),

                revenue_locked:
                    true
            };

            if (
                sub &&
                sub.user_id
            ) {
                const {
                    error
                } = await supabase
                    .from('subscriptions')
                    .update(payload)
                    .eq(
                        'user_id',
                        req.user.id
                    );

                if (error) {
                    throw error;
                }
            } else {
                const {
                    error
                } = await supabase
                    .from('subscriptions')
                    .insert({
                        user_id:
                            req.user.id,

                        plan: 'free',

                        status:
                            'active',

                        ...payload
                    });

                if (error) {
                    throw error;
                }
            }

            res.json({
                success: true,
                has_pin: true,
                locked: true
            });

        } catch (error) {
            console.error(
                'owner-pin set:',
                error
            );

            res.status(500).json({
                error: error.message
            });
        }
    }
);

app.post(
    '/api/owner-pin/verify',
    authenticate,
    async (req, res) => {
        try {
            const pin =
                String(
                    req.body.pin || ''
                ).trim();

            const {
                data,
                error
            } = await supabase
                .from('subscriptions')
                .select(
                    'owner_pin_hash, revenue_locked'
                )
                .eq(
                    'user_id',
                    req.user.id
                )
                .maybeSingle();

            if (error) {
                throw error;
            }

            if (
                !data ||
                !data.owner_pin_hash
            ) {
                return res.json({
                    ok: true,
                    unlocked: true,
                    has_pin: false,
                    locked: false
                });
            }

            if (
                hashPin(pin) ===
                data.owner_pin_hash
            ) {
                await supabase
                    .from('subscriptions')
                    .update({
                        revenue_locked:
                            false
                    })
                    .eq(
                        'user_id',
                        req.user.id
                    );

                return res.json({
                    ok: true,
                    unlocked: true,
                    has_pin: true,
                    locked: false
                });
            }

            return res.status(403).json({
                ok: false,
                error:
                    'Incorrect PIN'
            });

        } catch (error) {
            console.error(
                'owner-pin verify:',
                error
            );

            res.status(500).json({
                error: error.message
            });
        }
    }
);

// ─── REVENUE LOCK ────────────────────────────────────────────

app.get(
    '/api/revenue/lock-status',
    authenticate,
    async (req, res) => {
        try {
            const {
                data,
                error
            } = await supabase
                .from('subscriptions')
                .select(
                    'revenue_locked, owner_pin_hash'
                )
                .eq(
                    'user_id',
                    req.user.id
                )
                .maybeSingle();

            if (error) {
                throw error;
            }

            if (
                !data ||
                !data.owner_pin_hash
            ) {
                return res.json({
                    locked: false,
                    has_pin: false
                });
            }

            const locked =
                data.revenue_locked !==
                undefined
                    ? data.revenue_locked
                    : true;

            res.json({
                locked,
                has_pin: true
            });

        } catch (error) {
            console.error(
                'Revenue lock status error:',
                error
            );

            res.status(500).json({
                error: error.message
            });
        }
    }
);

app.post(
    '/api/revenue/lock',
    authenticate,
    async (req, res) => {
        try {
            const {
                lock
            } = req.body;

            const {
                data: sub,
                error: subError
            } = await supabase
                .from('subscriptions')
                .select(
                    'owner_pin_hash'
                )
                .eq(
                    'user_id',
                    req.user.id
                )
                .maybeSingle();

            if (subError) {
                throw subError;
            }

            if (
                !sub ||
                !sub.owner_pin_hash
            ) {
                return res.status(400).json({
                    error:
                        'Please set an owner PIN first before locking revenue.'
                });
            }

            const {
                data,
                error
            } = await supabase
                .from('subscriptions')
                .update({
                    revenue_locked:
                        !!lock
                })
                .eq(
                    'user_id',
                    req.user.id
                )
                .select(
                    'revenue_locked'
                )
                .single();

            if (error) {
                throw error;
            }

            res.json({
                locked:
                    data.revenue_locked
            });

        } catch (error) {
            console.error(
                'Revenue lock toggle error:',
                error
            );

            res.status(500).json({
                error: error.message
            });
        }
    }
);


// ─── LOCATIONS (multi-branch) ────────────────────────────────
app.get('/api/locations', authenticate, async (req, res) => {
    try {
        const { data, error } = await supabase
            .from('locations')
            .select('*')
            .eq('user_id', req.user.id)
            .order('is_default', { ascending: false })
            .order('name', { ascending: true });
        if (error) throw error;
        res.json(data || []);
    } catch (error) {
        console.error('List locations error:', error);
        res.status(500).json({ error: error.message });
    }
});

app.post('/api/locations', authenticate, async (req, res) => {
    try {
        const name = String(req.body.name || '').trim();
        if (!name) return res.status(400).json({ error: 'Location name is required' });
        const isDefault = !!req.body.is_default;
        if (isDefault) {
            await supabase.from('locations').update({ is_default: false }).eq('user_id', req.user.id);
        }
        const row = {
            user_id: req.user.id,
            name,
            address: String(req.body.address || '').trim() || null,
            phone: String(req.body.phone || '').trim() || null,
            is_default: isDefault
        };
        const { data, error } = await supabase.from('locations').insert(row).select().single();
        if (error) throw error;
        res.json(data);
    } catch (error) {
        console.error('Create location error:', error);
        res.status(500).json({ error: error.message });
    }
});

app.put('/api/locations/:id', authenticate, async (req, res) => {
    try {
        const updates = {};
        if (req.body.name != null) updates.name = String(req.body.name).trim();
        if (req.body.address != null) updates.address = String(req.body.address).trim();
        if (req.body.phone != null) updates.phone = String(req.body.phone).trim();
        if (req.body.is_default != null) {
            updates.is_default = !!req.body.is_default;
            if (updates.is_default) {
                await supabase.from('locations').update({ is_default: false }).eq('user_id', req.user.id);
            }
        }
        const { data, error } = await supabase
            .from('locations')
            .update(updates)
            .eq('id', req.params.id)
            .eq('user_id', req.user.id)
            .select()
            .single();
        if (error) throw error;
        res.json(data);
    } catch (error) {
        console.error('Update location error:', error);
        res.status(500).json({ error: error.message });
    }
});

app.delete('/api/locations/:id', authenticate, async (req, res) => {
    try {
        // Clear references first (jobs/inventory keep working without location)
        try {
            await supabase.from('jobs').update({ location_id: null }).eq('location_id', req.params.id).eq('user_id', req.user.id);
        } catch (eJ) { console.warn('clear job location_id', eJ.message || eJ); }
        try {
            await supabase.from('inventory').update({ location_id: null }).eq('location_id', req.params.id).eq('user_id', req.user.id);
        } catch (eI) { console.warn('clear inventory location_id', eI.message || eI); }
        const { error } = await supabase
            .from('locations')
            .delete()
            .eq('id', req.params.id)
            .eq('user_id', req.user.id);
        if (error) throw error;
        res.json({ success: true });
    } catch (error) {
        console.error('Delete location error:', error);
        res.status(500).json({ error: error.message });
    }
});


// ─── BUSINESS PAGES (public mini landing on CleanCrew) ─────
function slugifyBusiness(input) {
    return String(input || '')
        .toLowerCase()
        .trim()
        .replace(/[^a-z0-9\s-]/g, '')
        .replace(/\s+/g, '-')
        .replace(/-+/g, '-')
        .replace(/^-|-$/g, '')
        .slice(0, 48) || 'business';
}

async function uniqueSlug(base, userId) {
    let slug = slugifyBusiness(base);
    if (!slug) slug = 'business';
    for (let i = 0; i < 20; i++) {
        const trySlug = i === 0 ? slug : slug + '-' + (i + 1);
        const { data } = await supabase
            .from('business_pages')
            .select('id, user_id')
            .eq('slug', trySlug)
            .maybeSingle();
        if (!data || data.user_id === userId) return trySlug;
    }
    return slug + '-' + Date.now().toString(36).slice(-4);
}

// Public — no auth
app.get('/api/public/business/:slug', async (req, res) => {
    try {
        const slug = String(req.params.slug || '').toLowerCase().trim();
        if (!slug) return res.status(400).json({ error: 'Slug required' });
        const { data, error } = await supabase
            .from('business_pages')
            .select('slug, business_name, tagline, phone, whatsapp, services, services_json, areas, about, logo_url, is_published, primary_color, booking_enabled, template_id, hero_image_url, testimonials')
            .eq('slug', slug)
            .eq('is_published', true)
            .maybeSingle();
        if (error) throw error;
        if (!data) return res.status(404).json({ error: 'Business page not found' });
        res.json(data);
    } catch (error) {
        console.error('Public business page error:', error);
        res.status(500).json({ error: error.message });
    }
});

// Public booking from business page
app.post('/api/public/business/:slug/book', async (req, res) => {
    try {
        const slug = String(req.params.slug || '').toLowerCase().trim();
        const body = req.body || {};
        const clientName = String(body.client_name || '').trim();
        const clientPhone = String(body.client_phone || '').trim();
        const serviceType = String(body.service_type || body.service || '').trim();
        if (!clientName || !clientPhone || !serviceType) {
            return res.status(400).json({ error: 'Name, phone, and service are required' });
        }
        const { data: page, error: pageErr } = await supabase
            .from('business_pages')
            .select('user_id, booking_enabled, is_published, business_name')
            .eq('slug', slug)
            .eq('is_published', true)
            .maybeSingle();
        if (pageErr) throw pageErr;
        if (!page) return res.status(404).json({ error: 'Business page not found' });
        if (page.booking_enabled === false) {
            return res.status(400).json({ error: 'Booking is disabled for this business' });
        }

        const row = {
            user_id: page.user_id,
            client_name: clientName,
            client_phone: clientPhone,
            client_email: String(body.client_email || '').trim() || null,
            client_address: String(body.client_address || '').trim() || null,
            service_type: serviceType,
            booking_date: body.booking_date || null,
            booking_time: body.booking_time || null,
            estimated_amount: body.estimated_amount != null ? Number(body.estimated_amount) : null,
            notes: String(body.notes || '').trim() || null,
            status: 'pending'
        };

        const { data, error } = await supabase
            .from('website_bookings')
            .insert(row)
            .select()
            .single();
        if (error) {
            if (/relation|does not exist|website_bookings/i.test(error.message || '')) {
                return res.status(400).json({ error: 'Run migrations_website_phase_a.sql in Supabase first' });
            }
            throw error;
        }
        res.json({ success: true, booking_id: data.id, message: 'Booking received' });
    } catch (error) {
        console.error('Public book error:', error);
        res.status(500).json({ error: error.message });
    }
});

// Owner: list website bookings
app.get('/api/website/bookings', authenticate, async (req, res) => {
    try {
        const { data, error } = await supabase
            .from('website_bookings')
            .select('*')
            .eq('user_id', req.user.id)
            .order('created_at', { ascending: false })
            .limit(100);
        if (error) {
            if (/relation|does not exist/i.test(error.message || '')) {
                return res.json([]);
            }
            throw error;
        }
        res.json(data || []);
    } catch (error) {
        console.error('List website bookings error:', error);
        res.status(500).json({ error: error.message });
    }
});

// Owner: update booking status
app.put('/api/website/bookings/:id', authenticate, async (req, res) => {
    try {
        const status = String((req.body || {}).status || '').toLowerCase();
        const allowed = ['pending', 'confirmed', 'completed', 'cancelled'];
        if (allowed.indexOf(status) === -1) {
            return res.status(400).json({ error: 'Invalid status' });
        }
        const { data, error } = await supabase
            .from('website_bookings')
            .update({ status, updated_at: new Date().toISOString() })
            .eq('id', req.params.id)
            .eq('user_id', req.user.id)
            .select()
            .single();
        if (error) throw error;
        res.json(data);
    } catch (error) {
        console.error('Update website booking error:', error);
        res.status(500).json({ error: error.message });
    }
});

// Owner: convert booking → job
app.post('/api/website/bookings/:id/convert', authenticate, async (req, res) => {
    try {
        const userId = req.user.id;
        const { data: booking, error: bErr } = await supabase
            .from('website_bookings')
            .select('*')
            .eq('id', req.params.id)
            .eq('user_id', userId)
            .single();
        if (bErr || !booking) return res.status(404).json({ error: 'Booking not found' });
        if (booking.converted_to_job_id) {
            return res.json({ success: true, job_id: booking.converted_to_job_id, already: true });
        }

        const job = {
            user_id: userId,
            client: booking.client_name,
            service: booking.service_type,
            amount: booking.estimated_amount != null ? Number(booking.estimated_amount) : 0,
            date: booking.booking_date || new Date().toISOString().slice(0, 10),
            status: 'pending',
            mode: 'cleaning',
            notes: [
                booking.client_phone ? ('Phone: ' + booking.client_phone) : '',
                booking.client_address ? ('Address: ' + booking.client_address) : '',
                booking.booking_time ? ('Time: ' + booking.booking_time) : '',
                booking.notes || '',
                '[From website booking]'
            ].filter(Boolean).join('\n')
        };

        const ins = await supabase.from('jobs').insert(job).select().single();
        if (ins.error) {
            // retry without mode/notes if columns missing
            if (/column|notes|mode/i.test(ins.error.message || '')) {
                delete job.mode;
                delete job.notes;
                const retry = await supabase.from('jobs').insert(job).select().single();
                if (retry.error) throw retry.error;
                ins.data = retry.data;
            } else throw ins.error;
        }

        await supabase
            .from('website_bookings')
            .update({
                converted_to_job_id: ins.data.id,
                converted_at: new Date().toISOString(),
                status: 'confirmed',
                updated_at: new Date().toISOString()
            })
            .eq('id', booking.id)
            .eq('user_id', userId);

        res.json({ success: true, job_id: ins.data.id, job: ins.data });
    } catch (error) {
        console.error('Convert booking error:', error);
        res.status(500).json({ error: error.message });
    }
});

// Owner — get or seed from invoice_settings
app.get('/api/business-page', authenticate, async (req, res) => {
    try {
        const userId = req.user.id;
        let { data, error } = await supabase
            .from('business_pages')
            .select('*')
            .eq('user_id', userId)
            .maybeSingle();
        if (error) throw error;
        if (!data) {
            const settings = await supabase
                .from('invoice_settings')
                .select('business_name, logo_url, phone')
                .eq('user_id', userId)
                .maybeSingle();
            const name = (settings.data && settings.data.business_name) || 'My Cleaning Business';
            const slug = await uniqueSlug(name, userId);
            const trialEnd = new Date();
            trialEnd.setMonth(trialEnd.getMonth() + 3);
            const row = {
                user_id: userId,
                slug,
                business_name: name,
                logo_url: (settings.data && settings.data.logo_url) || null,
                phone: (settings.data && settings.data.phone) || null,
                whatsapp: (settings.data && settings.data.phone) || null,
                tagline: 'Professional cleaning & laundry services',
                services: 'Home cleaning\nOffice cleaning\nLaundry',
                services_json: [
                    { name: 'Home Cleaning', price_min: 5000, price_max: 15000 },
                    { name: 'Office Cleaning', price_min: 8000, price_max: 25000 },
                    { name: 'Laundry', price_min: 500, price_max: null }
                ],
                primary_color: '#1A6DDB',
                template_id: 'modern',
                booking_enabled: true,
                trial_started_at: new Date().toISOString(),
                trial_ends_at: trialEnd.toISOString(),
                areas: '',
                about: '',
                is_published: true
            };
            const ins = await supabase.from('business_pages').insert(row).select().single();
            if (ins.error) {
                if (/relation|does not exist|business_pages/i.test(ins.error.message || '')) {
                    return res.status(400).json({ error: 'Run migrations_business_pages.sql in Supabase first' });
                }
                if (/row-level security|RLS|violates row-level/i.test(ins.error.message || '')) {
                    return res.status(400).json({
                        error: 'Database security blocked save. On Render set SUPABASE_SERVICE_ROLE_KEY to the service_role key (not anon), then run migrations_fix_rls_business_pages.sql in Supabase.'
                    });
                }
                throw ins.error;
            }
            data = ins.data;
        }
        res.json(data);
    } catch (error) {
        console.error('Get business page error:', error);
        res.status(500).json({ error: error.message });
    }
});

app.put('/api/business-page', authenticate, async (req, res) => {
    try {
        const userId = req.user.id;
        const body = req.body || {};
        const businessName = String(body.business_name || '').trim();
        if (!businessName) return res.status(400).json({ error: 'Business name is required' });

        let slug = body.slug ? slugifyBusiness(body.slug) : slugifyBusiness(businessName);
        slug = await uniqueSlug(slug, userId);

        let servicesJson = body.services_json;
        if (typeof servicesJson === 'string') {
            try { servicesJson = JSON.parse(servicesJson); } catch (e) { servicesJson = []; }
        }
        if (!Array.isArray(servicesJson)) servicesJson = [];

        const payload = {
            user_id: userId,
            slug,
            business_name: businessName,
            tagline: String(body.tagline || '').trim() || null,
            phone: String(body.phone || '').trim() || null,
            whatsapp: String(body.whatsapp || body.phone || '').trim() || null,
            services: String(body.services || '').trim() || null,
            services_json: servicesJson,
            areas: String(body.areas || '').trim() || null,
            about: String(body.about || '').trim() || null,
            logo_url: body.logo_url || null,
            primary_color: String(body.primary_color || '#1A6DDB').trim() || '#1A6DDB',
            template_id: ['modern','vibrant','elegant'].indexOf(String(body.template_id||'').toLowerCase()) >= 0 ? String(body.template_id).toLowerCase() : 'modern',
            hero_image_url: body.hero_image_url || null,
            testimonials: String(body.testimonials || '').trim() || null,
            booking_enabled: body.booking_enabled !== false,
            is_published: body.is_published !== false,
            published_at: body.is_published !== false ? new Date().toISOString() : null,
            updated_at: new Date().toISOString()
        };

        const existing = await supabase
            .from('business_pages')
            .select('id')
            .eq('user_id', userId)
            .maybeSingle();

        let data, error;
        if (existing.data && existing.data.id) {
            const upd = await supabase
                .from('business_pages')
                .update(payload)
                .eq('user_id', userId)
                .select()
                .single();
            data = upd.data;
            error = upd.error;
        } else {
            const ins = await supabase
                .from('business_pages')
                .insert(payload)
                .select()
                .single();
            data = ins.data;
            error = ins.error;
        }
        if (error) {
            if (/duplicate|unique/i.test(error.message || '')) {
                return res.status(400).json({ error: 'That page link is taken — try a different slug' });
            }
            if (/relation|does not exist/i.test(error.message || '')) {
                return res.status(400).json({ error: 'Run migrations_business_pages.sql in Supabase first' });
            }
            throw error;
        }
        res.json(data);
    } catch (error) {
        console.error('Save business page error:', error);
        res.status(500).json({ error: error.message });
    }
});


// ─── INVOICE SETTINGS ───────────────────────────────────────


// Convert quotation → invoice
app.post('/api/invoices/:id/convert-to-invoice', authenticate, async (req, res) => {
    try {
        const userId = req.user.id;
        const id = req.params.id;
        const { data: row, error: fetchErr } = await supabase
            .from('invoices')
            .select('*')
            .eq('id', id)
            .eq('user_id', userId)
            .single();
        if (fetchErr || !row) {
            return res.status(404).json({ error: 'Quotation not found' });
        }
        const isQuote = row.doc_type === 'quotation' || row.status === 'quotation';
        if (!isQuote) {
            return res.status(400).json({ error: 'Only quotations can be converted to invoices' });
        }
        const updates = {
            doc_type: 'invoice',
            status: 'unpaid',
            quote_status: 'converted',
            amount_paid: 0,
            paid_at: null
        };
        // Keep QT number or issue invoice number — keep same number for audit trail, tag in description
        const { data, error } = await supabase
            .from('invoices')
            .update(updates)
            .eq('id', id)
            .eq('user_id', userId)
            .select()
            .single();
        if (error) {
            // Retry without doc_type if column missing
            if (/doc_type|column/i.test(error.message || '')) {
                const { data: d2, error: e2 } = await supabase
                    .from('invoices')
                    .update({ status: 'unpaid', amount_paid: 0, paid_at: null })
                    .eq('id', id)
                    .eq('user_id', userId)
                    .select()
                    .single();
                if (e2) return res.status(400).json({ error: e2.message });
                return res.json(d2);
            }
            return res.status(400).json({ error: error.message });
        }
        res.json(data);
    } catch (error) {
        console.error('Convert quotation error:', error);
        res.status(500).json({ error: error.message });
    }
});

app.get(
    '/api/invoice-settings',
    authenticate,
    async (req, res) => {
        try {
            const {
                data,
                error
            } = await supabase
                .from(
                    'invoice_settings'
                )
                .select('*')
                .eq(
                    'user_id',
                    req.user.id
                )
                .maybeSingle();

            if (error) {
                throw error;
            }

            res.json(data || {});

        } catch (error) {
            console.error(
                'Get invoice settings error:',
                error
            );

            res.status(500).json({
                error: error.message
            });
        }
    }
);

app.post(
    '/api/invoice-settings',
    authenticate,
    async (req, res) => {
        try {
            const userId = req.user.id;
            const body = req.body || {};

            // Only allow known columns — never trust client id (would break upsert)
            const payload = {
                user_id: userId,
                business_name: body.business_name != null ? String(body.business_name).trim() : '',
                business_address: body.business_address != null ? String(body.business_address).trim() : '',
                phone: body.phone != null ? String(body.phone).trim() : '',
                email: body.email != null ? String(body.email).trim() : '',
                bank_name: body.bank_name != null ? String(body.bank_name).trim() : '',
                account_name: body.account_name != null ? String(body.account_name).trim() : '',
                account_number: body.account_number != null ? String(body.account_number).trim() : '',
                payment_whatsapp: body.payment_whatsapp != null ? String(body.payment_whatsapp).trim() : '',
                terms_and_conditions: body.terms_and_conditions != null ? String(body.terms_and_conditions).trim() : '',
                logo_url: body.logo_url != null ? String(body.logo_url).trim() : '',
                invoice_accent: body.invoice_accent != null ? String(body.invoice_accent).trim() : '#1a6ddb',
                invoice_template: body.invoice_template != null ? String(body.invoice_template).trim() : 'classic',
                invoice_title: body.invoice_title != null ? String(body.invoice_title).trim() : '',
                invoice_tagline: body.invoice_tagline != null ? String(body.invoice_tagline).trim() : '',
                invoice_options: body.invoice_options && typeof body.invoice_options === 'object' ? JSON.stringify(body.invoice_options) : '{}',
                updated_at: new Date().toISOString()
            };

            // Prefer update-if-exists so unique(user_id) is never violated
            const existing = await supabase
                .from('invoice_settings')
                .select('id')
                .eq('user_id', userId)
                .maybeSingle();

            if (existing.error) {
                throw existing.error;
            }

            let data, error;
            if (existing.data && existing.data.id) {
                const updated = await supabase
                    .from('invoice_settings')
                    .update(payload)
                    .eq('user_id', userId)
                    .select()
                    .single();
                data = updated.data;
                error = updated.error;
            } else {
                const inserted = await supabase
                    .from('invoice_settings')
                    .upsert(payload, { onConflict: 'user_id' })
                    .select()
                    .single();
                data = inserted.data;
                error = inserted.error;
            }

            if (error && /logo_url|terms_and_conditions|invoice_accent|invoice_template|invoice_title|column/i.test(error.message || '')) {
                if (/logo_url/i.test(error.message || '')) delete payload.logo_url;
                if (/terms_and_conditions/i.test(error.message || '')) delete payload.terms_and_conditions;
                if (/invoice_accent/i.test(error.message || '')) delete payload.invoice_accent;
                if (/invoice_template/i.test(error.message || '')) delete payload.invoice_template;
                if (/invoice_title/i.test(error.message || '')) delete payload.invoice_title;
                if (/invoice_tagline/i.test(error.message || '')) delete payload.invoice_tagline;
                if (/invoice_options/i.test(error.message || '')) delete payload.invoice_options;
                const retry = existing.data && existing.data.id
                    ? await supabase.from('invoice_settings').update(payload).eq('user_id', userId).select().single()
                    : await supabase.from('invoice_settings').upsert(payload, { onConflict: 'user_id' }).select().single();
                if (retry.error) throw retry.error;
                return res.json(Object.assign({}, retry.data || payload, {
                    warning: 'logo_url column missing — run ALTER TABLE invoice_settings ADD COLUMN logo_url TEXT'
                }));
            }

            if (error) {
                throw error;
            }

            res.json(data || payload);
        } catch (error) {
            console.error(
                'Save invoice settings error:',
                error
            );

            res.status(500).json({
                error: error.message
            });
        }
    }
);


// ─── PUBLIC INVOICE LINK (branded share — no login) ─────────
// UUID acts as the secret; only invoices with a generated PDF are reachable.
app.get('/api/public/invoice/:id', async (req, res) => {
    try {
        const id = String(req.params.id || '').trim();
        // Accept UUID form only (avoids PostgREST errors on garbage ids)
        const uuidRe = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
        if (!uuidRe.test(id)) {
            return res.status(400).json({ error: 'Invalid invoice link' });
        }

        // select * so missing optional columns never break the public link
        let invoice = null;
        let error = null;
        const full = await supabase
            .from('invoices')
            .select('*')
            .eq('id', id)
            .maybeSingle();
        error = full.error;
        invoice = full.data;

        if (error) {
            console.error('Public invoice query error:', error.message || error);
            return res.status(500).json({
                error: 'Could not open invoice',
                details: error.message || String(error)
            });
        }
        if (!invoice) {
            return res.status(404).json({ error: 'Invoice not found' });
        }
        if (!invoice.pdf_url) {
            return res.status(404).json({
                error: 'This invoice PDF is not ready yet. Ask the business to generate it again.'
            });
        }

        if (String(req.query.format || '') === 'json') {
            const amount =
                invoice.amount_due != null ? invoice.amount_due :
                (invoice.amount != null ? invoice.amount : null);
            return res.json({
                id: invoice.id,
                pdf_url: invoice.pdf_url,
                number: invoice.number || invoice.invoice_numb || '',
                client: invoice.client || '',
                amount: amount,
                status: invoice.status || '',
                doc_type: invoice.doc_type || 'invoice',
                date: invoice.date || invoice.created_at || null
            });
        }

        return res.redirect(302, invoice.pdf_url);
    } catch (err) {
        console.error('Public invoice error:', err);
        return res.status(500).json({
            error: 'Could not open invoice',
            details: err && err.message ? err.message : String(err)
        });
    }
});

// ─── GENERATE INVOICE PDF ───────────────────────────────────

app.post(
    '/api/invoices/:id/generate-pdf',
    authenticate,
    async (req, res) => {
        try {
            const {
                id
            } = req.params;

            const userId =
                req.user.id;

            const {
                data: invoice,
                error: invoiceError
            } = await supabase
                .from('invoices')
                .select('*')
                .eq('id', id)
                .eq(
                    'user_id',
                    userId
                )
                .single();

            if (invoiceError) {
                throw invoiceError;
            }

            if (!invoice) {
                return res.status(404).json({
                    error:
                        'Invoice not found'
                });
            }

            const {
                data: settings,
                error: settingsError
            } = await supabase
                .from(
                    'invoice_settings'
                )
                .select('*')
                .eq(
                    'user_id',
                    userId
                )
                .maybeSingle();

            if (settingsError) {
                throw settingsError;
            }

            function hexToRgb(hex) {
                const h = String(hex || '').replace('#', '').trim();
                if (h.length === 6 && /^[0-9a-fA-F]+$/.test(h)) {
                    return {
                        r: parseInt(h.slice(0, 2), 16),
                        g: parseInt(h.slice(2, 4), 16),
                        b: parseInt(h.slice(4, 6), 16)
                    };
                }
                return { r: 26, g: 109, b: 219 };
            }
            const invoiceTemplate = String(
                (req.body && req.body.invoice_template) ||
                (settings && settings.invoice_template) ||
                'classic'
            ).toLowerCase();
            const accentHex = String(
                (req.body && req.body.invoice_accent) ||
                (settings && (settings.invoice_accent || settings.accent_color)) ||
                '#1a6ddb'
            );
            const accent = hexToRgb(accentHex);
            const customTitle = String(
                (req.body && req.body.invoice_title) ||
                (settings && settings.invoice_title) ||
                ''
            ).trim();

            // Branch contact from job location when set
            let branchLocation = null;
            if (invoice.job_id) {
                try {
                    const jobRes = await supabase
                        .from('jobs')
                        .select('location_id')
                        .eq('id', invoice.job_id)
                        .eq('user_id', userId)
                        .maybeSingle();
                    if (jobRes.data && jobRes.data.location_id) {
                        const locRes = await supabase
                            .from('locations')
                            .select('*')
                            .eq('id', jobRes.data.location_id)
                            .eq('user_id', userId)
                            .maybeSingle();
                        branchLocation = locRes.data || null;
                    }
                } catch (locErr) {
                    console.warn('Location lookup for invoice failed', locErr.message || locErr);
                }
            }

            
            const {
                jsPDF
            } = require('jspdf');

            const doc = new jsPDF();
            const pageWidth = doc.internal.pageSize.getWidth();
            const pageHeight = doc.internal.pageSize.getHeight();
            const margin = 18;
            const contentW = pageWidth - margin * 2;
            let y = margin;

            // ── Resolve business / invoice data (never invent) ──
            const businessName = (settings && settings.business_name) || 'Your Business';
            const tagline = String(
                (req.body && req.body.invoice_tagline) ||
                (settings && (settings.invoice_tagline || settings.tagline)) ||
                ''
            ).trim();
            const address =
                (branchLocation && branchLocation.address) ||
                (settings && settings.business_address) ||
                '';
            const phone =
                (branchLocation && branchLocation.phone) ||
                (settings && settings.phone) ||
                '';
            const email = (settings && settings.email) || '';
            const website = String(
                (req.body && req.body.website) ||
                (settings && settings.website) ||
                ''
            ).trim();
            const logoUrl =
                (req.body && req.body.logo_url) ||
                (settings && settings.logo_url) ||
                '';

            const bankName = (settings && settings.bank_name) || '';
            const accountName = (settings && settings.account_name) || '';
            const accountNumber = (settings && settings.account_number) || '';
            const paymentWhatsapp = (settings && settings.payment_whatsapp) || '';

            const bodyOpts = (req.body && req.body.invoice_options) || {};
            let setOpts = (settings && settings.invoice_options) || {};
            if (typeof setOpts === 'string') {
                try { setOpts = JSON.parse(setOpts); } catch (eSo) { setOpts = {}; }
            }
            if (!setOpts || typeof setOpts !== 'object') setOpts = {};
            function optOn(key, def) {
                if (bodyOpts[key] !== undefined) return !!bodyOpts[key];
                if (typeof setOpts === 'object' && setOpts && setOpts[key] !== undefined) return !!setOpts[key];
                // legacy bool columns
                if (settings && settings['show_' + key] !== undefined && settings['show_' + key] !== null) {
                    return !!settings['show_' + key];
                }
                return def;
            }
            const showLogo = optOn('logo', true);
            const showAddress = optOn('address', true);
            const showPhone = optOn('phone', true);
            const showEmail = optOn('email', true);
            const showWebsite = optOn('website', true);
            const showPayment = optOn('payment', true);
            const showTerms = optOn('terms', true);
            const showThankYou = optOn('thankyou', true);

            const isQuote = invoice.doc_type === 'quotation' ||
                String(invoice.status || '').toLowerCase() === 'quotation';
            const docLabel = customTitle || (isQuote ? 'QUOTATION' : 'INVOICE');
            const invoiceNumber = invoice.number || invoice.invoice_numb || invoice.id || '';
            const invDate = invoice.date ? new Date(invoice.date) : (invoice.created_at ? new Date(invoice.created_at) : new Date());
            const dueDate = invoice.due_date || invoice.valid_until || null;
            const amountDue = Number(invoice.amount_due != null ? invoice.amount_due : invoice.amount) || 0;
            const amountPaid = Number(invoice.amount_paid) || 0;
            let statusRaw = String(invoice.status || 'unpaid').toLowerCase();
            if (!isQuote) {
                if (amountPaid <= 0) statusRaw = 'unpaid';
                else if (amountDue > 0 && amountPaid >= amountDue) statusRaw = 'paid';
                else if (amountPaid > 0) statusRaw = 'partial';
            }
            const statusLabel = isQuote
                ? String(invoice.quote_status || invoice.status || 'draft').toUpperCase()
                : statusRaw.toUpperCase();

            function fmtDate(d) {
                try {
                    const dt = d instanceof Date ? d : new Date(d);
                    if (isNaN(dt.getTime())) return '—';
                    return dt.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
                } catch (e) { return '—'; }
            }
            function fmtMoney(n) {
                const v = Math.round(Number(n) || 0);
                try {
                    return 'NGN ' + v.toLocaleString('en-NG');
                } catch (e) {
                    return 'NGN ' + String(v);
                }
            }
            // Prefer Naira symbol if possible in Helvetica
            function money(n) {
                const v = Math.round(Number(n) || 0);
                return 'NGN ' + v.toLocaleString('en-NG');
            }

            function ensureSpace(need) {
                if (y + need > pageHeight - 22) {
                    doc.addPage();
                    y = margin;
                }
            }


            // White page — professional documents stay clean
            doc.setFillColor(255, 255, 255);
            doc.rect(0, 0, pageWidth, pageHeight, 'F');

            const headerIsDark = invoiceTemplate === 'bold';
            if (invoiceTemplate === 'bold') {
                doc.setFillColor(accent.r, accent.g, accent.b);
                doc.rect(0, 0, pageWidth, 52, 'F');
            } else if (invoiceTemplate === 'modern') {
                doc.setFillColor(accent.r, accent.g, accent.b);
                doc.rect(0, 0, 5, pageHeight, 'F');
            }

            // ── Top row: brand left | document meta right ──
            let cursorY = 16;
            if (invoiceTemplate === 'modern') cursorY = 16;

            // Logo
            let brandX = margin;
            const logoSize = 20;
            if (showLogo && logoUrl) {
                try {
                    let fmt = 'JPEG';
                    let b64 = null;
                    const raw = String(logoUrl).trim();
                    const dataMatch = raw.match(/^data:image\/([a-zA-Z0-9+.-]+);base64,([\s\S]+)$/i);
                    if (dataMatch) {
                        if (String(dataMatch[1]).toLowerCase().indexOf('png') !== -1) fmt = 'PNG';
                        b64 = dataMatch[2].replace(/\s/g, '');
                    } else if (/^https?:\/\//i.test(raw)) {
                        const imgRes = await fetch(raw);
                        if (imgRes.ok) {
                            const buf = Buffer.from(await imgRes.arrayBuffer());
                            b64 = buf.toString('base64');
                            if (raw.toLowerCase().indexOf('.png') !== -1) fmt = 'PNG';
                        }
                    }
                    if (b64) {
                        doc.addImage(b64, fmt, brandX, cursorY, logoSize, logoSize);
                        brandX = margin + logoSize + 7;
                    }
                } catch (logoErr) {
                    console.warn('Invoice logo skip', logoErr && logoErr.message);
                }
            }

            const textOnDark = headerIsDark;
            const primaryR = textOnDark ? 255 : accent.r;
            const primaryG = textOnDark ? 255 : accent.g;
            const primaryB = textOnDark ? 255 : accent.b;
            const bodyR = textOnDark ? 235 : 55;
            const bodyG = textOnDark ? 240 : 65;
            const bodyB = textOnDark ? 250 : 80;

            doc.setFont('helvetica', 'bold');
            doc.setFontSize(15);
            doc.setTextColor(primaryR, primaryG, primaryB);
            doc.text(String(businessName).substring(0, 42), brandX, cursorY + 7);

            let leftMetaY = cursorY + 13;
            doc.setFont('helvetica', 'normal');
            doc.setFontSize(8);
            doc.setTextColor(bodyR, bodyG, bodyB);
            if (tagline) {
                doc.text(String(tagline).substring(0, 55), brandX, leftMetaY);
                leftMetaY += 4.5;
            }
            const contactLine = [];
            if (showPhone && phone) contactLine.push(String(phone));
            if (showEmail && email) contactLine.push(String(email));
            if (showWebsite && website) contactLine.push(String(website));
            if (contactLine.length) {
                doc.text(contactLine.join('  ·  ').substring(0, 85), brandX, leftMetaY);
                leftMetaY += 4.5;
            }
            if (showAddress && address) {
                const addrLines = doc.splitTextToSize(String(address), contentW * 0.5);
                addrLines.slice(0, 2).forEach(function (ln) {
                    doc.text(ln, brandX, leftMetaY);
                    leftMetaY += 4;
                });
            }

            // Right meta block — always visible
            const rightEdge = pageWidth - margin;
            doc.setFont('helvetica', 'bold');
            doc.setFontSize(16);
            doc.setTextColor(primaryR, primaryG, primaryB);
            doc.text(String(docLabel).toUpperCase().substring(0, 22), rightEdge, cursorY + 7, { align: 'right' });

            let rightMetaY = cursorY + 14;
            doc.setFontSize(10);
            doc.setTextColor(textOnDark ? 255 : 30, textOnDark ? 255 : 35, textOnDark ? 255 : 45);
            if (invoiceNumber) {
                doc.setFont('helvetica', 'bold');
                doc.text('#' + String(invoiceNumber).replace(/^#/, ''), rightEdge, rightMetaY, { align: 'right' });
                rightMetaY += 5.5;
            }
            doc.setFont('helvetica', 'normal');
            doc.setFontSize(9);
            doc.setTextColor(bodyR, bodyG, bodyB);
            doc.text('Invoice date: ' + fmtDate(invDate), rightEdge, rightMetaY, { align: 'right' });
            rightMetaY += 5;
            if (dueDate) {
                doc.text((isQuote ? 'Valid until: ' : 'Due date: ') + fmtDate(dueDate), rightEdge, rightMetaY, { align: 'right' });
                rightMetaY += 5;
            }
            // Status
            let stR = 120, stG = 120, stB = 120;
            if (statusRaw === 'paid') { stR = 5; stG = 140; stB = 90; }
            else if (statusRaw === 'partial') { stR = 30; stG = 90; stB = 200; }
            else if (statusRaw === 'overdue') { stR = 200; stG = 40; stB = 40; }
            else if (isQuote) { stR = 110; stG = 50; stB = 200; }
            else { stR = 160; stG = 110; stB = 20; }
            if (textOnDark) {
                // keep status readable on bold bar
                doc.setFont('helvetica', 'bold');
                doc.setFontSize(9);
                doc.setTextColor(255, 255, 255);
                doc.text('Status: ' + statusLabel, rightEdge, rightMetaY, { align: 'right' });
            } else {
                doc.setFont('helvetica', 'bold');
                doc.setFontSize(9);
                doc.setTextColor(stR, stG, stB);
                doc.text(statusLabel, rightEdge, rightMetaY, { align: 'right' });
            }
            rightMetaY += 4;

            y = Math.max(leftMetaY, rightMetaY, cursorY + logoSize) + 8;
            if (invoiceTemplate === 'bold') {
                y = Math.max(y, 58);
            }

            // Accent rule under header
            doc.setDrawColor(accent.r, accent.g, accent.b);
            doc.setLineWidth(invoiceTemplate === 'minimal' ? 0.4 : 1.0);
            doc.line(margin, y, pageWidth - margin, y);
            y += 12;

            // ════════ FROM / BILL TO ════════
            ensureSpace(36);
            const colW = (contentW - 10) / 2;
            doc.setFont('helvetica', 'bold');
            doc.setFontSize(8);
            doc.setTextColor(accent.r, accent.g, accent.b);
            doc.text('FROM', margin, y);
            doc.text('BILL TO', margin + colW + 10, y);
            y += 5;

            doc.setFont('helvetica', 'bold');
            doc.setFontSize(10);
            doc.setTextColor(30, 35, 45);
            doc.text(String(businessName).substring(0, 40), margin, y);
            const clientName = String(invoice.client || invoice.client_name || 'Customer').substring(0, 40);
            doc.text(clientName, margin + colW + 10, y);
            y += 5;

            doc.setFont('helvetica', 'normal');
            doc.setFontSize(8);
            doc.setTextColor(90, 100, 115);
            let leftY = y;
            let rightY = y;
            if (showAddress && address) {
                const lines = doc.splitTextToSize(String(address), colW);
                lines.slice(0, 3).forEach(function (ln) {
                    doc.text(ln, margin, leftY);
                    leftY += 4;
                });
            }
            if (showPhone && phone) { doc.text(String(phone), margin, leftY); leftY += 4; }
            if (showEmail && email) { doc.text(String(email), margin, leftY); leftY += 4; }

            const clientPhone = invoice.phone || invoice.client_phone || '';
            const clientEmail = invoice.client_email || invoice.email || '';
            const clientAddr = invoice.client_address || invoice.address || '';
            if (clientAddr) {
                const lines = doc.splitTextToSize(String(clientAddr), colW);
                lines.slice(0, 3).forEach(function (ln) {
                    doc.text(ln, margin + colW + 10, rightY);
                    rightY += 4;
                });
            }
            if (clientPhone) { doc.text(String(clientPhone), margin + colW + 10, rightY); rightY += 4; }
            if (clientEmail) { doc.text(String(clientEmail), margin + colW + 10, rightY); rightY += 4; }

            y = Math.max(leftY, rightY) + 10;

            // ════════ LINE ITEMS ════════
            ensureSpace(40);
            let items = [];
            if (Array.isArray(invoice.line_items) && invoice.line_items.length) {
                items = invoice.line_items.map(function (it) {
                    const qty = Number(it.qty != null ? it.qty : it.quantity) || 1;
                    const rate = Number(it.rate != null ? it.rate : it.unit_price != null ? it.unit_price : it.amount) || 0;
                    const amt = Number(it.amount != null ? it.amount : qty * rate) || 0;
                    return {
                        service: String(it.service || it.name || it.description || 'Service').substring(0, 48),
                        desc: String(it.description || it.notes || '').substring(0, 48),
                        qty: qty,
                        rate: rate,
                        amount: amt
                    };
                });
            } else {
                // Single line from invoice fields — no fabricated extras
                const svcLabel = String(
                    invoice.service ||
                    invoice.description ||
                    invoice.notes ||
                    (isQuote ? 'Quoted work' : 'Professional service')
                ).trim() || 'Professional service';
                items = [{
                    service: svcLabel.substring(0, 48),
                    desc: String(invoice.description && invoice.service ? invoice.description : '').substring(0, 48),
                    qty: 1,
                    rate: amountDue,
                    amount: amountDue
                }];
            }

            // Table header
            const rowH = 7;
            doc.setFillColor(
                Math.min(255, accent.r + 200),
                Math.min(255, accent.g + 200),
                Math.min(255, accent.b + 200)
            );
            doc.roundedRect(margin, y - 4, contentW, rowH + 2, 1, 1, 'F');
            doc.setFont('helvetica', 'bold');
            doc.setFontSize(8);
            doc.setTextColor(50, 60, 75);
            const c1 = margin + 2;
            const c2 = margin + contentW * 0.38;
            const c3 = margin + contentW * 0.62;
            const c4 = margin + contentW * 0.74;
            const c5 = margin + contentW - 2;
            doc.text('SERVICE', c1, y + 1);
            doc.text('DESCRIPTION', c2, y + 1);
            doc.text('QTY', c3, y + 1);
            doc.text('RATE', c4, y + 1);
            doc.text('AMOUNT', c5, y + 1, { align: 'right' });
            y += rowH + 3;

            doc.setFont('helvetica', 'normal');
            doc.setFontSize(9);
            items.forEach(function (it, idx) {
                ensureSpace(12);
                if (idx % 2 === 1) {
                    doc.setFillColor(248, 249, 251);
                    doc.rect(margin, y - 4, contentW, rowH + 1, 'F');
                }
                doc.setTextColor(30, 35, 45);
                doc.text(String(it.service).substring(0, 28), c1, y);
                doc.setTextColor(110, 118, 130);
                doc.text(String(it.desc || '—').substring(0, 22), c2, y);
                doc.setTextColor(30, 35, 45);
                doc.text(String(it.qty), c3, y);
                doc.text(money(it.rate), c4, y);
                doc.text(money(it.amount), c5, y, { align: 'right' });
                y += rowH + 2;
            });

            y += 4;
            doc.setDrawColor(220, 225, 232);
            doc.setLineWidth(0.3);
            doc.line(margin + contentW * 0.55, y, pageWidth - margin, y);
            y += 8;

            // Totals
            ensureSpace(28);
            const totalsX = margin + contentW * 0.58;
            const totalsValX = pageWidth - margin;
            doc.setFont('helvetica', 'normal');
            doc.setFontSize(9);
            doc.setTextColor(90, 100, 115);
            doc.text('Subtotal', totalsX, y);
            doc.text(money(amountDue), totalsValX, y, { align: 'right' });
            y += 6;
            if (amountPaid > 0 && amountPaid < amountDue) {
                doc.text('Amount paid', totalsX, y);
                doc.text(money(amountPaid), totalsValX, y, { align: 'right' });
                y += 6;
            }
            // Total due box — keep label + amount inside with padding
            ensureSpace(18);
            const totalLabel = isQuote ? 'QUOTE TOTAL' : (statusRaw === 'paid' ? 'TOTAL PAID' : 'TOTAL DUE');
            const totalVal = statusRaw === 'paid' ? amountDue : Math.max(amountDue - amountPaid, 0);
            const totalText = money(statusRaw === 'paid' ? amountDue : (amountPaid > 0 ? totalVal : amountDue));
            const boxX = totalsX - 4;
            const boxW = (pageWidth - margin) - boxX; // flush to right margin
            const boxH = 16;
            doc.setFillColor(accent.r, accent.g, accent.b);
            doc.roundedRect(boxX, y - 5, boxW, boxH, 2, 2, 'F');
            doc.setFont('helvetica', 'bold');
            doc.setFontSize(10);
            doc.setTextColor(255, 255, 255);
            const pad = 8;
            doc.text(totalLabel, boxX + pad, y + 4);
            doc.text(totalText, boxX + boxW - pad, y + 4, { align: 'right' });
            y += 20;

            // ════════ PAYMENT INFO ════════
            if (showPayment && (bankName || accountName || accountNumber || paymentWhatsapp)) {
                ensureSpace(32);
                doc.setFont('helvetica', 'bold');
                doc.setFontSize(9);
                doc.setTextColor(accent.r, accent.g, accent.b);
                doc.text('PAYMENT INFORMATION', margin, y);
                y += 6;
                doc.setFont('helvetica', 'normal');
                doc.setFontSize(9);
                doc.setTextColor(40, 45, 55);
                if (accountName) { doc.text('Account name: ' + accountName, margin, y); y += 5; }
                if (bankName) { doc.text('Bank: ' + bankName, margin, y); y += 5; }
                if (accountNumber) { doc.text('Account number: ' + accountNumber, margin, y); y += 5; }
                if (invoiceNumber) { doc.text('Payment reference: ' + String(invoiceNumber), margin, y); y += 5; }
                if (paymentWhatsapp) { doc.text('Send payment proof to: ' + paymentWhatsapp, margin, y); y += 5; }
                y += 4;
            }

            // ════════ TERMS ════════
            const bodyTerms = (req.body && (req.body.terms_and_conditions || req.body.terms))
                ? String(req.body.terms_and_conditions || req.body.terms).trim()
                : '';
            const termsRaw = (
                (settings && (settings.terms_and_conditions || settings.terms)) ||
                bodyTerms ||
                ''
            ).toString().trim();
            if (showTerms && termsRaw) {
                ensureSpace(28);
                doc.setFont('helvetica', 'bold');
                doc.setFontSize(9);
                doc.setTextColor(accent.r, accent.g, accent.b);
                doc.text('TERMS & CONDITIONS', margin, y);
                y += 5;
                doc.setFont('helvetica', 'normal');
                doc.setFontSize(8);
                doc.setTextColor(80, 90, 100);
                const termsLines = termsRaw.split(/\r?\n/).map(function (l) { return String(l || '').trim(); }).filter(Boolean);
                const blocks = termsLines.length ? termsLines : [termsRaw];
                blocks.forEach(function (line) {
                    const wrapped = doc.splitTextToSize(line, contentW);
                    wrapped.forEach(function (wline) {
                        ensureSpace(6);
                        doc.text(wline, margin, y);
                        y += 4;
                    });
                    y += 1;
                });
                y += 4;
            }

            // ════════ FOOTER ════════
            ensureSpace(16);
            if (showThankYou) {
                doc.setFont('helvetica', 'italic');
                doc.setFontSize(9);
                doc.setTextColor(70, 80, 95);
                doc.text('Thank you for choosing ' + String(businessName).substring(0, 40) + '.', margin, y);
                y += 8;
            }
            // Subtle CleanCrew credit — secondary, not brand takeover
            doc.setFont('helvetica', 'normal');
            doc.setFontSize(7);
            doc.setTextColor(170, 175, 185);
            doc.text('Document generated with CleanCrew', margin, Math.min(y + 4, pageHeight - 12));

            const pdfBuffer =

                doc.output(
                    'arraybuffer'
                );

            const fileName =
                `invoice_${invoice.id}_${Date.now()}.pdf`;

            // STORAGE
            const {
                data: buckets,
                error:
                    listBucketsError
            } =
                await supabase.storage
                    .listBuckets();

            if (listBucketsError) {
                console.error(
                    'Could not list Storage buckets:',
                    listBucketsError
                );
            }

            const invoicesBucketExists =
                (
                    buckets || []
                ).some(
                    b =>
                        b.name ===
                        'invoices'
                );

            if (
                !invoicesBucketExists
            ) {
                const {
                    error:
                        createBucketError
                } =
                    await supabase.storage
                        .createBucket(
                            'invoices',
                            {
                                public: true
                            }
                        );

                if (
                    createBucketError
                ) {
                    console.error(
                        'Failed to create invoices bucket:',
                        createBucketError
                    );
                }
            }

            const {
                error:
                    uploadError
            } =
                await supabase.storage
                    .from('invoices')
                    .upload(
                        fileName,
                        Buffer.from(
                            pdfBuffer
                        ),
                        {
                            contentType:
                                'application/pdf',

                            cacheControl:
                                '3600',

                            upsert:
                                true
                        }
                    );

            if (uploadError) {
                console.error(
                    'Invoice PDF upload failed:',
                    uploadError
                );

                return res.status(500).json({
                    error:
                        'PDF was created but could not be saved.',

                    details:
                        uploadError.message
                });
            }

            const {
                data: urlData
            } =
                supabase.storage
                    .from('invoices')
                    .getPublicUrl(
                        fileName
                    );

            const pdfUrl =
                urlData.publicUrl;

            const {
                error: updateError
            } = await supabase
                .from('invoices')
                .update({
                    pdf_url:
                        pdfUrl
                })
                .eq(
                    'id',
                    id
                )
                .eq(
                    'user_id',
                    userId
                );

            if (updateError) {
                console.error(
                    'Invoice PDF URL update failed:',
                    updateError
                );

                return res.status(500).json({
                    error:
                        'PDF was uploaded, but the invoice could not be updated with its PDF URL.',

                    details:
                        updateError.message
                });
            }

            res.json({
                success: true,

                pdf_url:
                    pdfUrl,

                message:
                    'PDF generated successfully'
            });

        } catch (error) {
            console.error(
                'PDF generation error:',
                error
            );

            res.status(500).json({
                error:
                    error.message ||
                    'Failed to generate PDF'
            });
        }
    }
);

// ─── GET INVOICE PDF ─────────────────────────────────────────

app.get(
    '/api/invoices/:id/pdf',
    authenticate,
    async (req, res) => {
        try {
            const {
                id
            } = req.params;

            const userId =
                req.user.id;

            const {
                data: invoice,
                error: invoiceError
            } = await supabase
                .from('invoices')
                .select('*')
                .eq(
                    'id',
                    id
                )
                .eq(
                    'user_id',
                    userId
                )
                .single();

            if (invoiceError) {
                throw invoiceError;
            }

            if (!invoice) {
                return res.status(404).json({
                    error:
                        'Invoice not found'
                });
            }

            if (invoice.pdf_url) {
                return res.json({
                    pdf_url:
                        invoice.pdf_url
                });
            }

            return res.status(404).json({
                error:
                    'PDF not generated yet'
            });

        } catch (error) {
            console.error(
                'Get invoice PDF error:',
                error
            );

            res.status(500).json({
                error: error.message
            });
        }
    }
);


// ─── START SERVER ────────────────────────────────────────────

const PORT =
    process.env.PORT ||
    5000;

app.listen(
    PORT,
    '0.0.0.0',
    () => {
        console.log(
            `✅ CleanCrew server running on port ${PORT}`
        );

        console.log(
            `   Local: http://localhost:${PORT}`
        );
    }
);