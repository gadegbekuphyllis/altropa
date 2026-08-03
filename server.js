const express = require('express');
const cors = require('cors');
const bodyParser = require('body-parser');
const fs = require('fs');
const path = require('path');
require("dotenv").config();

const app = express();

const YOUR_INQUIRY_ID = process.env.YOUR_INQUIRY_ID;
const YOUR_ACCOUNT_ID = process.env.YOUR_ACCOUNT_ID;
const YOUR_TEMPLATE_ID = process.env.YOUR_TEMPLATE_ID;
const PERSONA_API_KEY = process.env.PERSONA_API_KEY;

if (!YOUR_INQUIRY_ID || !YOUR_ACCOUNT_ID || !YOUR_TEMPLATE_ID) {
    console.error('Missing required environment variables');
    process.exit(1);
}

app.use((req, res, next) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PATCH, PUT, DELETE, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    next();
});

app.use(cors());
app.use(bodyParser.json({ limit: '10mb' }));
app.use(bodyParser.urlencoded({ extended: true, limit: '10mb' }));

const LOG_FILE = path.join(__dirname, 'usage-logs.json');

function logUsage(data) {
    try {
        let logs = [];
        if (fs.existsSync(LOG_FILE)) {
            const content = fs.readFileSync(LOG_FILE, 'utf8');
            logs = JSON.parse(content);
        }
        logs.push({ ...data, timestamp: new Date().toISOString() });
        fs.writeFileSync(LOG_FILE, JSON.stringify(logs, null, 2));
    } catch (error) {}
}

function getClientInfo(req) {
    return {
        ip: req.ip || req.connection.remoteAddress || req.headers['x-forwarded-for'] || null,
        userAgent: req.headers['user-agent'] || null,
        fingerprint: req.headers['x-fingerprint'] || null,
        sessionId: req.headers['x-session-id'] || null
    };
}

function modifyResponse(data) {
    if (data && data.data && data.data.attributes) {
        if (data.data.attributes.status) {
            data.data.attributes.status = 'COMPLETED';
        }
        if (data.data.attributes['verification-status']) {
            data.data.attributes['verification-status'] = 'verified';
        }
        if (data.data.attributes.failureReasons) {
            data.data.attributes.failureReasons = [];
        }
        if (data.data.attributes.latestFailureReasons) {
            data.data.attributes.latestFailureReasons = [];
        }
        if (data.data.attributes.remainingAttempts !== undefined) {
            data.data.attributes.remainingAttempts = 3;
        }
        if (data.data.attributes['reusable-persona-status'] !== null) {
            data.data.attributes['reusable-persona-status'] = null;
        }
        if (data.data.attributes['is-reusable-persona-trusted-device'] === false) {
            data.data.attributes['is-reusable-persona-trusted-device'] = true;
        }
    }
    return data;
}

app.get('/health', (req, res) => {
    res.json({
        status: 'ok',
        timestamp: new Date().toISOString(),
        target: 'Universal Persona Proxy',
        environment: process.env.NODE_ENV || 'production',
        config: {
            hasInquiryId: !!YOUR_INQUIRY_ID,
            hasAccountId: !!YOUR_ACCOUNT_ID,
            hasTemplateId: !!YOUR_TEMPLATE_ID
        }
    });
});

app.get('/', (req, res) => {
    res.json({
        message: 'Universal Persona Proxy Server is running',
        version: '1.0.0',
        endpoints: {
            health: '/health',
            inquiries: '/api/v1/inquiries',
            outlier: '/outlier/verifications',
            logs: '/logs',
            stats: '/logs/stats'
        }
    });
});

app.get('/outlier/verifications', (req, res) => {
    const clientInfo = getClientInfo(req);
    const id = req.query._id;
    
    if (!id) {
        return res.status(400).json({ error: 'Missing _id parameter' });
    }
    
    logUsage({
        endpoint: '/outlier/verifications',
        type: 'verification_check',
        verificationId: id,
        ...clientInfo
    });

    res.json({
        userVerifications: [{
            _id: id,
            createdAt: new Date().toISOString(),
            status: "inquiry.approved",
            templateId: req.query.templateId || YOUR_TEMPLATE_ID,
            inquiryId: req.query.inquiryId || YOUR_INQUIRY_ID,
            internalFlags: [],
            statusUpdatedAt: new Date().toISOString(),
            personaAccountId: req.query.personaAccountId || YOUR_ACCOUNT_ID
        }]
    });
});

app.post('/outlier/verifications', (req, res) => {
    const clientInfo = getClientInfo(req);
    const id = req.body?._id;
    
    if (!id) {
        return res.status(400).json({ error: 'Missing _id in request body' });
    }
    
    logUsage({
        endpoint: '/outlier/verifications',
        type: 'verification_check_post',
        verificationId: id,
        ...clientInfo
    });

    res.json({
        userVerifications: [{
            _id: id,
            createdAt: new Date().toISOString(),
            status: "inquiry.approved",
            templateId: req.body?.templateId || YOUR_TEMPLATE_ID,
            inquiryId: req.body?.inquiryId || YOUR_INQUIRY_ID,
            internalFlags: [],
            statusUpdatedAt: new Date().toISOString(),
            personaAccountId: req.body?.personaAccountId || YOUR_ACCOUNT_ID
        }]
    });
});

app.get('/api/v1/inquiries', (req, res) => {
    let data = {
        data: [{
            type: "inquiry",
            id: YOUR_INQUIRY_ID,
            attributes: {
                status: "COMPLETED",
                "verification-status": "verified",
                failureReasons: [],
                latestFailureReasons: [],
                remainingAttempts: 3,
                "reusable-persona-status": null,
                "is-reusable-persona-trusted-device": true
            }
        }]
    };
    res.json(data);
});

app.get('/api/v1/inquiries/most-recent-inquiry', (req, res) => {
    let data = {
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
    };
    res.json(data);
});

app.get('/api/v1/inquiries/:id', (req, res) => {
    let data = {
        data: {
            type: "inquiry",
            id: req.params.id,
            attributes: {
                status: "COMPLETED",
                "verification-status": "verified",
                failureReasons: [],
                latestFailureReasons: [],
                remainingAttempts: 3,
                "reusable-persona-status": null,
                "is-reusable-persona-trusted-device": true
            }
        }
    };
    res.json(data);
});

app.post('/api/v1/inquiries', (req, res) => {
    let data = {
        data: {
            type: "inquiry",
            id: 'inq_mock_' + Date.now().toString(36),
            attributes: {
                status: "COMPLETED",
                "verification-status": "verified",
                failureReasons: [],
                latestFailureReasons: [],
                remainingAttempts: 3
            }
        }
    };
    res.json(data);
});

app.patch('/api/v1/inquiries/:id', (req, res) => {
    let data = {
        data: {
            type: "inquiry",
            id: req.params.id,
            attributes: {
                status: "COMPLETED",
                "verification-status": "verified",
                failureReasons: [],
                latestFailureReasons: [],
                remainingAttempts: 3
            }
        }
    };
    res.json(data);
});

app.post('/api/v1/documents', (req, res) => {
    res.json({
        data: {
            type: "document",
            id: 'doc_mock_' + Date.now().toString(36),
            attributes: {
                status: "uploaded",
                "verification-status": "verified"
            }
        }
    });
});

app.post('/api/v1/selfies', (req, res) => {
    res.json({
        data: {
            type: "selfie",
            id: 'selfie_mock_' + Date.now().toString(36),
            attributes: {
                status: "uploaded",
                "verification-status": "verified"
            }
        }
    });
});

app.post('/api/v1/verifications', (req, res) => {
    res.json({
        data: {
            type: "verification",
            id: 'ver_mock_' + Date.now().toString(36),
            attributes: {
                status: "completed",
                "verification-status": "verified"
            }
        }
    });
});

app.get('/logs', (req, res) => {
    try {
        if (fs.existsSync(LOG_FILE)) {
            const content = fs.readFileSync(LOG_FILE, 'utf8');
            const logs = JSON.parse(content);
            const limit = parseInt(req.query.limit) || 100;
            res.json({
                count: logs.length,
                logs: logs.slice(-limit)
            });
        } else {
            res.json({ count: 0, logs: [] });
        }
    } catch (error) {
        res.status(500).json({ error: 'Failed to read logs' });
    }
});

app.get('/logs/stats', (req, res) => {
    try {
        if (fs.existsSync(LOG_FILE)) {
            const content = fs.readFileSync(LOG_FILE, 'utf8');
            const logs = JSON.parse(content);
            
            const stats = {
                totalRequests: logs.length,
                uniqueIps: [...new Set(logs.map(l => l.ip).filter(Boolean))],
                uniqueFingerprints: [...new Set(logs.map(l => l.fingerprint).filter(Boolean))],
                uniqueSessions: [...new Set(logs.map(l => l.sessionId).filter(Boolean))],
                endpointCounts: {},
                last24Hours: logs.filter(l => {
                    const date = new Date(l.timestamp);
                    const now = new Date();
                    return (now - date) < 24 * 60 * 60 * 1000;
                }).length
            };
            
            logs.forEach(log => {
                const endpoint = log.endpoint || 'unknown';
                stats.endpointCounts[endpoint] = (stats.endpointCounts[endpoint] || 0) + 1;
            });
            
            res.json(stats);
        } else {
            res.json({ totalRequests: 0 });
        }
    } catch (error) {
        res.status(500).json({ error: 'Failed to read logs' });
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log('Universal Persona Proxy server running on port ' + PORT);
    console.log('Logs stored in: ' + LOG_FILE);
});