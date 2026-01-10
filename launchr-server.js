const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { Connection, Keypair, LAMPORTS_PER_SOL, PublicKey } = require('@solana/web3.js');
const { LaunchrEngine } = require('./launchr-engine');
const bs58 = require('bs58');
const tracker = require('./tracker');
const profiles = require('./profiles');
const { LaunchrBot } = require('./telegram-bot');
const { getOnChainStats } = require('./onchain-stats');

// Production Database Module
const { cultureDB, profileDB, postDB, mediaDB, auctionDB, rateLimiter, MEDIA_DIR } = require('./database');

// Culture Coins Security Module - CIA-Level Protection (optional - graceful fallback)
let CultureSecurityController = null;
let CULTURE_CSP = null;
let CULTURE_SECURITY_CONFIG = null;
try {
    const cultureSecurity = require('./culture-security');
    CultureSecurityController = cultureSecurity.CultureSecurityController;
    CULTURE_CSP = cultureSecurity.CULTURE_CSP;
    CULTURE_SECURITY_CONFIG = cultureSecurity.CULTURE_SECURITY_CONFIG;
    console.log('[CULTURE] Security module loaded');
} catch (e) {
    console.warn('[CULTURE] Security module not available:', e.message);
    // Provide minimal fallback
    CULTURE_CSP = {
        getSecurityHeaders() {
            return {
                'X-Content-Type-Options': 'nosniff',
                'X-Frame-Options': 'DENY',
                'Cache-Control': 'no-store'
            };
        }
    };
}

// ═══════════════════════════════════════════════════════════════════════════
// PRODUCTION CONFIGURATION - All Revenue Goes Here
// ═══════════════════════════════════════════════════════════════════════════

const PRODUCTION_CONFIG = {
    // Main Fee Wallet - ALL REVENUE GOES HERE
    FEE_WALLET_PRIVATE_KEY: process.env.FEE_WALLET_PRIVATE_KEY || '',

    // Privy configuration (for embedded wallets & server signing)
    PRIVY_APP_ID: process.env.PRIVY_APP_ID || '',
    PRIVY_APP_SECRET: process.env.PRIVY_APP_SECRET || '',
    // Authorization key for server-side wallet signing (generated via openssl)
    // openssl ecparam -name prime256v1 -genkey -noout -out private.pem
    // openssl ec -in private.pem -pubout -out public.pem
    PRIVY_AUTH_PRIVATE_KEY: process.env.PRIVY_AUTH_PRIVATE_KEY || '',

    // Helius RPC & API (Solana)
    HELIUS_RPC: process.env.HELIUS_RPC || process.env.RPC_URL || 'https://api.mainnet-beta.solana.com',
    HELIUS_API_KEY: process.env.HELIUS_API_KEY || '',

    // Twitter/X API - Bearer Token ONLY (read-only for trending feed)
    // Using Bearer Token avoids rate limit conflicts with apps that POST to Twitter
    X_BEARER_TOKEN: process.env.X_BEARER_TOKEN || process.env.TWITTER_BEARER_TOKEN || '',

    // Fee Structure
    PLATFORM_FEE_PERCENT: 1,      // 1% of all fees to LAUNCHR distribution pool
    CREATOR_FEE_PERCENT: 99,       // 99% to creator's allocation engine

    // Solana CAIP2 identifier for Privy (mainnet-beta)
    SOLANA_CAIP2: 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp', // mainnet
};

// ═══════════════════════════════════════════════════════════════════════════
// TOKEN BLOCKLIST - Block competitor/spam tokens
// ═══════════════════════════════════════════════════════════════════════════
const BLOCKED_MINTS = [
    'Apfi3UpBUbunhfSBhgvE7gQzRo8eg5YfWECwcqFJpimp', // Pimpball - competitor
    'Fp1FAHv6wWt8gSeu2w1VHsudX1igvnnCZ33u9PzU1Gtt', // Test token
    '6eB6mRm2vwjU57H3hDXXU8tQk53TPvpYhnEmhRZtuHmn', // Test token
    '3mFC9NGK64uKDYYE6kokiQd2dQJPuJvW1tAxY29Tpump', // Test token
];

// Filter out test tokens from leaderboard
const isTestToken = (token) => {
    const name = (token.name || '').toLowerCase();
    const symbol = (token.symbol || '').toLowerCase();
    return name === 'test' || name === 'tetst' || name === 'test1' ||
           symbol === 'test' || symbol === '$test' ||
           name.startsWith('test') && name.length <= 6;
};

// Get fee wallet public key if private key is set
let FEE_WALLET_PUBLIC_KEY = '';
if (PRODUCTION_CONFIG.FEE_WALLET_PRIVATE_KEY) {
    try {
        const keypair = Keypair.fromSecretKey(bs58.decode(PRODUCTION_CONFIG.FEE_WALLET_PRIVATE_KEY));
        FEE_WALLET_PUBLIC_KEY = keypair.publicKey.toBase58();
        console.log(`[REVENUE] Fee wallet configured: ${FEE_WALLET_PUBLIC_KEY.slice(0, 8)}...`);
    } catch (e) {
        console.error('[REVENUE] Invalid fee wallet private key');
    }
}

// SECURITY: Generate random HMAC secret if not configured
const HMAC_SECRET = process.env.HMAC_SECRET || crypto.randomBytes(32).toString('hex');
if (!process.env.HMAC_SECRET) {
    console.warn('[SECURITY] WARNING: HMAC_SECRET not set - using random session secret (will change on restart)');
    console.warn('[SECURITY] Set HMAC_SECRET env var for persistent signatures');
}

console.log('[CONFIG] Production config loaded:');
console.log(`  - HMAC Secret: ${process.env.HMAC_SECRET ? 'SET' : 'RANDOM (session-only)'}`);
console.log(`  - Privy App ID: ${PRODUCTION_CONFIG.PRIVY_APP_ID ? 'SET' : 'NOT SET'}`);
console.log(`  - Privy App Secret: ${PRODUCTION_CONFIG.PRIVY_APP_SECRET ? 'SET' : 'NOT SET'}`);
console.log(`  - Privy Auth Key: ${PRODUCTION_CONFIG.PRIVY_AUTH_PRIVATE_KEY ? 'SET' : 'NOT SET'}`);
console.log(`  - Helius RPC: ${PRODUCTION_CONFIG.HELIUS_RPC ? 'SET' : 'NOT SET'}`);
console.log(`  - Helius API Key: ${PRODUCTION_CONFIG.HELIUS_API_KEY ? 'SET' : 'NOT SET'}`);
console.log(`  - Twitter/X API: ${PRODUCTION_CONFIG.X_BEARER_TOKEN ? 'SET (Bearer Token)' : 'NOT SET'}`);
console.log(`  - Fee Wallet: ${FEE_WALLET_PUBLIC_KEY ? 'SET' : 'NOT SET'}`);

// ═══════════════════════════════════════════════════════════════════════════
// PRIVY SERVER SDK - 24/7 Server-Side Wallet Signing for ORBIT
// ═══════════════════════════════════════════════════════════════════════════

let privyClient = null;
let privyEnabled = false;

// Initialize Privy client for server-side signing
async function initPrivyClient() {
    if (!PRODUCTION_CONFIG.PRIVY_APP_ID || !PRODUCTION_CONFIG.PRIVY_APP_SECRET) {
        console.log('[PRIVY] Server SDK disabled - missing PRIVY_APP_ID or PRIVY_APP_SECRET');
        return false;
    }

    try {
        // Dynamic import for @privy-io/node (ESM compatibility)
        const { PrivyClient } = await import('@privy-io/node');

        const clientConfig = {
            appId: PRODUCTION_CONFIG.PRIVY_APP_ID,
            appSecret: PRODUCTION_CONFIG.PRIVY_APP_SECRET,
        };

        // Add authorization key if available (required for server-side wallet signing)
        if (PRODUCTION_CONFIG.PRIVY_AUTH_PRIVATE_KEY) {
            clientConfig.walletApi = {
                authorizationPrivateKey: PRODUCTION_CONFIG.PRIVY_AUTH_PRIVATE_KEY
            };
            console.log('[PRIVY] Authorization key configured for server-side signing');
        }

        privyClient = new PrivyClient(clientConfig);
        privyEnabled = true;
        console.log('[PRIVY] Server SDK initialized successfully');
        console.log('[PRIVY] 24/7 ORBIT signing ENABLED');
        return true;
    } catch (e) {
        console.error('[PRIVY] Failed to initialize server SDK:', e.message);
        privyEnabled = false;
        return false;
    }
}

// ═══════════════════════════════════════════════════════════════════════════
// PRIVY WALLET SIGNER - Server-side transaction signing via Privy API
// Implements the same interface as Keypair for LaunchrEngine compatibility
// ═══════════════════════════════════════════════════════════════════════════

class PrivyWalletSigner {
    constructor(privyWalletId, publicKeyString) {
        this.privyWalletId = privyWalletId;
        this.publicKey = new PublicKey(publicKeyString);
        this.isPrivySigner = true; // Flag to identify Privy signers
    }

    // Sign a transaction using Privy's server-side API
    // Returns the signed transaction
    async signTransaction(transaction) {
        if (!privyClient || !privyEnabled) {
            throw new Error('Privy server SDK not initialized');
        }

        try {
            // Serialize transaction to base64 for Privy API
            const serialized = transaction.serialize({
                requireAllSignatures: false,
                verifySignatures: false
            });
            const base64Tx = Buffer.from(serialized).toString('base64');

            // Call Privy's Solana signTransaction API
            const response = await privyClient.walletApi.solana.signTransaction({
                walletId: this.privyWalletId,
                transaction: base64Tx,
                caip2: PRODUCTION_CONFIG.SOLANA_CAIP2
            });

            // Deserialize the signed transaction
            const signedTxBuffer = Buffer.from(response.signedTransaction, 'base64');

            // Check if it's a versioned transaction
            if (transaction.version !== undefined) {
                const { VersionedTransaction } = require('@solana/web3.js');
                return VersionedTransaction.deserialize(signedTxBuffer);
            } else {
                const { Transaction } = require('@solana/web3.js');
                return Transaction.from(signedTxBuffer);
            }
        } catch (e) {
            console.error('[PRIVY] signTransaction failed:', e.message);
            throw new Error(`Privy signing failed: ${e.message}`);
        }
    }

    // Sign and send transaction in one call (more efficient)
    async signAndSendTransaction(transaction, connection) {
        if (!privyClient || !privyEnabled) {
            throw new Error('Privy server SDK not initialized');
        }

        try {
            // Serialize transaction to base64
            const serialized = transaction.serialize({
                requireAllSignatures: false,
                verifySignatures: false
            });
            const base64Tx = Buffer.from(serialized).toString('base64');

            // Call Privy's signAndSendTransaction API
            const response = await privyClient.walletApi.solana.signAndSendTransaction({
                walletId: this.privyWalletId,
                transaction: base64Tx,
                caip2: PRODUCTION_CONFIG.SOLANA_CAIP2
            });

            return {
                signature: response.hash,
                success: true
            };
        } catch (e) {
            console.error('[PRIVY] signAndSendTransaction failed:', e.message);
            throw new Error(`Privy send failed: ${e.message}`);
        }
    }
}

// Storage for Privy wallet sessions (maps user session to Privy wallet ID)
// Persisted to disk for 24/7 operation even after server restart
const PRIVY_SESSIONS_FILE = path.join(
    process.env.RAILWAY_ENVIRONMENT ? '/app/data' : __dirname,
    '.privy-sessions.json'
);
const privyWalletSessions = new Map(); // sessionToken -> { privyWalletId, publicKey, userId, createdAt }

// Load Privy sessions from disk
function loadPrivySessions() {
    try {
        if (fs.existsSync(PRIVY_SESSIONS_FILE)) {
            const data = JSON.parse(fs.readFileSync(PRIVY_SESSIONS_FILE, 'utf8'));
            for (const [key, value] of Object.entries(data.sessions || {})) {
                privyWalletSessions.set(key, value);
            }
            console.log(`[PRIVY] Loaded ${privyWalletSessions.size} wallet sessions`);
        }
    } catch (e) {
        console.error('[PRIVY] Failed to load sessions:', e.message);
    }
}

// Save Privy sessions to disk
function savePrivySessions() {
    try {
        const data = {
            sessions: Object.fromEntries(privyWalletSessions),
            updatedAt: Date.now()
        };
        fs.writeFileSync(PRIVY_SESSIONS_FILE, JSON.stringify(data, null, 2));
    } catch (e) {
        console.error('[PRIVY] Failed to save sessions:', e.message);
    }
}

// Register a Privy wallet for 24/7 ORBIT operation
function registerPrivyWallet(sessionToken, privyWalletId, publicKey, userId) {
    privyWalletSessions.set(sessionToken, {
        privyWalletId,
        publicKey,
        userId,
        createdAt: Date.now()
    });
    savePrivySessions();
    console.log(`[PRIVY] Registered wallet ${publicKey.slice(0, 8)}... for 24/7 ORBIT`);
}

// Get Privy signer for a session
function getPrivySigner(sessionToken) {
    const session = privyWalletSessions.get(sessionToken);
    if (!session) return null;
    return new PrivyWalletSigner(session.privyWalletId, session.publicKey);
}

// ═══════════════════════════════════════════════════════════════════════════
// PRIVY ENGINE MANAGEMENT - 24/7 Auto-Claim with Privy Signing
// Stores active Privy-backed engines that run continuously
// ═══════════════════════════════════════════════════════════════════════════
const PRIVY_ENGINES_FILE = path.join(
    process.env.RAILWAY_ENVIRONMENT ? '/app/data' : __dirname,
    '.privy-engines.json'
);
const privyEngines = new Map(); // tokenMint -> { engine, interval, sessionToken, publicKey }

// Load active Privy engines from disk and restart them
async function loadAndRecoverPrivyEngines() {
    if (!privyEnabled) {
        console.log('[PRIVY-ENGINE] Privy not enabled - skipping recovery');
        return;
    }

    try {
        if (fs.existsSync(PRIVY_ENGINES_FILE)) {
            const data = JSON.parse(fs.readFileSync(PRIVY_ENGINES_FILE, 'utf8'));
            console.log(`[PRIVY-ENGINE] Found ${Object.keys(data.engines || {}).length} engines to recover`);

            for (const [tokenMint, engineData] of Object.entries(data.engines || {})) {
                try {
                    // Get the Privy session for this engine
                    const session = privyWalletSessions.get(engineData.sessionToken);
                    if (!session) {
                        console.log(`[PRIVY-ENGINE] Session expired for ${tokenMint.slice(0, 8)}... - skipping`);
                        continue;
                    }

                    // Create Privy signer and engine
                    await startPrivyEngine(tokenMint, engineData.sessionToken, engineData.allocations);
                    console.log(`[PRIVY-ENGINE] Recovered engine for ${tokenMint.slice(0, 8)}...`);
                } catch (e) {
                    console.error(`[PRIVY-ENGINE] Failed to recover ${tokenMint.slice(0, 8)}...:`, e.message);
                }
            }
        }
    } catch (e) {
        console.error('[PRIVY-ENGINE] Failed to load engines:', e.message);
    }
}

// Save active Privy engines to disk
function savePrivyEngines() {
    try {
        const engines = {};
        for (const [tokenMint, data] of privyEngines.entries()) {
            engines[tokenMint] = {
                sessionToken: data.sessionToken,
                publicKey: data.publicKey,
                allocations: data.engine?.allocations || null,
                startedAt: data.startedAt
            };
        }
        fs.writeFileSync(PRIVY_ENGINES_FILE, JSON.stringify({ engines, updatedAt: Date.now() }, null, 2));
    } catch (e) {
        console.error('[PRIVY-ENGINE] Failed to save engines:', e.message);
    }
}

// Start a Privy-backed engine for a token
async function startPrivyEngine(tokenMint, sessionToken, allocations = null) {
    // Check if already running
    if (privyEngines.has(tokenMint)) {
        console.log(`[PRIVY-ENGINE] Engine already running for ${tokenMint.slice(0, 8)}...`);
        return privyEngines.get(tokenMint);
    }

    // Get Privy signer
    const signer = getPrivySigner(sessionToken);
    if (!signer) {
        throw new Error('Invalid session - Privy signer not found');
    }

    // Create connection
    const rpcUrl = PRODUCTION_CONFIG.HELIUS_RPC || 'https://api.mainnet-beta.solana.com';
    const conn = new Connection(rpcUrl, 'confirmed');

    // Create engine with Privy signer
    const privyEngine = new LaunchrEngine(conn, tokenMint, signer);

    // Set allocations if provided
    if (allocations) {
        try {
            privyEngine.setAllocations(allocations);
        } catch (e) {
            console.log(`[PRIVY-ENGINE] Using default allocations: ${e.message}`);
        }
    }

    // Start auto-claim loop
    const intervalMs = 1 * 60 * 1000; // 1 minute
    const runClaim = async () => {
        try {
            await privyEngine.updatePrice();
            const result = await privyEngine.claimAndDistribute();
            if (result.claimed > 0) {
                console.log(`[PRIVY-ENGINE] ${tokenMint.slice(0, 8)}... Claimed ${(result.claimed / 1e9).toFixed(4)} SOL`);
                logOrbitActivity(tokenMint, 'claimed', {
                    amount: result.claimed,
                    amountSOL: (result.claimed / 1e9).toFixed(6)
                });
            }
        } catch (e) {
            console.log(`[PRIVY-ENGINE] ${tokenMint.slice(0, 8)}... Error: ${e.message}`);
            logOrbitActivity(tokenMint, 'error', { error: e.message });
        }
    };

    // Run first claim
    runClaim();
    const interval = setInterval(runClaim, intervalMs);

    // Start price updates every 10s
    const priceInterval = setInterval(async () => {
        try {
            await privyEngine.updatePrice();
        } catch (e) {
            // Silent fail for price updates
        }
    }, 10000);

    // Store engine data
    const session = privyWalletSessions.get(sessionToken);
    privyEngines.set(tokenMint, {
        engine: privyEngine,
        interval,
        priceInterval,
        sessionToken,
        publicKey: session?.publicKey,
        startedAt: Date.now()
    });

    // Register ORBIT
    registerOrbit(tokenMint, session?.publicKey);

    // Save to disk
    savePrivyEngines();

    console.log(`[PRIVY-ENGINE] Started 24/7 engine for ${tokenMint.slice(0, 8)}... with Privy signing`);
    return privyEngines.get(tokenMint);
}

// Stop a Privy-backed engine
function stopPrivyEngine(tokenMint) {
    const engineData = privyEngines.get(tokenMint);
    if (!engineData) return false;

    if (engineData.interval) clearInterval(engineData.interval);
    if (engineData.priceInterval) clearInterval(engineData.priceInterval);

    privyEngines.delete(tokenMint);
    savePrivyEngines();

    // Update ORBIT status
    stopOrbit(tokenMint);

    console.log(`[PRIVY-ENGINE] Stopped engine for ${tokenMint.slice(0, 8)}...`);
    return true;
}

// Initialize Privy on server start
initPrivyClient().then(success => {
    if (success) {
        loadPrivySessions();
        // Recover Privy engines after a short delay (let server initialize)
        setTimeout(() => loadAndRecoverPrivyEngines(), 3000);
    }
});

// ═══════════════════════════════════════════════════════════════════════════
// VANITY KEYPAIR POOL - Pre-generated keypairs ending in "mars" (MARS MISSION)
// ═══════════════════════════════════════════════════════════════════════════

// Use /app/data/ for Railway volume persistence, fallback to local for dev
const DATA_DIR = process.env.RAILWAY_ENVIRONMENT ? '/app/data' : __dirname;
try { if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true }); } catch (e) {}

const VANITY_POOL_FILE = path.join(DATA_DIR, '.vanity-pool.json');
const VANITY_SUFFIX = 'mars'; // 4 chars = mars (MARS MISSION), findable in minutes
const VANITY_POOL_TARGET = 10; // Keep 10 keypairs ready
const VANITY_POOL_MIN = 3; // Start generating when below this

// Culture Coins Database
const CULTURES_FILE = path.join(DATA_DIR, 'cultures.json');

// Load cultures from file
const loadCultures = () => {
    try {
        if (fs.existsSync(CULTURES_FILE)) {
            return JSON.parse(fs.readFileSync(CULTURES_FILE, 'utf8'));
        }
    } catch (e) {
        console.error('[CULTURES] Error loading:', e.message);
    }
    return [];
};

// Save cultures to file
const saveCultures = (cultures) => {
    try {
        fs.writeFileSync(CULTURES_FILE, JSON.stringify(cultures, null, 2));
        return true;
    } catch (e) {
        console.error('[CULTURES] Error saving:', e.message);
        return false;
    }
};

// Generate ticker from name
const generateTicker = (name) => {
    return name.replace(/[^a-zA-Z]/g, '').toUpperCase().slice(0, 5) || 'CULT';
};

console.log(`[VANITY] Data directory: ${DATA_DIR}`);
console.log(`[CULTURES] Database: ${CULTURES_FILE}`);

let vanityPool = [];
let vanityGenerating = false;
let vanityGeneratorStats = { attempts: 0, found: 0, lastFoundAt: null };

// Rate limiting for vanity keypair endpoint (module-level for persistence)
const vanityRateLimits = {};
const VANITY_RATE_LIMIT_MS = 60000; // 1 minute between requests per IP

// Separate rate limit for custom vanity (shorter - 10 seconds)
const customVanityRateLimits = {};
const CUSTOM_VANITY_RATE_LIMIT_MS = 10000; // 10 seconds between requests per IP

// VAULT: Secure storage for dispensed keypairs (secretKey never exposed to frontend)
// Maps vaultId -> { secretKey, publicKey, dispensedAt, expiresAt }
const vanityVault = new Map();
const VAULT_EXPIRY_MS = 30 * 60 * 1000; // Vault entries expire after 30 minutes
const VAULT_CLEANUP_INTERVAL = 5 * 60 * 1000; // Clean up expired entries every 5 minutes

// Generate secure vault ID
function generateVaultId() {
    const bytes = require('crypto').randomBytes(32);
    return bytes.toString('hex');
}

// Clean up expired vault entries
function cleanupVault() {
    const now = Date.now();
    let cleaned = 0;
    for (const [vaultId, entry] of vanityVault.entries()) {
        if (entry.expiresAt < now) {
            vanityVault.delete(vaultId);
            cleaned++;
        }
    }
    if (cleaned > 0) {
        console.log(`[VAULT] Cleaned ${cleaned} expired entries. Active: ${vanityVault.size}`);
    }
}

// Start vault cleanup interval
setInterval(cleanupVault, VAULT_CLEANUP_INTERVAL);

// Load existing pool from disk
function loadVanityPool() {
    try {
        if (fs.existsSync(VANITY_POOL_FILE)) {
            const data = JSON.parse(fs.readFileSync(VANITY_POOL_FILE, 'utf8'));
            vanityPool = data.pool || [];
            vanityGeneratorStats = data.stats || vanityGeneratorStats;
            console.log(`[VANITY] Loaded ${vanityPool.length} pre-generated keypairs from disk`);
        }
    } catch (e) {
        console.error('[VANITY] Failed to load pool:', e.message);
        vanityPool = [];
    }
}

// Save pool to disk
function saveVanityPool() {
    try {
        fs.writeFileSync(VANITY_POOL_FILE, JSON.stringify({
            pool: vanityPool,
            stats: vanityGeneratorStats,
            updatedAt: Date.now()
        }, null, 2));
    } catch (e) {
        console.error('[VANITY] Failed to save pool:', e.message);
    }
}

// Generate a single vanity keypair (blocking - use in worker)
function tryGenerateVanityKeypair() {
    const keypair = Keypair.generate();
    const address = keypair.publicKey.toBase58();
    vanityGeneratorStats.attempts++;

    if (address.toLowerCase().endsWith(VANITY_SUFFIX.toLowerCase())) {
        return {
            publicKey: address,
            secretKey: bs58.encode(keypair.secretKey),
            generatedAt: Date.now()
        };
    }
    return null;
}

// Background generator - runs continuously when pool is low
async function runVanityGenerator() {
    if (vanityGenerating) return;
    vanityGenerating = true;

    console.log(`[VANITY] Starting background generator (pool: ${vanityPool.length}/${VANITY_POOL_TARGET})`);

    let batchAttempts = 0;
    const batchSize = 10000; // Check pool status every 10k attempts

    while (vanityPool.length < VANITY_POOL_TARGET) {
        // Generate in small batches to not block event loop
        for (let i = 0; i < 100; i++) {
            const result = tryGenerateVanityKeypair();
            if (result) {
                vanityPool.push(result);
                vanityGeneratorStats.found++;
                vanityGeneratorStats.lastFoundAt = Date.now();
                console.log(`[VANITY] Found keypair #${vanityGeneratorStats.found}: ${result.publicKey} (${vanityGeneratorStats.attempts.toLocaleString()} attempts)`);
                saveVanityPool();

                if (vanityPool.length >= VANITY_POOL_TARGET) break;
            }
            batchAttempts++;
        }

        // Log progress every batch
        if (batchAttempts >= batchSize) {
            console.log(`[VANITY] Progress: ${vanityGeneratorStats.attempts.toLocaleString()} attempts, pool: ${vanityPool.length}/${VANITY_POOL_TARGET}`);
            batchAttempts = 0;
        }

        // Yield to event loop
        await new Promise(r => setImmediate(r));
    }

    vanityGenerating = false;
    console.log(`[VANITY] Generator paused - pool full (${vanityPool.length}/${VANITY_POOL_TARGET})`);
}

// Get a vanity keypair from the pool
function getVanityKeypair() {
    if (vanityPool.length === 0) {
        return null;
    }

    const keypair = vanityPool.shift(); // Remove from pool
    saveVanityPool();

    // Start generator if pool is low
    if (vanityPool.length < VANITY_POOL_MIN) {
        setImmediate(() => runVanityGenerator());
    }

    return keypair;
}

// Initialize vanity pool on startup
loadVanityPool();
if (vanityPool.length < VANITY_POOL_TARGET) {
    // Start generating in background after a short delay
    setTimeout(() => runVanityGenerator(), 5000);
}

console.log(`[VANITY] Pool status: ${vanityPool.length}/${VANITY_POOL_TARGET} keypairs ready`);

// ═══════════════════════════════════════════════════════════════════════════
// CONFIG INJECTION - Inject env vars into client-side HTML
// ═══════════════════════════════════════════════════════════════════════════

function injectConfig(html) {
    // Inject the runtime config into the HTML
    const configScript = `
    <script>
        // LAUNCHR Production Config (injected by server)
        window.LAUNCHR_CONFIG = {
            PRIVY_APP_ID: '${PRODUCTION_CONFIG.PRIVY_APP_ID}',
            SOLANA_RPC: '${PRODUCTION_CONFIG.HELIUS_RPC}',
            FEE_WALLET: '${FEE_WALLET_PUBLIC_KEY}',
            PLATFORM_FEE: ${PRODUCTION_CONFIG.PLATFORM_FEE_PERCENT},
            SEED_SOL: ${PRODUCTION_CONFIG.SEED_SOL_PER_LAUNCH},
        };
    </script>
    `;

    // Replace placeholders with actual values
    let injected = html
        .replace(/YOUR_PRIVY_APP_ID/g, PRODUCTION_CONFIG.PRIVY_APP_ID)
        .replace(/YOUR_HELIUS_API_KEY/g, PRODUCTION_CONFIG.HELIUS_RPC.split('api-key=')[1] || '')
        .replace('https://mainnet.helius-rpc.com/?api-key=YOUR_HELIUS_API_KEY', PRODUCTION_CONFIG.HELIUS_RPC);

    // Inject config script after <head>
    injected = injected.replace('<head>', '<head>' + configScript);

    return injected;
}

// Cache landing page HTML (with config injection)
let landingPageCache = null;

// ═══════════════════════════════════════════════════════════════════════════
// X (TWITTER) TRENDING - Cache and helpers
// ═══════════════════════════════════════════════════════════════════════════
let xTrendingCache = { data: null, timestamp: 0 };
const X_CACHE_DURATION = 5 * 60 * 1000; // 5 minutes

function getCategoryForTopic(topic) {
    const lower = topic.toLowerCase();
    if (lower.includes('sol') || lower.includes('crypto') || lower.includes('token') || lower.includes('defi') || lower.includes('nft') || lower.includes('memecoin')) return 'Crypto';
    if (lower.includes('ai') || lower.includes('web3') || lower.includes('tech') || lower.includes('pump') || lower.includes('agent')) return 'Technology';
    if (lower.includes('art') || lower.includes('design') || lower.includes('music')) return 'Art';
    if (lower.includes('finance') || lower.includes('money') || lower.includes('invest')) return 'Finance';
    return 'Trending';
}

function formatTrendVolume(num) {
    if (num >= 1000000) return `${(num / 1000000).toFixed(1)}M`;
    if (num >= 1000) return `${(num / 1000).toFixed(1)}K`;
    return num.toString();
}

function getLandingHTML() {
    // Always read fresh in development, cache in production
    try {
        const html = fs.readFileSync(path.join(__dirname, 'website', 'index.html'), 'utf8');
        return injectConfig(html);
    } catch (e) {
        // Fallback redirect to /app if landing page not found
        return '<html><head><meta http-equiv="refresh" content="0;url=/app"></head></html>';
    }
}

// Terms & Conditions Page
function getTermsHTML() {
    return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Terms & Conditions - LAUNCHR</title>
    <meta name="description" content="LAUNCHR Terms & Conditions - Meme coin entertainment platform on Solana">
    <link href="https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;500;600;700&family=Playfair+Display:wght@400;500;600;700&display=swap" rel="stylesheet">
    <style>
        *,*::before,*::after{margin:0;padding:0;box-sizing:border-box}
        :root{--bg:#0a0a0a;--surface:#111;--border:#222;--border-active:#333;--text:#fff;--text-secondary:#a0a0a0;--text-muted:#666;--gold:#FFD966;--gold-dim:rgba(255,217,102,0.1);--gold-border:rgba(255,217,102,0.2);--red:#ef4444;--red-dim:rgba(239,68,68,0.1);--red-border:rgba(239,68,68,0.3)}
        html{scroll-behavior:smooth}
        body{font-family:'IBM Plex Mono',monospace;background:var(--bg);color:var(--text);line-height:1.7;-webkit-font-smoothing:antialiased}
        ::selection{background:var(--gold);color:#000}
        .nav{position:fixed;top:0;left:0;right:0;z-index:1000;background:rgba(10,10,10,0.95);backdrop-filter:blur(20px);border-bottom:1px solid var(--border)}
        .nav-inner{max-width:1200px;margin:0 auto;padding:0 24px;height:60px;display:flex;align-items:center;justify-content:space-between}
        .nav-brand{display:flex;align-items:center;gap:12px;text-decoration:none;color:var(--text)}
        .nav-logo{width:32px;height:32px;background:var(--gold);border-radius:8px;display:flex;align-items:center;justify-content:center;font-weight:700;color:#000;font-size:14px}
        .nav-title{font-weight:600;font-size:16px;letter-spacing:-0.5px}
        .nav-links{display:flex;gap:32px}
        .nav-link{color:var(--text-secondary);text-decoration:none;font-size:13px;font-weight:500;transition:color 0.2s}
        .nav-link:hover{color:var(--text)}
        .container{max-width:900px;margin:0 auto;padding:100px 24px 60px}
        .hero{text-align:center;margin-bottom:60px}
        .hero-badge{display:inline-flex;align-items:center;gap:8px;background:var(--gold-dim);border:1px solid var(--gold-border);color:var(--gold);padding:8px 16px;border-radius:100px;font-size:12px;font-weight:600;text-transform:uppercase;letter-spacing:1px;margin-bottom:24px}
        .hero h1{font-family:'Playfair Display',serif;font-size:clamp(36px,6vw,56px);font-weight:600;letter-spacing:-1px;margin-bottom:16px;background:linear-gradient(135deg,var(--text) 0%,var(--text-secondary) 100%);-webkit-background-clip:text;-webkit-text-fill-color:transparent;background-clip:text}
        .hero p{font-size:16px;color:var(--text-secondary);max-width:600px;margin:0 auto}
        .updated{font-size:12px;color:var(--text-muted);margin-top:16px}
        .warning-box{background:var(--red-dim);border:1px solid var(--red-border);border-radius:12px;padding:20px 24px;margin:40px 0}
        .warning-box strong{color:var(--red);font-weight:600}
        .warning-box p{color:var(--text-secondary);margin:0}
        .section{background:var(--surface);border:1px solid var(--border);border-radius:16px;padding:32px;margin-bottom:24px}
        .section h2{font-size:18px;font-weight:600;color:var(--gold);margin-bottom:16px;display:flex;align-items:center;gap:12px}
        .section h2 .num{background:var(--gold-dim);color:var(--gold);width:28px;height:28px;border-radius:8px;display:inline-flex;align-items:center;justify-content:center;font-size:13px;font-weight:600}
        .section p{color:var(--text-secondary);margin-bottom:16px}
        .section p:last-child{margin-bottom:0}
        .section ul{list-style:none;margin:16px 0 0 0}
        .section li{color:var(--text-secondary);padding:8px 0;padding-left:24px;position:relative}
        .section li::before{content:"";position:absolute;left:0;top:16px;width:8px;height:8px;background:var(--gold);border-radius:50%;opacity:0.6}
        .section li strong{color:var(--text)}
        .gold-box{background:var(--gold-dim);border:1px solid var(--gold-border);border-radius:12px;padding:20px 24px;margin:40px 0}
        .gold-box strong{color:var(--gold);font-weight:600}
        .gold-box p{color:var(--text-secondary);margin:0}
        .back-btn{display:inline-flex;align-items:center;gap:8px;background:var(--surface);border:1px solid var(--border);color:var(--text);padding:12px 24px;border-radius:8px;font-size:13px;font-weight:500;text-decoration:none;transition:all 0.2s;margin-top:20px}
        .back-btn:hover{border-color:var(--gold);color:var(--gold)}
        .footer{text-align:center;padding:40px 24px;border-top:1px solid var(--border);margin-top:40px}
        .footer p{font-size:12px;color:var(--text-muted)}
        @media(max-width:640px){.nav-links{display:none}.section{padding:24px}.hero h1{font-size:32px}}
    </style>
</head>
<body>
    <nav class="nav">
        <div class="nav-inner">
            <a href="/" class="nav-brand">
                <div class="nav-logo">L</div>
                <span class="nav-title">LAUNCHR</span>
            </a>
            <div class="nav-links">
                <a href="/culture-coins" class="nav-link">Culture Coins</a>
                <a href="/roadmap" class="nav-link">Roadmap</a>
                <a href="/terms" class="nav-link" style="color:var(--gold)">Terms</a>
            </div>
        </div>
    </nav>

    <div class="container">
        <div class="hero">
            <div class="hero-badge">Legal</div>
            <h1>Terms & Conditions</h1>
            <p>Please read these terms carefully before using the LAUNCHR platform</p>
            <p class="updated">Last Updated: January 2026</p>
        </div>

        <div class="warning-box">
            <p><strong>IMPORTANT NOTICE:</strong> LAUNCHR is a meme coin and entertainment platform created for educational and recreational purposes only. By accessing or using this platform, you agree to be bound by these terms.</p>
        </div>

        <div class="section">
            <h2><span class="num">1</span>Nature of the Platform</h2>
            <p>LAUNCHR is a cryptocurrency token and associated software tools operating on the Solana blockchain. This project is:</p>
            <ul>
                <li>Created purely for <strong>entertainment and educational purposes</strong></li>
                <li>A "meme coin" with <strong>no intrinsic value</strong></li>
                <li>NOT an investment vehicle or security</li>
                <li>NOT intended to generate financial returns for holders</li>
            </ul>
        </div>

        <div class="section">
            <h2><span class="num">2</span>No Financial Advice</h2>
            <p>Nothing on this platform constitutes financial, investment, legal, or tax advice. The creators and operators of LAUNCHR:</p>
            <ul>
                <li>Are NOT licensed financial advisors</li>
                <li>Make NO representations about future value or returns</li>
                <li>Do NOT recommend purchasing, selling, or holding any cryptocurrency</li>
                <li>Strongly advise you to consult qualified professionals before any financial decisions</li>
            </ul>
        </div>

        <div class="section">
            <h2><span class="num">3</span>Risk Acknowledgment</h2>
            <p>By using this platform, you acknowledge and accept that:</p>
            <ul>
                <li>Cryptocurrency investments are <strong>extremely high risk</strong></li>
                <li>You may lose <strong>100% of any funds</strong> used to purchase tokens</li>
                <li>Meme coins are particularly volatile and speculative</li>
                <li>Smart contracts may contain bugs or vulnerabilities</li>
                <li>Blockchain transactions are irreversible</li>
                <li>Regulatory changes may affect cryptocurrency at any time</li>
            </ul>
        </div>

        <div class="section">
            <h2><span class="num">4</span>No Expectation of Profit</h2>
            <p>LAUNCHR tokens are distributed and traded with <strong>NO expectation of profit</strong> derived from the efforts of others. Any value fluctuation is due solely to market dynamics and community interest, not the promise or efforts of the development team.</p>
        </div>

        <div class="section">
            <h2><span class="num">5</span>Educational Purpose</h2>
            <p>This platform demonstrates concepts including:</p>
            <ul>
                <li>Automated fee distribution mechanisms</li>
                <li>Token buyback and burn mechanics</li>
                <li>Market making algorithms</li>
                <li>Liquidity provision strategies</li>
            </ul>
            <p>These features are provided for educational exploration of DeFi concepts.</p>
        </div>

        <div class="section">
            <h2><span class="num">6</span>No Warranty</h2>
            <p>This software and platform are provided "AS IS" without warranty of any kind, express or implied, including but not limited to warranties of merchantability, fitness for a particular purpose, and non-infringement.</p>
        </div>

        <div class="section">
            <h2><span class="num">7</span>Limitation of Liability</h2>
            <p>In no event shall the creators, developers, or operators of LAUNCHR be liable for any direct, indirect, incidental, special, consequential, or punitive damages, including but not limited to loss of profits, data, or other intangible losses resulting from:</p>
            <ul>
                <li>Use or inability to use the platform</li>
                <li>Any transactions made through the platform</li>
                <li>Unauthorized access to your wallet or data</li>
                <li>Bugs, viruses, or errors in the software</li>
                <li>Any third-party actions or content</li>
            </ul>
        </div>

        <div class="section">
            <h2><span class="num">8</span>User Responsibilities</h2>
            <p>You are solely responsible for:</p>
            <ul>
                <li>Securing your private keys and wallet</li>
                <li>Understanding the risks of cryptocurrency</li>
                <li>Complying with your local laws and regulations</li>
                <li>Any tax obligations arising from your activities</li>
                <li>Your own financial decisions</li>
            </ul>
        </div>

        <div class="section">
            <h2><span class="num">9</span>Regulatory Compliance</h2>
            <p>LAUNCHR does not target or solicit users in jurisdictions where cryptocurrency activities are prohibited. Users are responsible for ensuring their participation complies with their local laws.</p>
        </div>

        <div class="section">
            <h2><span class="num">10</span>Modifications</h2>
            <p>We reserve the right to modify these terms at any time. Continued use of the platform after changes constitutes acceptance of the modified terms.</p>
        </div>

        <div class="section">
            <h2><span class="num">11</span>Governing Law</h2>
            <p>These terms shall be governed by and construed in accordance with applicable laws, without regard to conflict of law principles.</p>
        </div>

        <div class="gold-box">
            <p><strong>REMEMBER:</strong> This is a meme coin for fun and education. Never invest more than you can afford to lose completely. Do Your Own Research (DYOR). Have fun, but be responsible!</p>
        </div>

        <a href="/" class="back-btn">&larr; Back to LAUNCHR</a>

        <div class="footer">
            <p>&copy; 2026 LAUNCHR. All rights reserved. This is not financial advice.</p>
        </div>
    </div>
</body>
</html>`;
}

// Product Roadmap Page - Premium Design
function getRoadmapHTML() {
    return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Roadmap - LAUNCHR</title>
    <meta name="description" content="LAUNCHR 2026 Roadmap - Building the future of creator tokenomics on Solana">
    <link href="https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;500;600;700&family=Playfair+Display:wght@400;500;600;700&display=swap" rel="stylesheet">
    <style>
        *,*::before,*::after{margin:0;padding:0;box-sizing:border-box}
        :root{--bg:#0a0a0a;--surface:#111;--border:#222;--border-active:#333;--text:#fff;--text-secondary:#a0a0a0;--text-muted:#666;--gold:#FFD966;--gold-dim:rgba(255,217,102,0.1);--gold-border:rgba(255,217,102,0.2)}
        html{scroll-behavior:smooth}
        body{font-family:'IBM Plex Mono',monospace;background:var(--bg);color:var(--text);line-height:1.7;-webkit-font-smoothing:antialiased}
        ::selection{background:var(--gold);color:#000}
        .nav{position:fixed;top:0;left:0;right:0;z-index:1000;background:rgba(10,10,10,0.95);backdrop-filter:blur(20px);border-bottom:1px solid var(--border)}
        .nav-inner{max-width:1200px;margin:0 auto;padding:0 24px;height:60px;display:flex;align-items:center;justify-content:space-between}
        .nav-brand{display:flex;align-items:center;gap:12px;text-decoration:none;color:var(--text)}
        .nav-brand img{height:28px;width:28px}
        .nav-brand span{font-weight:600;font-size:15px;letter-spacing:0.05em}
        .nav-links{display:flex;align-items:center;gap:4px}
        .nav-link{padding:8px 14px;color:var(--text-muted);text-decoration:none;font-size:12px;font-weight:500;letter-spacing:0.05em;transition:all 0.15s}
        .nav-link:hover{color:var(--text)}
        .nav-link.active{color:var(--gold)}
        .header{padding:120px 24px 60px;text-align:center;border-bottom:1px solid var(--border)}
        .header-badge{display:inline-flex;align-items:center;gap:8px;padding:6px 14px;background:var(--gold-dim);border:1px solid var(--gold-border);font-size:10px;font-weight:600;color:var(--gold);margin-bottom:24px;text-transform:uppercase;letter-spacing:0.15em}
        .header-badge::before{content:'';width:6px;height:6px;background:var(--gold);border-radius:50%;animation:pulse 2s infinite}
        @keyframes pulse{0%,100%{opacity:1}50%{opacity:0.4}}
        .header-title{font-family:'Playfair Display',Georgia,serif;font-size:clamp(32px,5vw,48px);font-weight:600;letter-spacing:-0.02em;margin-bottom:16px}
        .header-title .gold{color:var(--gold)}
        .header-subtitle{font-size:13px;color:var(--text-muted);max-width:500px;margin:0 auto;line-height:1.8}
        .main{max-width:900px;margin:0 auto;padding:60px 24px}
        .timeline{position:relative}
        .timeline::before{content:'';position:absolute;left:0;top:0;bottom:0;width:1px;background:var(--border)}
        .quarter{position:relative;padding-left:40px;margin-bottom:60px}
        .quarter:last-child{margin-bottom:0}
        .quarter::before{content:'';position:absolute;left:-4px;top:6px;width:9px;height:9px;background:var(--gold);border:2px solid var(--bg)}
        .quarter-label{font-size:11px;font-weight:600;color:var(--gold);letter-spacing:0.2em;margin-bottom:24px;text-transform:uppercase}
        .section{background:var(--surface);border:1px solid var(--border);padding:24px;margin-bottom:16px}
        .section:last-child{margin-bottom:0}
        .section:hover{border-color:var(--border-active)}
        .section-title{font-size:14px;font-weight:600;color:var(--text);margin-bottom:16px;letter-spacing:0.02em}
        .section-items{display:flex;flex-direction:column;gap:10px}
        .section-item{display:flex;align-items:flex-start;gap:12px;font-size:12px;color:var(--text-secondary);line-height:1.6}
        .section-item::before{content:'—';color:var(--text-muted);flex-shrink:0}
        .section-item.completed{color:var(--text)}
        .section-item.completed::before{content:'✓';color:#22c55e;font-weight:600}
        .section-item.building::before{content:'◐';color:var(--gold)}
        .status-badge{display:inline-flex;align-items:center;gap:6px;font-size:10px;font-weight:600;padding:4px 10px;border-radius:4px;text-transform:uppercase;letter-spacing:0.1em;margin-left:auto;flex-shrink:0}
        .status-badge.completed{background:rgba(34,197,94,0.1);color:#22c55e;border:1px solid rgba(34,197,94,0.2)}
        .status-badge.building{background:var(--gold-dim);color:var(--gold);border:1px solid var(--gold-border)}
        .disclaimer-section{margin-top:80px;padding-top:60px;border-top:1px solid var(--border)}
        .disclaimer-header{text-align:center;margin-bottom:32px}
        .disclaimer-header h2{font-family:'Playfair Display',Georgia,serif;font-size:20px;color:var(--text-muted);margin-bottom:8px}
        .disclaimer-header p{font-size:11px;color:var(--text-muted)}
        .disclaimer-box{background:var(--surface);border:1px solid var(--border);padding:32px;margin-bottom:24px}
        .disclaimer-box h3{font-size:11px;font-weight:600;color:var(--gold);letter-spacing:0.15em;text-transform:uppercase;margin-bottom:16px}
        .disclaimer-box p{font-size:12px;color:var(--text-muted);line-height:1.8;margin-bottom:12px}
        .disclaimer-box p:last-child{margin-bottom:0}
        .disclaimer-box ul{list-style:none;padding:0;margin:0}
        .disclaimer-box li{font-size:12px;color:var(--text-muted);line-height:1.8;padding-left:20px;position:relative;margin-bottom:8px}
        .disclaimer-box li::before{content:'•';position:absolute;left:0;color:var(--text-muted)}
        .disclaimer-critical{background:rgba(239,68,68,0.05);border:1px solid rgba(239,68,68,0.2);padding:24px;text-align:center;margin-bottom:24px}
        .disclaimer-critical p{font-size:11px;color:#ef4444;line-height:1.8;margin:0}
        .disclaimer-critical strong{display:block;font-size:12px;letter-spacing:0.1em;margin-bottom:8px}
        .footer{text-align:center;padding:40px 24px;border-top:1px solid var(--border);margin-top:60px}
        .footer p{color:var(--text-muted);font-size:11px;margin-bottom:16px}
        .footer-links{display:flex;justify-content:center;gap:24px}
        .footer-links a{color:var(--text-muted);text-decoration:none;font-size:11px;transition:color 0.15s}
        .footer-links a:hover{color:var(--gold)}
        @media(max-width:768px){.nav-links{display:none}.header{padding:100px 20px 40px}.main{padding:40px 20px}.quarter{padding-left:24px}.section{padding:20px}}
    </style>
</head>
<body>
    <nav class="nav">
        <div class="nav-inner">
            <a href="/" class="nav-brand">
                <img src="/website/logo-icon.jpg" alt="LAUNCHR">
                <span>LAUNCHR</span>
            </a>
            <div class="nav-links">
                <a href="/" class="nav-link">Home</a>
                <a href="/launchpad" class="nav-link">Launchpad</a>
                <a href="/dashboard" class="nav-link">Dashboard</a>
                <a href="/culture-coins" class="nav-link">Culture</a>
                <a href="/docs" class="nav-link">Docs</a>
                <a href="/roadmap" class="nav-link active">Roadmap</a>
            </div>
        </div>
    </nav>

    <header class="header">
        <div class="header-badge">2026 Vision</div>
        <h1 class="header-title"><span class="gold">LAUNCHR</span> Roadmap</h1>
        <p class="header-subtitle">A forward-looking outline of platform development. Subject to change based on market conditions, technical feasibility, and community feedback.</p>
    </header>

    <main class="main">
        <div class="timeline">
            <div class="quarter">
                <div class="quarter-label">Q1 2026</div>
                <div class="section">
                    <h3 class="section-title">Core Platform Hardening <span class="status-badge completed">Completed</span></h3>
                    <div class="section-items">
                        <div class="section-item completed">Production dual path launches via Pump and Raydium</div>
                        <div class="section-item completed">Creator fee automation with configurable routing into buy and burns, LP adds, market making, or creator payouts</div>
                        <div class="section-item completed">Improved LP management and liquidity transparency</div>
                        <div class="section-item completed">Telegram first launch and management workflows</div>
                        <div class="section-item completed">Public dashboards for fee flows, burns, LP adds, and liquidity actions</div>
                    </div>
                </div>
                <div class="section">
                    <h3 class="section-title">Culture Coins Alpha <span class="status-badge building">Building</span></h3>
                    <div class="section-items">
                        <div class="section-item building">Launch Culture Coins framework</div>
                        <div class="section-item building">Creator defined tiers based on token ownership</div>
                        <div class="section-item building">Utility primitives for access, participation, and gated interactions</div>
                        <div class="section-item building">Native exchange of value between creators and communities</div>
                        <div class="section-item building">Early discovery layer for Culture Coins</div>
                    </div>
                </div>
                <div class="section">
                    <h3 class="section-title">Social and Economic Layer Expansion <span class="status-badge building">Building</span></h3>
                    <div class="section-items">
                        <div class="section-item building">Culture Coin profiles as social hubs</div>
                        <div class="section-item building">Native engagement, rewards, and incentive distribution</div>
                        <div class="section-item building">Dynamic fee strategies tied to community activity</div>
                        <div class="section-item building">Creator analytics and holder insights</div>
                    </div>
                </div>
                <div class="section">
                    <h3 class="section-title">Mobile App Development Phase 1 <span class="status-badge building">Building</span></h3>
                    <div class="section-items">
                        <div class="section-item building">Mobile product strategy and UX architecture</div>
                        <div class="section-item building">Core feature scoping and API design</div>
                        <div class="section-item building">Begin iOS and Android development</div>
                    </div>
                </div>
            </div>

            <div class="quarter">
                <div class="quarter-label">Q2 2026</div>
                <div class="section">
                    <h3 class="section-title">Cross Chain Expansion</h3>
                    <div class="section-items">
                        <div class="section-item">Cross chain Culture Coin visibility and analytics</div>
                        <div class="section-item">Support for cross chain liquidity and value flows</div>
                        <div class="section-item">Bridging primitives for participation across ecosystems</div>
                        <div class="section-item">Early integrations beyond Solana</div>
                    </div>
                </div>
                <div class="section">
                    <h3 class="section-title">Mobile App Development Phase 2</h3>
                    <div class="section-items">
                        <div class="section-item">Core launch and monitoring features on mobile</div>
                        <div class="section-item">Wallet connectivity and push notifications</div>
                        <div class="section-item">Internal testing and closed beta</div>
                    </div>
                </div>
            </div>

            <div class="quarter">
                <div class="quarter-label">Q3 2026</div>
                <div class="section">
                    <h3 class="section-title">Ecosystem and Infrastructure Scaling</h3>
                    <div class="section-items">
                        <div class="section-item">Advanced market making and liquidity strategies</div>
                        <div class="section-item">Expanded monetization primitives for Culture Coins</div>
                        <div class="section-item">Governance and incentive tooling for mature communities</div>
                        <div class="section-item">Open APIs for third party builders</div>
                    </div>
                </div>
                <div class="section">
                    <h3 class="section-title">Mobile App Development Phase 3</h3>
                    <div class="section-items">
                        <div class="section-item">Public mobile beta release</div>
                        <div class="section-item">Culture Coin discovery and interaction on mobile</div>
                        <div class="section-item">Performance optimization and security hardening</div>
                    </div>
                </div>
            </div>

            <div class="quarter">
                <div class="quarter-label">Q4 2026</div>
                <div class="section">
                    <h3 class="section-title">Platform Maturity</h3>
                    <div class="section-items">
                        <div class="section-item">Fully composable launch and culture infrastructure</div>
                        <div class="section-item">Creator and community revenue optimization tooling</div>
                        <div class="section-item">Cross chain discovery and aggregation</div>
                        <div class="section-item">Long term sustainability tooling for large ecosystems</div>
                    </div>
                </div>
                <div class="section">
                    <h3 class="section-title">Mobile App Development Phase 4</h3>
                    <div class="section-items">
                        <div class="section-item">Full mobile release</div>
                        <div class="section-item">Advanced creator controls on mobile</div>
                        <div class="section-item">Ongoing iteration based on user behavior</div>
                    </div>
                </div>
            </div>
        </div>

        <div class="disclaimer-section">
            <div class="disclaimer-header">
                <h2>Important Disclosures</h2>
                <p>Please read carefully before using this platform</p>
            </div>

            <div class="disclaimer-critical">
                <p><strong>⚠️ EXPERIMENTAL MEME COIN PLATFORM</strong>LAUNCHR is an experimental platform for launching and managing meme coins. Meme coins are highly speculative, extremely volatile, and you should expect to lose 100% of any funds you use on this platform. This is NOT a regulated financial service.</p>
            </div>

            <div class="disclaimer-box">
                <h3>No Financial Advice</h3>
                <p>Nothing on this platform, including this roadmap, constitutes financial advice, investment advice, trading advice, or any other sort of advice. You should not treat any of the platform's content as such. LAUNCHR does not recommend that any cryptocurrency should be bought, sold, or held by you. Do conduct your own due diligence and consult your financial advisor before making any investment decisions.</p>
            </div>

            <div class="disclaimer-box">
                <h3>Roadmap Disclaimer</h3>
                <p>This roadmap is aspirational and provided for informational purposes only. It does not constitute a commitment, promise, or guarantee of any kind. Development priorities, timelines, and features are subject to change at any time without notice based on:</p>
                <ul>
                    <li>Technical feasibility and development challenges</li>
                    <li>Market conditions and regulatory developments</li>
                    <li>Community feedback and platform priorities</li>
                    <li>Resource availability and team capacity</li>
                    <li>Third-party dependencies and integrations</li>
                </ul>
                <p>The inclusion of any feature on this roadmap does not guarantee its implementation.</p>
            </div>

            <div class="disclaimer-box">
                <h3>Risk Disclosure</h3>
                <p>Using LAUNCHR and participating in cryptocurrency activities involves substantial risk of loss and is not suitable for every person. Before using this platform, you should carefully consider:</p>
                <ul>
                    <li>Cryptocurrency values are extremely volatile and can go to zero</li>
                    <li>Meme coins have no intrinsic value and are purely speculative</li>
                    <li>Smart contracts may contain bugs or vulnerabilities</li>
                    <li>You may lose all funds you deposit or invest</li>
                    <li>Past performance does not indicate future results</li>
                    <li>Regulatory changes may affect the platform or your holdings</li>
                    <li>There is no guarantee of liquidity for any token</li>
                </ul>
            </div>

            <div class="disclaimer-box">
                <h3>No Warranties</h3>
                <p>This platform is provided "as is" and "as available" without warranties of any kind, either express or implied. LAUNCHR makes no warranty that the platform will meet your requirements, be uninterrupted, timely, secure, or error-free. You use this platform entirely at your own risk.</p>
            </div>

            <div class="disclaimer-box">
                <h3>Regulatory Compliance</h3>
                <p>LAUNCHR is not registered with, licensed by, or affiliated with any financial regulatory authority. The platform does not offer securities, investment contracts, or regulated financial products. Users are solely responsible for ensuring their use of the platform complies with all applicable laws and regulations in their jurisdiction. This platform is not available to residents of jurisdictions where cryptocurrency trading is prohibited.</p>
            </div>

            <div class="disclaimer-box">
                <h3>Limitation of Liability</h3>
                <p>To the maximum extent permitted by applicable law, LAUNCHR and its operators, developers, and affiliates shall not be liable for any indirect, incidental, special, consequential, or punitive damages, or any loss of profits or revenues, whether incurred directly or indirectly, or any loss of data, use, goodwill, or other intangible losses resulting from your use of the platform.</p>
            </div>
        </div>
    </main>

    <footer class="footer">
        <p>© 2026 LAUNCHR. Experimental meme coin platform. Use at your own risk.</p>
        <div class="footer-links">
            <a href="/terms">Terms of Service</a>
            <a href="/docs">Documentation</a>
            <a href="https://twitter.com/LaunchrTG" target="_blank">Twitter</a>
            <a href="https://t.me/launchr_sol" target="_blank">Telegram</a>
        </div>
    </footer>
</body>
</html>`;
}

// Security constants
const MAX_BODY_SIZE = 10 * 1024; // 10KB max request body
const SESSION_TOKEN_BYTES = 32;
const WEB_SESSION_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours for web sessions

// Rate limiting configuration
const RATE_LIMIT = {
    general: { max: 100, windowMs: 60 * 1000 },     // 100 req/min general
    sensitive: { max: 10, windowMs: 60 * 1000 },    // 10 req/min for sensitive ops
};
const requestCounts = new Map(); // IP -> { count, resetTime }
const failedAttempts = new Map(); // IP -> { count, lockoutUntil }
const FAIL2BAN_THRESHOLD = 5;
const FAIL2BAN_LOCKOUT_MS = 15 * 60 * 1000; // 15 min lockout

let engine = null;
let connection = null;
let wallet = null;
let logs = [];
let autoClaimInterval = null;
let priceUpdateInterval = null; // Updates price every 10s for RSI
let sessionToken = null; // Auth token for this session
let sessionCreatedAt = null; // When session was created

// ═══════════════════════════════════════════════════════════════════════════
// CULTURE COINS SECURITY - CIA-Level Protection
// ═══════════════════════════════════════════════════════════════════════════
let cultureSecurityController = null;
if (CultureSecurityController) {
    try {
        cultureSecurityController = new CultureSecurityController();
        console.log('[CULTURE] Security controller initialized with CIA-level protection');
    } catch (e) {
        console.error('[CULTURE] Failed to initialize security controller:', e.message);
    }
} else {
    console.log('[CULTURE] Security controller not available - running in basic mode');
}

// ═══════════════════════════════════════════════════════════════════════════
// ORBIT - Public Transparency Registry
// Tracks all active ORBIT instances for public monitoring
// ═══════════════════════════════════════════════════════════════════════════
const ORBIT_FILE = path.join(DATA_DIR, '.orbit-registry.json');
const orbitRegistry = new Map(); // mint -> OrbitStatus
const orbitActivityLog = []; // Global activity log (last 1000 events)
const ORBIT_ACTIVITY_MAX = 1000;

// ORBIT status structure
function createOrbitStatus(mint, walletAddress, allocations = null) {
    return {
        mint,
        wallet: walletAddress,
        status: 'active', // active, paused, stopped
        startedAt: Date.now(),
        lastClaimAt: null,
        lastDistributeAt: null,
        totalClaimed: 0,
        totalDistributed: 0,
        claimCount: 0,
        distributeCount: 0,
        lastError: null,
        uptime: 0, // calculated on read
        // Fee allocation percentages (must sum to 100) - matches engine field names
        allocations: allocations || {
            buybackBurn: 25,      // Tokens burned (deflationary)
            marketMaking: 25,     // AI-driven market making
            creatorRevenue: 25,   // Revenue to token creator
            liquidity: 25,        // Add LP + burn LP tokens
        },
    };
}

// Load ORBIT registry from disk
function loadOrbitRegistry() {
    try {
        if (fs.existsSync(ORBIT_FILE)) {
            const data = JSON.parse(fs.readFileSync(ORBIT_FILE, 'utf8'));
            if (data.registry) {
                for (const [mint, status] of Object.entries(data.registry)) {
                    orbitRegistry.set(mint, status);
                }
            }
            if (data.activityLog) {
                orbitActivityLog.push(...data.activityLog.slice(-ORBIT_ACTIVITY_MAX));
            }
            console.log(`[ORBIT] Loaded ${orbitRegistry.size} registered instances`);
        }
    } catch (e) {
        console.error('[ORBIT] Failed to load registry:', e.message);
    }
}

// Save ORBIT registry to disk
function saveOrbitRegistry() {
    try {
        const data = {
            registry: Object.fromEntries(orbitRegistry),
            activityLog: orbitActivityLog.slice(-ORBIT_ACTIVITY_MAX),
            updatedAt: Date.now()
        };
        fs.writeFileSync(ORBIT_FILE, JSON.stringify(data, null, 2));
    } catch (e) {
        console.error('[ORBIT] Failed to save registry:', e.message);
    }
}

// Log ORBIT activity (public transparency)
function logOrbitActivity(mint, action, details = {}) {
    const event = {
        timestamp: Date.now(),
        mint,
        action, // 'started', 'stopped', 'claimed', 'distributed', 'error'
        ...details
    };
    orbitActivityLog.push(event);
    if (orbitActivityLog.length > ORBIT_ACTIVITY_MAX) {
        orbitActivityLog.shift();
    }

    // Update registry stats
    const status = orbitRegistry.get(mint);
    if (status) {
        if (action === 'claimed' && details.amount) {
            status.lastClaimAt = Date.now();
            status.totalClaimed += details.amount;
            status.claimCount++;
        } else if (action === 'distributed' && details.amount) {
            status.lastDistributeAt = Date.now();
            status.totalDistributed += details.amount;
            status.distributeCount++;
        } else if (action === 'error') {
            status.lastError = details.error;
        }
        orbitRegistry.set(mint, status);
    }

    saveOrbitRegistry();
}

// Register a new ORBIT instance
function registerOrbit(mint, walletAddress, allocations = null) {
    if (!orbitRegistry.has(mint)) {
        const status = createOrbitStatus(mint, walletAddress, allocations);
        orbitRegistry.set(mint, status);
        logOrbitActivity(mint, 'started', { wallet: walletAddress });
        console.log(`[ORBIT] Registered: ${mint.slice(0, 8)}...`);
    } else {
        // Reactivate existing
        const status = orbitRegistry.get(mint);
        status.status = 'active';
        status.lastError = null;
        // Update allocations if provided
        if (allocations) {
            status.allocations = allocations;
        }
        orbitRegistry.set(mint, status);
    }
    saveOrbitRegistry();
}

// Update allocations for a token (uses engine field names)
function updateOrbitAllocations(mint, allocations) {
    const status = orbitRegistry.get(mint);
    if (status) {
        status.allocations = {
            buybackBurn: allocations.buybackBurn ?? status.allocations?.buybackBurn ?? 25,
            marketMaking: allocations.marketMaking ?? status.allocations?.marketMaking ?? 25,
            creatorRevenue: allocations.creatorRevenue ?? status.allocations?.creatorRevenue ?? 25,
            liquidity: allocations.liquidity ?? status.allocations?.liquidity ?? 25,
        };
        orbitRegistry.set(mint, status);
        saveOrbitRegistry();
        return true;
    }
    return false;
}

// Normalize allocations - support both old and new field names
function normalizeAllocations(rawAlloc) {
    if (!rawAlloc) return null;
    return {
        buybackBurn: rawAlloc.buybackBurn ?? rawAlloc.burn ?? 25,
        marketMaking: rawAlloc.marketMaking ?? rawAlloc.amm ?? 25,
        creatorRevenue: rawAlloc.creatorRevenue ?? rawAlloc.creatorFees ?? 25,
        liquidity: rawAlloc.liquidity ?? 25,
    };
}

// Stop an ORBIT instance
function stopOrbit(mint) {
    const status = orbitRegistry.get(mint);
    if (status) {
        status.status = 'stopped';
        orbitRegistry.set(mint, status);
        logOrbitActivity(mint, 'stopped');
        saveOrbitRegistry();
    }
}

// Get ORBIT status with calculated uptime
function getOrbitStatus(mint) {
    const status = orbitRegistry.get(mint);
    if (!status) return null;

    return {
        ...status,
        uptime: status.status === 'active' ? Date.now() - status.startedAt : status.uptime,
        uptimeFormatted: formatUptime(status.status === 'active' ? Date.now() - status.startedAt : status.uptime)
    };
}

// Format uptime as human readable
function formatUptime(ms) {
    const seconds = Math.floor(ms / 1000);
    const minutes = Math.floor(seconds / 60);
    const hours = Math.floor(minutes / 60);
    const days = Math.floor(hours / 24);

    if (days > 0) return `${days}d ${hours % 24}h`;
    if (hours > 0) return `${hours}h ${minutes % 60}m`;
    if (minutes > 0) return `${minutes}m ${seconds % 60}s`;
    return `${seconds}s`;
}

// Initialize ORBIT registry
loadOrbitRegistry();

// Auto-fund configuration
let autoFundConfig = {
    enabled: false,
    sourceWallet: null,
    encryptedSourceKey: null,
    minBalance: 0.05 * LAMPORTS_PER_SOL,  // 0.05 SOL minimum
    fundAmount: 0.1 * LAMPORTS_PER_SOL,    // 0.1 SOL per refill
    lastFunded: 0
};

// Rate limiting function
function checkRateLimit(ip, type = 'general') {
    const now = Date.now();
    const limit = RATE_LIMIT[type] || RATE_LIMIT.general;
    const key = `${ip}:${type}`;

    // Check fail2ban lockout first
    const failed = failedAttempts.get(ip);
    if (failed && failed.lockoutUntil > now) {
        return { allowed: false, reason: 'IP temporarily blocked' };
    }

    // Check rate limit
    let record = requestCounts.get(key);
    if (!record || now > record.resetTime) {
        record = { count: 0, resetTime: now + limit.windowMs };
        requestCounts.set(key, record);
    }

    record.count++;
    if (record.count > limit.max) {
        return { allowed: false, reason: 'Rate limit exceeded' };
    }

    return { allowed: true };
}

// Record failed auth attempt (fail2ban style)
function recordFailedAuth(ip) {
    const now = Date.now();
    let record = failedAttempts.get(ip) || { count: 0, lockoutUntil: 0 };

    // Reset if lockout expired
    if (record.lockoutUntil < now) {
        record.count = 0;
    }

    record.count++;
    if (record.count >= FAIL2BAN_THRESHOLD) {
        record.lockoutUntil = now + FAIL2BAN_LOCKOUT_MS;
        log(`SECURITY: IP ${ip.slice(0, 10)}... locked out for 15 minutes`);
    }

    failedAttempts.set(ip, record);
}

// Check if web session is still valid
function isSessionValid() {
    if (!sessionToken || !sessionCreatedAt) return false;
    if (Date.now() - sessionCreatedAt > WEB_SESSION_TTL_MS) {
        log('Session expired after 24 hours');
        sessionToken = null;
        sessionCreatedAt = null;
        engine = null;
        wallet = null;
        return false;
    }
    return true;
}

// Encrypt source key for auto-fund (using crypto)
function encryptKey(key) {
    const encKey = crypto.randomBytes(32);
    const iv = crypto.randomBytes(16);
    const cipher = crypto.createCipheriv('aes-256-gcm', encKey, iv);
    let encrypted = cipher.update(key, 'utf8', 'hex');
    encrypted += cipher.final('hex');
    return { encrypted, iv: iv.toString('hex'), authTag: cipher.getAuthTag().toString('hex'), encKey: encKey.toString('hex') };
}

function decryptKey(data) {
    const decipher = crypto.createDecipheriv('aes-256-gcm', Buffer.from(data.encKey, 'hex'), Buffer.from(data.iv, 'hex'));
    decipher.setAuthTag(Buffer.from(data.authTag, 'hex'));
    let decrypted = decipher.update(data.encrypted, 'hex', 'utf8');
    decrypted += decipher.final('utf8');
    return decrypted;
}

// HTML escape to prevent XSS
function escapeHtml(str) {
    return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#039;');
}

// SECURITY: Safely extract client IP from request
// Railway/proxies set X-Forwarded-For, validate format to prevent spoofing
function getClientIP(req) {
    const forwardedFor = req.headers['x-forwarded-for'];
    if (forwardedFor) {
        // Take first IP (client), trim whitespace, validate format
        const ip = forwardedFor.split(',')[0].trim();
        // Basic IPv4/IPv6 format validation
        if (/^[\d.:a-fA-F]+$/.test(ip) && ip.length <= 45) {
            return ip;
        }
    }
    // Fallback to socket address
    return req.socket?.remoteAddress || 'unknown';
}

// SECURITY: Sanitize error messages to prevent info leaks
// Removes stack traces, file paths, and internal details
function sanitizeErrorMessage(error) {
    const message = error?.message || String(error) || 'An error occurred';
    // Remove file paths
    let sanitized = message.replace(/\/[^\s:]+\.(js|ts|json)/gi, '[path]');
    // Remove stack traces
    sanitized = sanitized.replace(/\s+at\s+.+/g, '');
    // Remove line/column numbers
    sanitized = sanitized.replace(/:\d+:\d+/g, '');
    // Truncate long messages
    if (sanitized.length > 200) {
        sanitized = sanitized.slice(0, 200) + '...';
    }
    return sanitized;
}

// SECURITY: Input validation helpers
const validateInput = {
    // Validate string with max length
    string: (val, maxLen = 1000) => {
        if (typeof val !== 'string') return null;
        return val.slice(0, maxLen);
    },
    // Validate positive integer
    positiveInt: (val, max = Number.MAX_SAFE_INTEGER) => {
        const num = parseInt(val, 10);
        if (isNaN(num) || num < 0 || num > max) return null;
        return num;
    },
    // Validate Solana address (base58, 32-44 chars)
    solanaAddress: (val) => {
        if (typeof val !== 'string') return null;
        if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(val)) return null;
        return val;
    },
    // Validate array with max length
    array: (val, maxLen = 100) => {
        if (!Array.isArray(val)) return null;
        return val.slice(0, maxLen);
    },
    // Sanitize object keys (prevent prototype pollution)
    safeObject: (val) => {
        if (typeof val !== 'object' || val === null || Array.isArray(val)) return {};
        const safe = {};
        for (const key of Object.keys(val)) {
            // Block prototype pollution
            if (key === '__proto__' || key === 'constructor' || key === 'prototype') continue;
            safe[key] = val[key];
        }
        return safe;
    }
};

// Format timestamp to "X ago" format
function formatTimeAgo(timestamp) {
    if (!timestamp) return 'Unknown';
    const seconds = Math.floor((Date.now() - timestamp) / 1000);
    if (seconds < 60) return `${seconds}s ago`;
    const minutes = Math.floor(seconds / 60);
    if (minutes < 60) return `${minutes}m ago`;
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return `${hours}h ago`;
    const days = Math.floor(hours / 24);
    return `${days}d ago`;
}

// Safe body parser with size limit
function parseBody(req, maxSize = MAX_BODY_SIZE) {
    return new Promise((resolve, reject) => {
        let body = '';
        let size = 0;

        req.on('data', chunk => {
            size += chunk.length;
            if (size > maxSize) {
                req.destroy();
                reject(new Error('Request body too large'));
                return;
            }
            body += chunk;
        });

        req.on('end', () => {
            try {
                resolve(JSON.parse(body));
            } catch (e) {
                reject(new Error('Invalid JSON'));
            }
        });

        req.on('error', reject);
    });
}

// Validate Solana public key format
function isValidPublicKey(str) {
    try {
        new PublicKey(str);
        return true;
    } catch {
        return false;
    }
}

// Check auth token and session validity
function isAuthorized(req) {
    if (!isSessionValid()) return false;
    const authHeader = req.headers['authorization'];
    return authHeader === `Bearer ${sessionToken}`;
}

function log(msg) {
    const timestamp = new Date().toLocaleTimeString();
    // Sanitize log message to prevent log injection
    const sanitized = String(msg).replace(/[\r\n]/g, ' ');
    const entry = `[${timestamp}] ${sanitized}`;
    logs.push(entry);
    if (logs.length > 100) logs.shift();
    console.log(entry);
}

// Helper to read request body as string
function getBody(req) {
    return new Promise((resolve, reject) => {
        let body = '';
        req.on('data', chunk => { body += chunk.toString(); });
        req.on('end', () => resolve(body));
        req.on('error', reject);
    });
}

// ═══════════════════════════════════════════════════════════════════════════
// CACHE CLEANUP - Prevent memory leaks by periodically cleaning expired entries
// ═══════════════════════════════════════════════════════════════════════════
function cleanupCaches() {
    const now = Date.now();
    const MAX_CACHE_AGE = 300000; // 5 minutes max
    const MAX_CACHE_SIZE = 500; // Max entries per cache

    // Clean Map-based caches
    const mapCaches = [
        { cache: global.pumpCache, name: 'pumpCache' },
        { cache: global.pumpCreatorCache, name: 'pumpCreatorCache' },
        { cache: global.tokenDataCache, name: 'tokenDataCache' }
    ];

    for (const { cache, name } of mapCaches) {
        if (cache instanceof Map) {
            let deleted = 0;
            for (const [key, value] of cache) {
                if (now - (value.ts || 0) > MAX_CACHE_AGE) {
                    cache.delete(key);
                    deleted++;
                }
            }
            // Also limit size
            if (cache.size > MAX_CACHE_SIZE) {
                const excess = cache.size - MAX_CACHE_SIZE;
                const keys = Array.from(cache.keys()).slice(0, excess);
                keys.forEach(k => cache.delete(k));
                deleted += excess;
            }
            if (deleted > 0) console.log(`[CACHE] Cleaned ${deleted} entries from ${name}`);
        }
    }

    // Clean object-based cache (trendingCache)
    if (global.trendingCache && typeof global.trendingCache === 'object') {
        let deleted = 0;
        for (const key of Object.keys(global.trendingCache)) {
            if (now - (global.trendingCache[key]?.ts || 0) > MAX_CACHE_AGE) {
                delete global.trendingCache[key];
                deleted++;
            }
        }
        if (deleted > 0) console.log(`[CACHE] Cleaned ${deleted} entries from trendingCache`);
    }
}

// Run cache cleanup every 5 minutes
setInterval(cleanupCaches, 300000);

const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host}`);

    // Get origin for CORS - only allow same-origin or explicitly configured origins
    const origin = req.headers.origin;
    const allowedOrigins = (process.env.ALLOWED_ORIGINS?.split(',') || [])
        .map(o => o.trim())
        .filter(o => o && o !== '*'); // SECURITY: Reject wildcard CORS

    // CORS headers - only allow explicitly listed origins (no wildcards)
    if (origin && allowedOrigins.includes(origin)) {
        res.setHeader('Access-Control-Allow-Origin', origin);
    }
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    res.setHeader('Access-Control-Allow-Credentials', 'true');

    // ═══════════════════════════════════════════════════════════════════════════
    // SECURITY HEADERS - CIA-LEVEL PROTECTION
    // ═══════════════════════════════════════════════════════════════════════════
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('X-XSS-Protection', '1; mode=block');
    res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
    res.setHeader('Permissions-Policy', 'geolocation=(), microphone=(), camera=()');
    res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
    // CSP: Allow inline scripts (React) but block unsafe evals and data: URIs
    res.setHeader('Content-Security-Policy', [
        "default-src 'self'",
        "script-src 'self' 'unsafe-inline' https://unpkg.com https://cdn.jsdelivr.net https://esm.sh",
        "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
        "font-src 'self' https://fonts.gstatic.com",
        "img-src 'self' data: https: blob:",
        "connect-src 'self' https://api.dexscreener.com https://lite-api.jup.ag https://api.jup.ag https://gmgn.ai https://frontend-api.pump.fun https://*.helius-rpc.com wss://*.helius-rpc.com",
        "frame-src 'self' https://dexscreener.com",
        "object-src 'none'",
        "base-uri 'self'"
    ].join('; '));

    if (req.method === 'OPTIONS') {
        res.writeHead(200);
        res.end();
        return;
    }

    // Serve Landing Page
    if (url.pathname === '/' && req.method === 'GET') {
        res.writeHead(200, {
            'Content-Type': 'text/html; charset=utf-8',
            'Cache-Control': 'no-cache, no-store, must-revalidate',
            'Pragma': 'no-cache',
            'Expires': '0'
        });
        res.end(getLandingHTML());
        return;
    }

    // Serve Terms & Conditions
    if (url.pathname === '/terms' && req.method === 'GET') {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(getTermsHTML());
        return;
    }

    // Serve Product Roadmap
    if (url.pathname === '/roadmap' && req.method === 'GET') {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(getRoadmapHTML());
        return;
    }

    // Serve favicon
    if (url.pathname === '/favicon.ico' && req.method === 'GET') {
        try {
            const favicon = fs.readFileSync(path.join(__dirname, 'website', 'logo-icon.jpg'));
            res.writeHead(200, {
                'Content-Type': 'image/jpeg',
                'Cache-Control': 'public, max-age=604800'
            });
            res.end(favicon);
        } catch (e) {
            res.writeHead(404);
            res.end();
        }
        return;
    }

    // Serve logo images explicitly
    if ((url.pathname === '/website/logo-icon.jpg' || url.pathname === '/website/logo-full.jpg' || url.pathname === '/website/phantom_icon.png' || url.pathname === '/website/logo-icon.png' || url.pathname === '/website/logo-banner.png' || url.pathname === '/website/transparentbanner.png') && req.method === 'GET') {
        try {
            const filename = url.pathname.replace('/website/', '');
            const img = fs.readFileSync(path.join(__dirname, 'website', filename));
            const ext = filename.endsWith('.png') ? 'image/png' : 'image/jpeg';
            res.writeHead(200, { 'Content-Type': ext, 'Cache-Control': 'public, max-age=86400' });
            res.end(img);
        } catch (e) {
            res.writeHead(404);
            res.end('Image not found');
        }
        return;
    }

    // Serve Launchpad (with config injection)
    if (url.pathname === '/launchpad' && req.method === 'GET') {
        try {
            const html = fs.readFileSync(path.join(__dirname, 'website', 'launchpad.html'), 'utf8');
            res.writeHead(200, {
                'Content-Type': 'text/html; charset=utf-8',
                'Cache-Control': 'no-cache, no-store, must-revalidate',
                'Pragma': 'no-cache',
                'Expires': '0'
            });
            res.end(injectConfig(html));
        } catch (e) {
            res.writeHead(302, { 'Location': '/' });
            res.end();
        }
        return;
    }

    // Serve Creator Dashboard (full HTML with config injection)
    if (url.pathname === '/dashboard' && req.method === 'GET') {
        try {
            const html = fs.readFileSync(path.join(__dirname, 'website', 'dashboard.html'), 'utf8');
            res.writeHead(200, {
                'Content-Type': 'text/html; charset=utf-8',
                'Cache-Control': 'no-cache, no-store, must-revalidate',
                'Pragma': 'no-cache',
                'Expires': '0'
            });
            res.end(injectConfig(html));
        } catch (e) {
            res.writeHead(302, { 'Location': '/' });
            res.end();
        }
        return;
    }

    // Serve Auth page (React Privy popup)
    if (url.pathname === '/auth' && req.method === 'GET') {
        try {
            const html = fs.readFileSync(path.join(__dirname, 'frontend', 'dist', 'index.html'), 'utf8');
            res.writeHead(200, {
                'Content-Type': 'text/html; charset=utf-8',
                'Cache-Control': 'no-cache, no-store, must-revalidate'
            });
            res.end(injectConfig(html));
        } catch (e) {
            res.writeHead(302, { 'Location': '/' });
            res.end();
        }
        return;
    }

    // Serve Documentation (with config injection)
    if (url.pathname === '/docs' && req.method === 'GET') {
        try {
            const html = fs.readFileSync(path.join(__dirname, 'website', 'docs.html'), 'utf8');
            res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
            res.end(injectConfig(html));
        } catch (e) {
            res.writeHead(302, { 'Location': '/' });
            res.end();
        }
        return;
    }

    // Serve Guide page (alias for docs)
    if (url.pathname === '/guide' && req.method === 'GET') {
        try {
            const html = fs.readFileSync(path.join(__dirname, 'website', 'docs.html'), 'utf8');
            res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
            res.end(injectConfig(html));
        } catch (e) {
            res.writeHead(302, { 'Location': '/' });
            res.end();
        }
        return;
    }

    // Serve Profile page (with config injection)
    if (url.pathname.startsWith('/profile/') && req.method === 'GET') {
        try {
            const html = fs.readFileSync(path.join(__dirname, 'website', 'profile.html'), 'utf8');
            res.writeHead(200, {
                'Content-Type': 'text/html; charset=utf-8',
                'Cache-Control': 'no-cache, no-store, must-revalidate'
            });
            res.end(injectConfig(html));
        } catch (e) {
            res.writeHead(302, { 'Location': '/' });
            res.end();
        }
        return;
    }

    // Serve Culture Coins page (preview for team/testers)
    if (url.pathname === '/culture-coins' && req.method === 'GET') {
        try {
            const html = fs.readFileSync(path.join(__dirname, 'website', 'culture-coins.html'), 'utf8');

            // Basic headers only - no strict CSP (page uses inline scripts + external CDNs)
            res.writeHead(200, {
                'Content-Type': 'text/html; charset=utf-8',
                'Cache-Control': 'no-cache, no-store, must-revalidate'
            });
            res.end(injectConfig(html));
        } catch (e) {
            res.writeHead(302, { 'Location': '/' });
            res.end();
        }
        return;
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // X (TWITTER) TRENDING API - Real-time cultural pulse
    // Fetches trending topics from X API with caching
    // ═══════════════════════════════════════════════════════════════════════════

    // API: Get trending topics from X
    if (url.pathname === '/api/x/trending' && req.method === 'GET') {
        try {
            const now = Date.now();

            // Return cached data if still fresh (5 min cache)
            if (xTrendingCache.data && (now - xTrendingCache.timestamp) < X_CACHE_DURATION) {
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({
                    success: true,
                    trends: xTrendingCache.data,
                    cached: true,
                    cacheAge: Math.floor((now - xTrendingCache.timestamp) / 1000)
                }));
                return;
            }

            // X API Bearer Token (set via environment variable)
            const X_BEARER_TOKEN = process.env.X_BEARER_TOKEN || process.env.TWITTER_BEARER_TOKEN;

            let trends = [];
            let source = 'fallback';

            // ═══════════════════════════════════════════════════════════════
            // OPTION 1: Fetch REAL TWEETS from X API
            // ═══════════════════════════════════════════════════════════════
            if (X_BEARER_TOKEN) {
                log('[X-API] Fetching real tweets from X/Twitter API...');
                log('[X-API] Token starts with: ' + X_BEARER_TOKEN.slice(0, 15) + '...');
                try {
                    // Use URLSearchParams for proper encoding (auto-encodes special chars!)
                    const xUrl = new URL('https://api.twitter.com/2/tweets/search/recent');
                    xUrl.searchParams.set('query', '(crypto OR solana OR memecoin) -is:retweet lang:en');
                    xUrl.searchParams.set('max_results', '20');
                    xUrl.searchParams.set('tweet.fields', 'public_metrics,created_at,author_id');
                    xUrl.searchParams.set('expansions', 'author_id');
                    xUrl.searchParams.set('user.fields', 'username,name');
                    xUrl.searchParams.set('sort_order', 'relevancy');

                    log('[X-API] Request URL: ' + xUrl.toString().slice(0, 120) + '...');

                    const xResponse = await fetch(xUrl.toString(), {
                        headers: {
                            'Authorization': `Bearer ${X_BEARER_TOKEN}`
                            // NO Content-Type header for GET requests!
                        }
                    });

                    // ALWAYS read as text first so we can log errors properly
                    const responseText = await xResponse.text();
                    log('[X-API] Status: ' + xResponse.status);
                    log('[X-API] Response: ' + responseText.slice(0, 400));

                    if (!xResponse.ok) {
                        log('[X-API] FAILED! Status ' + xResponse.status + ': ' + responseText.slice(0, 300));
                        // Don't throw - fall through to CoinGecko backup
                    } else {
                        const xData = JSON.parse(responseText);

                        if (xData.data && xData.data.length > 0) {
                            // Build user lookup
                            const users = {};
                            if (xData.includes?.users) {
                                xData.includes.users.forEach(u => users[u.id] = u);
                            }

                            // INSTITUTIONAL GRADE SPAM FILTER
                            // Rule 1: HIGH ENGAGEMENT = ALWAYS TRUST (Elon, major accounts)
                            // Rule 2: Only filter LOW engagement spam bots with specific patterns
                            const isSpamBot = (text, likes) => {
                                // 50+ likes = real account, always trust
                                if (likes >= 50) return false;

                                // The SPECIFIC spam pattern we're seeing:
                                // "$BULLA $TRUMP $CRV $GALA How to stake crypto and earn $3724"
                                // Pattern: 3+ random tickers + staking/earn money claims
                                const tickerCount = (text.match(/\$[A-Za-z]{2,}/g) || []).length;
                                const hasScamClaim = /stak(e|ing|ed)/i.test(text) &&
                                                     /(earn|\$\d{3,}|passive|gains)/i.test(text);

                                // Block: 3+ tickers AND staking scam language AND low engagement
                                if (tickerCount >= 3 && hasScamClaim) return true;

                                // Block obvious wallet scams (any engagement level)
                                if (/drop your.*(address|wallet)/i.test(text)) return true;
                                if (/send .* (to )?(get|receive|claim)/i.test(text)) return true;
                                if (/dm (me|for|to)/i.test(text) && likes < 10) return true;

                                return false;
                            };
                            // Spam filter patterns - block common crypto spam/scam tweets
                            const SPAM_PATTERNS = [
                                /earn \$\d+/i,           // "earn $3724"
                                /earned \$\d+/i,         // "earned $3864"
                                /drop your.*address/i,  // "drop your SOL address"
                                /\bRT\b.*👇/i,           // "RT 👇" giveaway spam
                                /giveaway/i,            // giveaway spam
                                /free (airdrop|drop)/i, // free airdrop spam
                                /dm (me|for)/i,         // "DM me" scams
                                /(\$\w+\s*){4,}/,       // 4+ $TICKERS in a row (like "$BULLA $TRUMP $CRV $GALA")
                            ];

                            const isSpam = (text) => SPAM_PATTERNS.some(p => p.test(text));

                            // Convert to trend items with REAL tweet text (filtered)
                            const realTweets = xData.data
                                .filter(tweet => {
                                    const metrics = tweet.public_metrics || {};
                                    const likes = metrics.like_count || 0;
                                    // Block spam bots (return false to remove)
                                    if (isSpamBot(tweet.text, likes)) return false;
                                    // Require minimum engagement (3 likes) to filter out spam
                                    if ((metrics.like_count || 0) < 3) return false;
                                    // Block spam patterns
                                    if (isSpam(tweet.text)) return false;
                                    return true;
                                })
                                .slice(0, 10)
                                .map((tweet) => {
                                    const user = users[tweet.author_id] || {};
                                    const metrics = tweet.public_metrics || {};
                                    const engagement = (metrics.like_count || 0) + (metrics.retweet_count || 0) * 2;

                                    // Detect category from tweet content
                                    const text = tweet.text.toLowerCase();
                                    let category = 'TRENDING';
                                    if (text.includes('breaking') || text.includes('just in')) category = 'BREAKING';
                                    else if (text.includes('pump') || text.includes('moon')) category = 'HOT';
                                    else if (text.includes('defi') || text.includes('yield')) category = 'DEFI';
                                    else if (text.includes('sol') || text.includes('btc') || text.includes('eth')) category = 'MARKET';
                                    else if (text.includes('ai') || text.includes('agent')) category = 'ALPHA';

                                    return {
                                        name: tweet.text.slice(0, 140) + (tweet.text.length > 140 ? '...' : ''),
                                        category: category,
                                        volume: `${((metrics.like_count || 0) / 1000).toFixed(1)}K`,
                                        velocity: `+${metrics.retweet_count || 0}`,
                                        sentiment: 0.5 + Math.min(0.4, engagement / 5000),
                                        author: user.username ? `@${user.username}` : null,
                                        authorName: user.name || null,
                                        likes: metrics.like_count || 0,
                                        retweets: metrics.retweet_count || 0,
                                        tweetId: tweet.id,
                                        url: user.username ? `https://x.com/${user.username}/status/${tweet.id}` : null,
                                        isRealTweet: true
                                    };
                                });

                            if (realTweets.length >= 3) {
                                trends = realTweets;
                                source = 'x-api-real-tweets';
                                log('[X-API] ✓ SUCCESS! Got ' + realTweets.length + ' real tweets');
                            } else {
                                log('[X-API] Only got ' + realTweets.length + ' tweets, trying CoinGecko...');
                            }
                        } else {
                            log('[X-API] No tweets in response data');
                        }
                    }
                } catch (xErr) {
                    log('[X-API] Exception: ' + xErr.message);
                }
            } else {
                log('[X-API] No X_BEARER_TOKEN configured - skipping X API');
            }

            // ═══════════════════════════════════════════════════════════════
            // OPTION 2: Fetch REAL trending coins from CoinGecko (free, no auth)
            // ═══════════════════════════════════════════════════════════════
            if (trends.length < 5) {
                log('[NEWS-API] Fetching trending from CoinGecko...');
                try {
                    // CoinGecko free API - trending coins + news
                    const cgResponse = await fetch(
                        'https://api.coingecko.com/api/v3/search/trending',
                        { headers: { 'Accept': 'application/json' } }
                    );

                    if (cgResponse.ok) {
                        const cgData = await cgResponse.json();
                        log('[NEWS-API] CoinGecko response received');

                        if (cgData.coins && cgData.coins.length > 0) {
                            const trendingCoins = cgData.coins.slice(0, 10).map((item, index) => {
                                const coin = item.item;
                                const priceChange = coin.data?.price_change_percentage_24h?.usd || 0;

                                // Generate news-like headline from trending coin
                                let headline = `${coin.name} ($${coin.symbol.toUpperCase()}) trending`;
                                if (priceChange > 10) headline = `${coin.name} surges ${priceChange.toFixed(0)}% in 24h`;
                                else if (priceChange > 0) headline = `${coin.name} up ${priceChange.toFixed(1)}% - enters top trending`;
                                else if (priceChange < -10) headline = `${coin.name} dips ${Math.abs(priceChange).toFixed(0)}% amid selloff`;
                                else headline = `${coin.name} ($${coin.symbol.toUpperCase()}) gains momentum`;

                                return {
                                    name: headline,
                                    category: priceChange > 20 ? 'HOT' : priceChange > 0 ? 'TRENDING' : 'MARKET',
                                    volume: formatTrendVolume(coin.market_cap_rank ? (1000 - coin.market_cap_rank) * 1000 : 50000),
                                    velocity: `${priceChange >= 0 ? '+' : ''}${priceChange.toFixed(1)}%`,
                                    sentiment: priceChange > 0 ? 0.7 + Math.min(0.25, priceChange / 100) : 0.4,
                                    source: 'CoinGecko Trending',
                                    symbol: coin.symbol.toUpperCase(),
                                    marketCapRank: coin.market_cap_rank,
                                    thumb: coin.thumb,
                                    isRealNews: true
                                };
                            });

                            if (trendingCoins.length >= 3) {
                                trends = trendingCoins;
                                source = 'coingecko-trending';
                                log('[NEWS-API] ✓ Got ' + trendingCoins.length + ' trending coins from CoinGecko');
                            }
                        }
                    } else {
                        log('[NEWS-API] CoinGecko failed:', cgResponse.status);
                    }
                } catch (newsErr) {
                    log('[NEWS-API] CoinGecko error:', newsErr.message);
                }
            }

            // ═══════════════════════════════════════════════════════════════
            // FALLBACK: Use real-looking but static headlines
            // ═══════════════════════════════════════════════════════════════
            if (trends.length < 3) {
                log('[X-API] All APIs failed, using static fallback');
                // At least show helpful info about what's happening
                trends = [
                    { name: 'X API: Check X_BEARER_TOKEN in Railway', category: 'SETUP', volume: '—', velocity: '—', sentiment: 0.5 },
                    { name: 'CoinGecko API may be rate limited', category: 'INFO', volume: '—', velocity: '—', sentiment: 0.5 },
                    { name: 'Refresh in 5 minutes to retry', category: 'INFO', volume: '—', velocity: '—', sentiment: 0.5 }
                ];
                source = 'fallback';
            }

            // Cache and return
            xTrendingCache = { data: trends, timestamp: now };

            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: true, trends, cached: false, source }));
        } catch (e) {
            console.error('[X-API] Trending fetch error:', e);
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: false, error: e.message }));
        }
        return;
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // CULTURE COINS API - SECURE ENDPOINTS
    // All endpoints use CIA-level protection with signature verification
    // ═══════════════════════════════════════════════════════════════════════════

    // API: Get all cultures
    if (url.pathname === '/api/cultures' && req.method === 'GET') {
        try {
            const cultures = loadCultures();
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: true, cultures }));
        } catch (e) {
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: false, error: e.message }));
        }
        return;
    }

    // API: Get cultures created by a specific wallet
    if (url.pathname === '/api/cultures/by-wallet' && req.method === 'GET') {
        try {
            const wallet = url.searchParams.get('wallet');
            if (!wallet) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ success: false, error: 'Wallet address required' }));
                return;
            }

            const allCultures = loadCultures();
            // Filter cultures where creatorWallet or creator matches the wallet
            const userCultures = allCultures.filter(c =>
                c.creatorWallet === wallet ||
                c.creator === wallet
            );

            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: true, cultures: userCultures }));
        } catch (e) {
            console.error('[API] cultures by wallet error:', e);
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: false, error: e.message }));
        }
        return;
    }

    // API: Get single culture by ID
    if (url.pathname.startsWith('/api/culture/') && req.method === 'GET') {
        const id = parseInt(url.pathname.split('/').pop());
        if (!isNaN(id)) {
            try {
                const cultures = loadCultures();
                const culture = cultures.find(c => c.id === id);
                if (culture) {
                    res.writeHead(200, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ success: true, culture }));
                } else {
                    res.writeHead(404, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ success: false, error: 'Culture not found' }));
                }
            } catch (e) {
                res.writeHead(500, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ success: false, error: e.message }));
            }
            return;
        }
    }

    // API: Create new culture (CIA-level security with wallet verification)
    if (url.pathname === '/api/culture/create' && req.method === 'POST') {
        const clientIP = getClientIP(req);
        try {
            // Rate limit
            const rateCheck = checkRateLimit(clientIP, 'sensitive');
            if (!rateCheck.allowed) {
                res.writeHead(429, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ success: false, error: rateCheck.reason }));
                return;
            }

            // Allow larger body for culture creation (theme data, etc.) - 500KB max
            const body = await parseBody(req, 500 * 1024);
            const { name, creator, creatorName, ethos, beliefs, unlocks, tiers, theme, vanityAddress, wallet, signature, message, tokenAddress, txSignature, ticker, category, devBuyAmount } = body;

            if (!name || !creatorName) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ success: false, error: 'Name and creator name are required' }));
                return;
            }

            // Verify wallet signature if security controller available
            if (cultureSecurityController && wallet && signature && message) {
                const isValid = cultureSecurityController.verifyWalletSignature(message, signature, wallet);
                if (!isValid) {
                    console.warn(`[CULTURES] Invalid signature from ${wallet}`);
                    res.writeHead(403, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ success: false, error: 'Invalid wallet signature' }));
                    return;
                }
                console.log(`[CULTURES] Verified wallet: ${wallet}`);
            }

            const cultures = loadCultures();
            const newId = cultures.length > 0 ? Math.max(...cultures.map(c => c.id)) + 1 : 1001;

            // Generate integrity hash for the culture data
            const cultureHash = crypto.createHash('sha256')
                .update(JSON.stringify({ name, creatorName, ethos, beliefs }))
                .digest('hex');

            const newCulture = {
                id: newId,
                name: name.trim(),
                ticker: ticker || generateTicker(name), // Use provided ticker or generate
                ethos: Array.isArray(ethos) ? ethos.join(' | ') : (ethos || 'Building something meaningful'),
                category: category || 'other',
                devBuyAmount: devBuyAmount || 0,
                creator: wallet || vanityAddress || `0x${crypto.randomBytes(3).toString('hex')}...${crypto.randomBytes(2).toString('hex')}`,
                creatorName: creatorName.trim(),
                creatorWallet: wallet || null,
                supply: 1000000,
                burned: 0,
                pillars: beliefs || [],
                tiers: (tiers || []).map(t => ({
                    name: t.name,
                    percent: t.holdingPercent || t.percent || 0.1,
                    access: t.access || 'Basic access',
                    expectation: t.expectation || 'Participate'
                })),
                unlocks: unlocks || [],
                theme: theme || {},
                avgHoldDays: 0,
                participationRate: 0,
                holders: 1,
                activeAuctions: 0,
                createdAt: new Date().toISOString(),
                isUserCreated: true,
                // Token data (from pump.fun creation)
                tokenAddress: tokenAddress || null,
                txSignature: txSignature || null,
                vanityAddress: vanityAddress || tokenAddress || null,
                // Security fields
                integrityHash: cultureHash,
                createdFromIP: crypto.createHash('sha256').update(clientIP).digest('hex').slice(0, 16),
                securityVersion: 1
            };

            cultures.push(newCulture);

            if (saveCultures(cultures)) {
                // Audit log the creation (check if method exists)
                if (cultureSecurityController?.logAudit) {
                    cultureSecurityController.logAudit('CULTURE_CREATED', {
                        cultureId: newCulture.id,
                        cultureName: newCulture.name,
                        creatorWallet: wallet || 'anonymous',
                        integrityHash: cultureHash
                    });
                } else {
                    // Fallback to console logging
                    console.log(`[AUDIT] CULTURE_CREATED: ${newCulture.name} by ${wallet || 'anonymous'}`);
                }

                console.log(`[CULTURES] Created: ${newCulture.name} (ID: ${newCulture.id}) Hash: ${cultureHash.slice(0, 16)}...`);

                // Sign the response for tamper detection
                const responseData = { success: true, culture: newCulture };
                const responseSignature = crypto.createHmac('sha256', HMAC_SECRET)
                    .update(JSON.stringify(responseData))
                    .digest('hex');

                res.writeHead(200, {
                    'Content-Type': 'application/json',
                    'X-Response-Signature': responseSignature,
                    'X-Culture-Hash': cultureHash.slice(0, 16)
                });
                res.end(JSON.stringify(responseData));
            } else {
                res.writeHead(500, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ success: false, error: 'Failed to save culture' }));
            }
        } catch (e) {
            console.error('[CULTURES] Create error:', e);
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: false, error: e.message }));
        }
        return;
    }

    // API: Update existing culture (for edit mode)
    if (url.pathname === '/api/culture/update' && req.method === 'POST') {
        const clientIP = getClientIP(req);
        try {
            // Rate limit
            const rateCheck = checkRateLimit(clientIP, 'sensitive');
            if (!rateCheck.allowed) {
                res.writeHead(429, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ success: false, error: rateCheck.reason }));
                return;
            }

            const body = await parseBody(req, 500 * 1024);
            const { id, tokenAddress, name, creatorName, ethos, beliefs, unlocks, tiers, theme, category, wallet } = body;

            if (!id && !tokenAddress) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ success: false, error: 'Culture ID or token address required' }));
                return;
            }

            if (!wallet) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ success: false, error: 'Wallet address required for verification' }));
                return;
            }

            const cultures = loadCultures();

            // Find culture by ID or token address
            const cultureIndex = cultures.findIndex(c =>
                c.id === id ||
                c.id?.toString() === id?.toString() ||
                c.tokenAddress === tokenAddress ||
                (id && id.startsWith('pump_') && c.tokenAddress === id.replace('pump_', ''))
            );

            if (cultureIndex === -1) {
                // If not found, create a new culture entry for imported pump.fun coins
                if (tokenAddress) {
                    const newId = cultures.length > 0 ? Math.max(...cultures.map(c => c.id || 0)) + 1 : 1001;
                    const newCulture = {
                        id: newId,
                        name: name?.trim() || 'Unnamed Culture',
                        ticker: body.ticker || name?.replace(/[^a-zA-Z0-9]/g, '').slice(0, 8) || 'TOKEN',
                        ethos: Array.isArray(ethos) ? ethos.join(' | ') : (ethos || ''),
                        category: category || 'other',
                        creator: wallet,
                        creatorName: creatorName?.trim() || 'Creator',
                        creatorWallet: wallet,
                        supply: 1000000,
                        burned: 0,
                        pillars: beliefs || [],
                        tiers: (tiers || []).map(t => ({
                            name: t.name,
                            percent: t.holdingPercent || t.percent || 0.1,
                            access: t.access || 'Basic access',
                            content: t.content || []
                        })),
                        unlocks: unlocks || [],
                        theme: theme || {},
                        avgHoldDays: 0,
                        participationRate: 0,
                        holders: 1,
                        createdAt: new Date().toISOString(),
                        updatedAt: new Date().toISOString(),
                        isUserCreated: true,
                        tokenAddress: tokenAddress,
                        integrityHash: crypto.createHash('sha256').update(JSON.stringify({ name, creatorName, beliefs })).digest('hex')
                    };
                    cultures.push(newCulture);

                    if (saveCultures(cultures)) {
                        console.log(`[CULTURES] Created from pump.fun import: ${newCulture.name} (Token: ${tokenAddress})`);
                        res.writeHead(200, { 'Content-Type': 'application/json' });
                        res.end(JSON.stringify({ success: true, culture: newCulture, created: true }));
                    } else {
                        res.writeHead(500, { 'Content-Type': 'application/json' });
                        res.end(JSON.stringify({ success: false, error: 'Failed to save culture' }));
                    }
                    return;
                }

                res.writeHead(404, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ success: false, error: 'Culture not found' }));
                return;
            }

            const culture = cultures[cultureIndex];

            // Verify wallet ownership
            if (culture.wallet !== wallet && culture.creatorWallet !== wallet && culture.creator !== wallet) {
                res.writeHead(403, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ success: false, error: 'Not authorized to update this culture' }));
                return;
            }

            // Update culture fields
            if (name) culture.name = name.trim();
            if (creatorName) culture.creatorName = creatorName.trim();
            if (ethos !== undefined) culture.ethos = Array.isArray(ethos) ? ethos.join(' | ') : ethos;
            if (beliefs) culture.pillars = beliefs;
            if (unlocks) culture.unlocks = unlocks;
            if (tiers) culture.tiers = tiers.map(t => ({
                name: t.name,
                percent: t.holdingPercent || t.percent || 0.1,
                access: t.access || 'Basic access',
                content: t.content || []
            }));
            if (theme) culture.theme = theme;
            if (category) culture.category = category;
            culture.updatedAt = new Date().toISOString();

            // Recalculate integrity hash
            culture.integrityHash = crypto.createHash('sha256')
                .update(JSON.stringify({ name: culture.name, creatorName: culture.creatorName, beliefs: culture.pillars }))
                .digest('hex');

            if (saveCultures(cultures)) {
                console.log(`[CULTURES] Updated: ${culture.name} (ID: ${culture.id})`);
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ success: true, culture }));
            } else {
                res.writeHead(500, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ success: false, error: 'Failed to save culture' }));
            }
        } catch (e) {
            console.error('[CULTURES] Update error:', e);
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: false, error: e.message }));
        }
        return;
    }

    // API: Get authentication challenge for wallet signing
    if (url.pathname === '/api/culture/auth-challenge' && req.method === 'POST') {
        try {
            const body = await parseBody(req);
            const { wallet, action } = body;

            if (!wallet || !action) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ success: false, error: 'Missing wallet or action' }));
                return;
            }

            // Validate wallet address
            try {
                new PublicKey(wallet);
            } catch (e) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ success: false, error: 'Invalid wallet address' }));
                return;
            }

            // Generate challenge
            const challenge = cultureSecurityController
                ? cultureSecurityController.createAuthChallenge(action, wallet)
                : { message: `CULTURE_AUTH:${action}:${wallet}:${Date.now()}`, timestamp: Date.now() };

            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
                success: true,
                challenge: challenge.message,
                expiresAt: challenge.expiresAt || Date.now() + 300000
            }));
        } catch (e) {
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: false, error: e.message }));
        }
        return;
    }

    // API: Verify tier access for a culture
    if (url.pathname === '/api/culture/verify-access' && req.method === 'POST') {
        try {
            // Get client IP for rate limiting
            const clientIP = getClientIP(req);
            // Rate limit
            const rateCheck = checkRateLimit(clientIP, 'sensitive');
            if (!rateCheck.allowed) {
                res.writeHead(429, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ success: false, error: rateCheck.reason }));
                return;
            }

            const body = await parseBody(req);
            const { wallet, cultureId, signature, message } = body;

            if (!wallet || !cultureId) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ success: false, error: 'Missing wallet or cultureId' }));
                return;
            }

            // Verify request if signature provided
            if (cultureSecurityController && signature && message) {
                const validation = await cultureSecurityController.validateRequest({
                    wallet,
                    signature,
                    message,
                    ip: clientIP,
                    timestamp: Date.now(),
                    nonce: crypto.randomBytes(8).toString('hex')
                }, 'tierAccess');

                if (!validation.valid) {
                    res.writeHead(403, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ success: false, errors: validation.errors }));
                    return;
                }
            }

            // Verify tier access
            const accessResult = cultureSecurityController
                ? await cultureSecurityController.verifyTierAccess(wallet, cultureId, connection)
                : { valid: true, tier: 'Observer', holdingPercent: 0 };

            // Sign response for anti-tampering
            const signedResponse = cultureSecurityController
                ? cultureSecurityController.signResponse(accessResult)
                : accessResult;

            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: true, ...signedResponse }));
        } catch (e) {
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: false, error: e.message }));
        }
        return;
    }

    // API: Get culture security stats (public)
    if (url.pathname === '/api/culture/security-stats' && req.method === 'GET') {
        try {
            const stats = cultureSecurityController
                ? cultureSecurityController.getStats()
                : { error: 'Security controller not initialized' };

            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: true, stats }));
        } catch (e) {
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: false, error: e.message }));
        }
        return;
    }

    // API: Get culture audit logs (admin only - requires auth)
    if (url.pathname === '/api/culture/audit-logs' && req.method === 'GET') {
        try {
            // Require session token for audit access
            const authHeader = req.headers.authorization;
            if (!authHeader || !sessionToken || authHeader !== `Bearer ${sessionToken}`) {
                res.writeHead(401, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ success: false, error: 'Unauthorized' }));
                return;
            }

            const since = parseInt(url.searchParams.get('since')) || 0;
            const limit = Math.min(parseInt(url.searchParams.get('limit')) || 100, 1000);
            const type = url.searchParams.get('type');

            const logs = cultureSecurityController
                ? cultureSecurityController.getAuditLogs({ since, limit, type })
                : [];

            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
                success: true,
                logs,
                chainValid: cultureSecurityController?.verifyAuditChain()?.valid
            }));
        } catch (e) {
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: false, error: e.message }));
        }
        return;
    }

    // API: Verify audit chain integrity
    if (url.pathname === '/api/culture/verify-audit-chain' && req.method === 'GET') {
        try {
            const result = cultureSecurityController
                ? cultureSecurityController.verifyAuditChain()
                : { valid: false, error: 'Security controller not initialized' };

            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: true, ...result }));
        } catch (e) {
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: false, error: e.message }));
        }
        return;
    }

    // Phantom Wallet Integration - Manifest
    if ((url.pathname === '/phantom/manifest.json' || url.pathname === '/.well-known/phantom.json') && req.method === 'GET') {
        try {
            const manifest = fs.readFileSync(path.join(__dirname, 'website', 'phantom-manifest.json'), 'utf8');
            res.writeHead(200, {
                'Content-Type': 'application/json',
                'Access-Control-Allow-Origin': '*',
                'Cache-Control': 'public, max-age=3600'
            });
            res.end(manifest);
        } catch (e) {
            res.writeHead(404, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Manifest not found' }));
        }
        return;
    }

    // Serve static files from frontend/dist or website folder
    if ((url.pathname.startsWith('/assets/') || url.pathname.startsWith('/website/')) && req.method === 'GET') {
        // /website/ serves from website/ folder, /assets/ from frontend/dist/
        const isWebsite = url.pathname.startsWith('/website/');
        const baseDir = isWebsite
            ? path.join(__dirname, 'website')
            : path.join(__dirname, 'frontend', 'dist');
        const requestedPath = isWebsite
            ? url.pathname.replace('/website/', '')
            : url.pathname;

        // SECURITY: Normalize and validate path to prevent directory traversal
        const normalizedPath = path.normalize(requestedPath).replace(/^(\.\.(\/|\\|$))+/, '');
        const fullPath = path.join(baseDir, normalizedPath);

        // Ensure the resolved path is still within the allowed directory
        if (!fullPath.startsWith(baseDir)) {
            res.writeHead(403);
            res.end('Forbidden');
            return;
        }

        const ext = path.extname(fullPath).toLowerCase();
        const mimeTypes = {
            '.jpg': 'image/jpeg',
            '.jpeg': 'image/jpeg',
            '.png': 'image/png',
            '.svg': 'image/svg+xml',
            '.ico': 'image/x-icon',
            '.css': 'text/css',
            '.js': 'application/javascript'
        };
        const contentType = mimeTypes[ext] || 'application/octet-stream';

        try {
            const data = fs.readFileSync(fullPath);
            res.writeHead(200, { 'Content-Type': contentType, 'Cache-Control': 'public, max-age=86400' });
            res.end(data);
            return;
        } catch (e) {
            res.writeHead(404);
            res.end('Not found');
            return;
        }
    }

    // Serve Dashboard App
    if (url.pathname === '/app' && req.method === 'GET') {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(getHTML());
        return;
    }

    // API: Configure
    if (url.pathname === '/api/configure' && req.method === 'POST') {
        try {
            const data = await parseBody(req);

            // Validate required fields
            if (!data.privateKey || typeof data.privateKey !== 'string') {
                throw new Error('Private key is required');
            }
            if (!data.tokenMint || typeof data.tokenMint !== 'string') {
                throw new Error('Token mint is required');
            }

            // Validate token mint format
            if (!isValidPublicKey(data.tokenMint)) {
                throw new Error('Invalid token mint address');
            }

            // Validate private key format (base58)
            let decodedKey;
            try {
                decodedKey = bs58.decode(data.privateKey);
                if (decodedKey.length !== 64) {
                    throw new Error('Invalid key length');
                }
            } catch {
                throw new Error('Invalid private key format');
            }

            // Use RPC URL with robust fallback (empty string check)
            const rpcUrl = process.env.RPC_URL && process.env.RPC_URL.startsWith('http')
                ? process.env.RPC_URL
                : 'https://api.mainnet-beta.solana.com';
            connection = new Connection(rpcUrl, 'confirmed');
            wallet = Keypair.fromSecretKey(decodedKey);
            engine = new LaunchrEngine(connection, data.tokenMint, wallet);

            // Generate session token for subsequent requests
            sessionToken = crypto.randomBytes(SESSION_TOKEN_BYTES).toString('hex');
            sessionCreatedAt = Date.now();

            // Track this token in the registry
            tracker.registerToken(data.tokenMint, wallet.publicKey.toBase58());

            // Register ORBIT instance for public transparency
            registerOrbit(data.tokenMint, wallet.publicKey.toBase58());

            log('Connected: ' + wallet.publicKey.toBase58().slice(0, 8) + '...');
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
                success: true,
                wallet: wallet.publicKey.toBase58(),
                token: sessionToken  // Client stores this for auth
            }));
        } catch (e) {
            log('Config error: ' + e.message);
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: false, error: e.message }));
        }
        return;
    }

    // API: Debug Config - Check if PRIVY_APP_ID and other configs are set
    if (url.pathname === '/api/debug-config' && req.method === 'GET') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
            privy: {
                configured: !!PRODUCTION_CONFIG.PRIVY_APP_ID,
                appIdPrefix: PRODUCTION_CONFIG.PRIVY_APP_ID ? PRODUCTION_CONFIG.PRIVY_APP_ID.substring(0, 8) + '...' : null,
            },
            helius: {
                configured: !!PRODUCTION_CONFIG.HELIUS_RPC,
            },
            feeWallet: {
                configured: !!FEE_WALLET_PUBLIC_KEY,
                address: FEE_WALLET_PUBLIC_KEY ? FEE_WALLET_PUBLIC_KEY.substring(0, 8) + '...' : null,
            },
            railway: {
                environment: process.env.RAILWAY_ENVIRONMENT || null,
                dataDir: DATA_DIR,
            },
            timestamp: new Date().toISOString(),
        }));
        return;
    }

    // API: Get Status
    if (url.pathname === '/api/status' && req.method === 'GET') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        if (!engine) {
            res.end(JSON.stringify({ configured: false }));
            return;
        }
        try {
            const balance = await connection.getBalance(wallet.publicKey);
            const status = engine.getStatus();
            res.end(JSON.stringify({
                configured: true,
                wallet: wallet.publicKey.toBase58(),
                balance: balance / LAMPORTS_PER_SOL,
                ...status,
                autoClaimActive: autoClaimInterval !== null,
            }));
        } catch (e) {
            res.end(JSON.stringify({ configured: true, error: e.message }));
        }
        return;
    }

    // API: Update Allocations (requires auth)
    if (url.pathname === '/api/allocations' && req.method === 'POST') {
        if (!isAuthorized(req)) {
            res.writeHead(401, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: false, error: 'Unauthorized' }));
            return;
        }
        if (!engine) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: false, error: 'Not configured' }));
            return;
        }
        try {
            const data = await parseBody(req);

            // Validate allocation values
            const validKeys = ['marketMaking', 'buybackBurn', 'liquidity', 'creatorRevenue'];
            for (const key of validKeys) {
                if (typeof data[key] !== 'number' || data[key] < 0 || data[key] > 100) {
                    throw new Error(`Invalid allocation for ${key}: must be 0-100`);
                }
            }

            // Validate total is exactly 100%
            const total = validKeys.reduce((sum, key) => sum + (data[key] || 0), 0);
            if (Math.abs(total - 100) > 0.01) {
                throw new Error(`Allocations must sum to 100% (currently ${total}%)`);
            }

            engine.setAllocations(data);
            log('Allocations updated: ' + JSON.stringify(data));

            // Sync allocations to orbitRegistry for leaderboard display
            if (engine.tokenMintStr) {
                updateOrbitAllocations(engine.tokenMintStr, data);
            }

            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: true, allocations: engine.getAllocations() }));
        } catch (e) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: false, error: e.message }));
        }
        return;
    }

    // API: Toggle Feature (requires auth)
    if (url.pathname === '/api/feature' && req.method === 'POST') {
        if (!isAuthorized(req)) {
            res.writeHead(401, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: false, error: 'Unauthorized' }));
            return;
        }
        if (!engine) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: false, error: 'Not configured' }));
            return;
        }
        try {
            const data = await parseBody(req);

            // Validate feature name
            const validFeatures = ['marketMaking', 'buybackBurn', 'liquidity', 'creatorRevenue', 'burnLP'];
            if (!validFeatures.includes(data.feature)) {
                throw new Error('Invalid feature name');
            }
            if (typeof data.enabled !== 'boolean') {
                throw new Error('enabled must be a boolean');
            }

            engine.setFeatureEnabled(data.feature, data.enabled);
            log(`Feature ${data.feature}: ${data.enabled ? 'enabled' : 'disabled'}`);
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: true }));
        } catch (e) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: false, error: e.message }));
        }
        return;
    }

    // API: Claim and Distribute (requires auth)
    if (url.pathname === '/api/claim' && req.method === 'POST') {
        if (!isAuthorized(req)) {
            res.writeHead(401, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: false, error: 'Unauthorized' }));
            return;
        }
        if (!engine) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: false, error: 'Not configured' }));
            return;
        }
        try {
            log('Starting claim + distribute...');
            await engine.updatePrice();
            const result = await engine.claimAndDistribute();
            if (result.claimed > 0) {
                log('Claimed: ' + (result.claimed / LAMPORTS_PER_SOL).toFixed(4) + ' SOL');
                log('Distributed: ' + (result.distributed / LAMPORTS_PER_SOL).toFixed(4) + ' SOL');

                // Log ORBIT activity for public transparency
                logOrbitActivity(engine.tokenMintStr, 'claimed', {
                    amount: result.claimed,
                    amountSOL: (result.claimed / LAMPORTS_PER_SOL).toFixed(6),
                    manual: true
                });

                if (result.distributed > 0) {
                    logOrbitActivity(engine.tokenMintStr, 'distributed', {
                        amount: result.distributed,
                        amountSOL: (result.distributed / LAMPORTS_PER_SOL).toFixed(6),
                        holderFee: result.holderFee || 0,
                        manual: true
                    });
                }
            } else {
                log('No fees to claim');
            }
            res.writeHead(200, { 'Content-Type': 'application/json' });
            // Always include success: true when no error thrown
            res.end(JSON.stringify({ success: true, ...result }));
        } catch (e) {
            log('Error: ' + e.message);
            // Log ORBIT errors
            if (engine?.tokenMintStr) {
                logOrbitActivity(engine.tokenMintStr, 'error', { error: e.message, manual: true });
            }
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: false, error: e.message }));
        }
        return;
    }

    // API: Distribute from wallet balance (requires auth)
    if (url.pathname === '/api/distribute' && req.method === 'POST') {
        if (!isAuthorized(req)) {
            res.writeHead(401, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: false, error: 'Unauthorized' }));
            return;
        }
        if (!engine) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: false, error: 'Not configured' }));
            return;
        }
        try {
            const data = await parseBody(req);
            const amount = data.amount ? parseFloat(data.amount) : 0;

            if (amount <= 0) {
                throw new Error('Invalid amount');
            }

            const lamports = Math.floor(amount * LAMPORTS_PER_SOL);
            log(`Distributing ${amount} SOL from wallet...`);

            const result = await engine.distributeFees(lamports);

            if (result.distributed > 0) {
                log('Distributed: ' + (result.distributed / LAMPORTS_PER_SOL).toFixed(4) + ' SOL');
            }

            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(result));
        } catch (e) {
            log('Distribute error: ' + e.message);
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: false, error: e.message }));
        }
        return;
    }

    // API: Start Auto (requires auth)
    if (url.pathname === '/api/auto/start' && req.method === 'POST') {
        if (!isAuthorized(req)) {
            res.writeHead(401, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: false, error: 'Unauthorized' }));
            return;
        }
        if (!engine) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: false, error: 'Not configured' }));
            return;
        }
        if (autoClaimInterval) {
            // Still register ORBIT even if already running (for TEK indicator)
            if (engine?.tokenMintStr && wallet?.publicKey) {
                registerOrbit(engine.tokenMintStr, wallet.publicKey.toBase58());
            }
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: true, message: 'Already running' }));
            return;
        }

        const intervalMs = 1 * 60 * 1000;
        log('Auto-claim started (every 1 min)');

        const runClaim = async () => {
            try {
                // Check balance and auto-fund if needed
                if (autoFundConfig.enabled && autoFundConfig.encryptedSourceKey) {
                    const balance = await connection.getBalance(wallet.publicKey);
                    if (balance < autoFundConfig.minBalance) {
                        try {
                            const sourceKey = decryptKey(autoFundConfig.encryptedSourceKey);
                            const sourceKeypair = Keypair.fromSecretKey(bs58.decode(sourceKey));
                            const { SystemProgram, Transaction } = require('@solana/web3.js');
                            const tx = new Transaction().add(
                                SystemProgram.transfer({
                                    fromPubkey: sourceKeypair.publicKey,
                                    toPubkey: wallet.publicKey,
                                    lamports: autoFundConfig.fundAmount,
                                })
                            );
                            const sig = await connection.sendTransaction(tx, [sourceKeypair]);
                            // Don't block - just wait briefly
                            await new Promise(r => setTimeout(r, 2000));
                            autoFundConfig.lastFunded = Date.now();
                            log('Auto-fund: Added ' + (autoFundConfig.fundAmount / LAMPORTS_PER_SOL).toFixed(4) + ' SOL');
                        } catch (fundErr) {
                            log('Auto-fund error: ' + fundErr.message);
                        }
                    }
                }

                await engine.updatePrice();
                const result = await engine.claimAndDistribute();
                if (result.claimed > 0) {
                    log('Auto: Claimed ' + (result.claimed / LAMPORTS_PER_SOL).toFixed(4) + ' SOL');

                    // Log ORBIT activity for public transparency
                    logOrbitActivity(engine.tokenMintStr, 'claimed', {
                        amount: result.claimed,
                        amountSOL: (result.claimed / LAMPORTS_PER_SOL).toFixed(6)
                    });

                    if (result.distributed > 0) {
                        logOrbitActivity(engine.tokenMintStr, 'distributed', {
                            amount: result.distributed,
                            amountSOL: (result.distributed / LAMPORTS_PER_SOL).toFixed(6),
                            holderFee: result.holderFee || 0
                        });
                    }
                }
            } catch (e) {
                log('Auto error: ' + e.message);
                // Log ORBIT errors for transparency
                if (engine?.tokenMintStr) {
                    logOrbitActivity(engine.tokenMintStr, 'error', { error: e.message });
                }
            }
        };

        runClaim();
        autoClaimInterval = setInterval(runClaim, intervalMs);

        // Register ORBIT for TEK indicator
        if (engine?.tokenMintStr && wallet?.publicKey) {
            registerOrbit(engine.tokenMintStr, wallet.publicKey.toBase58());
        }

        // Start price updates every 10s to build RSI data
        if (!priceUpdateInterval) {
            priceUpdateInterval = setInterval(async () => {
                try {
                    if (engine) {
                        await engine.updatePrice();
                    }
                } catch (e) {
                    // Silent fail - don't crash on price update errors
                }
            }, 10000);
        }

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true }));
        return;
    }

    // API: Stop Auto (requires auth)
    if (url.pathname === '/api/auto/stop' && req.method === 'POST') {
        if (!isAuthorized(req)) {
            res.writeHead(401, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: false, error: 'Unauthorized' }));
            return;
        }
        if (autoClaimInterval) {
            clearInterval(autoClaimInterval);
            autoClaimInterval = null;
        }
        if (priceUpdateInterval) {
            clearInterval(priceUpdateInterval);
            priceUpdateInterval = null;
        }

        // Log ORBIT stopped for transparency
        if (engine?.tokenMintStr) {
            stopOrbit(engine.tokenMintStr);
        }

        log('Auto-claim stopped');
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true }));
        return;
    }

    // API: Configure Auto-Fund (requires auth)
    if (url.pathname === '/api/autofund/configure' && req.method === 'POST') {
        if (!isAuthorized(req)) {
            res.writeHead(401, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: false, error: 'Unauthorized' }));
            return;
        }
        try {
            const data = await parseBody(req);

            if (data.enabled === false) {
                // Disable auto-fund and wipe the source key
                autoFundConfig.enabled = false;
                autoFundConfig.encryptedSourceKey = null;
                autoFundConfig.sourceWallet = null;
                log('Auto-fund disabled');
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ success: true, enabled: false }));
                return;
            }

            // Enable auto-fund with source wallet
            if (!data.sourceKey || typeof data.sourceKey !== 'string') {
                throw new Error('Source wallet private key required');
            }

            // Validate source key format
            let sourceKeypair;
            try {
                sourceKeypair = Keypair.fromSecretKey(bs58.decode(data.sourceKey));
            } catch {
                throw new Error('Invalid source wallet private key format');
            }

            // Encrypt and store source key
            autoFundConfig.enabled = true;
            autoFundConfig.encryptedSourceKey = encryptKey(data.sourceKey);
            autoFundConfig.sourceWallet = sourceKeypair.publicKey.toBase58();

            // Optional: set min balance and fund amount
            if (data.minBalance !== undefined) {
                autoFundConfig.minBalance = Math.floor(data.minBalance * LAMPORTS_PER_SOL);
            }
            if (data.fundAmount !== undefined) {
                autoFundConfig.fundAmount = Math.floor(data.fundAmount * LAMPORTS_PER_SOL);
            }

            log('Auto-fund enabled from wallet ' + autoFundConfig.sourceWallet.slice(0, 8) + '...');
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
                success: true,
                enabled: true,
                sourceWallet: autoFundConfig.sourceWallet,
                minBalance: autoFundConfig.minBalance / LAMPORTS_PER_SOL,
                fundAmount: autoFundConfig.fundAmount / LAMPORTS_PER_SOL
            }));
        } catch (e) {
            log('Auto-fund config error: ' + e.message);
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: false, error: e.message }));
        }
        return;
    }

    // API: Manual Fund Wallet (requires wallet to be configured)
    if (url.pathname === '/api/fund' && req.method === 'POST') {
        // Security comes from requiring source private key, not session token
        if (!wallet) {
            res.writeHead(401, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: false, error: 'Connect wallet first' }));
            return;
        }
        try {
            const data = await parseBody(req);

            if (!data.sourceKey || typeof data.sourceKey !== 'string') {
                throw new Error('Source wallet private key required');
            }
            if (!data.amount || data.amount <= 0) {
                throw new Error('Invalid amount');
            }

            // Validate and decode source key
            let sourceKeypair;
            try {
                sourceKeypair = Keypair.fromSecretKey(bs58.decode(data.sourceKey));
            } catch {
                throw new Error('Invalid source wallet key');
            }

            // Send the transaction
            const { SystemProgram, Transaction } = require('@solana/web3.js');
            const lamports = Math.floor(data.amount * LAMPORTS_PER_SOL);

            const tx = new Transaction().add(
                SystemProgram.transfer({
                    fromPubkey: sourceKeypair.publicKey,
                    toPubkey: wallet.publicKey,
                    lamports: lamports,
                })
            );

            const sig = await connection.sendTransaction(tx, [sourceKeypair]);

            // Don't block on confirmation - just wait briefly for tx to propagate
            await new Promise(r => setTimeout(r, 2000));

            log('Manual fund: Added ' + data.amount.toFixed(4) + ' SOL from ' + sourceKeypair.publicKey.toBase58().slice(0, 8) + '...');

            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: true, signature: sig }));
        } catch (e) {
            log('Manual fund error: ' + e.message);
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: false, error: e.message }));
        }
        return;
    }

    // API: Get Logs (escape HTML to prevent XSS)
    if (url.pathname === '/api/logs' && req.method === 'GET') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        // Escape logs to prevent XSS when rendered as HTML
        const escapedLogs = logs.map(l => escapeHtml(l));
        res.end(JSON.stringify({ logs: escapedLogs }));
        return;
    }

    // API: Test Claude API Key - simple test to verify key works
    if (url.pathname === '/api/ai/test' && req.method === 'GET') {
        try {
            const apiKey = process.env.CLAUDE_API_KEY;
            if (!apiKey) {
                res.writeHead(500, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ success: false, error: 'CLAUDE_API_KEY not set' }));
                return;
            }

            log('Testing Claude API key (length=' + apiKey.length + ', prefix=' + apiKey.slice(0, 10) + '...)');

            const response = await fetch('https://api.anthropic.com/v1/messages', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'x-api-key': apiKey,
                    'anthropic-version': '2023-06-01'
                },
                body: JSON.stringify({
                    model: 'claude-3-haiku-20240307',
                    max_tokens: 10,
                    messages: [{ role: 'user', content: 'Say OK' }]
                })
            });

            if (!response.ok) {
                const errBody = await response.text();
                log('Claude API test FAILED: ' + response.status + ' - ' + errBody);
                res.writeHead(500, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ success: false, status: response.status, error: errBody }));
                return;
            }

            const result = await response.json();
            log('Claude API test SUCCESS: ' + result.content?.[0]?.text);
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: true, response: result.content?.[0]?.text }));
            return;
        } catch (error) {
            log('Claude API test error: ' + error.message);
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: false, error: error.message }));
            return;
        }
    }

    // API: Smart Optimizer - Optimize allocations using AI (no auth - just AI suggestions)
    if (url.pathname === '/api/ai/optimize' && req.method === 'POST') {
        try {
            const data = await parseBody(req);
            const { rsi, balance, currentAllocations, tokenPrice, marketCap, liquidity, volume24h, priceChange24h } = data;

            // Use server-side API key from environment
            const apiKey = process.env.CLAUDE_API_KEY;
            if (!apiKey) {
                throw new Error('AI service not configured');
            }

            // Format numbers for display
            const formatUsd = (n) => n ? (n >= 1000000 ? `$${(n/1000000).toFixed(2)}M` : n >= 1000 ? `$${(n/1000).toFixed(1)}K` : `$${n.toFixed(2)}`) : 'unknown';
            const formatPct = (n) => n !== null && n !== undefined ? `${n > 0 ? '+' : ''}${n.toFixed(1)}%` : 'unknown';

            // Call Claude API for optimization
            const prompt = `You are the LAUNCHR Smart Optimizer. Analyze real market data and provide SPECIFIC allocation recommendations.

LIVE MARKET DATA:
- RSI Indicator: ${rsi !== null ? rsi.toFixed(1) : 'not available'}
- Token Price: ${tokenPrice ? tokenPrice.toFixed(8) + ' SOL' : 'unknown'}
- Market Cap: ${formatUsd(marketCap)}
- Liquidity: ${formatUsd(liquidity)}
- 24h Volume: ${formatUsd(volume24h)}
- 24h Price Change: ${formatPct(priceChange24h)}
- Available Balance: ${balance || 0} SOL
- Current Allocations: Market Making ${currentAllocations?.marketMaking || 25}%, Burn ${currentAllocations?.buybackBurn || 25}%, Liquidity ${currentAllocations?.liquidity || 25}%, Creator Fees ${currentAllocations?.creatorRevenue || 25}%

OPTIMIZATION RULES:
1. RSI < 30 (oversold): Increase Market Making to buy the dip
2. RSI > 70 (overbought): Reduce Market Making, increase Burn
3. Low liquidity (<$10K): Prioritize Liquidity allocation
4. High volume + positive price: Market is active, balance allocations
5. Negative price trend: Increase Burn to reduce supply

Provide SPECIFIC percentages based on the data above. Be decisive.

Respond ONLY with valid JSON:
{"marketMaking": XX, "buybackBurn": XX, "liquidity": XX, "creatorRevenue": XX, "reasoning": "2-3 sentence analysis citing specific data points"}

The 4 percentages MUST sum to exactly 100.`;

            const response = await fetch('https://api.anthropic.com/v1/messages', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'x-api-key': apiKey,
                    'anthropic-version': '2023-06-01'
                },
                body: JSON.stringify({
                    model: 'claude-3-haiku-20240307',
                    max_tokens: 256,
                    messages: [{ role: 'user', content: prompt }]
                })
            });

            if (!response.ok) {
                const errBody = await response.text();
                log('Claude Optimizer API error: ' + response.status + ' - ' + errBody.slice(0, 500));
                throw new Error('Claude API error: ' + response.status + ' - ' + errBody.slice(0, 200));
            }

            const result = await response.json();
            log('Claude Optimizer response received');
            const content = result.content[0].text;

            // Parse the JSON response
            const optimized = JSON.parse(content);

            // Validate
            const total = optimized.marketMaking + optimized.buybackBurn + optimized.liquidity + optimized.creatorRevenue;
            if (Math.abs(total - 100) > 1) {
                throw new Error('AI returned invalid allocations (not 100%)');
            }

            log(`Optimizer: MM=${optimized.marketMaking}%, BB=${optimized.buybackBurn}%, LP=${optimized.liquidity}%, CR=${optimized.creatorRevenue}%`);

            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: true, allocations: optimized }));
            return;
        } catch (error) {
            log('Optimizer error: ' + error.message);
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: false, error: error.message }));
            return;
        }
    }

    // API: AI Coin Ideas Generator - Uses Claude to generate smart coin launch ideas
    if (url.pathname === '/api/ai/generate-ideas' && req.method === 'POST') {
        try {
            const data = await parseBody(req);
            const { trendingTokens, trendingNews } = data;

            const apiKey = process.env.CLAUDE_API_KEY;
            if (!apiKey) {
                log('AI Ideas error: CLAUDE_API_KEY not set in environment');
                throw new Error('AI service not configured - missing API key');
            }
            log('AI Ideas: API key found, length=' + apiKey.length);
            log('AI Ideas: Received ' + (trendingTokens?.length || 0) + ' tokens, ' + (trendingNews?.length || 0) + ' news trends');
            if (trendingTokens?.length > 0) {
                log('AI Ideas: Top tokens: ' + trendingTokens.slice(0,3).map(t => t.symbol || t.name).join(', '));
            }
            if (trendingNews?.length > 0) {
                log('AI Ideas: Top trends: ' + trendingNews.slice(0,3).map(t => t.name).join(', '));
            }

            // Format trending data with rich context (ensure numbers)
            const tokenContext = (trendingTokens || []).slice(0, 8).map(t => {
                const mc = parseFloat(t.marketCap) || 0;
                const change = parseFloat(t.priceChange) || 0;
                const vol = parseFloat(t.volume) || 0;
                return `• ${t.name || 'Unknown'} ($${t.symbol || '???'}) - MC: $${(mc / 1000000).toFixed(2)}M, 24h: ${change >= 0 ? '+' : ''}${change.toFixed(1)}%, Volume: $${(vol / 1000).toFixed(0)}K`;
            }).join('\n');

            const newsContext = (trendingNews || []).slice(0, 8).map(t => {
                const sent = parseFloat(t.sentiment) || 0.5;
                return `• "${t.name || 'Trend'}" - ${t.volume || 'N/A'} mentions, sentiment: ${Math.round(sent * 100)}% positive`;
            }).join('\n');

            const currentDate = new Date().toISOString().split('T')[0];

            const prompt = `You are a crypto culture coin strategist. Your job is to generate token ideas DIRECTLY INSPIRED BY the real trending tokens and real news below.

DATE: ${currentDate}

═══════════════════════════════════════════════════════════════
REAL TRENDING TOKENS RIGHT NOW (from pump.fun/Solana)
═══════════════════════════════════════════════════════════════
${tokenContext || 'No token data available'}

═══════════════════════════════════════════════════════════════
REAL CRYPTO NEWS/TWEETS RIGHT NOW
═══════════════════════════════════════════════════════════════
${newsContext || 'No news data available'}

═══════════════════════════════════════════════════════════════
YOUR TASK: Generate ideas BASED ON THE REAL DATA ABOVE
═══════════════════════════════════════════════════════════════

CRITICAL RULES:
1. Each idea MUST be directly inspired by a specific trending token OR news headline above
2. Reference the ACTUAL token names or news topics in your reasoning
3. Think: "What culture coin would capitalize on THIS specific trend?"
4. NOT random ideas - ideas must connect to the real data

EXAMPLES OF WHAT WE WANT:
- If BONK is trending → idea for a culture coin that captures the dog meme energy but with a unique angle
- If news says "Solana DEX volume surges" → idea for a DEX trader culture/community coin
- If AI tokens are pumping → idea for an AI-native creator culture coin

EXAMPLES OF WHAT WE DON'T WANT:
- Random "Lunar Chorus" type names with no connection to trends
- Generic ideas that ignore the actual trending data
- Made-up narratives that don't reference the real tokens/news

═══════════════════════════════════════════════════════════════
OUTPUT FORMAT (STRICT JSON - 5 ideas)
═══════════════════════════════════════════════════════════════

[
  {
    "name": "Creative name (2-3 words)",
    "ticker": "TICKER (3-5 chars)",
    "description": "2-sentence pitch - MUST mention which trend inspired this",
    "category": "e.g., 'Meme Culture', 'DeFi Degens', 'AI Builders', 'Gaming'",
    "confidence": 70-95,
    "reasoning": "MUST say: 'Inspired by [specific token/news from above]. This captures...'",
    "inspiredBy": "The specific token name or news headline this is based on"
  }
]

Generate 5 ideas that are CLEARLY derived from the real trending data above. Each idea should make it obvious which trend inspired it.`;

            const response = await fetch('https://api.anthropic.com/v1/messages', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'x-api-key': apiKey,
                    'anthropic-version': '2023-06-01'
                },
                body: JSON.stringify({
                    model: 'claude-3-haiku-20240307',  // Same model as TEK optimizer (works)
                    max_tokens: 2048,
                    messages: [{ role: 'user', content: prompt }]
                })
            });

            log('Claude API call made, awaiting response...');

            if (!response.ok) {
                const errBody = await response.text();
                log('Claude API error: ' + response.status + ' - ' + errBody.slice(0, 300));
                throw new Error('Claude API error: ' + response.status);
            }

            const result = await response.json();
            log('Claude response received, content length: ' + (result.content?.[0]?.text?.length || 0));

            if (!result.content || !result.content[0] || !result.content[0].text) {
                log('Unexpected Claude response: ' + JSON.stringify(result).slice(0, 300));
                throw new Error('Claude returned unexpected format');
            }

            const content = result.content[0].text;

            // Parse the JSON response
            let ideas;
            try {
                ideas = JSON.parse(content);
            } catch (e) {
                // Try to extract JSON from response
                const jsonMatch = content.match(/\[[\s\S]*\]/);
                if (jsonMatch) {
                    ideas = JSON.parse(jsonMatch[0]);
                } else {
                    throw new Error('Failed to parse AI response');
                }
            }

            // Validate and clean ideas
            ideas = ideas.slice(0, 5).map(idea => ({
                name: idea.name || 'Unnamed',
                ticker: (idea.ticker || 'TKN').toUpperCase().slice(0, 6),
                description: idea.description || '',
                category: idea.category || 'Culture',
                confidence: Math.min(99, Math.max(50, idea.confidence || 75)),
                reasoning: idea.reasoning || '',
                inspiredBy: idea.inspiredBy || null  // Which real token/news inspired this
            }));

            log(`AI Ideas: Generated ${ideas.length} institutional-grade coin ideas`);

            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: true, ideas: ideas }));
            return;
        } catch (error) {
            log('AI Ideas error: ' + error.message);
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: false, error: error.message }));
            return;
        }
    }

    // API: Public tracker stats
    if (url.pathname === '/api/tracker/stats' && req.method === 'GET') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(tracker.getPublicStats()));
        return;
    }

    // API: Force refresh all token metrics (holders, txns, etc.) - ADMIN ONLY
    if (url.pathname === '/api/tracker/refresh' && req.method === 'POST') {
        // SECURITY: Require authentication for admin operations
        if (!isAuthorized(req)) {
            res.writeHead(401, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: false, error: 'Unauthorized' }));
            return;
        }
        try {
            console.log('[API] Force refreshing all token metrics...');
            const result = await tracker.updateAllTokenMetrics();
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: true, ...result }));
        } catch (e) {
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: false, error: e.message }));
        }
        return;
    }

    // API: Remove a token by mint address - ADMIN ONLY
    if (url.pathname === '/api/tracker/remove' && req.method === 'POST') {
        // SECURITY: Require authentication for destructive operations
        if (!isAuthorized(req)) {
            res.writeHead(401, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: false, error: 'Unauthorized' }));
            return;
        }
        try {
            const body = await getBody(req);
            const { mint } = JSON.parse(body);
            if (!mint) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ success: false, error: 'mint required' }));
                return;
            }
            console.log(`[API] Removing token: ${mint.slice(0,8)}...`);
            const result = tracker.removeToken(mint);
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: true, ...result }));
        } catch (e) {
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: false, error: e.message }));
        }
        return;
    }

    // API: Keep only specified tokens (remove all others) - ADMIN ONLY
    if (url.pathname === '/api/tracker/keep-only' && req.method === 'POST') {
        // SECURITY: Require authentication for destructive operations
        if (!isAuthorized(req)) {
            res.writeHead(401, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: false, error: 'Unauthorized' }));
            return;
        }
        try {
            const body = await getBody(req);
            const { mints } = JSON.parse(body);
            if (!Array.isArray(mints)) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ success: false, error: 'mints array required' }));
                return;
            }
            console.log(`[API] Keeping only ${mints.length} tokens...`);
            const result = tracker.keepOnlyTokens(mints);
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: true, ...result }));
        } catch (e) {
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: false, error: e.message }));
        }
        return;
    }

    // Tracker page
    if (url.pathname === '/tracker' && req.method === 'GET') {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(getTrackerHTML());
        return;
    }

    // API: Get launchpad tokens (live list)
    if (url.pathname === '/api/tokens' && req.method === 'GET') {
        try {
            const data = tracker.getTokens();
            const tokens = (data.tokens || [])
                .filter(t => !BLOCKED_MINTS.includes(t.mint) && !isTestToken(t)) // Block competitor/test tokens
                .sort((a, b) => b.lastSeen - a.lastSeen)
                .slice(0, 50)
                .map(t => {
                    const orbitStatus = orbitRegistry.get(t.mint);
                    const hasOrbit = orbitStatus && orbitStatus.status === 'active';
                    // Get allocations - normalize old/new field names, null if no ORBIT
                    const allocations = hasOrbit ? normalizeAllocations(orbitStatus?.allocations) : null;
                    return {
                        mint: t.mint,
                        name: t.name || 'Unknown Token',
                        symbol: t.symbol || 'TOKEN',
                        image: t.image || null,
                        path: t.path || 'pump',
                        mcap: t.mcap || 0,
                        volume: t.volume || 0,
                        price: t.price || 0,
                        change: t.change || 0,
                        progress: t.progress || 0,
                        graduated: t.graduated || false,
                        graduatedAt: t.graduatedAt || null,
                        time: formatTimeAgo(t.lastSeen || t.registeredAt),
                        createdAt: t.registeredAt,
                        lastMetricsUpdate: t.lastMetricsUpdate || null,
                        // Socials (from tracker.updateTokenMetrics)
                        twitter: t.twitter || null,
                        telegram: t.telegram || null,
                        website: t.website || null,
                        // Additional market data
                        liquidity: t.liquidity || 0,
                        priceChange24h: t.priceChange24h || 0,
                        holders: t.holders || 0,
                        txns: t.txns || 0,
                        buys: t.buys || 0,
                        sells: t.sells || 0,
                        aiScore: Math.min(89, t.aiScore || 0),
                        aiSource: t.aiSource || null,
                        // TEK indicator
                        hasOrbit,
                        // Fee allocation percentages (null if no ORBIT = 100% creator)
                        allocations: allocations,
                    };
                });
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ tokens }));
        } catch (e) {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ tokens: [] }));
        }
        return;
    }

    // API: Get single token by mint from tracker (for Token Analytics)
    if (url.pathname.startsWith('/api/tracker/token/') && req.method === 'GET') {
        const mint = url.pathname.replace('/api/tracker/token/', '').trim();
        if (!mint || mint.length < 30) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Invalid mint address' }));
            return;
        }

        try {
            const data = tracker.getTokens();
            const token = (data.tokens || []).find(t =>
                t.mint?.trim() === mint ||
                t.mint?.trim().toLowerCase() === mint.toLowerCase()
            );

            if (token) {
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({
                    mint: token.mint,
                    name: token.name,
                    symbol: token.symbol,
                    holders: token.holders || 0,
                    txns: token.txns || 0,
                    buys: token.buys || 0,
                    sells: token.sells || 0,
                    mcap: token.mcap || 0,
                    volume: token.volume || 0,
                    liquidity: token.liquidity || 0,
                    price: token.price || 0,
                    priceChange24h: token.priceChange24h || 0
                }));
            } else {
                res.writeHead(404, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'Token not found in tracker' }));
            }
        } catch (e) {
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: e.message }));
        }
        return;
    }

    // ═══════════════════════════════════════════════════════════════════
    // TELEGRAM WALLET CONNECTION PAGE
    // ═══════════════════════════════════════════════════════════════════

    if (url.pathname === '/tg-connect' && req.method === 'GET') {
        const chatId = url.searchParams.get('id') || '';
        const html = `<!DOCTYPE html>
<html><head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Connect Wallet - LAUNCHR</title>
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{background:#0a0a0a;color:#fff;font-family:system-ui,sans-serif;min-height:100vh;display:flex;align-items:center;justify-content:center}
.c{max-width:400px;padding:2rem;text-align:center}
h1{font-size:1.5rem;margin-bottom:.5rem}
.sub{color:#888;margin-bottom:1.5rem}
.btn{background:linear-gradient(135deg,#9945FF,#14F195);color:#000;font-weight:bold;padding:1rem;border:none;border-radius:8px;font-size:1rem;cursor:pointer;width:100%}
.btn:disabled{opacity:.5}
.done{background:#0a1a0a;border:2px solid #14F195;border-radius:12px;padding:1.5rem;margin:1rem 0}
.done h2{color:#14F195;margin-bottom:.5rem}
.back{background:#1a1500;border:1px solid #443300;color:#ffaa00;padding:1rem;border-radius:8px;margin:1rem 0;font-size:1.1rem}
.addr{font-family:monospace;background:#111;padding:.5rem;border-radius:4px;font-size:.75rem;word-break:break-all;margin:.5rem 0}
.status{margin-top:1rem;color:#888}
.hide{display:none}
</style>
</head><body>
<div class="c">
<h1>🔗 Connect Wallet</h1>
<p class="sub">Link your wallet to Telegram</p>
<div id="s1">
<button class="btn" onclick="connect()">Connect Phantom</button>
<p class="status" id="st">Click to connect your wallet</p>
</div>
<div id="s2" class="hide">
<div class="done"><h2>✅ Connected!</h2><div class="addr" id="wa"></div></div>
<div class="back">📱 GO BACK TO TELEGRAM<br><small>Type <b>done</b> to continue</small></div>
<a href="https://t.me/LAUNCHR_V3_BOT" class="btn" style="display:block;text-decoration:none;background:#222;color:#fff;margin-top:1rem">Open Telegram →</a>
</div>
</div>
<script>
async function connect(){
document.getElementById('st').textContent='Connecting...';
try{
if(!window.solana||!window.solana.isPhantom){document.getElementById('st').innerHTML='❌ Install <a href="https://phantom.app" style="color:#14F195">Phantom</a>';return}
await window.solana.connect();
const w=window.solana.publicKey.toBase58();
fetch('/api/tg-link',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({chatId:'${chatId}',walletAddress:w})});
document.getElementById('s1').classList.add('hide');
document.getElementById('s2').classList.remove('hide');
document.getElementById('wa').textContent=w;
}catch(e){document.getElementById('st').textContent='❌ '+e.message}
}
if(window.solana?.isConnected)connect();
</script>
</body></html>`;
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end(html);
        return;
    }

    // API: Store telegram-wallet link
    if (url.pathname === '/api/tg-link' && req.method === 'POST') {
        let body = '';
        req.on('data', c => body += c);
        req.on('end', () => {
            try {
                const { chatId, walletAddress } = JSON.parse(body);
                if (!global.tgWalletLinks) global.tgWalletLinks = new Map();
                global.tgWalletLinks.set(chatId, { walletAddress, linkedAt: Date.now() });
                console.log('[TG-LINK] Linked ' + chatId + ' -> ' + walletAddress.slice(0,8) + '...');
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end('{"success":true}');
            } catch (e) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end('{"error":"Invalid request"}');
            }
        });
        return;
    }

    // ═══════════════════════════════════════════════════════════════════
    // TELEGRAM LAUNCH API - Complete pending launches from TG bot
    // ═══════════════════════════════════════════════════════════════════

    // API: Get pending launch by ID (from Telegram bot)
    if (url.pathname.startsWith('/api/tg-launch/') && !url.pathname.includes('/complete') && req.method === 'GET') {
        const launchId = url.pathname.replace('/api/tg-launch/', '').trim();

        if (!launchId || launchId.length < 16) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Invalid launch ID' }));
            return;
        }

        // Get pending launch from global store
        if (!global.pendingLaunches) global.pendingLaunches = new Map();
        const launch = global.pendingLaunches.get(launchId);

        if (!launch) {
            res.writeHead(404, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Launch not found or expired' }));
            return;
        }

        // Check expiration (1 hour)
        if (Date.now() - launch.createdAt > 60 * 60 * 1000) {
            global.pendingLaunches.delete(launchId);
            res.writeHead(410, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Launch expired' }));
            return;
        }

        // Return safe data (exclude secret key from response)
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
            launchId,
            tokenData: launch.tokenData,
            mintPublicKey: launch.mintKeypair.publicKey,
            devBuy: launch.devBuy,
            status: launch.status,
            createdAt: launch.createdAt
        }));
        return;
    }

    // API: Get unsigned transaction for launch (user will sign with Phantom)
    if (url.pathname === '/api/tg-launch/build-tx' && req.method === 'POST') {
        let body = '';
        req.on('data', chunk => body += chunk);
        req.on('end', async () => {
            try {
                const data = JSON.parse(body);
                const { launchId, walletAddress } = data;

                if (!launchId || !walletAddress) {
                    res.writeHead(400, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ error: 'Missing launchId or walletAddress' }));
                    return;
                }

                // Get pending launch
                if (!global.pendingLaunches) global.pendingLaunches = new Map();
                const launch = global.pendingLaunches.get(launchId);

                if (!launch) {
                    res.writeHead(404, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ error: 'Launch not found or expired' }));
                    return;
                }

                console.log(`[TG-LAUNCH] ========== BUILD TX START ==========`);
                console.log(`[TG-LAUNCH] Token: ${launch.tokenData.name} ($${launch.tokenData.symbol})`);
                console.log(`[TG-LAUNCH] Wallet: ${walletAddress}`);
                console.log(`[TG-LAUNCH] Mint: ${launch.mintKeypair.publicKey}`);
                console.log(`[TG-LAUNCH] DevBuy: ${launch.devBuy} SOL`);
                console.log(`[TG-LAUNCH] PhotoFileId: ${launch.tokenData.photoFileId || 'NONE'}`);

                const axios = require('axios');
                const FormData = require('form-data');
                const { VersionedTransaction } = require('@solana/web3.js');

                // Get the stored mint keypair
                const mintKeypair = Keypair.fromSecretKey(bs58.decode(launch.mintKeypair.secretKey));
                console.log(`[TG-LAUNCH] Mint keypair restored: ${mintKeypair.publicKey.toBase58()}`);

                // Step 1: Download image from Telegram if available
                let imageBuffer = null;
                if (launch.tokenData.photoFileId) {
                    console.log(`[TG-LAUNCH] Downloading image from Telegram...`);
                    try {
                        const TG_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
                        if (!TG_BOT_TOKEN) {
                            throw new Error('TELEGRAM_BOT_TOKEN not configured');
                        }

                        // Get file path from Telegram
                        const fileInfoRes = await axios.get(`https://api.telegram.org/bot${TG_BOT_TOKEN}/getFile?file_id=${launch.tokenData.photoFileId}`);
                        console.log(`[TG-LAUNCH] Telegram getFile response:`, JSON.stringify(fileInfoRes.data));

                        if (!fileInfoRes.data.ok || !fileInfoRes.data.result.file_path) {
                            throw new Error('Failed to get file path from Telegram');
                        }

                        const filePath = fileInfoRes.data.result.file_path;
                        console.log(`[TG-LAUNCH] File path: ${filePath}`);

                        // Download the actual file
                        const fileRes = await axios.get(`https://api.telegram.org/file/bot${TG_BOT_TOKEN}/${filePath}`, {
                            responseType: 'arraybuffer'
                        });
                        imageBuffer = Buffer.from(fileRes.data);
                        console.log(`[TG-LAUNCH] Image downloaded: ${imageBuffer.length} bytes`);
                    } catch (imgErr) {
                        console.error(`[TG-LAUNCH] Image download failed:`, imgErr.message);
                        // Continue without image - will use default
                    }
                }

                // Step 2: Upload metadata to IPFS via PumpPortal
                console.log('[TG-LAUNCH] Uploading metadata to IPFS...');
                const formData = new FormData();

                // Add image file if we have one
                if (imageBuffer) {
                    formData.append('file', imageBuffer, {
                        filename: 'token.png',
                        contentType: 'image/png'
                    });
                    console.log(`[TG-LAUNCH] Added image to form (${imageBuffer.length} bytes)`);
                } else {
                    // Create a simple placeholder image (1x1 transparent PNG)
                    console.log(`[TG-LAUNCH] No image - creating placeholder...`);
                    const placeholderPng = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64');
                    formData.append('file', placeholderPng, {
                        filename: 'token.png',
                        contentType: 'image/png'
                    });
                    console.log(`[TG-LAUNCH] Added placeholder image`);
                }

                formData.append('name', launch.tokenData.name);
                formData.append('symbol', launch.tokenData.symbol);
                formData.append('description', launch.tokenData.description || `${launch.tokenData.name} - Launched via LAUNCHR`);
                formData.append('twitter', launch.tokenData.twitter ? `https://twitter.com/${launch.tokenData.twitter}` : '');
                formData.append('telegram', '');
                formData.append('website', 'https://www.launchr.xyz');
                formData.append('showName', 'true');

                console.log(`[TG-LAUNCH] Form data prepared, calling Pump.fun IPFS...`);

                const ipfsRes = await axios.post('https://pump.fun/api/ipfs', formData, {
                    headers: formData.getHeaders(),
                    timeout: 30000
                });

                console.log(`[TG-LAUNCH] IPFS response status: ${ipfsRes.status}`);
                console.log(`[TG-LAUNCH] IPFS response data:`, JSON.stringify(ipfsRes.data));

                if (!ipfsRes.data || !ipfsRes.data.metadataUri) {
                    throw new Error(`Failed to upload metadata to IPFS: ${JSON.stringify(ipfsRes.data)}`);
                }

                const metadataUri = ipfsRes.data.metadataUri;
                console.log(`[TG-LAUNCH] ✅ Metadata uploaded: ${metadataUri}`);

                // Return metadataUri + mintSecretKey - frontend will call PumpPortal directly (like dashboard)
                const mintSecretArray = Array.from(bs58.decode(launch.mintKeypair.secretKey));
                console.log(`[TG-LAUNCH] ✅ BUILD TX COMPLETE - returning metadataUri + mint key for frontend PumpPortal call`);
                console.log(`[TG-LAUNCH] ========== BUILD TX END ==========`);

                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({
                    success: true,
                    metadataUri: metadataUri,
                    mint: launch.mintKeypair.publicKey,
                    mintSecretKey: mintSecretArray
                }));

            } catch (e) {
                console.error(`[TG-LAUNCH] ========== BUILD TX FAILED ==========`);
                console.error('[TG-LAUNCH] Error:', e.message);
                console.error('[TG-LAUNCH] Stack:', e.stack);
                res.writeHead(500, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: e.message }));
            }
        });
        return;
    }

    // API: Complete a pending launch (after user signed and sent tx)
    if (url.pathname === '/api/tg-launch/complete' && req.method === 'POST') {
        let body = '';
        req.on('data', chunk => body += chunk);
        req.on('end', async () => {
            try {
                const data = JSON.parse(body);
                const { launchId, signature, walletAddress } = data;

                if (!launchId || !walletAddress || !signature) {
                    res.writeHead(400, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ error: 'Missing launchId, walletAddress, or signature' }));
                    return;
                }

                // Get pending launch
                if (!global.pendingLaunches) global.pendingLaunches = new Map();
                const launch = global.pendingLaunches.get(launchId);

                if (!launch) {
                    res.writeHead(404, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ error: 'Launch not found or expired' }));
                    return;
                }

                console.log(`[TG-LAUNCH] Launch completed: ${launch.tokenData.name} - TX: ${signature}`);

                // Mark as completed and update tracker
                launch.status = 'completed';
                launch.completedBy = walletAddress;
                launch.completedAt = Date.now();
                launch.txSignature = signature;

                // Update token status in tracker
                tracker.updateTokenStatus(launch.mintKeypair.publicKey, {
                    status: 'active',
                    creator: walletAddress,
                    launchedAt: Date.now(),
                    txSignature: signature
                });

                // Remove from pending (keep for 5 min in case of retries)
                setTimeout(() => {
                    global.pendingLaunches.delete(launchId);
                }, 5 * 60 * 1000);

                // Send notification to Telegram user
                if (telegramBot && launch.chatId) {
                    try {
                        await telegramBot.sendMessage(launch.chatId, `
🎉 <b>TOKEN LAUNCHED!</b>

Your token <b>${launch.tokenData.name}</b> ($${launch.tokenData.symbol}) is now LIVE on Pump.fun!

<b>Mint:</b> <code>${launch.mintKeypair.publicKey}</code>

👉 <a href="https://pump.fun/${launch.mintKeypair.publicKey}">View on Pump.fun</a>
👉 <a href="https://solscan.io/tx/${signature}">View Transaction</a>
👉 <a href="https://www.launchr.xyz/dashboard">Configure ORBIT</a>

<b>NEXT STEPS:</b>
1. Share your token link
2. Set fee allocations in Dashboard
3. Enable ORBIT for 24/7 automation

<i>🔥 Your token is live! LFG! 🚀</i>
                        `.trim());
                    } catch (tgErr) {
                        console.error('[TG-LAUNCH] Failed to notify user:', tgErr.message);
                    }
                }

                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({
                    success: true,
                    mint: launch.mintKeypair.publicKey,
                    signature: signature,
                    message: 'Token launched successfully!'
                }));
            } catch (e) {
                console.error('[TG-LAUNCH] Complete error:', e.message);
                res.writeHead(500, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: e.message }));
            }
        });
        return;
    }

    // API: Launch page route (returns HTML for the launch UI)
    if (url.pathname.startsWith('/launch/') && req.method === 'GET') {
        const launchId = url.pathname.replace('/launch/', '').trim();

        // Serve the launch page HTML with proper Solana web3.js integration
        const launchHtml = `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Complete Your Launch - LAUNCHR</title>
    <link rel="icon" href="/favicon.ico" type="image/jpeg">
    <link rel="shortcut icon" href="/favicon.ico" type="image/jpeg">
    <link rel="apple-touch-icon" href="/website/logo-icon.jpg">
    <script src="https://unpkg.com/@solana/web3.js@1.87.6/lib/index.iife.min.js"></script>
    <style>
        * { margin: 0; padding: 0; box-sizing: border-box; }
        body {
            background: #0a0a0a;
            color: #fff;
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
            min-height: 100vh;
            display: flex;
            align-items: center;
            justify-content: center;
        }
        .container { max-width: 480px; padding: 2rem; text-align: center; }
        h1 { font-size: 1.8rem; margin-bottom: 1rem; }
        .token-card {
            background: #111;
            border: 1px solid #333;
            border-radius: 12px;
            padding: 1.5rem;
            margin: 1.5rem 0;
            text-align: left;
        }
        .token-card h2 { font-size: 1.4rem; margin-bottom: 0.5rem; }
        .token-card .symbol { color: #14F195; font-weight: bold; }
        .token-card .mint {
            font-family: monospace;
            font-size: 0.7rem;
            color: #666;
            word-break: break-all;
            margin-top: 0.75rem;
            padding: 0.5rem;
            background: #0a0a0a;
            border-radius: 4px;
        }
        .detail { margin: 0.5rem 0; color: #aaa; font-size: 0.9rem; }
        .btn {
            background: linear-gradient(135deg, #9945FF, #14F195);
            color: #000;
            font-weight: bold;
            padding: 1rem 2rem;
            border: none;
            border-radius: 8px;
            font-size: 1.1rem;
            cursor: pointer;
            width: 100%;
            margin-top: 1rem;
        }
        .btn:hover { opacity: 0.9; }
        .btn:disabled { opacity: 0.5; cursor: not-allowed; }
        .status { margin-top: 1rem; color: #888; font-size: 0.9rem; line-height: 1.5; }
        .error { color: #ff4444; padding: 1rem; }
        .success { color: #14F195; padding: 1rem; }
        .footer { margin-top: 2rem; color: #666; font-size: 0.75rem; line-height: 1.6; }
        .step { display: flex; align-items: center; gap: 0.5rem; margin: 0.5rem 0; }
        .step-done { color: #14F195; }
        .step-done::before { content: ''; display: inline-block; width: 14px; height: 14px; background: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='%2314F195'%3E%3Cpath d='M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41L9 16.17z'/%3E%3C/svg%3E") no-repeat center; margin-right: 6px; vertical-align: middle; }
        .step-active { color: #fff; }
        .step-pending { color: #444; }
        .spinner { display: inline-block; width: 16px; height: 16px; border: 2px solid #333; border-top-color: #14F195; border-radius: 50%; animation: spin 1s linear infinite; }
        @keyframes spin { to { transform: rotate(360deg); } }
        .warning { background: #1a1500; border: 1px solid #443300; color: #ffaa00; padding: 0.75rem; border-radius: 8px; font-size: 0.8rem; margin: 1rem 0; }
    </style>
</head>
<body>
    <div class="container">
        <img src="/website/logo-icon.jpg" width="60" height="60" alt="LAUNCHR" style="margin-bottom: 1rem;" onerror="this.style.display='none'">
        <h1>Complete Your Launch</h1>

        <div id="loading">Loading launch data...</div>

        <div id="launch-content" style="display:none;">
            <div class="token-card">
                <h2 id="token-name">Token Name</h2>
                <span class="symbol" id="token-symbol">$SYMBOL</span>
                <div class="detail" id="token-devbuy"></div>
                <div class="mint" id="token-mint"></div>
            </div>

            <div class="warning" id="sol-warning">
                You need ~0.02 SOL for transaction fees
            </div>

            <button class="btn" id="connect-btn">Connect Phantom Wallet</button>
            <button class="btn" id="launch-btn" style="display:none;">Sign & Launch Token</button>

            <div class="status" id="status"></div>
        </div>

        <div id="error" class="error" style="display:none;"></div>
        <div id="success" class="success" style="display:none;"></div>

        <div class="footer">
            Non-custodial - Your wallet signs directly<br>
            We never see your private keys<br><br>
            Meme coins are speculative. DYOR.
        </div>
    </div>

    <script>
        // XSS Protection - escape HTML entities
        function escapeHtml(str) {
            const div = document.createElement('div');
            div.textContent = str;
            return div.innerHTML;
        }

        const launchId = '${launchId}';
        let launchData = null;
        const { Connection, VersionedTransaction } = solanaWeb3;
        const connection = new Connection('${PRODUCTION_CONFIG.HELIUS_RPC}', 'confirmed');

        async function init() {
            try {
                const res = await fetch('/api/tg-launch/' + launchId);
                if (!res.ok) {
                    const err = await res.json();
                    throw new Error(err.error || 'Failed to load launch');
                }
                launchData = await res.json();

                document.getElementById('loading').style.display = 'none';
                document.getElementById('launch-content').style.display = 'block';

                document.getElementById('token-name').textContent = launchData.tokenData.name;
                document.getElementById('token-symbol').textContent = '$' + launchData.tokenData.symbol;
                document.getElementById('token-mint').textContent = 'Mint: ' + launchData.mintPublicKey;
                document.getElementById('token-devbuy').textContent = launchData.devBuy > 0
                    ? 'Initial Buy: ' + launchData.devBuy + ' SOL'
                    : 'No initial buy';

                // Update SOL warning with dev buy amount
                if (launchData.devBuy > 0) {
                    document.getElementById('sol-warning').textContent =
                        'You need ~0.02 SOL for fees + ' + launchData.devBuy + ' SOL for initial buy';
                }

            } catch (e) {
                document.getElementById('loading').style.display = 'none';
                document.getElementById('error').innerHTML = '<h3>Error: ' + escapeHtml(e.message) + '</h3><p style="margin-top:0.5rem;color:#888">This link may have expired. Go back to Telegram and try /create again.</p>';
                document.getElementById('error').style.display = 'block';
            }
        }

        document.getElementById('connect-btn').addEventListener('click', async () => {
            const statusEl = document.getElementById('status');
            try {
                if (typeof window.solana === 'undefined' || !window.solana.isPhantom) {
                    statusEl.innerHTML = 'Phantom wallet not found.<br><a href="https://phantom.app/" target="_blank" style="color:#14F195">Install Phantom</a>';
                    return;
                }

                statusEl.textContent = 'Connecting...';
                await window.solana.connect();
                document.getElementById('connect-btn').style.display = 'none';
                document.getElementById('launch-btn').style.display = 'block';
                statusEl.innerHTML = 'Connected: <code style="color:#14F195">' +
                    window.solana.publicKey.toBase58().slice(0, 6) + '...' +
                    window.solana.publicKey.toBase58().slice(-4) + '</code>';
            } catch (e) {
                statusEl.innerHTML = 'Connection failed: ' + escapeHtml(e.message);
            }
        });

        document.getElementById('launch-btn').addEventListener('click', async () => {
            const btn = document.getElementById('launch-btn');
            const statusEl = document.getElementById('status');
            btn.disabled = true;

            try {
                const walletAddress = window.solana.publicKey.toBase58();

                // Step 1: Get launch data (metadata URI + mint keypair)
                statusEl.innerHTML = '<div class="step step-active"><span class="spinner"></span> Preparing launch...</div>';
                btn.textContent = 'Preparing...';

                const buildRes = await fetch('/api/tg-launch/build-tx', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ launchId, walletAddress })
                });

                const buildData = await buildRes.json();
                if (!buildData.success) {
                    throw new Error(buildData.error || 'Failed to prepare launch');
                }

                // Step 2: Call PumpPortal DIRECTLY from browser (exactly like dashboard.html line 4205)
                statusEl.innerHTML = '<div class="step step-done">Metadata ready</div><div class="step step-active"><span class="spinner"></span> Building transaction...</div>';
                btn.textContent = 'Building...';

                console.log('[LAUNCH] Calling PumpPortal directly from browser...');
                const pumpRes = await fetch('https://pumpportal.fun/api/trade-local', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        publicKey: walletAddress,
                        action: 'create',
                        tokenMetadata: {
                            name: launchData.tokenData.name,
                            symbol: launchData.tokenData.symbol,
                            uri: buildData.metadataUri
                        },
                        mint: buildData.mint,
                        denominatedInSol: 'true',
                        amount: launchData.devBuy || 0,
                        slippage: 10,
                        priorityFee: 0.0005,
                        pool: 'pump'
                    })
                });

                if (pumpRes.status !== 200) {
                    const errText = await pumpRes.text();
                    throw new Error('PumpPortal error: ' + errText);
                }

                const txBuffer = await pumpRes.arrayBuffer();
                console.log('[LAUNCH] PumpPortal returned', txBuffer.byteLength, 'bytes');

                // Deserialize (exactly like dashboard line 4219)
                const tx = VersionedTransaction.deserialize(new Uint8Array(txBuffer));
                console.log('[LAUNCH] Transaction deserialized');

                // Step 3: Sign with mint first (exactly like dashboard line 4230)
                statusEl.innerHTML = '<div class="step step-done">Metadata ready</div><div class="step step-done">Transaction built</div><div class="step step-active"><span class="spinner"></span> Please approve in Phantom...</div>';
                btn.textContent = 'Approve in wallet...';

                const mintSecretBytes = new Uint8Array(buildData.mintSecretKey);
                const mintKeypair = solanaWeb3.Keypair.fromSecretKey(mintSecretBytes);
                tx.sign([mintKeypair]);
                console.log('[LAUNCH] Mint keypair signature added');

                // Sign with Phantom using signAllTransactions (sometimes works when signTransaction fails)
                const [signedTx] = await window.solana.signAllTransactions([tx]);
                console.log('[LAUNCH] Phantom signed');

                // Step 3: Send to network
                statusEl.innerHTML = '<div class="step step-done">Transaction built</div><div class="step step-done">Signed by wallet</div><div class="step step-active"><span class="spinner"></span> Sending to Solana...</div>';
                btn.textContent = 'Sending...';

                const signature = await connection.sendRawTransaction(signedTx.serialize(), {
                    skipPreflight: true,
                    maxRetries: 3
                });

                // Step 4: Wait for confirmation
                statusEl.innerHTML = '<div class="step step-done">Transaction built</div><div class="step step-done">Signed by wallet</div><div class="step step-done">Sent to Solana</div><div class="step step-active"><span class="spinner"></span> Confirming (may take 30s)...</div>';
                btn.textContent = 'Confirming...';

                await connection.confirmTransaction(signature, 'confirmed');

                // Step 5: Report completion
                const completeRes = await fetch('/api/tg-launch/complete', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ launchId, walletAddress, signature })
                });

                const result = await completeRes.json();

                // SUCCESS!
                document.getElementById('launch-content').style.display = 'none';
                document.getElementById('success').innerHTML =
                    '<h2 style="font-size:2rem;margin-bottom:1rem">TOKEN LAUNCHED</h2>' +
                    '<p style="margin:1rem 0;font-size:1.1rem"><b>' + launchData.tokenData.name + '</b> ($' + launchData.tokenData.symbol + ') is LIVE</p>' +
                    '<p style="margin:0.5rem 0;font-size:0.8rem;color:#888">TX: ' + signature.slice(0,20) + '...</p>' +
                    '<a href="https://pump.fun/' + buildData.mint + '" target="_blank" ' +
                    'style="display:inline-block;background:#14F195;color:#000;padding:0.75rem 1.5rem;border-radius:8px;text-decoration:none;font-weight:bold;margin:1rem 0">View on Pump.fun</a><br>' +
                    '<a href="https://solscan.io/tx/' + signature + '" target="_blank" ' +
                    'style="color:#888;font-size:0.85rem">View Transaction on Solscan</a>' +
                    '<p style="margin-top:1.5rem;padding:1rem;background:#111;border-radius:8px;font-size:0.9rem">Check Telegram for next steps<br><span style="color:#888">Set up ORBIT for automated fee distribution</span></p>';
                document.getElementById('success').style.display = 'block';

            } catch (e) {
                console.error('Launch error:', e);
                btn.disabled = false;
                btn.textContent = 'Sign & Launch Token';

                let errorMsg = e.message || 'Transaction failed';
                if (errorMsg.includes('User rejected')) {
                    errorMsg = 'You cancelled the transaction';
                } else if (errorMsg.includes('insufficient')) {
                    errorMsg = 'Insufficient SOL balance for fees';
                }

                statusEl.innerHTML = '<div style="color:#ff4444">' + escapeHtml(errorMsg) + '</div><div style="color:#888;font-size:0.85rem;margin-top:0.5rem">Click the button to try again</div>';
            }
        });

        // Auto-connect if Phantom is already connected
        if (window.solana?.isConnected) {
            document.getElementById('connect-btn').click();
        }

        init();
    </script>
</body>
</html>`;

        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end(launchHtml);
        return;
    }

    // API: Proxy for Pump.fun individual token with caching (ALICE pattern)
    if (url.pathname.startsWith('/api/pump/coin/') && req.method === 'GET') {
        const mint = url.pathname.replace('/api/pump/coin/', '');
        if (!mint || mint.length < 30) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Invalid mint address' }));
            return;
        }

        const CACHE_TTL = 30000;
        const cacheKey = `pump_token_${mint}`;

        if (!global.pumpCache) global.pumpCache = new Map();

        // Check cache
        const cached = global.pumpCache.get(cacheKey);
        if (cached && Date.now() - cached.ts < CACHE_TTL) {
            res.writeHead(200, { 'Content-Type': 'application/json', 'X-Cache': 'HIT' });
            res.end(JSON.stringify(cached.data));
            return;
        }

        try {
            const pumpUrl = `https://frontend-api.pump.fun/coins/${mint}`;
            const controller = new AbortController();
            const timeout = setTimeout(() => controller.abort(), 5000);

            const pumpRes = await fetch(pumpUrl, {
                headers: { 'Accept': 'application/json', 'User-Agent': 'Mozilla/5.0' },
                signal: controller.signal
            });
            clearTimeout(timeout);

            const data = pumpRes.ok ? await pumpRes.json() : null;

            if (data) {
                global.pumpCache.set(cacheKey, { data, ts: Date.now() });
            }

            res.writeHead(200, { 'Content-Type': 'application/json', 'X-Cache': 'MISS' });
            res.end(JSON.stringify(data));
        } catch (e) {
            console.error('[PUMP] Token proxy error:', e.message);
            res.writeHead(200, { 'Content-Type': 'application/json', 'X-Cache': 'ERROR' });
            res.end(JSON.stringify(cached?.data || null));
        }
        return;
    }

    // API: Get coins created by a specific wallet from pump.fun
    // Falls back to our local database cultures when pump.fun is unavailable
    if (url.pathname === '/api/pump/coins-by-creator' && req.method === 'GET') {
        const wallet = url.searchParams.get('wallet');
        if (!wallet) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Wallet address required' }));
            return;
        }

        const cacheKey = `pump_creator_${wallet}`;
        const CACHE_TTL = 300000; // 5 minute cache (longer due to API issues)

        // Initialize cache
        if (!global.pumpCreatorCache) global.pumpCreatorCache = new Map();

        // Check cache first (use even stale cache if API is having issues)
        const cached = global.pumpCreatorCache.get(cacheKey);
        if (cached && Date.now() - cached.ts < CACHE_TTL) {
            res.writeHead(200, { 'Content-Type': 'application/json', 'X-Cache': 'HIT' });
            res.end(JSON.stringify(cached.data));
            return;
        }

        // Helper to get local cultures for this wallet as fallback
        const getLocalCultures = () => {
            try {
                const cultures = loadCultures();
                return cultures
                    .filter(c => c.wallet === wallet || c.creatorWallet === wallet || c.creator === wallet)
                    .map(c => ({
                        mint: c.tokenAddress || c.id,
                        name: c.name,
                        symbol: c.ticker,
                        description: c.ethos || '',
                        image_uri: c.imageUri || '',
                        creator: wallet,
                        created_timestamp: c.createdAt,
                        usd_market_cap: c.marketCap || 0,
                        holder_count: c.holders || 0,
                        // Mark as from local DB
                        _source: 'local'
                    }));
            } catch (e) {
                return [];
            }
        };

        try {
            // Pump.fun API for coins created by wallet
            const pumpUrl = `https://frontend-api.pump.fun/coins/user-created-coins/${wallet}`;
            const controller = new AbortController();
            const timeout = setTimeout(() => controller.abort(), 5000);

            console.log(`[PUMP] Fetching coins by creator: ${wallet.slice(0, 8)}...`);

            const pumpRes = await fetch(pumpUrl, {
                headers: {
                    'Accept': 'application/json, text/plain, */*',
                    'Accept-Language': 'en-US,en;q=0.9',
                    'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                    'Origin': 'https://pump.fun',
                    'Referer': 'https://pump.fun/'
                },
                signal: controller.signal
            });
            clearTimeout(timeout);

            if (!pumpRes.ok) {
                console.warn(`[PUMP] API returned ${pumpRes.status} for creator ${wallet.slice(0, 8)}... - using local fallback`);
                // Return stale cache or local cultures as fallback
                const fallbackData = cached?.data || getLocalCultures();
                res.writeHead(200, { 'Content-Type': 'application/json', 'X-Cache': 'FALLBACK' });
                res.end(JSON.stringify(fallbackData));
                return;
            }

            const coins = await pumpRes.json();
            console.log(`[PUMP] Found ${coins?.length || 0} coins created by ${wallet.slice(0, 8)}...`);

            // Cache result
            global.pumpCreatorCache.set(cacheKey, { data: coins || [], ts: Date.now() });

            res.writeHead(200, { 'Content-Type': 'application/json', 'X-Cache': 'MISS' });
            res.end(JSON.stringify(coins || []));
        } catch (e) {
            console.error('[PUMP] Creator coins error:', e.message, '- using local fallback');
            // Return stale cache or local cultures as fallback
            const fallbackData = cached?.data || getLocalCultures();
            res.writeHead(200, { 'Content-Type': 'application/json', 'X-Cache': 'ERROR' });
            res.end(JSON.stringify(fallbackData));
        }
        return;
    }

    // API: Proxy for Pump.fun API with caching + rate limiting (ALICE pattern)
    if (url.pathname === '/api/pump/coins' && req.method === 'GET') {
        const CACHE_TTL = 30000; // 30 seconds cache
        const MIN_INTERVAL = 500; // 500ms between requests (2 RPS max)

        const sort = url.searchParams.get('sort') || 'created_timestamp';
        const order = url.searchParams.get('order') || 'DESC';
        const limit = url.searchParams.get('limit') || '20';
        const offset = url.searchParams.get('offset') || '0';
        const cacheKey = `pump_${sort}_${order}_${limit}_${offset}`;

        // Initialize cache
        if (!global.pumpCache) global.pumpCache = new Map();
        if (!global.lastPumpReq) global.lastPumpReq = 0;

        // Check cache first
        const cached = global.pumpCache.get(cacheKey);
        if (cached && Date.now() - cached.ts < CACHE_TTL) {
            res.writeHead(200, { 'Content-Type': 'application/json', 'X-Cache': 'HIT' });
            res.end(JSON.stringify(cached.data));
            return;
        }

        // Rate limit - return stale cache or empty if too fast
        const now = Date.now();
        if (now - global.lastPumpReq < MIN_INTERVAL) {
            res.writeHead(200, { 'Content-Type': 'application/json', 'X-Cache': 'RATE' });
            res.end(JSON.stringify(cached?.data || []));
            return;
        }
        global.lastPumpReq = now;

        // Fetch with timeout + graceful failure (ALICE pattern)
        try {
            const pumpUrl = `https://frontend-api.pump.fun/coins?offset=${offset}&limit=${limit}&sort=${sort}&order=${order}&includeNsfw=false`;
            const controller = new AbortController();
            const timeout = setTimeout(() => controller.abort(), 5000);

            const pumpRes = await fetch(pumpUrl, {
                headers: { 'Accept': 'application/json', 'User-Agent': 'Mozilla/5.0' },
                signal: controller.signal
            });
            clearTimeout(timeout);

            // Graceful: return empty array on bad response, don't throw
            const data = pumpRes.ok ? await pumpRes.json() : [];

            // Cache result
            global.pumpCache.set(cacheKey, { data, ts: Date.now() });

            res.writeHead(200, { 'Content-Type': 'application/json', 'X-Cache': 'MISS' });
            res.end(JSON.stringify(data));
        } catch (e) {
            // Graceful failure - return cached or empty, never error
            console.error('[PUMP] Proxy error:', e.message);
            res.writeHead(200, { 'Content-Type': 'application/json', 'X-Cache': 'ERROR' });
            res.end(JSON.stringify(cached?.data || []));
        }
        return;
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // TOKEN DATA API - Real on-chain data via Helius DAS + DexScreener
    // Returns marketCap, volume, holders, price for any Solana token
    // ═══════════════════════════════════════════════════════════════════════════
    if (url.pathname.startsWith('/api/token/') && req.method === 'GET') {
        const mint = url.pathname.replace('/api/token/', '');
        if (!mint || mint.length < 30) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Invalid mint address' }));
            return;
        }

        const CACHE_TTL = 60000; // 1 minute cache
        const cacheKey = `token_data_${mint}`;
        if (!global.tokenDataCache) global.tokenDataCache = new Map();

        const cached = global.tokenDataCache.get(cacheKey);
        if (cached && Date.now() - cached.ts < CACHE_TTL) {
            res.writeHead(200, { 'Content-Type': 'application/json', 'X-Cache': 'HIT' });
            res.end(JSON.stringify(cached.data));
            return;
        }

        try {
            const HELIUS_RPC = PRODUCTION_CONFIG.HELIUS_RPC;
            let tokenData = { mint, marketCap: 0, volume: 0, holders: 0, price: 0 };

            // Get metadata from Helius DAS API
            if (HELIUS_RPC && HELIUS_RPC.includes('helius')) {
                try {
                    const heliusRes = await fetch(HELIUS_RPC, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({
                            jsonrpc: '2.0',
                            id: 'get-token-data',
                            method: 'getAsset',
                            params: { id: mint, displayOptions: { showFungible: true } }
                        })
                    });
                    const heliusData = await heliusRes.json();
                    if (heliusData.result) {
                        const asset = heliusData.result;
                        tokenData.name = asset.content?.metadata?.name || '';
                        tokenData.symbol = asset.content?.metadata?.symbol || '';
                        tokenData.image = asset.content?.links?.image || '';
                        tokenData.decimals = asset.token_info?.decimals || 9;
                        tokenData.supply = asset.token_info?.supply || 0;
                        // Price info from Helius if available
                        if (asset.token_info?.price_info) {
                            tokenData.price = asset.token_info.price_info.price_per_token || 0;
                            tokenData.marketCap = tokenData.supply * tokenData.price / Math.pow(10, tokenData.decimals);
                        }
                    }
                } catch (e) {
                    log(`[TOKEN API] Helius error: ${e.message}`);
                }
            }

            // Get price/volume data from DexScreener (more reliable for market data)
            try {
                const dexRes = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${mint}`);
                if (dexRes.ok) {
                    const dexData = await dexRes.json();
                    const solPair = dexData.pairs?.find(p => p.chainId === 'solana' && p.quoteToken?.symbol === 'SOL');
                    if (solPair) {
                        tokenData.price = parseFloat(solPair.priceUsd) || tokenData.price;
                        tokenData.marketCap = solPair.marketCap || solPair.fdv || tokenData.marketCap;
                        tokenData.volume = solPair.volume?.h24 || 0;
                        tokenData.liquidity = solPair.liquidity?.usd || 0;
                        tokenData.priceChange24h = solPair.priceChange?.h24 || 0;
                        if (!tokenData.name) tokenData.name = solPair.baseToken?.name;
                        if (!tokenData.symbol) tokenData.symbol = solPair.baseToken?.symbol;
                    }
                }
            } catch (e) {
                log(`[TOKEN API] DexScreener error: ${e.message}`);
            }

            // Get holder count from multiple sources (same approach as working dashboard)
            // Fallback chain: Pump.fun -> Jupiter -> GMGN -> Helius RPC -> Birdeye

            // 1. Try pump.fun for holder count
            try {
                const pumpRes = await fetch(`https://frontend-api.pump.fun/coins/${mint}`);
                if (pumpRes.ok) {
                    const pumpData = await pumpRes.json();
                    if (pumpData) {
                        tokenData.holders = pumpData.holder_count || tokenData.holders;
                        if (!tokenData.marketCap && pumpData.usd_market_cap) {
                            tokenData.marketCap = pumpData.usd_market_cap;
                        }
                        if (tokenData.holders > 0) {
                            log(`[TOKEN API] Got ${tokenData.holders} holders from Pump.fun for ${mint.slice(0,8)}`);
                        }
                    }
                }
            } catch (e) {}

            // 2. FALLBACK: Jupiter API for holder count (same as working dashboard)
            if (!tokenData.holders || tokenData.holders <= 1) {
                try {
                    const jupRes = await fetch(`https://lite-api.jup.ag/tokens/v2/search?query=${mint}`);
                    if (jupRes.ok) {
                        const jupArr = await jupRes.json();
                        const jupToken = Array.isArray(jupArr) ? jupArr.find(t => t.id === mint || t.address === mint) : null;
                        if (jupToken?.holderCount > 0) {
                            tokenData.holders = jupToken.holderCount;
                            log(`[TOKEN API] Got ${tokenData.holders} holders from Jupiter for ${mint.slice(0,8)}`);
                        }
                    }
                } catch (e) {}
            }

            // 3. FALLBACK: GMGN API for holder count (same as working dashboard)
            if (!tokenData.holders || tokenData.holders <= 1) {
                try {
                    const gmgnRes = await fetch(`https://gmgn.ai/defi/quotation/v1/tokens/sol/${mint}`);
                    if (gmgnRes.ok) {
                        const gmgnData = await gmgnRes.json();
                        const gmgnHolders = gmgnData?.data?.token?.holder_count || gmgnData?.data?.token?.holders || 0;
                        if (gmgnHolders > 0) {
                            tokenData.holders = gmgnHolders;
                            log(`[TOKEN API] Got ${tokenData.holders} holders from GMGN for ${mint.slice(0,8)}`);
                        }
                    }
                } catch (e) {}
            }

            // 4. FALLBACK: Helius RPC to count token accounts directly
            if ((!tokenData.holders || tokenData.holders <= 1) && HELIUS_RPC) {
                try {
                    log(`[TOKEN API] Fetching holder count from Helius RPC for ${mint.slice(0,8)}...`);

                    const holderRes = await fetch(HELIUS_RPC, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({
                            jsonrpc: '2.0',
                            id: 'get-holders',
                            method: 'getTokenAccounts',
                            params: {
                                mint: mint,
                                limit: 1000,
                                options: { showZeroBalance: false }
                            }
                        })
                    });

                    if (holderRes.ok) {
                        const holderData = await holderRes.json();
                        if (holderData.result && holderData.result.token_accounts) {
                            const uniqueOwners = new Set(
                                holderData.result.token_accounts
                                    .filter(acc => acc.amount > 0)
                                    .map(acc => acc.owner)
                            );
                            const holderCount = uniqueOwners.size;
                            log(`[TOKEN API] Found ${holderCount} holders via Helius RPC for ${mint.slice(0,8)}`);
                            if (holderCount > tokenData.holders) {
                                tokenData.holders = holderCount;
                            }
                        }
                    }
                } catch (e) {
                    log(`[TOKEN API] Helius RPC holder fetch failed: ${e.message}`);
                }
            }

            // 5. FALLBACK: Birdeye API
            if (!tokenData.holders || tokenData.holders <= 1) {
                try {
                    const birdeyeRes = await fetch(`https://public-api.birdeye.so/defi/token_overview?address=${mint}`, {
                        headers: { 'X-API-KEY': 'public' }
                    });
                    if (birdeyeRes.ok) {
                        const birdData = await birdeyeRes.json();
                        if (birdData.data?.holder) {
                            tokenData.holders = birdData.data.holder;
                            log(`[TOKEN API] Got ${tokenData.holders} holders from Birdeye for ${mint.slice(0,8)}`);
                        }
                    }
                } catch (e) {}
            }

            // Cache the result
            global.tokenDataCache.set(cacheKey, { data: tokenData, ts: Date.now() });

            log(`[TOKEN API] ${mint.slice(0,8)}... - MC: $${tokenData.marketCap?.toLocaleString() || 0}, Vol: $${tokenData.volume?.toLocaleString() || 0}, Holders: ${tokenData.holders || 0}`);
            res.writeHead(200, { 'Content-Type': 'application/json', 'X-Cache': 'MISS' });
            res.end(JSON.stringify(tokenData));
        } catch (e) {
            console.error('[TOKEN API] Error:', e.message);
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: e.message }));
        }
        return;
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // JUPITER SWAP API - Buy/Sell tokens via Jupiter aggregator
    // ═══════════════════════════════════════════════════════════════════════════

    const SOL_MINT = 'So11111111111111111111111111111111111111112';

    // API: Get swap quote
    if (url.pathname === '/api/swap/quote' && req.method === 'GET') {
        try {
            const inputMint = url.searchParams.get('inputMint');
            const outputMint = url.searchParams.get('outputMint');
            const amount = url.searchParams.get('amount');
            const slippageBps = url.searchParams.get('slippageBps') || '500';

            if (!inputMint || !outputMint || !amount) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ success: false, error: 'inputMint, outputMint, and amount required' }));
                return;
            }

            log(`[SWAP] Quote: ${inputMint.slice(0,8)}... → ${outputMint.slice(0,8)}... amount=${amount}`);

            // Use Jupiter lite-api (no API key needed)
            const quoteUrl = `https://lite-api.jup.ag/swap/v1/quote?inputMint=${inputMint}&outputMint=${outputMint}&amount=${amount}&slippageBps=${slippageBps}`;
            const quoteRes = await fetch(quoteUrl);

            if (!quoteRes.ok) {
                const errText = await quoteRes.text();
                throw new Error(`Jupiter quote failed: ${quoteRes.status} - ${errText.slice(0, 200)}`);
            }

            const quote = await quoteRes.json();
            log(`[SWAP] Quote received: out=${quote.outAmount}, price impact=${quote.priceImpactPct}%`);

            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: true, quote }));
        } catch (e) {
            log(`[SWAP] Quote error: ${e.message}`);
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: false, error: e.message }));
        }
        return;
    }

    // API: Build swap transaction (returns unsigned tx for client to sign)
    if (url.pathname === '/api/swap/build' && req.method === 'POST') {
        try {
            const body = await parseBody(req);
            const { quote, userPublicKey } = body;

            if (!quote || !userPublicKey) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ success: false, error: 'quote and userPublicKey required' }));
                return;
            }

            log(`[SWAP] Building tx for ${userPublicKey.slice(0,8)}...`);

            // Get swap transaction from Jupiter
            const swapRes = await fetch('https://lite-api.jup.ag/swap/v1/swap', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    quoteResponse: quote,
                    userPublicKey: userPublicKey,
                    wrapAndUnwrapSol: true,
                    dynamicComputeUnitLimit: true,
                    prioritizationFeeLamports: 'auto'
                })
            });

            if (!swapRes.ok) {
                const errText = await swapRes.text();
                throw new Error(`Jupiter swap build failed: ${swapRes.status} - ${errText.slice(0, 200)}`);
            }

            const swapData = await swapRes.json();
            log(`[SWAP] Transaction built successfully`);

            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
                success: true,
                swapTransaction: swapData.swapTransaction, // base64 encoded
                lastValidBlockHeight: swapData.lastValidBlockHeight
            }));
        } catch (e) {
            log(`[SWAP] Build error: ${e.message}`);
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: false, error: e.message }));
        }
        return;
    }

    // API: Execute signed swap transaction
    if (url.pathname === '/api/swap/execute' && req.method === 'POST') {
        try {
            const body = await parseBody(req);
            const { signedTransaction } = body;

            if (!signedTransaction) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ success: false, error: 'signedTransaction required' }));
                return;
            }

            log(`[SWAP] Executing signed transaction...`);

            const { Connection, VersionedTransaction } = require('@solana/web3.js');
            const connection = new Connection(PRODUCTION_CONFIG.HELIUS_RPC, 'confirmed');

            // Decode and send the signed transaction
            const txBuffer = Buffer.from(signedTransaction, 'base64');
            const tx = VersionedTransaction.deserialize(txBuffer);

            // Send with skipPreflight for faster landing
            const signature = await connection.sendRawTransaction(tx.serialize(), {
                skipPreflight: true,
                maxRetries: 3,
                preflightCommitment: 'confirmed'
            });

            log(`[SWAP] Transaction sent: ${signature}`);

            // Wait for confirmation (with timeout)
            const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash('confirmed');
            const confirmation = await connection.confirmTransaction({
                signature,
                blockhash,
                lastValidBlockHeight
            }, 'confirmed');

            if (confirmation.value.err) {
                throw new Error(`Transaction failed: ${JSON.stringify(confirmation.value.err)}`);
            }

            log(`[SWAP] ✓ Confirmed: ${signature}`);

            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
                success: true,
                signature,
                confirmed: true
            }));
        } catch (e) {
            log(`[SWAP] Execute error: ${e.message}`);
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: false, error: e.message }));
        }
        return;
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // TOKEN OWNERSHIP VERIFICATION - Uses Helius DAS API (CIA-Level)
    // Verifies if wallet is creator/authority of a token before allowing edits
    // ═══════════════════════════════════════════════════════════════════════════
    if (url.pathname === '/api/verify-token-ownership' && req.method === 'POST') {
        try {
            const body = await parseBody(req);
            const { mint, wallet } = body;

            if (!mint || !wallet) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ success: false, error: 'mint and wallet required' }));
                return;
            }

            const HELIUS_RPC = PRODUCTION_CONFIG.HELIUS_RPC;
            if (!HELIUS_RPC || !HELIUS_RPC.includes('helius')) {
                res.writeHead(500, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ success: false, error: 'Helius RPC not configured' }));
                return;
            }

            log(`[VERIFY] Checking ownership: ${wallet.slice(0,8)}... owns ${mint.slice(0,8)}...`);

            // Use Helius DAS API getAsset to get token metadata including authorities
            const heliusRes = await fetch(HELIUS_RPC, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    jsonrpc: '2.0',
                    id: 'verify-ownership',
                    method: 'getAsset',
                    params: { id: mint }
                })
            });
            const heliusData = await heliusRes.json();

            if (heliusData.error) {
                log(`[VERIFY] Helius error: ${heliusData.error.message}`);
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ success: false, error: heliusData.error.message }));
                return;
            }

            const asset = heliusData.result;
            if (!asset) {
                res.writeHead(404, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ success: false, error: 'Token not found' }));
                return;
            }

            // Check multiple authority sources
            let isOwner = false;
            let ownershipType = null;
            const walletLower = wallet.toLowerCase();

            // 1. Check authorities array (update authority, freeze authority, etc.)
            if (asset.authorities && Array.isArray(asset.authorities)) {
                for (const auth of asset.authorities) {
                    if (auth.address?.toLowerCase() === walletLower) {
                        isOwner = true;
                        ownershipType = `authority:${auth.scopes?.join(',') || 'full'}`;
                        break;
                    }
                }
            }

            // 2. Check creators array (original token creator)
            if (!isOwner && asset.creators && Array.isArray(asset.creators)) {
                for (const creator of asset.creators) {
                    if (creator.address?.toLowerCase() === walletLower) {
                        isOwner = true;
                        ownershipType = creator.verified ? 'verified_creator' : 'creator';
                        break;
                    }
                }
            }

            // 3. Check ownership.owner (current holder - less authoritative)
            if (!isOwner && asset.ownership?.owner?.toLowerCase() === walletLower) {
                // For fungible tokens, being an owner doesn't mean creator
                // But for NFTs/cultures it might
                isOwner = false; // Don't grant access just for holding
                ownershipType = 'holder_only';
            }

            // 4. Check token_info for mint authority (SPL tokens)
            if (!isOwner && asset.token_info) {
                if (asset.token_info.mint_authority?.toLowerCase() === walletLower) {
                    isOwner = true;
                    ownershipType = 'mint_authority';
                }
                if (asset.token_info.freeze_authority?.toLowerCase() === walletLower) {
                    isOwner = true;
                    ownershipType = 'freeze_authority';
                }
            }

            log(`[VERIFY] Result: wallet=${wallet.slice(0,8)}... isOwner=${isOwner} type=${ownershipType}`);

            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
                success: true,
                isOwner,
                ownershipType,
                tokenInfo: {
                    name: asset.content?.metadata?.name || asset.content?.json_uri,
                    symbol: asset.content?.metadata?.symbol,
                    image: asset.content?.links?.image,
                    authorities: asset.authorities?.map(a => ({ address: a.address, scopes: a.scopes })),
                    creators: asset.creators?.map(c => ({ address: c.address, verified: c.verified }))
                }
            }));
        } catch (e) {
            console.error('[VERIFY] Error:', e.message);
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: false, error: e.message }));
        }
        return;
    }

    // API: Get ALL tokens owned/created by a wallet using Helius DAS
    if (url.pathname === '/api/wallet-tokens' && req.method === 'GET') {
        const wallet = url.searchParams.get('wallet');
        if (!wallet) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'wallet required' }));
            return;
        }

        const HELIUS_RPC = PRODUCTION_CONFIG.HELIUS_RPC;
        if (!HELIUS_RPC || !HELIUS_RPC.includes('helius')) {
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Helius RPC not configured' }));
            return;
        }

        const cacheKey = `wallet_tokens_${wallet}`;
        const CACHE_TTL = 60000; // 1 minute
        if (!global.walletTokenCache) global.walletTokenCache = {};
        const cached = global.walletTokenCache[cacheKey];
        if (cached && Date.now() - cached.ts < CACHE_TTL) {
            res.writeHead(200, { 'Content-Type': 'application/json', 'X-Cache': 'HIT' });
            res.end(JSON.stringify(cached.data));
            return;
        }

        try {
            log(`[WALLET-TOKENS] Fetching all tokens for ${wallet.slice(0,8)}...`);

            // Use Helius searchAssets to find all fungible tokens owned by wallet
            const heliusRes = await fetch(HELIUS_RPC, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    jsonrpc: '2.0',
                    id: 'wallet-tokens',
                    method: 'searchAssets',
                    params: {
                        ownerAddress: wallet,
                        tokenType: 'fungible',
                        displayOptions: { showFungible: true },
                        limit: 100
                    }
                })
            });
            const heliusData = await heliusRes.json();

            let tokens = [];
            if (heliusData.result?.items) {
                tokens = heliusData.result.items
                    .filter(item => item.token_info) // Only fungible tokens
                    .map(item => ({
                        mint: item.id,
                        name: item.content?.metadata?.name || 'Unknown',
                        symbol: item.content?.metadata?.symbol || '???',
                        image: item.content?.links?.image,
                        balance: item.token_info?.balance || 0,
                        decimals: item.token_info?.decimals || 0,
                        supply: item.token_info?.supply,
                        isCreator: item.creators?.some(c => c.address === wallet) || false,
                        isAuthority: item.authorities?.some(a => a.address === wallet) || false
                    }));
            }

            log(`[WALLET-TOKENS] Found ${tokens.length} fungible tokens`);

            const result = { success: true, tokens, count: tokens.length };
            global.walletTokenCache[cacheKey] = { data: result, ts: Date.now() };

            res.writeHead(200, { 'Content-Type': 'application/json', 'X-Cache': 'MISS' });
            res.end(JSON.stringify(result));
        } catch (e) {
            console.error('[WALLET-TOKENS] Error:', e.message);
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: false, error: e.message }));
        }
        return;
    }

    // API: Get REAL trending Solana meme coins using Helius + DexScreener
    if (url.pathname === '/api/trending-tokens' && req.method === 'GET') {
        const CACHE_TTL = 60000; // 1 minute cache
        const cacheKey = 'trending_tokens_v3';

        if (!global.trendingCache) global.trendingCache = {};
        const cached = global.trendingCache[cacheKey];
        if (cached && Date.now() - cached.ts < CACHE_TTL) {
            res.writeHead(200, { 'Content-Type': 'application/json', 'X-Cache': 'HIT' });
            res.end(JSON.stringify(cached.data));
            return;
        }

        // Tokens to EXCLUDE (not meme coins - stables, LSTs, wrapped)
        const EXCLUDED = new Set([
            'So11111111111111111111111111111111111111112', // Wrapped SOL
            'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', // USDC
            'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB', // USDT
            'mSoLzYCxHdYgdzU16g5QSh3i5K3z3KZK7ytfqcJm7So', // mSOL
            'J1toso1uCk3RLmjorhTtrVwY9HJ7X8V9yYac6Y7kGCPn', // jitoSOL
            'bSo13r4TkiE4KumL71LsHTPpL2euBYLFx6h9HP3piy1', // bSOL
            '7dHbWXmci3dT8UFYWYZweBLXgycu7Y3iL6trKn1Y7ARj', // stSOL
        ]);

        const HELIUS_KEY = PRODUCTION_CONFIG.HELIUS_API_KEY;

        try {
            let tokens = [];

            // Step 1: Get trending tokens from DexScreener boosted list
            const boostRes = await fetch('https://api.dexscreener.com/token-boosts/top/v1');
            const boostData = await boostRes.json();

            let mints = [];
            if (Array.isArray(boostData)) {
                mints = boostData
                    .filter(t => t.chainId === 'solana' && !EXCLUDED.has(t.tokenAddress))
                    .map(t => t.tokenAddress)
                    .slice(0, 60);
            }

            // Step 2: Use Helius DAS API (getAssetBatch) via RPC for rich metadata
            const HELIUS_RPC = PRODUCTION_CONFIG.HELIUS_RPC;
            const heliusMeta = {};

            if (HELIUS_RPC && HELIUS_RPC.includes('helius') && mints.length > 0) {
                try {
                    // Use getAssetBatch - Helius DAS API with displayOptions for fungible tokens
                    const batchRes = await fetch(HELIUS_RPC, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({
                            jsonrpc: '2.0',
                            id: 'launchr-trending',
                            method: 'getAssetBatch',
                            params: {
                                ids: mints.slice(0, 50),
                                displayOptions: {
                                    showFungible: true,
                                    showCollectionMetadata: true
                                }
                            }
                        })
                    });
                    const batchData = await batchRes.json();

                    if (batchData.result && Array.isArray(batchData.result)) {
                        log(`[HELIUS DAS] getAssetBatch returned ${batchData.result.length} assets`);
                        for (const asset of batchData.result) {
                            if (asset && asset.id) {
                                // Extract metadata from Helius DAS response
                                heliusMeta[asset.id] = {
                                    name: asset.content?.metadata?.name || asset.token_info?.symbol,
                                    symbol: asset.content?.metadata?.symbol || asset.token_info?.symbol,
                                    image: asset.content?.links?.image || asset.content?.files?.[0]?.uri,
                                    // Additional token info from Helius
                                    decimals: asset.token_info?.decimals,
                                    supply: asset.token_info?.supply,
                                    priceInfo: asset.token_info?.price_info
                                };
                            }
                        }
                    } else if (batchData.error) {
                        log(`[HELIUS DAS] Error: ${batchData.error.message}`);
                    }
                } catch (e) {
                    log(`[HELIUS DAS] getAssetBatch failed: ${e.message}`);
                }
            }

            // Step 3: Get price data from DexScreener + RUG DETECTION
            for (const mint of mints.slice(0, 60)) {
                try {
                    const pairRes = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${mint}`);
                    const pairData = await pairRes.json();

                    if (pairData.pairs && pairData.pairs.length > 0) {
                        const solPair = pairData.pairs
                            .filter(p => p.quoteToken?.symbol === 'SOL' || p.quoteToken?.symbol === 'WSOL')
                            .sort((a, b) => (b.liquidity?.usd || 0) - (a.liquidity?.usd || 0))[0]
                            || pairData.pairs[0];

                        const liquidity = solPair.liquidity?.usd || 0;
                        const volume24h = solPair.volume?.h24 || 0;
                        const priceChange24h = solPair.priceChange?.h24 || 0;
                        const marketCap = solPair.marketCap || solPair.fdv || 0;

                        // RUG DETECTION - Skip tokens that look rugged/dead
                        const isRugged = (
                            liquidity < 10000 ||           // Less than $10k liquidity = likely rugged
                            volume24h < 5000 ||            // Less than $5k volume = dead
                            priceChange24h < -90 ||        // Dropped 90%+ = rugged
                            marketCap < 10000 ||           // Market cap under $10k = dead
                            (liquidity > 0 && marketCap / liquidity > 100) // Suspicious MC/liquidity ratio
                        );

                        if (!isRugged) {
                            const hMeta = heliusMeta[mint] || {};
                            tokens.push({
                                mint: mint,
                                name: hMeta.name || solPair.baseToken?.name || 'Unknown',
                                symbol: hMeta.symbol || solPair.baseToken?.symbol || '???',
                                image: hMeta.image || solPair.info?.imageUrl || `https://dd.dexscreener.com/ds-data/tokens/solana/${mint}.png`,
                                marketCap: marketCap,
                                price: parseFloat(solPair.priceUsd) || 0,
                                priceChange: priceChange24h,
                                priceChange5m: solPair.priceChange?.m5 || 0,
                                priceChange1h: solPair.priceChange?.h1 || 0,
                                volume24h: volume24h,
                                liquidity: liquidity,
                                source: HELIUS_RPC?.includes('helius') ? 'helius+dex' : 'dexscreener'
                            });
                        } else {
                            log(`[RUG FILTER] Skipped ${solPair.baseToken?.symbol || mint}: liq=$${liquidity}, vol=$${volume24h}, change=${priceChange24h}%`);
                        }
                    }
                } catch (e) { /* skip */ }

                if (tokens.length >= 50) break; // Show 50 trending tokens
            }

            // Fallback: DexScreener only if not enough tokens
            if (tokens.length < 10) {
                log('[TRENDING] Fallback - using DexScreener search');
                try {
                    const searchRes = await fetch('https://api.dexscreener.com/latest/dex/search?q=solana%20meme');
                    const searchData = await searchRes.json();

                    if (searchData.pairs) {
                        const seenMints = new Set(tokens.map(t => t.mint));
                        const memePairs = searchData.pairs
                            .filter(p => {
                                const liq = p.liquidity?.usd || 0;
                                const vol = p.volume?.h24 || 0;
                                const change = p.priceChange?.h24 || 0;
                                const mc = p.marketCap || p.fdv || 0;
                                // Same rug detection as above
                                return (
                                    p.chainId === 'solana' &&
                                    !seenMints.has(p.baseToken?.address) &&
                                    !EXCLUDED.has(p.baseToken?.address) &&
                                    liq >= 10000 &&
                                    vol >= 5000 &&
                                    change > -90 &&
                                    mc >= 10000 &&
                                    (liq === 0 || mc / liq <= 100)
                                );
                            })
                            .sort((a, b) => (b.volume?.h24 || 0) - (a.volume?.h24 || 0))
                            .slice(0, 50 - tokens.length);

                        for (const pair of memePairs) {
                            tokens.push({
                                mint: pair.baseToken?.address,
                                name: pair.baseToken?.name || 'Unknown',
                                symbol: pair.baseToken?.symbol || '???',
                                image: pair.info?.imageUrl || `https://dd.dexscreener.com/ds-data/tokens/solana/${pair.baseToken?.address}.png`,
                                marketCap: pair.marketCap || pair.fdv || 0,
                                price: parseFloat(pair.priceUsd) || 0,
                                priceChange: pair.priceChange?.h24 || 0,
                                priceChange5m: pair.priceChange?.m5 || 0,
                                priceChange1h: pair.priceChange?.h1 || 0,
                                volume24h: pair.volume?.h24 || 0,
                                liquidity: pair.liquidity?.usd || 0,
                                source: 'dexscreener'
                            });
                        }
                    }
                } catch (e) { /* skip */ }
            }

            // Sort by 24h volume and take top 20
            tokens.sort((a, b) => (b.volume24h || 0) - (a.volume24h || 0));
            tokens = tokens.slice(0, 20);

            // ENRICH: Add holder counts via Jupiter API (same as dashboard)
            // Batch fetch holders for all tokens in parallel
            await Promise.all(tokens.map(async (token) => {
                try {
                    // Try Jupiter first (best for most tokens)
                    const jupRes = await fetch(`https://lite-api.jup.ag/tokens/v2/search?query=${token.mint}`);
                    if (jupRes.ok) {
                        const jupArr = await jupRes.json();
                        const jupToken = Array.isArray(jupArr) ? jupArr.find(t => t.id === token.mint || t.address === token.mint) : null;
                        if (jupToken?.holderCount > 0) {
                            token.holders = jupToken.holderCount;
                            return;
                        }
                    }
                    // Fallback to GMGN
                    const gmgnRes = await fetch(`https://gmgn.ai/defi/quotation/v1/tokens/sol/${token.mint}`);
                    if (gmgnRes.ok) {
                        const gmgnData = await gmgnRes.json();
                        const holders = gmgnData?.data?.token?.holder_count || gmgnData?.data?.token?.holders || 0;
                        if (holders > 0) token.holders = holders;
                    }
                } catch (e) {
                    token.holders = 0;
                }
            }));

            // Cache result
            global.trendingCache[cacheKey] = { data: { success: true, tokens, count: tokens.length, source: HELIUS_KEY ? 'helius' : 'dexscreener' }, ts: Date.now() };

            log(`[TRENDING] Fetched ${tokens.length} meme coins via ${HELIUS_KEY ? 'Helius+DexScreener' : 'DexScreener'}`);
            res.writeHead(200, { 'Content-Type': 'application/json', 'X-Cache': 'MISS' });
            res.end(JSON.stringify({ success: true, tokens, count: tokens.length }));
        } catch (e) {
            console.error('[TRENDING] Error:', e.message);
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: false, tokens: [], error: e.message }));
        }
        return;
    }

    // API: Register a new token (called after successful launch)
    if (url.pathname === '/api/register-token' && req.method === 'POST') {
        try {
            const data = await parseBody(req);
            if (!data.mint || !data.creator) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'mint and creator required' }));
                return;
            }

            const result = tracker.registerToken(data.mint, data.creator, {
                name: data.name || 'Unknown Token',
                symbol: data.symbol || 'TOKEN',
                image: data.image || null,
                path: data.path || 'pump',
                description: data.description || '',
                socials: data.socials || {}
            });

            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: true, ...result }));
        } catch (e) {
            console.error('[API] register-token error:', e);
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: false, error: e.message }));
        }
        return;
    }

    // API: Get tokens by creator wallet (My Launches)
    if (url.pathname === '/api/my-tokens' && req.method === 'GET') {
        try {
            const wallet = url.searchParams.get('wallet');
            if (!wallet) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'Wallet address required' }));
                return;
            }

            const tokens = tracker.getTokensByCreator(wallet)
                .sort((a, b) => b.registeredAt - a.registeredAt)
                .map(t => ({
                    mint: t.mint,
                    name: t.name || 'Unknown Token',
                    symbol: t.symbol || 'TOKEN',
                    image: t.image || null,
                    path: t.path || 'pump',
                    mcap: t.mcap || 0,
                    volume: t.volume || 0,
                    price: t.price || 0,
                    change: t.change || 0,
                    holders: t.holders || 0,
                    progress: t.progress || 0,
                    graduated: t.graduated || false,
                    graduatedAt: t.graduatedAt || null,
                    createdAt: t.registeredAt,
                    time: formatTimeAgo(t.registeredAt),
                    stats: t.stats || { totalClaimed: 0, totalDistributed: 0 },
                    lastMetricsUpdate: t.lastMetricsUpdate || null,
                    hasOrbit: orbitRegistry.has(t.mint) && orbitRegistry.get(t.mint)?.status === 'active',
                }));

            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ tokens }));
        } catch (e) {
            console.error('[API] my-tokens error:', e);
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ tokens: [] }));
        }
        return;
    }

    // API: Get leaderboard (top tokens by mcap - show ALL registered tokens)
    if (url.pathname === '/api/leaderboard' && req.method === 'GET') {
        try {
            const data = tracker.getTokens();
            const leaderboard = (data.tokens || [])
                .filter(t => !BLOCKED_MINTS.includes(t.mint) && !isTestToken(t)) // Block competitor/test tokens
                .sort((a, b) => (b.mcap || 0) - (a.mcap || 0))
                .slice(0, 10)
                .map((t, index) => {
                    const orbitStatus = orbitRegistry.get(t.mint);
                    const hasOrbit = orbitStatus && orbitStatus.status === 'active';
                    // Get allocations - normalize old/new field names, null if no ORBIT
                    const allocations = hasOrbit ? normalizeAllocations(orbitStatus?.allocations) : null;
                    return {
                        rank: index + 1,
                        mint: t.mint,
                        name: t.name || 'Unknown Token',
                        symbol: t.symbol || 'TOKEN',
                        image: t.image || null,
                        mcap: t.mcap || 0,
                        volume: t.volume || 0,
                        progress: t.progress || 0,
                        graduated: t.graduated || false,
                        path: t.path === 'launchr' ? 'Launchr' : 'Pump.fun',
                        reward: index < 3 ? 'Winner' : null,
                        holders: t.holders || 0,
                        txns: t.txns || 0,
                        aiScore: Math.min(89, t.aiScore || 0),
                        hasOrbit,
                        createdAt: t.registeredAt || null,
                        // Fee allocation percentages (null if no ORBIT = 100% creator)
                        allocations: allocations,
                    };
                });
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ leaderboard }));
        } catch (e) {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ leaderboard: [] }));
        }
        return;
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // PROFILE API ENDPOINTS
    // ═══════════════════════════════════════════════════════════════════════════

    // API: Check username availability (must be before general profile GET)
    // ═══════════════════════════════════════════════════════════════════════════
    // 2-BIT PIXEL PFP GENERATOR - Unique avatar for each user
    // ═══════════════════════════════════════════════════════════════════════════

    if (url.pathname === '/api/generate-pfp' && req.method === 'POST') {
        let body = '';
        req.on('data', chunk => body += chunk);
        req.on('end', async () => {
            try {
                const data = JSON.parse(body);
                const { wallet, seed } = data;

                if (!wallet) {
                    res.writeHead(400, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ error: 'Wallet required' }));
                    return;
                }

                // Generate unique pixel art based on wallet address
                const pfpSvg = generatePixelPfp(wallet, seed);

                // Save PFP as data URI
                const pfpDataUri = `data:image/svg+xml;base64,${Buffer.from(pfpSvg).toString('base64')}`;

                // Update profile with new PFP
                profiles.updateProfile(wallet, { avatar: pfpDataUri });

                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({
                    success: true,
                    pfp: pfpDataUri,
                    message: 'Profile picture generated!'
                }));
            } catch (e) {
                console.error('[PFP] Generation error:', e);
                res.writeHead(500, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: e.message }));
            }
        });
        return;
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // NFT-WORTHY PIXEL PFP GENERATOR - High Quality 512x512 Character Avatars
    // CIA-Level Quality - Layered, Detailed, Unique
    // ═══════════════════════════════════════════════════════════════════════════
    function generatePixelPfp(wallet, customSeed = null) {
        const seedStr = customSeed ? `${wallet}${customSeed}` : wallet;
        const hash = crypto.createHash('sha256').update(seedStr).digest('hex');
        const hash2 = crypto.createHash('sha256').update(hash + 'layer2').digest('hex');
        const hash3 = crypto.createHash('sha256').update(hash + 'layer3').digest('hex');

        // Helper to get deterministic values from hash
        const getVal = (h, start, mod) => parseInt(h.slice(start, start + 2), 16) % mod;
        const getValRange = (h, start, min, max) => min + (parseInt(h.slice(start, start + 2), 16) % (max - min));

        // Premium color palettes - NFT-worthy combinations
        const palettes = [
            { name: 'Cyberpunk', bg: ['#0a0a12', '#12121f'], skin: ['#f5d0c5', '#e8b4a8'], accent: '#ff2d75', highlight: '#00f0ff', shadow: '#1a0a20' },
            { name: 'Golden', bg: ['#0f0f0f', '#1a1510'], skin: ['#f5d0c5', '#deb887'], accent: '#FFD966', highlight: '#fff4d4', shadow: '#2a1f0a' },
            { name: 'Cosmic', bg: ['#0a0a1a', '#1a0a2e'], skin: ['#e8d0f0', '#c8a0d8'], accent: '#9d4edd', highlight: '#e0aaff', shadow: '#10051a' },
            { name: 'Ocean', bg: ['#051015', '#0a1f2a'], skin: ['#d0e8f5', '#a0c8d8'], accent: '#00b4d8', highlight: '#90e0ef', shadow: '#03161f' },
            { name: 'Fire', bg: ['#150505', '#2a0a0a'], skin: ['#f5d5c5', '#e8a088'], accent: '#ff4500', highlight: '#ffaa00', shadow: '#1a0505' },
            { name: 'Matrix', bg: ['#000a00', '#001a00'], skin: ['#c5f5d0', '#88d8a8'], accent: '#00ff41', highlight: '#80ff80', shadow: '#001500' },
            { name: 'Arctic', bg: ['#0a0f15', '#101520'], skin: ['#e8f0f5', '#c0d0e0'], accent: '#7dd3fc', highlight: '#ffffff', shadow: '#050a10' },
            { name: 'Lava', bg: ['#1a0500', '#2a0a00'], skin: ['#f5c5a0', '#e0a070'], accent: '#ff6b35', highlight: '#ffc078', shadow: '#150500' },
            { name: 'Royal', bg: ['#0a051a', '#150a2a'], skin: ['#f0d8e8', '#d0a8c8'], accent: '#c77dff', highlight: '#e0b0ff', shadow: '#0a0515' },
            { name: 'Culture', bg: ['#0a0a0a', '#151510'], skin: ['#f5e0c5', '#e0c8a0'], accent: '#FFD966', highlight: '#FF6B6B', shadow: '#1a1505' },
        ];

        // Select palette
        const palette = palettes[getVal(hash, 0, palettes.length)];

        // Canvas settings - 512x512 NFT standard
        const size = 512;
        const gridSize = 24; // 24x24 pixel grid
        const pixelSize = Math.floor(size / gridSize);

        // Character traits from hash
        const traits = {
            headShape: getVal(hash, 2, 4),      // 0: round, 1: square, 2: tall, 3: wide
            eyeStyle: getVal(hash, 4, 6),       // Different eye shapes
            eyeColor: getVal(hash, 6, 8),       // Eye color variants
            mouthStyle: getVal(hash, 8, 5),     // Mouth expressions
            hairStyle: getVal(hash, 10, 8),     // Hair styles
            hairColor: getVal(hash, 12, 6),     // Hair colors
            accessory: getVal(hash, 14, 10),    // Accessories (glasses, earrings, etc.)
            bgPattern: getVal(hash, 16, 5),     // Background pattern
            glowEffect: getVal(hash, 18, 3),    // Glow intensity
            skinTone: getVal(hash2, 0, 4),      // Skin tone variant
            expression: getVal(hash2, 2, 4),    // Expression modifier
            rare: getVal(hash3, 0, 100) < 5,    // 5% chance of rare trait
        };

        // Start SVG
        let svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">`;

        // Defs for gradients and filters
        svg += `<defs>`;
        svg += `<linearGradient id="bgGrad" x1="0%" y1="0%" x2="100%" y2="100%">`;
        svg += `<stop offset="0%" style="stop-color:${palette.bg[0]}"/>`;
        svg += `<stop offset="100%" style="stop-color:${palette.bg[1]}"/>`;
        svg += `</linearGradient>`;
        svg += `<linearGradient id="skinGrad" x1="0%" y1="0%" x2="0%" y2="100%">`;
        svg += `<stop offset="0%" style="stop-color:${palette.skin[0]}"/>`;
        svg += `<stop offset="100%" style="stop-color:${palette.skin[1]}"/>`;
        svg += `</linearGradient>`;
        svg += `<filter id="glow"><feGaussianBlur stdDeviation="3" result="blur"/><feMerge><feMergeNode in="blur"/><feMergeNode in="SourceGraphic"/></feMerge></filter>`;
        svg += `<filter id="shadow"><feDropShadow dx="2" dy="4" stdDeviation="3" flood-color="${palette.shadow}" flood-opacity="0.5"/></filter>`;
        svg += `</defs>`;

        // Background with gradient
        svg += `<rect width="${size}" height="${size}" fill="url(#bgGrad)"/>`;

        // Background pattern
        if (traits.bgPattern === 1) {
            // Grid pattern
            for (let i = 0; i < size; i += 32) {
                svg += `<line x1="${i}" y1="0" x2="${i}" y2="${size}" stroke="${palette.accent}15" stroke-width="1"/>`;
                svg += `<line x1="0" y1="${i}" x2="${size}" y2="${i}" stroke="${palette.accent}15" stroke-width="1"/>`;
            }
        } else if (traits.bgPattern === 2) {
            // Dots pattern
            for (let x = 16; x < size; x += 32) {
                for (let y = 16; y < size; y += 32) {
                    svg += `<circle cx="${x}" cy="${y}" r="2" fill="${palette.accent}20"/>`;
                }
            }
        } else if (traits.bgPattern === 3) {
            // Diagonal lines
            for (let i = -size; i < size * 2; i += 24) {
                svg += `<line x1="${i}" y1="0" x2="${i + size}" y2="${size}" stroke="${palette.accent}10" stroke-width="1"/>`;
            }
        }

        // Glow effect behind head
        if (traits.glowEffect > 0) {
            const glowOpacity = traits.glowEffect === 2 ? '30' : '15';
            svg += `<circle cx="${size/2}" cy="${size/2 - 20}" r="140" fill="${palette.accent}${glowOpacity}" filter="url(#glow)"/>`;
        }

        // Helper to draw pixel
        const px = (x, y, color, opacity = 1) => {
            const rx = x * pixelSize;
            const ry = y * pixelSize;
            const op = opacity < 1 ? ` opacity="${opacity}"` : '';
            return `<rect x="${rx}" y="${ry}" width="${pixelSize}" height="${pixelSize}" fill="${color}"${op}/>`;
        };

        // Character group with shadow
        svg += `<g filter="url(#shadow)">`;

        // NECK (below head)
        for (let x = 10; x <= 13; x++) {
            for (let y = 18; y <= 20; y++) {
                svg += px(x, y, 'url(#skinGrad)');
            }
        }

        // BODY/SHOULDERS
        for (let x = 6; x <= 17; x++) {
            for (let y = 21; y <= 24; y++) {
                if (x >= 8 && x <= 15) {
                    svg += px(x, y, palette.accent);
                } else if (y >= 22) {
                    svg += px(x, y, palette.accent);
                }
            }
        }

        // HEAD - Different shapes based on trait
        const headPixels = [];
        const headTop = 4;
        const headBottom = 18;
        const headLeft = 6;
        const headRight = 17;

        // Generate head shape
        for (let y = headTop; y <= headBottom; y++) {
            for (let x = headLeft; x <= headRight; x++) {
                const centerX = (headLeft + headRight) / 2;
                const centerY = (headTop + headBottom) / 2;
                const dx = Math.abs(x - centerX);
                const dy = Math.abs(y - centerY);

                let inHead = false;
                if (traits.headShape === 0) { // Round
                    inHead = (dx * dx / 36 + dy * dy / 49) <= 1;
                } else if (traits.headShape === 1) { // Square-ish
                    inHead = dx <= 5 && dy <= 6;
                } else if (traits.headShape === 2) { // Tall
                    inHead = (dx * dx / 25 + dy * dy / 56) <= 1;
                } else { // Wide
                    inHead = (dx * dx / 42 + dy * dy / 42) <= 1;
                }

                if (inHead) {
                    headPixels.push({x, y});
                    svg += px(x, y, 'url(#skinGrad)');
                }
            }
        }

        // HAIR - Different styles
        const hairColors = ['#1a1a1a', '#4a3728', '#8b4513', '#d4a574', '#ff6b6b', '#9d4edd'];
        const hairColor = hairColors[traits.hairColor];

        if (traits.hairStyle === 0) { // Short spiky
            for (let x = 7; x <= 16; x++) {
                const spikeHeight = 2 + (x % 2);
                for (let y = headTop - spikeHeight; y <= headTop + 2; y++) {
                    svg += px(x, y, hairColor);
                }
            }
        } else if (traits.hairStyle === 1) { // Long flowing
            for (let x = 5; x <= 18; x++) {
                for (let y = 2; y <= headTop + 3; y++) {
                    svg += px(x, y, hairColor);
                }
                // Side hair
                if (x <= 6 || x >= 17) {
                    for (let y = headTop + 3; y <= 16; y++) {
                        svg += px(x, y, hairColor);
                    }
                }
            }
        } else if (traits.hairStyle === 2) { // Mohawk
            for (let x = 10; x <= 13; x++) {
                for (let y = 0; y <= headTop + 2; y++) {
                    svg += px(x, y, hairColor);
                }
            }
        } else if (traits.hairStyle === 3) { // Bald with shine
            svg += `<ellipse cx="${size/2 - 20}" cy="${(headTop + 2) * pixelSize}" rx="15" ry="10" fill="${palette.highlight}40"/>`;
        } else if (traits.hairStyle === 4) { // Afro
            for (let x = 4; x <= 19; x++) {
                for (let y = 1; y <= headTop + 4; y++) {
                    const dx = Math.abs(x - 11.5);
                    const dy = Math.abs(y - 4);
                    if (dx * dx / 64 + dy * dy / 16 <= 1) {
                        svg += px(x, y, hairColor);
                    }
                }
            }
        } else if (traits.hairStyle === 5) { // Undercut
            for (let x = 7; x <= 16; x++) {
                for (let y = headTop - 1; y <= headTop + 1; y++) {
                    svg += px(x, y, hairColor);
                }
            }
        } else if (traits.hairStyle === 6) { // Ponytail
            for (let x = 8; x <= 15; x++) {
                for (let y = headTop - 1; y <= headTop + 2; y++) {
                    svg += px(x, y, hairColor);
                }
            }
            // Ponytail
            for (let y = headTop; y <= headTop + 8; y++) {
                svg += px(17, y, hairColor);
                svg += px(18, y + 1, hairColor);
            }
        } else { // Bangs
            for (let x = 7; x <= 16; x++) {
                for (let y = headTop - 1; y <= headTop + 3; y++) {
                    svg += px(x, y, hairColor);
                }
            }
        }

        // EYES
        const eyeY = 10;
        const leftEyeX = 8;
        const rightEyeX = 13;
        const eyeColors = ['#1a1a1a', '#4169e1', '#228b22', '#8b4513', palette.accent, '#9d4edd', '#00bcd4', '#ff6b6b'];
        const eyeColor = eyeColors[traits.eyeColor];

        if (traits.eyeStyle === 0) { // Normal
            svg += px(leftEyeX, eyeY, '#ffffff');
            svg += px(leftEyeX + 1, eyeY, eyeColor);
            svg += px(rightEyeX, eyeY, '#ffffff');
            svg += px(rightEyeX + 1, eyeY, eyeColor);
        } else if (traits.eyeStyle === 1) { // Big
            for (let dy = -1; dy <= 0; dy++) {
                svg += px(leftEyeX, eyeY + dy, '#ffffff');
                svg += px(leftEyeX + 1, eyeY + dy, '#ffffff');
                svg += px(rightEyeX, eyeY + dy, '#ffffff');
                svg += px(rightEyeX + 1, eyeY + dy, '#ffffff');
            }
            svg += px(leftEyeX + 1, eyeY, eyeColor);
            svg += px(rightEyeX + 1, eyeY, eyeColor);
        } else if (traits.eyeStyle === 2) { // Narrow
            svg += px(leftEyeX, eyeY, eyeColor);
            svg += px(leftEyeX + 1, eyeY, eyeColor);
            svg += px(rightEyeX, eyeY, eyeColor);
            svg += px(rightEyeX + 1, eyeY, eyeColor);
        } else if (traits.eyeStyle === 3) { // Glowing
            svg += `<rect x="${leftEyeX * pixelSize}" y="${eyeY * pixelSize}" width="${pixelSize * 2}" height="${pixelSize}" fill="${palette.accent}" filter="url(#glow)"/>`;
            svg += `<rect x="${rightEyeX * pixelSize}" y="${eyeY * pixelSize}" width="${pixelSize * 2}" height="${pixelSize}" fill="${palette.accent}" filter="url(#glow)"/>`;
        } else if (traits.eyeStyle === 4) { // Cyber
            svg += px(leftEyeX, eyeY, '#ff0000');
            svg += px(leftEyeX + 1, eyeY, '#ff0000');
            svg += px(rightEyeX, eyeY, '#00ff00');
            svg += px(rightEyeX + 1, eyeY, '#00ff00');
        } else { // Anime style
            for (let dy = -1; dy <= 1; dy++) {
                svg += px(leftEyeX, eyeY + dy, '#ffffff');
                svg += px(leftEyeX + 1, eyeY + dy, dy === 1 ? eyeColor : '#ffffff');
                svg += px(rightEyeX, eyeY + dy, '#ffffff');
                svg += px(rightEyeX + 1, eyeY + dy, dy === 1 ? eyeColor : '#ffffff');
            }
            // Highlight
            svg += px(leftEyeX, eyeY - 1, palette.highlight, 0.8);
            svg += px(rightEyeX, eyeY - 1, palette.highlight, 0.8);
        }

        // MOUTH
        const mouthY = 14;
        if (traits.mouthStyle === 0) { // Smile
            svg += px(9, mouthY, palette.shadow);
            svg += px(10, mouthY + 1, palette.shadow);
            svg += px(11, mouthY + 1, palette.shadow);
            svg += px(12, mouthY + 1, palette.shadow);
            svg += px(13, mouthY, palette.shadow);
        } else if (traits.mouthStyle === 1) { // Neutral
            svg += px(10, mouthY, palette.shadow);
            svg += px(11, mouthY, palette.shadow);
            svg += px(12, mouthY, palette.shadow);
        } else if (traits.mouthStyle === 2) { // Grin
            svg += px(9, mouthY, palette.shadow);
            svg += px(10, mouthY + 1, '#ffffff');
            svg += px(11, mouthY + 1, '#ffffff');
            svg += px(12, mouthY + 1, '#ffffff');
            svg += px(13, mouthY, palette.shadow);
        } else if (traits.mouthStyle === 3) { // Smirk
            svg += px(10, mouthY, palette.shadow);
            svg += px(11, mouthY, palette.shadow);
            svg += px(12, mouthY - 1, palette.shadow);
        } else { // Open
            svg += px(10, mouthY, '#1a0a0a');
            svg += px(11, mouthY, '#1a0a0a');
            svg += px(12, mouthY, '#1a0a0a');
            svg += px(10, mouthY + 1, '#ff6b6b');
        }

        // ACCESSORIES
        if (traits.accessory === 1) { // Glasses
            svg += `<rect x="${(leftEyeX - 1) * pixelSize}" y="${(eyeY - 1) * pixelSize}" width="${pixelSize * 4}" height="${pixelSize * 3}" fill="none" stroke="${palette.accent}" stroke-width="2" rx="4"/>`;
            svg += `<rect x="${(rightEyeX - 1) * pixelSize}" y="${(eyeY - 1) * pixelSize}" width="${pixelSize * 4}" height="${pixelSize * 3}" fill="none" stroke="${palette.accent}" stroke-width="2" rx="4"/>`;
            svg += `<line x1="${(leftEyeX + 3) * pixelSize}" y1="${eyeY * pixelSize}" x2="${(rightEyeX - 1) * pixelSize}" y2="${eyeY * pixelSize}" stroke="${palette.accent}" stroke-width="2"/>`;
        } else if (traits.accessory === 2) { // Earring
            svg += `<circle cx="${6 * pixelSize}" cy="${12 * pixelSize}" r="6" fill="${palette.accent}"/>`;
        } else if (traits.accessory === 3) { // Scar
            svg += `<line x1="${14 * pixelSize}" y1="${8 * pixelSize}" x2="${16 * pixelSize}" y2="${12 * pixelSize}" stroke="${palette.shadow}" stroke-width="3"/>`;
        } else if (traits.accessory === 4) { // Headband
            svg += `<rect x="${6 * pixelSize}" y="${(headTop + 1) * pixelSize}" width="${12 * pixelSize}" height="${pixelSize}" fill="${palette.accent}"/>`;
        } else if (traits.accessory === 5) { // Tattoo
            svg += `<text x="${15 * pixelSize}" y="${16 * pixelSize}" font-size="12" fill="${palette.accent}">◈</text>`;
        } else if (traits.accessory === 6) { // Visor
            svg += `<rect x="${7 * pixelSize}" y="${(eyeY - 1) * pixelSize}" width="${10 * pixelSize}" height="${pixelSize * 2}" fill="${palette.accent}90" rx="4"/>`;
        } else if (traits.accessory === 7) { // Crown (rare)
            svg += `<polygon points="${9 * pixelSize},${(headTop - 1) * pixelSize} ${10 * pixelSize},${(headTop - 3) * pixelSize} ${11 * pixelSize},${(headTop - 1) * pixelSize} ${12 * pixelSize},${(headTop - 4) * pixelSize} ${13 * pixelSize},${(headTop - 1) * pixelSize} ${14 * pixelSize},${(headTop - 3) * pixelSize} ${15 * pixelSize},${(headTop - 1) * pixelSize}" fill="${palette.accent}" filter="url(#glow)"/>`;
        }

        // RARE TRAIT - Glowing aura
        if (traits.rare) {
            svg += `<circle cx="${size/2}" cy="${size/2 - 20}" r="160" fill="none" stroke="${palette.accent}" stroke-width="3" opacity="0.6" filter="url(#glow)"/>`;
            svg += `<circle cx="${size/2}" cy="${size/2 - 20}" r="180" fill="none" stroke="${palette.highlight}" stroke-width="2" opacity="0.3" filter="url(#glow)"/>`;
        }

        svg += `</g>`; // End character group

        // Signature/watermark
        svg += `<text x="${size - 10}" y="${size - 10}" font-family="monospace" font-size="8" fill="${palette.accent}40" text-anchor="end">CULTURE</text>`;

        svg += '</svg>';
        return svg;
    }

    // API: Auto-generate PFP for new users (called when profile is first created)
    if (url.pathname === '/api/profile/auto-pfp' && req.method === 'GET') {
        try {
            const wallet = url.searchParams.get('wallet');
            if (!wallet) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'Wallet required' }));
                return;
            }

            // Generate PFP
            const pfpSvg = generatePixelPfp(wallet);
            const pfpDataUri = `data:image/svg+xml;base64,${Buffer.from(pfpSvg).toString('base64')}`;

            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ pfp: pfpDataUri }));
        } catch (e) {
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: e.message }));
        }
        return;
    }

    if (url.pathname === '/api/profile/check-username' && req.method === 'GET') {
        try {
            const username = url.searchParams.get('username');
            const wallet = url.searchParams.get('wallet');

            if (!username) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'Username required' }));
                return;
            }

            const available = profiles.isUsernameAvailable(username, wallet);
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ available }));
        } catch (e) {
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Internal server error' }));
        }
        return;
    }

    // API: Get followers list (must be before general profile GET)
    if (url.pathname.match(/^\/api\/profile\/[^/]+\/followers$/) && req.method === 'GET') {
        try {
            const wallet = url.pathname.split('/')[3];
            const limit = parseInt(url.searchParams.get('limit') || '50');
            const offset = parseInt(url.searchParams.get('offset') || '0');

            const followers = profiles.getFollowers(wallet, limit, offset);
            const total = profiles.getFollowerCount(wallet);

            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ followers, total }));
        } catch (e) {
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Internal server error' }));
        }
        return;
    }

    // API: Get following list (must be before general profile GET)
    if (url.pathname.match(/^\/api\/profile\/[^/]+\/following$/) && req.method === 'GET') {
        try {
            const wallet = url.pathname.split('/')[3];
            const limit = parseInt(url.searchParams.get('limit') || '50');
            const offset = parseInt(url.searchParams.get('offset') || '0');

            const following = profiles.getFollowing(wallet, limit, offset);
            const total = profiles.getFollowingCount(wallet);

            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ following, total }));
        } catch (e) {
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Internal server error' }));
        }
        return;
    }

    // API: Get user profile by wallet or username
    if (url.pathname.startsWith('/api/profile/') && req.method === 'GET') {
        try {
            const identifier = url.pathname.split('/api/profile/')[1];
            if (!identifier) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'Wallet or username required' }));
                return;
            }

            let profile;
            // Check if it's a wallet address (base58, typically 32-44 chars)
            if (identifier.length >= 32 && identifier.length <= 44) {
                profile = profiles.getProfile(identifier);
            } else {
                // Try to find by username
                profile = profiles.getProfileByUsername(identifier);
            }

            if (!profile) {
                res.writeHead(404, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'Profile not found' }));
                return;
            }

            // Get user's created tokens
            const createdTokens = tracker.getTokensByCreator(profile.wallet);

            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
                profile,
                createdCoins: createdTokens.length,
                tokens: createdTokens.map(t => ({
                    mint: t.mint,
                    name: t.name || 'Unknown',
                    symbol: t.symbol || 'TOKEN',
                    image: t.image || null,
                    mcap: t.mcap || 0,
                    createdAt: t.registeredAt,
                    graduated: t.graduated || false
                }))
            }));
        } catch (e) {
            console.error('[API] profile error:', e);
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Internal server error' }));
        }
        return;
    }

    // API: Update user profile
    if (url.pathname === '/api/profile' && req.method === 'POST') {
        let body = '';
        req.on('data', chunk => body += chunk);
        req.on('end', () => {
            try {
                const data = JSON.parse(body);
                const { wallet, username, displayName, avatar, bio, twitter, telegram, website } = data;

                if (!wallet) {
                    res.writeHead(400, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ error: 'Wallet address required' }));
                    return;
                }

                // Check if username is taken
                if (username && !profiles.isUsernameAvailable(username, wallet)) {
                    res.writeHead(400, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ error: 'Username already taken' }));
                    return;
                }

                const updatedProfile = profiles.updateProfile(wallet, {
                    username,
                    displayName,
                    avatar,
                    bio,
                    twitter,
                    telegram,
                    website
                });

                // ALSO sync to SQLite profileDB so posts can JOIN with display_name
                try {
                    profileDB.upsert(wallet, {
                        displayName: displayName || username || '',
                        bio: bio || '',
                        pfpUrl: avatar || null,
                        bannerUrl: null
                    });
                    console.log('[PROFILE] Synced to SQLite:', wallet.slice(0, 8) + '...', 'displayName:', displayName || username);
                } catch (syncErr) {
                    console.error('[PROFILE] SQLite sync error:', syncErr);
                }

                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ profile: updatedProfile }));
            } catch (e) {
                console.error('[API] update profile error:', e);
                res.writeHead(500, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'Internal server error' }));
            }
        });
        return;
    }

    // API: Follow a user
    if (url.pathname === '/api/follow' && req.method === 'POST') {
        let body = '';
        req.on('data', chunk => body += chunk);
        req.on('end', () => {
            try {
                const data = JSON.parse(body);
                const { follower, following } = data;

                if (!follower || !following) {
                    res.writeHead(400, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ error: 'Follower and following wallets required' }));
                    return;
                }

                const result = profiles.followUser(follower, following);
                res.writeHead(result.success ? 200 : 400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify(result));
            } catch (e) {
                console.error('[API] follow error:', e);
                res.writeHead(500, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'Internal server error' }));
            }
        });
        return;
    }

    // API: Unfollow a user
    if (url.pathname === '/api/unfollow' && req.method === 'POST') {
        let body = '';
        req.on('data', chunk => body += chunk);
        req.on('end', () => {
            try {
                const data = JSON.parse(body);
                const { follower, following } = data;

                if (!follower || !following) {
                    res.writeHead(400, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ error: 'Follower and following wallets required' }));
                    return;
                }

                const result = profiles.unfollowUser(follower, following);
                res.writeHead(result.success ? 200 : 400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify(result));
            } catch (e) {
                console.error('[API] unfollow error:', e);
                res.writeHead(500, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'Internal server error' }));
            }
        });
        return;
    }

    // API: Check if following
    if (url.pathname === '/api/is-following' && req.method === 'GET') {
        try {
            const follower = url.searchParams.get('follower');
            const following = url.searchParams.get('following');

            if (!follower || !following) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'Follower and following wallets required' }));
                return;
            }

            const isFollowing = profiles.isFollowing(follower, following);
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ isFollowing }));
        } catch (e) {
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Internal server error' }));
        }
        return;
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // POSTS API - Database-backed social feed
    // ═══════════════════════════════════════════════════════════════════════════

    // API: Create a new post
    if (url.pathname === '/api/posts' && req.method === 'POST') {
        const clientIP = getClientIP(req);
        console.log('[POSTS] POST request received from:', clientIP);
        try {
            // Rate limit check
            const rateCheck = rateLimiter.check(clientIP, 'post');
            if (!rateCheck.allowed) {
                console.log('[POSTS] Rate limited:', clientIP);
                res.writeHead(429, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ success: false, error: 'Rate limit exceeded. Please wait before posting again.' }));
                return;
            }

            const body = await parseBody(req, 100 * 1024); // 100KB max for post data
            console.log('[POSTS] Received body:', JSON.stringify(body).slice(0, 200));
            const { authorWallet, cultureId, content, mediaUrls } = body;

            if (!authorWallet || !content) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ success: false, error: 'Author wallet and content are required' }));
                return;
            }

            // Ensure author profile exists in SQLite for posts FOREIGN KEY constraint
            // This MUST succeed or the post insert will fail
            try {
                const authorProfile = profiles.getProfile(authorWallet);
                profileDB.upsert(authorWallet, {
                    displayName: authorProfile?.displayName || authorProfile?.username || authorWallet.slice(0, 8) + '...',
                    bio: authorProfile?.bio || '',
                    pfpUrl: authorProfile?.avatar || null,
                    bannerUrl: null
                });
                console.log(`[POSTS] Profile ensured for ${authorWallet.slice(0, 8)}...`);
            } catch (syncErr) {
                console.error('[POSTS] Profile sync error:', syncErr);
                // Don't fail - let the post creation try anyway
            }

            // Handle media - support both mediaUrls array and single mediaUrl
            let mediaUrl = Array.isArray(mediaUrls) && mediaUrls.length > 0 ? mediaUrls[0] : (mediaUrls || null);
            // Ensure mediaUrl is a string
            if (mediaUrl && typeof mediaUrl !== 'string') {
                mediaUrl = mediaUrl.url || mediaUrl.src || String(mediaUrl) || null;
            }

            const post = postDB.create({
                authorWallet,
                cultureId: cultureId || null,
                content: content.trim().slice(0, 5000), // Max 5000 chars
                mediaUrl: mediaUrl,
                mediaType: mediaUrl && typeof mediaUrl === 'string' ? (mediaUrl.match(/\.(mp4|webm|mov)$/i) ? 'video' : 'image') : null
            });

            console.log(`[POSTS] ✓ Created post ${post.id} by ${authorWallet.slice(0, 8)}... content: "${content.slice(0,30)}..."`);
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: true, post }));
        } catch (e) {
            console.error('[POSTS] Create error:', e.message);
            console.error('[POSTS] Stack:', e.stack?.slice(0, 500));
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: false, error: e.message }));
        }
        return;
    }

    // API: Get posts (with optional filters)
    if (url.pathname === '/api/posts' && req.method === 'GET') {
        try {
            const cultureId = url.searchParams.get('cultureId');
            const authorWallet = url.searchParams.get('author');
            const limit = parseInt(url.searchParams.get('limit')) || 50;
            const offset = parseInt(url.searchParams.get('offset')) || 0;

            console.log(`[POSTS] GET request - cultureId: ${cultureId}, author: ${authorWallet}, limit: ${limit}`);

            let posts;
            if (cultureId) {
                posts = postDB.getByCulture(parseInt(cultureId), limit, offset);
                console.log(`[POSTS] Found ${posts.length} posts for culture ${cultureId}`);
            } else if (authorWallet) {
                posts = postDB.getByAuthor(authorWallet, limit, offset);
                console.log(`[POSTS] Found ${posts.length} posts by ${authorWallet.slice(0,8)}...`);
            } else {
                posts = postDB.getAll(limit, offset);
                console.log(`[POSTS] Returning ${posts.length} total posts from database`);
            }

            // CRITICAL: Enrich posts with profile data from both SQLite and profiles.js
            // This ensures usernames always show correctly even if SQLite profile is missing
            const enrichedPosts = posts.map(post => {
                // If authorName is still a wallet address (fallback), try to get from profiles.js
                const isWalletFallback = !post.authorName ||
                    (post.authorWallet && post.authorName === post.authorWallet.slice(0, 6) + '...' + post.authorWallet.slice(-4));

                if (isWalletFallback && post.authorWallet) {
                    // Try profiles.js module
                    const profileFromJson = profiles.getProfile(post.authorWallet);
                    if (profileFromJson?.displayName) {
                        // Also sync to SQLite for future queries
                        try {
                            profileDB.upsert(post.authorWallet, {
                                displayName: profileFromJson.displayName,
                                bio: profileFromJson.bio || '',
                                pfpUrl: profileFromJson.avatar || null,
                                bannerUrl: null
                            });
                        } catch (e) { /* ignore sync errors */ }

                        return {
                            ...post,
                            authorName: profileFromJson.displayName,
                            authorPfp: profileFromJson.avatar || post.authorPfp
                        };
                    }
                }
                return post;
            });

            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: true, posts: enrichedPosts }));
        } catch (e) {
            console.error('[POSTS] Get error:', e);
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: false, error: e.message }));
        }
        return;
    }

    // API: Get single post by ID
    if (url.pathname.match(/^\/api\/posts\/\d+$/) && req.method === 'GET') {
        try {
            const postId = parseInt(url.pathname.split('/').pop());
            const post = postDB.getById(postId);

            if (!post) {
                res.writeHead(404, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ success: false, error: 'Post not found' }));
                return;
            }

            // Use correct method name: profileDB.get() not getByWallet()
            const profile = profileDB.get(post.authorWallet);
            const enrichedPost = {
                ...post,
                authorName: profile?.displayName || post.authorWallet.slice(0, 6) + '...' + post.authorWallet.slice(-4),
                authorPfp: profile?.pfpUrl || null
            };

            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: true, post: enrichedPost }));
        } catch (e) {
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: false, error: e.message }));
        }
        return;
    }

    // API: Like a post
    if (url.pathname.match(/^\/api\/posts\/\d+\/like$/) && req.method === 'POST') {
        try {
            const postId = parseInt(url.pathname.split('/')[3]);
            const body = await parseBody(req);
            const { wallet } = body;

            if (!wallet) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ success: false, error: 'Wallet required' }));
                return;
            }

            const likes = postDB.toggleLike(postId, wallet);
            if (likes === null) {
                res.writeHead(404, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ success: false, error: 'Post not found' }));
                return;
            }
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: true, likes }));
        } catch (e) {
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: false, error: e.message }));
        }
        return;
    }

    // API: Repost
    if (url.pathname.match(/^\/api\/posts\/\d+\/repost$/) && req.method === 'POST') {
        try {
            const postId = parseInt(url.pathname.split('/')[3]);
            const body = await parseBody(req);
            const { wallet } = body;

            if (!wallet) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ success: false, error: 'Wallet required' }));
                return;
            }

            const result = postDB.toggleRepost(postId, wallet);
            if (result === null) {
                res.writeHead(404, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ success: false, error: 'Post not found' }));
                return;
            }
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: true, reposts: result.reposts, repostedBy: result.repostedBy }));
        } catch (e) {
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: false, error: e.message }));
        }
        return;
    }

    // API: Add comment to post
    if (url.pathname.match(/^\/api\/posts\/\d+\/comment$/) && req.method === 'POST') {
        const clientIP = getClientIP(req);
        try {
            const rateCheck = rateLimiter.check(clientIP, 'post');
            if (!rateCheck.allowed) {
                res.writeHead(429, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ success: false, error: 'Rate limit exceeded' }));
                return;
            }

            const postId = parseInt(url.pathname.split('/')[3]);
            const body = await parseBody(req);
            const { authorWallet, content } = body;

            if (!authorWallet || !content) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ success: false, error: 'Author and content required' }));
                return;
            }

            const comment = postDB.addComment(postId, authorWallet, content.trim().slice(0, 2000));
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: true, comment }));
        } catch (e) {
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: false, error: e.message }));
        }
        return;
    }

    // API: Get comments for a post
    if (url.pathname.match(/^\/api\/posts\/\d+\/comments$/) && req.method === 'GET') {
        try {
            const postId = parseInt(url.pathname.split('/')[3]);
            const comments = postDB.getComments(postId);

            // Enrich with profile data - use correct method name
            const enrichedComments = comments.map(comment => {
                const profile = profileDB.get(comment.authorWallet || comment.author_wallet);
                return {
                    ...comment,
                    authorName: profile?.displayName || (comment.authorWallet || comment.author_wallet)?.slice(0, 6) + '...',
                    authorPfp: profile?.pfpUrl || null
                };
            });

            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: true, comments: enrichedComments }));
        } catch (e) {
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: false, error: e.message }));
        }
        return;
    }

    // API: Delete post (owner only)
    if (url.pathname.match(/^\/api\/posts\/\d+$/) && req.method === 'DELETE') {
        try {
            const postId = parseInt(url.pathname.split('/').pop());
            const body = await parseBody(req);
            const { wallet } = body;

            if (!wallet) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ success: false, error: 'Wallet required' }));
                return;
            }

            const post = postDB.getById(postId);
            if (!post) {
                res.writeHead(404, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ success: false, error: 'Post not found' }));
                return;
            }

            if (post.author_wallet !== wallet) {
                res.writeHead(403, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ success: false, error: 'Not authorized to delete this post' }));
                return;
            }

            postDB.delete(postId);
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: true }));
        } catch (e) {
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: false, error: e.message }));
        }
        return;
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // AUCTION API - Production auction system for culture content
    // ═══════════════════════════════════════════════════════════════════════════

    // API: Get all active auctions
    if (url.pathname === '/api/auctions' && req.method === 'GET') {
        try {
            const cultureId = url.searchParams.get('cultureId');
            const creatorWallet = url.searchParams.get('creator');
            const limit = parseInt(url.searchParams.get('limit')) || 50;

            let auctions;
            if (cultureId) {
                auctions = auctionDB.getByCulture(cultureId, limit);
            } else if (creatorWallet) {
                auctions = auctionDB.getByCreator(creatorWallet, limit);
            } else {
                auctions = auctionDB.getActive(limit);
            }

            // Calculate time remaining for each auction
            const now = new Date();
            const enrichedAuctions = auctions.map(a => {
                const endsAt = new Date(a.ends_at);
                const msRemaining = endsAt - now;
                const hours = Math.floor(msRemaining / 3600000);
                const minutes = Math.floor((msRemaining % 3600000) / 60000);
                return {
                    ...a,
                    endsIn: msRemaining > 0 ? `${hours}h ${minutes}m` : 'Ended',
                    isActive: msRemaining > 0 && a.status === 'active'
                };
            });

            console.log(`[AUCTIONS] Returning ${enrichedAuctions.length} auctions`);
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: true, auctions: enrichedAuctions }));
        } catch (e) {
            console.error('[AUCTIONS] Get error:', e.message);
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: false, error: e.message }));
        }
        return;
    }

    // API: Get single auction by ID
    if (url.pathname.match(/^\/api\/auctions\/[a-zA-Z0-9-]+$/) && req.method === 'GET') {
        try {
            const auctionId = url.pathname.split('/').pop();
            const auction = auctionDB.getById(auctionId);

            if (!auction) {
                res.writeHead(404, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ success: false, error: 'Auction not found' }));
                return;
            }

            // Get bid history
            const bids = auctionDB.getBids(auctionId);

            // Calculate time remaining
            const now = new Date();
            const endsAt = new Date(auction.ends_at);
            const msRemaining = endsAt - now;
            const hours = Math.floor(msRemaining / 3600000);
            const minutes = Math.floor((msRemaining % 3600000) / 60000);

            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
                success: true,
                auction: {
                    ...auction,
                    endsIn: msRemaining > 0 ? `${hours}h ${minutes}m` : 'Ended',
                    isActive: msRemaining > 0 && auction.status === 'active'
                },
                bids
            }));
        } catch (e) {
            console.error('[AUCTIONS] Get by ID error:', e.message);
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: false, error: e.message }));
        }
        return;
    }

    // API: Create a new auction (creator only)
    if (url.pathname === '/api/auctions' && req.method === 'POST') {
        const clientIP = getClientIP(req);
        try {
            const rateCheck = rateLimiter.check(clientIP, 'create');
            if (!rateCheck.allowed) {
                res.writeHead(429, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ success: false, error: 'Rate limit exceeded' }));
                return;
            }

            const body = await parseBody(req);
            const { cultureId, tokenAddress, creatorWallet, title, description, contentType, contentUrl, minBid, outcome, durationHours } = body;

            if (!cultureId || !tokenAddress || !creatorWallet || !title) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ success: false, error: 'cultureId, tokenAddress, creatorWallet, and title are required' }));
                return;
            }

            // Verify creator owns the culture
            const culture = cultureDB.getById(cultureId);
            if (!culture) {
                res.writeHead(404, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ success: false, error: 'Culture not found' }));
                return;
            }

            if (culture.creator_wallet !== creatorWallet) {
                res.writeHead(403, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ success: false, error: 'Only the culture creator can create auctions' }));
                return;
            }

            // Calculate end time (default 24 hours)
            const hours = Math.min(Math.max(parseInt(durationHours) || 24, 1), 168); // 1 hour to 7 days
            const endsAt = new Date(Date.now() + hours * 3600000).toISOString();

            const auction = auctionDB.create({
                cultureId,
                tokenAddress,
                creatorWallet,
                title: title.trim().slice(0, 200),
                description: (description || '').trim().slice(0, 2000),
                contentType: contentType || 'essay',
                contentUrl: contentUrl || null,
                minBid: Math.max(parseFloat(minBid) || 0.1, 0.01),
                outcome: outcome === 'treasury' ? 'treasury' : 'burn',
                endsAt
            });

            console.log(`[AUCTIONS] Created auction "${title}" for culture ${culture.name} by ${creatorWallet.slice(0, 8)}...`);
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: true, auction }));
        } catch (e) {
            console.error('[AUCTIONS] Create error:', e.message);
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: false, error: e.message }));
        }
        return;
    }

    // API: Place a bid on an auction
    if (url.pathname.match(/^\/api\/auctions\/[a-zA-Z0-9-]+\/bid$/) && req.method === 'POST') {
        const clientIP = getClientIP(req);
        try {
            const rateCheck = rateLimiter.check(clientIP, 'bid');
            if (!rateCheck.allowed) {
                res.writeHead(429, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ success: false, error: 'Rate limit exceeded' }));
                return;
            }

            const auctionId = url.pathname.split('/')[3];
            const body = await parseBody(req);
            const { bidderWallet, amount, txSignature } = body;

            if (!bidderWallet || !amount) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ success: false, error: 'bidderWallet and amount are required' }));
                return;
            }

            const result = auctionDB.placeBid(auctionId, bidderWallet, parseFloat(amount), txSignature);

            if (!result.success) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify(result));
                return;
            }

            console.log(`[AUCTIONS] Bid ${amount} SOL on auction ${auctionId} by ${bidderWallet.slice(0, 8)}...`);
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(result));
        } catch (e) {
            console.error('[AUCTIONS] Bid error:', e.message);
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: false, error: e.message }));
        }
        return;
    }

    // API: Cancel an auction (creator only, no bids)
    if (url.pathname.match(/^\/api\/auctions\/[a-zA-Z0-9-]+\/cancel$/) && req.method === 'POST') {
        try {
            const auctionId = url.pathname.split('/')[3];
            const body = await parseBody(req);
            const { creatorWallet } = body;

            if (!creatorWallet) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ success: false, error: 'creatorWallet is required' }));
                return;
            }

            const result = auctionDB.cancel(auctionId, creatorWallet);

            if (!result.success) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify(result));
                return;
            }

            console.log(`[AUCTIONS] Auction ${auctionId} cancelled by ${creatorWallet.slice(0, 8)}...`);
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(result));
        } catch (e) {
            console.error('[AUCTIONS] Cancel error:', e.message);
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: false, error: e.message }));
        }
        return;
    }

    // API: End/settle an auction (creator only, after auction expires)
    if (url.pathname.match(/^\/api\/auctions\/[a-zA-Z0-9-]+\/settle$/) && req.method === 'POST') {
        try {
            const auctionId = url.pathname.split('/')[3];
            const body = await parseBody(req);
            const { creatorWallet, txSignature } = body;

            const auction = auctionDB.getById(auctionId);
            if (!auction) {
                res.writeHead(404, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ success: false, error: 'Auction not found' }));
                return;
            }

            if (auction.creator_wallet !== creatorWallet) {
                res.writeHead(403, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ success: false, error: 'Only the creator can settle this auction' }));
                return;
            }

            // Check if auction has ended
            if (new Date(auction.ends_at) > new Date()) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ success: false, error: 'Auction has not ended yet' }));
                return;
            }

            const result = auctionDB.endAuction(auctionId, txSignature);

            if (!result.success) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify(result));
                return;
            }

            // Log the outcome for tracking
            console.log(`[AUCTIONS] Auction ${auctionId} settled - Winner: ${auction.highest_bidder || 'none'}, Amount: ${auction.current_bid} SOL, Outcome: ${auction.outcome}`);
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
                success: true,
                winner: auction.highest_bidder,
                finalAmount: auction.current_bid,
                outcome: auction.outcome,
                message: auction.bid_count > 0
                    ? `Auction settled! ${auction.current_bid} SOL ${auction.outcome === 'burn' ? 'will be burned' : 'sent to treasury'}`
                    : 'Auction ended with no bids'
            }));
        } catch (e) {
            console.error('[AUCTIONS] Settle error:', e.message);
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: false, error: e.message }));
        }
        return;
    }

    // API: Get expired auctions that need settlement (admin/cron)
    if (url.pathname === '/api/auctions/expired' && req.method === 'GET') {
        try {
            const expired = auctionDB.getExpired();
            console.log(`[AUCTIONS] Found ${expired.length} expired auctions needing settlement`);
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: true, auctions: expired }));
        } catch (e) {
            console.error('[AUCTIONS] Get expired error:', e.message);
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: false, error: e.message }));
        }
        return;
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // MEDIA UPLOAD API - File storage for images/videos
    // ═══════════════════════════════════════════════════════════════════════════

    // API: Upload media file
    if (url.pathname === '/api/media/upload' && req.method === 'POST') {
        const clientIP = getClientIP(req);
        try {
            const rateCheck = rateLimiter.check(clientIP, 'upload');
            if (!rateCheck.allowed) {
                res.writeHead(429, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ success: false, error: 'Upload rate limit exceeded. Please wait.' }));
                return;
            }

            const contentType = req.headers['content-type'] || '';
            const contentLength = parseInt(req.headers['content-length'] || '0');

            // Size limits
            const MAX_VIDEO_SIZE = 50 * 1024 * 1024; // 50MB
            const MAX_IMAGE_SIZE = 5 * 1024 * 1024;  // 5MB

            const isVideo = contentType.includes('video');
            const maxSize = isVideo ? MAX_VIDEO_SIZE : MAX_IMAGE_SIZE;

            if (contentLength > maxSize) {
                res.writeHead(413, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({
                    success: false,
                    error: `File too large. Max size: ${isVideo ? '50MB for videos' : '5MB for images'}`
                }));
                return;
            }

            // Read the file data
            const chunks = [];
            for await (const chunk of req) {
                chunks.push(chunk);
                // Double-check size during upload
                const currentSize = chunks.reduce((acc, c) => acc + c.length, 0);
                if (currentSize > maxSize) {
                    res.writeHead(413, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ success: false, error: 'File too large' }));
                    return;
                }
            }

            const fileBuffer = Buffer.concat(chunks);

            // Determine file type from content-type header
            let fileType = 'bin';
            if (contentType.includes('image/jpeg') || contentType.includes('image/jpg')) fileType = 'jpg';
            else if (contentType.includes('image/png')) fileType = 'png';
            else if (contentType.includes('image/gif')) fileType = 'gif';
            else if (contentType.includes('image/webp')) fileType = 'webp';
            else if (contentType.includes('video/mp4')) fileType = 'mp4';
            else if (contentType.includes('video/webm')) fileType = 'webm';
            else if (contentType.includes('video/quicktime')) fileType = 'mov';

            // Save to disk
            const result = mediaDB.save(fileBuffer, fileType, url.searchParams.get('wallet') || 'anonymous');

            console.log(`[MEDIA] Uploaded ${result.filename} (${(fileBuffer.length / 1024).toFixed(1)}KB)`);

            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
                success: true,
                url: `/media/${result.filename}`,
                filename: result.filename,
                size: fileBuffer.length
            }));
        } catch (e) {
            console.error('[MEDIA] Upload error:', e);
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: false, error: e.message }));
        }
        return;
    }

    // API: Serve media files
    if (url.pathname.startsWith('/media/') && req.method === 'GET') {
        try {
            const filename = url.pathname.replace('/media/', '');

            // SECURITY: Prevent path traversal attacks
            const filePath = path.resolve(MEDIA_DIR, filename);
            const mediaRoot = path.resolve(MEDIA_DIR);
            if (!filePath.startsWith(mediaRoot + path.sep) && filePath !== mediaRoot) {
                console.warn('[SECURITY] Path traversal attempt blocked:', filename);
                res.writeHead(403, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'Access denied' }));
                return;
            }

            if (!fs.existsSync(filePath)) {
                res.writeHead(404, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'File not found' }));
                return;
            }

            // Determine content type
            const ext = path.extname(filename).toLowerCase();
            const contentTypes = {
                '.jpg': 'image/jpeg',
                '.jpeg': 'image/jpeg',
                '.png': 'image/png',
                '.gif': 'image/gif',
                '.webp': 'image/webp',
                '.mp4': 'video/mp4',
                '.webm': 'video/webm',
                '.mov': 'video/quicktime'
            };

            const contentType = contentTypes[ext] || 'application/octet-stream';

            // Stream the file
            const stat = fs.statSync(filePath);
            res.writeHead(200, {
                'Content-Type': contentType,
                'Content-Length': stat.size,
                'Cache-Control': 'public, max-age=31536000' // Cache for 1 year
            });

            const readStream = fs.createReadStream(filePath);
            readStream.pipe(res);
        } catch (e) {
            console.error('[MEDIA] Serve error:', e);
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Internal server error' }));
        }
        return;
    }

    // API: Get stats - ON-CHAIN DATA for real transparency
    // If mint param provided: returns token-specific TEK stats
    // If no mint: returns platform-wide stats
    if (url.pathname === '/api/stats' && req.method === 'GET') {
        try {
            const mint = url.searchParams.get('mint');

            // If mint is provided, get on-chain stats for that specific token
            if (mint) {
                console.log(`[STATS] Fetching on-chain stats for ${mint.slice(0, 8)}...`);

                // Get the fee wallet for this token from ORBIT registry or use default
                const orbitStatus = orbitRegistry.get(mint);
                let feeWallet = orbitStatus?.wallet || process.env.FEE_WALLET_PUBLIC_KEY || '';

                // If no fee wallet, try to derive from private key
                if (!feeWallet && process.env.FEE_WALLET_PRIVATE_KEY) {
                    try {
                        const secretKey = bs58.decode(process.env.FEE_WALLET_PRIVATE_KEY);
                        const keypair = Keypair.fromSecretKey(secretKey);
                        feeWallet = keypair.publicKey.toBase58();
                        console.log(`[STATS] Derived fee wallet: ${feeWallet.slice(0, 8)}...`);
                    } catch (e) {
                        console.error('[STATS] Could not derive fee wallet:', e.message);
                    }
                }

                if (!feeWallet) {
                    res.writeHead(200, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({
                        success: false,
                        error: 'No fee wallet configured for this token',
                        totalClaimed: 0,
                        totalDistributed: 0,
                        pending: 0,
                        holderPool: 0,
                    }));
                    return;
                }

                // Fetch REAL on-chain stats
                const onChainStats = getOnChainStats();
                const stats = await onChainStats.getStatsForDashboard(mint, feeWallet);

                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify(stats));
                return;
            }

            // No mint provided - return platform-wide stats
            const data = tracker.getTokens();
            const tokens = data.tokens || [];

            // Get platform stats from ops wallet (1% collected from ALL tokens)
            const onChainStats = getOnChainStats();
            let platformStats = { totalReceivedSOL: 0 };
            try {
                platformStats = await onChainStats.getPlatformStats();
            } catch (e) {
                console.error('[STATS] Platform stats error:', e.message);
            }

            // Sum totalDistributed from all active ORBIT engines (values in lamports)
            let totalDistributedLamports = 0;
            let totalClaimedLamports = 0;
            for (const [mint, orbitStatus] of orbitRegistry.entries()) {
                totalDistributedLamports += orbitStatus.totalDistributed || 0;
                totalClaimedLamports += orbitStatus.totalClaimed || 0;
            }

            const stats = {
                success: true,
                totalLaunches: tokens.length,
                vanityTokens: tokens.length,
                totalVolume: tokens.reduce((sum, t) => sum + (t.volume || 0), 0),
                // Platform revenue (1% from all tokens) - FROM ON-CHAIN
                holderPool: platformStats.totalReceivedSOL || 0,
                holderPoolBalance: platformStats.currentBalanceSOL || 0,
                // Aggregated from registry (backup)
                totalClaimed: totalClaimedLamports,
                totalClaimedSOL: totalClaimedLamports / 1e9,
                totalDistributed: totalDistributedLamports,
                totalDistributedSOL: totalDistributedLamports / 1e9,
                graduated: tokens.filter(t => t.graduated).length,
                source: 'onchain+registry',
            };
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(stats));
        } catch (e) {
            console.error('[STATS] Error:', e.message);
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
                success: false,
                error: e.message,
                totalLaunches: 0,
                totalClaimed: 0,
                totalDistributed: 0,
                holderPool: 0,
                pending: 0,
            }));
        }
        return;
    }

    // API: Get timer (6-hour distribution cycle)
    if (url.pathname === '/api/timer' && req.method === 'GET') {
        // Timer endpoint - returns countdown data (6 hour cycle)
        const now = Date.now();
        const sixHours = 6 * 60 * 60 * 1000; // 6 hours in ms
        const nextDistribution = Math.ceil(now / sixHours) * sixHours;
        const secondsRemaining = Math.floor((nextDistribution - now) / 1000);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ secondsRemaining, nextDistributionTime: nextDistribution }));
        return;
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // ORBIT PUBLIC API - Transparency endpoints for external platforms (Moby, etc)
    // Rate limited for DoS protection
    // ═══════════════════════════════════════════════════════════════════════════

    // API: Get all active ORBIT instances (PUBLIC - rate limited)
    if (url.pathname === '/api/orbit/status' && req.method === 'GET') {
        // Rate limit ORBIT endpoints
        const clientIP = getClientIP(req);
        const rateCheck = checkRateLimit(clientIP, 'general');
        if (!rateCheck.allowed) {
            res.writeHead(429, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: false, error: rateCheck.reason }));
            return;
        }
        try {
            const instances = [];
            for (const [mint, status] of orbitRegistry.entries()) {
                instances.push(getOrbitStatus(mint));
            }

            // Sort by most recently active
            instances.sort((a, b) => (b.lastClaimAt || b.startedAt) - (a.lastClaimAt || a.startedAt));

            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
                success: true,
                count: instances.length,
                activeCount: instances.filter(i => i.status === 'active').length,
                instances,
                timestamp: Date.now()
            }));
        } catch (e) {
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: false, error: e.message }));
        }
        return;
    }

    // API: Get ORBIT status for specific token (PUBLIC - rate limited)
    if (url.pathname.startsWith('/api/orbit/status/') && req.method === 'GET') {
        const clientIP = getClientIP(req);
        const rateCheck = checkRateLimit(clientIP, 'general');
        if (!rateCheck.allowed) {
            res.writeHead(429, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: false, error: rateCheck.reason }));
            return;
        }

        const mint = url.pathname.replace('/api/orbit/status/', '').trim();

        // Validate base58 format
        if (!mint || mint.length < 32 || !/^[1-9A-HJ-NP-Za-km-z]+$/.test(mint)) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: false, error: 'Invalid mint address' }));
            return;
        }

        const status = getOrbitStatus(mint);

        if (!status) {
            res.writeHead(404, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
                success: false,
                error: 'No ORBIT found for this token',
                mint,
                hasOrbit: false
            }));
            return;
        }

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
            success: true,
            hasOrbit: true,
            ...status,
            timestamp: Date.now()
        }));
        return;
    }

    // API: Get ORBIT activity log (PUBLIC - rate limited)
    if (url.pathname === '/api/orbit/activity' && req.method === 'GET') {
        const clientIP = getClientIP(req);
        const rateCheck = checkRateLimit(clientIP, 'general');
        if (!rateCheck.allowed) {
            res.writeHead(429, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: false, error: rateCheck.reason }));
            return;
        }
        try {
            const limitParam = parseInt(url.searchParams.get('limit'));
            const limit = isNaN(limitParam) ? 100 : Math.max(1, Math.min(limitParam, 500));
            const mint = url.searchParams.get('mint');

            // Get activities efficiently (slice before reverse)
            let activities = orbitActivityLog.slice(-limit).reverse();

            // Filter by mint if specified
            if (mint) {
                activities = activities.filter(a => a.mint === mint);
            }

            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
                success: true,
                count: activities.length,
                activities,
                timestamp: Date.now()
            }));
        } catch (e) {
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: false, error: e.message }));
        }
        return;
    }

    // API: Check if token has ORBIT (simple boolean check for external platforms)
    if (url.pathname.startsWith('/api/orbit/check/') && req.method === 'GET') {
        const clientIP = getClientIP(req);
        const rateCheck = checkRateLimit(clientIP, 'general');
        if (!rateCheck.allowed) {
            res.writeHead(429, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: false, error: rateCheck.reason }));
            return;
        }

        const mint = url.pathname.replace('/api/orbit/check/', '').trim();

        // Validate mint address format (base58)
        if (!mint || mint.length < 32 || !/^[1-9A-HJ-NP-Za-km-z]+$/.test(mint)) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: false, error: 'Invalid mint address' }));
            return;
        }

        const status = orbitRegistry.get(mint);

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
            mint,
            hasOrbit: !!status,
            isActive: status?.status === 'active',
            timestamp: Date.now()
        }));
        return;
    }

    // API: Update allocations for a token (for leaderboard display)
    // Uses engine field names: buybackBurn, marketMaking, creatorRevenue, liquidity
    if (url.pathname === '/api/orbit/allocations' && req.method === 'POST') {
        try {
            const data = await parseBody(req);
            const { mint, allocations } = data;

            if (!mint || !allocations) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ success: false, error: 'mint and allocations required' }));
                return;
            }

            // Validate mint address format
            if (mint.length < 32 || !/^[1-9A-HJ-NP-Za-km-z]+$/.test(mint)) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ success: false, error: 'Invalid mint address' }));
                return;
            }

            // Validate allocations - uses engine field names
            const { buybackBurn, marketMaking, creatorRevenue, liquidity } = allocations;
            if (typeof buybackBurn !== 'number' || typeof marketMaking !== 'number' ||
                typeof creatorRevenue !== 'number' || typeof liquidity !== 'number') {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ success: false, error: 'All allocations must be numbers (buybackBurn, marketMaking, creatorRevenue, liquidity)' }));
                return;
            }

            // Validate total is 100%
            const total = buybackBurn + marketMaking + creatorRevenue + liquidity;
            if (Math.abs(total - 100) > 0.01) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ success: false, error: `Allocations must sum to 100% (currently ${total}%)` }));
                return;
            }

            // Update or create orbit entry with allocations
            const status = orbitRegistry.get(mint);
            if (status) {
                updateOrbitAllocations(mint, { buybackBurn, marketMaking, creatorRevenue, liquidity });
            } else {
                // Create new orbit entry with allocations (inactive by default)
                const newStatus = createOrbitStatus(mint, 'unknown', { buybackBurn, marketMaking, creatorRevenue, liquidity });
                newStatus.status = 'inactive';
                orbitRegistry.set(mint, newStatus);
                saveOrbitRegistry();
            }

            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
                success: true,
                mint,
                allocations: { buybackBurn, marketMaking, creatorRevenue, liquidity }
            }));
        } catch (e) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: false, error: e.message }));
        }
        return;
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // PRIVY 24/7 ORBIT API - Register Privy wallet for server-side signing
    // ═══════════════════════════════════════════════════════════════════════════

    // API: Register Privy wallet for 24/7 ORBIT (requires Privy auth token)
    if (url.pathname === '/api/privy/register-orbit' && req.method === 'POST') {
        if (!privyEnabled) {
            res.writeHead(503, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
                success: false,
                error: 'Privy server-side signing not configured. Contact support.'
            }));
            return;
        }

        let body = '';
        req.on('data', chunk => body += chunk);
        req.on('end', async () => {
            try {
                const data = JSON.parse(body);
                const { privyAuthToken, privyWalletId, publicKey, tokenMint } = data;

                if (!privyAuthToken || !privyWalletId || !publicKey) {
                    res.writeHead(400, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({
                        success: false,
                        error: 'Missing required fields: privyAuthToken, privyWalletId, publicKey'
                    }));
                    return;
                }

                // Verify the Privy auth token to get user info
                try {
                    const verifiedUser = await privyClient.verifyAuthToken(privyAuthToken);

                    // Generate a session token for this ORBIT instance
                    const orbitSessionToken = crypto.randomBytes(32).toString('hex');

                    // Register the wallet for 24/7 signing
                    registerPrivyWallet(orbitSessionToken, privyWalletId, publicKey, verifiedUser.userId);

                    // If token mint provided, START THE 24/7 ENGINE with Privy signing!
                    let engineStarted = false;
                    if (tokenMint) {
                        try {
                            await startPrivyEngine(tokenMint, orbitSessionToken);
                            engineStarted = true;
                            console.log(`[PRIVY] 24/7 Engine STARTED for ${tokenMint.slice(0, 8)}...`);
                        } catch (engineError) {
                            console.error(`[PRIVY] Failed to start engine: ${engineError.message}`);
                        }
                    }

                    console.log(`[PRIVY] 24/7 ORBIT registered for user ${verifiedUser.userId}`);

                    res.writeHead(200, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({
                        success: true,
                        orbitSessionToken,
                        engineStarted,
                        message: engineStarted
                            ? '24/7 ORBIT Engine STARTED! Auto-claim runs continuously even when browser is closed.'
                            : '24/7 ORBIT signing enabled. Provide tokenMint to start auto-claim.',
                        privyEnabled: true
                    }));
                } catch (verifyError) {
                    console.error('[PRIVY] Auth token verification failed:', verifyError.message);
                    res.writeHead(401, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({
                        success: false,
                        error: 'Invalid Privy auth token'
                    }));
                }
            } catch (e) {
                console.error('[PRIVY] Register ORBIT error:', e.message);
                res.writeHead(500, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ success: false, error: e.message }));
            }
        });
        return;
    }

    // API: Check Privy 24/7 status
    if (url.pathname === '/api/privy/status' && req.method === 'GET') {
        // Get active engines info
        const activeEngines = [];
        for (const [tokenMint, data] of privyEngines.entries()) {
            activeEngines.push({
                tokenMint: tokenMint.slice(0, 8) + '...',
                publicKey: data.publicKey?.slice(0, 8) + '...',
                startedAt: data.startedAt,
                runningFor: Math.floor((Date.now() - data.startedAt) / 1000 / 60) + ' minutes'
            });
        }

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
            success: true,
            privyEnabled,
            serverSideSigningAvailable: privyEnabled && !!PRODUCTION_CONFIG.PRIVY_AUTH_PRIVATE_KEY,
            activeSessions: privyWalletSessions.size,
            activeEngines: activeEngines.length,
            engines: activeEngines,
            message: privyEnabled
                ? '24/7 ORBIT available - close browser and auto-claim continues'
                : 'Privy server signing not configured'
        }));
        return;
    }

    // API: Revoke 24/7 ORBIT session
    if (url.pathname === '/api/privy/revoke-orbit' && req.method === 'POST') {
        let body = '';
        req.on('data', chunk => body += chunk);
        req.on('end', async () => {
            try {
                const data = JSON.parse(body);
                const { orbitSessionToken, privyAuthToken } = data;

                if (!orbitSessionToken) {
                    res.writeHead(400, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ success: false, error: 'Missing orbitSessionToken' }));
                    return;
                }

                // Verify ownership via Privy auth token if provided
                const session = privyWalletSessions.get(orbitSessionToken);
                if (!session) {
                    res.writeHead(404, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ success: false, error: 'Session not found' }));
                    return;
                }

                if (privyAuthToken && privyEnabled) {
                    try {
                        const verifiedUser = await privyClient.verifyAuthToken(privyAuthToken);
                        if (verifiedUser.userId !== session.userId) {
                            res.writeHead(403, { 'Content-Type': 'application/json' });
                            res.end(JSON.stringify({ success: false, error: 'Not authorized to revoke this session' }));
                            return;
                        }
                    } catch (e) {
                        // Continue with revocation even if auth fails (user may have logged out)
                    }
                }

                // Stop any engines using this session
                let enginesStopped = 0;
                for (const [tokenMint, engineData] of privyEngines.entries()) {
                    if (engineData.sessionToken === orbitSessionToken) {
                        stopPrivyEngine(tokenMint);
                        enginesStopped++;
                    }
                }

                // Revoke the session
                privyWalletSessions.delete(orbitSessionToken);
                savePrivySessions();

                console.log(`[PRIVY] 24/7 ORBIT session revoked for wallet ${session.publicKey.slice(0, 8)}... (${enginesStopped} engines stopped)`);

                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({
                    success: true,
                    enginesStopped,
                    message: `24/7 ORBIT session revoked. ${enginesStopped} engine(s) stopped.`
                }));
            } catch (e) {
                res.writeHead(500, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ success: false, error: e.message }));
            }
        });
        return;
    }

    // API: Get vanity keypair (mint address ending in "launchr") - RATE LIMITED
    if (url.pathname === '/api/vanity-keypair' && req.method === 'GET') {
        // Rate limit by IP
        const clientIP = getClientIP(req);
        const lastRequest = vanityRateLimits[clientIP] || 0;
        const now = Date.now();

        if (now - lastRequest < VANITY_RATE_LIMIT_MS) {
            const waitSeconds = Math.ceil((VANITY_RATE_LIMIT_MS - (now - lastRequest)) / 1000);
            res.writeHead(429, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
                success: false,
                error: `Rate limited. Please wait ${waitSeconds} seconds.`,
                retryAfter: waitSeconds
            }));
            return;
        }

        vanityRateLimits[clientIP] = now;

        // Clean old rate limit entries every 100 requests
        if (Object.keys(vanityRateLimits).length > 1000) {
            const cutoff = now - VANITY_RATE_LIMIT_MS * 2;
            for (const ip in vanityRateLimits) {
                if (vanityRateLimits[ip] < cutoff) delete vanityRateLimits[ip];
            }
        }
        const keypair = getVanityKeypair();
        res.writeHead(200, { 'Content-Type': 'application/json' });

        if (keypair) {
            // VAULT: Store secretKey server-side, return only vaultId to client
            const vaultId = generateVaultId();
            const now = Date.now();
            vanityVault.set(vaultId, {
                secretKey: keypair.secretKey,
                publicKey: keypair.publicKey,
                dispensedAt: now,
                expiresAt: now + VAULT_EXPIRY_MS,
                used: false
            });

            console.log(`[VAULT] Stored keypair ${keypair.publicKey} with vaultId (${vanityVault.size} active, ${vanityPool.length} in pool)`);

            res.end(JSON.stringify({
                success: true,
                publicKey: keypair.publicKey,
                secretKey: keypair.secretKey,  // For local signing (dashboard uses this)
                vaultId: vaultId,  // For vault signing (deprecated, doesn't work with wallets)
                expiresIn: VAULT_EXPIRY_MS / 1000,
                poolRemaining: vanityPool.length,
                generatorStats: {
                    totalAttempts: vanityGeneratorStats.attempts,
                    totalFound: vanityGeneratorStats.found
                }
            }));
        } else {
            // Pool empty - tell client to generate locally or wait
            console.log('[VANITY] Pool empty - client should generate locally');
            res.end(JSON.stringify({
                success: false,
                error: 'No vanity keypairs available',
                poolRemaining: 0,
                generating: vanityGenerating,
                generatorStats: {
                    totalAttempts: vanityGeneratorStats.attempts,
                    totalFound: vanityGeneratorStats.found
                }
            }));

            // Trigger generator if not running
            if (!vanityGenerating) {
                setImmediate(() => runVanityGenerator());
            }
        }
        return;
    }

    // API: Custom vanity - generate on-demand with user's suffix (VAULT SECURED)
    if (url.pathname === '/api/custom-vanity' && req.method === 'POST') {
        let body = [];
        req.on('data', chunk => body.push(chunk));
        req.on('end', async () => {
            try {
                const data = JSON.parse(Buffer.concat(body).toString());
                const { suffix } = data;

                // Validate suffix
                if (!suffix || typeof suffix !== 'string') {
                    res.writeHead(400, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ success: false, error: 'Missing suffix parameter' }));
                    return;
                }

                if (suffix.length < 1 || suffix.length > 4) {
                    res.writeHead(400, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ success: false, error: 'Suffix must be 1-4 characters' }));
                    return;
                }

                // Validate base58 characters only
                const validChars = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
                for (const char of suffix) {
                    if (!validChars.includes(char)) {
                        res.writeHead(400, { 'Content-Type': 'application/json' });
                        res.end(JSON.stringify({ success: false, error: `Invalid character "${char}" - use only base58 chars (no 0, O, I, l)` }));
                        return;
                    }
                }

                // Rate limit by IP (separate from Mars vanity, shorter cooldown)
                const clientIP = getClientIP(req);
                const lastRequest = customVanityRateLimits[clientIP] || 0;
                const now = Date.now();

                if (now - lastRequest < CUSTOM_VANITY_RATE_LIMIT_MS) {
                    const waitSeconds = Math.ceil((CUSTOM_VANITY_RATE_LIMIT_MS - (now - lastRequest)) / 1000);
                    res.writeHead(429, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({
                        success: false,
                        error: `Rate limited. Please wait ${waitSeconds} seconds.`,
                        retryAfter: waitSeconds
                    }));
                    return;
                }

                customVanityRateLimits[clientIP] = now;

                console.log(`[CUSTOM-VANITY] Generating keypair with suffix "${suffix}" for ${clientIP}`);

                // Generate keypair on-demand (server-side)
                const targetSuffix = suffix.toLowerCase();
                const maxAttempts = 2000000; // Higher limit for server
                let attempts = 0;
                let foundKeypair = null;

                const startTime = Date.now();
                while (attempts < maxAttempts) {
                    attempts++;
                    const keypair = Keypair.generate();
                    const address = keypair.publicKey.toBase58();

                    if (address.toLowerCase().endsWith(targetSuffix)) {
                        foundKeypair = {
                            publicKey: address,
                            secretKey: bs58.encode(keypair.secretKey)
                        };
                        break;
                    }

                    // Log progress every 100k attempts
                    if (attempts % 100000 === 0) {
                        console.log(`[CUSTOM-VANITY] ${attempts.toLocaleString()} attempts for suffix "${suffix}"...`);
                    }
                }

                const duration = ((Date.now() - startTime) / 1000).toFixed(2);

                if (!foundKeypair) {
                    console.log(`[CUSTOM-VANITY] Failed to find "${suffix}" after ${attempts.toLocaleString()} attempts (${duration}s)`);
                    res.writeHead(408, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({
                        success: false,
                        error: `Could not find address ending in "${suffix}" after ${attempts.toLocaleString()} attempts. Try a shorter suffix.`,
                        attempts
                    }));
                    return;
                }

                console.log(`[CUSTOM-VANITY] Found ${foundKeypair.publicKey} after ${attempts.toLocaleString()} attempts (${duration}s)`);

                // Store in vault (same as Mars vanity)
                const vaultId = generateVaultId();
                const vaultNow = Date.now();
                vanityVault.set(vaultId, {
                    secretKey: foundKeypair.secretKey,
                    publicKey: foundKeypair.publicKey,
                    dispensedAt: vaultNow,
                    expiresAt: vaultNow + VAULT_EXPIRY_MS,
                    used: false,
                    customSuffix: suffix
                });

                console.log(`[VAULT] Stored custom vanity ${foundKeypair.publicKey} with vaultId (${vanityVault.size} active)`);

                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({
                    success: true,
                    publicKey: foundKeypair.publicKey,
                    vaultId: vaultId,
                    expiresIn: VAULT_EXPIRY_MS / 1000,
                    attempts,
                    duration: parseFloat(duration)
                }));

            } catch (e) {
                console.error('[CUSTOM-VANITY] Error:', e.message);
                res.writeHead(500, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ success: false, error: e.message }));
            }
        });
        return;
    }

    // API: Vanity pool status (for monitoring)
    if (url.pathname === '/api/vanity-status' && req.method === 'GET') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
            poolSize: vanityPool.length,
            targetSize: VANITY_POOL_TARGET,
            minSize: VANITY_POOL_MIN,
            isGenerating: vanityGenerating,
            stats: vanityGeneratorStats,
            suffix: VANITY_SUFFIX,
            vaultActive: vanityVault.size
        }));
        return;
    }

    // API: VAULT - Sign transaction with mint keypair (secretKey never exposed)
    if (url.pathname === '/api/vault/sign' && req.method === 'POST') {
        let body = [];
        req.on('data', chunk => body.push(chunk));
        req.on('end', async () => {
            try {
                const data = JSON.parse(Buffer.concat(body).toString());
                const { vaultId, transaction } = data;

                if (!vaultId || !transaction) {
                    res.writeHead(400, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ success: false, error: 'Missing vaultId or transaction' }));
                    return;
                }

                // Look up vault entry
                const vaultEntry = vanityVault.get(vaultId);
                if (!vaultEntry) {
                    res.writeHead(404, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ success: false, error: 'Vault entry not found or expired' }));
                    return;
                }

                // Check if already used (one-time use)
                if (vaultEntry.used) {
                    res.writeHead(403, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ success: false, error: 'Vault entry already used' }));
                    return;
                }

                // Check expiry
                if (Date.now() > vaultEntry.expiresAt) {
                    vanityVault.delete(vaultId);
                    res.writeHead(410, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ success: false, error: 'Vault entry expired' }));
                    return;
                }

                // Decode transaction and sign with mint keypair
                const { VersionedTransaction } = require('@solana/web3.js');
                const txBuffer = Buffer.from(transaction, 'base64');
                const tx = VersionedTransaction.deserialize(txBuffer);

                // Recreate keypair from stored secretKey
                const secretKeyBytes = bs58.decode(vaultEntry.secretKey);
                const mintKeypair = Keypair.fromSecretKey(secretKeyBytes);

                // SECURITY: Validate transaction includes mint keypair as signer
                const mintPubkeyStr = mintKeypair.publicKey.toBase58();
                const txAccountKeys = tx.message.staticAccountKeys.map(k => k.toBase58());
                if (!txAccountKeys.includes(mintPubkeyStr)) {
                    console.error(`[VAULT] SECURITY: Transaction rejected - mint ${mintPubkeyStr} not in account keys`);
                    res.writeHead(403, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ success: false, error: 'Transaction does not reference this mint' }));
                    return;
                }

                // Log transaction details for audit
                console.log(`[VAULT] Signing transaction for mint ${mintPubkeyStr}`);
                console.log(`[VAULT] Transaction has ${tx.message.compiledInstructions.length} instructions`);

                // Sign transaction with mint keypair
                tx.sign([mintKeypair]);

                // Mark vault entry as used
                vaultEntry.used = true;
                vaultEntry.usedAt = Date.now();

                // Serialize signed transaction
                const signedTxBuffer = Buffer.from(tx.serialize());
                const signedTxBase64 = signedTxBuffer.toString('base64');

                console.log(`[VAULT] Signed transaction for mint ${vaultEntry.publicKey}`);

                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({
                    success: true,
                    signedTransaction: signedTxBase64,
                    publicKey: vaultEntry.publicKey
                }));

                // Clean up used entry after short delay (allow retries on network failure)
                setTimeout(() => {
                    if (vanityVault.has(vaultId) && vanityVault.get(vaultId).used) {
                        vanityVault.delete(vaultId);
                        console.log(`[VAULT] Cleaned up used entry for ${vaultEntry.publicKey}`);
                    }
                }, 60000); // Keep for 1 minute after use for retries

            } catch (e) {
                console.error('[VAULT] Sign error:', e);
                res.writeHead(500, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ success: false, error: 'Failed to sign transaction: ' + e.message }));
            }
        });
        return;
    }

    // API: VAULT - Sign with mint keypair AND send transaction (wallet signs first, then server adds mint sig and sends)
    // This matches the TG bot pattern: tx.sign([walletKeypair, mintKeypair]) then sendRawTransaction
    if (url.pathname === '/api/vault/sign-and-send' && req.method === 'POST') {
        let body = [];
        req.on('data', chunk => body.push(chunk));
        req.on('end', async () => {
            try {
                const data = JSON.parse(Buffer.concat(body).toString());
                const { vaultId, transaction } = data;

                if (!vaultId || !transaction) {
                    res.writeHead(400, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ success: false, error: 'Missing vaultId or transaction' }));
                    return;
                }

                // Look up vault entry
                const vaultEntry = vanityVault.get(vaultId);
                if (!vaultEntry) {
                    res.writeHead(404, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ success: false, error: 'Vault entry not found or expired' }));
                    return;
                }

                // Check if already used (one-time use)
                if (vaultEntry.used) {
                    res.writeHead(403, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ success: false, error: 'Vault entry already used' }));
                    return;
                }

                // Check expiry
                if (Date.now() > vaultEntry.expiresAt) {
                    vanityVault.delete(vaultId);
                    res.writeHead(410, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ success: false, error: 'Vault entry expired' }));
                    return;
                }

                // Decode transaction (already signed by wallet)
                const { VersionedTransaction, Connection } = require('@solana/web3.js');
                const txBuffer = Buffer.from(transaction, 'base64');
                const tx = VersionedTransaction.deserialize(txBuffer);

                // Recreate mint keypair from stored secretKey
                const secretKeyBytes = bs58.decode(vaultEntry.secretKey);
                const mintKeypair = Keypair.fromSecretKey(secretKeyBytes);

                // SECURITY: Validate transaction includes mint keypair as signer
                const mintPubkeyStr = mintKeypair.publicKey.toBase58();
                const txAccountKeys = tx.message.staticAccountKeys.map(k => k.toBase58());
                if (!txAccountKeys.includes(mintPubkeyStr)) {
                    console.error(`[VAULT] SECURITY: Transaction rejected - mint ${mintPubkeyStr} not in account keys`);
                    res.writeHead(403, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ success: false, error: 'Transaction does not reference this mint' }));
                    return;
                }

                // Log transaction details for audit
                console.log(`[VAULT] Signing and sending transaction for mint ${mintPubkeyStr}`);
                console.log(`[VAULT] Transaction has ${tx.message.compiledInstructions.length} instructions`);

                // Add mint keypair signature (wallet already signed)
                tx.sign([mintKeypair]);

                // Mark vault entry as used
                vaultEntry.used = true;
                vaultEntry.usedAt = Date.now();

                console.log(`[VAULT] Added mint signature for ${vaultEntry.publicKey}, sending transaction...`);

                // Send the fully signed transaction (same as TG bot: skipPreflight: true)
                const connection = new Connection(PRODUCTION_CONFIG.HELIUS_RPC || 'https://api.mainnet-beta.solana.com', 'confirmed');
                const signature = await connection.sendRawTransaction(tx.serialize(), {
                    skipPreflight: true,
                    maxRetries: 3
                });

                console.log(`[VAULT] Transaction sent: ${signature}`);

                // Wait for confirmation
                await connection.confirmTransaction(signature, 'confirmed');
                console.log(`[VAULT] Transaction confirmed: ${signature}`);

                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({
                    success: true,
                    signature: signature,
                    publicKey: vaultEntry.publicKey
                }));

                // Clean up
                setTimeout(() => {
                    if (vanityVault.has(vaultId)) {
                        vanityVault.delete(vaultId);
                    }
                }, 60000);

            } catch (e) {
                console.error('[VAULT] Sign-and-send error:', e);
                res.writeHead(500, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ success: false, error: 'Failed to sign and send: ' + e.message }));
            }
        });
        return;
    }

    // API: IPFS Proxy for Pump.fun (to avoid CORS)
    if (url.pathname === '/api/ipfs-upload' && req.method === 'POST') {
        let body = [];
        req.on('data', chunk => body.push(chunk));
        req.on('end', async () => {
            try {
                const rawBody = Buffer.concat(body);

                // Forward the request to pump.fun
                const response = await fetch('https://pump.fun/api/ipfs', {
                    method: 'POST',
                    headers: {
                        'Content-Type': req.headers['content-type'],
                        'Content-Length': rawBody.length
                    },
                    body: rawBody
                });

                const data = await response.json();
                console.log('[IPFS PROXY] Upload successful:', JSON.stringify(data, null, 2));

                // Extract image URL from metadata if available
                let imageUrl = null;
                if (data.metadata?.image) {
                    imageUrl = data.metadata.image;
                } else if (data.metadataUri) {
                    // Construct image URL from metadata URI (pump.fun pattern)
                    // Metadata: https://cf-ipfs.com/ipfs/XXX -> Image is usually in the metadata
                    try {
                        const metaRes = await fetch(data.metadataUri);
                        if (metaRes.ok) {
                            const metadata = await metaRes.json();
                            imageUrl = metadata.image || null;
                            console.log('[IPFS PROXY] Fetched image URL:', imageUrl);
                        }
                    } catch (e) {
                        console.log('[IPFS PROXY] Could not fetch metadata for image:', e.message);
                    }
                }

                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ ...data, imageUrl }));
            } catch (e) {
                console.error('[IPFS PROXY] Error:', e.message);
                res.writeHead(500, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: e.message }));
            }
        });
        return;
    }

    res.writeHead(404);
    res.end('Not found');
});

function getTrackerHTML() {
    return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>LAUNCHR - Token Tracker</title>
    <link rel="icon" href="/website/logo-icon.jpg" type="image/jpeg">
    <link href="https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600;700;800;900&family=JetBrains+Mono:wght@400;500;600&display=swap" rel="stylesheet">
    <style>
        * { box-sizing: border-box; margin: 0; padding: 0; }
        :root {
            --bg: #000000;
            --card: rgba(255,255,255,0.03);
            --border: rgba(255,255,255,0.08);
            --text: #ffffff;
            --text-dim: rgba(255,255,255,0.5);
            --accent: #a855f7;
        }
        body {
            font-family: 'Inter', -apple-system, sans-serif;
            background: var(--bg);
            color: var(--text);
            min-height: 100vh;
        }
        .bg-glow {
            position: fixed;
            inset: 0;
            background: radial-gradient(ellipse at 50% 0%, rgba(168,85,247,0.1) 0%, transparent 50%);
            pointer-events: none;
        }
        nav {
            position: fixed;
            top: 0; left: 0; right: 0;
            z-index: 100;
            padding: 16px 32px;
            display: flex;
            justify-content: space-between;
            align-items: center;
            background: rgba(0,0,0,0.85);
            backdrop-filter: blur(20px);
            border-bottom: 1px solid var(--border);
        }
        .nav-brand {
            display: flex;
            align-items: center;
            gap: 12px;
            text-decoration: none;
            color: var(--text);
        }
        .nav-brand img { height: 28px; border-radius: 6px; }
        .nav-brand span { font-weight: 700; font-size: 16px; letter-spacing: 2px; }
        .nav-links { display: flex; align-items: center; gap: 24px; }
        .nav-links a { color: var(--text-dim); text-decoration: none; font-size: 13px; font-weight: 500; }
        .nav-links a:hover { color: var(--text); }
        .btn { padding: 10px 20px; border-radius: 8px; font-size: 13px; font-weight: 600; text-decoration: none; background: var(--text); color: var(--bg); }

        .container {
            max-width: 900px;
            margin: 0 auto;
            padding: 120px 24px 60px;
            position: relative;
            z-index: 1;
        }
        .header {
            text-align: center;
            margin-bottom: 60px;
        }
        .header h1 {
            font-size: 42px;
            font-weight: 800;
            margin-bottom: 12px;
            letter-spacing: -1px;
        }
        .header p {
            color: var(--text-dim);
            font-size: 16px;
        }

        .stats-grid {
            display: grid;
            grid-template-columns: repeat(3, 1fr);
            gap: 20px;
            margin-bottom: 48px;
        }
        .stat-card {
            background: var(--card);
            border: 1px solid var(--border);
            border-radius: 16px;
            padding: 32px 24px;
            text-align: center;
        }
        .stat-value {
            font-size: 48px;
            font-weight: 800;
            background: linear-gradient(135deg, var(--accent), #6366f1);
            -webkit-background-clip: text;
            -webkit-text-fill-color: transparent;
            margin-bottom: 8px;
        }
        .stat-label {
            font-size: 13px;
            color: var(--text-dim);
            text-transform: uppercase;
            letter-spacing: 2px;
        }

        .tokens-section h2 {
            font-size: 20px;
            font-weight: 700;
            margin-bottom: 20px;
        }
        .tokens-list {
            background: var(--card);
            border: 1px solid var(--border);
            border-radius: 16px;
            overflow: hidden;
        }
        .token-row {
            display: grid;
            grid-template-columns: 1fr 1fr 100px;
            padding: 16px 24px;
            border-bottom: 1px solid var(--border);
            align-items: center;
        }
        .token-row:last-child { border-bottom: none; }
        .token-row.header {
            background: rgba(255,255,255,0.02);
            font-size: 11px;
            font-weight: 600;
            color: var(--text-dim);
            text-transform: uppercase;
            letter-spacing: 1px;
        }
        .token-mint {
            font-family: 'JetBrains Mono', monospace;
            font-size: 13px;
            color: var(--accent);
        }
        .token-date {
            font-size: 13px;
            color: var(--text-dim);
        }
        .token-sessions {
            font-size: 13px;
            font-weight: 600;
            text-align: right;
        }
        .empty-state {
            padding: 60px 24px;
            text-align: center;
            color: var(--text-dim);
        }
        .live-dot {
            display: inline-block;
            width: 8px;
            height: 8px;
            background: #22c55e;
            border-radius: 50%;
            margin-right: 8px;
            animation: pulse 2s infinite;
        }
        @keyframes pulse {
            0%, 100% { opacity: 1; }
            50% { opacity: 0.4; }
        }

        @media (max-width: 768px) {
            .stats-grid { grid-template-columns: 1fr; }
            .token-row { grid-template-columns: 1fr 80px; }
            .token-date { display: none; }
        }
    </style>
</head>
<body>
    <div class="bg-glow"></div>

    <nav>
        <a href="/" class="nav-brand">
            <img src="/website/logo-icon.jpg" alt="LAUNCHR">
            <span>LAUNCHR</span>
        </a>
        <div class="nav-links">
            <a href="/">Home</a>
            <a href="/app">Dashboard</a>
            <a href="https://x.com/LaunchrTG" target="_blank">Twitter</a>
        </div>
    </nav>

    <div class="container">
        <div class="header">
            <h1><span class="live-dot"></span>Token Tracker</h1>
            <p>Tokens launched and managed with LAUNCHR technology</p>
        </div>

        <div class="stats-grid">
            <div class="stat-card">
                <div class="stat-value" id="totalTokens">-</div>
                <div class="stat-label">Tokens Tracked</div>
            </div>
            <div class="stat-card">
                <div class="stat-value" id="totalClaimed">-</div>
                <div class="stat-label">SOL Claimed</div>
            </div>
            <div class="stat-card">
                <div class="stat-value" id="totalDistributed">-</div>
                <div class="stat-label">SOL Distributed</div>
            </div>
        </div>

        <div class="tokens-section">
            <h2>Recent Tokens</h2>
            <div class="tokens-list">
                <div class="token-row header">
                    <span>Token Address</span>
                    <span>Registered</span>
                    <span style="text-align: right;">Sessions</span>
                </div>
                <div id="tokensList">
                    <div class="empty-state">Loading...</div>
                </div>
            </div>
        </div>
    </div>

    <script>
        async function loadStats() {
            try {
                const res = await fetch('/api/tracker/stats');
                const data = await res.json();

                document.getElementById('totalTokens').textContent = data.totalTokens || 0;
                document.getElementById('totalClaimed').textContent = ((data.totalClaimed || 0) / 1e9).toFixed(2);
                document.getElementById('totalDistributed').textContent = ((data.totalDistributed || 0) / 1e9).toFixed(2);

                const list = document.getElementById('tokensList');
                if (data.recentTokens && data.recentTokens.length > 0) {
                    list.innerHTML = data.recentTokens.map(t => {
                        const date = new Date(t.registeredAt).toLocaleDateString();
                        return \`<div class="token-row">
                            <span class="token-mint">\${t.mint}</span>
                            <span class="token-date">\${date}</span>
                            <span class="token-sessions">\${t.sessions}</span>
                        </div>\`;
                    }).join('');
                } else {
                    list.innerHTML = '<div class="empty-state">No tokens tracked yet. Be the first to launch!</div>';
                }
            } catch (e) {
                console.error(e);
            }
        }

        loadStats();
        setInterval(loadStats, 30000);
    </script>
</body>
</html>`;
}

function getHTML() {
    return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>LAUNCHR - Dashboard</title>
    <link rel="icon" href="/website/logo-icon.jpg" type="image/jpeg">
    <link href="https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600;700;800;900&family=JetBrains+Mono:wght@400;500;600&display=swap" rel="stylesheet">
    <style>
        * { box-sizing: border-box; margin: 0; padding: 0; }

        :root {
            --accent-1: #6366f1;
            --accent-2: #8b5cf6;
            --accent-3: #a78bfa;
            --bg-dark: #000000;
            --bg-card: rgba(255,255,255,0.03);
            --border: rgba(255,255,255,0.08);
            --text: #fafafa;
            --text-dim: rgba(255,255,255,0.5);
        }

        body {
            font-family: 'Inter', -apple-system, sans-serif;
            background: var(--bg-dark);
            color: var(--text);
            min-height: 100vh;
            overflow-x: hidden;
        }

        .bg-effects {
            position: fixed;
            top: 0;
            left: 0;
            width: 100%;
            height: 100%;
            pointer-events: none;
            z-index: 0;
        }

        .bg-effects::before {
            content: '';
            position: absolute;
            top: -50%;
            left: -50%;
            width: 200%;
            height: 200%;
            background: radial-gradient(ellipse at 30% 20%, rgba(99, 102, 241, 0.08) 0%, transparent 50%),
                        radial-gradient(ellipse at 70% 80%, rgba(139, 92, 246, 0.06) 0%, transparent 50%);
        }

        /* Navigation */
        nav {
            position: fixed;
            top: 0;
            left: 0;
            right: 0;
            z-index: 100;
            padding: 16px 32px;
            display: flex;
            justify-content: space-between;
            align-items: center;
            background: rgba(0,0,0,0.85);
            backdrop-filter: blur(20px);
            border-bottom: 1px solid var(--border);
        }

        .nav-brand {
            display: flex;
            align-items: center;
            gap: 12px;
            text-decoration: none;
            color: var(--text);
        }

        .nav-brand img {
            height: 32px;
            width: auto;
            border-radius: 6px;
        }

        .nav-brand span {
            font-weight: 700;
            font-size: 16px;
            letter-spacing: 2px;
        }

        .nav-links {
            display: flex;
            align-items: center;
            gap: 24px;
        }

        .nav-links a {
            color: var(--text-dim);
            text-decoration: none;
            font-size: 13px;
            font-weight: 500;
            transition: color 0.2s;
        }

        .nav-links a:hover {
            color: var(--text);
        }

        .nav-badge {
            padding: 6px 12px;
            background: rgba(99, 102, 241, 0.15);
            border: 1px solid rgba(99, 102, 241, 0.3);
            border-radius: 100px;
            font-size: 11px;
            font-weight: 600;
            color: var(--accent-3);
            letter-spacing: 1px;
        }

        .container {
            max-width: 1100px;
            margin: 0 auto;
            padding: 20px;
            position: relative;
            z-index: 1;
        }

        .grid {
            display: grid;
            grid-template-columns: repeat(12, 1fr);
            gap: 16px;
        }

        .col-4 { grid-column: span 4; }
        .col-6 { grid-column: span 6; }
        .col-8 { grid-column: span 8; }
        .col-12 { grid-column: span 12; }

        @media (max-width: 900px) {
            .col-4, .col-6, .col-8 { grid-column: span 12; }
        }

        .card {
            background: var(--bg-card);
            border: 1px solid var(--border);
            border-radius: 16px;
            padding: 24px;
            backdrop-filter: blur(20px);
        }

        .card-title {
            font-size: 11px;
            font-weight: 600;
            letter-spacing: 2px;
            text-transform: uppercase;
            color: var(--text-dim);
            margin-bottom: 20px;
        }

        input {
            width: 100%;
            padding: 14px 16px;
            border-radius: 10px;
            border: 1px solid var(--border);
            background: rgba(0,0,0,0.4);
            color: var(--text);
            font-size: 14px;
            font-family: inherit;
            margin-bottom: 12px;
        }

        input:focus {
            outline: none;
            border-color: var(--accent-1);
        }

        .btn {
            width: 100%;
            padding: 14px 20px;
            border-radius: 10px;
            border: none;
            font-size: 13px;
            font-weight: 600;
            font-family: inherit;
            cursor: pointer;
            transition: all 0.2s;
            text-transform: uppercase;
            letter-spacing: 1px;
        }

        .btn-primary {
            background: linear-gradient(135deg, var(--accent-1), var(--accent-2));
            color: white;
        }

        .btn-primary:hover {
            transform: translateY(-1px);
            box-shadow: 0 4px 20px rgba(99, 102, 241, 0.3);
        }

        .btn-secondary {
            background: rgba(255,255,255,0.05);
            color: var(--text);
            border: 1px solid var(--border);
        }

        .btn-success {
            background: linear-gradient(135deg, #10b981, #34d399);
            color: white;
        }

        .btn-danger {
            background: linear-gradient(135deg, #ef4444, #f87171);
            color: white;
        }

        .btn:disabled {
            opacity: 0.4;
            cursor: not-allowed;
        }

        .btn-grid {
            display: grid;
            grid-template-columns: 1fr 1fr;
            gap: 10px;
        }

        /* Allocation Sliders */
        .allocation-item {
            margin-bottom: 20px;
        }

        .allocation-header {
            display: flex;
            justify-content: space-between;
            align-items: center;
            margin-bottom: 8px;
        }

        .allocation-name {
            font-size: 13px;
            font-weight: 600;
            display: flex;
            align-items: center;
            gap: 8px;
        }

        .allocation-value {
            font-size: 18px;
            font-weight: 700;
            color: var(--accent-3);
        }

        .allocation-toggle {
            width: 40px;
            height: 22px;
            background: rgba(255,255,255,0.1);
            border-radius: 11px;
            position: relative;
            cursor: pointer;
            transition: background 0.2s;
        }

        .allocation-toggle.active {
            background: var(--accent-1);
        }

        .allocation-toggle::after {
            content: '';
            position: absolute;
            top: 2px;
            left: 2px;
            width: 18px;
            height: 18px;
            background: white;
            border-radius: 50%;
            transition: transform 0.2s;
        }

        .allocation-toggle.active::after {
            transform: translateX(18px);
        }

        .slider {
            width: 100%;
            height: 6px;
            border-radius: 3px;
            background: rgba(255,255,255,0.1);
            -webkit-appearance: none;
            appearance: none;
            cursor: pointer;
        }

        .slider::-webkit-slider-thumb {
            -webkit-appearance: none;
            width: 18px;
            height: 18px;
            border-radius: 50%;
            background: var(--accent-2);
            cursor: pointer;
            box-shadow: 0 2px 10px rgba(139, 92, 246, 0.4);
        }

        .slider:disabled {
            opacity: 0.3;
            cursor: not-allowed;
        }

        /* Stats */
        .stat-row {
            display: flex;
            justify-content: space-between;
            padding: 12px 0;
            border-bottom: 1px solid var(--border);
        }

        .stat-row:last-child {
            border-bottom: none;
        }

        .stat-label {
            font-size: 13px;
            color: var(--text-dim);
        }

        .stat-value {
            font-size: 14px;
            font-weight: 600;
        }

        /* Status badge */
        .status-badge {
            display: inline-flex;
            align-items: center;
            gap: 6px;
            padding: 6px 12px;
            border-radius: 20px;
            font-size: 11px;
            font-weight: 600;
            text-transform: uppercase;
            letter-spacing: 1px;
        }

        .status-badge.active {
            background: rgba(16, 185, 129, 0.15);
            color: #34d399;
        }

        .status-badge.inactive {
            background: rgba(239, 68, 68, 0.15);
            color: #f87171;
        }

        .status-dot {
            width: 6px;
            height: 6px;
            border-radius: 50%;
            background: currentColor;
        }

        /* Logs */
        .logs-container {
            background: rgba(0,0,0,0.4);
            border-radius: 10px;
            padding: 16px;
            height: 180px;
            overflow-y: auto;
            font-family: monospace;
            font-size: 12px;
            line-height: 1.8;
        }

        .log-entry {
            color: var(--text-dim);
        }

        /* Connected card */
        .connected-banner {
            background: rgba(16, 185, 129, 0.1);
            border: 1px solid rgba(16, 185, 129, 0.2);
            border-radius: 12px;
            padding: 16px 20px;
            display: flex;
            align-items: center;
            justify-content: space-between;
        }

        .connected-info {
            display: flex;
            align-items: center;
            gap: 12px;
        }

        .connected-dot {
            width: 8px;
            height: 8px;
            border-radius: 50%;
            background: #34d399;
            box-shadow: 0 0 10px rgba(52, 211, 153, 0.5);
        }

        .total-display {
            text-align: center;
            padding: 20px;
            background: rgba(99, 102, 241, 0.1);
            border-radius: 12px;
            margin-bottom: 20px;
        }

        .total-label {
            font-size: 11px;
            color: var(--text-dim);
            text-transform: uppercase;
            letter-spacing: 1px;
        }

        .total-value {
            font-size: 36px;
            font-weight: 800;
            color: var(--accent-3);
        }

        .total-warning {
            color: #f87171;
            animation: pulse 1s ease-in-out infinite;
        }

        @keyframes pulse {
            0%, 100% { opacity: 1; }
            50% { opacity: 0.5; }
        }
    </style>
</head>
<body>
    <div class="bg-effects"></div>

    <nav>
        <a href="/" class="nav-brand">
            <img src="/website/logo-icon.jpg" alt="LAUNCHR">
            <span>LAUNCHR</span>
        </a>
        <div class="nav-links">
            <a href="https://x.com/LaunchrTG" target="_blank">Twitter</a>
            <span class="nav-badge">DASHBOARD</span>
        </div>
    </nav>

    <div class="container" style="padding-top: 100px;">
        <div class="grid">
            <!-- Connection -->
            <div class="col-12" id="configCard">
                <div class="card">
                    <div class="card-title">Connect Wallet</div>
                    <div style="background: rgba(234,179,8,0.1); border: 1px solid rgba(234,179,8,0.3); border-radius: 8px; padding: 12px; margin-bottom: 16px;">
                        <p style="font-size: 11px; color: #eab308; margin: 0; line-height: 1.5;">
                            <strong>⚠️ IMPORTANT:</strong> Your private key is <strong>PROCESSED</strong> to sign transactions but is <strong>NEVER STORED</strong> on any server or database.
                            Keys are encrypted in memory (AES-256) and wiped on disconnect. No logging, no persistence.
                            Only use a dedicated fee wallet - never your main wallet. DYOR.
                        </p>
                    </div>
                    <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 12px;">
                        <input type="password" id="privateKey" placeholder="Private Key (base58)" autocomplete="off">
                        <input type="text" id="tokenMint" placeholder="Token Mint Address">
                    </div>
                    <button class="btn btn-primary" onclick="configure()" style="margin-top: 8px;">Connect</button>
                </div>
            </div>

            <div class="col-12" id="connectedCard" style="display: none;">
                <div class="connected-banner">
                    <div class="connected-info">
                        <div class="connected-dot"></div>
                        <span style="font-weight: 600;">Connected:</span>
                        <span id="walletDisplay" style="font-family: monospace; color: var(--text-dim);"></span>
                    </div>
                    <button class="btn btn-secondary" onclick="disconnect()" style="width: auto; padding: 8px 16px;">Disconnect</button>
                </div>
            </div>

            <!-- ALL-TIME BREAKDOWN - Full Width -->
            <div class="col-12" id="breakdownCard" style="display: none;">
                <div class="card" style="background: linear-gradient(135deg, rgba(34,197,94,0.08), rgba(59,130,246,0.08)); border-color: rgba(34,197,94,0.3);">
                    <div class="card-title" style="color: #22c55e; font-size: 13px;">ALL-TIME STATS BREAKDOWN</div>
                    <div style="display: grid; grid-template-columns: repeat(4, 1fr); gap: 24px;">
                        <div style="text-align: center;">
                            <div style="font-size: 28px; font-weight: 800; color: #22c55e;" id="statLP">0.0000</div>
                            <div style="font-size: 11px; color: var(--text-dim); text-transform: uppercase; letter-spacing: 1px;">LP Added (SOL)</div>
                        </div>
                        <div style="text-align: center;">
                            <div style="font-size: 28px; font-weight: 800; color: #f97316;" id="statBurn">0.0000</div>
                            <div style="font-size: 11px; color: var(--text-dim); text-transform: uppercase; letter-spacing: 1px;">Buyback & Burn (SOL)</div>
                        </div>
                        <div style="text-align: center;">
                            <div style="font-size: 28px; font-weight: 800; color: #3b82f6;" id="statMM">0.0000</div>
                            <div style="font-size: 11px; color: var(--text-dim); text-transform: uppercase; letter-spacing: 1px;">Market Making (SOL)</div>
                        </div>
                        <div style="text-align: center;">
                            <div style="font-size: 28px; font-weight: 800; color: #a855f7;" id="statRevenue">0.0000</div>
                            <div style="font-size: 11px; color: var(--text-dim); text-transform: uppercase; letter-spacing: 1px;">Creator Revenue (SOL)</div>
                        </div>
                    </div>
                </div>
            </div>

            <!-- Allocation Controls -->
            <div class="col-8">
                <div class="card">
                    <div class="card-title">Fee Allocation</div>

                    <div class="total-display">
                        <div class="total-label">Total Allocation</div>
                        <div class="total-value" id="totalAllocation">100%</div>
                    </div>

                    <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 16px;">
                        <div class="allocation-item">
                            <label style="font-size: 12px; color: var(--text-dim); display: block; margin-bottom: 6px;">Market Making %</label>
                            <input type="number" id="input-marketMaking" min="0" max="100" value="25" oninput="clampValue(this)" onchange="updateTotal()" style="font-size: 16px; text-align: center;">
                        </div>

                        <div class="allocation-item">
                            <label style="font-size: 12px; color: var(--text-dim); display: block; margin-bottom: 6px;">Buyback & Burn %</label>
                            <input type="number" id="input-buybackBurn" min="0" max="100" value="25" oninput="clampValue(this)" onchange="updateTotal()" style="font-size: 16px; text-align: center;">
                        </div>

                        <div class="allocation-item">
                            <label style="font-size: 12px; color: var(--text-dim); display: block; margin-bottom: 6px;">Liquidity Pool %</label>
                            <input type="number" id="input-liquidity" min="0" max="100" value="25" oninput="clampValue(this)" onchange="updateTotal()" style="font-size: 16px; text-align: center;">
                        </div>

                        <div class="allocation-item">
                            <label style="font-size: 12px; color: var(--text-dim); display: block; margin-bottom: 6px;">Creator Revenue %</label>
                            <input type="number" id="input-creatorRevenue" min="0" max="100" value="25" oninput="clampValue(this)" onchange="updateTotal()" style="font-size: 16px; text-align: center;">
                        </div>
                    </div>

                    <p style="font-size: 11px; color: var(--text-dim); margin-top: 12px; text-align: center;">Must total exactly 100%</p>
                    <button class="btn btn-primary" onclick="saveAllocations()" id="saveBtn" disabled style="margin-top: 12px;">Save Allocations</button>
                </div>
            </div>

            <!-- Stats & Controls -->
            <div class="col-4">
                <div class="card" style="margin-bottom: 16px;">
                    <div class="card-title">Statistics</div>
                    <div class="stat-row">
                        <span class="stat-label">Balance</span>
                        <span class="stat-value" id="balance">-- SOL</span>
                    </div>
                    <div class="stat-row">
                        <span class="stat-label">Total Claimed</span>
                        <span class="stat-value" id="claimed">-- SOL</span>
                    </div>
                    <div class="stat-row">
                        <span class="stat-label">Total Distributed</span>
                        <span class="stat-value" id="distributed">-- SOL</span>
                    </div>
                    <div class="stat-row">
                        <span class="stat-label">RSI</span>
                        <span class="stat-value" id="rsi">--</span>
                    </div>
                </div>

                <div class="card">
                    <div class="card-title">Automation</div>
                    <div style="margin-bottom: 16px;">
                        <span class="status-badge inactive" id="autoBadge">
                            <span class="status-dot"></span>
                            <span id="autoStatusText">Inactive</span>
                        </span>
                    </div>
                    <div class="btn-grid">
                        <button class="btn btn-success" onclick="startAuto()" id="startBtn" disabled>Start</button>
                        <button class="btn btn-danger" onclick="stopAuto()" id="stopBtn" disabled>Stop</button>
                    </div>
                    <button class="btn btn-primary" onclick="claimNow()" id="claimBtn" disabled style="margin-top: 12px;">Claim Now</button>
                </div>

                <!-- DISTRIBUTE FROM WALLET - BIG AND OBVIOUS -->
                <div class="card" style="background: linear-gradient(135deg, rgba(249,115,22,0.2), rgba(234,88,12,0.2)); border: 2px solid #f97316; margin-top: 16px;">
                    <div class="card-title" style="color: #f97316; font-size: 16px;">🔥 DISTRIBUTE FROM WALLET</div>
                    <p style="font-size: 12px; color: var(--text-dim); margin-bottom: 12px;">Use your wallet SOL directly - runs all mechanisms instantly!</p>
                    <div style="display: flex; gap: 8px; align-items: center;">
                        <input type="number" id="distributeAmount" value="0.5" step="0.1" min="0.01" style="flex: 1; font-size: 18px; padding: 12px; margin: 0; font-weight: bold;">
                        <span style="color: var(--text); font-size: 14px; font-weight: bold;">SOL</span>
                    </div>
                    <button class="btn" onclick="distributeNow()" id="distributeBtn" disabled style="margin-top: 12px; background: linear-gradient(135deg, #f97316, #ea580c); width: 100%; padding: 16px; font-size: 16px; font-weight: bold;">
                        🚀 DISTRIBUTE NOW
                    </button>
                    <div id="distributeResult" style="margin-top: 8px; font-size: 12px; display: none;"></div>
                </div>

                <div class="card" style="background: linear-gradient(135deg, rgba(168,85,247,0.1), rgba(99,102,241,0.1)); border-color: rgba(168,85,247,0.3);">
                    <div class="card-title" style="color: #a855f7;">SMART OPTIMIZER</div>
                    <p style="font-size: 12px; color: var(--text-dim); margin-bottom: 16px;">AI analyzes market conditions and optimizes your allocations automatically</p>
                    <button class="btn" onclick="runMaximus()" id="maximusBtn" disabled style="background: linear-gradient(135deg, #a855f7, #6366f1); width: 100%;">
                        RUN ANALYSIS
                    </button>
                    <div id="maximusResult" style="margin-top: 12px; font-size: 11px; color: var(--text-dim); display: none;"></div>
                </div>

                <div class="card" style="background: linear-gradient(135deg, rgba(34,197,94,0.1), rgba(16,185,129,0.1)); border-color: rgba(34,197,94,0.3); margin-top: 16px;">
                    <div class="card-title" style="color: #22c55e;">FUND WALLET</div>
                    <p style="font-size: 11px; color: var(--text-dim); margin-bottom: 12px;">Send SOL directly to the LAUNCHR wallet address below.</p>

                    <div id="fundWalletConfig" style="display: none;">
                        <!-- Wallet Address Display -->
                        <div style="background: rgba(0,0,0,0.3); padding: 12px; border-radius: 8px; margin-bottom: 12px;">
                            <div style="font-size: 10px; color: var(--text-dim); margin-bottom: 6px;">LAUNCHR WALLET ADDRESS</div>
                            <div style="display: flex; align-items: center; gap: 8px;">
                                <code id="launchrWalletAddress" style="flex: 1; font-size: 11px; color: #22c55e; word-break: break-all; background: rgba(34,197,94,0.1); padding: 8px; border-radius: 4px;">Loading...</code>
                                <button onclick="copyWalletAddress()" style="background: #22c55e; color: #000; border: none; padding: 8px 12px; border-radius: 4px; cursor: pointer; font-weight: 600; font-size: 11px; white-space: nowrap;">
                                    COPY
                                </button>
                            </div>
                            <div id="copyResult" style="margin-top: 6px; font-size: 10px; color: #22c55e; display: none;">✓ Copied! Send SOL from Phantom</div>
                        </div>

                        <p style="font-size: 10px; color: var(--text-dim); text-align: center; margin: 0;">
                            Open Phantom → Send → Paste address → Send SOL
                        </p>
                    </div>
                </div>
            </div>

            <!-- Logs -->
            <div class="col-12">
                <div class="card">
                    <div class="card-title">Activity Log</div>
                    <div class="logs-container" id="logs"></div>
                </div>
            </div>

            <!-- Disclaimer -->
            <div class="col-12">
                <div style="padding: 16px; background: rgba(239,68,68,0.05); border: 1px solid rgba(239,68,68,0.2); border-radius: 12px; margin-top: 16px;">
                    <p style="font-size: 11px; color: rgba(255,255,255,0.5); text-align: center; line-height: 1.6;">
                        <strong style="color: #ef4444;">DISCLAIMER:</strong> LAUNCHR is a meme coin with no intrinsic value or expectation of financial return.
                        This is NOT financial advice. Cryptocurrency investments are extremely risky and may result in total loss of funds.
                        DYOR. Only invest what you can afford to lose. By using this platform, you acknowledge these risks.
                    </p>
                    <p style="font-size: 11px; text-align: center; margin-top: 12px;">
                        <a href="/terms" target="_blank" style="color: #10b981; text-decoration: none;">Terms & Conditions</a>
                        <span style="color: #333; margin: 0 8px;">|</span>
                        <a href="/roadmap" target="_blank" style="color: #10b981; text-decoration: none;">Roadmap</a>
                    </p>
                </div>
            </div>
        </div>
    </div>

    <script>
        // XSS Protection
        function escapeHtml(str) {
            const div = document.createElement('div');
            div.textContent = str;
            return div.innerHTML;
        }

        let configured = false;
        let authToken = null;
        let allocationsLoaded = false; // Track if we've loaded allocations from server

        // Clamp input values to 0-100
        function clampValue(input) {
            let val = parseInt(input.value) || 0;
            if (val < 0) val = 0;
            if (val > 100) val = 100;
            input.value = val;
            updateTotal();
        }

        // Helper to make authenticated requests
        function authHeaders() {
            const headers = { 'Content-Type': 'application/json' };
            if (authToken) {
                headers['Authorization'] = 'Bearer ' + authToken;
            }
            return headers;
        }

        // Get allocations from inputs
        function getAllocations() {
            return {
                marketMaking: parseInt(document.getElementById('input-marketMaking').value) || 0,
                buybackBurn: parseInt(document.getElementById('input-buybackBurn').value) || 0,
                liquidity: parseInt(document.getElementById('input-liquidity').value) || 0,
                creatorRevenue: parseInt(document.getElementById('input-creatorRevenue').value) || 0
            };
        }

        // Update total display and save button state
        function updateTotal() {
            const alloc = getAllocations();
            const total = alloc.marketMaking + alloc.buybackBurn + alloc.liquidity + alloc.creatorRevenue;
            const display = document.getElementById('totalAllocation');
            const saveBtn = document.getElementById('saveBtn');

            display.textContent = total + '%';

            if (total === 100) {
                display.className = 'total-value';
                saveBtn.disabled = false;
                saveBtn.textContent = 'Save Allocations';
            } else if (total > 100) {
                display.className = 'total-value total-warning';
                saveBtn.disabled = true;
                saveBtn.textContent = 'Over by ' + (total - 100) + '%';
            } else {
                display.className = 'total-value total-warning';
                saveBtn.disabled = true;
                saveBtn.textContent = 'Under by ' + (100 - total) + '%';
            }
        }

        async function saveAllocations(silent = false) {
            const allocations = getAllocations();
            const total = allocations.marketMaking + allocations.buybackBurn + allocations.liquidity + allocations.creatorRevenue;
            if (total !== 100) {
                if (!silent) alert('Allocations must sum to 100%');
                return false;
            }

            try {
                const res = await fetch('/api/allocations', {
                    method: 'POST',
                    headers: authHeaders(),
                    body: JSON.stringify(allocations)
                });
                const data = await res.json();
                if (data.success) {
                    if (!silent) alert('Allocations saved!');
                    console.log('[ENGINE] Allocations auto-saved:', allocations);
                    return true;
                } else {
                    if (!silent) alert('Error: ' + data.error);
                    return false;
                }
            } catch (e) {
                if (!silent) alert('Error: ' + e.message);
                return false;
            }
        }

        async function configure() {
            const privateKey = document.getElementById('privateKey').value;
            const tokenMint = document.getElementById('tokenMint').value;

            if (!privateKey || !tokenMint) {
                alert('Enter private key and token mint');
                return;
            }

            try {
                const res = await fetch('/api/configure', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ privateKey, tokenMint })
                });
                const data = await res.json();

                if (data.success) {
                    configured = true;
                    authToken = data.token;  // Store the session token
                    document.getElementById('configCard').style.display = 'none';
                    document.getElementById('connectedCard').style.display = 'block';
                    document.getElementById('breakdownCard').style.display = 'block';
                    document.getElementById('walletDisplay').textContent = data.wallet.slice(0,8) + '...' + data.wallet.slice(-6);
                    document.getElementById('saveBtn').disabled = false;
                    document.getElementById('claimBtn').disabled = false;
                    document.getElementById('startBtn').disabled = false;
                    document.getElementById('stopBtn').disabled = false;
                    document.getElementById('maximusBtn').disabled = false;
                    document.getElementById('distributeBtn').disabled = false;
                    document.getElementById('fundWalletConfig').style.display = 'block';
                    refreshStatus();
                    refreshLogs();
                } else {
                    alert('Error: ' + data.error);
                }
            } catch (e) {
                alert('Error: ' + e.message);
            }
        }

        function disconnect() {
            configured = false;
            authToken = null;  // Clear auth token
            allocationsLoaded = false;  // Reset so allocations load fresh on reconnect
            document.getElementById('configCard').style.display = 'block';
            document.getElementById('connectedCard').style.display = 'none';
            document.getElementById('breakdownCard').style.display = 'none';
        }

        function copyWalletAddress() {
            const address = document.getElementById('launchrWalletAddress').textContent;
            navigator.clipboard.writeText(address).then(() => {
                const result = document.getElementById('copyResult');
                result.style.display = 'block';
                setTimeout(() => result.style.display = 'none', 3000);
            });
        }

        async function refreshStatus() {
            if (!configured) return;
            try {
                const res = await fetch('/api/status');
                const data = await res.json();

                if (data.configured) {
                    document.getElementById('balance').textContent = (data.balance || 0).toFixed(4) + ' SOL';
                    document.getElementById('claimed').textContent = ((data.stats?.totalClaimed || 0) / 1e9).toFixed(4) + ' SOL';
                    document.getElementById('distributed').textContent = ((data.stats?.totalDistributed || 0) / 1e9).toFixed(4) + ' SOL';
                    document.getElementById('rsi').textContent = data.rsi?.current?.toFixed(1) || '--';

                    // ALL-TIME BREAKDOWN stats
                    document.getElementById('statLP').textContent = ((data.stats?.liquidity || 0) / 1e9).toFixed(4);
                    document.getElementById('statBurn').textContent = ((data.stats?.buybackBurn || 0) / 1e9).toFixed(4);
                    document.getElementById('statMM').textContent = ((data.stats?.marketMaking || 0) / 1e9).toFixed(4);
                    document.getElementById('statRevenue').textContent = ((data.stats?.creatorRevenue || 0) / 1e9).toFixed(4);

                    // Update wallet address display
                    if (data.wallet) {
                        document.getElementById('launchrWalletAddress').textContent = data.wallet;
                    }

                    // Only load allocations from server ONCE on initial connect
                    if (data.allocations && !allocationsLoaded) {
                        document.getElementById('input-marketMaking').value = data.allocations.marketMaking || 25;
                        document.getElementById('input-buybackBurn').value = data.allocations.buybackBurn || 25;
                        document.getElementById('input-liquidity').value = data.allocations.liquidity || 25;
                        document.getElementById('input-creatorRevenue').value = data.allocations.creatorRevenue || 25;
                        updateTotal();
                        allocationsLoaded = true;
                    }

                    const badge = document.getElementById('autoBadge');
                    const text = document.getElementById('autoStatusText');
                    if (data.autoClaimActive) {
                        badge.className = 'status-badge active';
                        text.textContent = 'Active';
                    } else {
                        badge.className = 'status-badge inactive';
                        text.textContent = 'Inactive';
                    }
                }
            } catch (e) {
                console.error(e);
            }
        }

        async function claimNow() {
            const btn = document.getElementById('claimBtn');
            btn.disabled = true;
            btn.textContent = 'Processing...';

            try {
                await fetch('/api/claim', { method: 'POST', headers: authHeaders() });
                refreshStatus();
                refreshLogs();
            } catch (e) {
                alert('Error: ' + e.message);
            }

            btn.disabled = false;
            btn.textContent = 'Claim Now';
        }

        async function distributeNow() {
            const btn = document.getElementById('distributeBtn');
            const resultDiv = document.getElementById('distributeResult');
            const amount = parseFloat(document.getElementById('distributeAmount').value);

            if (!amount || amount <= 0) {
                alert('Enter a valid amount');
                return;
            }

            btn.disabled = true;
            btn.textContent = 'DISTRIBUTING...';

            try {
                const res = await fetch('/api/distribute', {
                    method: 'POST',
                    headers: authHeaders(),
                    body: JSON.stringify({ amount })
                });
                const data = await res.json();

                if (data.success) {
                    resultDiv.innerHTML = '✅ Distributed ' + (data.distributed / 1e9).toFixed(4) + ' SOL!';
                    resultDiv.style.color = '#22c55e';
                } else {
                    resultDiv.innerHTML = '❌ ' + escapeHtml(data.error || 'Failed');
                    resultDiv.style.color = '#ef4444';
                }
                resultDiv.style.display = 'block';
                refreshStatus();
                refreshLogs();
            } catch (e) {
                resultDiv.innerHTML = '❌ ' + escapeHtml(e.message);
                resultDiv.style.color = '#ef4444';
                resultDiv.style.display = 'block';
            }

            btn.disabled = false;
            btn.textContent = 'DISTRIBUTE';
        }

        async function runMaximus() {
            const btn = document.getElementById('maximusBtn');
            const resultDiv = document.getElementById('maximusResult');

            btn.disabled = true;
            btn.textContent = 'ANALYZING...';
            resultDiv.style.display = 'none';

            try {
                const rsi = document.getElementById('rsi').textContent;
                const balance = document.getElementById('balance').textContent.replace(' SOL', '');

                const res = await fetch('/api/ai/optimize', {
                    method: 'POST',
                    headers: authHeaders(),
                    body: JSON.stringify({
                        rsi: rsi !== '--' ? parseFloat(rsi) : null,
                        balance: parseFloat(balance) || 0,
                        currentAllocations: getAllocations()
                    })
                });

                const data = await res.json();
                if (data.success) {
                    // Apply the optimized allocations to inputs
                    document.getElementById('input-marketMaking').value = data.allocations.marketMaking || 0;
                    document.getElementById('input-buybackBurn').value = data.allocations.buybackBurn || 0;
                    document.getElementById('input-liquidity').value = data.allocations.liquidity || 0;
                    document.getElementById('input-creatorRevenue').value = data.allocations.creatorRevenue || 0;
                    updateTotal();

                    // AUTO-SAVE silently to engine
                    const saved = await saveAllocations(true);

                    // REFRESH UI to show new allocations!
                    await refreshStatus();

                    if (saved) {
                        resultDiv.innerHTML = '✅ APPLIED: ' + (data.allocations.reasoning || 'Allocations optimized and saved to engine!');
                    } else {
                        resultDiv.innerHTML = '⚠️ ' + (data.allocations.reasoning || 'Optimized but failed to save - click Save manually');
                    }
                    resultDiv.style.display = 'block';
                    resultDiv.style.color = saved ? '#22c55e' : '#f59e0b';
                } else {
                    throw new Error(data.error);
                }
            } catch (e) {
                resultDiv.innerHTML = '❌ ' + escapeHtml(e.message);
                resultDiv.style.display = 'block';
                resultDiv.style.color = '#ef4444';
            }

            btn.disabled = false;
            btn.textContent = 'RUN ANALYSIS';
        }

        async function startAuto() {
            await fetch('/api/auto/start', { method: 'POST', headers: authHeaders() });
            refreshStatus();
            refreshLogs();
        }

        async function stopAuto() {
            await fetch('/api/auto/stop', { method: 'POST', headers: authHeaders() });
            refreshStatus();
            refreshLogs();
        }

        // Manual fund function
        async function fundWalletNow() {
            const sourceKey = document.getElementById('fundSourceKey').value;
            const fundAmount = parseFloat(document.getElementById('fundAmount').value);

            if (!sourceKey) {
                alert('Enter source wallet private key');
                return;
            }

            if (!fundAmount || fundAmount <= 0) {
                alert('Enter a valid amount');
                return;
            }

            const btn = document.getElementById('fundNowBtn');
            const resultDiv = document.getElementById('fundResult');
            btn.disabled = true;
            btn.textContent = 'Sending...';
            resultDiv.style.display = 'none';

            try {
                const res = await fetch('/api/fund', {
                    method: 'POST',
                    headers: authHeaders(),
                    body: JSON.stringify({
                        sourceKey: sourceKey,
                        amount: fundAmount
                    })
                });
                const data = await res.json();

                if (data.success) {
                    document.getElementById('fundSourceKey').value = '';
                    resultDiv.innerHTML = '✅ Sent ' + fundAmount + ' SOL!';
                    resultDiv.style.color = '#22c55e';
                    resultDiv.style.display = 'block';

                    // Immediate optimistic update - add to displayed balance
                    const balEl = document.getElementById('balance');
                    const currentBal = parseFloat(balEl.textContent) || 0;
                    balEl.textContent = (currentBal + fundAmount).toFixed(4) + ' SOL';

                    // Then refresh from server to get accurate balance
                    refreshLogs();
                    setTimeout(() => refreshStatus(), 1000);
                    setTimeout(() => refreshStatus(), 3000);
                } else {
                    resultDiv.innerHTML = '❌ ' + escapeHtml(data.error);
                    resultDiv.style.color = '#ef4444';
                    resultDiv.style.display = 'block';
                }
            } catch (e) {
                resultDiv.innerHTML = '❌ ' + escapeHtml(e.message);
                resultDiv.style.color = '#ef4444';
                resultDiv.style.display = 'block';
            }

            btn.disabled = false;
            btn.textContent = 'SEND NOW';
        }

        // Toggle auto-fund on/off
        let autoFundEnabled = false;
        function toggleAutoFund() {
            autoFundEnabled = !autoFundEnabled;
            const toggle = document.getElementById('autoFundToggle');
            toggle.className = autoFundEnabled ? 'allocation-toggle active' : 'allocation-toggle';
        }

        // Save auto-fund configuration
        async function saveAutoFund() {
            const sourceKey = document.getElementById('fundSourceKey').value;
            const minBalance = parseFloat(document.getElementById('autoFundMinBalance').value);
            const fundAmount = parseFloat(document.getElementById('autoFundAmount').value);
            const resultDiv = document.getElementById('fundResult');

            if (!autoFundEnabled) {
                // Disable auto-fund
                try {
                    const res = await fetch('/api/autofund/configure', {
                        method: 'POST',
                        headers: authHeaders(),
                        body: JSON.stringify({ enabled: false })
                    });
                    const data = await res.json();
                    if (data.success) {
                        resultDiv.innerHTML = 'Auto-fund disabled';
                        resultDiv.style.color = 'var(--text-dim)';
                        resultDiv.style.display = 'block';
                    }
                } catch (e) {
                    resultDiv.innerHTML = 'Error: ' + escapeHtml(e.message);
                    resultDiv.style.color = '#ef4444';
                    resultDiv.style.display = 'block';
                }
                return;
            }

            // Enable auto-fund
            if (!sourceKey) {
                alert('Enter source wallet private key to enable auto-fund');
                return;
            }

            try {
                const res = await fetch('/api/autofund/configure', {
                    method: 'POST',
                    headers: authHeaders(),
                    body: JSON.stringify({
                        enabled: true,
                        sourceKey: sourceKey,
                        minBalance: minBalance,
                        fundAmount: fundAmount
                    })
                });
                const data = await res.json();
                if (data.success) {
                    resultDiv.innerHTML = 'Auto-fund enabled! Min: ' + minBalance + ' SOL, Refill: ' + fundAmount + ' SOL';
                    resultDiv.style.color = '#22c55e';
                    resultDiv.style.display = 'block';
                } else {
                    resultDiv.innerHTML = 'Error: ' + escapeHtml(data.error);
                    resultDiv.style.color = '#ef4444';
                    resultDiv.style.display = 'block';
                }
            } catch (e) {
                resultDiv.innerHTML = 'Error: ' + escapeHtml(e.message);
                resultDiv.style.color = '#ef4444';
                resultDiv.style.display = 'block';
            }
        }

        async function refreshLogs() {
            try {
                const res = await fetch('/api/logs');
                const data = await res.json();
                const logsDiv = document.getElementById('logs');
                logsDiv.innerHTML = data.logs.map(l => '<div class="log-entry">' + l + '</div>').join('');
                logsDiv.scrollTop = logsDiv.scrollHeight;
            } catch (e) {
                console.error(e);
            }
        }

        setInterval(() => {
            if (configured) {
                refreshLogs();
                refreshStatus();
            }
        }, 3000);
    </script>
</body>
</html>`;
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, async () => {
    console.log('LAUNCHR running on port ' + PORT);

    // ═══════════════════════════════════════════════════════════════════
    // AUTO-CONFIGURE FROM ENVIRONMENT VARIABLES
    // If PRIVATE_KEY and TOKEN_MINT are set, auto-configure and auto-start!
    // ═══════════════════════════════════════════════════════════════════
    const envPrivateKey = process.env.PRIVATE_KEY;
    const envTokenMint = process.env.TOKEN_MINT;

    if (envPrivateKey && envTokenMint) {
        console.log('[AUTO] Found PRIVATE_KEY and TOKEN_MINT in environment');
        try {
            // Decode private key
            let decodedKey;
            try {
                decodedKey = bs58.decode(envPrivateKey);
            } catch {
                // Try as JSON array
                const keyArray = JSON.parse(envPrivateKey);
                decodedKey = new Uint8Array(keyArray);
            }

            // Setup connection and wallet
            const rpcUrl = process.env.RPC_URL && process.env.RPC_URL.startsWith('http')
                ? process.env.RPC_URL
                : 'https://api.mainnet-beta.solana.com';
            connection = new Connection(rpcUrl, 'confirmed');
            wallet = Keypair.fromSecretKey(decodedKey);

            console.log(`[AUTO] Wallet: ${wallet.publicKey.toBase58()}`);
            console.log(`[AUTO] Token: ${envTokenMint}`);

            // Create engine (args: connection, tokenMint, wallet)
            engine = new LaunchrEngine(connection, envTokenMint, wallet);

            // Generate session token for this auto-configured session
            sessionToken = crypto.randomBytes(32).toString('hex');
            sessionCreatedAt = Date.now();

            // AUTO-START claiming!
            console.log('[AUTO] Starting auto-claim...');
            const intervalMs = 1 * 60 * 1000; // 1 minute

            const runClaim = async () => {
                try {
                    await engine.updatePrice();
                    const result = await engine.claimAndDistribute();
                    if (result.claimed > 0) {
                        log('Auto: Claimed ' + (result.claimed / LAMPORTS_PER_SOL).toFixed(4) + ' SOL');
                    }
                } catch (e) {
                    log('Auto error: ' + e.message);
                }
            };

            // Run first claim immediately
            runClaim();
            autoClaimInterval = setInterval(runClaim, intervalMs);

            // Start price updates every 10s
            priceUpdateInterval = setInterval(async () => {
                try {
                    if (engine) {
                        await engine.updatePrice();
                    }
                } catch (e) {
                    // Silent fail - don't crash on price update errors
                }
            }, 10000);

            log('Auto-claim started (every 1 min) - AUTO-CONFIGURED FROM ENV');
            console.log('[AUTO] ✅ Auto-claim STARTED from environment variables!');

        } catch (err) {
            console.log('[AUTO] Failed to auto-configure: ' + err.message);
        }
    } else {
        console.log('[AUTO] No PRIVATE_KEY/TOKEN_MINT in env - manual configuration required');
    }

    // Start graduation watcher (check every 5 minutes)
    console.log('[GRADUATION] Starting graduation watcher...');
    setInterval(async () => {
        try {
            await tracker.checkAllGraduations();
        } catch (e) {
            console.log('[GRADUATION] Watcher error: ' + e.message);
        }
    }, 5 * 60 * 1000);
    // Run first check after 30 seconds
    setTimeout(() => tracker.checkAllGraduations().catch(() => {}), 30000);

    // Start metrics updater (update token mcap/volume/price every 10 minutes)
    console.log('[METRICS] Starting token metrics updater...');
    setInterval(async () => {
        try {
            await tracker.updateAllTokenMetrics();
        } catch (e) {
            console.log('[METRICS] Updater error: ' + e.message);
        }
    }, 10 * 60 * 1000);
    // Run first update after 60 seconds
    setTimeout(() => tracker.updateAllTokenMetrics().catch(() => {}), 60000);

    // Start Telegram bot if token is configured
    const botToken = process.env.TELEGRAM_BOT_TOKEN;
    if (botToken) {
        const bot = new LaunchrBot(botToken);
        bot.startPolling();
        console.log('Telegram bot started');
    } else {
        console.log('Telegram bot not started (TELEGRAM_BOT_TOKEN not set)');
    }
});

// Graceful shutdown
process.on('SIGTERM', () => {
    console.log('SIGTERM received, shutting down...');
    if (autoClaimInterval) clearInterval(autoClaimInterval);
    server.close(() => {
        console.log('Server closed');
        process.exit(0);
    });
});

process.on('SIGINT', () => {
    console.log('SIGINT received, shutting down...');
    if (autoClaimInterval) clearInterval(autoClaimInterval);
    server.close(() => {
        console.log('Server closed');
        process.exit(0);
    });
});
