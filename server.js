const express = require('express');
const cors = require('cors');
const bodyParser = require('body-parser');
const https = require('https');
require("dotenv").config();

const app = express();

// Add security headers
app.use((req, res, next) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    next();
});

app.use(cors());
app.use(bodyParser.json({ limit: '10mb' }));
app.use(bodyParser.urlencoded({ extended: true, limit: '10mb' }));

const PERSONA_API_KEY = process.env.PERSONA_API_KEY;
function modifyInquiryResponse(data) {
    try {
        if (data && data.data) {
            if (Array.isArray(data.data)) {
                data.data.forEach(item => {
                    if (item && item.attributes) {
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
                        if (item.attributes['reusable-persona-status'] !== undefined) {
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
                if (data.data.attributes['reusable-persona-status'] !== undefined) {
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

// Health endpoint - MUST be before the proxy
app.get('/health', (req, res) => {
    res.json({
        status: 'ok',
        timestamp: new Date().toISOString(),
        target: 'https://api.withpersona.com',
        environment: process.env.NODE_ENV || 'production'
    });
});

// Root endpoint for testing
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

// Proxy all other requests
app.all('*', (req, res) => {
    // Skip if it's the health endpoint
    if (req.path === '/health') {
        return;
    }

    const options = {
        method: req.method,
        headers: {
            ...req.headers,
            host: 'api.withpersona.com',
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
        },
        hostname: 'api.withpersona.com',
        path: req.url,
        port: 443,
        rejectUnauthorized: false
    };
    
    const proxyReq = https.request(options, (proxyRes) => {
        let responseBody = '';
        
        proxyRes.on('data', (chunk) => {
            responseBody += chunk.toString();
        });
        
        proxyRes.on('end', () => {
            let modifiedBody = responseBody;
            let statusCode = proxyRes.statusCode;
            let contentType = proxyRes.headers['content-type'] || 'application/json';
            
            try {
                if (responseBody) {
                    const data = JSON.parse(responseBody);
                    if (req.url.includes('inquiry') || req.url.includes('inquiries') || req.url.includes('verification')) {
                        const modified = modifyInquiryResponse(data);
                        modifiedBody = JSON.stringify(modified);
                    }
                }
            } catch (e) {
                // Keep original if parsing fails
            }
            
            res.status(statusCode);
            res.setHeader('Content-Type', contentType);
            res.end(modifiedBody);
        });
        
        proxyRes.on('error', (err) => {
            res.status(500).json({ error: 'Proxy error: ' + err.message });
        });
    });
    
    proxyReq.on('error', (err) => {
        res.status(500).json({ error: 'Proxy error: ' + err.message });
    });
    
    if (req.body && Object.keys(req.body).length > 0) {
        proxyReq.write(JSON.stringify(req.body));
    }
    
    proxyReq.end();
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log('Proxy server running on port ' + PORT);
    console.log('Health check: /health');
});