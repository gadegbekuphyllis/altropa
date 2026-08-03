const express = require('express');
const { createProxyMiddleware } = require('http-proxy-middleware');
const cors = require('cors');

const app = express();
app.use(cors());

let documentUploaded = false;

function modifyInquiryConfig(rawJson) {
    if (!rawJson) return rawJson;
    try {
        const data = JSON.parse(rawJson);
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
            return JSON.stringify(data);
        }
        return rawJson;
    } catch {
        return rawJson;
    }
}

app.use('/', createProxyMiddleware({
    target: 'https://api.withpersona.com',
    changeOrigin: true,
    onProxyReq: (proxyReq, req, res) => {
        if ((req.method === 'POST' || req.method === 'PATCH') && 
            (req.url.includes('document') || req.url.includes('verification') || req.url.includes('upload'))) {
            documentUploaded = true;
        }
    },
    onProxyRes: (proxyRes, req, res) => {
        let responseBody = '';
        const originalWrite = res.write;
        const originalEnd = res.end;
        
        res.write = function(chunk) {
            responseBody += chunk;
            originalWrite.call(res, chunk);
        };
        
        res.end = function(chunk) {
            if (chunk) responseBody += chunk;
            if (responseBody) {
                try {
                    if (req.url.includes('most-recent-inquiry')) {
                        const data = JSON.parse(responseBody);
                        if (documentUploaded && data.status !== 'verified') {
                            data.status = 'COMPLETED';
                            data.verificationStatus = 'verified';
                            data.failureReasons = [];
                            data.latestFailureReasons = [];
                            data.remainingAttempts = 3;
                            responseBody = JSON.stringify(data);
                        }
                    }
                    else if (req.url.includes('/api/') || req.url.includes('inquir') || req.url.includes('verification')) {
                        const data = JSON.parse(responseBody);
                        if (data?.data?.attributes?.config?.idclasses) {
                            responseBody = modifyInquiryConfig(responseBody);
                        }
                        if (data?.data?.attributes) {
                            let modified = false;
                            const attributes = data.data.attributes;
                            if (attributes['reusable-persona-status'] !== null) {
                                attributes['reusable-persona-status'] = null;
                                modified = true;
                            }
                            if (attributes['is-reusable-persona-trusted-device'] === false) {
                                attributes['is-reusable-persona-trusted-device'] = true;
                                modified = true;
                            }
                            if (modified && !req.url.includes('config')) {
                                responseBody = JSON.stringify(data);
                            }
                        }
                    }
                    else if (req.url.includes('newsfeed')) {
                        const data = JSON.parse(responseBody);
                        if (data?.response?.[0]?.messageData) {
                            const messageMap = data.response[0].messageData;
                            Object.keys(messageMap).forEach((key) => {
                                if (messageMap[key]?.vars?.Title?.value?.includes("Verification not accepted")) {
                                    delete messageMap[key];
                                }
                            });
                            responseBody = JSON.stringify(data);
                        }
                    }
                } catch {}
            }
            if (responseBody) {
                originalEnd.call(res, responseBody);
            } else {
                originalEnd.call(res);
            }
        };
    }
}));

app.listen(3000, () => {
    console.log('Server running on http://localhost:3000');
});
