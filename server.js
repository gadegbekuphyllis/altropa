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
    process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

app.use('/api/webhook', bodyParser.json({
    verify: (req, res, buf) => {
        req.rawBody = buf.toString();
    }
}));

const ALLOWED_EXTENSION_IDS = new Set([
    'lmifennglkmmanneighhdeopefefiaom',
]);

const ALLOWED_ORIGINS = new Set([
    'https://app.outlier.ai',
    'https://altropa.onrender.com',
    ...[...ALLOWED_EXTENSION_IDS].map(id => `chrome-extension://${id}`)
]);

app.use(cors({
    origin: (origin, callback) => {
        if (!origin) return callback(null, true);
        if (ALLOWED_ORIGINS.has(origin)) {
            return callback(null, true);
        }
        return callback(new Error('Not allowed by CORS'));
    },
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: [
        'Content-Type',
        'Authorization',
        'x-session-token',
        'x-extension-id',
        'x-internal-api-key',
        'x-csrf-token'
    ],
    credentials: true,
    optionsSuccessStatus: 204
}));

app.use((err, req, res, next) => {
    if (err.message === 'Not allowed by CORS') {
        return res.status(403).json({ error: 'Origin not allowed' });
    }
    next(err);
});

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
    } catch (e) {}
}

// ============================================================
// OUTLIER SERVER-TO-SERVER PROXY
// ============================================================

function callOutlierAPI(endpoint, method = 'GET', body = null, headers = {}) {
    return new Promise((resolve, reject) => {
        const data = body ? JSON.stringify(body) : null;
        const options = {
            hostname: 'app.outlier.ai',
            path: endpoint,
            method: method,
            headers: {
                'Content-Type': 'application/json',
                'User-Agent': 'Altropa-Server/1.0',
                ...headers
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
                    resolve({
                        statusCode: response.statusCode,
                        headers: response.headers,
                        body: JSON.parse(responseBody)
                    });
                } catch (e) {
                    resolve({
                        statusCode: response.statusCode,
                        headers: response.headers,
                        body: responseBody
                    });
                }
            });
        });
        request.on('error', reject);
        if (data) request.write(data);
        request.end();
    });
}

// ============================================================
// PROTECTED PROXY ENDPOINTS - REQUIRES EXTENSION AUTH
// ============================================================

app.post('/api/proxy/internal/worker/get_pii', extensionAuthMiddleware, async (req, res) => {
    const { userId } = req.body;
    if (!userId) {
        return res.status(400).json({ error: 'Missing userId' });
    }
    
    logUsage({
        endpoint: '/api/proxy/internal/worker/get_pii',
        extensionId: req.extensionId,
        userId
    });

    try {
        const result = await callOutlierAPI(
            `/internal/worker/get_pii?worker=${userId}`,
            'GET',
            null,
            {
                'Cookie': req.headers.cookie || '',
                'x-csrf-token': req.headers['x-csrf-token'] || ''
            }
        );
        res.status(result.statusCode).json(result.body);
    } catch (error) {
        res.status(502).json({ error: 'Failed to fetch PII' });
    }
});

app.post('/api/proxy/internal/worker/update_pii', extensionAuthMiddleware, async (req, res) => {
    const { userId, data } = req.body;
    if (!userId || !data) {
        return res.status(400).json({ error: 'Missing userId or data' });
    }
    
    logUsage({
        endpoint: '/api/proxy/internal/worker/update_pii',
        extensionId: req.extensionId,
        userId
    });

    try {
        const result = await callOutlierAPI(
            '/internal/worker/update_pii',
            'POST',
            data,
            {
                'Cookie': req.headers.cookie || '',
                'x-csrf-token': req.headers['x-csrf-token'] || ''
            }
        );
        res.status(result.statusCode).json(result.body);
    } catch (error) {
        res.status(502).json({ error: 'Failed to update PII' });
    }
});

app.post('/api/proxy/internal/worker/verifications', extensionAuthMiddleware, async (req, res) => {
    logUsage({
        endpoint: '/api/proxy/internal/worker/verifications',
        extensionId: req.extensionId
    });

    try {
        const result = await callOutlierAPI(
            '/internal/worker/verifications',
            'POST',
            req.body,
            {
                'Cookie': req.headers.cookie || '',
                'x-csrf-token': req.headers['x-csrf-token'] || ''
            }
        );
        res.status(result.statusCode).json(result.body);
    } catch (error) {
        res.status(502).json({ error: 'Failed to complete verification' });
    }
});

app.get('/api/proxy/internal/persona/most-recent-inquiry', extensionAuthMiddleware, async (req, res) => {
    const { userId, isForAssignment, isProjectOnboarding, isProofOfAddress, isForAddressVerification } = req.query;
    
    if (!userId) {
        return res.status(400).json({ error: 'Missing userId' });
    }

    logUsage({
        endpoint: '/api/proxy/internal/persona/most-recent-inquiry',
        extensionId: req.extensionId,
        userId
    });

    const params = new URLSearchParams({
        isForAssignment: isForAssignment || 'false',
        isProjectOnboarding: isProjectOnboarding || 'false',
        isProofOfAddress: isProofOfAddress || 'false',
        isForAddressVerification: isForAddressVerification || 'false'
    });

    try {
        const result = await callOutlierAPI(
            `/internal/persona/most-recent-inquiry?_id=${userId}&${params.toString()}`,
            'GET',
            null,
            {
                'Cookie': req.headers.cookie || '',
                'x-csrf-token': req.headers['x-csrf-token'] || ''
            }
        );
        res.status(result.statusCode).json(result.body);
    } catch (error) {
        res.status(502).json({ error: 'Failed to fetch most recent inquiry from Outlier' });
    }
});

app.post('/api/proxy/internal/persona/inquiry', extensionAuthMiddleware, async (req, res) => {
    const { userId, isForAssignment, isProjectOnboarding, isProofOfAddress, additionalFields, isForAddressVerification } = req.body;
    
    if (!userId) {
        return res.status(400).json({ error: 'Missing userId' });
    }

    logUsage({
        endpoint: '/api/proxy/internal/persona/inquiry',
        extensionId: req.extensionId,
        userId
    });

    const payload = {
        userId,
        isForAssignment: isForAssignment || false,
        isProjectOnboarding: isProjectOnboarding || false,
        isProofOfAddress: isProofOfAddress || false,
        isForAddressVerification: isForAddressVerification || false,
        additionalFields: additionalFields || {}
    };

    try {
        const result = await callOutlierAPI(
            '/internal/persona/inquiry',
            'POST',
            payload,
            {
                'Cookie': req.headers.cookie || '',
                'x-csrf-token': req.headers['x-csrf-token'] || ''
            }
        );
        res.status(result.statusCode).json(result.body);
    } catch (error) {
        res.status(502).json({ error: 'Failed to create Persona inquiry' });
    }
});

app.get('/api/proxy/internal/fraud/user_verification_template', extensionAuthMiddleware, async (req, res) => {
    const { userId } = req.query;
    if (!userId) {
        return res.status(400).json({ error: 'Missing userId' });
    }

    logUsage({
        endpoint: '/api/proxy/internal/fraud/user_verification_template',
        extensionId: req.extensionId,
        userId
    });

    try {
        const result = await callOutlierAPI(
            `/internal/fraud/user_verification_template?_id=${userId}`,
            'GET',
            null,
            {
                'Cookie': req.headers.cookie || '',
                'x-csrf-token': req.headers['x-csrf-token'] || ''
            }
        );
        res.status(result.statusCode).json(result.body);
    } catch (error) {
        res.status(502).json({ error: 'Failed to fetch' });
    }
});

// ============================================================
// PERSONA API FUNCTIONS
// ============================================================

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
                        const err = new Error(`Persona API error (${response.statusCode}): ${JSON.stringify(parsed)}`);
                        err.statusCode = response.statusCode;
                        err.body = parsed;
                        reject(err);
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
    if (!signatureHeader) return false;
    try {
        const sets = signatureHeader.split(' ');
        for (const set of sets) {
            const parts = Object.fromEntries(set.split(',').map(kv => kv.split('=')));
            const { t: timestamp, v1: signature } = parts;
            if (!timestamp || !signature) continue;
            const signedPayload = `${timestamp}.${rawBody}`;
            const expected = crypto.createHmac('sha256', WEBHOOK_SECRET).update(signedPayload).digest('hex');
            const expectedBuffer = Buffer.from(expected, 'hex');
            const signatureBuffer = Buffer.from(signature, 'hex');
            if (expectedBuffer.length === signatureBuffer.length && crypto.timingSafeEqual(expectedBuffer, signatureBuffer)) {
                return true;
            }
        }
        return false;
    } catch (err) {
        return false;
    }
}

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

async function getOrCreateInquiry(userId) {
    const { data: existing, error: lookupError } = await supabase
        .from('verifications')
        .select('*')
        .eq('user_id', userId)
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle();

    if (lookupError) {}

    let inquiryId;

    if (existing && ['failed', 'declined', 'needs_review'].includes(existing.status)) {
        const err = new Error('A previous verification for this user did not succeed. Contact support to retry.');
        err.code = 'VERIFICATION_BLOCKED';
        err.priorStatus = existing.status;
        throw err;
    } else if (existing && !isTerminalPersonaStatus(existing.status)) {
        inquiryId = existing.inquiry_id;
    } else {
        const inquiry = await personaRequest('/api/v1/inquiries', 'POST', {
            data: {
                attributes: {
                    'inquiry-template-id': TEMPLATE_ID,
                    'reference-id': userId
                }
            }
        });

        inquiryId = inquiry.data?.id;
        if (!inquiryId) {
            throw new Error('Missing inquiry ID from Persona');
        }

        const { error: insertError } = await supabase
            .from('verifications')
            .insert({
                inquiry_id: inquiryId,
                reference_id: userId,
                user_id: userId,
                template_id: TEMPLATE_ID,
                status: 'created',
                created_at: new Date().toISOString(),
                updated_at: new Date().toISOString()
            });

        if (insertError) {}
    }

    const resumeResponse = await personaRequest(`/api/v1/inquiries/${inquiryId}/resume`, 'POST');
    const sessionToken = resumeResponse.meta?.['session-token'];
    if (!sessionToken) {
        throw new Error('Missing session token from Persona resume');
    }

    return { inquiryId, sessionToken };
}

async function refreshVerificationFromPersona(verification) {
    if (!verification || !verification.inquiry_id) return null;

    let response;
    try {
        response = await fetchInquiryFromPersona(verification.inquiry_id);
    } catch (err) {
        return null;
    }

    if (response.statusCode !== 200) {
        return null;
    }

    let parsed;
    try {
        parsed = JSON.parse(response.body);
    } catch (err) {
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

    if (updateError) {}

    return {
        ...verification,
        status,
        verification_status: verificationStatus,
        persona_account_id: accountId || verification.persona_account_id,
        updated_at: new Date().toISOString()
    };
}

function createRateLimiter({ windowMs, max }) {
    const hits = new Map();
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

const SESSION_TTL_MS = 24 * 60 * 60 * 1000;
setInterval(() => {
    supabase
        .from('sessions')
        .delete()
        .lt('expires_at', new Date().toISOString())
        .then(({ error }) => {
            if (error) {}
        });
}, 60 * 60 * 1000).unref();

function isValidExtensionId(id) {
    return typeof id === 'string' && /^[a-p]{32}$/.test(id);
}

async function issueSessionToken(extensionId) {
    const token = crypto.randomBytes(32).toString('hex');
    const expiresAt = new Date(Date.now() + SESSION_TTL_MS).toISOString();
    const { error } = await supabase
        .from('sessions')
        .insert({ token, extension_id: extensionId, expires_at: expiresAt });
    if (error) {
        throw new Error('Failed to create session');
    }
    return token;
}

async function validateSession(token, extensionId) {
    if (!token || !extensionId) return false;
    const { data: session, error } = await supabase
        .from('sessions')
        .select('extension_id, expires_at')
        .eq('token', token)
        .maybeSingle();
    if (error) {
        return false;
    }
    if (!session) return false;
    if (new Date(session.expires_at).getTime() < Date.now()) {
        await supabase.from('sessions').delete().eq('token', token);
        return false;
    }
    return session.extension_id === extensionId;
}

const checkSessionIpRateLimit = createRateLimiter({ windowMs: 10 * 60 * 1000, max: 10 });
const checkExtensionActionRateLimit = createRateLimiter({ windowMs: 10 * 60 * 1000, max: 10 });

async function extensionAuthMiddleware(req, res, next) {
    const token = req.headers['x-session-token'];
    const extensionId = req.headers['x-extension-id'];

    if (!(await validateSession(token, extensionId))) {
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

function internalAuthMiddleware(req, res, next) {
    const key = req.headers['x-internal-api-key'];
    if (!key || key !== process.env.INTERNAL_API_KEY) {
        return res.status(401).json({ error: 'Unauthorized' });
    }
    next();
}

async function startVerificationForUser({ referenceId, userId, redirectUri, origin }) {
    if (!referenceId || !userId || !redirectUri) {
        return { httpStatus: 400, body: { error: 'referenceId, userId and redirectUri are required' } };
    }

    logUsage({
        endpoint: '/api/start-verification',
        referenceId,
        userId,
        redirectUri,
        origin
    });

    try {
        const inquiry = await personaRequest('/api/v1/inquiries', 'POST', {
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
        });

        const inquiryId = inquiry.data?.id;
        const flowUrl = inquiry.meta?.['one-time-link'] || inquiry.meta?.['one-time-link-short'];

        if (!inquiryId) {
            return { httpStatus: 500, body: { error: 'Missing inquiry ID from Persona' } };
        }

        if (!flowUrl) {
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
                origin: origin || null,
                created_at: new Date().toISOString(),
                updated_at: new Date().toISOString()
            });

        if (insertError) {}

        return {
            httpStatus: 200,
            body: { success: true, userId, inquiryId, referenceId, flowUrl }
        };

    } catch (err) {
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
            return { httpStatus: 500, body: { error: 'Database query failed' } };
        }

        if (verifications && verifications.length > 0) {
            const verification = verifications[0];

            if (isTerminalPersonaStatus(verification.status)) {
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
        return { httpStatus: 500, body: { error: 'Failed to check verification status' } };
    }
}

// ============================================================
// ROUTES
// ============================================================

app.post('/auth/session', async (req, res) => {
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

    if (!ALLOWED_EXTENSION_IDS.has(extensionId)) {
        return res.status(403).json({ error: 'Unknown extension' });
    }

    const token = await issueSessionToken(extensionId);

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

    if (action === 'create_inquiry') {
        try {
            const { inquiryId, sessionToken } = await getOrCreateInquiry(userId);
            return res.json({ inquiryId, sessionToken });
        } catch (e) {
            if (e.code === 'VERIFICATION_BLOCKED') {
                return res.status(403).json({
                    error: e.message,
                    priorStatus: e.priorStatus
                });
            }
            return res.status(500).json({
                error: e.message || 'Unknown error creating inquiry',
                details: e.body
            });
        }
    }
    if (action === 'verification_status') {
        const result = await getVerificationStatusForUser(userId);
        return res.status(result.httpStatus).json(result.body);
    }

    if (action === 'get_persona_config') {
        return res.json({
            templateId: TEMPLATE_ID,
            environmentId: process.env.PERSONA_ENVIRONMENT_ID
        });
    }

    return res.status(400).json({ error: `Unknown action: ${action}` });
});

app.post('/internal/persona/inquiry', internalAuthMiddleware, async (req, res) => {
    const { userId } = req.body;

    if (!userId) {
        return res.status(400).json({ error: 'Missing userId' });
    }

    try {
        const personaResponse = await fetch('https://withpersona.com/api/v1/inquiries', {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${process.env.PERSONA_API_KEY}`,
                'Content-Type': 'application/json',
                'Persona-Version': '2023-01-05'
            },
            body: JSON.stringify({
                data: {
                    attributes: {
                        'inquiry-template-id': process.env.PERSONA_TEMPLATE_ID,
                        'reference-id': userId
                    }
                }
            })
        });

        if (!personaResponse.ok) {
            const errBody = await personaResponse.json().catch(() => ({}));
            return res.status(502).json({ error: 'Failed to create inquiry' });
        }

        const data = await personaResponse.json();
        const inquiryId = data.data?.id;

        if (!inquiryId) {
            return res.status(502).json({ error: 'Missing inquiry ID from Persona' });
        }
        const resumeResponse = await fetch(`https://withpersona.com/api/v1/inquiries/${inquiryId}/resume`, {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${process.env.PERSONA_API_KEY}`,
                'Content-Type': 'application/json',
                'Persona-Version': '2023-01-05'
            }
        });

        if (!resumeResponse.ok) {
            const errBody = await resumeResponse.json().catch(() => ({}));
            return res.status(502).json({ error: 'Failed to create session for inquiry', inquiryId });
        }

        const resumeData = await resumeResponse.json();
        const sessionToken = resumeData.meta?.['session-token'];

        if (!sessionToken) {
            return res.status(502).json({ error: 'Missing session token from Persona', inquiryId });
        }

        return res.json({
            inquiryId,
            sessionToken
        });
    } catch (error) {
        return res.status(500).json({ error: 'Internal error' });
    }
});

app.get('/internal/persona/most-recent-inquiry', internalAuthMiddleware, async (req, res) => {
    const userId = req.query._id || req.query.userId || req.query.referenceId;
    if (!userId) {
        return res.status(400).json({
            error: '_id, userId, or referenceId query parameter is required'
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
            return res.status(500).json({
                error: 'Database query failed'
            });
        }
        if (!inquiry) {
            return res.status(404).json({
                status: "NOT_FOUND",
                inquiryId: null,
                failureReasons: [],
                latestFailureReasons: [],
                remainingAttempts: null,
                createdAt: null
            });
        }

        if (!isTerminalPersonaStatus(inquiry.status)) {
            const refreshed = await refreshVerificationFromPersona(inquiry);
            if (refreshed) {
                inquiry = refreshed;
            }
        }
        const status = inquiry.status
            ? inquiry.status.replace('inquiry.', '').toUpperCase()
            : "UNKNOWN";

        return res.json({
            status,
            inquiryId: inquiry.inquiry_id,
            failureReasons: inquiry.failure_reasons || [],
            latestFailureReasons: inquiry.latest_failure_reasons || [],
            remainingAttempts: inquiry.remaining_attempts ?? null,
            createdAt: inquiry.created_at
        });
    } catch (err) {
        return res.status(500).json({
            error: 'Failed to fetch most recent inquiry'
        });
    }
});

app.get('/internal/worker/verifications', internalAuthMiddleware, async (req, res) => {
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
            return res.status(500).json({
                error: 'Database query failed'
            });
        }

        if (verifications && verifications.length > 0) {
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
        return res.status(502).json({
            error: 'Unable to fetch verifications'
        });
    }
});

app.get('/health', (req, res) => {
    res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

app.post('/api/start-verification', startVerificationRateLimiter, async (req, res) => {
    const { referenceId, userId, redirectUri } = req.body;
    const origin = req.headers.origin || req.headers.referer || 'https://app.outlier.ai';

    const result = await startVerificationForUser({
        referenceId,
        userId,
        redirectUri: redirectUri || 'https://altropa.onrender.com/redirect',
        origin
    });
    return res.status(result.httpStatus).json(result.body);
});

app.get('/redirect', async (req, res) => {
    const inquiryId = req.query["inquiry-id"];
    const referenceId = req.query["reference-id"];
    const subject = req.query.subject;
    const status = req.query.status;

    if (!inquiryId) {
        return res.status(400).json({ error: 'Missing inquiry-id' });
    }

    try {
        const { data: verification, error } = await supabase
            .from('verifications')
            .select('origin, redirect_uri, user_id')
            .eq('inquiry_id', inquiryId)
            .maybeSingle();

        if (error) {}
        if (verification) {
            await supabase
                .from('verifications')
                .update({
                    status: status,
                    verification_status: status === 'approved' || status === 'completed' ? 'verified' : null,
                    updated_at: new Date().toISOString()
                })
                .eq('inquiry_id', inquiryId);
        }
        let redirectUrl = 'https://app.outlier.ai';

        if (verification?.origin) {
            redirectUrl = verification.origin;
        } else if (process.env.CLIENT_REDIRECT_URL) {
            redirectUrl = process.env.CLIENT_REDIRECT_URL + `?inquiryId=${inquiryId}&status=${status}`;
        }

        return res.redirect(redirectUrl);
    } catch (err) {
        return res.redirect('https://app.outlier.ai');
    }
});

app.post('/api/webhook', async (req, res) => {
    const rawBody = req.rawBody;

    if (!verifyWebhookSignature(req, rawBody)) {
        return res.status(401).json({
            error: 'Invalid signature'
        });
    }

    const body = req.body;

    logUsage({
        endpoint: '/api/webhook',
        eventType: body.type
    });

    const inquiryPayload = body.data?.attributes?.payload?.data;
    const inquiryId = inquiryPayload?.id;
    const attributes = inquiryPayload?.attributes || {};
    const status = attributes.status;
    const referenceId = attributes['reference-id'];
    const verificationStatus = attributes['verification-status'];
    const accountId = inquiryPayload?.relationships?.account?.data?.id;

    if (!inquiryId) {
        return res.status(400).json({
            error: "Missing inquiry ID"
        });
    }

    try {
        const { data: existingVerification } = await supabase
            .from('verifications')
            .select('user_id, reference_id, persona_account_id, status, verification_status')
            .eq('inquiry_id', inquiryId)
            .maybeSingle();

        const existingStatus = existingVerification?.status;
        const incomingIsStale = existingStatus && isTerminalPersonaStatus(existingStatus) && !isTerminalPersonaStatus(status);

        if (incomingIsStale) {}

        const updateData = {
            inquiry_id: inquiryId,
            reference_id: existingVerification?.reference_id || referenceId,
            user_id: existingVerification?.user_id || null,
            status: incomingIsStale ? existingStatus : status,
            verification_status: incomingIsStale ? (existingVerification?.verification_status ?? null) : (verificationStatus || null),
            persona_account_id: accountId || existingVerification?.persona_account_id || null,
            webhook_data: body,
            updated_at: new Date().toISOString()
        };

        const { error } = await supabase
            .from('verifications')
            .upsert(updateData, {
                onConflict: 'inquiry_id'
            });

        if (error) {
            return res.status(500).json({
                error: "Database update failed"
            });
        }

        return res.json({
            success: true,
            inquiryId,
            accountId,
            status
        });
    } catch(err) {
        return res.status(500).json({
            error: "Webhook processing failed"
        });
    }
});

app.get('/logs', internalAuthMiddleware, (req, res) => {
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
    console.log(`Webhook URL: https://altropa.onrender.com/api/webhook`);
});