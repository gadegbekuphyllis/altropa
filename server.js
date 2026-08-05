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

app.get('/internal/worker/verifications', async (req, res) => {
    const userId = req.query._id;
    if (!userId) {
        return res.status(400).json({ error: 'Missing _id parameter' });
    }

    try {
        const { data: verifications, error } = await supabase
            .from('verifications')
            .select('*')
            .eq('user_id', userId)
            .order('created_at', { ascending: false });

        if (error) {
            console.error('Supabase query error:', error);
            return res.status(500).json({ error: 'Database query failed' });
        }

        if (verifications && verifications.length > 0) {
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

            return res.json({ userVerifications });
        }

        res.json({ userVerifications: [] });

    } catch (err) {
        console.error('Worker verifications error:', err); 
        res.status(502).json({
            error: 'Unable to fetch verifications'
        });
    }
});

app.get('/health', (req, res) => 

    { res.json({ status: 'ok', timestamp: new Date().toISOString() }); 

});

app.post('/api/start-verification', async (req, res) => {
    const { referenceId, userId, redirectUri } = req.body;

    if (!referenceId || !userId || !redirectUri) {
        return res.status(400).json({
            error: 'referenceId, userId and redirectUri are required'
        });
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

        const flowUrl =
            inquiry.meta?.['one-time-link'];


        if (!inquiryId) {
            console.error(
                "Missing inquiry ID:",
                inquiry
            );

            return res.status(500).json({
                error: 'Missing inquiry ID from Persona'
            });
        }


        if (!flowUrl) {
            console.error(
                "Missing flow URL:",
                inquiry
            );

            return res.status(500).json({
                error: 'Missing flow URL from Persona',
                inquiryId
            });
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
            console.error(
                'Supabase insert error:',
                insertError
            );
        }


        return res.json({
            success: true,
            userId,
            inquiryId,
            referenceId,
            flowUrl
        });


    } catch (err) {

        console.error(
            'Error starting verification:',
            err
        );

        return res.status(502).json({
            error: 'Failed to start verification',
            details: err.body || err.message
        });
    }
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

    const inquiryId = body.data?.id;
    const status = body.data?.attributes?.status;
    const referenceId = body.data?.attributes?.['reference-id'];
    const verificationStatus =
        body.data?.attributes?.['verification-status'];

    const accountId =
        body.data?.relationships?.account?.data?.id;

    if (!inquiryId) {
        return res.status(400).json({
            error: 'Missing inquiry ID'
        });
    }

    try {

        console.log(
            `Verification ${status} for inquiry ${inquiryId}`
        );

        const { data: existingVerification } = await supabase
            .from('verifications')
            .select('user_id')
            .eq('inquiry_id', inquiryId)
            .single();


        const { error: upsertError } = await supabase
            .from('verifications')
            .upsert({
                inquiry_id: inquiryId,
                reference_id: referenceId,
                user_id: existingVerification?.user_id || null,
                status: status,
                verification_status: verificationStatus,
                persona_account_id: accountId,
                webhook_data: body,
                updated_at: new Date().toISOString()
            }, {
                onConflict: 'inquiry_id'
            });


        if (upsertError) {
            console.error(
                'Supabase upsert error:',
                upsertError
            );
        }


        return res.json({
            success:true,
            message:'Webhook received'
        });


    } catch(err) {

        console.error(
            'Webhook processing error:',
            err
        );

        return res.status(500).json({
            error:'Webhook processing failed'
        });
    }
});

app.get('/api/verification-status', async (req, res) => {
    const userId = req.query._id;

    if (!userId) {
        return res.status(400).json({ error: '_id parameter is required' });
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
            return res.status(500).json({ error: 'Database query failed' });
        }

        if (verifications && verifications.length > 0) {
            const verification = verifications[0];
            
            if (verification.status !== 'created') {
                return res.json({
                    _id: verification.user_id,
                    referenceId: verification.reference_id,
                    status: verification.status,
                    verificationStatus: verification.verification_status,
                    completedAt: verification.updated_at,
                    verified: verification.status === 'approved' || verification.status === 'completed'
                });
            }

            const options = {
                hostname: 'api.withpersona.com',
                path: '/api/v1/inquiries/' + verification.inquiry_id,
                method: 'GET',
                headers: {
                    'Authorization': 'Bearer ' + PERSONA_API_KEY,
                    'Persona-Version': '2023-01-01'
                }
            };

            const response = await new Promise((resolve, reject) => {
                const req = https.request(options, (res) => {
                    let body = '';
                    res.on('data', (chunk) => body += chunk);
                    res.on('end', () => resolve({ statusCode: res.statusCode, body }));
                    res.on('error', reject);
                });
                req.on('error', reject);
                req.end();
            });

            if (response.statusCode !== 200) {
                return res.status(response.statusCode).json({
                    error: 'Persona API error',
                    details: response.body
                });
            }

            const parsed = JSON.parse(response.body);
            const inquiry = parsed.data;
            const status = inquiry.attributes?.status || 'unknown';
            const inquiryVerificationStatus = inquiry.attributes?.['verification-status'] || null;

            const { error: updateError } = await supabase
                .from('verifications')
                .update({
                    status: status,
                    verification_status: inquiryVerificationStatus,
                    updated_at: new Date().toISOString()
                })
                .eq('id', verification.id);

            if (updateError) {
                console.error('Supabase update error:', updateError);
            }

            return res.json({
                _id: verification.user_id,
                referenceId: verification.reference_id,
                status: status,
                verificationStatus: inquiryVerificationStatus,
                verified: status === 'approved' || status === 'completed' || inquiryVerificationStatus === 'verified'
            });
        }

        return res.status(404).json({ error: 'No verification found' });

    } catch (err) {
        console.error('Error checking status:', err);
        res.status(500).json({
            error: 'Failed to check verification status'
        });
    }
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