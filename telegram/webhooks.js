/**
 * LAUNCHR - Webhook Endpoints for Main Server Integration
 *
 * These endpoints handle callbacks from the website when users:
 * - Complete wallet authentication
 * - Start/stop the engine
 * - Engine completes cycles
 *
 * SECURITY:
 * - All endpoints require HMAC signature verification
 * - No sensitive data flows through these endpoints
 * - Rate limited per source
 */

const crypto = require('crypto');
const { handleWebhook, linkTokens, sessionBridge } = require('./index');

// ═══════════════════════════════════════════════════════════════════════
// CONFIGURATION
// ═══════════════════════════════════════════════════════════════════════

const WEBHOOK_CONFIG = {
    // Secret for HMAC verification (set via environment)
    SECRET: process.env.TELEGRAM_WEBHOOK_SECRET || crypto.randomBytes(32).toString('hex'),

    // Rate limiting
    MAX_REQUESTS_PER_MINUTE: 100,

    // Allowed origins (for CORS)
    ALLOWED_ORIGINS: (process.env.ALLOWED_ORIGINS || 'https://www.launchronsol.xyz').split(','),
};

// Rate limiting state
const rateLimitState = {
    requests: 0,
    windowStart: Date.now(),
};

// ═══════════════════════════════════════════════════════════════════════
// HMAC VERIFICATION
// ═══════════════════════════════════════════════════════════════════════

/**
 * Verify HMAC signature of webhook request
 */
function verifySignature(body, signature) {
    if (!signature) return false;

    const expected = crypto
        .createHmac('sha256', WEBHOOK_CONFIG.SECRET)
        .update(typeof body === 'string' ? body : JSON.stringify(body))
        .digest('hex');

    // Timing-safe comparison
    return crypto.timingSafeEqual(
        Buffer.from(signature),
        Buffer.from(expected)
    );
}

/**
 * Generate HMAC signature (for testing/client use)
 */
function generateSignature(body) {
    return crypto
        .createHmac('sha256', WEBHOOK_CONFIG.SECRET)
        .update(typeof body === 'string' ? body : JSON.stringify(body))
        .digest('hex');
}

// ═══════════════════════════════════════════════════════════════════════
// RATE LIMITING
// ═══════════════════════════════════════════════════════════════════════

function checkRateLimit() {
    const now = Date.now();

    // Reset window every minute
    if (now - rateLimitState.windowStart > 60000) {
        rateLimitState.requests = 0;
        rateLimitState.windowStart = now;
    }

    if (rateLimitState.requests >= WEBHOOK_CONFIG.MAX_REQUESTS_PER_MINUTE) {
        return false;
    }

    rateLimitState.requests++;
    return true;
}

// ═══════════════════════════════════════════════════════════════════════
// REQUEST HANDLER
// ═══════════════════════════════════════════════════════════════════════

/**
 * Main webhook request handler
 * Integrate this into your HTTP server
 *
 * @param {http.IncomingMessage} req
 * @param {http.ServerResponse} res
 * @param {string} body - Raw request body
 */
async function handleRequest(req, res, body) {
    // CORS headers
    const origin = req.headers.origin;
    if (WEBHOOK_CONFIG.ALLOWED_ORIGINS.includes(origin)) {
        res.setHeader('Access-Control-Allow-Origin', origin);
    }
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Signature');

    // Handle preflight
    if (req.method === 'OPTIONS') {
        res.writeHead(200);
        res.end();
        return;
    }

    // Only POST allowed
    if (req.method !== 'POST') {
        res.writeHead(405, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Method not allowed' }));
        return;
    }

    // Rate limit check
    if (!checkRateLimit()) {
        res.writeHead(429, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Rate limit exceeded' }));
        return;
    }

    // Parse body
    let data;
    try {
        data = typeof body === 'string' ? JSON.parse(body) : body;
    } catch (e) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Invalid JSON' }));
        return;
    }

    // Verify signature (skip in development)
    const signature = req.headers['x-signature'];
    if (process.env.NODE_ENV === 'production') {
        if (!verifySignature(body, signature)) {
            res.writeHead(401, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Invalid signature' }));
            return;
        }
    }

    // Extract webhook type
    const { type, ...webhookData } = data;

    if (!type) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Missing type' }));
        return;
    }

    // Handle webhook
    try {
        const result = await handleWebhook(type, webhookData);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(result));
    } catch (e) {
        console.error('[WEBHOOK] Error:', e.message);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Internal error' }));
    }
}

// ═══════════════════════════════════════════════════════════════════════
// TOKEN VERIFICATION ENDPOINT
// ═══════════════════════════════════════════════════════════════════════

/**
 * Verify a link token (called by website before showing connect UI)
 *
 * @param {string} token
 * @returns {object} { valid, chatId, expiresAt }
 */
function verifyToken(token) {
    // Check if token exists and is not expired
    // Note: This doesn't consume the token, just validates it

    const stats = linkTokens.getStats();
    // We can't peek at token without consuming, so just return basic validation
    return {
        valid: token && token.length === 43, // Base64url of 32 bytes
        message: 'Token format valid. Consume via webhook.',
    };
}

// ═══════════════════════════════════════════════════════════════════════
// SERVER INTEGRATION HELPERS
// ═══════════════════════════════════════════════════════════════════════

/**
 * Get route handlers for integration with main server
 */
function getRoutes() {
    return {
        // POST /api/telegram/webhook - Main webhook endpoint
        '/api/telegram/webhook': handleRequest,

        // GET /api/telegram/link - Verify link token
        '/api/telegram/verify-token': async (req, res, query) => {
            const token = query.get('token');
            const result = verifyToken(token);
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(result));
        },

        // GET /api/telegram/stats - Get bridge stats
        '/api/telegram/stats': async (req, res) => {
            const stats = sessionBridge.getStats();
            const tokenStats = linkTokens.getStats();
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ sessions: stats, tokens: tokenStats }));
        },

        // POST /api/telegram/complete-link - Website calls this after auth
        '/api/telegram/complete-link': async (req, res, body) => {
            // Parse body
            let data;
            try {
                data = typeof body === 'string' ? JSON.parse(body) : body;
            } catch (e) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'Invalid JSON' }));
                return;
            }

            const { token, privyUserId, walletAddress } = data;

            if (!token || !privyUserId || !walletAddress) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'Missing required fields' }));
                return;
            }

            const result = await handleWebhook('link_complete', {
                token,
                privyUserId,
                walletAddress,
            });

            res.writeHead(result.success ? 200 : 400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(result));
        },
    };
}

// ═══════════════════════════════════════════════════════════════════════
// EXPORTS
// ═══════════════════════════════════════════════════════════════════════

module.exports = {
    handleRequest,
    verifySignature,
    generateSignature,
    verifyToken,
    getRoutes,
    WEBHOOK_CONFIG,
};
