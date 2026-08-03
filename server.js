const express = require('express');
const cors = require('cors');
const bodyParser = require('body-parser');
const https = require('https');
const zlib = require('zlib');
require("dotenv").config();

const app = express();

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

const PERSONA_API_KEY = process.env.PERSONA_API_KEY;
const inquiryState = {};

function decompressResponse(proxyRes) {
    return new Promise((resolve, reject) => {
        const chunks = [];
        const encoding = proxyRes.headers['content-encoding'];
        
        proxyRes.on('data', (chunk) => chunks.push(chunk));
        proxyRes.on('end', () => {
            const buffer = Buffer.concat(chunks);
            
            if (encoding && encoding.includes('gzip')) {
                zlib.gunzip(buffer, (err, decoded) => {
                    if (err) {
                        reject(err);
                    } else {
                        resolve(decoded.toString('utf8'));
                    }
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
                if (item?.attributes) {
                    if (isComplete) {
                        item.attributes.status = 'COMPLETED';
                        item.attributes['verification-status'] = 'verified';
                        item.attributes.failureReasons = [];
                        item.attributes.latestFailureReasons = [];
                        item.attributes.remainingAttempts = 3;
                    }
                }
            });
        } else if (data.data.attributes) {
            if (isComplete) {
                data.data.attributes.status = 'COMPLETED';
                data.data.attributes['verification-status'] = 'verified';
                data.data.attributes.failureReasons = [];
                data.data.attributes.latestFailureReasons = [];
                data.data.attributes.remainingAttempts = 3;
                data.data.attributes['reusable-persona-status'] = null;
                data.data.attributes['is-reusable-persona-trusted-device'] = true;
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
        target: 'https://api.withpersona.com',
        environment: process.env.NODE_ENV || 'production'
    });
});

app.get('/', (req, res) => {
    res.json({
        message: 'Persona Proxy Server is running',
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

    const inquiryId = getInquiryId(req);

    if (req.url.includes('/inquiries') && req.method === 'PATCH') {
        try {
            const body = JSON.parse(req.body);
            if (body?.data?.attributes?.fields?.selected_country_code) {
                if (inquiryId) {
                    if (!inquiryState[inquiryId]) inquiryState[inquiryId] = {};
                    inquiryState[inquiryId].countrySelected = true;
                }
            }
        } catch (e) {}
    }

    if (req.url.includes('/documents') || req.url.includes('/relationships/documents')) {
        if (inquiryId) {
            if (!inquiryState[inquiryId]) inquiryState[inquiryId] = {};
            inquiryState[inquiryId].idUploaded = true;
        }
    }

    if (req.url.includes('/selfies') || req.url.includes('/relationships/selfies')) {
        if (inquiryId) {
            if (!inquiryState[inquiryId]) inquiryState[inquiryId] = {};
            inquiryState[inquiryId].selfieVerified = true;
        }
    }

    const options = {
        method: req.method,
        headers: {
            ...req.headers,
            host: 'api.withpersona.com',
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
            'Accept-Encoding': 'identity'
        },
        hostname: 'api.withpersona.com',
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
    console.log('Proxy server running on port ' + PORT);
});