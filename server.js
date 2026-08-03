const express = require('express');
const cors = require('cors');
const bodyParser = require('body-parser');
const https = require('https');
const zlib = require('zlib');
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
const documentUploaded = {};

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

function decompressResponse(proxyRes) {
    return new Promise((resolve, reject) => {
        const chunks = [];
        const encoding = proxyRes.headers['content-encoding'];
        
        proxyRes.on('data', (chunk) => chunks.push(chunk));
        proxyRes.on('end', () => {
            const buffer = Buffer.concat(chunks);
            if (encoding && encoding.includes('gzip')) {
                zlib.gunzip(buffer, (err, decoded) => {
                    if (err) reject(err);
                    else resolve(decoded.toString('utf8'));
                });
            } else {
                resolve(buffer.toString('utf8'));
            }
        });
        proxyRes.on('error', reject);
    });
}

function getTargetHost(req) {
    const host = req.headers['host'] || req.headers['x-forwarded-host'];
    if (host) {
        return host;
    }
    return 'api.withpersona.com';
}

function getInquiryId(req) {
    const match = req.url.match(/\/inquiries\/([^\/?]+)/);
    if (match) return match[1];
    if (req.body?.data?.id) return req.body.data.id;
    if (req.body?.data?.attributes?.inquiry_id) return req.body.data.attributes.inquiry_id;
    if (req.body?.data?.attributes?.inquiry) return req.body.data.attributes.inquiry;
    return null;
}

function modifyResponseData(data, inquiryId) {
    try {
        if (data && data.data) {
            if (Array.isArray(data.data)) {
                data.data.forEach(item => {
                    if (item?.attributes) {
                        if (item.attributes.status === 'created' || item.attributes.status === 'pending') {
                            item.attributes.status = 'COMPLETED';
                        }
                        if (item.attributes['verification-status'] === 'pending' || !item.attributes['verification-status']) {
                            item.attributes['verification-status'] = 'verified';
                        }
                        if (item.attributes.failureReasons) {
                            item.attributes.failureReasons = [];
                        }
                        if (item.attributes.latestFailureReasons) {
                            item.attributes.latestFailureReasons = [];
                        }
                        if (item.attributes.remainingAttempts !== undefined) {
                            item.attributes.remainingAttempts = 3;
                        }
                        if (item.attributes['reusable-persona-status'] !== null) {
                            item.attributes['reusable-persona-status'] = null;
                        }
                        if (item.attributes['is-reusable-persona-trusted-device'] === false) {
                            item.attributes['is-reusable-persona-trusted-device'] = true;
                        }
                    }
                });
            } else if (data.data.attributes) {
                if (data.data.attributes.status === 'created' || data.data.attributes.status === 'pending') {
                    data.data.attributes.status = 'COMPLETED';
                }
                if (data.data.attributes['verification-status'] === 'pending' || !data.data.attributes['verification-status']) {
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
        }
        return data;
    } catch (e) {
        return data;
    }
}

app.get('/health', (req, res) => {
    res.json({
        status: 'ok',
        timestamp: new Date().toISOString(),
        target: 'Universal Persona Proxy - Real API Forwarding',
        environment: process.env.NODE_ENV || 'production'
    });
});

app.get('/', (req, res) => {
    res.json({
        message: 'Universal Persona Proxy Server is running',
        version: '1.0.0',
        endpoints: {
            health: '/health',
            proxy: '/*'
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

app.all('*', async (req, res) => {
    if (req.path === '/health' || req.path === '/outlier/verifications') {
        return;
    }

    const targetHost = getTargetHost(req);
    const inquiryId = getInquiryId(req);

    if ((req.url.includes('/documents') || req.url.includes('/uploads')) && inquiryId) {
        documentUploaded[inquiryId] = true;
        const clientInfo = getClientInfo(req);
        logUsage({
            endpoint: req.url,
            type: 'document_upload',
            inquiryId: inquiryId,
            ...clientInfo
        });
    }

    const options = {
        method: req.method,
        headers: {
            ...req.headers,
            host: targetHost,
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
            'Accept-Encoding': 'identity'
        },
        hostname: targetHost,
        path: req.url,
        port: 443,
        rejectUnauthorized: false
    };
    
    try {
        const proxyReq = https.request(options, async (proxyRes) => {
            try {
                let responseBody = await decompressResponse(proxyRes);
                let modifiedBody = responseBody;
                let statusCode = proxyRes.statusCode;
                let contentType = proxyRes.headers['content-type'] || 'application/json';
                
                try {
                    if (responseBody) {
                        const data = JSON.parse(responseBody);
                        let id = inquiryId;
                        if (!id && data?.data?.id) {
                            id = data.data.id;
                        }
                        
                        const modifiedData = modifyResponseData(data, id);
                        modifiedBody = JSON.stringify(modifiedData);
                    }
                } catch (e) {}
                
                res.status(statusCode);
                res.setHeader('Content-Type', contentType);
                res.setHeader('Content-Encoding', 'identity');
                res.end(modifiedBody);
            } catch (err) {
                res.status(500).json({ error: 'Proxy error: ' + err.message });
            }
        });
        
        proxyReq.on('error', (err) => {
            res.status(500).json({ error: 'Proxy error: ' + err.message });
        });
        
        if (req.body && Object.keys(req.body).length > 0) {
            proxyReq.write(JSON.stringify(req.body));
        }
        
        proxyReq.end();
    } catch (err) {
        res.status(500).json({ error: 'Proxy error: ' + err.message });
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log('Universal Persona Proxy server running on port ' + PORT);
    console.log('Forwarding to real Persona API and modifying responses');
});