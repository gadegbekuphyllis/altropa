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

app.get('/api/v1/inquiries', (req, res) => {
    logUsage({ endpoint: '/api/v1/inquiries', method: 'GET' });
    res.json({
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
    });
});

app.get('/api/v1/inquiries/most-recent-inquiry', (req, res) => {
    logUsage({ endpoint: '/api/v1/inquiries/most-recent-inquiry' });
    res.json({
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

app.get('/api/v1/inquiries/:id', (req, res) => {
    logUsage({ endpoint: `/api/v1/inquiries/${req.params.id}` });
    res.json({
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
    });
});

app.post('/api/v1/inquiries', (req, res) => {
    logUsage({ endpoint: '/api/v1/inquiries', method: 'POST' });
    const newId = 'inq_mock_' + Date.now().toString(36);
    res.json({
        data: {
            type: "inquiry",
            id: newId,
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

app.patch('/api/v1/inquiries/:id', (req, res) => {
    logUsage({ endpoint: `/api/v1/inquiries/${req.params.id}`, method: 'PATCH' });
    res.json({
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
    });
});

app.post('/api/v1/documents', (req, res) => {
    logUsage({ endpoint: '/api/v1/documents' });
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
    logUsage({ endpoint: '/api/v1/selfies' });
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
    logUsage({ endpoint: '/api/v1/verifications' });
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