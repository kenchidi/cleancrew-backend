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

const m = new Module(filename, module.parent);
m.filename = filename;
m.paths = Module._nodeModulePaths(path.dirname(filename));
m._compile(source, filename);
