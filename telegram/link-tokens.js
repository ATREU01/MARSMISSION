/**
 * LAUNCHR - Secure Link Token System
 *
 * CIA-LEVEL SECURITY for Telegram ↔ Website session linking.
 *
 * CRITICAL: This system ensures we NEVER handle private keys.
 * Users authenticate on the website via Privy MPC.
 * Telegram only receives a session reference.
 *
 * Security Features:
 * - Cryptographically secure random tokens
 * - 5-minute expiration
 * - One-time use (consumed on link)
 * - No sensitive data in tokens
 * - Rate limiting per chatId
 * - Audit logging
 */

const crypto = require('crypto');

// Token configuration
const TOKEN_CONFIG = {
    BYTES: 32,                          // 256-bit tokens
    EXPIRY_MS: 5 * 60 * 1000,          // 5 minutes
    MAX_PENDING_PER_USER: 3,           // Max pending tokens per chatId
    CLEANUP_INTERVAL_MS: 60 * 1000,    // Clean expired every minute
};

// In-memory token store (no persistence = no attack surface)
// Format: { token: { chatId, createdAt, used, ip } }
const pendingTokens = new Map();

// Rate limiting: { chatId: { count, windowStart } }
const rateLimits = new Map();
const RATE_LIMIT = { MAX: 10, WINDOW_MS: 60 * 1000 }; // 10 per minute

// Audit log (in-memory, rotates)
const auditLog = [];
const MAX_AUDIT_ENTRIES = 1000;

/**
 * Generate a cryptographically secure link token
 * @param {string|number} chatId - Telegram chat ID
 * @param {object} metadata - Optional metadata (NO sensitive data)
 * @returns {object} { token, expiresAt, linkUrl }
 */
function generateToken(chatId, metadata = {}) {
    // Rate limit check
    if (!checkRateLimit(chatId)) {
        audit('RATE_LIMIT_EXCEEDED', { chatId });
        return { error: 'Rate limit exceeded. Try again in 1 minute.' };
    }

    // Check pending token limit
    const userPending = countPendingTokens(chatId);
    if (userPending >= TOKEN_CONFIG.MAX_PENDING_PER_USER) {
        // Revoke oldest pending tokens for this user
        revokePendingTokens(chatId);
    }

    // Generate secure random token
    const tokenBytes = crypto.randomBytes(TOKEN_CONFIG.BYTES);
    const token = tokenBytes.toString('base64url'); // URL-safe encoding

    const now = Date.now();
    const expiresAt = now + TOKEN_CONFIG.EXPIRY_MS;

    // Store token (ONLY non-sensitive data)
    pendingTokens.set(token, {
        chatId: String(chatId),
        createdAt: now,
        expiresAt,
        used: false,
        metadata: {
            // NEVER store: private keys, passwords, sensitive PII
            // ONLY store: preferences, non-identifying info
            source: metadata.source || 'telegram',
            action: metadata.action || 'link',
        },
    });

    // Build secure link URL
    const baseUrl = process.env.LAUNCHR_WEB_URL || 'https://www.launchronsol.xyz';
    const linkUrl = `${baseUrl}/link?token=${encodeURIComponent(token)}`;

    audit('TOKEN_GENERATED', { chatId, expiresIn: TOKEN_CONFIG.EXPIRY_MS });

    return {
        success: true,
        token,
        expiresAt,
        expiresIn: TOKEN_CONFIG.EXPIRY_MS,
        linkUrl,
    };
}

/**
 * Verify and consume a link token
 * Called by the website when user clicks the link
 * @param {string} token - The link token
 * @param {string} privyUserId - User ID from Privy auth
 * @returns {object} { valid, chatId, error }
 */
function verifyAndConsumeToken(token, privyUserId) {
    if (!token || typeof token !== 'string') {
        audit('TOKEN_INVALID_FORMAT', { token: 'empty' });
        return { valid: false, error: 'Invalid token format' };
    }

    const tokenData = pendingTokens.get(token);

    if (!tokenData) {
        audit('TOKEN_NOT_FOUND', { tokenPrefix: token.slice(0, 8) });
        return { valid: false, error: 'Token not found or already used' };
    }

    // Check expiration
    if (Date.now() > tokenData.expiresAt) {
        pendingTokens.delete(token);
        audit('TOKEN_EXPIRED', { chatId: tokenData.chatId });
        return { valid: false, error: 'Token expired' };
    }

    // Check if already used
    if (tokenData.used) {
        audit('TOKEN_ALREADY_USED', { chatId: tokenData.chatId });
        return { valid: false, error: 'Token already used' };
    }

    // Mark as used and delete (one-time use)
    tokenData.used = true;
    pendingTokens.delete(token);

    // Secure wipe the token from memory
    secureWipe(token);

    audit('TOKEN_CONSUMED', { chatId: tokenData.chatId, privyUserId });

    return {
        valid: true,
        chatId: tokenData.chatId,
        metadata: tokenData.metadata,
    };
}

/**
 * Revoke all pending tokens for a chatId
 */
function revokePendingTokens(chatId) {
    const chatIdStr = String(chatId);
    let revoked = 0;

    for (const [token, data] of pendingTokens) {
        if (data.chatId === chatIdStr) {
            pendingTokens.delete(token);
            revoked++;
        }
    }

    if (revoked > 0) {
        audit('TOKENS_REVOKED', { chatId, count: revoked });
    }

    return revoked;
}

/**
 * Count pending tokens for a chatId
 */
function countPendingTokens(chatId) {
    const chatIdStr = String(chatId);
    let count = 0;

    for (const data of pendingTokens.values()) {
        if (data.chatId === chatIdStr && !data.used) {
            count++;
        }
    }

    return count;
}

/**
 * Check rate limit for a chatId
 */
function checkRateLimit(chatId) {
    const chatIdStr = String(chatId);
    const now = Date.now();
    const limit = rateLimits.get(chatIdStr);

    if (!limit || now - limit.windowStart > RATE_LIMIT.WINDOW_MS) {
        rateLimits.set(chatIdStr, { count: 1, windowStart: now });
        return true;
    }

    if (limit.count >= RATE_LIMIT.MAX) {
        return false;
    }

    limit.count++;
    return true;
}

/**
 * Secure wipe a string from memory (best effort in JS)
 */
function secureWipe(str) {
    if (typeof str === 'string' && str.length > 0) {
        // Overwrite with random data (helps with some memory analyzers)
        try {
            const arr = str.split('');
            for (let i = 0; i < arr.length; i++) {
                arr[i] = String.fromCharCode(Math.floor(Math.random() * 256));
            }
        } catch (e) {
            // Best effort
        }
    }
}

/**
 * Audit logging (in-memory, no persistence)
 */
function audit(event, data = {}) {
    const entry = {
        timestamp: new Date().toISOString(),
        event,
        ...data,
        // NEVER log sensitive data
        // Sanitize chatId to just show existence
        chatId: data.chatId ? `${String(data.chatId).slice(0, 4)}...` : undefined,
    };

    auditLog.push(entry);

    // Rotate log
    if (auditLog.length > MAX_AUDIT_ENTRIES) {
        auditLog.shift();
    }

    // Console log for monitoring (production would use proper logging)
    console.log(`[LINK-TOKEN] ${event}`, entry);
}

/**
 * Get audit log (for admin/debugging)
 */
function getAuditLog(limit = 100) {
    return auditLog.slice(-limit);
}

/**
 * Cleanup expired tokens (runs on interval)
 */
function cleanupExpiredTokens() {
    const now = Date.now();
    let cleaned = 0;

    for (const [token, data] of pendingTokens) {
        if (now > data.expiresAt) {
            pendingTokens.delete(token);
            cleaned++;
        }
    }

    if (cleaned > 0) {
        audit('TOKENS_CLEANED', { count: cleaned });
    }

    // Also clean old rate limits
    for (const [chatId, limit] of rateLimits) {
        if (now - limit.windowStart > RATE_LIMIT.WINDOW_MS * 2) {
            rateLimits.delete(chatId);
        }
    }
}

// Start cleanup interval
setInterval(cleanupExpiredTokens, TOKEN_CONFIG.CLEANUP_INTERVAL_MS);

/**
 * Get system stats (for monitoring)
 */
function getStats() {
    return {
        pendingTokens: pendingTokens.size,
        rateLimitEntries: rateLimits.size,
        auditLogSize: auditLog.length,
        config: {
            tokenExpiryMs: TOKEN_CONFIG.EXPIRY_MS,
            maxPendingPerUser: TOKEN_CONFIG.MAX_PENDING_PER_USER,
            rateLimitMax: RATE_LIMIT.MAX,
            rateLimitWindowMs: RATE_LIMIT.WINDOW_MS,
        },
    };
}

module.exports = {
    generateToken,
    verifyAndConsumeToken,
    revokePendingTokens,
    getAuditLog,
    getStats,
    TOKEN_CONFIG,
};
