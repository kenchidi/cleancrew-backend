const fs = require('fs');
const Module = require('module');
const path = require('path');

const filename = path.join(__dirname, 'server.js');
let source = fs.readFileSync(filename, 'utf8');

// Fix job insertion retries: only retry when the full payload is rejected by
// an old/missing schema. Retrying RLS/network/constraint errors can create
// duplicates or hide the real failure.
const oldInsert = `            let data, error;
            {
                const attempt = await supabase.from('jobs').insert(job).select().single();
                data = attempt.data;
                error = attempt.error;
            }
            if (error) {
                console.warn('Job insert full failed, retry minimal:', error.message || error);
                const retry = await supabase.from('jobs').insert(minimalJob).select().single();
                data = retry.data;
                error = retry.error;
            }`;

const newInsert = `            let data, error;
            {
                const attempt = await supabase.from('jobs').insert(job).select().single();
                data = attempt.data;
                error = attempt.error;
            }

            if (error && /column|schema|does not exist|could not find/i.test(error.message || '')) {
                console.warn('Job insert full failed due to schema mismatch, retry minimal:', error.message || error);
                const retry = await supabase.from('jobs').insert(minimalJob).select().single();
                data = retry.data;
                error = retry.error;
            }`;

if (!source.includes(oldInsert)) {
    throw new Error('Hotfix could not find the job insert block');
}
source = source.replace(oldInsert, newInsert);

// Return the job immediately after the successful insert. Client auto-save,
// staff assignment and quota refresh are secondary work and should not keep
// the New Job request waiting on more database round-trips.
const oldSideEffects = `            // Auto-save client from job form (no need to fill Clients tab separately)
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
            });`;

const newSideEffects = `            const responseData = {
                ...data,
                _meta: {
                    source: canCreate.source,
                    free_remaining: null,
                    credits_remaining: canCreate.source === 'credit'
                        ? consumedCreditBalance
                        : null
                }
            };
            res.json(responseData);

            // Secondary work is intentionally detached from the HTTP response.
            // A failure here must never make a successfully-created job look
            // like it failed to the user.
            setImmediate(async function () {
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

                try {
                    const assignments = Array.isArray(req.body.staff_assignments)
                        ? req.body.staff_assignments
                        : [];
                    if (assignments.length && data && data.id) {
                        await replaceJobStaff(userId, data.id, assignments);
                    }
                } catch (staffErr) {
                    console.error('Job created but staff assign failed:', staffErr.message || staffErr);
                }
            });`;

if (!source.includes(oldSideEffects)) {
    throw new Error('Hotfix could not find the job side-effect block');
}
source = source.replace(oldSideEffects, newSideEffects);

// Do not make account setup block signup. Auth creation is the critical path;
// subscription and credit-wallet records are safely initialized in the
// background, while login already falls back to the free plan if needed.
const oldSignupSetup = `        await supabase
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
        }`;

const newSignupSetup = `        setImmediate(async function () {
            try {
                await supabase
                    .from('subscriptions')
                    .insert({
                        user_id: authData.user.id,
                        status: 'active',
                        trial_end: null,
                        plan: 'free'
                    });
            } catch (subscriptionErr) {
                console.error('Subscription setup on signup failed:', subscriptionErr.message || subscriptionErr);
            }

            try {
                await ensureCreditWallet(authData.user.id);
            } catch (walletErr) {
                console.error('Credit wallet on signup (non-fatal):', walletErr.message || walletErr);
            }
        });`;

if (!source.includes(oldSignupSetup)) {
    throw new Error('Hotfix could not find the signup setup block');
}
source = source.replace(oldSignupSetup, newSignupSetup);

// ─── Dashboard startup optimization ─────────────────────────
// server.js serves static files itself. Replace that middleware with a small
// wrapper that serves dashboard.html after removing the client-side request
// storm. The actual dashboard file stays unchanged in GitHub.
const oldStatic = `app.use(express.static(__dirname));`;
const newStatic = `// Serve dashboard.html with a staged startup so a Render cold start is not
// hit by 8-10 authenticated Supabase requests at the same time.
app.use(function cleancrewDashboardFastStart(req, res, next) {
    if (req.path !== '/dashboard.html' && req.path !== '/') return next();
    try {
        const dashboardPath = path.join(__dirname, 'dashboard.html');
        let html = fs.readFileSync(dashboardPath, 'utf8');

        const oldInit = \`        function init() {
            updateDashGreeting();
            try { currentLocationFilter = localStorage.getItem('cleancrew_location_filter') || 'all'; } catch (e) {}

            // Critical path first — show jobs/overview ASAP (Render cold start is slow)
            try {
                var b = document.getElementById('freeJobsBadge');
                if (b && /—|-/.test(b.textContent)) b.textContent = 'Free jobs: …';
            } catch (eB) {}
            renderAll();
            refreshFreeJobs();
            refreshCredits();
            setTimeout(function() { refreshFreeJobs(); }, 800);

            // Secondary — delay so jobs/quota get the network first
            setTimeout(function() {
                try { loadUserInfo(); } catch (e) {}
                try { checkPaystackReturn(); } catch (e) {}
            }, 50);
            setTimeout(function() {
                try { initRevenueLock(); } catch (e) {}
                try { checkSubscription(); } catch (e) {}
                try { loadInvoiceSettings(); } catch (e) {}
                if (typeof loadLocations === 'function') {
                    loadLocations().then(function() {
                        try {
                            if (jobsData && jobsData.length) renderOverview(jobsData, clientsData || []);
                            if (typeof renderJobs === 'function') renderJobs(jobsData);
                        } catch (e2) {}
                    }).catch(function() {});
                }
                try { loadBusinessPage(); } catch (e) {}
            }, 0);
        }\`;

        const newInit = \`        function init() {
            updateDashGreeting();
            try { currentLocationFilter = localStorage.getItem('cleancrew_location_filter') || 'all'; } catch (e) {}

            // Critical path: only the jobs + clients request starts immediately.
            // Everything else is deliberately staggered so Render/Supabase is not
            // flooded by simultaneous authenticated requests during cold starts.
            try {
                var b = document.getElementById('freeJobsBadge');
                if (b && /—|-/.test(b.textContent)) b.textContent = 'Free jobs: …';
            } catch (eB) {}

            renderAll();

            // Quota/credits are useful, but not required to paint the dashboard.
            setTimeout(function() { refreshFreeJobs(); }, 1200);
            setTimeout(function() { refreshCredits(); }, 1700);

            // Identity/payment state comes after the first data paint.
            setTimeout(function() {
                try { loadUserInfo(); } catch (e) {}
                try { checkPaystackReturn(); } catch (e) {}
            }, 2200);

            setTimeout(function() {
                try { initRevenueLock(); } catch (e) {}
            }, 3200);

            setTimeout(function() {
                try { checkSubscription(); } catch (e) {}
            }, 3800);

            setTimeout(function() {
                try { loadInvoiceSettings(); } catch (e) {}
            }, 4500);

            setTimeout(function() {
                if (typeof loadLocations === 'function') {
                    loadLocations().then(function() {
                        try {
                            if (jobsData && jobsData.length) renderOverview(jobsData, clientsData || []);
                            if (typeof renderJobs === 'function') renderJobs(jobsData);
                        } catch (e2) {}
                    }).catch(function() {});
                }
            }, 5400);

            setTimeout(function() {
                try { loadBusinessPage(); } catch (e) {}
            }, 6500);
        }\`;

        if (!html.includes(oldInit)) {
            console.error('Dashboard fast-start transform could not find init block; serving original dashboard.');
        } else {
            html = html.replace(oldInit, newInit);
        }

        // Keep invoices out of the first render wave. They only feed the
        // outstanding KPI and can update it after the main dashboard is painted.
        const oldInvoiceStart = \`                    if (typeof getInvoices === 'function') {
                        getInvoices().then(function(inv) {\`;
        const newInvoiceStart = \`                    if (typeof getInvoices === 'function') {
                        setTimeout(function() { getInvoices().then(function(inv) {\`;
\`;
        const oldInvoiceEnd = \`                        }).catch(function() {});
                    }
                })\n                .catch(function(e) {\`;
        const newInvoiceEnd = \`                        }).catch(function() {}); }, 1500);
                    }
                })\n                .catch(function(e) {\`;
        if (html.includes(oldInvoiceStart) && html.includes(oldInvoiceEnd)) {
            html = html.replace(oldInvoiceStart, newInvoiceStart).replace(oldInvoiceEnd, newInvoiceEnd);
        }

        res.setHeader('Cache-Control', 'no-store');
        res.type('html').send(html);
    } catch (e) {
        console.error('Dashboard fast-start middleware failed:', e);
        next();
    }
});

app.use(express.static(__dirname));`;

if (!source.includes(oldStatic)) {
    throw new Error('Hotfix could not find express static middleware');
}
source = source.replace(oldStatic, newStatic);

const m = new Module(filename, module.parent);
m.filename = filename;
m.paths = Module._nodeModulePaths(path.dirname(filename));
m._compile(source, filename);
