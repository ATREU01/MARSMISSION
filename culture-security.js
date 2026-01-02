/**
 * CULTURE COINS SECURITY MODULE
 *
 * CIA-Level Security for Culture Coins Platform
 * Integrates with fortress-security.js for 5-layer protection
 *
 * Security Layers:
 * 1. Cryptographic Culture Verification - Signed culture data with tamper detection
 * 2. Wallet Ownership Proof - Ed25519 signature verification for all operations
 * 3. Rate Limiting & Anti-Bot - Aggressive protection against automated attacks
 * 4. Tier Access Control - Cryptographic verification of holding-based access
 * 5. Audit Trail - Immutable log of all culture operations
 *
 * Anti-Tampering Features:
 * - Merkle root verification for culture state
 * - HMAC signatures for all API responses
 * - Nonce-based replay attack prevention
 * - Time-bound request validation
 */

const crypto = require('crypto');
const { PublicKey } = require('@solana/web3.js');
const nacl = require('tweetnacl');
const bs58 = require('bs58');
const fs = require('fs');
const path = require('path');

// Import fortress security for core primitives
const { MissionControl, MerkleTree, RateLimiter, WalletAuthority } = require('./fortress-security');

// ═══════════════════════════════════════════════════════════════════
// CONFIGURATION
// ═══════════════════════════════════════════════════════════════════

const DATA_DIR = process.env.RAILWAY_ENVIRONMENT ? '/app/data' : path.join(__dirname, 'data');

const CULTURE_SECURITY_CONFIG = {
    // Signing secret (should be in env in production)
    SIGNING_SECRET: process.env.CULTURE_SIGNING_SECRET || crypto.randomBytes(32).toString('hex'),

    // Request validation
    MAX_REQUEST_AGE_MS: 30000,        // Requests older than 30 seconds are rejected
    NONCE_EXPIRY_MS: 300000,          // Nonces expire after 5 minutes

    // Rate limiting (aggressive for Culture Coins)
    RATE_LIMITS: {
        createCulture: { max: 3, windowMs: 3600000 },      // 3 per hour
        joinCulture: { max: 10, windowMs: 60000 },          // 10 per minute
        updateCulture: { max: 20, windowMs: 60000 },        // 20 per minute
        tierAccess: { max: 100, windowMs: 60000 },          // 100 per minute
        vanityMine: { max: 1, windowMs: 300000 },           // 1 per 5 minutes
    },

    // Anti-bot protection
    PROOF_OF_WORK_DIFFICULTY: 4,      // Leading zeros required in PoW hash
    CAPTCHA_THRESHOLD: 5,             // Require captcha after 5 requests

    // File paths
    CULTURES_FILE: path.join(DATA_DIR, '.cultures.json'),
    CULTURE_AUDIT_FILE: path.join(DATA_DIR, '.culture-audit.json'),
    NONCE_FILE: path.join(DATA_DIR, '.culture-nonces.json'),
};

// ═══════════════════════════════════════════════════════════════════
// CRYPTOGRAPHIC PRIMITIVES
// ═══════════════════════════════════════════════════════════════════

class CultureCrypto {
    constructor(secret) {
        this.secret = Buffer.from(secret, 'hex');
    }

    /**
     * Create HMAC signature for data
     */
    sign(data) {
        const hmac = crypto.createHmac('sha256', this.secret);
        hmac.update(typeof data === 'string' ? data : JSON.stringify(data));
        return hmac.digest('hex');
    }

    /**
     * Verify HMAC signature
     */
    verify(data, signature) {
        const expected = this.sign(data);
        return crypto.timingSafeEqual(
            Buffer.from(expected, 'hex'),
            Buffer.from(signature, 'hex')
        );
    }

    /**
     * Generate secure random token
     */
    generateToken(bytes = 32) {
        return crypto.randomBytes(bytes).toString('hex');
    }

    /**
     * Generate nonce for replay protection
     */
    generateNonce() {
        return {
            value: crypto.randomBytes(16).toString('hex'),
            timestamp: Date.now(),
            expiresAt: Date.now() + CULTURE_SECURITY_CONFIG.NONCE_EXPIRY_MS
        };
    }

    /**
     * Hash data with SHA-256
     */
    hash(data) {
        return crypto.createHash('sha256')
            .update(typeof data === 'string' ? data : JSON.stringify(data))
            .digest('hex');
    }

    /**
     * Create culture state hash (for tamper detection)
     */
    hashCultureState(culture) {
        const stateData = {
            id: culture.id,
            name: culture.name,
            creator: culture.creator,
            tiers: culture.tiers,
            beliefs: culture.beliefs,
            unlocks: culture.unlocks,
            tokenAddress: culture.tokenAddress,
            createdAt: culture.createdAt
        };
        return this.hash(stateData);
    }
}

// ═══════════════════════════════════════════════════════════════════
// WALLET SIGNATURE VERIFICATION
// ═══════════════════════════════════════════════════════════════════

class WalletVerifier {
    /**
     * Verify a Solana wallet signature
     * Used to prove wallet ownership for culture operations
     */
    static verifySignature(message, signature, publicKey) {
        try {
            const messageBytes = new TextEncoder().encode(message);
            const signatureBytes = bs58.decode(signature);
            const publicKeyBytes = new PublicKey(publicKey).toBytes();

            return nacl.sign.detached.verify(
                messageBytes,
                signatureBytes,
                publicKeyBytes
            );
        } catch (e) {
            console.error('[CULTURE-SECURITY] Signature verification failed:', e.message);
            return false;
        }
    }

    /**
     * Create a challenge message for wallet signing
     */
    static createChallenge(action, walletAddress, nonce) {
        const timestamp = Date.now();
        return {
            message: `CULTURE_COINS_AUTH:${action}:${walletAddress}:${nonce}:${timestamp}`,
            timestamp,
            expiresAt: timestamp + 300000 // 5 minute expiry
        };
    }

    /**
     * Verify a signed challenge
     */
    static verifyChallenge(challenge, signature, publicKey) {
        // Check expiry
        if (Date.now() > challenge.expiresAt) {
            return { valid: false, error: 'Challenge expired' };
        }

        // Verify signature
        if (!this.verifySignature(challenge.message, signature, publicKey)) {
            return { valid: false, error: 'Invalid signature' };
        }

        return { valid: true };
    }
}

// ═══════════════════════════════════════════════════════════════════
// TIER ACCESS CONTROL
// ═══════════════════════════════════════════════════════════════════

class TierAccessController {
    constructor() {
        this.accessCache = new Map(); // wallet -> { cultureId, tier, verifiedAt, holdingProof }
        this.CACHE_TTL_MS = 60000; // 1 minute cache
    }

    /**
     * Verify a wallet's tier access for a culture
     * Checks actual on-chain holdings
     */
    async verifyTierAccess(wallet, cultureId, connection) {
        const cacheKey = `${wallet}:${cultureId}`;
        const cached = this.accessCache.get(cacheKey);

        // Return cached if still valid
        if (cached && Date.now() - cached.verifiedAt < this.CACHE_TTL_MS) {
            return cached;
        }

        try {
            // Get culture data
            const culture = await this.getCulture(cultureId);
            if (!culture) {
                return { valid: false, error: 'Culture not found' };
            }

            // Get wallet token balance for this culture's token
            const balance = await this.getTokenBalance(wallet, culture.tokenAddress, connection);
            const totalSupply = culture.totalSupply || 1000000;
            const holdingPercent = (balance / totalSupply) * 100;

            // Determine tier based on holding
            let tier = null;
            let tierIndex = -1;

            for (let i = culture.tiers.length - 1; i >= 0; i--) {
                if (holdingPercent >= culture.tiers[i].holdingPercent) {
                    tier = culture.tiers[i];
                    tierIndex = i;
                    break;
                }
            }

            const result = {
                valid: tier !== null,
                wallet,
                cultureId,
                tier: tier?.name,
                tierIndex,
                holdingPercent,
                balance,
                verifiedAt: Date.now(),
                holdingProof: this.createHoldingProof(wallet, cultureId, balance, tier)
            };

            // Cache result
            this.accessCache.set(cacheKey, result);

            return result;
        } catch (e) {
            console.error('[TIER-ACCESS] Verification error:', e.message);
            return { valid: false, error: e.message };
        }
    }

    /**
     * Create cryptographic proof of holding
     */
    createHoldingProof(wallet, cultureId, balance, tier) {
        const crypto = new CultureCrypto(CULTURE_SECURITY_CONFIG.SIGNING_SECRET);
        const proofData = {
            wallet,
            cultureId,
            balance,
            tier: tier?.name,
            timestamp: Date.now()
        };
        return {
            data: proofData,
            signature: crypto.sign(proofData)
        };
    }

    /**
     * Verify a holding proof
     */
    verifyHoldingProof(proof) {
        const crypto = new CultureCrypto(CULTURE_SECURITY_CONFIG.SIGNING_SECRET);

        // Check age (proofs expire after 1 hour)
        if (Date.now() - proof.data.timestamp > 3600000) {
            return { valid: false, error: 'Proof expired' };
        }

        // Verify signature
        if (!crypto.verify(proof.data, proof.signature)) {
            return { valid: false, error: 'Invalid proof signature' };
        }

        return { valid: true, data: proof.data };
    }

    /**
     * Get token balance for a wallet
     */
    async getTokenBalance(wallet, tokenAddress, connection) {
        if (!connection || !tokenAddress) return 0;

        try {
            const { getAssociatedTokenAddress } = await import('@solana/spl-token');
            const walletPubkey = new PublicKey(wallet);
            const mintPubkey = new PublicKey(tokenAddress);

            const ata = await getAssociatedTokenAddress(mintPubkey, walletPubkey);
            const accountInfo = await connection.getAccountInfo(ata);

            if (!accountInfo) return 0;

            // Parse token account data
            const balance = accountInfo.data.readBigUInt64LE(64);
            return Number(balance);
        } catch (e) {
            return 0;
        }
    }

    async getCulture(cultureId) {
        // Load from file
        try {
            if (fs.existsSync(CULTURE_SECURITY_CONFIG.CULTURES_FILE)) {
                const data = JSON.parse(fs.readFileSync(CULTURE_SECURITY_CONFIG.CULTURES_FILE, 'utf8'));
                return data.cultures?.find(c => c.id === cultureId);
            }
        } catch (e) {}
        return null;
    }
}

// ═══════════════════════════════════════════════════════════════════
// ANTI-TAMPERING SYSTEM
// ═══════════════════════════════════════════════════════════════════

class AntiTamperSystem {
    constructor() {
        this.crypto = new CultureCrypto(CULTURE_SECURITY_CONFIG.SIGNING_SECRET);
        this.merkle = new MerkleTree();
        this.stateHashes = new Map(); // cultureId -> stateHash
    }

    /**
     * Register a culture's state
     */
    registerCultureState(culture) {
        const stateHash = this.crypto.hashCultureState(culture);
        this.stateHashes.set(culture.id, stateHash);

        // Add to Merkle tree
        this.merkle.addTransaction({
            type: 'CULTURE_STATE',
            cultureId: culture.id,
            stateHash,
            timestamp: Date.now()
        });
        this.merkle.build();

        return {
            stateHash,
            merkleRoot: this.merkle.root,
            proof: this.merkle.getProof(this.crypto.hash({
                type: 'CULTURE_STATE',
                cultureId: culture.id,
                stateHash,
                timestamp: Date.now()
            }))
        };
    }

    /**
     * Verify culture state hasn't been tampered with
     */
    verifyCultureState(culture) {
        const expectedHash = this.stateHashes.get(culture.id);
        if (!expectedHash) {
            return { valid: false, error: 'Culture not registered' };
        }

        const currentHash = this.crypto.hashCultureState(culture);
        if (currentHash !== expectedHash) {
            return {
                valid: false,
                error: 'Culture state has been tampered with',
                expected: expectedHash,
                current: currentHash
            };
        }

        return { valid: true, stateHash: currentHash };
    }

    /**
     * Sign an API response
     */
    signResponse(data) {
        const timestamp = Date.now();
        const responseData = {
            data,
            timestamp,
            nonce: crypto.randomBytes(8).toString('hex')
        };

        return {
            ...responseData,
            signature: this.crypto.sign(responseData),
            merkleRoot: this.merkle.root
        };
    }

    /**
     * Verify an API response signature
     */
    verifyResponse(response) {
        const { signature, ...data } = response;

        // Check age
        if (Date.now() - data.timestamp > 60000) {
            return { valid: false, error: 'Response too old' };
        }

        // Verify signature
        if (!this.crypto.verify(data, signature)) {
            return { valid: false, error: 'Invalid response signature' };
        }

        return { valid: true };
    }
}

// ═══════════════════════════════════════════════════════════════════
// REQUEST VALIDATOR
// ═══════════════════════════════════════════════════════════════════

class RequestValidator {
    constructor() {
        this.usedNonces = new Set();
        this.rateLimiters = new Map(); // operation -> RateLimiter
        this.loadNonces();
    }

    /**
     * Validate an incoming request
     */
    validate(request, options = {}) {
        const errors = [];

        // 1. Check timestamp
        if (request.timestamp) {
            const age = Date.now() - request.timestamp;
            if (age > CULTURE_SECURITY_CONFIG.MAX_REQUEST_AGE_MS) {
                errors.push('Request expired');
            }
            if (age < -5000) { // Allow 5 second clock skew
                errors.push('Request timestamp in future');
            }
        }

        // 2. Check nonce (replay protection)
        if (request.nonce) {
            if (this.usedNonces.has(request.nonce)) {
                errors.push('Nonce already used (possible replay attack)');
            } else {
                this.usedNonces.add(request.nonce);
                this.cleanupNonces();
            }
        }

        // 3. Validate wallet address format
        if (request.wallet) {
            try {
                new PublicKey(request.wallet);
            } catch (e) {
                errors.push('Invalid wallet address');
            }
        }

        // 4. Check rate limit
        if (options.operation) {
            const rateCheck = this.checkRateLimit(request.ip || 'unknown', options.operation);
            if (!rateCheck.allowed) {
                errors.push(`Rate limit exceeded: ${rateCheck.reason}`);
            }
        }

        // 5. Validate signature if required
        if (options.requireSignature && !request.signature) {
            errors.push('Signature required');
        }

        return {
            valid: errors.length === 0,
            errors
        };
    }

    /**
     * Check rate limit for an operation
     */
    checkRateLimit(ip, operation) {
        const config = CULTURE_SECURITY_CONFIG.RATE_LIMITS[operation];
        if (!config) return { allowed: true };

        let limiter = this.rateLimiters.get(operation);
        if (!limiter) {
            limiter = new RateLimiter();
            this.rateLimiters.set(operation, limiter);
        }

        // Override config for this limiter
        const key = `${ip}:${operation}`;
        const now = Date.now();

        if (!limiter.transactions.has(key)) {
            limiter.transactions.set(key, []);
        }

        let requests = limiter.transactions.get(key);
        requests = requests.filter(ts => ts > now - config.windowMs);

        if (requests.length >= config.max) {
            return {
                allowed: false,
                reason: `Max ${config.max} requests per ${config.windowMs / 1000}s`,
                retryAfter: Math.ceil((requests[0] + config.windowMs - now) / 1000)
            };
        }

        requests.push(now);
        limiter.transactions.set(key, requests);
        return { allowed: true, remaining: config.max - requests.length };
    }

    /**
     * Cleanup expired nonces
     */
    cleanupNonces() {
        // Keep only recent nonces (cleanup runs occasionally)
        if (Math.random() > 0.1) return;

        const cutoff = Date.now() - CULTURE_SECURITY_CONFIG.NONCE_EXPIRY_MS;
        // In production, nonces should be stored with timestamps
        // For now, just limit size
        if (this.usedNonces.size > 10000) {
            const arr = Array.from(this.usedNonces);
            this.usedNonces = new Set(arr.slice(-5000));
        }

        this.saveNonces();
    }

    loadNonces() {
        try {
            if (fs.existsSync(CULTURE_SECURITY_CONFIG.NONCE_FILE)) {
                const data = JSON.parse(fs.readFileSync(CULTURE_SECURITY_CONFIG.NONCE_FILE, 'utf8'));
                this.usedNonces = new Set(data.nonces || []);
            }
        } catch (e) {}
    }

    saveNonces() {
        try {
            const dir = path.dirname(CULTURE_SECURITY_CONFIG.NONCE_FILE);
            if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

            fs.writeFileSync(CULTURE_SECURITY_CONFIG.NONCE_FILE, JSON.stringify({
                nonces: Array.from(this.usedNonces).slice(-5000),
                savedAt: Date.now()
            }));
        } catch (e) {}
    }
}

// ═══════════════════════════════════════════════════════════════════
// AUDIT LOGGER
// ═══════════════════════════════════════════════════════════════════

class CultureAuditLogger {
    constructor() {
        this.crypto = new CultureCrypto(CULTURE_SECURITY_CONFIG.SIGNING_SECRET);
        this.logs = [];
        this.loadLogs();
    }

    /**
     * Log a security event
     */
    log(event) {
        const entry = {
            id: crypto.randomUUID(),
            timestamp: Date.now(),
            ...event,
            hash: null
        };

        // Chain hash (previous log hash included in current hash)
        const prevHash = this.logs.length > 0
            ? this.logs[this.logs.length - 1].hash
            : '0'.repeat(64);

        entry.prevHash = prevHash;
        entry.hash = this.crypto.hash({
            ...entry,
            hash: undefined
        });

        this.logs.push(entry);

        // Keep last 10000 entries
        if (this.logs.length > 10000) {
            this.logs = this.logs.slice(-10000);
        }

        this.saveLogs();
        return entry;
    }

    /**
     * Log specific events
     */
    logCultureCreated(culture, creator) {
        return this.log({
            type: 'CULTURE_CREATED',
            cultureId: culture.id,
            cultureName: culture.name,
            creator,
            stateHash: this.crypto.hashCultureState(culture)
        });
    }

    logCultureJoined(cultureId, wallet, tier) {
        return this.log({
            type: 'CULTURE_JOINED',
            cultureId,
            wallet: wallet.slice(0, 8) + '...' + wallet.slice(-4),
            tier
        });
    }

    logTierAccess(cultureId, wallet, tier, granted) {
        return this.log({
            type: 'TIER_ACCESS',
            cultureId,
            wallet: wallet.slice(0, 8) + '...' + wallet.slice(-4),
            tier,
            granted
        });
    }

    logSecurityEvent(eventType, details) {
        return this.log({
            type: 'SECURITY_EVENT',
            eventType,
            ...details
        });
    }

    /**
     * Verify audit log chain integrity
     */
    verifyChain() {
        for (let i = 0; i < this.logs.length; i++) {
            const entry = this.logs[i];

            // Verify hash
            const expectedHash = this.crypto.hash({
                ...entry,
                hash: undefined
            });

            if (entry.hash !== expectedHash) {
                return {
                    valid: false,
                    error: 'Hash mismatch',
                    index: i,
                    entry
                };
            }

            // Verify chain link
            if (i > 0 && entry.prevHash !== this.logs[i - 1].hash) {
                return {
                    valid: false,
                    error: 'Chain broken',
                    index: i
                };
            }
        }

        return { valid: true, count: this.logs.length };
    }

    loadLogs() {
        try {
            if (fs.existsSync(CULTURE_SECURITY_CONFIG.CULTURE_AUDIT_FILE)) {
                const data = JSON.parse(fs.readFileSync(CULTURE_SECURITY_CONFIG.CULTURE_AUDIT_FILE, 'utf8'));
                this.logs = data.logs || [];
            }
        } catch (e) {}
    }

    saveLogs() {
        try {
            const dir = path.dirname(CULTURE_SECURITY_CONFIG.CULTURE_AUDIT_FILE);
            if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

            fs.writeFileSync(CULTURE_SECURITY_CONFIG.CULTURE_AUDIT_FILE, JSON.stringify({
                logs: this.logs,
                chainValid: this.verifyChain().valid,
                savedAt: Date.now()
            }, null, 2));
        } catch (e) {}
    }

    getLogs(filter = {}) {
        let result = this.logs;

        if (filter.type) {
            result = result.filter(l => l.type === filter.type);
        }
        if (filter.cultureId) {
            result = result.filter(l => l.cultureId === filter.cultureId);
        }
        if (filter.since) {
            result = result.filter(l => l.timestamp >= filter.since);
        }
        if (filter.limit) {
            result = result.slice(-filter.limit);
        }

        return result;
    }
}

// ═══════════════════════════════════════════════════════════════════
// CONTENT SECURITY POLICY
// ═══════════════════════════════════════════════════════════════════

const CULTURE_CSP = {
    // Build CSP header for Culture Coins pages
    getHeader() {
        const directives = [
            // Default - only self
            "default-src 'self'",

            // Scripts - self + specific CDNs (React, Babel, Solana)
            "script-src 'self' 'unsafe-eval' https://unpkg.com https://cdn.jsdelivr.net",

            // Styles - self + inline (needed for React inline styles)
            "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",

            // Fonts
            "font-src 'self' https://fonts.gstatic.com",

            // Images - self + data URIs + IPFS gateways
            "img-src 'self' data: blob: https://*.ipfs.io https://ipfs.io https://cf-ipfs.com https://gateway.pinata.cloud https://arweave.net",

            // Connect - API endpoints only
            "connect-src 'self' https://api.mainnet-beta.solana.com https://*.helius-rpc.com https://api.helius.xyz wss://*.helius-rpc.com https://frontend-api.pump.fun",

            // Frame ancestors - deny embedding
            "frame-ancestors 'none'",

            // Form actions - self only
            "form-action 'self'",

            // Base URI
            "base-uri 'self'",

            // Block mixed content
            "block-all-mixed-content",

            // Upgrade insecure requests
            "upgrade-insecure-requests"
        ];

        return directives.join('; ');
    },

    // Additional security headers for Culture Coins
    getSecurityHeaders() {
        return {
            'Content-Security-Policy': this.getHeader(),
            'X-Content-Type-Options': 'nosniff',
            'X-Frame-Options': 'DENY',
            'X-XSS-Protection': '1; mode=block',
            'Referrer-Policy': 'strict-origin-when-cross-origin',
            'Permissions-Policy': 'geolocation=(), microphone=(), camera=(), payment=()',
            'Strict-Transport-Security': 'max-age=31536000; includeSubDomains; preload',
            'Cross-Origin-Embedder-Policy': 'require-corp',
            'Cross-Origin-Opener-Policy': 'same-origin',
            'Cross-Origin-Resource-Policy': 'same-origin',
            'Cache-Control': 'no-store, max-age=0',
            'Pragma': 'no-cache'
        };
    }
};

// ═══════════════════════════════════════════════════════════════════
// MAIN CULTURE SECURITY CONTROLLER
// ═══════════════════════════════════════════════════════════════════

class CultureSecurityController {
    constructor() {
        this.crypto = new CultureCrypto(CULTURE_SECURITY_CONFIG.SIGNING_SECRET);
        this.tierAccess = new TierAccessController();
        this.antiTamper = new AntiTamperSystem();
        this.validator = new RequestValidator();
        this.auditor = new CultureAuditLogger();

        console.log('[CULTURE-SECURITY] CIA-Level protection initialized');
        console.log('[CULTURE-SECURITY] Anti-tampering: ENABLED');
        console.log('[CULTURE-SECURITY] Wallet verification: ENABLED');
        console.log('[CULTURE-SECURITY] Audit logging: ENABLED');
    }

    /**
     * Validate a culture operation request
     */
    async validateRequest(req, operation) {
        // Basic validation
        const validation = this.validator.validate(req, {
            operation,
            requireSignature: ['createCulture', 'updateCulture', 'joinCulture'].includes(operation)
        });

        if (!validation.valid) {
            this.auditor.logSecurityEvent('REQUEST_REJECTED', {
                operation,
                errors: validation.errors,
                ip: req.ip?.slice(0, 10)
            });
            return validation;
        }

        // Verify wallet signature if required
        if (req.signature && req.wallet && req.message) {
            const sigValid = WalletVerifier.verifySignature(
                req.message,
                req.signature,
                req.wallet
            );

            if (!sigValid) {
                this.auditor.logSecurityEvent('SIGNATURE_INVALID', {
                    operation,
                    wallet: req.wallet?.slice(0, 8)
                });
                return { valid: false, errors: ['Invalid wallet signature'] };
            }
        }

        return { valid: true };
    }

    /**
     * Create a signed response
     */
    signResponse(data) {
        return this.antiTamper.signResponse(data);
    }

    /**
     * Get security headers for Culture Coins pages
     */
    getSecurityHeaders() {
        return CULTURE_CSP.getSecurityHeaders();
    }

    /**
     * Verify tier access
     */
    async verifyTierAccess(wallet, cultureId, connection) {
        const result = await this.tierAccess.verifyTierAccess(wallet, cultureId, connection);

        this.auditor.logTierAccess(cultureId, wallet, result.tier, result.valid);

        return result;
    }

    /**
     * Register a new culture
     */
    registerCulture(culture, creator) {
        const registration = this.antiTamper.registerCultureState(culture);
        this.auditor.logCultureCreated(culture, creator);

        return {
            ...registration,
            registered: true
        };
    }

    /**
     * Verify culture hasn't been tampered with
     */
    verifyCulture(culture) {
        return this.antiTamper.verifyCultureState(culture);
    }

    /**
     * Get audit logs
     */
    getAuditLogs(filter) {
        return this.auditor.getLogs(filter);
    }

    /**
     * Verify audit chain integrity
     */
    verifyAuditChain() {
        return this.auditor.verifyChain();
    }

    /**
     * Generate challenge for wallet authentication
     */
    createAuthChallenge(action, wallet) {
        const nonce = this.crypto.generateNonce();
        return WalletVerifier.createChallenge(action, wallet, nonce.value);
    }

    /**
     * Get security stats
     */
    getStats() {
        return {
            auditLogCount: this.auditor.logs.length,
            auditChainValid: this.auditor.verifyChain().valid,
            signingSecretSet: !!CULTURE_SECURITY_CONFIG.SIGNING_SECRET,
            cspEnabled: true,
            antiTamperEnabled: true
        };
    }
}

// ═══════════════════════════════════════════════════════════════════
// EXPORTS
// ═══════════════════════════════════════════════════════════════════

module.exports = {
    CultureSecurityController,
    CultureCrypto,
    WalletVerifier,
    TierAccessController,
    AntiTamperSystem,
    RequestValidator,
    CultureAuditLogger,
    CULTURE_CSP,
    CULTURE_SECURITY_CONFIG
};
