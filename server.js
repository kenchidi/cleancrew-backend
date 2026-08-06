const express = require('express');
const cors = require('cors');
const dotenv = require('dotenv');
const { createClient } = require('@supabase/supabase-js');

dotenv.config();

const app = express();

app.use(cors({
  origin: '*',
  methods: ['GET', 'POST', 'PUT', 'DELETE'],
  allowedHeaders: ['Content-Type', 'Authorization']
}));

app.use(express.json());
app.use(express.static(__dirname));

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

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

    const trialEnd = new Date(Date.now() + 14 * 86400000);

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
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/jobs', authenticate, async (req, res) => {
  try {
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

// ─── ──────────────────────────────────────────────────────
// ─── CLIENTS ROUTES ────────────────────────────────────────
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
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/clients', authenticate, async (req, res) => {
  try {
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

// ─── ──────────────────────────────────────────────────────
// ─── START SERVER ──────────────────────────────────────────
// ─── ──────────────────────────────────────────────────────

const PORT = process.env.PORT || 5000;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`✅ CleanCrew server running on port ${PORT}`);
  console.log(`   Local: http://localhost:${PORT}`);
  console.log(`   Network: http://10.5.0.2:${PORT}`);
});