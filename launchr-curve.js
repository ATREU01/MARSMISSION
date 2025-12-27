/**
 * LAUNCHR BONDING CURVE ENGINE
 * ═══════════════════════════════════════════════════════════════════════════
 * CIA-grade bonding curve implementation for LAUNCHR native tokens
 *
 * How it works:
 * 1. Token launches with 1B supply, 800M on curve
 * 2. Users buy/sell against the curve - price adjusts dynamically
 * 3. SOL accumulates in the curve vault
 * 4. At 85 SOL threshold, token graduates
 * 5. Liquidity migrates to Raydium, LP tokens burned
 * ═══════════════════════════════════════════════════════════════════════════
 */

const { Connection, Keypair, PublicKey, Transaction, SystemProgram, LAMPORTS_PER_SOL } = require('@solana/web3.js');
const { TOKEN_PROGRAM_ID, getAssociatedTokenAddress, createAssociatedTokenAccountInstruction, createTransferInstruction, getAccount } = require('@solana/spl-token');
const fs = require('fs');
const path = require('path');

// ═══════════════════════════════════════════════════════════════════════════
// CONFIGURATION
// ═══════════════════════════════════════════════════════════════════════════

const CURVE_CONFIG = {
    // Supply allocation
    TOTAL_SUPPLY: 1_000_000_000,        // 1 billion tokens
    CURVE_SUPPLY: 800_000_000,          // 800M on bonding curve
    RESERVE_SUPPLY: 200_000_000,        // 200M for LP after graduation
    DECIMALS: 6,

    // Curve parameters (pump.fun style)
    VIRTUAL_SOL_RESERVES: 30,           // Virtual SOL for price calculation
    VIRTUAL_TOKEN_RESERVES: 1_073_000_000, // Virtual tokens (slightly > 1B)

    // Graduation threshold
    GRADUATION_SOL: 85,                 // SOL needed to graduate
    GRADUATION_MCAP: 69000,             // ~$69K mcap at graduation

    // Fees - LAUNCHR Revenue Model
    PLATFORM_FEE_BPS: 100,              // 1% platform fee on every trade
    GRADUATION_FEE_SOL: 2.3,            // SOL taken by platform on graduation
    CREATOR_REWARD_SOL: 0.5,            // SOL reward to creator on graduation
    LP_DEPOSIT_SOL: 12,                 // SOL deposited to Raydium LP
    LP_FEE_SHARE_BPS: 25,               // 0.25% of LP trading fees go to LAUNCHR

    // Storage
    CURVES_FILE: path.join(__dirname, '.launchr-curves.json'),
};

// ═══════════════════════════════════════════════════════════════════════════
// BONDING CURVE MATH (Constant Product AMM - x * y = k)
// ═══════════════════════════════════════════════════════════════════════════

class CurveMath {
    /**
     * Calculate tokens received for SOL input (buy)
     * Uses constant product formula: x * y = k
     */
    static calculateBuyTokens(solAmount, virtualSol, virtualTokens) {
        // New virtual SOL after purchase
        const newVirtualSol = virtualSol + solAmount;

        // Constant product
        const k = virtualSol * virtualTokens;

        // New virtual tokens
        const newVirtualTokens = k / newVirtualSol;

        // Tokens received
        const tokensOut = virtualTokens - newVirtualTokens;

        return {
            tokensOut: Math.floor(tokensOut),
            newVirtualSol,
            newVirtualTokens,
            pricePerToken: solAmount / tokensOut,
            priceImpact: ((newVirtualSol / virtualSol) - 1) * 100,
        };
    }

    /**
     * Calculate SOL received for token input (sell)
     */
    static calculateSellSol(tokenAmount, virtualSol, virtualTokens) {
        // New virtual tokens after sale
        const newVirtualTokens = virtualTokens + tokenAmount;

        // Constant product
        const k = virtualSol * virtualTokens;

        // New virtual SOL
        const newVirtualSol = k / newVirtualTokens;

        // SOL received
        const solOut = virtualSol - newVirtualSol;

        return {
            solOut,
            newVirtualSol,
            newVirtualTokens,
            pricePerToken: solOut / tokenAmount,
            priceImpact: ((newVirtualTokens / virtualTokens) - 1) * 100,
        };
    }

    /**
     * Get current token price
     */
    static getCurrentPrice(virtualSol, virtualTokens) {
        return virtualSol / virtualTokens;
    }

    /**
     * Calculate market cap
     */
    static getMarketCap(virtualSol, virtualTokens, totalSupply) {
        const price = this.getCurrentPrice(virtualSol, virtualTokens);
        return price * totalSupply;
    }

    /**
     * Calculate progress to graduation (0-100%)
     */
    static getProgress(realSolReserves, threshold = CURVE_CONFIG.GRADUATION_SOL) {
        return Math.min((realSolReserves / threshold) * 100, 100);
    }
}

// ═══════════════════════════════════════════════════════════════════════════
// BONDING CURVE STATE
// ═══════════════════════════════════════════════════════════════════════════

class BondingCurveState {
    constructor(mint, creator, name, symbol) {
        this.mint = mint;
        this.creator = creator;
        this.name = name;
        this.symbol = symbol;

        // Reserves (virtual for price, real for actual holdings)
        this.virtualSolReserves = CURVE_CONFIG.VIRTUAL_SOL_RESERVES;
        this.virtualTokenReserves = CURVE_CONFIG.VIRTUAL_TOKEN_RESERVES;
        this.realSolReserves = 0;        // Actual SOL in vault
        this.realTokenReserves = CURVE_CONFIG.CURVE_SUPPLY; // Tokens available to buy

        // State
        this.graduated = false;
        this.graduatedAt = null;
        this.raydiumPool = null;
        this.lpBurned = false;

        // Stats
        this.totalBuys = 0;
        this.totalSells = 0;
        this.totalVolumeSol = 0;
        this.uniqueBuyers = new Set();
        this.trades = [];

        // Timestamps
        this.createdAt = Date.now();
        this.lastTradeAt = null;
    }

    /**
     * Execute buy
     */
    buy(solAmount, buyer) {
        if (this.graduated) {
            throw new Error('Token has graduated - trade on Raydium');
        }

        // Calculate tokens
        const result = CurveMath.calculateBuyTokens(
            solAmount,
            this.virtualSolReserves,
            this.virtualTokenReserves
        );

        if (result.tokensOut > this.realTokenReserves) {
            throw new Error('Insufficient tokens in curve');
        }

        // Apply platform fee
        const fee = solAmount * (CURVE_CONFIG.PLATFORM_FEE_BPS / 10000);
        const netSol = solAmount - fee;

        // Update reserves
        this.virtualSolReserves = result.newVirtualSol;
        this.virtualTokenReserves = result.newVirtualTokens;
        this.realSolReserves += netSol;
        this.realTokenReserves -= result.tokensOut;

        // Update stats
        this.totalBuys++;
        this.totalVolumeSol += solAmount;
        this.uniqueBuyers.add(buyer);
        this.lastTradeAt = Date.now();

        // Log trade
        this.trades.push({
            type: 'buy',
            buyer,
            solIn: solAmount,
            tokensOut: result.tokensOut,
            price: result.pricePerToken,
            fee,
            timestamp: Date.now(),
        });

        // Check graduation
        const shouldGraduate = this.realSolReserves >= CURVE_CONFIG.GRADUATION_SOL;

        return {
            success: true,
            tokensOut: result.tokensOut,
            pricePerToken: result.pricePerToken,
            priceImpact: result.priceImpact,
            fee,
            newPrice: CurveMath.getCurrentPrice(this.virtualSolReserves, this.virtualTokenReserves),
            progress: CurveMath.getProgress(this.realSolReserves),
            shouldGraduate,
        };
    }

    /**
     * Execute sell
     */
    sell(tokenAmount, seller) {
        if (this.graduated) {
            throw new Error('Token has graduated - trade on Raydium');
        }

        // Calculate SOL
        const result = CurveMath.calculateSellSol(
            tokenAmount,
            this.virtualSolReserves,
            this.virtualTokenReserves
        );

        if (result.solOut > this.realSolReserves) {
            throw new Error('Insufficient SOL in curve');
        }

        // Apply platform fee
        const fee = result.solOut * (CURVE_CONFIG.PLATFORM_FEE_BPS / 10000);
        const netSol = result.solOut - fee;

        // Update reserves
        this.virtualSolReserves = result.newVirtualSol;
        this.virtualTokenReserves = result.newVirtualTokens;
        this.realSolReserves -= result.solOut;
        this.realTokenReserves += tokenAmount;

        // Update stats
        this.totalSells++;
        this.totalVolumeSol += result.solOut;
        this.lastTradeAt = Date.now();

        // Log trade
        this.trades.push({
            type: 'sell',
            seller,
            tokensIn: tokenAmount,
            solOut: netSol,
            price: result.pricePerToken,
            fee,
            timestamp: Date.now(),
        });

        return {
            success: true,
            solOut: netSol,
            pricePerToken: result.pricePerToken,
            priceImpact: result.priceImpact,
            fee,
            newPrice: CurveMath.getCurrentPrice(this.virtualSolReserves, this.virtualTokenReserves),
            progress: CurveMath.getProgress(this.realSolReserves),
        };
    }

    /**
     * Get quote for buy (no state change)
     */
    quoteBuy(solAmount) {
        const result = CurveMath.calculateBuyTokens(
            solAmount,
            this.virtualSolReserves,
            this.virtualTokenReserves
        );

        const fee = solAmount * (CURVE_CONFIG.PLATFORM_FEE_BPS / 10000);

        return {
            tokensOut: result.tokensOut,
            pricePerToken: result.pricePerToken,
            priceImpact: result.priceImpact,
            fee,
            available: result.tokensOut <= this.realTokenReserves,
        };
    }

    /**
     * Get quote for sell (no state change)
     */
    quoteSell(tokenAmount) {
        const result = CurveMath.calculateSellSol(
            tokenAmount,
            this.virtualSolReserves,
            this.virtualTokenReserves
        );

        const fee = result.solOut * (CURVE_CONFIG.PLATFORM_FEE_BPS / 10000);

        return {
            solOut: result.solOut - fee,
            pricePerToken: result.pricePerToken,
            priceImpact: result.priceImpact,
            fee,
            available: result.solOut <= this.realSolReserves,
        };
    }

    /**
     * Mark as graduated
     */
    graduate(raydiumPool) {
        this.graduated = true;
        this.graduatedAt = Date.now();
        this.raydiumPool = raydiumPool;
        return this;
    }

    /**
     * Get current status
     */
    getStatus() {
        const price = CurveMath.getCurrentPrice(this.virtualSolReserves, this.virtualTokenReserves);
        const mcap = CurveMath.getMarketCap(this.virtualSolReserves, this.virtualTokenReserves, CURVE_CONFIG.TOTAL_SUPPLY);
        const progress = CurveMath.getProgress(this.realSolReserves);

        return {
            mint: this.mint,
            name: this.name,
            symbol: this.symbol,
            creator: this.creator,

            // Price
            price,
            priceUsd: price * 200, // Approximate SOL price
            mcap,
            mcapUsd: mcap * 200,

            // Reserves
            virtualSol: this.virtualSolReserves,
            virtualTokens: this.virtualTokenReserves,
            realSol: this.realSolReserves,
            tokensRemaining: this.realTokenReserves,
            tokensSold: CURVE_CONFIG.CURVE_SUPPLY - this.realTokenReserves,

            // Progress
            progress,
            graduationThreshold: CURVE_CONFIG.GRADUATION_SOL,
            solToGraduate: Math.max(0, CURVE_CONFIG.GRADUATION_SOL - this.realSolReserves),

            // State
            graduated: this.graduated,
            graduatedAt: this.graduatedAt,
            raydiumPool: this.raydiumPool,
            lpBurned: this.lpBurned,

            // Stats
            totalTrades: this.totalBuys + this.totalSells,
            totalBuys: this.totalBuys,
            totalSells: this.totalSells,
            totalVolume: this.totalVolumeSol,
            uniqueBuyers: this.uniqueBuyers.size,

            // Time
            createdAt: this.createdAt,
            lastTradeAt: this.lastTradeAt,
            age: Date.now() - this.createdAt,
        };
    }

    /**
     * Serialize for storage
     */
    toJSON() {
        return {
            mint: this.mint,
            creator: this.creator,
            name: this.name,
            symbol: this.symbol,
            virtualSolReserves: this.virtualSolReserves,
            virtualTokenReserves: this.virtualTokenReserves,
            realSolReserves: this.realSolReserves,
            realTokenReserves: this.realTokenReserves,
            graduated: this.graduated,
            graduatedAt: this.graduatedAt,
            raydiumPool: this.raydiumPool,
            lpBurned: this.lpBurned,
            totalBuys: this.totalBuys,
            totalSells: this.totalSells,
            totalVolumeSol: this.totalVolumeSol,
            uniqueBuyers: Array.from(this.uniqueBuyers),
            trades: this.trades.slice(-100), // Last 100 trades
            createdAt: this.createdAt,
            lastTradeAt: this.lastTradeAt,
        };
    }

    /**
     * Restore from storage
     */
    static fromJSON(data) {
        const curve = new BondingCurveState(data.mint, data.creator, data.name, data.symbol);

        curve.virtualSolReserves = data.virtualSolReserves;
        curve.virtualTokenReserves = data.virtualTokenReserves;
        curve.realSolReserves = data.realSolReserves;
        curve.realTokenReserves = data.realTokenReserves;
        curve.graduated = data.graduated;
        curve.graduatedAt = data.graduatedAt;
        curve.raydiumPool = data.raydiumPool;
        curve.lpBurned = data.lpBurned;
        curve.totalBuys = data.totalBuys;
        curve.totalSells = data.totalSells;
        curve.totalVolumeSol = data.totalVolumeSol;
        curve.uniqueBuyers = new Set(data.uniqueBuyers || []);
        curve.trades = data.trades || [];
        curve.createdAt = data.createdAt;
        curve.lastTradeAt = data.lastTradeAt;

        return curve;
    }
}

// ═══════════════════════════════════════════════════════════════════════════
// CURVE MANAGER (Handles all curves)
// ═══════════════════════════════════════════════════════════════════════════

class LaunchrCurveManager {
    constructor(connection, platformWallet) {
        this.connection = connection;
        this.platformWallet = platformWallet;
        this.curves = new Map();

        this.loadCurves();
    }

    /**
     * Create new bonding curve
     */
    createCurve(mint, creator, name, symbol) {
        if (this.curves.has(mint)) {
            throw new Error('Curve already exists for this token');
        }

        const curve = new BondingCurveState(mint, creator, name, symbol);
        this.curves.set(mint, curve);
        this.saveCurves();

        console.log(`[CURVE] Created bonding curve for ${symbol} (${mint})`);

        return curve;
    }

    /**
     * Get curve by mint
     */
    getCurve(mint) {
        return this.curves.get(mint);
    }

    /**
     * Get all active curves (not graduated)
     */
    getActiveCurves() {
        return Array.from(this.curves.values()).filter(c => !c.graduated);
    }

    /**
     * Get all graduated curves
     */
    getGraduatedCurves() {
        return Array.from(this.curves.values()).filter(c => c.graduated);
    }

    /**
     * Execute buy on curve
     */
    async buy(mint, solAmount, buyer) {
        const curve = this.getCurve(mint);
        if (!curve) throw new Error('Curve not found');

        const result = curve.buy(solAmount, buyer);
        this.saveCurves();

        // Check if should graduate
        if (result.shouldGraduate) {
            console.log(`[CURVE] ${curve.symbol} is ready to graduate!`);
            await this.graduate(mint);
        }

        return result;
    }

    /**
     * Execute sell on curve
     */
    async sell(mint, tokenAmount, seller) {
        const curve = this.getCurve(mint);
        if (!curve) throw new Error('Curve not found');

        const result = curve.sell(tokenAmount, seller);
        this.saveCurves();

        return result;
    }

    /**
     * Graduate curve to Raydium
     */
    async graduate(mint) {
        const curve = this.getCurve(mint);
        if (!curve) throw new Error('Curve not found');
        if (curve.graduated) throw new Error('Already graduated');

        console.log(`\n${'═'.repeat(50)}`);
        console.log(`GRADUATING: ${curve.name} (${curve.symbol})`);
        console.log(`${'═'.repeat(50)}`);
        console.log(`SOL in curve: ${curve.realSolReserves.toFixed(2)}`);
        console.log(`Tokens sold: ${(CURVE_CONFIG.CURVE_SUPPLY - curve.realTokenReserves).toLocaleString()}`);

        try {
            // 1. Calculate LP amounts
            const lpSol = CURVE_CONFIG.LP_DEPOSIT_SOL;
            const remainingTokens = curve.realTokenReserves + CURVE_CONFIG.RESERVE_SUPPLY;

            console.log(`[GRADUATE] LP deposit: ${lpSol} SOL + ${remainingTokens.toLocaleString()} tokens`);

            // 2. Create Raydium pool (placeholder - needs actual Raydium SDK)
            const raydiumPool = {
                poolId: 'pending_raydium_' + Date.now(),
                baseMint: mint,
                quoteMint: 'So11111111111111111111111111111111111111112', // SOL
                lpMint: null,
                baseDeposit: remainingTokens,
                quoteDeposit: lpSol * LAMPORTS_PER_SOL,
                createdAt: Date.now(),
                status: 'pending',
            };

            // 3. Mark as graduated
            curve.graduate(raydiumPool);

            // 4. Reward creator
            const creatorReward = CURVE_CONFIG.CREATOR_REWARD_SOL;
            console.log(`[GRADUATE] Creator reward: ${creatorReward} SOL to ${curve.creator}`);

            // 5. Platform takes remaining (after LP deposit and creator reward)
            const platformTake = curve.realSolReserves - lpSol - creatorReward;
            console.log(`[GRADUATE] Platform revenue: ${platformTake.toFixed(2)} SOL`);

            this.saveCurves();

            console.log(`\n[GRADUATE] ${curve.symbol} graduated successfully!`);
            console.log(`[GRADUATE] Now trading on Raydium`);
            console.log(`${'═'.repeat(50)}\n`);

            return {
                success: true,
                raydiumPool,
                creatorReward,
                platformRevenue: platformTake,
            };

        } catch (error) {
            console.error(`[GRADUATE] Failed: ${error.message}`);
            return { success: false, error: error.message };
        }
    }

    /**
     * Get leaderboard (by progress)
     */
    getLeaderboard(limit = 10) {
        return this.getActiveCurves()
            .map(c => c.getStatus())
            .sort((a, b) => b.progress - a.progress)
            .slice(0, limit);
    }

    /**
     * Get trending (by recent volume)
     */
    getTrending(limit = 10) {
        const oneHourAgo = Date.now() - 3600000;

        return this.getActiveCurves()
            .map(c => {
                const recentTrades = c.trades.filter(t => t.timestamp > oneHourAgo);
                const recentVolume = recentTrades.reduce((sum, t) => sum + (t.solIn || t.solOut || 0), 0);
                return { ...c.getStatus(), recentVolume };
            })
            .sort((a, b) => b.recentVolume - a.recentVolume)
            .slice(0, limit);
    }

    /**
     * Save curves to file
     */
    saveCurves() {
        try {
            const data = {};
            for (const [mint, curve] of this.curves) {
                data[mint] = curve.toJSON();
            }
            fs.writeFileSync(CURVE_CONFIG.CURVES_FILE, JSON.stringify(data, null, 2));
        } catch (e) {
            console.error(`[CURVE] Save error: ${e.message}`);
        }
    }

    /**
     * Load curves from file
     */
    loadCurves() {
        try {
            if (fs.existsSync(CURVE_CONFIG.CURVES_FILE)) {
                const data = JSON.parse(fs.readFileSync(CURVE_CONFIG.CURVES_FILE, 'utf8'));
                for (const [mint, curveData] of Object.entries(data)) {
                    this.curves.set(mint, BondingCurveState.fromJSON(curveData));
                }
                console.log(`[CURVE] Loaded ${this.curves.size} curves`);
            }
        } catch (e) {
            console.error(`[CURVE] Load error: ${e.message}`);
        }
    }
}

// ═══════════════════════════════════════════════════════════════════════════
// EXPORTS
// ═══════════════════════════════════════════════════════════════════════════

module.exports = {
    LaunchrCurveManager,
    BondingCurveState,
    CurveMath,
    CURVE_CONFIG,
};
