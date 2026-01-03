/**
 * LAUNCHR - Secure Session Bridge
 *
 * Maps Telegram users to Website sessions via Privy authentication.
 *
 * CRITICAL SECURITY ARCHITECTURE:
 * ═══════════════════════════════════════════════════════════════════════
 *
 *   TELEGRAM                    BRIDGE                     WEBSITE
 *   ────────                    ──────                     ───────
 *   User clicks              This module              Privy MPC Auth
 *   "Link Wallet"    ───────►  generates    ───────►  User signs with
 *        │                    secure token              their wallet
 *        │                         │                        │
 *        │                         │                        │
 *        ▼                         ▼                        ▼
 *   Gets status             Stores mapping:           Confirms link
 *   updates only          chatId ↔ privyUserId       via callback
 *
 * ═══════════════════════════════════════════════════════════════════════
 *
 * WHAT WE STORE (non-sensitive):
 * - Telegram chatId
 * - Privy userId (NOT the wallet address or any keys)
 * - Linked timestamp
 * - Notification preferences
 * - Session status
 *
 * WHAT WE NEVER STORE:
 * - Private keys (NEVER)
 * - Wallet mnemonics (NEVER)
 * - Passwords (NEVER)
 * - Full wallet addresses (only truncated for display)
 *
 * LEGAL PROTECTION:
 * - We are a notification/status layer only
 * - All signing happens via Privy MPC (we never have full keys)
 * - Users maintain custody of their wallets
 * - No custody = no money transmitter liability
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

// ═══════════════════════════════════════════════════════════════════════
// CONFIGURATION
// ═══════════════════════════════════════════════════════════════════════

const BRIDGE_CONFIG = {
    // Session expiration (30 days for linked sessions)
    SESSION_TTL_MS: 30 * 24 * 60 * 60 * 1000,

    // Persist to file for recovery after restart
    // NOTE: Only non-sensitive data is stored
    PERSIST_FILE: process.env.RAILWAY_ENVIRONMENT
        ? '/app/data/telegram-sessions.json'
        : path.join(__dirname, '..', 'data', 'telegram-sessions.json'),

    // Auto-save interval
    SAVE_INTERVAL_MS: 60 * 1000, // Every minute

    // Cleanup interval
    CLEANUP_INTERVAL_MS: 60 * 60 * 1000, // Every hour
};

// ═══════════════════════════════════════════════════════════════════════
// SESSION STORE
// ═══════════════════════════════════════════════════════════════════════

// Format: { chatId: SessionData }
const sessions = new Map();

/**
 * Session data structure (ONLY non-sensitive data)
 * @typedef {Object} SessionData
 * @property {string} chatId - Telegram chat ID
 * @property {string} privyUserId - Privy user ID (NOT wallet address)
 * @property {string} walletPreview - Truncated wallet for display (e.g., "7xK3...8f2P")
 * @property {string} mint - Token mint address (if configured)
 * @property {string} mintPreview - Truncated mint for display
 * @property {boolean} linked - Whether session is fully linked
 * @property {number} linkedAt - Timestamp when linked
 * @property {number} lastActivity - Last activity timestamp
 * @property {Object} notifications - Notification preferences
 * @property {Object} engine - Engine status (read-only mirror)
 */

// ═══════════════════════════════════════════════════════════════════════
// CORE FUNCTIONS
// ═══════════════════════════════════════════════════════════════════════

/**
 * Create a pending session (before linking)
 * Called when user initiates /link command
 */
function createPendingSession(chatId, metadata = {}) {
    const chatIdStr = String(chatId);

    // If already linked, don't overwrite
    const existing = sessions.get(chatIdStr);
    if (existing && existing.linked) {
        return {
            success: false,
            error: 'Already linked. Use /unlink first.',
            session: existing,
        };
    }

    const session = {
        chatId: chatIdStr,
        privyUserId: null,
        walletPreview: null,
        mint: null,
        mintPreview: null,
        linked: false,
        linkedAt: null,
        createdAt: Date.now(),
        lastActivity: Date.now(),
        notifications: {
            claims: true,
            distributions: true,
            alerts: true,
            dailySummary: false,
        },
        engine: {
            active: false,
            lastCycle: null,
            stats: {
                totalClaimed: 0,
                totalDistributed: 0,
                cycles: 0,
            },
        },
        metadata: {
            username: metadata.username || null,
            source: 'telegram',
        },
    };

    sessions.set(chatIdStr, session);
    log('SESSION_CREATED', { chatId: chatIdStr });

    return { success: true, session };
}

/**
 * Complete the link (called when website confirms via token)
 * @param {string} chatId - Telegram chat ID
 * @param {string} privyUserId - Privy user ID
 * @param {string} walletAddress - Full wallet address (we truncate it)
 */
function completeLink(chatId, privyUserId, walletAddress) {
    const chatIdStr = String(chatId);
    const session = sessions.get(chatIdStr);

    if (!session) {
        return { success: false, error: 'Session not found. Start with /link' };
    }

    if (session.linked) {
        return { success: false, error: 'Already linked' };
    }

    // Store ONLY non-sensitive data
    session.privyUserId = privyUserId;
    session.walletPreview = truncateAddress(walletAddress);
    session.linked = true;
    session.linkedAt = Date.now();
    session.lastActivity = Date.now();

    sessions.set(chatIdStr, session);
    scheduleSave();

    log('SESSION_LINKED', { chatId: chatIdStr, privyUserId });

    return { success: true, session };
}

/**
 * Set the token mint for a linked session
 */
function setMint(chatId, mintAddress) {
    const chatIdStr = String(chatId);
    const session = sessions.get(chatIdStr);

    if (!session || !session.linked) {
        return { success: false, error: 'Not linked' };
    }

    session.mint = mintAddress;
    session.mintPreview = truncateAddress(mintAddress);
    session.lastActivity = Date.now();

    sessions.set(chatIdStr, session);
    scheduleSave();

    log('MINT_SET', { chatId: chatIdStr, mint: session.mintPreview });

    return { success: true, session };
}

/**
 * Update engine status (called by engine loop)
 */
function updateEngineStatus(chatId, status) {
    const chatIdStr = String(chatId);
    const session = sessions.get(chatIdStr);

    if (!session) return false;

    session.engine = {
        active: status.active || false,
        lastCycle: status.lastCycle || null,
        stats: {
            totalClaimed: status.totalClaimed || 0,
            totalDistributed: status.totalDistributed || 0,
            cycles: status.cycles || 0,
        },
        allocations: status.allocations || null,
        lastAnalysis: status.analysis || null,
    };
    session.lastActivity = Date.now();

    sessions.set(chatIdStr, session);

    return true;
}

/**
 * Update notification preferences
 */
function setNotifications(chatId, prefs) {
    const chatIdStr = String(chatId);
    const session = sessions.get(chatIdStr);

    if (!session) return false;

    session.notifications = {
        ...session.notifications,
        ...prefs,
    };
    session.lastActivity = Date.now();

    sessions.set(chatIdStr, session);
    scheduleSave();

    return true;
}

/**
 * Get session by chatId
 */
function getSession(chatId) {
    const chatIdStr = String(chatId);
    const session = sessions.get(chatIdStr);

    if (!session) return null;

    // Check expiration
    if (session.linkedAt && Date.now() - session.linkedAt > BRIDGE_CONFIG.SESSION_TTL_MS) {
        sessions.delete(chatIdStr);
        log('SESSION_EXPIRED', { chatId: chatIdStr });
        return null;
    }

    return session;
}

/**
 * Get session by Privy user ID
 */
function getSessionByPrivyId(privyUserId) {
    for (const session of sessions.values()) {
        if (session.privyUserId === privyUserId) {
            return session;
        }
    }
    return null;
}

/**
 * Check if chatId has a linked session
 */
function isLinked(chatId) {
    const session = getSession(chatId);
    return session && session.linked;
}

/**
 * Unlink/destroy a session
 */
function unlinkSession(chatId) {
    const chatIdStr = String(chatId);
    const session = sessions.get(chatIdStr);

    if (session) {
        sessions.delete(chatIdStr);
        scheduleSave();
        log('SESSION_UNLINKED', { chatId: chatIdStr });
        return { success: true };
    }

    return { success: false, error: 'No session found' };
}

/**
 * Get all linked sessions (for engine loop)
 */
function getAllLinkedSessions() {
    const linked = [];

    for (const session of sessions.values()) {
        if (session.linked && session.mint) {
            linked.push({
                chatId: session.chatId,
                privyUserId: session.privyUserId,
                mint: session.mint,
                notifications: session.notifications,
            });
        }
    }

    return linked;
}

/**
 * Get session count stats
 */
function getStats() {
    let total = 0;
    let linked = 0;
    let active = 0;

    for (const session of sessions.values()) {
        total++;
        if (session.linked) linked++;
        if (session.engine?.active) active++;
    }

    return { total, linked, active };
}

// ═══════════════════════════════════════════════════════════════════════
// PERSISTENCE (Non-sensitive data only)
// ═══════════════════════════════════════════════════════════════════════

let saveScheduled = false;

function scheduleSave() {
    if (saveScheduled) return;
    saveScheduled = true;
    setTimeout(() => {
        saveScheduled = false;
        saveSessions();
    }, 5000); // Debounce saves
}

function saveSessions() {
    try {
        // Ensure directory exists
        const dir = path.dirname(BRIDGE_CONFIG.PERSIST_FILE);
        if (!fs.existsSync(dir)) {
            fs.mkdirSync(dir, { recursive: true });
        }

        // Convert Map to array for JSON
        const data = Array.from(sessions.entries());

        fs.writeFileSync(BRIDGE_CONFIG.PERSIST_FILE, JSON.stringify(data, null, 2));
        log('SESSIONS_SAVED', { count: sessions.size });
    } catch (e) {
        console.error('[SESSION-BRIDGE] Save failed:', e.message);
    }
}

function loadSessions() {
    try {
        if (fs.existsSync(BRIDGE_CONFIG.PERSIST_FILE)) {
            const data = JSON.parse(fs.readFileSync(BRIDGE_CONFIG.PERSIST_FILE, 'utf8'));

            for (const [chatId, session] of data) {
                // Validate session still within TTL
                if (session.linkedAt && Date.now() - session.linkedAt > BRIDGE_CONFIG.SESSION_TTL_MS) {
                    continue; // Skip expired
                }
                sessions.set(chatId, session);
            }

            log('SESSIONS_LOADED', { count: sessions.size });
        }
    } catch (e) {
        console.error('[SESSION-BRIDGE] Load failed:', e.message);
    }
}

function cleanupExpiredSessions() {
    const now = Date.now();
    let cleaned = 0;

    for (const [chatId, session] of sessions) {
        if (session.linkedAt && now - session.linkedAt > BRIDGE_CONFIG.SESSION_TTL_MS) {
            sessions.delete(chatId);
            cleaned++;
        }
    }

    if (cleaned > 0) {
        log('SESSIONS_CLEANED', { count: cleaned });
        saveSessions();
    }
}

// ═══════════════════════════════════════════════════════════════════════
// UTILITIES
// ═══════════════════════════════════════════════════════════════════════

/**
 * Truncate address for display (NEVER store full addresses)
 */
function truncateAddress(address) {
    if (!address || address.length < 12) return address;
    return `${address.slice(0, 4)}...${address.slice(-4)}`;
}

/**
 * Audit logging
 */
function log(event, data = {}) {
    const entry = {
        timestamp: new Date().toISOString(),
        event,
        ...data,
    };
    console.log(`[SESSION-BRIDGE] ${event}`, JSON.stringify(data));
}

// ═══════════════════════════════════════════════════════════════════════
// INITIALIZATION
// ═══════════════════════════════════════════════════════════════════════

// Load existing sessions on startup
loadSessions();

// Start cleanup interval
setInterval(cleanupExpiredSessions, BRIDGE_CONFIG.CLEANUP_INTERVAL_MS);

// Auto-save interval
setInterval(saveSessions, BRIDGE_CONFIG.SAVE_INTERVAL_MS);

// ═══════════════════════════════════════════════════════════════════════
// EXPORTS
// ═══════════════════════════════════════════════════════════════════════

module.exports = {
    // Core functions
    createPendingSession,
    completeLink,
    setMint,
    updateEngineStatus,
    setNotifications,
    getSession,
    getSessionByPrivyId,
    isLinked,
    unlinkSession,
    getAllLinkedSessions,
    getStats,

    // Utilities
    truncateAddress,

    // For testing/admin
    saveSessions,
    loadSessions,
};
