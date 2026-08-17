// ─── server.js ──────────────────────────────────────────────
const express = require('express');
const cors = require('cors');
const dotenv = require('dotenv');
const crypto = require('crypto');
const { createClient } = require('@supabase/supabase-js');

dotenv.config();

const app = express();

// ─── ✅ SIMPLIFIED CORS ──────────────────────────────────────
app.use(cors());
app.use(express.json());
app.use(express.static(__dirname));

// ─── ──────────────────────────────────────────────────────
// ─── THE REST OF YOUR CODE REMAINS EXACTLY THE SAME ────
// ─── ──────────────────────────────────────────────────────

// ─── Supabase Client ──────────────────────────────────────
const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY
);
console.log(
    'Supabase service role key loaded:',
    !!process.env.SUPABASE_SERVICE_ROLE_KEY
);

// ─── Paystack config ──────────────────────────────────────
const PAYSTACK_SECRET_KEY = process.env.PAYSTACK_SECRET_KEY;
const PAYSTACK_PUBLIC_KEY = process.env.PAYSTACK_PUBLIC_KEY;

// ─── Paystack plans ──────────────────────────────────────
const PLANS = {
    free: {
        amount: 0,
        name: 'Free',
        features: '25 jobs/mo, 25 clients, 3 staff, 15 invoices/mo, 30 WhatsApp/mo, 10 inventory',
        limits: {
            jobs: 25,
            clients: 25,
            staff: 3,
            invoices: 15,
            whatsapp_messages: 30,
            inventory: 10
        },
        monthly: ['jobs', 'invoices', 'whatsapp_messages']
    },
    starter: {
        amount: 1250000,
        name: 'Starter',
        features: '50 jobs, 50 clients, 5 staff, 20 invoices/month, 100 WhatsApp messages, 10 inventory items',
        limits: {
            jobs: 50,
            clients: 50,
            staff: 5,
            invoices: 20,
            whatsapp_messages: 100,
            inventory: 10
        },
        monthly: ['jobs', 'invoices', 'whatsapp_messages']
    },
    professional: {
        amount: 1750000,
        name: 'Professional',
        features: 'Unlimited jobs, clients, staff, invoices, WhatsApp & inventory',
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
        features: 'Everything in Professional + team access & advanced reporting',
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

const FRONTEND_URL = process.env.FRONTEND_URL || 'https://cleancrewapp.com';

// ─── AUTHENTICATION MIDDLEWARE ──────────────────────────
const authenticate = async (req, res, next) => {
    const token = req.headers.authorization?.split(' ')[1];
    if (!token) {
        return res.status(401).json({ error: 'Unauthorized' });
    }

    const { data: { user }, error } = await supabase.auth.getUser(token);
    if (error || !user) {
        return res.status(401).json({ error: 'Invalid token' });
    }

    if (!user.email_confirmed_at) {
        return res.status(403).json({
            error: 'Please confirm your email address before accessing the dashboard.',
            requires_confirmation: true
        });
    }

    req.user = user;
    next();
};

// ─── HELPERS ──────────────────────────────────────────────
async function checkPlanLimit(userId, type) {
    const { data: sub, error: subError } = await supabase
        .from('subscriptions')
        .select('plan, status')
        .eq('user_id', userId)
        .single();

    if (subError && subError.code !== 'PGRST116') {
        throw new Error('Error checking subscription');
    }

    let planName = sub?.plan || 'free';
    if (!PLANS[planName]) planName = 'free';

    const limit = PLANS[planName]?.limits?.[type];
    if (limit === undefined) {
        return { allowed: true, limit: Infinity, plan: planName, count: 0 };
    }

    if (limit === Infinity) {
        return { allowed: true, limit: Infinity, plan: planName, count: 0 };
    }

    const isMonthly = (PLANS[planName].monthly || []).includes(type);
    let query = supabase
        .from(type === 'whatsapp_messages' ? 'usage_events' : type)
        .select('*', { count: 'exact', head: true })
        .eq('user_id', userId);

    if (type === 'whatsapp_messages') {
        query = supabase
            .from('usage_events')
            .select('*', { count: 'exact', head: true })
            .eq('user_id', userId)
            .eq('action_type', 'whatsapp_sent');
    }

    if (isMonthly) {
        const start = new Date();
        start.setDate(1);
        start.setHours(0, 0, 0, 0);
        query = query.gte('created_at', start.toISOString());
    }

    const { count, error: countError } = await query;

    if (countError) {
        if (type === 'whatsapp_messages') {
            console.warn('WhatsApp usage count skipped:', countError.message);
            return { allowed: true, limit, count: 0, plan: planName };
        }
        throw new Error('Error counting items');
    }

    const currentCount = count || 0;

    if (currentCount >= limit) {
        const period = isMonthly ? ' this month' : '';
        return {
            allowed: false,
            limit,
            count: currentCount,
            plan: planName,
            code: 'LIMIT_REACHED',
            message: `You've reached your ${PLANS[planName].name} plan limit of ${limit} ${type.replace(/_/g, ' ')}${period}. Upgrade or buy credits to continue.`
        };
    }

    return { allowed: true, limit, count: currentCount, plan: planName };
}

async function getUserPlan(userId) {
    const { data: sub, error } = await supabase
        .from('subscriptions')
        .select('plan')
        .eq('user_id', userId)
        .single();

    if (error && error.code !== 'PGRST116') {
        throw new Error('Error fetching subscription');
    }

    return sub?.plan || 'free';
}

// ─── ──────────────────────────────────────────────────────
// ─── API ROUTES ──────────────────────────────────────────
// ─── ──────────────────────────────────────────────────────

// ─── TEST ENDPOINT ──────────────────────────────────────
app.get('/api/test', (req, res) => {
    res.json({
        message: 'CORS is working!',
        time: new Date().toISOString()
    });
});

// ─── AUTH ROUTES ──────────────────────────────────────────
app.post('/api/auth/signup', async (req, res) => {
    try {
        const { name, email, password } = req.body;

        if (!name || !email || !password) {
            return res.status(400).json({ error: 'All fields are required' });
        }

        const { data: authData, error: authError } = await supabase.auth.signUp({
            email,
            password,
            options: {
                data: { name },
                emailRedirectTo: `${FRONTEND_URL}/login.html?confirmed=1`
            }
        });

        if (authError) throw authError;

        await supabase
            .from('subscriptions')
            .insert({
                user_id: authData.user.id,
                status: 'active',
                trial_end: null,
                plan: 'free'
            });

        res.json({
            success: true,
            user: authData.user,
            requires_confirmation: true,
            message: 'Please check your email to confirm your account.'
        });
    } catch (error) {
        console.error('Signup error:', error);
        res.status(400).json({ error: error.message });
    }
});

app.post('/api/auth/login', async (req, res) => {
    try {
        const { email, password } = req.body;

        if (!email || !password) {
            return res.status(400).json({ error: 'Email and password are required' });
        }

        const { data: authData, error: authError } = await supabase.auth.signInWithPassword({
            email,
            password
        });

        if (authError) throw authError;

        if (!authData.user.email_confirmed_at) {
            return res.status(403).json({
                error: 'Please confirm your email address before logging in. Check your inbox for the confirmation link.',
                requires_confirmation: true,
                email: email
            });
        }

        const { data: sub } = await supabase
            .from('subscriptions')
            .select('*')
            .eq('user_id', authData.user.id)
            .single();

        res.json({
            token: authData.session.access_token,
            refresh_token: authData.session.refresh_token,
            expires_in: authData.session.expires_in,
            user: {
                id: authData.user.id,
                email: authData.user.email,
                name: authData.user.user_metadata.name,
                subscription: sub || { status: 'active', plan: 'free' }
            }
        });
    } catch (error) {
        console.error('Login error:', error);
        res.status(401).json({ error: error.message });
    }
});

// ─── ✅ TOKEN REFRESH ROUTE ──────────────────────────────
// Exchanges a Supabase refresh_token for a new access token, so the
// dashboard can silently renew a session instead of failing with
// "Invalid token" once the access token's 1-hour lifetime is up.
app.post('/api/auth/refresh', async (req, res) => {
    try {
        const { refresh_token } = req.body;
        if (!refresh_token) {
            return res.status(400).json({ error: 'refresh_token is required' });
        }

        const { data, error } = await supabase.auth.refreshSession({ refresh_token });
        if (error || !data.session) {
            return res.status(401).json({ error: 'Invalid or expired refresh token' });
        }

        res.json({
            token: data.session.access_token,
            refresh_token: data.session.refresh_token,
            expires_in: data.session.expires_in
        });
    } catch (error) {
        console.error('Token refresh error:', error);
        res.status(401).json({ error: error.message });
    }
});

// ─── ✅ PASSWORD RESET ROUTE ─────────────────────────────
app.post('/api/auth/reset-password', async (req, res) => {
    console.log('✅ Password reset endpoint hit!');
    try {
        const { email } = req.body;
        console.log('📧 Email received:', email);

        if (!email) {
            console.log('❌ No email provided');
            return res.status(400).json({ error: 'Email is required' });
        }

        const { error } = await supabase.auth.resetPasswordForEmail(email, {
            redirectTo: `${FRONTEND_URL}/reset-password.html`
        });

        if (error) {
            console.error('❌ Supabase error:', error);
            return res.status(400).json({ error: error.message });
        }

        console.log('✅ Reset email sent to:', email);
        res.json({ success: true, message: 'Password reset email sent' });
    } catch (error) {
        console.error('❌ Server error:', error);
        res.status(500).json({ error: error.message });
    }
});

// ─── Resend Confirmation Email ──────────────────────────
app.post('/api/auth/resend-confirmation', async (req, res) => {
    try {
        const { email } = req.body;

        if (!email) {
            return res.status(400).json({ error: 'Email is required' });
        }

        const { error: resendError } = await supabase.auth.resend({
            type: 'signup',
            email: email,
            options: {
                emailRedirectTo: `${FRONTEND_URL}/login.html?confirmed=1`
            }
        });

        if (resendError) throw resendError;

        res.json({ success: true, message: 'Confirmation email resent successfully. Please check your inbox.' });
    } catch (error) {
        console.error('Resend confirmation error:', error);
        res.status(400).json({ error: error.message });
    }
});

// ─── Get User ─────────────────────────────────────────────
// ─── ✅ HEALTH CHECK ─────────────────────────────────────
// Lightweight, unauthenticated endpoint. Point an external uptime
// monitor (UptimeRobot, cron-job.org, etc.) at this every 5-10 minutes
// to prevent Render's free tier from spinning the service down and
// causing a slow "cold start" on the next real request (e.g. login).
app.get('/api/health', (req, res) => {
    res.json({ status: 'ok', time: new Date().toISOString() });
});

app.get('/api/user', authenticate, async (req, res) => {
    try {
        const plan = await getUserPlan(req.user.id);
        res.json({
            id: req.user.id,
            email: req.user.email,
            name: req.user.user_metadata?.name || '',
            email_confirmed: !!req.user.email_confirmed_at,
            plan: plan
        });
    } catch (error) {
        console.error('Get user error:', error);
        res.status(500).json({ error: error.message });
    }
});

// ─── Subscription Status ──────────────────────────────────
app.get('/api/subscription/status', authenticate, async (req, res) => {
    try {
        const { data: sub } = await supabase
            .from('subscriptions')
            .select('*')
            .eq('user_id', req.user.id)
            .single();

        res.json({
            status: sub?.status || 'active',
            trial_end: sub?.trial_end || null,
            plan: sub?.plan || 'free'
        });
    } catch (error) {
        console.error('Subscription status error:', error);
        res.status(500).json({ error: error.message });
    }
});

// ─── Paystack Routes ──────────────────────────────────────
app.post('/api/paystack/initialize', authenticate, async (req, res) => {
    try {
        const { plan = 'professional' } = req.body;
        const { email } = req.user;
        const userId = req.user.id;

        if (!PLANS[plan]) {
            return res.status(400).json({ error: 'Invalid plan selected' });
        }

        const planData = PLANS[plan];
        const reference = `cleancrew_${userId}_${Date.now()}`;

        const response = await fetch('https://api.paystack.co/transaction/initialize', {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${PAYSTACK_SECRET_KEY}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                email: email,
                amount: planData.amount,
                currency: 'NGN',
                reference: reference,
                callback_url: `${FRONTEND_URL}/dashboard.html`,
                metadata: {
                    user_id: userId,
                    plan: plan,
                    plan_name: planData.name,
                    amount: planData.amount / 100
                }
            })
        });

        const data = await response.json();

        if (data.status) {
            await supabase
                .from('transactions')
                .insert({
                    user_id: userId,
                    reference: reference,
                    amount: planData.amount / 100,
                    plan: plan,
                    status: 'pending'
                });

            res.json({
                authorization_url: data.data.authorization_url,
                reference: reference,
                plan: plan,
                amount: planData.amount / 100
            });
        } else {
            res.status(400).json({ error: data.message });
        }
    } catch (error) {
        console.error('Paystack error:', error);
        res.status(500).json({ error: error.message });
    }
});

app.post('/api/paystack/verify/:reference', authenticate, async (req, res) => {
    try {
        const { reference } = req.params;

        const response = await fetch(`https://api.paystack.co/transaction/verify/${reference}`, {
            headers: {
                'Authorization': `Bearer ${PAYSTACK_SECRET_KEY}`
            }
        });

        const data = await response.json();

        if (data.status && data.data.status === 'success') {
            const userId = req.user.id;
            const plan = data.data.metadata?.plan || 'professional';

            await supabase
                .from('subscriptions')
                .upsert({
                    user_id: userId,
                    status: 'active',
                    plan: plan,
                    trial_end: new Date(Date.now() + 365 * 86400000).toISOString()
                });

            await supabase
                .from('transactions')
                .update({ status: 'completed' })
                .eq('reference', reference);

            res.json({ success: true, message: 'Subscription activated!' });
        } else {
            res.status(400).json({ error: 'Payment verification failed' });
        }
    } catch (error) {
        console.error('Verify error:', error);
        res.status(500).json({ error: error.message });
    }
});

app.post('/api/paystack/webhook', async (req, res) => {
    try {
        const hash = crypto
            .createHmac('sha512', PAYSTACK_SECRET_KEY)
            .update(JSON.stringify(req.body))
            .digest('hex');

        if (hash !== req.headers['x-paystack-signature']) {
            return res.status(401).send('Unauthorized');
        }

        const event = req.body;

        if (event.event === 'charge.success') {
            const { reference } = event.data;
            const { user_id, plan } = event.data.metadata;

            await supabase
                .from('subscriptions')
                .upsert({
                    user_id: user_id,
                    status: 'active',
                    plan: plan || 'professional',
                    trial_end: new Date(Date.now() + 365 * 86400000).toISOString()
                });

            await supabase
                .from('transactions')
                .update({ status: 'completed' })
                .eq('reference', reference);

            console.log(`✅ Subscription activated for user ${user_id} (${plan})`);
        }

        res.sendStatus(200);
    } catch (error) {
        console.error('Webhook error:', error);
        res.sendStatus(500);
    }
});

// ─── Usage / plan limits (for dashboard UI) ────────────────
app.get('/api/usage/limits', authenticate, async (req, res) => {
    try {
        const plan = await getUserPlan(req.user.id);
        const planDef = PLANS[plan] || PLANS.free;
        const types = ['jobs', 'clients', 'staff', 'invoices', 'inventory'];
        const usage = {};
        for (const type of types) {
            try {
                const result = await checkPlanLimit(req.user.id, type);
                usage[type] = {
                    used: result.count,
                    limit: result.limit === Infinity ? null : result.limit,
                    allowed: result.allowed
                };
            } catch (e) {
                usage[type] = { used: 0, limit: planDef.limits[type] ?? null, allowed: true };
            }
        }
        res.json({
            plan,
            plan_name: planDef.name,
            features: planDef.features,
            usage
        });
    } catch (error) {
        console.error('Usage limits error:', error);
        res.status(500).json({ error: error.message });
    }
});

// ─── ──────────────────────────────────────────────────────
// ─── JOBS ROUTES ──────────────────────────────────────────
// ─── ──────────────────────────────────────────────────────

app.get('/api/jobs', authenticate, async (req, res) => {
    try {
        const { data, error } = await supabase
            .from('jobs')
            .select('*')
            .eq('user_id', req.user.id)
            .order('created_at', { ascending: false });

        if (error) throw error;
        res.json(data);
    } catch (error) {
        console.error('Error fetching jobs:', error);
        res.status(500).json({ error: error.message });
    }
});

app.post('/api/jobs', authenticate, async (req, res) => {
    try {
        const limitCheck = await checkPlanLimit(req.user.id, 'jobs');

        if (!limitCheck.allowed) {
            return res.status(403).json({
                error: limitCheck.message,
                limit: limitCheck.limit,
                count: limitCheck.count,
                plan: limitCheck.plan
            });
        }

        const mode = req.body.mode || req.body.service_type || 'cleaning';
        const job = {
            ...req.body,
            user_id: req.user.id,
            mode,
            service_type: mode,
            items: req.body.items || req.body.laundry_items || [],
            rooms: req.body.rooms ?? null,
            property_size: req.body.property_size || null
        };

        const { data, error } = await supabase
            .from('jobs')
            .insert(job)
            .select()
            .single();

        if (error) throw error;
        res.json(data);
    } catch (error) {
        console.error('Error creating job:', error);
        res.status(500).json({ error: error.message });
    }
});

app.put('/api/jobs/:id', authenticate, async (req, res) => {
    try {
        const { id } = req.params;
        const { data, error } = await supabase
            .from('jobs')
            .update(req.body)
            .eq('id', id)
            .eq('user_id', req.user.id)
            .select()
            .single();

        if (error) throw error;
        res.json(data);
    } catch (error) {
        console.error('Error updating job:', error);
        res.status(500).json({ error: error.message });
    }
});

app.delete('/api/jobs/:id', authenticate, async (req, res) => {
    try {
        const { id } = req.params;
        const { error } = await supabase
            .from('jobs')
            .delete()
            .eq('id', id)
            .eq('user_id', req.user.id);

        if (error) throw error;
        res.json({ success: true });
    } catch (error) {
        console.error('Error deleting job:', error);
        res.status(500).json({ error: error.message });
    }
});

// ─── ──────────────────────────────────────────────────────
// ─── CLIENTS ROUTES ──────────────────────────────────────
// ─── ──────────────────────────────────────────────────────

app.get('/api/clients', authenticate, async (req, res) => {
    try {
        const { data, error } = await supabase
            .from('clients')
            .select('*')
            .eq('user_id', req.user.id)
            .order('created_at', { ascending: false });

        if (error) throw error;
        res.json(data);
    } catch (error) {
        console.error('Error fetching clients:', error);
        res.status(500).json({ error: error.message });
    }
});

app.post('/api/clients', authenticate, async (req, res) => {
    try {
        const limitCheck = await checkPlanLimit(req.user.id, 'clients');

        if (!limitCheck.allowed) {
            return res.status(403).json({
                error: limitCheck.message,
                limit: limitCheck.limit,
                count: limitCheck.count,
                plan: limitCheck.plan
            });
        }

        const client = { ...req.body, user_id: req.user.id };
        const { data, error } = await supabase
            .from('clients')
            .insert(client)
            .select()
            .single();

        if (error) throw error;
        res.json(data);
    } catch (error) {
        console.error('Error creating client:', error);
        res.status(500).json({ error: error.message });
    }
});

app.delete('/api/clients/:id', authenticate, async (req, res) => {
    try {
        const { id } = req.params;
        const { error } = await supabase
            .from('clients')
            .delete()
            .eq('id', id)
            .eq('user_id', req.user.id);

        if (error) throw error;
        res.json({ success: true });
    } catch (error) {
        console.error('Error deleting client:', error);
        res.status(500).json({ error: error.message });
    }
});

// ─── ──────────────────────────────────────────────────────
// ─── INVENTORY ROUTES ──────────────────────────────────────
// ─── ──────────────────────────────────────────────────────

app.get('/api/inventory', authenticate, async (req, res) => {
    try {
        const { data, error } = await supabase
            .from('inventory')
            .select('*')
            .eq('user_id', req.user.id)
            .order('created_at', { ascending: false });

        if (error) throw error;
        res.json(data);
    } catch (error) {
        console.error('Error fetching inventory:', error);
        res.status(500).json({ error: error.message });
    }
});

app.post('/api/inventory', authenticate, async (req, res) => {
    try {
        const limitCheck = await checkPlanLimit(req.user.id, 'inventory');

        if (!limitCheck.allowed) {
            return res.status(403).json({
                error: limitCheck.message,
                limit: limitCheck.limit,
                count: limitCheck.count,
                plan: limitCheck.plan
            });
        }

        const item = {
            ...req.body,
            user_id: req.user.id,
            category: req.body.category || 'cleaning'
        };
        const { data, error } = await supabase
            .from('inventory')
            .insert(item)
            .select()
            .single();

        if (error) throw error;
        res.json(data);
    } catch (error) {
        console.error('Error creating inventory item:', error);
        res.status(500).json({ error: error.message });
    }
});

app.put('/api/inventory/:id', authenticate, async (req, res) => {
    try {
        const { id } = req.params;
        const { data, error } = await supabase
            .from('inventory')
            .update(req.body)
            .eq('id', id)
            .eq('user_id', req.user.id)
            .select()
            .single();

        if (error) throw error;
        res.json(data);
    } catch (error) {
        console.error('Error updating inventory item:', error);
        res.status(500).json({ error: error.message });
    }
});

app.delete('/api/inventory/:id', authenticate, async (req, res) => {
    try {
        const { id } = req.params;
        const { error } = await supabase
            .from('inventory')
            .delete()
            .eq('id', id)
            .eq('user_id', req.user.id);

        if (error) throw error;
        res.json({ success: true });
    } catch (error) {
        console.error('Error deleting inventory item:', error);
        res.status(500).json({ error: error.message });
    }
});

// ─── ──────────────────────────────────────────────────────
// ─── INVOICE ROUTES ──────────────────────────────────────
// ─── ──────────────────────────────────────────────────────

app.get('/api/invoices', authenticate, async (req, res) => {
    try {
        const { data, error } = await supabase
            .from('invoices')
            .select('*')
            .eq('user_id', req.user.id)
            .order('created_at', { ascending: false });

        if (error) throw error;
        res.json(data);
    } catch (error) {
        console.error('Error fetching invoices:', error);
        res.status(500).json({ error: error.message });
    }
});

app.post('/api/invoices', authenticate, async (req, res) => {
    try {
        const limitCheck = await checkPlanLimit(req.user.id, 'invoices');

        if (!limitCheck.allowed) {
            return res.status(403).json({
                error: limitCheck.message,
                limit: limitCheck.limit,
                count: limitCheck.count,
                plan: limitCheck.plan
            });
        }

        const amount = req.body.amount_due ?? req.body.amount;
        const invoice = {
            user_id: req.user.id,
            number: req.body.number || `CC-${Date.now().toString().slice(-6)}`,
            client: req.body.client,
            service: req.body.description || req.body.service || 'Service',
            amount: amount,
            amount_due: amount,
            amount_paid: req.body.amount_paid ?? 0,
            date: req.body.date,
            status: req.body.status || 'unpaid',
            job_id: req.body.job_id || null,
            paid_at: req.body.paid_at || null
        };

        console.log('Creating invoice with data:', invoice);

        const { data, error } = await supabase
            .from('invoices')
            .insert(invoice)
            .select()
            .single();

        if (error) {
            console.error('Supabase error:', error);
            return res.status(400).json({ error: error.message, details: error });
        }

        res.json(data);
    } catch (error) {
        console.error('Error creating invoice:', error);
        res.status(500).json({ error: error.message });
    }
});

app.put('/api/invoices/:id', authenticate, async (req, res) => {
    try {
        const { id } = req.params;
        const { data, error } = await supabase
            .from('invoices')
            .update(req.body)
            .eq('id', id)
            .eq('user_id', req.user.id)
            .select()
            .single();

        if (error) throw error;
        res.json(data);
    } catch (error) {
        console.error('Error updating invoice:', error);
        res.status(500).json({ error: error.message });
    }
});

app.delete('/api/invoices/:id', authenticate, async (req, res) => {
    try {
        const { id } = req.params;
        const { error } = await supabase
            .from('invoices')
            .delete()
            .eq('id', id)
            .eq('user_id', req.user.id);

        if (error) throw error;
        res.json({ success: true });
    } catch (error) {
        console.error('Error deleting invoice:', error);
        res.status(500).json({ error: error.message });
    }
});

// ─── ──────────────────────────────────────────────────────
// ─── STAFF ROUTES ──────────────────────────────────────────
// ─── ──────────────────────────────────────────────────────

app.get('/api/staff', authenticate, async (req, res) => {
    try {
        const { data, error } = await supabase
            .from('staff')
            .select('*')
            .eq('user_id', req.user.id)
            .order('created_at', { ascending: false });

        if (error) throw error;
        res.json(data);
    } catch (error) {
        console.error('Error fetching staff:', error);
        res.status(500).json({ error: error.message });
    }
});

app.post('/api/staff', authenticate, async (req, res) => {
    try {
        const limitCheck = await checkPlanLimit(req.user.id, 'staff');

        if (!limitCheck.allowed) {
            return res.status(403).json({
                error: limitCheck.message,
                limit: limitCheck.limit,
                count: limitCheck.count,
                plan: limitCheck.plan
            });
        }

        const staff = { ...req.body, user_id: req.user.id };
        const { data, error } = await supabase
            .from('staff')
            .insert(staff)
            .select()
            .single();

        if (error) throw error;
        res.json(data);
    } catch (error) {
        console.error('Error creating staff:', error);
        res.status(500).json({ error: error.message });
    }
});

app.put('/api/staff/:id', authenticate, async (req, res) => {
    try {
        const { id } = req.params;
        const { data, error } = await supabase
            .from('staff')
            .update(req.body)
            .eq('id', id)
            .eq('user_id', req.user.id)
            .select()
            .single();

        if (error) throw error;
        res.json(data);
    } catch (error) {
        console.error('Error updating staff:', error);
        res.status(500).json({ error: error.message });
    }
});

app.delete('/api/staff/:id', authenticate, async (req, res) => {
    try {
        const { id } = req.params;
        const { error } = await supabase
            .from('staff')
            .delete()
            .eq('id', id)
            .eq('user_id', req.user.id);

        if (error) throw error;
        res.json({ success: true });
    } catch (error) {
        console.error('Error deleting staff:', error);
        res.status(500).json({ error: error.message });
    }
});


// ─── ──────────────────────────────────────────────────────
// ─── LAUNDRY PRICING ──────────────────────────────────────
// ─── ──────────────────────────────────────────────────────

app.get('/api/laundry-pricing', authenticate, async (req, res) => {
    try {
        const { data, error } = await supabase
            .from('laundry_pricing')
            .select('*')
            .eq('user_id', req.user.id)
            .order('item_name', { ascending: true });
        if (error) throw error;
        res.json(data || []);
    } catch (error) {
        console.error('laundry-pricing list:', error);
        res.status(500).json({ error: error.message });
    }
});

app.post('/api/laundry-pricing', authenticate, async (req, res) => {
    try {
        const item_name = (req.body.item_name || '').trim();
        const price = parseFloat(req.body.price);
        if (!item_name || isNaN(price) || price < 0) {
            return res.status(400).json({ error: 'item_name and valid price required' });
        }
        const { data, error } = await supabase
            .from('laundry_pricing')
            .upsert({
                user_id: req.user.id,
                item_name,
                price,
                updated_at: new Date().toISOString()
            }, { onConflict: 'user_id,item_name' })
            .select()
            .single();
        if (error) throw error;
        res.json(data);
    } catch (error) {
        console.error('laundry-pricing save:', error);
        res.status(500).json({ error: error.message });
    }
});

app.delete('/api/laundry-pricing/:id', authenticate, async (req, res) => {
    try {
        const { error } = await supabase
            .from('laundry_pricing')
            .delete()
            .eq('id', req.params.id)
            .eq('user_id', req.user.id);
        if (error) throw error;
        res.json({ success: true });
    } catch (error) {
        console.error('laundry-pricing delete:', error);
        res.status(500).json({ error: error.message });
    }
});

// ─── ──────────────────────────────────────────────────────
// ─── OWNER PIN (lock revenue) ─────────────────────────────
// ─── ──────────────────────────────────────────────────────

function hashPin(pin) {
    return crypto.createHash('sha256').update(String(pin) + (process.env.PIN_PEPPER || 'cleancrew-pin')).digest('hex');
}

app.get('/api/owner-pin/status', authenticate, async (req, res) => {
    try {
        const { data, error } = await supabase
            .from('subscriptions')
            .select('owner_pin_hash, revenue_locked')
            .eq('user_id', req.user.id)
            .maybeSingle();
        if (error) throw error;
        // Default: if no PIN, revenue is visible; if PIN exists, default to locked
        const hasPin = !!(data && data.owner_pin_hash);
        const locked = hasPin ? (data.revenue_locked !== false) : false;
        res.json({ has_pin: hasPin, locked: locked });
    } catch (error) {
        console.error('owner-pin status:', error);
        res.status(500).json({ error: error.message });
    }
});

app.post('/api/owner-pin/set', authenticate, async (req, res) => {
    try {
        const pin = String(req.body.pin || '').trim();
        const current = String(req.body.current_pin || '').trim();
        if (!/^\d{4,6}$/.test(pin)) {
            return res.status(400).json({ error: 'PIN must be 4–6 digits' });
        }
        const { data: sub, error: subErr } = await supabase
            .from('subscriptions')
            .select('user_id, owner_pin_hash, plan, status')
            .eq('user_id', req.user.id)
            .maybeSingle();
        if (subErr) throw subErr;

        if (sub && sub.owner_pin_hash) {
            if (!current || hashPin(current) !== sub.owner_pin_hash) {
                return res.status(403).json({
                    error: 'Current PIN is incorrect. Enter your existing PIN to change it.'
                });
            }
        }

        const payload = {
            owner_pin_hash: hashPin(pin),
            revenue_locked: true  // When PIN is set, lock revenue by default
        };

        if (sub && sub.user_id) {
            const { error } = await supabase
                .from('subscriptions')
                .update(payload)
                .eq('user_id', req.user.id);
            if (error) throw error;
        } else {
            const { error } = await supabase
                .from('subscriptions')
                .insert({
                    user_id: req.user.id,
                    plan: 'free',
                    status: 'active',
                    ...payload
                });
            if (error) throw error;
        }
        res.json({ success: true, has_pin: true, locked: true });
    } catch (error) {
        console.error('owner-pin set:', error);
        res.status(500).json({ error: error.message });
    }
});

app.post('/api/owner-pin/verify', authenticate, async (req, res) => {
    try {
        const pin = String(req.body.pin || '').trim();
        const { data, error } = await supabase
            .from('subscriptions')
            .select('owner_pin_hash, revenue_locked')
            .eq('user_id', req.user.id)
            .maybeSingle();
        if (error) throw error;
        if (!data || !data.owner_pin_hash) {
            return res.json({ ok: true, unlocked: true, has_pin: false, locked: false });
        }
        if (hashPin(pin) === data.owner_pin_hash) {
            // PIN verified → unlock revenue and update server-side lock status
            await supabase
                .from('subscriptions')
                .update({ revenue_locked: false })
                .eq('user_id', req.user.id);
            return res.json({ 
                ok: true, 
                unlocked: true, 
                has_pin: true, 
                locked: false 
            });
        }
        return res.status(403).json({ ok: false, error: 'Incorrect PIN' });
    } catch (error) {
        console.error('owner-pin verify:', error);
        res.status(500).json({ error: error.message });
    }
});


// ─── ──────────────────────────────────────────────────────
// ─── REVENUE LOCK (sync across devices) ──────────────────
// ─── ──────────────────────────────────────────────────────

// ─── Get revenue lock status ─────────────────────────────
app.get('/api/revenue/lock-status', authenticate, async (req, res) => {
    try {
        const { data, error } = await supabase
            .from('subscriptions')
            .select('revenue_locked, owner_pin_hash')
            .eq('user_id', req.user.id)
            .maybeSingle();

        if (error) throw error;

        // If no PIN is set, revenue is always visible
        if (!data || !data.owner_pin_hash) {
            return res.json({ locked: false, has_pin: false });
        }

        // Default to locked if PIN exists (safer default)
        const locked = data.revenue_locked !== undefined ? data.revenue_locked : true;
        res.json({ locked, has_pin: true });
    } catch (error) {
        console.error('Revenue lock status error:', error);
        res.status(500).json({ error: error.message });
    }
});

// ─── Toggle revenue lock ──────────────────────────────────
app.post('/api/revenue/lock', authenticate, async (req, res) => {
    try {
        const { lock } = req.body; // true = lock, false = unlock
        
        // Verify user has a PIN before allowing lock/unlock
        const { data: sub, error: subError } = await supabase
            .from('subscriptions')
            .select('owner_pin_hash')
            .eq('user_id', req.user.id)
            .maybeSingle();
            
        if (subError) throw subError;
        if (!sub || !sub.owner_pin_hash) {
            return res.status(400).json({ 
                error: 'Please set an owner PIN first before locking revenue.' 
            });
        }

        const { data, error } = await supabase
            .from('subscriptions')
            .update({ revenue_locked: lock })
            .eq('user_id', req.user.id)
            .select('revenue_locked')
            .single();

        if (error) throw error;
        res.json({ locked: data.revenue_locked });
    } catch (error) {
        console.error('Revenue lock toggle error:', error);
        res.status(500).json({ error: error.message });
    }
});
// ─── ──────────────────────────────────────────────────────
// ─── INVOICE SETTINGS ROUTES ─────────────────────────────
// ─── ──────────────────────────────────────────────────────

// ─── Get Invoice Settings ────────────────────────────────
app.get('/api/invoice-settings', authenticate, async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('invoice_settings')
      .select('*')
      .eq('user_id', req.user.id)
      .maybeSingle();

    if (error) throw error;
    res.json(data || {});
  } catch (error) {
    console.error('Get invoice settings error:', error);
    res.status(500).json({ error: error.message });
  }
});

// ─── Save Invoice Settings ──────────────────────────────
app.post('/api/invoice-settings', authenticate, async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('invoice_settings')
      .upsert({
        user_id: req.user.id,
        ...req.body,
        updated_at: new Date().toISOString()
      })
      .select()
      .single();

    if (error) throw error;
    res.json(data);
  } catch (error) {
    console.error('Save invoice settings error:', error);
    res.status(500).json({ error: error.message });
  }
});

// ─── ──────────────────────────────────────────────────────
// ─── GENERATE INVOICE PDF ────────────────────────────────
// ─── ──────────────────────────────────────────────────────

// ─── Generate PDF for an invoice ─────────────────────────
app.post('/api/invoices/:id/generate-pdf', authenticate, async (req, res) => {
  try {
    const { id } = req.params;
    const userId = req.user.id;

    // Get invoice
    const { data: invoice, error: invoiceError } = await supabase
      .from('invoices')
      .select('*')
      .eq('id', id)
      .eq('user_id', userId)
      .single();

    if (invoiceError) throw invoiceError;
    if (!invoice) return res.status(404).json({ error: 'Invoice not found' });

    // Get settings
    const { data: settings, error: settingsError } = await supabase
      .from('invoice_settings')
      .select('*')
      .eq('user_id', userId)
      .maybeSingle();

    if (settingsError) throw settingsError;

    // Generate PDF
    const { jsPDF } = require('jspdf');

    const doc = new jsPDF();
    const pageWidth = doc.internal.pageSize.getWidth();
    const margin = 20;
    let y = 20;

    // ─── HEADER ────────────────────────────────────────────
    const businessName = settings?.business_name || 'CleanCrew Laundry';
    const address = settings?.business_address || '';
    const phone = settings?.phone || '';
    const email = settings?.email || '';

    doc.setFontSize(24);
    doc.setFont('helvetica', 'bold');
    doc.setTextColor(26, 109, 219);
    doc.text(businessName, margin, y);
    y += 10;

    doc.setFontSize(10);
    doc.setFont('helvetica', 'normal');
    doc.setTextColor(100, 100, 100);
    if (address) { doc.text(address, margin, y); y += 6; }
    if (phone) { doc.text(`Phone: ${phone}`, margin, y); y += 6; }
    if (email) { doc.text(`Email: ${email}`, margin, y); y += 6; }
    y += 4;

    doc.setDrawColor(26, 109, 219);
    doc.setLineWidth(0.5);
    doc.line(margin, y, pageWidth - margin, y);
    y += 10;

    // ─── INVOICE TITLE ────────────────────────────────────
    doc.setFontSize(20);
    doc.setFont('helvetica', 'bold');
    doc.setTextColor(26, 109, 219);
    doc.text('INVOICE', margin, y);

    const invoiceNumber = invoice.number || invoice.invoice_numb || `CC-${String(invoice.id).slice(0, 8)}`;
    const invoiceDate = new Date(invoice.date || invoice.created_at).toLocaleDateString('en-NG', {
      day: '2-digit',
      month: 'short',
      year: 'numeric'
    });

    doc.setFontSize(11);
    doc.setFont('helvetica', 'normal');
    doc.setTextColor(51, 51, 51);
    doc.text(`#${invoiceNumber}`, pageWidth - margin - 10, y, { align: 'right' });
    y += 8;
    doc.text(`Date: ${invoiceDate}`, pageWidth - margin - 10, y, { align: 'right' });
    y += 8;

    const statusText = invoice.status || 'Unpaid';
    const statusColor = statusText === 'paid' ? '#16A34A' : (statusText === 'pending' ? '#F0A421' : '#DC2626');
    doc.setTextColor(statusColor);
    doc.text(`Status: ${statusText.charAt(0).toUpperCase() + statusText.slice(1)}`, pageWidth - margin - 10, y, { align: 'right' });
    y += 14;

    // ─── BILL TO ──────────────────────────────────────────
    doc.setFontSize(11);
    doc.setFont('helvetica', 'bold');
    doc.setTextColor(51, 51, 51);
    doc.text('BILL TO:', margin, y);
    y += 8;

    doc.setFont('helvetica', 'normal');
    doc.text(invoice.client || 'Customer', margin, y);
    y += 6;
    if (invoice.phone) { doc.text(`Phone: ${invoice.phone}`, margin, y); y += 6; }
    y += 8;

    // ─── ITEMS TABLE ──────────────────────────────────────
    const col1 = margin;
    const col2 = 110;
    const col3 = 150;
    const col4 = 175;
    const rowHeight = 8;

    doc.setFillColor(240, 244, 248);
    doc.rect(margin, y - 4, pageWidth - (margin * 2), rowHeight, 'F');

    doc.setFont('helvetica', 'bold');
    doc.setFontSize(10);
    doc.setTextColor(51, 51, 51);
    doc.text('Description', col1, y);
    doc.text('Qty', col2, y);
    doc.text('Price', col3, y);
    doc.text('Total', col4, y);
    y += rowHeight + 4;

    const amount = invoice.amount || invoice.amount_due || 0;
    let items = [];

    if (invoice.items) {
      try {
        items = typeof invoice.items === 'string' ? JSON.parse(invoice.items) : invoice.items;
      } catch (e) { items = []; }
    }

    if (!items || items.length === 0) {
      items = [{ name: invoice.service || 'Service', qty: 1, price: amount }];
    }

    doc.setFont('helvetica', 'normal');
    doc.setFontSize(10);
    doc.setTextColor(51, 51, 51);

    items.forEach((item) => {
      const itemName = item.name || item.service || 'Service';
      const qty = item.qty || 1;
      const price = item.price || (amount / qty) || 0;
      const total = qty * price;

      doc.text(itemName.substring(0, 30), col1, y);
      doc.text(String(qty), col2, y);
      doc.text(`₦${price.toLocaleString()}`, col3, y);
      doc.text(`₦${total.toLocaleString()}`, col4, y);
      y += rowHeight;

      if (y > 260) {
        doc.addPage();
        y = 20;
      }
    });

    y += 4;
    doc.setDrawColor(200, 200, 200);
    doc.line(margin, y, pageWidth - margin, y);
    y += 6;

    doc.setFont('helvetica', 'bold');
    doc.setFontSize(12);
    doc.setTextColor(26, 109, 219);
    doc.text('TOTAL', col3, y);
    doc.text(`₦${amount.toLocaleString()}`, col4, y);
    y += 16;

    // ─── PAYMENT INSTRUCTIONS ──────────────────────────
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(12);
    doc.setTextColor(26, 109, 219);
    doc.text('Payment Instructions', margin, y);
    y += 8;

    doc.setFont('helvetica', 'normal');
    doc.setFontSize(10);
    doc.setTextColor(51, 51, 51);

    const bankName = settings?.bank_name || '';
    const accountName = settings?.account_name || '';
    const accountNumber = settings?.account_number || '';
    const paymentWhatsapp = settings?.payment_whatsapp || '';

    if (bankName) { doc.text(`Bank: ${bankName}`, margin, y); y += 6; }
    if (accountName) { doc.text(`Account Name: ${accountName}`, margin, y); y += 6; }
    if (accountNumber) { doc.text(`Account Number: ${accountNumber}`, margin, y); y += 6; }
    doc.text(`Reference: ${invoiceNumber}`, margin, y);
    y += 6;
    if (paymentWhatsapp) {
      doc.text(`After payment, send proof to: ${paymentWhatsapp}`, margin, y);
      y += 10;
    }

    // ─── FOOTER ──────────────────────────────────────────
    const footerY = 280;
    doc.setFontSize(9);
    doc.setTextColor(150, 150, 150);
    doc.setFont('helvetica', 'italic');
    doc.text(`Thank you for choosing ${businessName}!`, margin, footerY);
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(8);
    doc.setTextColor(180, 180, 180);
    doc.text('Powered by CleanCrew — cleancrewapp.com', margin, footerY + 6);

    // ─── SAVE PDF ──────────────────────────────────────
    const pdfBuffer = doc.output('arraybuffer');
    const fileName = `invoice_${invoice.id}_${Date.now()}.pdf`;

    // Make sure the 'invoices' bucket exists before uploading. If this is
    // the first time PDF generation has run, or the bucket was deleted,
    // this creates it automatically instead of failing outright.
    const { data: buckets, error: listBucketsError } = await supabase.storage.listBuckets();
    if (listBucketsError) {
      console.error('Could not list Storage buckets:', listBucketsError);
    }
    const invoicesBucketExists = (buckets || []).some(b => b.name === 'invoices');
    if (!invoicesBucketExists) {
      const { error: createBucketError } = await supabase.storage.createBucket('invoices', {
        public: true
      });
      if (createBucketError) {
        console.error('Failed to auto-create "invoices" bucket:', createBucketError);
      } else {
        console.log('Created missing "invoices" Storage bucket.');
      }
    }

    // Try to upload to Supabase Storage
    const { error: uploadError } = await supabase.storage
      .from('invoices')
      .upload(fileName, Buffer.from(pdfBuffer), {
        contentType: 'application/pdf',
        cacheControl: '3600',
        upsert: true
      });

    if (uploadError) {
      console.error('Invoice PDF upload failed:', uploadError);
      return res.status(500).json({
        error: 'PDF was created but could not be saved. Check that the Supabase Storage bucket "invoices" exists and is accessible.',
        details: uploadError.message
      });
    }

    // Get public URL
    const { data: urlData } = supabase.storage
      .from('invoices')
      .getPublicUrl(fileName);

    const pdfUrl = urlData.publicUrl;

    // Update invoice with PDF URL
    const { error: updateError } = await supabase
      .from('invoices')
      .update({ pdf_url: pdfUrl })
      .eq('id', id);

    if (updateError) {
      console.error('Invoice PDF URL update failed:', updateError);
      return res.status(500).json({
        error: 'PDF was uploaded, but the invoice could not be updated with its PDF URL.',
        details: updateError.message
      });
    }

    res.json({
      success: true,
      pdf_url: pdfUrl,
      message: 'PDF generated successfully'
    });

  } catch (error) {
    console.error('PDF generation error:', error);
    res.status(500).json({
      error: error.message || 'Failed to generate PDF'
    });
  }
});

// ─── Get Invoice PDF ────────────────────────────────────
app.get('/api/invoices/:id/pdf', authenticate, async (req, res) => {
  try {
    const { id } = req.params;
    const userId = req.user.id;

    const { data: invoice, error: invoiceError } = await supabase
      .from('invoices')
      .select('*')
      .eq('id', id)
      .eq('user_id', userId)
      .single();

    if (invoiceError) throw invoiceError;
    if (!invoice) return res.status(404).json({ error: 'Invoice not found' });

    if (invoice.pdf_url) {
      return res.json({ pdf_url: invoice.pdf_url });
    }

    return res.status(404).json({ error: 'PDF not generated yet' });
    
  } catch (error) {
    console.error('Get invoice PDF error:', error);
    res.status(500).json({ error: error.message });
  }
});


// ─── ──────────────────────────────────────────────────────
// ─── START SERVER ──────────────────────────────────────────
// ─── ──────────────────────────────────────────────────────

const PORT = process.env.PORT || 5000;
app.listen(PORT, '0.0.0.0', () => {
    console.log(`✅ CleanCrew server running on port ${PORT}`);
    console.log(`   Local: http://localhost:${PORT}`);
});
