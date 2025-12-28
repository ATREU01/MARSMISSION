const fs = require('fs');
const path = require('path');
const axios = require('axios');

// Helius API for holders and transactions
// Extract API key from HELIUS_RPC URL (format: https://mainnet.helius-rpc.com/?api-key=XXXX)
const HELIUS_RPC = process.env.HELIUS_RPC || process.env.RPC_URL || '';
const HELIUS_API_KEY = HELIUS_RPC.includes('api-key=')
    ? HELIUS_RPC.split('api-key=')[1]?.split('&')[0]
    : process.env.HELIUS_API_KEY;
const HELIUS_RPC_URL = HELIUS_API_KEY
    ? `https://mainnet.helius-rpc.com/?api-key=${HELIUS_API_KEY}`
    : null;

// Use /app/data/ for Railway volume persistence, fallback to local data/ for dev
const DATA_DIR = process.env.RAILWAY_ENVIRONMENT ? '/app/data' : path.join(__dirname, 'data');
const DATA_FILE = path.join(DATA_DIR, 'tracked-tokens.json');

// Pump.fun graduation threshold
const GRADUATION_THRESHOLD_SOL = 85;

// ALICE pattern - axios instance with proper headers for Pump.fun API
const pumpApi = axios.create({
    baseURL: 'https://frontend-api.pump.fun',
    timeout: 5000,
    headers: {
        'Accept': 'application/json',
        'User-Agent': 'Mozilla/5.0'
    }
});

// Simple cache for API responses (30 second TTL)
const apiCache = new Map();
const CACHE_TTL = 30000;

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
console.log(`[TRACKER] Helius RPC: ${HELIUS_RPC_URL ? 'CONFIGURED' : 'NOT SET'}`);

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

// Check graduation status for a single token from pump.fun API (ALICE pattern)
async function checkGraduationStatus(tokenMint) {
    try {
        // Check cache first
        const cacheKey = `grad_${tokenMint}`;
        const cached = apiCache.get(cacheKey);
        if (cached && Date.now() - cached.ts < CACHE_TTL) {
            return cached.data;
        }

        const response = await pumpApi.get(`/coins/${tokenMint}`);

        if (response.data) {
            const realSol = (response.data.virtual_sol_reserves || 0) / 1e9;
            const graduated = response.data.complete === true;
            const progress = Math.min((realSol / GRADUATION_THRESHOLD_SOL) * 100, 100);

            const result = {
                graduated,
                progress,
                realSol,
                mcap: response.data.usd_market_cap || 0,
                bondingCurve: response.data.bonding_curve,
                raydiumPool: response.data.raydium_pool || null,
            };

            apiCache.set(cacheKey, { data: result, ts: Date.now() });
            return result;
        }

        return { graduated: false, progress: 0 };
    } catch (error) {
        // Graceful failure - return cached if available
        const cached = apiCache.get(`grad_${tokenMint}`);
        return cached?.data || { graduated: false, error: error.message };
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

// Update token metrics with MULTIPLE API FALLBACKS
async function updateTokenMetrics(tokenMint) {
    const data = loadTokens();
    const token = data.tokens.find(t => t.mint === tokenMint);

    if (!token) return null;

    const cacheKey = `metrics_${tokenMint}`;
    const cached = apiCache.get(cacheKey);

    if (cached && Date.now() - cached.ts < CACHE_TTL) {
        return { success: true, token, cached: true };
    }

    let updated = false;

    // TRY 1: Pump.fun API
    try {
        const response = await pumpApi.get(`/coins/${tokenMint}`);
        const d = response.data;

        if (d && d.name) {
            token.name = d.name || token.name;
            token.symbol = d.symbol || token.symbol;
            token.image = d.image_uri || token.image;
            token.mcap = d.usd_market_cap || token.mcap || 0;
            token.price = d.price || token.price || 0;
            token.volume = d.volume_24h || d.volume || token.volume || 0;
            token.realSolReserves = (d.real_sol_reserves || 0) / 1e9;
            token.virtualSolReserves = (d.virtual_sol_reserves || 0) / 1e9;
            token.virtualTokenReserves = d.virtual_token_reserves || 0;
            token.progress = Math.min((token.realSolReserves / GRADUATION_THRESHOLD_SOL) * 100, 100);
            token.graduated = d.complete === true;
            token.twitter = d.twitter || token.twitter;
            token.telegram = d.telegram || token.telegram;
            token.website = d.website || token.website;
            updated = true;
            console.log(`[TRACKER] Pump.fun: ${token.name} ($${token.symbol})`);
        }
    } catch (e) {
        // Pump.fun failed, try fallbacks
    }

    // TRY 2: DexScreener API (especially for graduated tokens)
    if (!updated || token.name === 'Unknown Token' || !token.mcap) {
        try {
            const dexRes = await axios.get(`https://api.dexscreener.com/latest/dex/tokens/${tokenMint}`, {
                timeout: 5000,
                headers: { 'Accept': 'application/json' }
            });

            const pair = dexRes.data?.pairs?.[0];
            if (pair && pair.baseToken) {
                token.name = pair.baseToken.name || token.name;
                token.symbol = pair.baseToken.symbol || token.symbol;
                token.image = pair.info?.imageUrl || token.image || `https://dd.dexscreener.com/ds-data/tokens/solana/${tokenMint}.png`;
                token.mcap = pair.fdv || pair.marketCap || token.mcap || 0;
                token.price = parseFloat(pair.priceUsd) || token.price || 0;
                token.volume = pair.volume?.h24 || token.volume || 0;
                token.liquidity = pair.liquidity?.usd || 0;
                token.priceChange24h = pair.priceChange?.h24 || 0;

                // Extract socials from DexScreener info.socials array
                if (pair.info?.socials && Array.isArray(pair.info.socials)) {
                    for (const social of pair.info.socials) {
                        if (social.type === 'twitter' && social.url) {
                            token.twitter = social.url;
                        } else if (social.type === 'telegram' && social.url) {
                            token.telegram = social.url;
                        } else if (social.type === 'website' && social.url) {
                            token.website = social.url;
                        }
                    }
                }
                // Also check info.websites array
                if (pair.info?.websites && Array.isArray(pair.info.websites)) {
                    const website = pair.info.websites[0];
                    if (website?.url) token.website = website.url;
                }

                // Only mark graduated if on Raydium/PumpSwap (not pump.fun bonding curve)
                // Check dexId to determine if actually graduated
                const dexId = pair.dexId?.toLowerCase() || '';
                if (dexId === 'raydium' || dexId === 'pumpswap' || dexId.includes('raydium')) {
                    token.graduated = true;
                }
                // DON'T set graduated=true just because it's on DexScreener
                // Pump.fun bonding curve tokens also appear on DexScreener
                updated = true;
                console.log(`[TRACKER] DexScreener: ${token.name} ($${token.symbol}) dex=${dexId}`);
            }
        } catch (e) {
            // DexScreener failed
        }
    }

    // TRY 3: Jupiter API
    if (!updated || token.name === 'Unknown Token') {
        try {
            const jupRes = await axios.get(`https://lite-api.jup.ag/tokens/v2/search?query=${tokenMint}`, {
                timeout: 5000,
                headers: { 'Accept': 'application/json' }
            });

            const jupToken = Array.isArray(jupRes.data)
                ? jupRes.data.find(t => t.address === tokenMint || t.id === tokenMint)
                : null;

            if (jupToken) {
                token.name = jupToken.name || token.name;
                token.symbol = jupToken.symbol || token.symbol;
                token.image = jupToken.logoURI || token.image;
                updated = true;
                console.log(`[TRACKER] Jupiter: ${token.name} ($${token.symbol})`);
            }
        } catch (e) {
            // Jupiter failed
        }
    }

    // TRY 4: Helius API for holders count and transactions
    if (HELIUS_RPC_URL) {
        // Get transaction signatures to estimate activity and holders
        try {
            const sigsRes = await axios.post(
                HELIUS_RPC_URL,
                {
                    jsonrpc: '2.0',
                    id: 'sigs',
                    method: 'getSignaturesForAddress',
                    params: [tokenMint, { limit: 1000 }]
                },
                { timeout: 10000, headers: { 'Content-Type': 'application/json' } }
            );

            if (sigsRes.data?.result) {
                const signatures = sigsRes.data.result;
                token.txns = signatures.length >= 1000 ? '1000+' : signatures.length;

                // Estimate holders from unique signers (rough approximation)
                const uniqueSigners = new Set();
                for (const sig of signatures.slice(0, 200)) {
                    // Each signature has a unique signer
                    if (sig.signature) uniqueSigners.add(sig.signature.slice(0, 20));
                }
                // Very rough holder estimate based on activity
                if (!token.holders || token.holders === 0) {
                    token.holders = Math.max(uniqueSigners.size, Math.floor(signatures.length / 5));
                }

                console.log(`[TRACKER] Helius: ${token.symbol} - ${token.txns} txns, ~${token.holders} holders (est)`);
            }
        } catch (e) {
            console.log(`[TRACKER] Helius sigs failed: ${e.message}`);
        }
    } else {
        console.log(`[TRACKER] Helius not configured - skipping holder/txn data`);
    }

    // Calculate price from reserves if still missing
    if (!token.price && token.virtualSolReserves && token.virtualTokenReserves) {
        const SOL_PRICE_USD = 190; // TODO: fetch real price
        const priceInSol = token.virtualSolReserves / token.virtualTokenReserves;
        token.price = priceInSol * SOL_PRICE_USD;
    }

    // Fallback image
    if (!token.image) {
        token.image = `https://dd.dexscreener.com/ds-data/tokens/solana/${tokenMint}.png`;
    }

    // Mark update time
    token.lastMetricsUpdate = Date.now();

    if (token.graduated && !token.graduatedAt) {
        token.graduatedAt = Date.now();
    }

    if (updated) {
        apiCache.set(cacheKey, { data: token, ts: Date.now() });
        saveTokens(data);
        return { success: true, token };
    }

    return { success: false };
}

// Update metrics for all tokens (runs periodically)
async function updateAllTokenMetrics() {
    const data = loadTokens();
    const tokens = data.tokens || [];

    console.log(`[TRACKER] Updating metrics for ${tokens.length} tokens...`);

    let updated = 0;
    for (const token of tokens) {
        try {
            const result = await updateTokenMetrics(token.mint);
            if (result?.success) updated++;
            // Rate limit - 500ms between API calls
            await new Promise(r => setTimeout(r, 500));
        } catch (e) {
            console.log(`[TRACKER] Error updating ${token.mint.slice(0, 8)}...: ${e.message}`);
        }
    }

    console.log(`[TRACKER] Updated metrics for ${updated}/${tokens.length} tokens`);
    return { updated, total: tokens.length };
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
    updateTokenMetrics,
    updateAllTokenMetrics,
    GRADUATION_THRESHOLD_SOL,
};
