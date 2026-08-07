// ─── server.js ──────────────────────────────────────────────
const express = require('express');
const cors = require('cors');
const dotenv = require('dotenv');
const crypto = require('crypto');
const { createClient } = require('@supabase/supabase-js');

dotenv.config();

const app = express();

// ─── CORS ──────────────────────────────────────────────────
app.use(cors({
  origin: '*',
  methods: ['GET', 'POST', 'PUT', 'DELETE'],
  allowedHeaders: ['Content-Type', 'Authorization']
}));

app.use(express.json());
app.use(express.static(__dirname));

// ─── Supabase Client ──────────────────────────────────────
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

// ─── Paystack config ──────────────────────────────────────
const PAYSTACK_SECRET_KEY = process.env.PAYSTACK_SECRET_KEY;
const PAYSTACK_PUBLIC_KEY = process.env.PAYSTACK_PUBLIC_KEY;

// ─── Paystack plans ──────────────────────────────────────
const PLANS = {
  starter: { 
    amount: 1000000, // ₦10,000 in kobo
    name: 'Starter',
    features: 'Up to 50 jobs, 50 clients',
    limits: { jobs: 50, clients: 50 }
  },
  professional: { 
    amount: 1750000, // ₦17,500 in kobo
    name: 'Professional',
    features: 'Unlimited jobs & clients, invoicing',
    limits: { jobs: Infinity, clients: Infinity }
  },
  enterprise: { 
    amount: 3500000, // ₦35,000 in kobo
    name: 'Enterprise',
    features: 'Everything + team access',
    limits: { jobs: Infinity, clients: Infinity }
  }
};

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

  req.user = user;
  next();
};

// ─── PLAN LIMIT CHECK ──────────────────────────────────
async function checkPlanLimit(userId, type) {
  const { data: sub, error: subError } = await supabase
    .from('subscriptions')
    .select('plan')
    .eq('user_id', userId)
    .single();

  if (subError && subError.code !== 'PGRST116') {
    throw new Error('Error checking subscription');
  }

  const planName = sub?.plan || 'starter';
  const limit = PLANS[planName]?.limits?.[type] || 50;

  if (limit === Infinity) {
    return { allowed: true, limit: Infinity, plan: planName, count: 0 };
  }

  const { count, error: countError } = await supabase
    .from(type)
    .select('*', { count: 'exact', head: true })
    .eq('user_id', userId);

  if (countError) {
    throw new Error('Error counting items');
  }

  const currentCount = count || 0;

  if (currentCount >= limit) {
    return { 
      allowed: false, 
      limit, 
      count: currentCount, 
      plan: planName,
      message: `You've reached your ${planName} plan limit of ${limit} ${type}. Upgrade to Professional for unlimited ${type}.`
    };
  }

  return { allowed: true, limit, count: currentCount, plan: planName };
}

// ─── ──────────────────────────────────────────────────────
// ─── AUTH ROUTES ──────────────────────────────────────────
// ─── ──────────────────────────────────────────────────────

app.post('/api/auth/signup', async (req, res) => {
  try {
    const { name, email, password } = req.body;

    if (!name || !email || !password) {
      return res.status(400).json({ error: 'All fields are required' });
    }

    const { data: authData, error: authError } = await supabase.auth.signUp({
      email,
      password,
      options: { data: { name } }
    });

    if (authError) throw authError;

    const trialEnd = new Date();
    trialEnd.setDate(trialEnd.getDate() + 14);

    await supabase
      .from('subscriptions')
      .insert({
        user_id: authData.user.id,
        status: 'trial',
        trial_end: trialEnd.toISOString(),
        plan: 'professional'
      });

    res.json({ success: true, user: authData.user });
  } catch (error) {
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

    const { data: sub } = await supabase
      .from('subscriptions')
      .select('*')
      .eq('user_id', authData.user.id)
      .single();

    res.json({
      token: authData.session.access_token,
      user: {
        id: authData.user.id,
        email: authData.user.email,
        name: authData.user.user_metadata.name,
        subscription: sub || { status: 'trial', trial_end: new Date(Date.now() + 14 * 86400000) }
      }
    });
  } catch (error) {
    res.status(401).json({ error: error.message });
  }
});

// ─── Get User ─────────────────────────────────────────────
app.get('/api/user', authenticate, async (req, res) => {
  try {
    res.json({
      id: req.user.id,
      email: req.user.email,
      name: req.user.user_metadata?.name || ''
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ─── ──────────────────────────────────────────────────────
// ─── PASSWORD RESET ROUTES ──────────────────────────────
// ─── ──────────────────────────────────────────────────────

// ─── Forgot Password ──────────────────────────────────────
app.post('/api/auth/reset-password', async (req, res) => {
  try {
    const { email } = req.body;

    if (!email) {
      return res.status(400).json({ error: 'Email is required' });
    }

    const { error } = await supabase.auth.resetPasswordForEmail(email, {
      redirectTo: 'https://cleancrew-frontend.vercel.app/reset-password.html'
    });

    if (error) throw error;

    res.json({ success: true, message: 'Password reset email sent' });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

// ─── Confirm Reset Password ──────────────────────────────
app.post('/api/auth/reset-password/confirm', async (req, res) => {
  try {
    const { access_token, new_password } = req.body;

    if (!access_token || !new_password) {
      return res.status(400).json({ error: 'Token and new password are required' });
    }

    const { data, error } = await supabase.auth.updateUser({
      password: new_password,
      access_token: access_token
    });

    if (error) throw error;

    res.json({ success: true, message: 'Password updated successfully' });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

// ─── ──────────────────────────────────────────────────────
// ─── SUBSCRIPTION ROUTES ──────────────────────────────────
// ─── ──────────────────────────────────────────────────────

app.get('/api/subscription/status', authenticate, async (req, res) => {
  try {
    const { data: sub } = await supabase
      .from('subscriptions')
      .select('*')
      .eq('user_id', req.user.id)
      .single();
    
    res.json({
      status: sub?.status || 'trial',
      trial_end: sub?.trial_end || new Date(Date.now() + 14 * 86400000),
      plan: sub?.plan || 'professional'
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ─── Initialize Paystack payment ───────────────────────────
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
        callback_url: 'https://cleancrew-frontend.vercel.app/dashboard.html',
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

// ─── Verify Paystack transaction ────────────────────────────
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

// ─── Paystack Webhook ──────────────────────────────────────
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

// ─── ──────────────────────────────────────────────────────
// ─── CRUD ROUTES WITH PLAN LIMITS ──────────────────────
// ─── ──────────────────────────────────────────────────────

// ─── JOBS ──────────────────────────────────────────────────
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

    const job = { ...req.body, user_id: req.user.id };
    const { data, error } = await supabase
      .from('jobs')
      .insert(job)
      .select()
      .single();

    if (error) throw error;
    res.json(data);
  } catch (error) {
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
    res.status(500).json({ error: error.message });
  }
});

// ─── CLIENTS ──────────────────────────────────────────────
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
    res.status(500).json({ error: error.message });
  }
});

// ─── START SERVER ──────────────────────────────────────────
const PORT = process.env.PORT || 5000;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`✅ CleanCrew server running on port ${PORT}`);
  console.log(`   Local: http://localhost:${PORT}`);
});