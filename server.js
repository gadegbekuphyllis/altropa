const express = require('express');
const { createProxyMiddleware } = require('http-proxy-middleware');
const cors = require('cors');
const bodyParser = require('body-parser');
const https = require('https');
const http = require('http');

const app = express();
app.use(cors());
app.use(bodyParser.json({ limit: '10mb' }));
app.use(bodyParser.urlencoded({ extended: true, limit: '10mb' }));

let documentUploaded = false;

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

function modifyConfigResponse(data) {
    try {
        if (data?.data?.attributes?.config?.idclasses) {
            const config = data.data.attributes.config;
            config.idclasses = [
                { 'class': 'id', 'name': 'National ID', 'country-code': null, 'allow-upload': true, 'requires-device': 'desktop', 'requires-sides': ['front', 'back'] },
                { 'class': 'pp', 'name': 'Passport', 'country-code': null, 'allow-upload': true, 'requires-device': 'desktop', 'requires-sides': ['front'] },
                { 'class': 'dl', 'name': "Driver's License", 'country-code': null, 'allow-upload': true, 'requires-device': 'desktop', 'requires-sides': ['front', 'back'] }
            ];
            config['country-code'] = null;
            config['selected-country-code'] = null;
            config['selected-subdivision-code'] = null;
            config['require-country-selection'] = null;
            config['country-select-mode'] = true;
            config['field-key-country'] = null;
            config['enabled-capture-options-desktop'] = ['upload', 'mobile_camera', 'web_camera'];
            config['enabled-capture-options-mobile'] = ['upload', 'mobile_camera', 'web_camera'];
            config['enabled-capture-options-native-mobile'] = ['upload', 'web_camera'];
            config['device-handoff-enabled'] = true;
            config['device-handoff-options'] = ['email', 'sms', 'qr'];
            config['enabled-capture-file-types'] = ['image/jpg', 'image/jpeg', 'image/png', 'image/heic', 'image/heif', 'image/tiff', 'image/tif', 'application/pdf'];
            config['device-handoff-email-disabled'] = false;
            config['device-handoff-phone-number-disabled'] = false;
            config['allow-file-upload'] = true;
            config['device-handoff-list-style'] = 'none';
            config['liveness-required'] = false;
            config['require-liveness'] = false;
            config['cancel-button-enabled'] = true;
            config['back-step-enabled'] = true;
            config['web-camera-manual-capture-delay-ms'] = 0;
            config['native-mobile-camera-manual-capture-delay-ms'] = 0;
            config['barcode-camera-manual-capture-delay-ms'] = 0;
            config['image-capture-count'] = 5;
            config['govid-design-version'] = 1;
            config['disclaimer'] = 'desktop';
        }
        return data;
    } catch (e) {
        return data;
    }
}

app.all('*', (req, res) => {
    const url = 'https://api.withpersona.com' + req.url;
    const headers = { ...req.headers };
    delete headers.host;
    
    const options = {
        method: req.method,
        headers: headers,
        hostname: 'api.withpersona.com',
        path: req.url,
        port: 443
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
                    } else if (req.url.includes('config')) {
                        const modified = modifyConfigResponse(data);
                        modifiedBody = JSON.stringify(modified);
                    }
                }
            } catch (e) {
                // If parsing fails, keep original
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

app.get('/health', (req, res) => {
    res.json({
        status: 'ok',
        timestamp: new Date().toISOString(),
        target: 'https://api.withpersona.com',
        documentUploaded: documentUploaded
    });
});

const PORT = 3000;
app.listen(PORT, () => {
    console.log('Proxy server running on port ' + PORT);
});