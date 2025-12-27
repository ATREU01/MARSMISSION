const fs = require('fs');
const path = require('path');
const axios = require('axios');

// Use /app/data/ for Railway volume persistence, fallback to local data/ for dev
const DATA_DIR = process.env.RAILWAY_ENVIRONMENT ? '/app/data' : path.join(__dirname, 'data');
const DATA_FILE = path.join(DATA_DIR, 'tracked-tokens.json');

// Pump.fun graduation threshold
const GRADUATION_THRESHOLD_SOL = 85;

// Ensure data directory exists
function ensureDataDir() {
    if (!fs.existsSync(DATA_DIR)) {
        try {
            fs.mkdirSync(DATA_DIR, { recursive: true });
            console.log(`[TRACKER] Created data directory: ${DATA_DIR}`);
        } catch (e) {
            console.error(`[TRACKER] Failed to create data directory: ${e.message}`);
        }
    }
}

console.log(`[TRACKER] Data file: ${DATA_FILE}`);

// Load tracked tokens
function loadTokens() {
    ensureDataDir();
    try {
        if (fs.existsSync(DATA_FILE)) {
            return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
        }
    } catch (e) {
        console.error('Error loading tokens:', e.message);
    }
    return { tokens: [], stats: { totalTokens: 0, totalClaimed: 0, totalDistributed: 0 } };
}

// Save tracked tokens
function saveTokens(data) {
    ensureDataDir();
    fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));
}

// Register a new token
function registerToken(tokenMint, walletAddress, metadata = {}) {
    const data = loadTokens();

    // Check if already registered
    const existing = data.tokens.find(t => t.mint === tokenMint);
    if (existing) {
        // Update last seen and creator if not set
        existing.lastSeen = Date.now();
        existing.sessions = (existing.sessions || 0) + 1;
        if (walletAddress && !existing.creator) {
            existing.creator = walletAddress;
        }
        saveTokens(data);
        return { registered: false, updated: true, token: existing };
    }

    // New token
    const token = {
        mint: tokenMint,
        creator: walletAddress || null,  // Store full creator wallet address
        wallet: walletAddress ? walletAddress.slice(0, 8) + '...' : null,  // Display version
        registeredAt: Date.now(),
        lastSeen: Date.now(),
        sessions: 1,
        stats: {
            totalClaimed: 0,
            totalDistributed: 0
        },
        ...metadata
    };

    data.tokens.push(token);
    data.stats.totalTokens = data.tokens.length;
    saveTokens(data);

    return { registered: true, updated: false, token };
}

// Get tokens by creator wallet
function getTokensByCreator(creatorWallet) {
    const data = loadTokens();
    return data.tokens.filter(t => t.creator === creatorWallet);
}

// Update token stats
function updateTokenStats(tokenMint, claimed, distributed) {
    const data = loadTokens();
    const token = data.tokens.find(t => t.mint === tokenMint);

    if (token) {
        token.stats.totalClaimed += claimed || 0;
        token.stats.totalDistributed += distributed || 0;
        token.lastSeen = Date.now();

        // Update global stats
        data.stats.totalClaimed = data.tokens.reduce((sum, t) => sum + (t.stats?.totalClaimed || 0), 0);
        data.stats.totalDistributed = data.tokens.reduce((sum, t) => sum + (t.stats?.totalDistributed || 0), 0);

        saveTokens(data);
        return true;
    }
    return false;
}

// Get all tracked tokens
function getTokens() {
    return loadTokens();
}

// Get public stats (no sensitive data)
function getPublicStats() {
    const data = loadTokens();
    return {
        totalTokens: data.tokens.length,
        totalClaimed: data.stats.totalClaimed || 0,
        totalDistributed: data.stats.totalDistributed || 0,
        recentTokens: data.tokens
            .sort((a, b) => b.registeredAt - a.registeredAt)
            .slice(0, 10)
            .map(t => ({
                mint: t.mint.slice(0, 8) + '...' + t.mint.slice(-6),
                registeredAt: t.registeredAt,
                sessions: t.sessions
            }))
    };
}

// Check graduation status for a single token from pump.fun API
async function checkGraduationStatus(tokenMint) {
    try {
        const response = await axios.get(
            `https://frontend-api.pump.fun/coins/${tokenMint}`,
            { timeout: 10000 }
        );

        if (response.data) {
            const realSol = (response.data.virtual_sol_reserves || 0) / 1e9;
            const graduated = response.data.complete === true;
            const progress = Math.min((realSol / GRADUATION_THRESHOLD_SOL) * 100, 100);

            return {
                graduated,
                progress,
                realSol,
                mcap: response.data.usd_market_cap || 0,
                bondingCurve: response.data.bonding_curve,
                raydiumPool: response.data.raydium_pool || null,
            };
        }

        return { graduated: false, progress: 0 };
    } catch (error) {
        return { graduated: false, error: error.message };
    }
}

// Update graduation status for a token
async function updateGraduationStatus(tokenMint) {
    const data = loadTokens();
    const token = data.tokens.find(t => t.mint === tokenMint);

    if (!token) return null;

    const status = await checkGraduationStatus(tokenMint);

    if (status.graduated !== undefined) {
        const wasGraduated = token.graduated;
        token.graduated = status.graduated;
        token.progress = status.progress;
        token.mcap = status.mcap || token.mcap;
        token.raydiumPool = status.raydiumPool;

        if (status.graduated && !wasGraduated) {
            token.graduatedAt = Date.now();
            console.log(`[TRACKER] Token ${tokenMint.slice(0, 8)}... GRADUATED!`);
        }

        saveTokens(data);
    }

    return { token, status };
}

// Check graduation for all non-graduated tokens
async function checkAllGraduations() {
    const data = loadTokens();
    const nonGraduated = data.tokens.filter(t => !t.graduated);
    const results = [];

    console.log(`[TRACKER] Checking graduation for ${nonGraduated.length} tokens...`);

    for (const token of nonGraduated) {
        try {
            const result = await updateGraduationStatus(token.mint);
            if (result?.status?.graduated) {
                results.push({
                    mint: token.mint,
                    name: token.name,
                    graduatedAt: token.graduatedAt,
                });
            }
            // Rate limit - 500ms between API calls
            await new Promise(r => setTimeout(r, 500));
        } catch (e) {
            console.log(`[TRACKER] Error checking ${token.mint.slice(0, 8)}...: ${e.message}`);
        }
    }

    if (results.length > 0) {
        console.log(`[TRACKER] ${results.length} new graduations detected!`);
    }

    return results;
}

// Get graduation stats
function getGraduationStats() {
    const data = loadTokens();
    const graduated = data.tokens.filter(t => t.graduated);
    const pending = data.tokens.filter(t => !t.graduated);

    return {
        total: data.tokens.length,
        graduated: graduated.length,
        pending: pending.length,
        graduationRate: data.tokens.length > 0
            ? ((graduated.length / data.tokens.length) * 100).toFixed(1) + '%'
            : '0%',
        recentGraduations: graduated
            .sort((a, b) => (b.graduatedAt || 0) - (a.graduatedAt || 0))
            .slice(0, 5)
            .map(t => ({
                mint: t.mint,
                name: t.name,
                graduatedAt: t.graduatedAt,
            })),
    };
}

module.exports = {
    registerToken,
    updateTokenStats,
    getTokens,
    getTokensByCreator,
    getPublicStats,
    checkGraduationStatus,
    updateGraduationStatus,
    checkAllGraduations,
    getGraduationStats,
    GRADUATION_THRESHOLD_SOL,
};
