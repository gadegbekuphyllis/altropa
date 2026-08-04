const express = require('express');
const cors = require('cors');
const bodyParser = require('body-parser');
const https = require('https');
const fs = require('fs');
const path = require('path');
require("dotenv").config();

const app = express();

const PERSONA_API_KEY = process.env.PERSONA_API_KEY;

if (!PERSONA_API_KEY) {
    console.error('Missing PERSONA_API_KEY environment variable');
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

function readResponse(proxyRes) {
    return new Promise((resolve, reject) => {
        let body = '';
        proxyRes.on('data', (chunk) => body += chunk);
        proxyRes.on('end', () => resolve(body));
        proxyRes.on('error', reject);
    });
}

// Create inquiry - PRODUCTION, real Persona API
app.post('/api/v1/inquiries', async (req, res) => {
    const templateId = req.body?.data?.attributes?.['template-id'];
    
    if (!templateId) {
        return res.status(400).json({ error: 'template-id is required' });
    }

    logUsage({ endpoint: '/api/v1/inquiries', templateId: templateId });

    const data = JSON.stringify({
        data: {
            attributes: {
                "template-id": templateId,
                "redirect-uri": "https://scaramouch1.onrender.com/redirect"
            }
        }
    });

    const options = {
        hostname: 'api.withpersona.com',
        path: '/api/v1/inquiries',
        method: 'POST',
        headers: {
            'Authorization': 'Bearer ' + PERSONA_API_KEY,
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(data),
            'Persona-Version': '2023-01-01'
        }
    };

    const proxyReq = https.request(options, (proxyRes) => {
        let body = '';
        proxyRes.on('data', (chunk) => body += chunk);
        proxyRes.on('end', () => {
            // Return Persona's real response
            res.status(proxyRes.statusCode);
            res.setHeader('Content-Type', 'application/json');
            res.end(body);
        });
    });

    proxyReq.on('error', (err) => {
        console.error('Proxy error:', err);
        res.status(502).json({
            error: 'Unable to reach Persona API',
            details: err.message
        });
    });

    proxyReq.write(data);
    proxyReq.end();
});

// Get inquiry - PRODUCTION, real Persona API
app.get('/api/v1/inquiries/:id', async (req, res) => {
    const inquiryId = req.params.id;

    const options = {
        hostname: 'api.withpersona.com',
        path: '/api/v1/inquiries/' + inquiryId,
        method: 'GET',
        headers: {
            'Authorization': 'Bearer ' + PERSONA_API_KEY,
            'Persona-Version': '2023-01-01'
        }
    };

    const proxyReq = https.request(options, (proxyRes) => {
        let body = '';
        proxyRes.on('data', (chunk) => body += chunk);
        proxyRes.on('end', () => {
            res.status(proxyRes.statusCode);
            res.setHeader('Content-Type', 'application/json');
            res.end(body);
        });
    });

    proxyReq.on('error', (err) => {
        res.status(502).json({
            error: 'Unable to reach Persona API',
            details: err.message
        });
    });

    proxyReq.end();
});

// List inquiries - PRODUCTION, real Persona API
app.get('/api/v1/inquiries', async (req, res) => {
    const options = {
        hostname: 'api.withpersona.com',
        path: '/api/v1/inquiries',
        method: 'GET',
        headers: {
            'Authorization': 'Bearer ' + PERSONA_API_KEY,
            'Persona-Version': '2023-01-01'
        }
    };

    const proxyReq = https.request(options, (proxyRes) => {
        let body = '';
        proxyRes.on('data', (chunk) => body += chunk);
        proxyRes.on('end', () => {
            res.status(proxyRes.statusCode);
            res.setHeader('Content-Type', 'application/json');
            res.end(body);
        });
    });

    proxyReq.on('error', (err) => {
        res.status(502).json({
            error: 'Unable to reach Persona API',
            details: err.message
        });
    });

    proxyReq.end();
});

// Outlier verification endpoint - PRODUCTION, real Persona API
app.get('/outlier/verifications', async (req, res) => {
    const id = req.query._id;
    if (!id) {
        return res.status(400).json({ error: 'Missing _id parameter' });
    }

    const options = {
        hostname: 'api.withpersona.com',
        path: '/api/v1/inquiries/' + id,
        method: 'GET',
        headers: {
            'Authorization': 'Bearer ' + PERSONA_API_KEY,
            'Persona-Version': '2023-01-01'
        }
    };

    const proxyReq = https.request(options, (proxyRes) => {
        let body = '';
        proxyRes.on('data', (chunk) => body += chunk);
        proxyRes.on('end', () => {
            if (proxyRes.statusCode !== 200) {
                return res.status(proxyRes.statusCode).json({
                    error: 'Persona API error',
                    details: body
                });
            }

            try {
                const parsed = JSON.parse(body);
                const inquiry = parsed.data;
                
                // Transform to Outlier format - but keep real data
                res.json({
                    userVerifications: [{
                        _id: id,
                        createdAt: inquiry.attributes['created-at'],
                        status: 'inquiry.' + (inquiry.attributes.status || 'unknown').toLowerCase(),
                        verificationStatus: inquiry.attributes['verification-status'] || null,
                        templateId: inquiry.relationships?.['inquiry-template']?.data?.id || null,
                        inquiryId: inquiry.id,
                        internalFlags: [],
                        statusUpdatedAt: inquiry.attributes['updated-at'],
                        personaAccountId: inquiry.relationships?.account?.data?.id || null
                    }]
                });
            } catch (e) {
                console.error('Error parsing Persona response:', e);
                res.status(502).json({
                    error: 'Invalid response from Persona'
                });
            }
        });
    });

    proxyReq.on('error', (err) => {
        res.status(502).json({
            error: 'Unable to reach Persona API',
            details: err.message
        });
    });

    proxyReq.end();
});

app.get('/health', (req, res) => {
    res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

app.get('/redirect', (req, res) => {
    res.send(`<!DOCTYPE html>
<html>
<head><title>Verification Complete</title></head>
<body style="font-family:Arial;text-align:center;padding-top:50px;">
  <h2>Verification Complete</h2>
  <p>You can close this window.</p>
  <script>
    if(window.parent) {
      window.parent.postMessage({
        type: "PERSONA_VERIFICATION_COMPLETE",
        status: "approved"
      }, "*");
    }
  </script>
</body>
</html>`);
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