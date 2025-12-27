/**
 * LAUNCHR - Programmable Creator Fee Engine
 *
 * Dynamic fee routing that adapts to every stage of a token's lifecycle.
 * No hard-coded splits - fully adjustable in real time.
 */

const { Connection, Keypair, PublicKey, Transaction, VersionedTransaction, SystemProgram, LAMPORTS_PER_SOL } = require('@solana/web3.js');
const { TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID, getAssociatedTokenAddress, createBurnInstruction, NATIVE_MINT, getAccount, createSyncNativeInstruction, createAssociatedTokenAccountInstruction } = require('@solana/spl-token');
const { PumpAmmSdk, OnlinePumpAmmSdk } = require('@pump-fun/pump-swap-sdk');
const BN = require('bn.js');

// Helper to get the token program for a mint (Token-2022 vs legacy SPL Token)
async function getMintTokenProgram(connection, mintPubkey) {
    try {
        const mintInfo = await connection.getAccountInfo(mintPubkey);
        if (mintInfo) {
            // Token-2022 uses TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb
            if (mintInfo.owner.equals(TOKEN_2022_PROGRAM_ID)) {
                return TOKEN_2022_PROGRAM_ID;
            }
        }
    } catch (e) {
        // Default to Token-2022 for pump.fun tokens
    }
    // Pump.fun tokens use Token-2022
    return TOKEN_2022_PROGRAM_ID;
}
const axios = require('axios');
const bs58 = require('bs58');
const fs = require('fs');
const path = require('path');

// ═══════════════════════════════════════════════════════════════════
// PUMPSWAP CONSTANTS
// ═══════════════════════════════════════════════════════════════════
const PUMPSWAP_PROGRAM_ID = new PublicKey('pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA');
const PUMP_PROGRAM_ID = new PublicKey('6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P');
const WSOL_MINT = new PublicKey('So11111111111111111111111111111111111111112');

// Stats persistence file
const STATS_FILE = path.join(__dirname, '.launchr-stats.json');

function loadStats(tokenMint) {
    try {
        if (fs.existsSync(STATS_FILE)) {
            const data = JSON.parse(fs.readFileSync(STATS_FILE, 'utf8'));
            if (data[tokenMint]) {
                console.log(`[STATS] Loaded persisted stats for ${tokenMint.slice(0, 8)}...`);
                return data[tokenMint];
            }
        }
    } catch (e) {
        console.log(`[STATS] Could not load stats: ${e.message}`);
    }
    return null;
}

function saveStats(tokenMint, stats) {
    try {
        let data = {};
        if (fs.existsSync(STATS_FILE)) {
            data = JSON.parse(fs.readFileSync(STATS_FILE, 'utf8'));
        }
        data[tokenMint] = stats;
        fs.writeFileSync(STATS_FILE, JSON.stringify(data, null, 2));
    } catch (e) {
        console.log(`[STATS] Could not save stats: ${e.message}`);
    }
}

// ═══════════════════════════════════════════════════════════════════
// CONFIGURATION
// ═══════════════════════════════════════════════════════════════════

const CONFIG = {
    PUMP_PORTAL_API: 'https://pumpportal.fun/api',
    PUMP_FUN_API: 'https://frontend-api.pump.fun',
    JUPITER_PRICE_API: 'https://api.jup.ag/price/v2',
    DEXSCREENER_API: 'https://api.dexscreener.com/latest/dex/tokens',
    DEFAULT_RPC: 'https://api.mainnet-beta.solana.com',
    MIN_TX_FEE_RESERVE: 0.001 * LAMPORTS_PER_SOL, // 0.001 SOL minimum for distribution

    // LAUNCHR HOLDER FEE - 1% of all creator fees go to LAUNCHR holders
    LAUNCHR_HOLDER_FEE_BPS: 100, // 1% = 100 basis points
    LAUNCHR_OPS_WALLET: getLaunchrOpsWallet(),
};

// Derive LAUNCHR ops wallet address from private key or env
function getLaunchrOpsWallet() {
    // First check for explicit address
    if (process.env.LAUNCHR_OPS_WALLET) {
        return process.env.LAUNCHR_OPS_WALLET;
    }
    // Derive from FEE_WALLET_PRIVATE_KEY
    if (process.env.FEE_WALLET_PRIVATE_KEY) {
        try {
            const secretKey = bs58.decode(process.env.FEE_WALLET_PRIVATE_KEY);
            const keypair = Keypair.fromSecretKey(secretKey);
            console.log(`[CONFIG] LAUNCHR ops wallet derived: ${keypair.publicKey.toBase58()}`);
            return keypair.publicKey.toBase58();
        } catch (e) {
            console.error('[CONFIG] Failed to derive ops wallet from private key:', e.message);
        }
    }
    return '';
}

// ═══════════════════════════════════════════════════════════════════
// 10-FACTOR REAL-TIME MARKET ANALYZER
// Production-grade evaluation for optimal trade timing
// ═══════════════════════════════════════════════════════════════════

class MarketAnalyzer {
    constructor() {
        // Price history for calculations
        this.priceHistory = [];
        this.volumeHistory = [];
        this.tradeHistory = [];
        this.maxHistory = 100;

        // Current metrics (all 0-100 scale, higher = more bullish)
        this.metrics = {
            rsi: 50,              // 1. Relative Strength Index
            momentum: 50,         // 2. Price momentum (short vs long term)
            volumeTrend: 50,      // 3. Volume trend analysis
            priceVelocity: 50,    // 4. Rate of price change
            volatility: 50,       // 5. Volatility score (inverse - low vol = high score)
            buyPressure: 50,      // 6. Buy vs sell pressure
            support: 50,          // 7. Distance from support level
            resistance: 50,       // 8. Distance from resistance level
            trendStrength: 50,    // 9. Overall trend strength
            marketPhase: 50,      // 10. Market cycle phase detection
        };

        // Composite scores
        this.buyScore = 50;       // Overall buy signal (0-100)
        this.sellScore = 50;      // Overall sell signal (0-100)
        this.confidence = 0;      // Confidence level (0-100)

        // Timestamps
        this.lastUpdate = 0;
    }

    // Add new market data point
    addDataPoint(data) {
        const now = Date.now();

        // Add price
        if (data.price) {
            this.priceHistory.push({ price: data.price, time: now });
            if (this.priceHistory.length > this.maxHistory) {
                this.priceHistory.shift();
            }
        }

        // Add volume
        if (data.volume !== undefined) {
            this.volumeHistory.push({ volume: data.volume, time: now });
            if (this.volumeHistory.length > this.maxHistory) {
                this.volumeHistory.shift();
            }
        }

        // Add trade data
        if (data.isBuy !== undefined) {
            this.tradeHistory.push({ isBuy: data.isBuy, amount: data.amount || 0, time: now });
            if (this.tradeHistory.length > this.maxHistory) {
                this.tradeHistory.shift();
            }
        }

        // Recalculate all metrics
        this.calculate();
        this.lastUpdate = now;
    }

    // Calculate all 10 metrics
    calculate() {
        if (this.priceHistory.length < 2) return;

        this.calculateRSI();
        this.calculateMomentum();
        this.calculateVolumeTrend();
        this.calculatePriceVelocity();
        this.calculateVolatility();
        this.calculateBuyPressure();
        this.calculateSupportResistance();
        this.calculateTrendStrength();
        this.calculateMarketPhase();
        this.calculateCompositeScores();
    }

    // 1. RSI Calculation (14-period)
    calculateRSI() {
        const prices = this.priceHistory.slice(-15).map(p => p.price);
        if (prices.length < 2) return;

        let gains = 0, losses = 0;
        for (let i = 1; i < prices.length; i++) {
            const diff = prices[i] - prices[i - 1];
            if (diff > 0) gains += diff;
            else losses -= diff;
        }

        const avgGain = gains / (prices.length - 1);
        const avgLoss = losses / (prices.length - 1);

        if (avgLoss === 0) {
            this.metrics.rsi = 100;
        } else {
            const rs = avgGain / avgLoss;
            this.metrics.rsi = 100 - (100 / (1 + rs));
        }
    }

    // 2. Momentum (short-term vs long-term price change)
    calculateMomentum() {
        const prices = this.priceHistory.map(p => p.price);
        if (prices.length < 10) return;

        const current = prices[prices.length - 1];
        const short = prices.slice(-5).reduce((a, b) => a + b, 0) / 5;  // 5-period MA
        const long = prices.slice(-20).reduce((a, b) => a + b, 0) / Math.min(20, prices.length);  // 20-period MA

        // Momentum: how much short-term is above/below long-term
        const momentumRatio = short / long;
        // Convert to 0-100 scale (0.9 = 0, 1.0 = 50, 1.1 = 100)
        this.metrics.momentum = Math.max(0, Math.min(100, (momentumRatio - 0.9) * 500));
    }

    // 3. Volume Trend
    calculateVolumeTrend() {
        if (this.volumeHistory.length < 5) return;

        const volumes = this.volumeHistory.map(v => v.volume);
        const recent = volumes.slice(-5).reduce((a, b) => a + b, 0) / 5;
        const older = volumes.slice(-20, -5).reduce((a, b) => a + b, 0) / Math.max(1, volumes.slice(-20, -5).length);

        if (older === 0) {
            this.metrics.volumeTrend = 50;
        } else {
            // Higher recent volume = higher score
            const ratio = recent / older;
            this.metrics.volumeTrend = Math.max(0, Math.min(100, ratio * 50));
        }
    }

    // 4. Price Velocity (rate of change)
    calculatePriceVelocity() {
        const prices = this.priceHistory.map(p => p.price);
        if (prices.length < 5) return;

        const current = prices[prices.length - 1];
        const prev5 = prices[prices.length - 5] || prices[0];

        const changePercent = ((current - prev5) / prev5) * 100;
        // Convert to 0-100 scale (-10% = 0, 0% = 50, +10% = 100)
        this.metrics.priceVelocity = Math.max(0, Math.min(100, 50 + (changePercent * 5)));
    }

    // 5. Volatility (inverse - lower volatility = higher score)
    calculateVolatility() {
        const prices = this.priceHistory.slice(-20).map(p => p.price);
        if (prices.length < 5) return;

        const mean = prices.reduce((a, b) => a + b, 0) / prices.length;
        const variance = prices.reduce((sum, p) => sum + Math.pow(p - mean, 2), 0) / prices.length;
        const stdDev = Math.sqrt(variance);
        const coeffOfVar = (stdDev / mean) * 100;

        // Lower volatility = higher score (inverse)
        // 0% CV = 100 score, 20% CV = 0 score
        this.metrics.volatility = Math.max(0, Math.min(100, 100 - (coeffOfVar * 5)));
    }

    // 6. Buy Pressure (buy vs sell ratio)
    calculateBuyPressure() {
        const recentTrades = this.tradeHistory.slice(-50);
        if (recentTrades.length === 0) {
            this.metrics.buyPressure = 50;
            return;
        }

        let buyVolume = 0, sellVolume = 0;
        for (const trade of recentTrades) {
            if (trade.isBuy) buyVolume += trade.amount;
            else sellVolume += trade.amount;
        }

        const total = buyVolume + sellVolume;
        if (total === 0) {
            this.metrics.buyPressure = 50;
        } else {
            this.metrics.buyPressure = (buyVolume / total) * 100;
        }
    }

    // 7 & 8. Support and Resistance levels
    calculateSupportResistance() {
        const prices = this.priceHistory.map(p => p.price);
        if (prices.length < 10) return;

        const current = prices[prices.length - 1];
        const min = Math.min(...prices);
        const max = Math.max(...prices);
        const range = max - min;

        if (range === 0) {
            this.metrics.support = 50;
            this.metrics.resistance = 50;
            return;
        }

        // Support: how close to recent low (closer to low = lower score = more room to fall)
        // Distance from support as % of range (higher = better = more cushion)
        this.metrics.support = ((current - min) / range) * 100;

        // Resistance: how close to recent high (closer to high = lower score = less room to grow)
        // Distance from resistance as % of range (inverse - lower = closer to breaking out)
        this.metrics.resistance = 100 - ((max - current) / range) * 100;
    }

    // 9. Trend Strength (how consistent is the direction)
    calculateTrendStrength() {
        const prices = this.priceHistory.slice(-20).map(p => p.price);
        if (prices.length < 5) return;

        let upMoves = 0, downMoves = 0;
        for (let i = 1; i < prices.length; i++) {
            if (prices[i] > prices[i - 1]) upMoves++;
            else if (prices[i] < prices[i - 1]) downMoves++;
        }

        const total = upMoves + downMoves;
        if (total === 0) {
            this.metrics.trendStrength = 50;
            return;
        }

        // Trend strength: how one-sided the moves are
        const dominance = Math.max(upMoves, downMoves) / total;
        const direction = upMoves > downMoves ? 1 : -1;

        // 50% = no trend, 100% = strong uptrend, 0% = strong downtrend
        this.metrics.trendStrength = 50 + (direction * (dominance - 0.5) * 100);
    }

    // 10. Market Phase Detection (accumulation, markup, distribution, markdown)
    calculateMarketPhase() {
        const prices = this.priceHistory.map(p => p.price);
        if (prices.length < 20) return;

        const recent = prices.slice(-10);
        const older = prices.slice(-30, -10);

        if (older.length === 0) {
            this.metrics.marketPhase = 50;
            return;
        }

        const recentAvg = recent.reduce((a, b) => a + b, 0) / recent.length;
        const olderAvg = older.reduce((a, b) => a + b, 0) / older.length;
        const recentVol = this.calculateStdDev(recent);
        const olderVol = this.calculateStdDev(older);

        // Phases:
        // Accumulation (40-60): Low vol, sideways, before markup
        // Markup (60-100): Rising prices, increasing vol
        // Distribution (40-60): High vol, sideways, before markdown
        // Markdown (0-40): Falling prices

        const priceChange = (recentAvg - olderAvg) / olderAvg;
        const volChange = olderVol > 0 ? recentVol / olderVol : 1;

        if (priceChange > 0.05 && volChange > 0.8) {
            // Markup phase
            this.metrics.marketPhase = 60 + Math.min(40, priceChange * 400);
        } else if (priceChange < -0.05) {
            // Markdown phase
            this.metrics.marketPhase = 40 + Math.max(-40, priceChange * 400);
        } else {
            // Accumulation or Distribution
            this.metrics.marketPhase = 50 + (priceChange * 100);
        }

        this.metrics.marketPhase = Math.max(0, Math.min(100, this.metrics.marketPhase));
    }

    calculateStdDev(arr) {
        if (arr.length === 0) return 0;
        const mean = arr.reduce((a, b) => a + b, 0) / arr.length;
        const variance = arr.reduce((sum, val) => sum + Math.pow(val - mean, 2), 0) / arr.length;
        return Math.sqrt(variance);
    }

    // Calculate composite buy/sell scores
    calculateCompositeScores() {
        // Weights for each factor (sum to 1.0)
        const weights = {
            rsi: 0.15,           // RSI is a key indicator
            momentum: 0.12,      // Momentum matters
            volumeTrend: 0.08,   // Volume confirms moves
            priceVelocity: 0.10, // Speed of change
            volatility: 0.08,    // Stability preference
            buyPressure: 0.15,   // Order flow is crucial
            support: 0.08,       // Technical levels
            resistance: 0.04,    // Less weight on resistance
            trendStrength: 0.12, // Trend following
            marketPhase: 0.08,   // Cycle awareness
        };

        // Calculate weighted buy score
        // For buy signals: low RSI is good, so invert it
        const buyFactors = {
            rsi: 100 - this.metrics.rsi,  // Inverted: low RSI = good buy
            momentum: this.metrics.momentum,
            volumeTrend: this.metrics.volumeTrend,
            priceVelocity: this.metrics.priceVelocity,
            volatility: this.metrics.volatility,
            buyPressure: this.metrics.buyPressure,
            support: this.metrics.support,
            resistance: 100 - this.metrics.resistance,  // Inverted: far from resistance = good
            trendStrength: this.metrics.trendStrength,
            marketPhase: this.metrics.marketPhase,
        };

        this.buyScore = 0;
        for (const [key, weight] of Object.entries(weights)) {
            this.buyScore += buyFactors[key] * weight;
        }

        // Sell score is inverse
        this.sellScore = 100 - this.buyScore;

        // Confidence based on data availability and consistency
        const dataPoints = this.priceHistory.length;
        const dataConfidence = Math.min(100, dataPoints * 2);  // Max at 50 data points

        // Consistency: how aligned are the signals
        const signals = Object.values(this.metrics);
        const avgSignal = signals.reduce((a, b) => a + b, 0) / signals.length;
        const signalVariance = signals.reduce((sum, s) => sum + Math.pow(s - avgSignal, 2), 0) / signals.length;
        const signalConsistency = Math.max(0, 100 - Math.sqrt(signalVariance));

        this.confidence = (dataConfidence * 0.4 + signalConsistency * 0.6);
    }

    // Main decision function
    shouldBuy(threshold = 60) {
        return this.buyScore >= threshold && this.confidence >= 40;
    }

    shouldSell(threshold = 60) {
        return this.sellScore >= threshold && this.confidence >= 40;
    }

    shouldHold() {
        return !this.shouldBuy() && !this.shouldSell();
    }

    // Get action recommendation
    getRecommendation() {
        if (this.confidence < 30) {
            return { action: 'WAIT', reason: 'Insufficient data', confidence: this.confidence };
        }

        if (this.buyScore >= 70) {
            return { action: 'STRONG_BUY', reason: 'Multiple bullish signals', confidence: this.confidence };
        } else if (this.buyScore >= 60) {
            return { action: 'BUY', reason: 'Favorable conditions', confidence: this.confidence };
        } else if (this.sellScore >= 70) {
            return { action: 'STRONG_SELL', reason: 'Multiple bearish signals', confidence: this.confidence };
        } else if (this.sellScore >= 60) {
            return { action: 'SELL', reason: 'Unfavorable conditions', confidence: this.confidence };
        } else {
            return { action: 'HOLD', reason: 'Neutral market', confidence: this.confidence };
        }
    }

    // Get full analysis report
    getAnalysis() {
        return {
            metrics: { ...this.metrics },
            buyScore: Math.round(this.buyScore * 10) / 10,
            sellScore: Math.round(this.sellScore * 10) / 10,
            confidence: Math.round(this.confidence),
            recommendation: this.getRecommendation(),
            dataPoints: this.priceHistory.length,
            lastUpdate: this.lastUpdate,
        };
    }

    // Legacy RSI getter for backward compatibility
    get rsi() {
        return {
            value: this.metrics.rsi,
            shouldBuy: (threshold = 35) => this.metrics.rsi < threshold,
        };
    }
}

// Legacy RSI Calculator (for backward compatibility)
class RSICalculator {
    constructor(period = 14) {
        this.period = period;
        this.prices = [];
        this.currentRSI = 50;
    }

    addPrice(price) {
        this.prices.push(price);
        if (this.prices.length > this.period + 1) {
            this.prices.shift();
        }
        this.calculate();
    }

    calculate() {
        if (this.prices.length < 2) return;

        let gains = 0, losses = 0;
        const numChanges = this.prices.length - 1;

        for (let i = 1; i < this.prices.length; i++) {
            const diff = this.prices[i] - this.prices[i - 1];
            if (diff > 0) gains += diff;
            else losses -= diff;
        }

        const avgGain = gains / numChanges;
        const avgLoss = losses / numChanges;

        if (avgLoss === 0) {
            this.currentRSI = 100;
        } else {
            const rs = avgGain / avgLoss;
            this.currentRSI = 100 - (100 / (1 + rs));
        }
    }

    get value() {
        return this.currentRSI;
    }

    shouldBuy(threshold = 35) {
        return this.currentRSI < threshold;
    }
}

// ═══════════════════════════════════════════════════════════════════
// PUMP PORTAL CLIENT
// ═══════════════════════════════════════════════════════════════════

class PumpPortalClient {
    constructor(connection, wallet) {
        this.connection = connection;
        this.wallet = wallet;
        this.lastCallTime = 0;
        this.minCallInterval = 1500; // Minimum 1.5s between API calls
    }

    // Rate limiter - wait if needed before making API call
    async rateLimit() {
        const now = Date.now();
        const timeSinceLastCall = now - this.lastCallTime;
        if (timeSinceLastCall < this.minCallInterval) {
            const waitTime = this.minCallInterval - timeSinceLastCall;
            await new Promise(r => setTimeout(r, waitTime));
        }
        this.lastCallTime = Date.now();
    }

    // Helper: retry with exponential backoff
    async withRetry(fn, maxRetries = 4, baseDelay = 2000) {
        let lastError;
        for (let attempt = 0; attempt < maxRetries; attempt++) {
            try {
                return await fn();
            } catch (error) {
                lastError = error;
                // Only retry on network errors, not on business logic errors
                const isRetryable = error.message?.includes('network') ||
                                    error.message?.includes('timeout') ||
                                    error.message?.includes('ECONNREFUSED') ||
                                    error.message?.includes('ETIMEDOUT') ||
                                    error.code === 'ENOTFOUND';

                if (!isRetryable || attempt === maxRetries - 1) {
                    throw error;
                }

                // Exponential backoff with jitter to prevent thundering herd
                // Base: 2s, 4s, 8s, 16s + random jitter up to baseDelay
                const jitter = Math.random() * baseDelay;
                const delay = baseDelay * Math.pow(2, attempt) + jitter;
                await new Promise(r => setTimeout(r, delay));
            }
        }
        throw lastError;
    }

    async trade(action, mint, amount, slippage = 5) {
        try {
            // Rate limit to prevent 429 errors
            await this.rateLimit();

            // Wrap the entire trade in retry logic
            return await this.withRetry(async () => {
                // For buys: amount is in SOL (denominatedInSol = true)
                // For sells: amount is in tokens (denominatedInSol = false)
                const denominatedInSol = action === 'buy' ? 'true' : 'false';

                // Use form-urlencoded format (same as claim) with arraybuffer response
                const response = await axios.post(`${CONFIG.PUMP_PORTAL_API}/trade-local`,
                    new URLSearchParams({
                        publicKey: this.wallet.publicKey.toBase58(),
                        action,
                        mint,
                        amount: amount.toString(),
                        denominatedInSol,
                        slippage: slippage.toString(),
                        priorityFee: '0.0005',
                        pool: 'auto',
                    }).toString(),
                    {
                        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                        responseType: 'arraybuffer',
                        timeout: 30000
                    }
                );

                // Response is raw binary versioned transaction
                const tx = VersionedTransaction.deserialize(new Uint8Array(response.data));
                tx.sign([this.wallet]);

                const sig = await this.connection.sendRawTransaction(tx.serialize(), {
                    skipPreflight: true,
                    maxRetries: 3,
                });

                // Don't block on confirmation - just wait briefly
                await new Promise(r => setTimeout(r, 3000));

                return { success: true, signature: sig };
            });
        } catch (error) {
            return { success: false, error: error.message };
        }
    }

    async buy(mint, solAmount) {
        // Ensure ATA exists before buying - PumpPortal doesn't create it
        const mintPubkey = new PublicKey(mint);

        // Get correct token program (Token-2022 for pump.fun tokens)
        const tokenProgram = await getMintTokenProgram(this.connection, mintPubkey);
        const isToken2022 = tokenProgram.equals(TOKEN_2022_PROGRAM_ID);
        console.log(`[BUY] Token: ${mint.slice(0, 8)}..., Program: ${isToken2022 ? 'Token-2022' : 'SPL Token'}`);

        // Get ATA with correct token program
        const ata = await getAssociatedTokenAddress(
            mintPubkey,
            this.wallet.publicKey,
            false, // allowOwnerOffCurve
            tokenProgram // Use correct token program
        );

        console.log(`[BUY] ATA: ${ata.toBase58()}`);

        try {
            let ataInfo = await this.connection.getAccountInfo(ata);

            if (!ataInfo) {
                console.log(`[BUY] ATA doesn't exist, creating with ${isToken2022 ? 'Token-2022' : 'SPL Token'}...`);

                const createAtaIx = createAssociatedTokenAccountInstruction(
                    this.wallet.publicKey, // payer
                    ata,                   // ata
                    this.wallet.publicKey, // owner
                    mintPubkey,            // mint
                    tokenProgram           // Use correct token program!
                );

                const tx = new Transaction().add(createAtaIx);
                const sig = await this.connection.sendTransaction(tx, [this.wallet], {
                    skipPreflight: false,
                    maxRetries: 3,
                });
                console.log(`[BUY] ATA creation TX: ${sig}`);

                // Wait and verify ATA was created
                for (let i = 0; i < 5; i++) {
                    await new Promise(r => setTimeout(r, 2000));
                    ataInfo = await this.connection.getAccountInfo(ata);
                    if (ataInfo) {
                        console.log(`[BUY] ✅ ATA verified: ${ata.toBase58()}`);
                        break;
                    }
                    console.log(`[BUY] Waiting for ATA... attempt ${i + 1}/5`);
                }

                if (!ataInfo) {
                    console.log(`[BUY] ⚠️ ATA creation may have failed, proceeding anyway`);
                }
            } else {
                console.log(`[BUY] ATA exists: ${ata.toBase58()}`);
            }
        } catch (ataError) {
            console.log(`[BUY] ATA error: ${ataError.message}`);
        }

        return this.trade('buy', mint, solAmount);
    }

    async sell(mint, tokenAmount) {
        return this.trade('sell', mint, tokenAmount);
    }

    async claimCreatorFees(tokenMint) {
        try {
            // Rate limit to prevent 429 errors
            await this.rateLimit();

            console.log(`[CLAIM] Requesting fee claim for ${tokenMint.slice(0, 8)}... wallet: ${this.wallet.publicKey.toBase58().slice(0, 8)}...`);

            // Use trade-local endpoint with form-urlencoded (the correct format)
            const response = await axios.post(`${CONFIG.PUMP_PORTAL_API}/trade-local`,
                new URLSearchParams({
                    publicKey: this.wallet.publicKey.toBase58(),
                    action: 'collectCreatorFee',
                    mint: tokenMint,
                    priorityFee: '0.000005',
                }).toString(),
                {
                    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                    responseType: 'arraybuffer'
                }
            );

            console.log(`[CLAIM] API response status: ${response.status}, data length: ${response.data?.byteLength || 0} bytes`);

            if (!response.data || response.data.byteLength === 0) {
                console.log('[CLAIM] No transaction data returned');
                return { success: true, claimed: 0 };
            }

            // Response is raw binary versioned transaction data
            const tx = VersionedTransaction.deserialize(new Uint8Array(response.data));
            tx.sign([this.wallet]);

            const balanceBefore = await this.connection.getBalance(this.wallet.publicKey);

            const sig = await this.connection.sendRawTransaction(tx.serialize(), {
                skipPreflight: true,
                maxRetries: 3,
            });
            console.log(`[CLAIM] Transaction sent: ${sig}`);

            // Wait a few seconds for tx to land, then check balance
            await new Promise(r => setTimeout(r, 5000));

            // Get balance after claim
            const balanceAfter = await this.connection.getBalance(this.wallet.publicKey);
            const balanceChange = balanceAfter - balanceBefore;

            // Estimate tx fee
            const txFee = 5000; // ~0.000005 SOL
            const claimed = balanceChange + txFee;

            if (claimed > 0) {
                console.log(`[CLAIM] SUCCESS! Claimed ${(claimed / 1e9).toFixed(6)} SOL`);
            } else {
                console.log(`[CLAIM] No balance change detected (tx may still be processing)`);
            }

            return { success: true, claimed: Math.max(0, claimed), signature: sig, txFee };
        } catch (error) {
            console.log(`[CLAIM] Error: ${error.message}`);
            if (error.response) {
                console.log(`[CLAIM] API error status: ${error.response.status}, data: ${JSON.stringify(error.response.data)}`);
            }
            // Already processed = fees were just claimed
            if (error.message?.includes('already been processed')) {
                console.log('[CLAIM] Transaction already processed - fees were claimed');
                return { success: true, claimed: 0, reason: 'already_claimed' };
            }
            if (error.message?.includes('no fees') || error.response?.status === 404) {
                return { success: true, claimed: 0 };
            }
            return { success: false, error: error.message, claimed: 0 };
        }
    }
}

// ═══════════════════════════════════════════════════════════════════
// LAUNCHR ENGINE - Dynamic Fee Allocation
// ═══════════════════════════════════════════════════════════════════

class LaunchrEngine {
    constructor(connection, tokenMint, wallet) {
        this.connection = connection;
        this.tokenMint = new PublicKey(tokenMint);
        this.tokenMintStr = tokenMint;
        this.wallet = wallet;
        this.pumpPortal = new PumpPortalClient(connection, wallet);

        // PumpSwap SDK for post-bond liquidity operations
        // Base SDK for offline calculations, Online SDK for fetching pool state
        this.pumpSwapSdk = new PumpAmmSdk();
        this.pumpSwapOnlineSdk = new OnlinePumpAmmSdk(this.connection);
        this.isBonded = false; // Track if token has migrated to PumpSwap
        this.pumpSwapPool = null; // Cache pool address once bonded

        // 10-Factor Real-Time Market Analyzer
        this.analyzer = new MarketAnalyzer();

        // Legacy RSI for backward compatibility
        const self = this;
        this.rsi = {
            get value() { return self.analyzer?.metrics?.rsi || 50; },
            shouldBuy: (threshold = 35) => (self.analyzer?.metrics?.rsi || 50) < threshold,
        };

        // Dynamic allocations (all in percentages, must sum to 100)
        this.allocations = {
            marketMaking: 25,     // Market making buys/sells
            buybackBurn: 25,      // Buybacks and burns
            liquidity: 25,        // LP provision
            creatorRevenue: 25,   // Direct to creator
        };

        // Feature toggles - ALL ENABLED by default
        this.features = {
            marketMaking: true,
            buybackBurn: true,
            liquidity: true,
            creatorRevenue: true,
        };

        // Stats tracking - load from file if exists
        const savedStats = loadStats(tokenMint);
        this.stats = savedStats || {
            totalClaimed: 0,
            totalDistributed: 0,
            marketMaking: 0,
            buybackBurn: 0,
            liquidity: 0,
            creatorRevenue: 0,
            transactions: [],
        };

        this.currentPrice = 0;
        this.creatorWallet = wallet.publicKey; // Default to same wallet
    }

    // Save stats to file (call after updates)
    persistStats() {
        saveStats(this.tokenMintStr, this.stats);
    }

    // ─────────────────────────────────────────────────────────────────
    // ALLOCATION MANAGEMENT
    // ─────────────────────────────────────────────────────────────────

    setAllocations(allocations) {
        const total = Object.values(allocations).reduce((a, b) => a + b, 0);
        if (Math.abs(total - 100) > 0.01) {
            throw new Error(`Allocations must sum to 100%. Current: ${total}%`);
        }

        this.allocations = { ...allocations };
        return this.allocations;
    }

    getAllocations() {
        return { ...this.allocations };
    }

    setFeatureEnabled(feature, enabled) {
        if (!(feature in this.features)) {
            throw new Error(`Unknown feature: ${feature}`);
        }
        this.features[feature] = enabled;

        // If disabling a feature, redistribute its allocation
        if (!enabled && this.allocations[feature] > 0) {
            this.redistributeAllocation(feature);
        }
    }

    redistributeAllocation(disabledFeature) {
        const amountToRedistribute = this.allocations[disabledFeature];
        this.allocations[disabledFeature] = 0;

        const enabledFeatures = Object.keys(this.features).filter(
            f => this.features[f] && f !== disabledFeature
        );

        if (enabledFeatures.length > 0) {
            // FIX: Use integer math to prevent floating point drift
            const perFeature = Math.floor(amountToRedistribute / enabledFeatures.length);
            const remainder = amountToRedistribute % enabledFeatures.length;

            enabledFeatures.forEach((f, i) => {
                // Distribute remainder to first few features
                this.allocations[f] += perFeature + (i < remainder ? 1 : 0);
            });
        }

        // Safety check: ensure total is exactly 100
        const total = Object.values(this.allocations).reduce((a, b) => a + b, 0);
        if (total !== 100 && enabledFeatures.length > 0) {
            this.allocations[enabledFeatures[0]] += (100 - total);
        }
    }

    setCreatorWallet(walletAddress) {
        this.creatorWallet = new PublicKey(walletAddress);
    }

    // ─────────────────────────────────────────────────────────────────
    // PUMPSWAP BOND DETECTION
    // ─────────────────────────────────────────────────────────────────

    /**
     * Derive the canonical PumpSwap pool address for this token
     * Canonical pools (from bonding) use index=0 and creator=pool-authority PDA
     */
    derivePumpSwapPoolAddress() {
        // Derive pool authority from Pump program: ["pool-authority", base_mint]
        const [poolAuthority] = PublicKey.findProgramAddressSync(
            [Buffer.from('pool-authority'), this.tokenMint.toBuffer()],
            PUMP_PROGRAM_ID
        );

        // Derive pool PDA from PumpSwap: ["pool", index(0), creator, base_mint, quote_mint]
        const indexBuffer = Buffer.alloc(2);
        indexBuffer.writeUInt16LE(0); // Canonical index = 0

        const [poolAddress] = PublicKey.findProgramAddressSync(
            [
                Buffer.from('pool'),
                indexBuffer,
                poolAuthority.toBuffer(),
                this.tokenMint.toBuffer(),
                WSOL_MINT.toBuffer(),
            ],
            PUMPSWAP_PROGRAM_ID
        );

        return poolAddress;
    }

    /**
     * Check if token has bonded (migrated to PumpSwap)
     * Returns true if PumpSwap pool exists, false if still on bonding curve
     */
    async checkIfBonded() {
        try {
            const poolAddress = this.derivePumpSwapPoolAddress();
            const accountInfo = await this.connection.getAccountInfo(poolAddress);

            if (accountInfo && accountInfo.data.length > 0) {
                // Pool exists - token has bonded!
                this.isBonded = true;
                this.pumpSwapPool = poolAddress;
                console.log(`[BOND] ✅ Token BONDED! PumpSwap pool: ${poolAddress.toBase58()}`);
                return true;
            }

            this.isBonded = false;
            this.pumpSwapPool = null;
            return false;
        } catch (error) {
            console.log(`[BOND] Check failed: ${error.message}`);
            return false;
        }
    }

    /**
     * Get PumpSwap pool state for liquidity operations
     */
    async getPumpSwapPoolState() {
        if (!this.isBonded || !this.pumpSwapPool) {
            await this.checkIfBonded();
        }

        if (!this.isBonded) {
            return null;
        }

        try {
            const poolState = await this.pumpSwapOnlineSdk.liquiditySolanaState(
                this.pumpSwapPool,
                this.wallet.publicKey
            );
            return poolState;
        } catch (error) {
            console.log(`[PUMPSWAP] Failed to get pool state: ${error.message}`);
            return null;
        }
    }

    // ─────────────────────────────────────────────────────────────────
    // PRICE & MARKET DATA
    // ─────────────────────────────────────────────────────────────────

    async updatePrice() {
        // ═══════════════════════════════════════════════════════════════════
        // REAL DEX DATA - DexScreener API (works for bonded tokens on PumpSwap/Raydium)
        // ═══════════════════════════════════════════════════════════════════
        try {
            const dexResponse = await axios.get(
                `${CONFIG.DEXSCREENER_API}/${this.tokenMintStr}`,
                { timeout: 5000 }
            );

            if (dexResponse.data?.pairs?.length > 0) {
                // Get the main trading pair (highest liquidity)
                const pairs = dexResponse.data.pairs;
                const mainPair = pairs.sort((a, b) => (b.liquidity?.usd || 0) - (a.liquidity?.usd || 0))[0];

                if (mainPair) {
                    this.currentPrice = parseFloat(mainPair.priceUsd) || 0;
                    const priceNative = parseFloat(mainPair.priceNative) || 0;

                    // DexScreener gives us REAL price changes for RSI!
                    const priceChange = {
                        m5: parseFloat(mainPair.priceChange?.m5) || 0,
                        h1: parseFloat(mainPair.priceChange?.h1) || 0,
                        h6: parseFloat(mainPair.priceChange?.h6) || 0,
                        h24: parseFloat(mainPair.priceChange?.h24) || 0,
                    };

                    const volume = {
                        h1: parseFloat(mainPair.volume?.h1) || 0,
                        h6: parseFloat(mainPair.volume?.h6) || 0,
                        h24: parseFloat(mainPair.volume?.h24) || 0,
                    };

                    const txns = mainPair.txns || {};
                    const buys = (txns.h1?.buys || 0) + (txns.h6?.buys || 0);
                    const sells = (txns.h1?.sells || 0) + (txns.h6?.sells || 0);
                    const buyPressure = buys + sells > 0 ? buys / (buys + sells) * 100 : 50;

                    console.log(`[DEX] $${this.currentPrice.toFixed(8)} | 1h: ${priceChange.h1 >= 0 ? '+' : ''}${priceChange.h1.toFixed(1)}% | Vol: $${(volume.h1 / 1000).toFixed(1)}K | Buy%: ${buyPressure.toFixed(0)}%`);

                    // Calculate RSI-like value from real price changes
                    // If price went up in most timeframes = high RSI (overbought)
                    // If price went down = low RSI (oversold)
                    const avgChange = (priceChange.m5 * 0.4 + priceChange.h1 * 0.35 + priceChange.h6 * 0.25);
                    // Map price change to RSI: -20% = RSI 20, 0% = RSI 50, +20% = RSI 80
                    const calculatedRSI = Math.max(0, Math.min(100, 50 + (avgChange * 1.5)));

                    // Directly update RSI from real market data
                    this.analyzer.metrics.rsi = calculatedRSI;

                    this.analyzer.addDataPoint({
                        price: this.currentPrice,
                        volume: volume.h24,
                        marketCap: parseFloat(mainPair.marketCap) || 0,
                        priceChange: priceChange.h1,
                        buyPressure: buyPressure,
                    });

                    return; // Success - got real DEX data
                }
            }
        } catch (error) {
            // DexScreener failed - try pump.fun
        }

        // ═══════════════════════════════════════════════════════════════════
        // FALLBACK - Pump.fun API (for pre-bond tokens)
        // ═══════════════════════════════════════════════════════════════════
        try {
            const response = await axios.get(
                `${CONFIG.PUMP_FUN_API}/coins/${this.tokenMintStr}`,
                { timeout: 5000 }
            );

            const data = response.data;
            if (data) {
                if (data.virtual_sol_reserves && data.virtual_token_reserves) {
                    const solReserves = data.virtual_sol_reserves / 1e9;
                    const tokenReserves = data.virtual_token_reserves / 1e6;
                    this.currentPrice = solReserves / tokenReserves;

                    console.log(`[PUMP] $${(this.currentPrice * (data.sol_price_usd || 180)).toFixed(8)} (bonding curve)`);

                    this.analyzer.addDataPoint({
                        price: this.currentPrice,
                        volume: data.volume_24h || 0,
                        marketCap: data.usd_market_cap || 0,
                    });
                    return;
                }
            }
        } catch (error) {
            // Silent fail
        }

        // ═══════════════════════════════════════════════════════════════════
        // LAST RESORT - Jupiter Price API
        // ═══════════════════════════════════════════════════════════════════
        try {
            const jupResponse = await axios.get(
                `${CONFIG.JUPITER_PRICE_API}?ids=${this.tokenMintStr}`,
                { timeout: 5000 }
            );

            if (jupResponse.data?.data?.[this.tokenMintStr]?.price) {
                this.currentPrice = parseFloat(jupResponse.data.data[this.tokenMintStr].price);
                console.log(`[JUP] $${this.currentPrice.toFixed(8)}`);

                this.analyzer.addDataPoint({
                    price: this.currentPrice,
                });
            }
        } catch (e) {
            // Silent fail
        }
    }

    // Get full market analysis
    getMarketAnalysis() {
        return this.analyzer.getAnalysis();
    }

    // ─────────────────────────────────────────────────────────────────
    // FEE CLAIMING
    // ─────────────────────────────────────────────────────────────────

    async claimFees() {
        const result = await this.pumpPortal.claimCreatorFees(this.tokenMintStr);

        if (result.success && result.claimed > 0) {
            this.stats.totalClaimed += result.claimed;
            this.logTransaction('claim', result.claimed, result.signature);
            this.persistStats(); // Save cumulative stats
        }

        return result;
    }

    // ─────────────────────────────────────────────────────────────────
    // FEE DISTRIBUTION
    // ─────────────────────────────────────────────────────────────────

    async distributeFees(totalAmount) {
        console.log(`[DISTRIBUTE] Starting distribution of ${(totalAmount / LAMPORTS_PER_SOL).toFixed(6)} SOL`);

        if (totalAmount <= CONFIG.MIN_TX_FEE_RESERVE) {
            console.log(`[DISTRIBUTE] Amount too small (min: ${CONFIG.MIN_TX_FEE_RESERVE / LAMPORTS_PER_SOL} SOL)`);
            return { success: false, error: 'Amount too small', distributed: 0, failed: 0 };
        }

        const distributable = totalAmount - CONFIG.MIN_TX_FEE_RESERVE;
        console.log(`[DISTRIBUTE] Distributable: ${(distributable / LAMPORTS_PER_SOL).toFixed(6)} SOL`);

        const results = {
            marketMaking: { amount: 0, success: false },
            buybackBurn: { amount: 0, success: false },
            liquidity: { amount: 0, success: false },
            creatorRevenue: { amount: 0, success: false },
        };

        // Calculate amounts for each allocation
        const amounts = {};
        for (const [key, percent] of Object.entries(this.allocations)) {
            amounts[key] = Math.floor(distributable * (percent / 100));
        }

        console.log(`[DISTRIBUTE] Allocations: MM=${amounts.marketMaking}, BB=${amounts.buybackBurn}, LP=${amounts.liquidity}, CR=${amounts.creatorRevenue}`);
        console.log(`[DISTRIBUTE] Features enabled: MM=${this.features.marketMaking}, BB=${this.features.buybackBurn}, LP=${this.features.liquidity}, CR=${this.features.creatorRevenue}`);

        // Execute each enabled feature
        if (this.features.marketMaking && amounts.marketMaking > 0) {
            console.log(`[DISTRIBUTE] Executing Market Making with ${amounts.marketMaking} lamports...`);
            results.marketMaking = await this.executeMarketMaking(amounts.marketMaking);
            console.log(`[DISTRIBUTE] MM result: ${JSON.stringify(results.marketMaking)}`);
        }

        if (this.features.buybackBurn && amounts.buybackBurn > 0) {
            console.log(`[DISTRIBUTE] Executing Buyback & Burn with ${amounts.buybackBurn} lamports...`);
            results.buybackBurn = await this.executeBuybackBurn(amounts.buybackBurn);
            console.log(`[DISTRIBUTE] BB result: ${JSON.stringify(results.buybackBurn)}`);
        }

        if (this.features.liquidity && amounts.liquidity > 0) {
            console.log(`[DISTRIBUTE] Executing Liquidity Add with ${amounts.liquidity} lamports...`);
            results.liquidity = await this.executeLiquidityAdd(amounts.liquidity);
            console.log(`[DISTRIBUTE] LP result: ${JSON.stringify(results.liquidity)}`);
        }

        if (this.features.creatorRevenue && amounts.creatorRevenue > 0) {
            console.log(`[DISTRIBUTE] Executing Creator Revenue with ${amounts.creatorRevenue} lamports...`);
            results.creatorRevenue = await this.executeCreatorRevenue(amounts.creatorRevenue);
            console.log(`[DISTRIBUTE] CR result: ${JSON.stringify(results.creatorRevenue)}`);
        }

        // Update stats and track failed amounts
        let totalDistributed = 0;
        let totalFailed = 0;

        for (const [key, result] of Object.entries(results)) {
            if (result.success && result.amount > 0) {
                this.stats[key] += result.amount;
                totalDistributed += result.amount;
            } else if (amounts[key] > 0 && this.features[key]) {
                // FIX: Track failed distribution amounts
                totalFailed += amounts[key];
                this.logTransaction(`${key}_failed`, amounts[key], result.error || 'unknown');
            }
        }

        this.stats.totalDistributed += totalDistributed;
        this.persistStats(); // Save cumulative stats

        // FIX: If any distributions failed, add to pending/retained funds
        if (totalFailed > 0) {
            // Failed funds are retained in wallet for next distribution attempt
            this.stats.pendingRetry = (this.stats.pendingRetry || 0) + totalFailed;
        }

        console.log(`[DISTRIBUTE] DONE - Distributed: ${(totalDistributed / LAMPORTS_PER_SOL).toFixed(6)} SOL, Failed: ${(totalFailed / LAMPORTS_PER_SOL).toFixed(6)} SOL`);

        return {
            success: true,
            distributed: totalDistributed,
            failed: totalFailed,
            results
        };
    }

    async executeMarketMaking(amount) {
        // Market making - BUY or SELL based on RSI
        // RSI > 70 = overbought = SELL
        // RSI < 30 = oversold = BUY
        // Otherwise = BUY (default buying pressure)
        try {
            const rsi = this.analyzer?.metrics?.rsi || 50;
            const solAmount = amount / LAMPORTS_PER_SOL;

            // Decide action based on RSI
            const shouldSell = rsi > 70;

            if (shouldSell) {
                // SELL - check if we have tokens to sell
                console.log(`[MM] RSI=${rsi.toFixed(1)} (>70) - SELLING tokens...`);

                // Get correct token program (Token-2022 for pump.fun)
                const tokenProgram = await getMintTokenProgram(this.connection, this.tokenMint);
                const ata = await getAssociatedTokenAddress(this.tokenMint, this.wallet.publicKey, false, tokenProgram);
                let tokenBalance = BigInt(0);
                try {
                    const account = await getAccount(this.connection, ata, 'confirmed', tokenProgram);
                    tokenBalance = account.amount;
                } catch (e) {
                    // No tokens
                }

                if (tokenBalance <= 0n) {
                    console.log(`[MM] No tokens to sell, skipping`);
                    return { amount: 0, success: true, action: 'skip_no_tokens' };
                }

                // Sell a portion (10% of balance or equivalent to SOL amount)
                const tokensToSell = tokenBalance / 10n; // Sell 10% of holdings
                if (tokensToSell <= 0n) {
                    console.log(`[MM] Token balance too low to sell`);
                    return { amount: 0, success: true, action: 'skip_low_balance' };
                }

                console.log(`[MM] Selling ${tokensToSell} tokens...`);
                const result = await this.pumpPortal.sell(this.tokenMintStr, Number(tokensToSell) / 1e6);

                if (result.success) {
                    console.log(`[MM] 📉 SOLD! TX: ${result.signature}`);
                    this.logTransaction('market_make_sell', Number(tokensToSell), result.signature);
                    return { amount, success: true, action: 'sell', signature: result.signature };
                }

                console.log(`[MM] Sell FAILED: ${result.error}`);
                return { amount: 0, success: false, error: result.error };
            } else {
                // BUY - default action
                console.log(`[MM] RSI=${rsi.toFixed(1)} - BUYING ${solAmount.toFixed(6)} SOL worth of tokens...`);
                const result = await this.pumpPortal.buy(this.tokenMintStr, solAmount);

                if (result.success) {
                    console.log(`[MM] 📈 BOUGHT! TX: ${result.signature}`);
                    this.logTransaction('market_make_buy', amount, result.signature);
                    return { amount, success: true, action: 'buy', signature: result.signature };
                }

                console.log(`[MM] Buy FAILED: ${result.error || 'unknown'}`);
                return { amount: 0, success: false, error: result.error };
            }
        } catch (error) {
            console.log(`[MM] ERROR: ${error.message}`);
            return { amount: 0, success: false, error: error.message };
        }
    }

    async executeBuybackBurn(amount) {
        // Buyback & Burn - First burn existing tokens, then optionally buy more
        try {
            const solAmount = amount / LAMPORTS_PER_SOL;
            console.log(`[BB] Starting buyback & burn with ${solAmount.toFixed(6)} SOL...`);

            // Get correct token program (Token-2022 for pump.fun)
            const tokenProgram = await getMintTokenProgram(this.connection, this.tokenMint);
            const ata = await getAssociatedTokenAddress(this.tokenMint, this.wallet.publicKey, false, tokenProgram);
            let existingBalance = BigInt(0);
            try {
                const account = await getAccount(this.connection, ata, 'confirmed', tokenProgram);
                existingBalance = account.amount;
            } catch (e) {
                // Account doesn't exist
            }

            let totalBurned = 0;

            // If we have existing tokens, burn them first!
            if (existingBalance > 0n) {
                console.log(`[BB] Found ${existingBalance} existing tokens - BURNING NOW!`);
                const burnResult = await this.burnTokens();

                if (burnResult.success && burnResult.burned > 0) {
                    console.log(`[BB] 🔥 BURNED ${burnResult.burned} existing tokens! TX: ${burnResult.signature}`);
                    this.logTransaction('burn', burnResult.burned, burnResult.signature);
                    totalBurned = burnResult.burned;
                }
            }

            // Then buy more tokens for future burns (if we have SOL allocated)
            if (solAmount > 0.001) {
                console.log(`[BB] Buying ${solAmount.toFixed(6)} SOL worth of tokens...`);
                const buyResult = await this.pumpPortal.buy(this.tokenMintStr, solAmount);

                if (buyResult.success) {
                    console.log(`[BB] Buy SUCCESS! TX: ${buyResult.signature}`);
                    this.logTransaction('buyback', amount, buyResult.signature);

                    // Try to burn the newly bought tokens too
                    console.log(`[BB] Waiting for new tokens to arrive...`);
                    const newBurnResult = await this.burnTokensWithRetry();

                    if (newBurnResult.success && newBurnResult.burned > 0) {
                        console.log(`[BB] 🔥 BURNED ${newBurnResult.burned} new tokens! TX: ${newBurnResult.signature}`);
                        this.logTransaction('burn', newBurnResult.burned, newBurnResult.signature);
                        totalBurned += newBurnResult.burned;
                    }
                } else {
                    console.log(`[BB] Buy failed: ${buyResult.error}, but existing tokens were burned`);
                }
            }

            if (totalBurned > 0) {
                console.log(`[BB] ✅ Total burned this round: ${totalBurned} tokens`);
            }

            return { amount, success: true, action: 'buyback_burn', burned: totalBurned };
        } catch (error) {
            console.log(`[BB] ERROR: ${error.message}`);
            return { amount: 0, success: false, error: error.message };
        }
    }

    async executeLiquidityAdd(amount) {
        try {
            const solAmount = amount / LAMPORTS_PER_SOL;
            console.log(`[LP] Adding liquidity with ${solAmount.toFixed(6)} SOL...`);

            // Check if token has bonded to PumpSwap
            await this.checkIfBonded();

            if (this.isBonded && this.pumpSwapPool) {
                // ═══════════════════════════════════════════════════════════
                // POST-BOND: Use PumpSwap SDK for real LP add
                // ═══════════════════════════════════════════════════════════
                console.log(`[LP] Token BONDED - Pool: ${this.pumpSwapPool.toBase58()}`);

                try {
                    // Use OnlinePumpAmmSdk's liquiditySolanaState - handles all decoding + fetching
                    const liquiditySolanaState = await this.pumpSwapOnlineSdk.liquiditySolanaState(
                        this.pumpSwapPool,
                        this.wallet.publicKey
                    );

                    if (!liquiditySolanaState || !liquiditySolanaState.pool) {
                        throw new Error('Failed to get pool state from SDK');
                    }

                    const pool = liquiditySolanaState.pool;
                    console.log(`[LP] Pool - Base: ${pool.baseMint.toBase58().slice(0,8)}..., Quote: ${pool.quoteMint.toBase58().slice(0,8)}...`);
                    console.log(`[LP] Pool reserves - Base: ${liquiditySolanaState.poolBaseTokenAccount?.amount || 0}, Quote: ${liquiditySolanaState.poolQuoteTokenAccount?.amount || 0}`);

                    // Calculate deposit based on quote (SOL) input
                    // SDK expects BN (bn.js) numbers, not native BigInt
                    const quoteAmount = new BN(amount);
                    const slippage = 0.05; // 5%

                    const depositCalc = this.pumpSwapSdk.depositAutocompleteBaseAndLpTokenFromQuote(
                        liquiditySolanaState,
                        quoteAmount,
                        slippage
                    );

                    console.log(`[LP] Deposit calc - Base needed: ${depositCalc.base.toString()}, LP tokens: ${depositCalc.lpToken.toString()}`);

                    // Check if we have enough tokens - use correct Token-2022 ATA
                    let tokenBalance = new BN(0);
                    const correctAta = await getAssociatedTokenAddress(
                        this.tokenMint,
                        this.wallet.publicKey,
                        false,
                        TOKEN_2022_PROGRAM_ID
                    );
                    try {
                        const tokenAccount = await getAccount(this.connection, correctAta, 'confirmed', TOKEN_2022_PROGRAM_ID);
                        tokenBalance = new BN(tokenAccount.amount.toString());
                        console.log(`[LP] User has ${tokenBalance.toString()} base tokens`);
                        // Update state with correct ATA
                        liquiditySolanaState.userBaseTokenAccount = correctAta;
                    } catch (e) {
                        console.log(`[LP] No base token account yet`);
                    }

                    // If we don't have enough tokens, buy some first
                    if (tokenBalance.lt(depositCalc.base)) {
                        console.log(`[LP] Need more tokens (have ${tokenBalance.toString()}, need ${depositCalc.base.toString()})`);
                        const buyResult = await this.pumpPortal.buy(this.tokenMintStr, solAmount * 0.5);
                        if (!buyResult.success) {
                            throw new Error(`Pre-buy failed: ${buyResult.error}`);
                        }
                        console.log(`[LP] Pre-buy TX: ${buyResult.signature}`);
                        await new Promise(r => setTimeout(r, 10000)); // Wait for tokens to arrive

                        // Refresh pool state after buy
                        const refreshedState = await this.pumpSwapOnlineSdk.liquiditySolanaState(
                            this.pumpSwapPool,
                            this.wallet.publicKey
                        );
                        if (refreshedState) {
                            Object.assign(liquiditySolanaState, refreshedState);
                        }

                        // Get actual token balance after buy
                        try {
                            console.log(`[LP] Checking Token-2022 ATA: ${correctAta.toBase58().slice(0,8)}...`);
                            const tokenAccount = await getAccount(this.connection, correctAta, 'confirmed', TOKEN_2022_PROGRAM_ID);
                            tokenBalance = new BN(tokenAccount.amount.toString());
                            console.log(`[LP] After buy: ${tokenBalance.toString()} tokens`);
                            liquiditySolanaState.userBaseTokenAccount = correctAta;
                        } catch (e) {
                            console.log(`[LP] Error checking balance: ${e.message}`);
                            throw new Error('No tokens after pre-buy');
                        }
                    }

                    // Recalculate deposit based on tokens we ACTUALLY have (use 90% to leave buffer)
                    const actualTokens = tokenBalance.muln(90).divn(100);
                    const finalDepositCalc = this.pumpSwapSdk.depositAutocompleteQuoteAndLpTokenFromBase(
                        liquiditySolanaState,
                        actualTokens,
                        slippage
                    );
                    console.log(`[LP] Final deposit - Tokens: ${actualTokens.toString()}, SOL needed: ${finalDepositCalc.quote.toString()}, LP: ${finalDepositCalc.lpToken.toString()}`);

                    // Create deposit instructions using SDK with recalculated amounts
                    const depositIxs = await this.pumpSwapSdk.depositInstructions(
                        liquiditySolanaState,
                        finalDepositCalc.lpToken,
                        slippage
                    );

                    // Build transaction with WSOL handling
                    const tx = new Transaction();

                    // Helper to check if account exists
                    const accountExists = async (pubkey) => {
                        if (!pubkey) return false;
                        const info = await this.connection.getAccountInfo(pubkey);
                        return info !== null;
                    };

                    // Ensure WSOL account exists and wrap SOL
                    const wsolExists = await accountExists(liquiditySolanaState.userQuoteTokenAccount);
                    if (!wsolExists) {
                        console.log(`[LP] Creating WSOL account...`);
                        tx.add(createAssociatedTokenAccountInstruction(
                            this.wallet.publicKey,
                            liquiditySolanaState.userQuoteTokenAccount,
                            this.wallet.publicKey,
                            WSOL_MINT
                        ));
                    }

                    // Ensure LP token account exists
                    const lpAccountExists = await accountExists(liquiditySolanaState.userPoolTokenAccount);
                    if (!lpAccountExists) {
                        console.log(`[LP] Creating LP token account...`);
                        tx.add(createAssociatedTokenAccountInstruction(
                            this.wallet.publicKey,
                            liquiditySolanaState.userPoolTokenAccount,
                            this.wallet.publicKey,
                            pool.lpMint
                        ));
                    }

                    // Wrap SOL to WSOL (use calculated quote amount, add 5% buffer)
                    const solToWrap = finalDepositCalc.quote.muln(105).divn(100);
                    console.log(`[LP] Wrapping ${solToWrap.toString()} lamports to WSOL`);
                    tx.add(SystemProgram.transfer({
                        fromPubkey: this.wallet.publicKey,
                        toPubkey: liquiditySolanaState.userQuoteTokenAccount,
                        lamports: parseInt(solToWrap.toString()),
                    }));
                    tx.add(createSyncNativeInstruction(liquiditySolanaState.userQuoteTokenAccount));

                    // Add deposit instructions
                    for (const ix of depositIxs) {
                        tx.add(ix);
                    }

                    const sig = await this.connection.sendTransaction(tx, [this.wallet], {
                        skipPreflight: false,
                        maxRetries: 3,
                    });

                    console.log(`[LP] ✅ REAL LP ADDED! TX: ${sig}`);
                    this.logTransaction('lp_add_real', amount, sig);
                    return { amount, success: true, action: 'lp_add_real', signature: sig };

                } catch (pumpSwapError) {
                    console.log(`[LP] PumpSwap error: ${pumpSwapError.message}`);
                    console.log(`[LP] Stack: ${pumpSwapError.stack?.slice(0, 300)}`);
                    console.log(`[LP] Falling back to buy...`);
                }
            }

            // ═══════════════════════════════════════════════════════════
            // PRE-BOND or FALLBACK: Buy tokens (buying = adding to liquidity)
            // ═══════════════════════════════════════════════════════════
            console.log(`[LP] ${this.isBonded ? 'Fallback' : 'Pre-bond'}: Buying tokens...`);
            const buyResult = await this.pumpPortal.buy(this.tokenMintStr, solAmount);

            if (buyResult.success) {
                console.log(`[LP] SUCCESS! TX: ${buyResult.signature}`);
                this.logTransaction('lp_add', amount, buyResult.signature);
                return { amount, success: true, action: 'lp_add', signature: buyResult.signature };
            }

            console.log(`[LP] FAILED: ${buyResult.error || 'unknown'}`);
            return { amount: 0, success: false, error: buyResult.error };
        } catch (error) {
            console.log(`[LP] ERROR: ${error.message}`);
            return { amount: 0, success: false, error: error.message };
        }
    }

    async executeCreatorRevenue(amount) {
        // Creator Revenue - Track or transfer to creator
        try {
            console.log(`[CR] Processing ${(amount / LAMPORTS_PER_SOL).toFixed(6)} SOL creator revenue...`);

            if (this.creatorWallet.equals(this.wallet.publicKey)) {
                // Already in wallet, just track it
                console.log(`[CR] Retained in wallet (same address)`);
                this.logTransaction('creator_revenue', amount, 'retained');
                return { amount, success: true, action: 'retained' };
            }

            // Transfer to different creator wallet
            const tx = new Transaction().add(
                SystemProgram.transfer({
                    fromPubkey: this.wallet.publicKey,
                    toPubkey: this.creatorWallet,
                    lamports: amount,
                })
            );

            const sig = await this.connection.sendTransaction(tx, [this.wallet]);
            console.log(`[CR] Transfer sent: ${sig}`);

            await new Promise(r => setTimeout(r, 3000)); // Wait instead of blocking confirm

            console.log(`[CR] SUCCESS! Transferred to creator`);
            this.logTransaction('creator_revenue', amount, sig);
            return { amount, success: true, action: 'transferred', signature: sig };
        } catch (error) {
            return { amount: 0, success: false, error: error.message };
        }
    }

    /**
     * Wait for tokens to arrive then burn them - with retry logic
     * Checks up to 6 times (30 seconds total) for tokens to appear
     */
    async burnTokensWithRetry(maxRetries = 6, delayMs = 5000) {
        // Get correct token program (Token-2022 for pump.fun)
        const tokenProgram = await getMintTokenProgram(this.connection, this.tokenMint);
        const ata = await getAssociatedTokenAddress(this.tokenMint, this.wallet.publicKey, false, tokenProgram);

        console.log(`[BB] Checking ATA: ${ata.toBase58()}`);
        console.log(`[BB] Token mint: ${this.tokenMint.toBase58()}`);
        console.log(`[BB] Wallet: ${this.wallet.publicKey.toBase58()}`);
        console.log(`[BB] Using: ${tokenProgram.equals(TOKEN_2022_PROGRAM_ID) ? 'Token-2022' : 'SPL Token'}`);

        for (let attempt = 1; attempt <= maxRetries; attempt++) {
            try {
                // Wait before checking (first attempt waits too)
                await new Promise(r => setTimeout(r, delayMs));

                // First check if account exists at all
                const accountInfo = await this.connection.getAccountInfo(ata);
                if (!accountInfo) {
                    console.log(`[BB] Attempt ${attempt}/${maxRetries}: ATA does not exist yet`);
                    continue;
                }

                const balance = await this.connection.getTokenAccountBalance(ata);
                const tokenBalance = BigInt(balance.value.amount);

                console.log(`[BB] Attempt ${attempt}/${maxRetries}: Balance = ${tokenBalance} tokens`);

                if (tokenBalance > 0n) {
                    // Tokens arrived! Burn them
                    console.log(`[BB] 🔥 Tokens found! Burning ${tokenBalance} tokens...`);

                    const tx = new Transaction().add(
                        createBurnInstruction(ata, this.tokenMint, this.wallet.publicKey, tokenBalance, [], tokenProgram)
                    );

                    const sig = await this.connection.sendTransaction(tx, [this.wallet], {
                        skipPreflight: true,
                        maxRetries: 3,
                    });

                    // Wait briefly for confirmation
                    await new Promise(r => setTimeout(r, 3000));

                    console.log(`[BB] ✅ BURNED! TX: ${sig}`);
                    return { success: true, burned: Number(tokenBalance), signature: sig };
                }
            } catch (error) {
                // Token account might not exist yet, keep trying
                console.log(`[BB] Attempt ${attempt}/${maxRetries}: ${error.message}`);
            }
        }

        // Exhausted retries - try one more thing: check if we have ANY tokens in the account
        try {
            const finalBalance = await this.connection.getTokenAccountBalance(ata);
            const finalAmount = BigInt(finalBalance.value.amount);
            if (finalAmount > 0n) {
                console.log(`[BB] Final check found ${finalAmount} tokens - burning...`);
                const tx = new Transaction().add(
                    createBurnInstruction(ata, this.tokenMint, this.wallet.publicKey, finalAmount, [], tokenProgram)
                );
                const sig = await this.connection.sendTransaction(tx, [this.wallet], {
                    skipPreflight: true,
                    maxRetries: 3,
                });
                await new Promise(r => setTimeout(r, 3000));
                return { success: true, burned: Number(finalAmount), signature: sig };
            }
        } catch (e) {
            // Account doesn't exist
        }

        // Exhausted retries - tokens never arrived
        console.log(`[BB] Tokens did not arrive after ${maxRetries} attempts (${maxRetries * delayMs / 1000}s)`);
        return { success: false, burned: 0, balance: 0, error: 'Tokens did not arrive in time' };
    }

    async burnTokens() {
        try {
            // Get correct token program (Token-2022 for pump.fun)
            const tokenProgram = await getMintTokenProgram(this.connection, this.tokenMint);
            const ata = await getAssociatedTokenAddress(this.tokenMint, this.wallet.publicKey, false, tokenProgram);
            const balance = await this.connection.getTokenAccountBalance(ata);
            const tokenBalance = BigInt(balance.value.amount);

            if (tokenBalance <= 0n) {
                return { success: true, burned: 0 };
            }

            const tx = new Transaction().add(
                createBurnInstruction(ata, this.tokenMint, this.wallet.publicKey, tokenBalance, [], tokenProgram)
            );

            const sig = await this.connection.sendTransaction(tx, [this.wallet], {
                skipPreflight: true,
                maxRetries: 3,
            });
            // Don't block on confirmation
            await new Promise(r => setTimeout(r, 3000));

            return { success: true, burned: Number(tokenBalance), signature: sig };
        } catch (error) {
            return { success: false, burned: 0, error: error.message };
        }
    }

    // ─────────────────────────────────────────────────────────────────
    // CLAIM AND DISTRIBUTE (Combined Operation)
    // 1% goes to LAUNCHR holder pool, 99% to creator's allocation
    // ─────────────────────────────────────────────────────────────────

    async claimAndDistribute() {
        const claimResult = await this.claimFees();

        if (!claimResult.success) {
            return { claimed: 0, distributed: 0, holderFee: 0, error: claimResult.error };
        }

        if (claimResult.claimed <= 0) {
            return { claimed: 0, distributed: 0, holderFee: 0 };
        }

        // ═══════════════════════════════════════════════════════════
        // LAUNCHR HOLDER FEE: 1% to operations wallet
        // ═══════════════════════════════════════════════════════════
        const holderFeeAmount = Math.floor(claimResult.claimed * CONFIG.LAUNCHR_HOLDER_FEE_BPS / 10000);
        const creatorAmount = claimResult.claimed - holderFeeAmount;

        console.log(`\n${'═'.repeat(50)}`);
        console.log(`[FEE SPLIT] Total claimed: ${(claimResult.claimed / LAMPORTS_PER_SOL).toFixed(6)} SOL`);
        console.log(`[FEE SPLIT] → LAUNCHR holders (1%): ${(holderFeeAmount / LAMPORTS_PER_SOL).toFixed(6)} SOL`);
        console.log(`[FEE SPLIT] → Creator allocation (99%): ${(creatorAmount / LAMPORTS_PER_SOL).toFixed(6)} SOL`);
        console.log(`${'═'.repeat(50)}\n`);

        // Send 1% to LAUNCHR ops wallet
        let holderFeeResult = { success: false, amount: 0 };
        if (holderFeeAmount > 0 && CONFIG.LAUNCHR_OPS_WALLET) {
            try {
                const tx = new Transaction().add(
                    SystemProgram.transfer({
                        fromPubkey: this.wallet.publicKey,
                        toPubkey: new PublicKey(CONFIG.LAUNCHR_OPS_WALLET),
                        lamports: holderFeeAmount,
                    })
                );
                const sig = await this.connection.sendTransaction(tx, [this.wallet]);
                console.log(`[HOLDER FEE] Sent ${(holderFeeAmount / LAMPORTS_PER_SOL).toFixed(6)} SOL to LAUNCHR | TX: ${sig}`);
                holderFeeResult = { success: true, amount: holderFeeAmount, signature: sig };
                this.logTransaction('launchr_holder_fee', holderFeeAmount, sig);
            } catch (e) {
                console.log(`[HOLDER FEE] Transfer failed: ${e.message}`);
                // If transfer fails, add back to creator amount
                holderFeeResult = { success: false, amount: 0, error: e.message };
            }
        } else if (!CONFIG.LAUNCHR_OPS_WALLET) {
            console.log(`[HOLDER FEE] No ops wallet configured - skipping holder fee`);
        }

        // Distribute 99% to creator's allocation
        const distributeResult = await this.distributeFees(creatorAmount);

        // Track holder fees in stats
        if (!this.stats.holderFeesCollected) this.stats.holderFeesCollected = 0;
        this.stats.holderFeesCollected += holderFeeResult.amount;

        return {
            claimed: claimResult.claimed,
            holderFee: holderFeeResult.amount,
            distributed: distributeResult.distributed,
            results: distributeResult.results,
            holderFeeResult,
        };
    }

    // ─────────────────────────────────────────────────────────────────
    // LOGGING & STATUS
    // ─────────────────────────────────────────────────────────────────

    logTransaction(type, amount, signature) {
        this.stats.transactions.push({
            type,
            amount,
            signature,
            timestamp: Date.now(),
        });

        // Keep last 100 transactions
        if (this.stats.transactions.length > 100) {
            this.stats.transactions.shift();
        }
    }

    getStatus() {
        return {
            tokenMint: this.tokenMintStr,
            allocations: this.allocations,
            features: this.features,
            stats: this.stats,
            analysis: this.analyzer.getAnalysis(),
            rsi: {
                current: this.analyzer.metrics.rsi,
                shouldBuy: this.analyzer.shouldBuy(),
            },
            currentPrice: this.currentPrice,
            creatorWallet: this.creatorWallet.toBase58(),
        };
    }

    getStats() {
        return { ...this.stats };
    }
}

// ═══════════════════════════════════════════════════════════════════
// EXPORTS
// ═══════════════════════════════════════════════════════════════════

module.exports = {
    LaunchrEngine,
    MarketAnalyzer,
    PumpPortalClient,
    RSICalculator,
    CONFIG,
};
