/**
 * LAUNCHR - Secure Telegram Session Manager
 * Production-grade security for wallet connections
 *
 * Features:
 * - AES-256-GCM encryption (authenticated encryption)
 * - Session expiration (7 days)
 * - Auto-fund wallet tracking
 * - Secure memory wiping
 * - No disk persistence
 */

const crypto = require('crypto');

// Session expiration (7 days for TG sessions)
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

// AES-256-GCM encryption key (generated once per process)
const ENCRYPTION_KEY = crypto.randomBytes(32);

class SecureSessionManager {
    constructor() {
        // In-memory only - never persisted
        this.sessions = new Map();

        // Start session cleanup interval (every 1 hour)
        setInterval(() => this.cleanExpiredSessions(), 60 * 60 * 1000);
    }

    // Encrypt with AES-256-GCM (authenticated encryption)
    encrypt(text) {
        const iv = crypto.randomBytes(16);
        const cipher = crypto.createCipheriv('aes-256-gcm', ENCRYPTION_KEY, iv);
        let encrypted = cipher.update(text, 'utf8', 'hex');
        encrypted += cipher.final('hex');
        const authTag = cipher.getAuthTag();
        return {
            iv: iv.toString('hex'),
            encrypted,
            authTag: authTag.toString('hex')
        };
    }

    // Decrypt with authentication verification
    decrypt(encryptedData) {
        try {
            if (typeof encryptedData === 'string') {
                // Legacy format - direct encrypted string (CBC)
                // This shouldn't happen in new sessions
                return null;
            }
            const decipher = crypto.createDecipheriv(
                'aes-256-gcm',
                ENCRYPTION_KEY,
                Buffer.from(encryptedData.iv, 'hex')
            );
            decipher.setAuthTag(Buffer.from(encryptedData.authTag, 'hex'));
            let decrypted = decipher.update(encryptedData.encrypted, 'hex', 'utf8');
            decrypted += decipher.final('utf8');
            return decrypted;
        } catch (e) {
            console.error('[SESSION] Decryption failed');
            return null;
        }
    }

    // Secure memory wipe (best effort in JS)
    secureWipe(data) {
        if (Buffer.isBuffer(data)) {
            data.fill(0);
        }
        return null;
    }

    // Create a new session with encrypted private key
    create(chatId, privateKey, mint, allocations = null) {
        // Encrypt the private key immediately
        const encryptedKey = this.encrypt(privateKey);

        // Default allocations
        const alloc = allocations || {
            marketMaking: 25,
            buybackBurn: 25,
            liquidityPool: 25,
            creatorRevenue: 25
        };

        const session = {
            chatId,
            mint,
            encryptedKey,
            allocations: alloc,
            active: false,
            createdAt: Date.now(),
            lastActivity: Date.now(),
            stats: {
                claimed: 0,
                distributed: 0,
                cycles: 0
            },
            // Auto-fund configuration
            autoFund: {
                enabled: false,
                encryptedSourceKey: null,
                sourceWallet: null,
                minBalance: 0.05 * 1e9,  // 0.05 SOL minimum before refill
                fundAmount: 0.1 * 1e9,    // 0.1 SOL per refill
                lastFunded: 0
            }
        };

        this.sessions.set(chatId, session);
        console.log(`[SESSION] Created for ${chatId}, expires in 7 days`);
        return session;
    }

    // Get session with expiration check
    get(chatId) {
        const session = this.sessions.get(chatId);
        if (!session) return null;

        // Check expiration
        if (Date.now() - session.createdAt > SESSION_TTL_MS) {
            console.log(`[SESSION] ${chatId} expired`);
            this.destroy(chatId);
            return null;
        }

        session.lastActivity = Date.now();
        return session;
    }

    // Get decrypted private key (use sparingly)
    getKey(chatId) {
        const session = this.get(chatId);
        if (!session) return null;
        return this.decrypt(session.encryptedKey);
    }

    // Check if session exists
    has(chatId) {
        const session = this.sessions.get(chatId);
        if (!session) return false;

        // Check expiration
        if (Date.now() - session.createdAt > SESSION_TTL_MS) {
            this.destroy(chatId);
            return false;
        }
        return true;
    }

    // Set session active state
    setActive(chatId, active) {
        const session = this.sessions.get(chatId);
        if (session) {
            session.active = active;
            session.lastActivity = Date.now();
        }
    }

    // Update allocations
    setAllocations(chatId, allocations) {
        const session = this.sessions.get(chatId);
        if (session) {
            session.allocations = { ...allocations };
            session.lastActivity = Date.now();
        }
    }

    // Update stats
    updateStats(chatId, claimed, distributed) {
        const session = this.sessions.get(chatId);
        if (session) {
            session.stats.claimed += claimed;
            session.stats.distributed += distributed;
            session.stats.cycles++;
            session.lastActivity = Date.now();
        }
    }

    // Configure auto-fund for a session
    setAutoFund(chatId, options) {
        const session = this.sessions.get(chatId);
        if (!session) return false;

        if (options.enabled !== undefined) {
            session.autoFund.enabled = options.enabled;
        }
        if (options.sourceKey) {
            session.autoFund.encryptedSourceKey = this.encrypt(options.sourceKey);
        }
        if (options.sourceWallet) {
            session.autoFund.sourceWallet = options.sourceWallet;
        }
        if (options.minBalance !== undefined) {
            session.autoFund.minBalance = Math.floor(options.minBalance);
        }
        if (options.fundAmount !== undefined) {
            session.autoFund.fundAmount = Math.floor(options.fundAmount);
        }

        session.lastActivity = Date.now();
        console.log(`[SESSION] Auto-fund configured for ${chatId}: enabled=${session.autoFund.enabled}`);
        return true;
    }

    // Get auto-fund config with decrypted source key
    getAutoFundConfig(chatId) {
        const session = this.sessions.get(chatId);
        if (!session || !session.autoFund.enabled) return null;

        return {
            enabled: session.autoFund.enabled,
            sourceWallet: session.autoFund.sourceWallet,
            sourceKey: session.autoFund.encryptedSourceKey
                ? this.decrypt(session.autoFund.encryptedSourceKey)
                : null,
            minBalance: session.autoFund.minBalance,
            fundAmount: session.autoFund.fundAmount,
            lastFunded: session.autoFund.lastFunded
        };
    }

    // Record a fund event
    recordFund(chatId, amount) {
        const session = this.sessions.get(chatId);
        if (session) {
            session.autoFund.lastFunded = Date.now();
        }
    }

    // Disable auto-fund
    disableAutoFund(chatId) {
        const session = this.sessions.get(chatId);
        if (session) {
            session.autoFund.enabled = false;
            // Wipe the source key
            if (session.autoFund.encryptedSourceKey) {
                session.autoFund.encryptedSourceKey = null;
            }
            session.autoFund.sourceWallet = null;
        }
    }

    // Destroy session completely (secure wipe)
    destroy(chatId) {
        const session = this.sessions.get(chatId);
        if (session) {
            // Overwrite encrypted keys with random data before delete
            if (session.encryptedKey) {
                session.encryptedKey.encrypted = crypto.randomBytes(64).toString('hex');
                session.encryptedKey.iv = null;
                session.encryptedKey.authTag = null;
            }
            if (session.autoFund.encryptedSourceKey) {
                session.autoFund.encryptedSourceKey.encrypted = crypto.randomBytes(64).toString('hex');
                session.autoFund.encryptedSourceKey = null;
            }
            this.sessions.delete(chatId);
            console.log(`[SESSION] ${chatId} destroyed securely`);
        }
    }

    // Get all active sessions (for engine loop)
    getActiveSessions() {
        const active = [];
        const now = Date.now();

        for (const [chatId, session] of this.sessions) {
            // Check expiration
            if (now - session.createdAt > SESSION_TTL_MS) {
                console.log(`[SESSION] ${chatId} expired, removing`);
                this.destroy(chatId);
                continue;
            }

            if (session.active) {
                active.push({
                    chatId,
                    mint: session.mint,
                    privateKey: this.decrypt(session.encryptedKey),
                    allocations: { ...session.allocations },
                    autoFund: session.autoFund.enabled ? this.getAutoFundConfig(chatId) : null
                });
            }
        }
        return active;
    }

    // Clean up expired sessions
    cleanExpiredSessions() {
        const now = Date.now();
        let cleaned = 0;

        for (const [chatId, session] of this.sessions) {
            if (now - session.createdAt > SESSION_TTL_MS) {
                this.destroy(chatId);
                cleaned++;
            }
        }

        if (cleaned > 0) {
            console.log(`[SESSION] Cleaned ${cleaned} expired sessions`);
        }
    }

    // Get count of active sessions
    getActiveCount() {
        let count = 0;
        for (const session of this.sessions.values()) {
            if (session.active) count++;
        }
        return count;
    }
}

module.exports = new SecureSessionManager();
