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

function modifyResponse(body) {
    try {
        const data = JSON.parse(body);
        if (data?.data?.attributes) {
            data.data.attributes.status = 'COMPLETED';
            data.data.attributes['verification-status'] = 'verified';
            data.data.attributes.failureReasons = [];
            data.data.attributes.latestFailureReasons = [];
            data.data.attributes.remainingAttempts = 3;
            data.data.attributes['reusable-persona-status'] = null;
            data.data.attributes['is-reusable-persona-trusted-device'] = true;
        }
        if (data?.data && Array.isArray(data.data)) {
            data.data.forEach(item => {
                if (item?.attributes) {
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
    logUsage({ endpoint: req.url, method: req.method });

    const options = {
        hostname: 'api.withpersona.com',
        path: req.url,
        method: req.method,
        headers: {
            ...req.headers,
            host: 'api.withpersona.com',
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
        },
        rejectUnauthorized: false,
        secureOptions: require('constants').SSL_OP_NO_TLSv1_2,
        ciphers: 'DEFAULT@SECLEVEL=1'
    };

    try {
        const proxyReq = https.request(options, (proxyRes) => {
            let body = '';
            proxyRes.on('data', (chunk) => body += chunk);
            proxyRes.on('end', () => {
                const modified = modifyResponse(body);
                res.status(200);
                res.setHeader('Content-Type', 'application/json');
                res.end(modified);
            });
        });

        proxyReq.on('error', (err) => {
            res.status(200).json({
                data: {
                    type: "inquiry",
                    id: YOUR_INQUIRY_ID,
                    attributes: {
                        status: "COMPLETED",
                        "verification-status": "verified",
                        failureReasons: [],
                        latestFailureReasons: [],
                        remainingAttempts: 3
                    }
                }
            });
        });

        proxyReq.on('timeout', () => {
            proxyReq.destroy();
            res.status(200).json({
                data: {
                    type: "inquiry",
                    id: YOUR_INQUIRY_ID,
                    attributes: {
                        status: "COMPLETED",
                        "verification-status": "verified",
                        failureReasons: [],
                        latestFailureReasons: [],
                        remainingAttempts: 3
                    }
                }
            });
        });

        if (req.body && Object.keys(req.body).length > 0) {
            proxyReq.write(JSON.stringify(req.body));
        }
        proxyReq.end();

    } catch (e) {
        res.status(200).json({
            data: {
                type: "inquiry",
                id: YOUR_INQUIRY_ID,
                attributes: {
                    status: "COMPLETED",
                    "verification-status": "verified",
                    failureReasons: [],
                    latestFailureReasons: [],
                    remainingAttempts: 3
                }
            }
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
    console.log(`Proxy running on port ${PORT}`);
});