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

// ═══════════════════════════════════════════════════════════════════
// AI SENTIMENT ANALYSIS
// ═══════════════════════════════════════════════════════════════════

const sentimentCache = new Map();
const SENTIMENT_CACHE_TTL = 5 * 60 * 1000; // 5 minutes

// Keyword fallback (no API needed)
const BULLISH_WORDS = ['moon', 'pump', 'gem', 'alpha', 'degen', 'ape', 'rocket', 'lambo', '100x', 'buy', 'bull', 'send', 'fire'];
const BEARISH_WORDS = ['scam', 'rug', 'dump', 'dead', 'fake', 'honeypot', 'drain', 'sell', 'bear', 'rekt'];

function analyzeKeywords(text) {
    const lower = text.toLowerCase();
    let bullish = 0, bearish = 0;

    for (const word of BULLISH_WORDS) {
        if (lower.includes(word)) bullish++;
    }
    for (const word of BEARISH_WORDS) {
        if (lower.includes(word)) bearish++;
    }

    const total = bullish + bearish;
    if (total === 0) return 50; // neutral

    const ratio = (bullish - bearish) / total;
    return Math.round(50 + (ratio * 40)); // Range: 10-90
}

// Claude API sentiment analysis with price context
async function analyzeWithClaude(tokenName, tokenSymbol, priceData = null) {
    const apiKey = process.env.CLAUDE_API_KEY;
    if (!apiKey) return null;

    try {
        // Build price context if available
        let priceContext = '';
        if (priceData) {
            const { change5m, change1h, change24h } = priceData;
            priceContext = `
PRICE ACTION:
- 5min change: ${change5m > 0 ? '+' : ''}${change5m?.toFixed(1) || 0}%
- 1hr change: ${change1h > 0 ? '+' : ''}${change1h?.toFixed(1) || 0}%
- 24hr change: ${change24h > 0 ? '+' : ''}${change24h?.toFixed(1) || 0}%

TIMING:
- If already pumped 100%+ in 1h: Max score 40 (late entry)
- If 5m negative while 1h positive: Max score 50 (distribution)`;
        }

        const response = await axios.post('https://api.anthropic.com/v1/messages', {
            model: 'claude-3-haiku-20240307',
            max_tokens: 100,
            messages: [{
                role: 'user',
                content: `Rate crypto meme token "${tokenName}" ($${tokenSymbol}) from 0-100 for trading potential.
${priceContext}
SCORING:
- 80-100: Viral meme potential + good entry timing
- 60-79: Good concept + reasonable entry
- 40-59: Average OR already pumped significantly
- 20-39: Weak concept OR chasing pump
- 0-19: Red flags or scam indicators

Reply with ONLY a number 0-100.`
            }]
        }, {
            headers: {
                'Content-Type': 'application/json',
                'x-api-key': apiKey,
                'anthropic-version': '2023-06-01'
            },
            timeout: 10000
        });

        const text = response.data?.content?.[0]?.text || '';
        const score = parseInt(text.match(/\d+/)?.[0]);

        if (score >= 0 && score <= 100) {
            console.log(`[AI] Claude sentiment for ${tokenSymbol}: ${score}`);
            return score;
        }
        return null;
    } catch (e) {
        console.log(`[AI] Claude error: ${e.message}`);
        return null;
    }
}

// Master sentiment function
async function getTokenSentiment(token) {
    const name = token.name || '';
    const symbol = token.symbol || '';
    const cacheKey = `${symbol}-${name}`.toLowerCase();

    // Check cache
    const cached = sentimentCache.get(cacheKey);
    if (cached && (Date.now() - cached.timestamp) < SENTIMENT_CACHE_TTL) {
        return cached.result;
    }

    // Get price data
    const priceData = {
        change5m: token.priceChange5m || 0,
        change1h: token.priceChange1h || 0,
        change24h: token.priceChange24h || 0
    };

    // Keyword fallback
    const keywordScore = analyzeKeywords(`${name} ${symbol}`);

    // Try Claude
    const claudeScore = await analyzeWithClaude(name, symbol, priceData);

    let finalScore, source;
    if (claudeScore !== null) {
        finalScore = claudeScore;
        source = 'claude';
    } else {
        finalScore = keywordScore;
        source = 'keywords';
    }

    const result = { score: finalScore, source, claudeScore, keywordScore };

    // Cache it
    sentimentCache.set(cacheKey, { result, timestamp: Date.now() });

    return result;
}

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

    // TRY 4: Multi-source HOLDER data (fallback chain)
    // Reset holders to re-fetch fresh data each time
    let holderSource = '';
    let freshHolders = 0;

    // 4a. Pump.fun holder_count (best for pump tokens)
    try {
        const pumpHolderRes = await pumpApi.get(`/coins/${tokenMint}`);
        const d = pumpHolderRes.data;
        freshHolders = d?.holder_count || d?.unique_holders || d?.holders || 0;
        if (freshHolders > 0) {
            holderSource = 'Pump.fun';
        }
    } catch (e) {}

    // 4b. GMGN (reliable for all tokens)
    if (freshHolders === 0) {
        try {
            const gmgnRes = await axios.get(`https://gmgn.ai/defi/quotation/v1/tokens/sol/${tokenMint}`, {
                timeout: 5000,
                headers: { 'Accept': 'application/json', 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' }
            });
            freshHolders = gmgnRes.data?.data?.token?.holder_count || gmgnRes.data?.data?.token?.holders || 0;
            if (freshHolders > 0) holderSource = 'GMGN';
        } catch (e) {}
    }

    // 4c. Birdeye API
    if (freshHolders === 0) {
        try {
            const birdRes = await axios.get(`https://public-api.birdeye.so/public/token_overview?address=${tokenMint}`, {
                timeout: 5000,
                headers: { 'Accept': 'application/json', 'User-Agent': 'Mozilla/5.0' }
            });
            freshHolders = birdRes.data?.data?.holder || 0;
            if (freshHolders > 0) holderSource = 'Birdeye';
        } catch (e) {}
    }

    // 4d. Solscan
    if (freshHolders === 0) {
        try {
            const solscanRes = await axios.get(`https://public-api.solscan.io/token/holders?tokenAddress=${tokenMint}&limit=1`, {
                timeout: 5000,
                headers: { 'Accept': 'application/json', 'User-Agent': 'Mozilla/5.0' }
            });
            freshHolders = solscanRes.data?.total || 0;
            if (freshHolders > 0) holderSource = 'Solscan';
        } catch (e) {}
    }

    // Update holder count if we got fresh data
    // Also validate it's a reasonable number (not an HTTP status code)
    if (freshHolders > 0 && freshHolders < 10000000) {
        token.holders = freshHolders;
        console.log(`[TRACKER] ${holderSource}: ${token.symbol} has ${token.holders} holders`);
    } else if (freshHolders === 0 && token.holders > 0) {
        // If all APIs failed but we have old data, log it
        console.log(`[TRACKER] No fresh holder data for ${token.symbol}, keeping ${token.holders}`);
    }

    // TRY 5: Helius for transaction count
    if (HELIUS_RPC_URL && (!token.txns || token.txns === 0)) {
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
                console.log(`[TRACKER] Helius: ${token.symbol} - ${token.txns} txns`);
            }
        } catch (e) {
            console.log(`[TRACKER] Helius txns failed: ${e.message}`);
        }
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

    // TRY 6: AI Sentiment Analysis (Claude)
    if (token.name && token.symbol && !token.aiScore) {
        try {
            const sentiment = await getTokenSentiment(token);
            if (sentiment?.score) {
                token.aiScore = sentiment.score;
                token.aiSource = sentiment.source;
                console.log(`[AI] ${token.symbol}: Score ${token.aiScore} (${token.aiSource})`);
            }
        } catch (e) {
            // AI failed silently
        }
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
    getTokenSentiment,
    getPublicStats,
    checkGraduationStatus,
    updateGraduationStatus,
    checkAllGraduations,
    getGraduationStats,
    updateTokenMetrics,
    updateAllTokenMetrics,
    GRADUATION_THRESHOLD_SOL,
};
