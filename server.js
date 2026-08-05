const express = require('express');
const cors = require('cors');
const bodyParser = require('body-parser');
const https = require('https');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { createClient } = require('@supabase/supabase-js');
require("dotenv").config();

const app = express();

const PERSONA_API_KEY = process.env.PERSONA_API_KEY;
const TEMPLATE_ID = process.env.TEMPLATE_ID;
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!PERSONA_API_KEY || !TEMPLATE_ID || !WEBHOOK_SECRET || !SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    console.error('Missing required environment variables');
    process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

app.use('/api/webhook', bodyParser.json({
    verify: (req, res, buf) => {
        req.rawBody = buf.toString();
    }
}));

app.use(cors());
app.use(bodyParser.json({ limit: '10mb' }));
app.use(bodyParser.urlencoded({ extended: true }));

const LOG_FILE = path.join(__dirname, 'usage-logs.json');

function logUsage(data) {
    try {
        let logs = [];
        if (fs.existsSync(LOG_FILE)) {
            logs = JSON.parse(fs.readFileSync(LOG_FILE, 'utf8'));
        }
        logs.push({ ...data, timestamp: new Date().toISOString() });
        fs.writeFileSync(LOG_FILE, JSON.stringify(logs, null, 2));
    } catch (e) {
        console.error('Logging error:', e);
    }
}

function personaRequest(path, method, body = null) {
    return new Promise((resolve, reject) => {
        const data = body ? JSON.stringify(body) : null;

        const options = {
            hostname: 'api.withpersona.com',
            path: path,
            method: method,
            headers: {
                'Authorization': 'Bearer ' + PERSONA_API_KEY,
                'Content-Type': 'application/json',
                'Persona-Version': '2025-12-08'
            }
        };

        if (data) {
            options.headers['Content-Length'] = Buffer.byteLength(data);
        }

        const request = https.request(options, (response) => {
            let responseBody = '';
            response.on('data', chunk => responseBody += chunk);
            response.on('end', () => {
                try {
                    const parsed = JSON.parse(responseBody);
                    if (response.statusCode >= 400) {
                        reject({ statusCode: response.statusCode, body: parsed });
                    } else {
                        resolve(parsed);
                    }
                } catch (err) {
                    reject(err);
                }
            });
        });

        request.on('error', reject);
        if (data) request.write(data);
        request.end();
    });
}

function verifyWebhookSignature(req, rawBody) {
    const signatureHeader = req.headers['persona-signature'];

    if (!signatureHeader) {
        console.error('Missing persona-signature header');
        return false;
    }

    try {
        const sets = signatureHeader.split(' ');

        for (const set of sets) {
            const parts = Object.fromEntries(
                set.split(',').map(kv => kv.split('='))
            );

            const { t: timestamp, v1: signature } = parts;

            if (!timestamp || !signature) continue;

            const signedPayload = `${timestamp}.${rawBody}`;

            const expected = crypto
                .createHmac('sha256', WEBHOOK_SECRET)
                .update(signedPayload)
                .digest('hex');

            const expectedBuffer = Buffer.from(expected, 'hex');
            const signatureBuffer = Buffer.from(signature, 'hex');

            if (
                expectedBuffer.length === signatureBuffer.length &&
                crypto.timingSafeEqual(expectedBuffer, signatureBuffer)
            ) {
                return true;
            }
        }

        console.error('No matching signature found in persona-signature header');
        return false;

    } catch (err) {
        console.error('Signature verification error:', err);
        return false;
    }
}

// ---------------------------------------------------------------------
// Shared helpers for fetching live status from Persona and syncing to DB
// ---------------------------------------------------------------------

function isTerminalPersonaStatus(status) {
    if (!status) return false;
    const s = status.toLowerCase();
    return ['completed', 'approved', 'declined', 'failed', 'expired'].includes(s);
}

function fetchInquiryFromPersona(inquiryId) {
    return new Promise((resolve, reject) => {
        const options = {
            hostname: 'api.withpersona.com',
            path: '/api/v1/inquiries/' + inquiryId,
            method: 'GET',
            headers: {
                'Authorization': 'Bearer ' + PERSONA_API_KEY,
                'Persona-Version': '2023-01-01'
            }
        };

        const request = https.request(options, (response) => {
            let body = '';
            response.on('data', chunk => body += chunk);
            response.on('end', () => resolve({ statusCode: response.statusCode, body }));
        });
        request.on('error', reject);
        request.end();
    });
}

// Pulls the latest status for a verification row directly from Persona
// and writes it back to Supabase. Returns the updated row (merged with
// what was passed in), or null if the Persona call failed.
async function refreshVerificationFromPersona(verification) {
    if (!verification || !verification.inquiry_id) return null;

    let response;
    try {
        response = await fetchInquiryFromPersona(verification.inquiry_id);
    } catch (err) {
        console.error('Persona refresh request failed:', err);
        return null;
    }

    if (response.statusCode !== 200) {
        console.error('Persona refresh failed:', response.statusCode, response.body);
        return null;
    }

    let parsed;
    try {
        parsed = JSON.parse(response.body);
    } catch (err) {
        console.error('Persona refresh parse failed:', err);
        return null;
    }

    const inquiry = parsed.data;
    const status = inquiry.attributes?.status || verification.status;
    const verificationStatus = inquiry.attributes?.['verification-status'] || null;
    const accountId = inquiry.relationships?.account?.data?.id || null;

    const { error: updateError } = await supabase
        .from('verifications')
        .update({
            status: status,
            verification_status: verificationStatus,
            persona_account_id: accountId || undefined,
            updated_at: new Date().toISOString()
        })
        .eq('id', verification.id);

    if (updateError) {
        console.error('Supabase refresh update error:', updateError);
    }

    return {
        ...verification,
        status,
        verification_status: verificationStatus,
        persona_account_id: accountId || verification.persona_account_id,
        updated_at: new Date().toISOString()
    };
}

// ---------------------------------------------------------------------
// Simple in-memory rate limiter (no extra dependency required)
// Limits by client IP AND by userId, since either could be abused.
// ---------------------------------------------------------------------

function createRateLimiter({ windowMs, max }) {
    const hits = new Map(); // key -> [timestamps]

    // periodic cleanup so the map doesn't grow forever
    setInterval(() => {
        const now = Date.now();
        for (const [key, timestamps] of hits.entries()) {
            const fresh = timestamps.filter(t => now - t < windowMs);
            if (fresh.length === 0) {
                hits.delete(key);
            } else {
                hits.set(key, fresh);
            }
        }
    }, windowMs).unref();

    return function rateLimit(key) {
        const now = Date.now();
        const timestamps = (hits.get(key) || []).filter(t => now - t < windowMs);

        if (timestamps.length >= max) {
            const retryAfterMs = windowMs - (now - timestamps[0]);
            return { limited: true, retryAfterSeconds: Math.ceil(retryAfterMs / 1000) };
        }

        timestamps.push(now);
        hits.set(key, timestamps);
        return { limited: false };
    };
}

// 5 verification starts per IP per 10 minutes, 3 per userId per 10 minutes.
// Tune these numbers to your actual traffic/abuse profile.
const checkIpRateLimit = createRateLimiter({ windowMs: 10 * 60 * 1000, max: 5 });
const checkUserRateLimit = createRateLimiter({ windowMs: 10 * 60 * 1000, max: 3 });

function startVerificationRateLimiter(req, res, next) {
    const ip = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.socket.remoteAddress || 'unknown';
    const userId = req.body?.userId || 'unknown';

    const ipResult = checkIpRateLimit(`ip:${ip}`);
    if (ipResult.limited) {
        res.set('Retry-After', String(ipResult.retryAfterSeconds));
        return res.status(429).json({
            error: 'Too many verification attempts from this address. Please try again later.',
            retryAfterSeconds: ipResult.retryAfterSeconds
        });
    }

    const userResult = checkUserRateLimit(`user:${userId}`);
    if (userResult.limited) {
        res.set('Retry-After', String(userResult.retryAfterSeconds));
        return res.status(429).json({
            error: 'Too many verification attempts for this account. Please try again later.',
            retryAfterSeconds: userResult.retryAfterSeconds
        });
    }

    next();
}

// ---------------------------------------------------------------------
// Extension session store (in-memory)
//
// IMPORTANT CAVEAT: chrome.runtime.id is NOT a secret - it's visible in
// the Chrome Web Store listing and in the extension's own source. This
// session layer confirms "a client claiming to be extension X asked for
// a token" and lets us rate-limit/revoke access - it does NOT
// cryptographically prove the request truly came from your extension.
// A determined attacker could extract your extension ID and request
// their own tokens. This is a reasonable deterrent against casual abuse,
// not a substitute for a real secret if you need stronger guarantees.
// ---------------------------------------------------------------------

const SESSION_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours
const sessions = new Map(); // token -> { extensionId, expiresAt }

// periodic cleanup of expired sessions
setInterval(() => {
    const now = Date.now();
    for (const [token, session] of sessions.entries()) {
        if (session.expiresAt < now) {
            sessions.delete(token);
        }
    }
}, 60 * 60 * 1000).unref();

// Chrome extension IDs are exactly 32 lowercase letters a-p.
function isValidExtensionId(id) {
    return typeof id === 'string' && /^[a-p]{32}$/.test(id);
}

function issueSessionToken(extensionId) {
    const token = crypto.randomBytes(32).toString('hex');
    sessions.set(token, {
        extensionId,
        expiresAt: Date.now() + SESSION_TTL_MS
    });
    return token;
}

function validateSession(token, extensionId) {
    if (!token || !extensionId) return false;
    const session = sessions.get(token);
    if (!session) return false;
    if (session.expiresAt < Date.now()) {
        sessions.delete(token);
        return false;
    }
    return session.extensionId === extensionId;
}

const checkSessionIpRateLimit = createRateLimiter({ windowMs: 10 * 60 * 1000, max: 10 });
const checkExtensionActionRateLimit = createRateLimiter({ windowMs: 10 * 60 * 1000, max: 10 });

function extensionAuthMiddleware(req, res, next) {
    const token = req.headers['x-session-token'];
    const extensionId = req.headers['x-extension-id'];

    if (!validateSession(token, extensionId)) {
        return res.status(401).json({
            error: 'Invalid or expired session. Please re-initialize and try again.'
        });
    }

    const actionResult = checkExtensionActionRateLimit(`ext:${extensionId}`);
    if (actionResult.limited) {
        res.set('Retry-After', String(actionResult.retryAfterSeconds));
        return res.status(429).json({
            error: 'Too many requests from this extension. Please try again later.',
            retryAfterSeconds: actionResult.retryAfterSeconds
        });
    }

    req.extensionId = extensionId;
    next();
}

// ---------------------------------------------------------------------
// Shared verification logic, reused by both the direct HTTP routes and
// the /api/extension dispatcher so there's a single source of truth.
// ---------------------------------------------------------------------

async function startVerificationForUser({ referenceId, userId, redirectUri }) {
    if (!referenceId || !userId || !redirectUri) {
        return { httpStatus: 400, body: { error: 'referenceId, userId and redirectUri are required' } };
    }

    logUsage({
        endpoint: '/api/start-verification',
        referenceId,
        userId,
        redirectUri
    });

    try {
        const inquiry = await personaRequest(
            '/api/v1/inquiries',
            'POST',
            {
                data: {
                    attributes: {
                        "inquiry-template-id": TEMPLATE_ID,
                        "reference-id": referenceId,
                        "redirect-uri": redirectUri
                    }
                },
                meta: {
                    "auto-create-one-time-link": true
                }
            }
        );

        const inquiryId = inquiry.data?.id;
        const flowUrl = inquiry.meta?.['one-time-link'] || inquiry.meta?.['one-time-link-short'];

        if (!inquiryId) {
            console.error("Missing inquiry ID:", inquiry);
            return { httpStatus: 500, body: { error: 'Missing inquiry ID from Persona' } };
        }

        if (!flowUrl) {
            console.error("Missing flow URL:", inquiry);
            return { httpStatus: 500, body: { error: 'Missing flow URL from Persona', inquiryId } };
        }

        const { error: insertError } = await supabase
            .from('verifications')
            .insert({
                inquiry_id: inquiryId,
                reference_id: referenceId,
                user_id: userId,
                template_id: TEMPLATE_ID,
                status: 'created',
                redirect_uri: redirectUri,
                created_at: new Date().toISOString(),
                updated_at: new Date().toISOString()
            });

        if (insertError) {
            console.error('Supabase insert error:', insertError);
        }

        return {
            httpStatus: 200,
            body: { success: true, userId, inquiryId, referenceId, flowUrl }
        };

    } catch (err) {
        console.error('Error starting verification:', err);
        return {
            httpStatus: 502,
            body: { error: 'Failed to start verification', details: err.body || err.message }
        };
    }
}

async function getVerificationStatusForUser(userId) {
    if (!userId) {
        return { httpStatus: 400, body: { error: '_id parameter is required' } };
    }

    try {
        const { data: verifications, error } = await supabase
            .from('verifications')
            .select('*')
            .eq('user_id', userId)
            .order('created_at', { ascending: false })
            .limit(1);

        if (error) {
            console.error('Supabase query error:', error);
            return { httpStatus: 500, body: { error: 'Database query failed' } };
        }

        if (verifications && verifications.length > 0) {
            const verification = verifications[0];

            if (verification.status !== 'created') {
                return {
                    httpStatus: 200,
                    body: {
                        _id: verification.user_id,
                        referenceId: verification.reference_id,
                        status: verification.status,
                        verificationStatus: verification.verification_status,
                        completedAt: verification.updated_at,
                        verified: verification.status === 'approved' || verification.status === 'completed'
                    }
                };
            }

            const refreshed = await refreshVerificationFromPersona(verification);

            if (!refreshed) {
                return { httpStatus: 502, body: { error: 'Persona API error' } };
            }

            const status = refreshed.status;
            const inquiryVerificationStatus = refreshed.verification_status;

            return {
                httpStatus: 200,
                body: {
                    _id: verification.user_id,
                    referenceId: verification.reference_id,
                    status: status,
                    verificationStatus: inquiryVerificationStatus,
                    verified: status === 'approved' || status === 'completed' || inquiryVerificationStatus === 'verified'
                }
            };
        }

        return { httpStatus: 404, body: { error: 'No verification found' } };

    } catch (err) {
        console.error('Error checking status:', err);
        return { httpStatus: 500, body: { error: 'Failed to check verification status' } };
    }
}

// ---------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------

app.post('/auth/session', (req, res) => {
    const ip = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.socket.remoteAddress || 'unknown';

    const ipResult = checkSessionIpRateLimit(`ip:${ip}`);
    if (ipResult.limited) {
        res.set('Retry-After', String(ipResult.retryAfterSeconds));
        return res.status(429).json({
            error: 'Too many session requests from this address. Please try again later.',
            retryAfterSeconds: ipResult.retryAfterSeconds
        });
    }

    const { extensionId } = req.body;

    if (!isValidExtensionId(extensionId)) {
        return res.status(400).json({ error: 'Missing or invalid extensionId' });
    }

    const token = issueSessionToken(extensionId);

    logUsage({ endpoint: '/auth/session', extensionId });

    return res.json({
        token,
        expiresIn: SESSION_TTL_MS / 1000
    });
});

app.post('/api/extension', extensionAuthMiddleware, async (req, res) => {
    const { action, userId, referenceId, redirectUri } = req.body;

    logUsage({ endpoint: '/api/extension', action, extensionId: req.extensionId, userId });

    if (action === 'start_verification') {
        const result = await startVerificationForUser({
            referenceId: referenceId || userId,
            userId,
            redirectUri: redirectUri || `${req.protocol}://${req.get('host')}/redirect`
        });
        return res.status(result.httpStatus).json(result.body);
    }

    if (action === 'verification_status') {
        const result = await getVerificationStatusForUser(userId);
        return res.status(result.httpStatus).json(result.body);
    }

    return res.status(400).json({ error: `Unknown action: ${action}` });
});

app.get('/internal/persona/most-recent-inquiry', async (req, res) => {

    const userId = req.query._id;

    if (!userId) {
        return res.status(400).json({
            error: 'Missing _id parameter'
        });
    }


    try {

        let { data: inquiry, error } = await supabase
            .from('verifications')
            .select('*')
            .eq('user_id', userId)
            .order('created_at', { ascending: false })
            .limit(1)
            .maybeSingle();


        if (error) {

            console.error(
                "Most recent inquiry error:",
                error
            );

            return res.status(500).json({
                error: 'Database query failed'
            });
        }



        if (!inquiry) {

            return res.json({
                status: "NOT_FOUND",
                inquiryId: null,
                failureReasons: [],
                latestFailureReasons: [],
                remainingAttempts: 3,
                createdAt: new Date().toISOString()
            });

        }


        // Self-heal: if we don't yet have a terminal status cached,
        // check Persona live before responding so this endpoint never
        // gets permanently stuck on a stale "created" status.
        if (!isTerminalPersonaStatus(inquiry.status)) {
            const refreshed = await refreshVerificationFromPersona(inquiry);
            if (refreshed) {
                inquiry = refreshed;
            }
        }


        let status = "CREATED";


        if (inquiry.status) {

            status =
                inquiry.status
                .replace('inquiry.', '')
                .toUpperCase();

        }



        return res.json({

            status,

            inquiryId:
                inquiry.inquiry_id,

            failureReasons:
                inquiry.failure_reasons || [],

            latestFailureReasons:
                inquiry.latest_failure_reasons || [],

            remainingAttempts:
                inquiry.remaining_attempts ?? 3,

            createdAt:
                inquiry.created_at

        });



    } catch (err) {

        console.error(
            "Most recent inquiry failed:",
            err
        );


        return res.status(500).json({
            error:'Failed to fetch most recent inquiry'
        });

    }

});

app.get('/internal/worker/verifications', async (req, res) => {
    const userId = req.query._id;

    if (!userId) {
        return res.status(400).json({
            error: 'Missing _id parameter'
        });
    }

    try {

        const { data: verifications, error } = await supabase
            .from('verifications')
            .select('*')
            .eq('user_id', userId)
            .order('created_at', { ascending: false })
            .limit(1);


        if (error) {
            console.error('Supabase query error:', error);

            return res.status(500).json({
                error: 'Database query failed'
            });
        }


        if (verifications && verifications.length > 0) {

            // Self-heal: refresh from Persona live if not yet terminal.
            if (!isTerminalPersonaStatus(verifications[0].status)) {
                const refreshed = await refreshVerificationFromPersona(verifications[0]);
                if (refreshed) {
                    verifications[0] = refreshed;
                }
            }

            const userVerifications = verifications.map(v => ({
                _id: v.user_id,
                createdAt: v.created_at,
                status: 'inquiry.' + v.status.toLowerCase(),
                templateId: v.template_id,
                inquiryId: v.inquiry_id,
                internalFlags: [],
                statusUpdatedAt: v.updated_at,
                personaAccountId: v.persona_account_id
            }));

            return res.json({
                userVerifications
            });
        }


        return res.json({
            userVerifications: []
        });


    } catch (err) {

        console.error(
            'Worker verifications error:',
            err
        );

        return res.status(502).json({
            error: 'Unable to fetch verifications'
        });
    }
});

app.get('/health', (req, res) => 

    { res.json({ status: 'ok', timestamp: new Date().toISOString() }); 

});

app.post('/api/start-verification', startVerificationRateLimiter, async (req, res) => {
    const { referenceId, userId, redirectUri } = req.body;
    const result = await startVerificationForUser({ referenceId, userId, redirectUri });
    return res.status(result.httpStatus).json(result.body);
});

app.get('/redirect', (req, res) => {

    const {
        "inquiry-id": inquiryId,
        "reference-id": referenceId,
        subject,
        status
    } = req.query;



    console.log(
        "Persona redirect:",
        {
            inquiryId,
            referenceId,
            subject,
            status
        }
    );

    const clientUrl =
        process.env.CLIENT_REDIRECT_URL;



    if (clientUrl) {

        return res.redirect(
            `${clientUrl}?inquiryId=${inquiryId}&status=${status}`
        );

    }


    res.json({

        success:true,

        inquiryId,

        referenceId,

        subject,

        status

    });

});

app.post('/api/webhook', async (req, res) => {

    const rawBody = req.rawBody;

    if (!verifyWebhookSignature(req, rawBody)) {
        console.error('Invalid webhook signature');
        return res.status(401).json({
            error: 'Invalid signature'
        });
    }


    const body = req.body;


    logUsage({
        endpoint: '/api/webhook',
        eventType: body.type
    });


    // Persona wraps the actual inquiry inside an Event envelope:
    // { data: { type: 'event', id: 'evt_...', attributes: { name, payload: { data: <inquiry> } } } }
    const inquiryPayload = body.data?.attributes?.payload?.data;

    const inquiryId = inquiryPayload?.id;

    const attributes = inquiryPayload?.attributes || {};

    const status = attributes.status;

    const referenceId = attributes['reference-id'];

    const verificationStatus = attributes['verification-status'];

    const accountId =
        inquiryPayload?.relationships?.account?.data?.id;



    console.log("Webhook data:", {
        inquiryId,
        status,
        referenceId,
        verificationStatus,
        accountId
    });



    if (!inquiryId) {
        return res.status(400).json({
            error: "Missing inquiry ID"
        });
    }



    try {


        const { data: existingVerification } =
            await supabase
            .from('verifications')
            .select(
                'user_id, reference_id, persona_account_id'
            )
            .eq(
                'inquiry_id',
                inquiryId
            )
            .maybeSingle();



        const updateData = {

            inquiry_id: inquiryId,

            reference_id:
                existingVerification?.reference_id ||
                referenceId,

            user_id:
                existingVerification?.user_id || null,

            status: status,

            verification_status:
                verificationStatus || null,

            persona_account_id:
                accountId || existingVerification?.persona_account_id || null,

            webhook_data:
                body,

            updated_at:
                new Date().toISOString()

        };



        console.log(
            "Saving verification:",
            updateData
        );



        const { error } =
            await supabase
            .from('verifications')
            .upsert(
                updateData,
                {
                    onConflict: 'inquiry_id'
                }
            );



        if (error) {

            console.error(
                "Supabase error:",
                error
            );

            return res.status(500).json({
                error:"Database update failed"
            });
        }



        return res.json({

            success:true,

            inquiryId,

            accountId,

            status

        });



    } catch(err) {

        console.error(
            "Webhook error:",
            err
        );


        return res.status(500).json({
            error:"Webhook processing failed"
        });

    }

});

app.get('/api/verification-status', async (req, res) => {
    const userId = req.query._id;
    const result = await getVerificationStatusForUser(userId);
    return res.status(result.httpStatus).json(result.body);
});

app.get('/logs', (req, res) => {
    try {
        if (fs.existsSync(LOG_FILE)) {
            const logs = JSON.parse(fs.readFileSync(LOG_FILE, 'utf8'));
            res.json({ count: logs.length, logs: logs.slice(-100) });
        } else {
            res.json({ count: 0, logs: [] });
        }
    } catch (e) {
        res.json({ count: 0, logs: [] });
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
    console.log(`Template ID: ${TEMPLATE_ID}`);
    console.log(`Webhook URL: https://scaramouch1.onrender.com/api/webhook`);
});