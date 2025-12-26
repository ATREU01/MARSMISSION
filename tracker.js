const fs = require('fs');
const path = require('path');

const DATA_FILE = path.join(__dirname, 'data', 'tracked-tokens.json');

// Ensure data directory exists
function ensureDataDir() {
    const dataDir = path.dirname(DATA_FILE);
    if (!fs.existsSync(dataDir)) {
        fs.mkdirSync(dataDir, { recursive: true });
    }
}

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
        // Update last seen
        existing.lastSeen = Date.now();
        existing.sessions = (existing.sessions || 0) + 1;
        saveTokens(data);
        return { registered: false, updated: true, token: existing };
    }

    // New token
    const token = {
        mint: tokenMint,
        wallet: walletAddress ? walletAddress.slice(0, 8) + '...' : null,
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

module.exports = {
    registerToken,
    updateTokenStats,
    getTokens,
    getPublicStats
};
