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

app.use((req, res, next) => {
    res.setHeader('Content-Encoding', 'identity');
    res.setHeader('Content-Type', 'application/json');
    next();
});

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
    if (!inquiryState[inquiryId]) {
        inquiryState[inquiryId] = {
            created: false,
            countrySelected: false,
            idUploaded: false,
            selfieVerified: false,
            completed: false
        };
    }
    return inquiryState[inquiryId];
}

function isVerificationComplete(inquiryId) {
    const state = getInquiryState(inquiryId);
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
        const state = getInquiryState(inquiryId);
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
            } else {
                // Keep as 'created' or 'pending' if not complete
                if (data.data.attributes.status === 'pending') {
                    // Keep pending
                }
            }
        }
        if (data?.data && Array.isArray(data.data)) {
            data.data.forEach(item => {
                if (item?.attributes) {
                    if (complete) {
                        item.attributes.status = 'COMPLETED';
                        item.attributes['verification-status'] = 'verified';
                        item.attributes.failureReasons = [];
                        item.attributes.latestFailureReasons = [];
                        item.attributes.remainingAttempts = 3;
                    }
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
    const inquiryId = req.params.id;
    logUsage({ endpoint: `/api/v1/inquiries/${inquiryId}` });
    
    const state = getInquiryState(inquiryId);
    const complete = isVerificationComplete(inquiryId);
    
    res.json({
        data: {
            type: "inquiry",
            id: inquiryId,
            attributes: {
                status: complete ? "COMPLETED" : "created",
                "verification-status": complete ? "verified" : "pending",
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
    
    // Initialize state for new inquiry
    getInquiryState(newId);
    
    res.json({
        data: {
            type: "inquiry",
            id: newId,
            attributes: {
                status: "created",
                "verification-status": "pending",
                failureReasons: [],
                latestFailureReasons: [],
                remainingAttempts: 3
            }
        }
    });
});

app.patch('/api/v1/inquiries/:id', (req, res) => {
    const inquiryId = req.params.id;
    logUsage({ endpoint: `/api/v1/inquiries/${inquiryId}`, method: 'PATCH' });
    
    const state = getInquiryState(inquiryId);
    
    // Track country selection
    if (req.body?.data?.attributes?.fields?.selected_country_code) {
        state.countrySelected = true;
        logUsage({ endpoint: '/inquiries/patch', action: 'country_selected', inquiryId });
    }
    
    const complete = isVerificationComplete(inquiryId);
    
    res.json({
        data: {
            type: "inquiry",
            id: inquiryId,
            attributes: {
                status: complete ? "COMPLETED" : "created",
                "verification-status": complete ? "verified" : "pending",
                failureReasons: [],
                latestFailureReasons: [],
                remainingAttempts: 3
            }
        }
    });
});

app.post('/api/v1/documents', (req, res) => {
    const inquiryId = req.body?.data?.attributes?.inquiry_id || getInquiryId(req);
    logUsage({ endpoint: '/api/v1/documents', inquiryId });
    
    if (inquiryId) {
        const state = getInquiryState(inquiryId);
        state.idUploaded = true;
        logUsage({ endpoint: '/documents', action: 'id_uploaded', inquiryId });
    }
    
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
    const inquiryId = req.body?.data?.attributes?.inquiry_id || getInquiryId(req);
    logUsage({ endpoint: '/api/v1/selfies', inquiryId });
    
    if (inquiryId) {
        const state = getInquiryState(inquiryId);
        state.selfieVerified = true;
        logUsage({ endpoint: '/selfies', action: 'selfie_verified', inquiryId });
    }
    
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
    const inquiryId = req.body?.data?.attributes?.inquiry_id || getInquiryId(req);
    logUsage({ endpoint: '/api/v1/verifications', inquiryId });
    
    if (inquiryId) {
        const state = getInquiryState(inquiryId);
        state.selfieVerified = true;
        logUsage({ endpoint: '/verifications', action: 'verification_completed', inquiryId });
    }
    
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