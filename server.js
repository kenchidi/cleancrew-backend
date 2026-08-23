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
app.use(express.json());
app.use(express.static(__dirname));

// ─── SUPABASE ────────────────────────────────────────────────

const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY
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
        name: 'Starter',
        features:
            '50 jobs, 50 clients, 5 staff, 20 invoices/month, 100 WhatsApp messages, 10 inventory items',
        limits: {
            jobs: 50,
            clients: 50,
            staff: 5,
            invoices: 20,
            whatsapp_messages: 100,
            inventory: 10
        },
        monthly: [
            'jobs',
            'invoices',
            'whatsapp_messages'
        ]
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
    starter: { name: 'Starter Pack', amount: 500000, jobs: 20 },      // ₦5,000
    business: { name: 'Business Pack', amount: 1000000, jobs: 45 },   // ₦10,000
    professional: { name: 'Pro Pack', amount: 2000000, jobs: 100 },   // ₦20,000
    enterprise: { name: 'Enterprise Pack', amount: 5000000, jobs: 275 } // ₦50,000
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
                `You've reached your ${PLANS[planName].name} plan limit of ${limit} ${type.replace(/_/g, ' ')}${period}. Upgrade or buy credits to continue.`
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
    const {
        data: sub,
        error: subError
    } = await supabase
        .from('subscriptions')
        .select('plan, status')
        .eq('user_id', userId)
        .maybeSingle();

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

    const usedLifetime = await getLifetimeJobsUsed(userId);
    const freeLeft = Math.max(0, LIFETIME_FREE_JOBS - usedLifetime);
    const creditBalance = await getCreditBalance(userId);

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
                    error: 'Invalid credit pack. Use starter, business, professional, or enterprise.'
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
            const used = await getLifetimeJobsUsed(userId);
            const freeLeft = Math.max(0, LIFETIME_FREE_JOBS - used);
            const credits = await getCreditBalance(userId);
            const decision = await canCreateJob(userId);

            const { data: sub } = await supabase
                .from('subscriptions')
                .select('plan, status')
                .eq('user_id', userId)
                .maybeSingle();

            res.json({
                lifetime_free_limit: LIFETIME_FREE_JOBS,
                jobs_used: used,
                free_jobs_remaining: freeLeft,
                credits,
                subscription: sub || { plan: 'free', status: 'active' },
                can_create: decision.allowed,
                source: decision.source,
                message: decision.message || null
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
                other_cost: req.body.other_cost != null ? Number(req.body.other_cost) : undefined
            };

            // Drop null optional keys that may not exist on older schemas
            Object.keys(job).forEach(function (k) {
                if (job[k] === null || job[k] === undefined) {
                    delete job[k];
                }
            });
            // Always keep user_id
            job.user_id = userId;

            const {
                data,
                error
            } = await supabase
                .from('jobs')
                .insert(job)
                .select()
                .single();

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
                    return res.status(500).json({
                        error:
                            'Database security blocked this job (RLS). ' +
                            'On Render, set SUPABASE_SERVICE_ROLE_KEY to the service_role key from Supabase (Settings → API), not the anon key. Then redeploy.',
                        code: 'RLS_JOBS_INSERT',
                        detail: msg
                    });
                }

                throw error;
            }

            res.json({
                ...data,

                _meta: {
                    source:
                        canCreate.source,

                    free_remaining:
                        await getFreeJobsRemaining(
                            userId
                        ),

                    credits_remaining:
                        await getCreditBalance(
                            userId
                        )
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

            const client = {
                ...req.body,
                user_id:
                    req.user.id
            };

            const {
                data,
                error
            } = await supabase
                .from('clients')
                .insert(client)
                .select()
                .single();

            if (error) {
                throw error;
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
                user_id: req.user.id
            };
            // Drop undefined so we don't send unknown columns
            Object.keys(item).forEach(function (k) {
                if (item[k] === undefined) delete item[k];
            });

            const {
                data,
                error
            } = await supabase
                .from('inventory')
                .insert(item)
                .select()
                .single();

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
            const {
                data,
                error
            } = await supabase
                .from('inventory')
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

            const invoice = {
                user_id:
                    req.user.id,

                number:
                    req.body.number ||
                    `CC-${Date.now()
                        .toString()
                        .slice(-6)}`,

                client:
                    req.body.client,

                service:
                    req.body.description ||
                    req.body.service ||
                    'Service',

                amount,

                amount_due:
                    amount,

                amount_paid:
                    req.body.amount_paid ??
                    0,

                date:
                    req.body.date,

                status:
                    req.body.status ||
                    'unpaid',

                job_id:
                    req.body.job_id ||
                    null,

                paid_at:
                    req.body.paid_at ||
                    null
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
            const {
                data,
                error
            } = await supabase
                .from('invoices')
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
                'Error updating invoice:',
                error
            );

            res.status(500).json({
                error: error.message
            });
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
            const {
                data,
                error
            } = await supabase
                .from('staff')
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

            const staff = {
                ...req.body,
                user_id:
                    req.user.id
            };

            const {
                data,
                error
            } = await supabase
                .from('staff')
                .insert(staff)
                .select()
                .single();

            if (error) {
                throw error;
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

// ─── INVOICE SETTINGS ───────────────────────────────────────

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
            const {
                data,
                error
            } = await supabase
                .from(
                    'invoice_settings'
                )
                .upsert({
                    user_id:
                        req.user.id,

                    ...req.body,

                    updated_at:
                        new Date()
                            .toISOString()
                })
                .select()
                .single();

            if (error) {
                throw error;
            }

            res.json(data);

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

            const {
                jsPDF
            } = require('jspdf');

            const doc =
                new jsPDF();

            const pageWidth =
                doc.internal.pageSize.getWidth();

            const margin = 20;

            let y = 20;

            const businessName =
                settings?.business_name ||
                'CleanCrew Laundry';

            const address =
                settings?.business_address ||
                '';

            const phone =
                settings?.phone ||
                '';

            const email =
                settings?.email ||
                '';

            // HEADER
            doc.setFontSize(24);
            doc.setFont(
                'helvetica',
                'bold'
            );

            doc.setTextColor(
                26,
                109,
                219
            );

            doc.text(
                businessName,
                margin,
                y
            );

            y += 10;

            doc.setFontSize(10);

            doc.setFont(
                'helvetica',
                'normal'
            );

            doc.setTextColor(
                100,
                100,
                100
            );

            if (address) {
                doc.text(
                    address,
                    margin,
                    y
                );

                y += 6;
            }

            if (phone) {
                doc.text(
                    `Phone: ${phone}`,
                    margin,
                    y
                );

                y += 6;
            }

            if (email) {
                doc.text(
                    `Email: ${email}`,
                    margin,
                    y
                );

                y += 6;
            }

            y += 4;

            doc.setDrawColor(
                26,
                109,
                219
            );

            doc.setLineWidth(0.5);

            doc.line(
                margin,
                y,
                pageWidth -
                    margin,
                y
            );

            y += 10;

            // INVOICE TITLE
            doc.setFontSize(20);

            doc.setFont(
                'helvetica',
                'bold'
            );

            doc.setTextColor(
                26,
                109,
                219
            );

            doc.text(
                'INVOICE',
                margin,
                y
            );

            const invoiceNumber =
                invoice.number ||
                invoice.invoice_numb ||
                `CC-${String(
                    invoice.id
                ).slice(0, 8)}`;

            const invoiceDate =
                new Date(
                    invoice.date ||
                    invoice.created_at
                ).toLocaleDateString(
                    'en-NG',
                    {
                        day: '2-digit',
                        month: 'short',
                        year: 'numeric'
                    }
                );

            doc.setFontSize(11);

            doc.setFont(
                'helvetica',
                'normal'
            );

            doc.setTextColor(
                51,
                51,
                51
            );

            doc.text(
                `#${invoiceNumber}`,
                pageWidth -
                    margin -
                    10,
                y,
                {
                    align:
                        'right'
                }
            );

            y += 8;

            doc.text(
                `Date: ${invoiceDate}`,
                pageWidth -
                    margin -
                    10,
                y,
                {
                    align:
                        'right'
                }
            );

            y += 8;

            const statusText =
                invoice.status ||
                'Unpaid';

            const statusColor =
                statusText === 'paid'
                    ? '#16A34A'
                    : statusText ===
                      'pending'
                    ? '#F0A421'
                    : '#DC2626';

            doc.setTextColor(
                statusColor
            );

            doc.text(
                `Status: ${statusText
                    .charAt(0)
                    .toUpperCase() +
                    statusText.slice(
                        1
                    )}`,
                pageWidth -
                    margin -
                    10,
                y,
                {
                    align:
                        'right'
                }
            );

            y += 14;

            // BILL TO
            doc.setFontSize(11);

            doc.setFont(
                'helvetica',
                'bold'
            );

            doc.setTextColor(
                51,
                51,
                51
            );

            doc.text(
                'BILL TO:',
                margin,
                y
            );

            y += 8;

            doc.setFont(
                'helvetica',
                'normal'
            );

            doc.text(
                invoice.client ||
                    'Customer',
                margin,
                y
            );

            y += 6;

            if (invoice.phone) {
                doc.text(
                    `Phone: ${invoice.phone}`,
                    margin,
                    y
                );

                y += 6;
            }

            y += 8;

            // ITEMS TABLE
            const col1 = margin;
            const col2 = 110;
            const col3 = 150;
            const col4 = 175;

            const rowHeight = 8;

            doc.setFillColor(
                240,
                244,
                248
            );

            doc.rect(
                margin,
                y - 4,
                pageWidth -
                    margin * 2,
                rowHeight,
                'F'
            );

            doc.setFont(
                'helvetica',
                'bold'
            );

            doc.setFontSize(10);

            doc.setTextColor(
                51,
                51,
                51
            );

            doc.text(
                'Description',
                col1,
                y
            );

            doc.text(
                'Qty',
                col2,
                y
            );

            doc.text(
                'Price',
                col3,
                y
            );

            doc.text(
                'Total',
                col4,
                y
            );

            y +=
                rowHeight + 4;

            const amount =
                Number(
                    invoice.amount ||
                    invoice.amount_due ||
                    0
                );

            let items = [];

            if (invoice.items) {
                try {
                    items =
                        typeof invoice.items ===
                        'string'
                            ? JSON.parse(
                                  invoice.items
                              )
                            : invoice.items;
                } catch (e) {
                    items = [];
                }
            }

            if (
                !items ||
                items.length === 0
            ) {
                items = [
                    {
                        name:
                            invoice.service ||
                            'Service',

                        qty: 1,

                        price:
                            amount
                    }
                ];
            }

            doc.setFont(
                'helvetica',
                'normal'
            );

            doc.setFontSize(10);

            doc.setTextColor(
                51,
                51,
                51
            );

            items.forEach(
                (item) => {
                    const itemName =
                        item.name ||
                        item.service ||
                        'Service';

                    const qty =
                        Number(
                            item.qty || 1
                        );

                    const price =
                        Number(
                            item.price ??
                                (
                                    amount /
                                    qty
                                )
                        );

                    const total =
                        qty * price;

                    doc.text(
                        String(
                            itemName
                        ).substring(
                            0,
                            30
                        ),
                        col1,
                        y
                    );

                    doc.text(
                        String(qty),
                        col2,
                        y
                    );

                    doc.text(
                        `NGN ${price.toLocaleString()}`,
                        col3,
                        y
                    );

                    doc.text(
                        `NGN ${total.toLocaleString()}`,
                        col4,
                        y
                    );

                    y += rowHeight;

                    if (y > 260) {
                        doc.addPage();
                        y = 20;
                    }
                }
            );

            y += 4;

            doc.setDrawColor(
                200,
                200,
                200
            );

            doc.line(
                margin,
                y,
                pageWidth -
                    margin,
                y
            );

            y += 6;

            doc.setFont(
                'helvetica',
                'bold'
            );

            doc.setFontSize(12);

            doc.setTextColor(
                26,
                109,
                219
            );

            doc.text(
                'TOTAL',
                col3,
                y
            );

            doc.text(
                `NGN ${amount.toLocaleString()}`,
                col4,
                y
            );

            y += 16;

            // PAYMENT INSTRUCTIONS
            doc.setFont(
                'helvetica',
                'bold'
            );

            doc.setFontSize(12);

            doc.setTextColor(
                26,
                109,
                219
            );

            doc.text(
                'Payment Instructions',
                margin,
                y
            );

            y += 8;

            doc.setFont(
                'helvetica',
                'normal'
            );

            doc.setFontSize(10);

            doc.setTextColor(
                51,
                51,
                51
            );

            const bankName =
                settings?.bank_name ||
                '';

            const accountName =
                settings?.account_name ||
                '';

            const accountNumber =
                settings?.account_number ||
                '';

            const paymentWhatsapp =
                settings?.payment_whatsapp ||
                '';

            if (bankName) {
                doc.text(
                    `Bank: ${bankName}`,
                    margin,
                    y
                );

                y += 6;
            }

            if (accountName) {
                doc.text(
                    `Account Name: ${accountName}`,
                    margin,
                    y
                );

                y += 6;
            }

            if (accountNumber) {
                doc.text(
                    `Account Number: ${accountNumber}`,
                    margin,
                    y
                );

                y += 6;
            }

            doc.text(
                `Reference: ${invoiceNumber}`,
                margin,
                y
            );

            y += 6;

            if (paymentWhatsapp) {
                doc.text(
                    `After payment, send proof to: ${paymentWhatsapp}`,
                    margin,
                    y
                );

                y += 10;
            }

            // FOOTER
            const footerY = 280;

            doc.setFontSize(9);

            doc.setTextColor(
                150,
                150,
                150
            );

            doc.setFont(
                'helvetica',
                'italic'
            );

            doc.text(
                `Thank you for choosing ${businessName}!`,
                margin,
                footerY
            );

            doc.setFont(
                'helvetica',
                'normal'
            );

            doc.setFontSize(8);

            doc.setTextColor(
                180,
                180,
                180
            );

            doc.text(
                'Powered by CleanCrew — cleancrewapp.com',
                margin,
                footerY + 6
            );

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