const express = require('express');
const cors = require('cors');
const bodyParser = require('body-parser');
const https = require('https');
const fs = require('fs');
const path = require('path');
require("dotenv").config();

const app = express();

const YOUR_INQUIRY_ID = process.env.YOUR_INQUIRY_ID;
const YOUR_ACCOUNT_ID = process.env.YOUR_ACCOUNT_ID;
const YOUR_TEMPLATE_ID = process.env.YOUR_TEMPLATE_ID;

if (!YOUR_INQUIRY_ID || !YOUR_ACCOUNT_ID || !YOUR_TEMPLATE_ID) {
    console.error('Missing required environment variables');
    process.exit(1);
}

app.use(cors());
app.use(bodyParser.json({ limit: '10mb' }));
app.use(bodyParser.urlencoded({ extended: true }));

const LOG_FILE = path.join(__dirname, 'usage-logs.json');
const inquiryState = {};

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

function getInquiryState(inquiryId) {
    if (!inquiryId) return null;
    if (!inquiryState[inquiryId]) {
        inquiryState[inquiryId] = {
            countrySelected: false,
            idUploaded: false,
            selfieVerified: false
        };
    }
    return inquiryState[inquiryId];
}

function isVerificationComplete(inquiryId) {
    const state = getInquiryState(inquiryId);
    if (!state) return false;
    return state.countrySelected && state.idUploaded && state.selfieVerified;
}

function getInquiryId(req) {
    const match = req.url.match(/\/inquiries\/([^\/?]+)/);
    if (match) return match[1];
    if (req.body?.data?.id) return req.body.data.id;
    if (req.body?.data?.attributes?.inquiry_id) return req.body.data.attributes.inquiry_id;
    if (req.body?.data?.attributes?.inquiry) return req.body.data.attributes.inquiry;
    return null;
}

function modifyResponse(body, inquiryId) {
    try {
        const data = JSON.parse(body);
        const complete = isVerificationComplete(inquiryId);
        
        if (data?.data?.attributes) {
            if (complete) {
                data.data.attributes.status = 'COMPLETED';
                data.data.attributes['verification-status'] = 'verified';
                data.data.attributes.failureReasons = [];
                data.data.attributes.latestFailureReasons = [];
                data.data.attributes.remainingAttempts = 3;
                data.data.attributes['reusable-persona-status'] = null;
                data.data.attributes['is-reusable-persona-trusted-device'] = true;
            }
        }
        if (data?.data && Array.isArray(data.data)) {
            data.data.forEach(item => {
                if (item?.attributes && complete) {
                    item.attributes.status = 'COMPLETED';
                    item.attributes['verification-status'] = 'verified';
                    item.attributes.failureReasons = [];
                    item.attributes.latestFailureReasons = [];
                    item.attributes.remainingAttempts = 3;
                }
            });
        }
        return JSON.stringify(data);
    } catch (e) {
        return body;
    }
}

function readResponse(proxyRes) {
    return new Promise((resolve, reject) => {
        let body = '';
        proxyRes.on('data', (chunk) => body += chunk);
        proxyRes.on('end', () => resolve(body));
        proxyRes.on('error', reject);
    });
}

app.get('/health', (req, res) => {
    res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

app.get('/outlier/verifications', (req, res) => {
    const id = req.query._id || 'test123';
    logUsage({ endpoint: '/outlier/verifications', id: id });
    res.json({
        userVerifications: [{
            _id: id,
            createdAt: new Date().toISOString(),
            status: "inquiry.approved",
            templateId: YOUR_TEMPLATE_ID,
            inquiryId: YOUR_INQUIRY_ID,
            internalFlags: [],
            statusUpdatedAt: new Date().toISOString(),
            personaAccountId: YOUR_ACCOUNT_ID
        }]
    });
});

app.post('/outlier/verifications', (req, res) => {
    const id = req.body?._id || 'test123';
    logUsage({ endpoint: '/outlier/verifications', id: id });
    res.json({
        userVerifications: [{
            _id: id,
            createdAt: new Date().toISOString(),
            status: "inquiry.approved",
            templateId: YOUR_TEMPLATE_ID,
            inquiryId: YOUR_INQUIRY_ID,
            internalFlags: [],
            statusUpdatedAt: new Date().toISOString(),
            personaAccountId: YOUR_ACCOUNT_ID
        }]
    });
});

app.all('/api/*', async (req, res) => {
    const inquiryId = getInquiryId(req);
    logUsage({ endpoint: req.url, method: req.method, inquiryId });
    const requestId = Math.random().toString(36).slice(2, 8);
    console.log(`>>> REQUEST START [${requestId}] <<<`);

    const body = req.body;

    if (req.url.includes('/documents') && inquiryId) {
        const state = getInquiryState(inquiryId);
        if (state) {
            state.idUploaded = true;
            logUsage({ action: 'id_uploaded', inquiryId });
        }
    }

    if ((req.url.includes('/selfies') || req.url.includes('/verifications')) && inquiryId) {
        const state = getInquiryState(inquiryId);
        if (state) {
            state.selfieVerified = true;
            logUsage({ action: 'selfie_verified', inquiryId });
        }
    }

    if (req.url.includes('/inquiries') && req.method === 'PATCH' && body) {
        if (body?.data?.attributes?.fields?.selected_country_code) {
            const state = getInquiryState(inquiryId);
            if (state) {
                state.countrySelected = true;
                logUsage({ action: 'country_selected', inquiryId });
            }
        }
    }

    const headers = {
        'host': 'api.withpersona.com',
        'user-agent': 'Scaramouch1 Proxy/1.0',
        'accept': 'application/json',
        'accept-encoding': 'identity',
        'persona-version': '2023-01-01'
    };

    const forwardHeaders = ['authorization', 'content-type'];
    forwardHeaders.forEach(key => {
        if (req.headers[key]) {
            headers[key] = req.headers[key];
        }
    });

    let payload = null;
    if (body && Object.keys(body).length > 0) {
        payload = JSON.stringify(body);
        headers['content-length'] = Buffer.byteLength(payload);
    }

    console.log(`=== OUTGOING REQUEST [${requestId}] ===`);
    console.log('Method:', req.method);
    console.log('URL:', req.url);
    console.log('Headers:', JSON.stringify(headers, null, 2));
    if (payload) {
        console.log('Payload length:', payload.length);
        console.log('Payload:', payload);
    }

    const options = {
        hostname: 'api.withpersona.com',
        path: req.url,
        method: req.method,
        headers: headers,
        rejectUnauthorized: true
    };

    let upstreamRespondedOrErrored = false;

    try {
        const proxyReq = https.request(options, async (proxyRes) => {
            upstreamRespondedOrErrored = true;
            console.log(`=== UPSTREAM RESPONSE [${requestId}] ===`, proxyRes.statusCode);
            const contentType = proxyRes.headers['content-type'] || '';
            const isJson = contentType.includes('json');

            try {
                let responseBody = await readResponse(proxyRes);
                let modifiedBody = responseBody;

                if (isJson && responseBody) {
                    try {
                        const parsed = JSON.parse(responseBody);
                        const modified = modifyResponse(responseBody, inquiryId);
                        if (modified !== responseBody) {
                            modifiedBody = modified;
                        }
                    } catch (parseErr) {}
                }

                res.status(proxyRes.statusCode || 200);

                Object.entries(proxyRes.headers).forEach(([key, value]) => {
                    if (key.toLowerCase() !== 'content-length' && key.toLowerCase() !== 'content-encoding') {
                        res.setHeader(key, value);
                    }
                });
                if (isJson) {
                    res.setHeader('Content-Type', 'application/json');
                }

                res.end(modifiedBody);
            } catch (err) {
                res.status(502).json({ error: 'Proxy processing error: ' + err.message });
            }
        });

        proxyReq.setTimeout(30000, () => {
            if (!upstreamRespondedOrErrored && !res.headersSent) {
                proxyReq.destroy(new Error('Request timeout'));
                res.status(504).json({ error: 'Upstream timeout' });
            }
        });

        proxyReq.on('error', (err) => {
            upstreamRespondedOrErrored = true;
            console.error(`Proxy request error [${requestId}]:`, err.message);
            logUsage({ error: err.message, stack: err.stack });
            if (!res.headersSent) {
                res.status(502).json({ error: 'Upstream error: ' + err.message });
            }
        });

        req.on('close', () => {
            if (!upstreamRespondedOrErrored && !res.headersSent) {
                console.log('Client disconnected before upstream responded - aborting');
                proxyReq.destroy();
            }
        });

        if (payload) {
            proxyReq.write(payload);
        }
        proxyReq.end();

    } catch (e) {
        logUsage({ error: e.message, stack: e.stack });
        if (!res.headersSent) {
            res.status(500).json({ error: 'Server error: ' + e.message });
        }
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
    console.log(`Proxy running on port ${PORT}`);
});