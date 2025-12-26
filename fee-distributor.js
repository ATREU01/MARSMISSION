/**
 * TOKEN FEE DISTRIBUTION SYSTEM - PumpFun/PumpPortal
 *
 * Fee Split:
 * - 25% Burned (sent to dead address)
 * - 25% Buyback with RSI indicator (via PumpPortal)
 * - 25% Random holder distribution
 * - 25% Added to PumpSwap pool + auto burn LP
 */

const {
    Connection,
    PublicKey,
    Keypair,
    Transaction,
    VersionedTransaction,
    SystemProgram,
    LAMPORTS_PER_SOL,
    sendAndConfirmTransaction,
    ComputeBudgetProgram,
} = require('@solana/web3.js');

const {
    TOKEN_PROGRAM_ID,
    getAssociatedTokenAddress,
    getOrCreateAssociatedTokenAccount,
    createTransferInstruction,
    createBurnInstruction,
    getAccount,
} = require('@solana/spl-token');

const axios = require('axios');
const bs58 = require('bs58');

// ═══════════════════════════════════════════════════════════════════
// CONFIGURATION
// ═══════════════════════════════════════════════════════════════════

const CONFIG = {
    // Fee split percentages
    FEE_SPLIT: {
        BURN: 25,
        BUYBACK: 25,
        HOLDER_REWARD: 25,
        LP_POOL: 25,
    },

    // RSI settings
    RSI: {
        PERIOD: 14,
        OVERSOLD: 30,
        OVERBOUGHT: 70,
        STRONG_BUY: 20,
    },

    // Pump.fun / PumpPortal endpoints
    PUMP_PORTAL_API: 'https://pumpportal.fun/api',
    PUMP_FUN_API: 'https://frontend-api.pump.fun',

    // Burn address (standard Solana burn)
    BURN_ADDRESS: new PublicKey('1nc1nerator11111111111111111111111111111111'),

    // Minimum thresholds
    MIN_HOLDERS_FOR_DISTRIBUTION: 5,
    MIN_FEE_THRESHOLD_LAMPORTS: 100000, // 0.0001 SOL worth

    // Transaction settings
    PRIORITY_FEE: 100000, // microlamports
    SLIPPAGE_BPS: 500, // 5%
};

// ═══════════════════════════════════════════════════════════════════
// RSI CALCULATOR
// ═══════════════════════════════════════════════════════════════════

class RSICalculator {
    constructor(period = 14) {
        this.period = period;
        this.prices = [];
    }

    addPrice(price) {
        if (typeof price !== 'number' || price <= 0) return;
        this.prices.push(price);
        // Keep only what we need
        if (this.prices.length > this.period * 2) {
            this.prices = this.prices.slice(-this.period - 1);
        }
    }

    calculate() {
        if (this.prices.length < this.period + 1) {
            return { rsi: 50, ready: false, dataPoints: this.prices.length };
        }

        let gains = 0;
        let losses = 0;

        for (let i = this.prices.length - this.period; i < this.prices.length; i++) {
            const change = this.prices[i] - this.prices[i - 1];
            if (change > 0) {
                gains += change;
            } else {
                losses += Math.abs(change);
            }
        }

        const avgGain = gains / this.period;
        const avgLoss = losses / this.period;

        if (avgLoss === 0) return { rsi: 100, ready: true };

        const rs = avgGain / avgLoss;
        const rsi = 100 - (100 / (1 + rs));

        return { rsi: Math.round(rsi * 100) / 100, ready: true };
    }

    shouldBuyback() {
        const { rsi, ready } = this.calculate();

        if (!ready) {
            return { rsi, shouldBuy: false, multiplier: 0, reason: 'insufficient_data' };
        }

        // Aggressive buying when oversold
        if (rsi < CONFIG.RSI.STRONG_BUY) {
            return { rsi, shouldBuy: true, multiplier: 2.0, reason: 'strong_buy' };
        }
        if (rsi < CONFIG.RSI.OVERSOLD) {
            return { rsi, shouldBuy: true, multiplier: 1.5, reason: 'oversold' };
        }
        if (rsi < 40) {
            return { rsi, shouldBuy: true, multiplier: 1.0, reason: 'buy_zone' };
        }
        if (rsi < 50) {
            return { rsi, shouldBuy: true, multiplier: 0.5, reason: 'weak_buy' };
        }

        // Accumulate when RSI is high
        return { rsi, shouldBuy: false, multiplier: 0, reason: 'accumulating' };
    }
}

// ═══════════════════════════════════════════════════════════════════
// PUMPPORTAL CLIENT
// ═══════════════════════════════════════════════════════════════════

class PumpPortalClient {
    constructor(connection, wallet) {
        this.connection = connection;
        this.wallet = wallet;
    }

    /**
     * Retry with exponential backoff for network failures
     */
    async withRetry(fn, maxRetries = 4, baseDelay = 2000) {
        let lastError;
        for (let attempt = 0; attempt < maxRetries; attempt++) {
            try {
                return await fn();
            } catch (error) {
                lastError = error;
                const isRetryable = error.message?.includes('network') ||
                                    error.message?.includes('timeout') ||
                                    error.message?.includes('ECONNREFUSED') ||
                                    error.message?.includes('ETIMEDOUT') ||
                                    error.code === 'ENOTFOUND';

                if (!isRetryable || attempt === maxRetries - 1) {
                    throw error;
                }

                const delay = baseDelay * Math.pow(2, attempt);
                console.log(`[PUMP] Retry ${attempt + 1}/${maxRetries} in ${delay}ms...`);
                await new Promise(r => setTimeout(r, delay));
            }
        }
        throw lastError;
    }

    /**
     * Buy tokens via PumpPortal
     */
    async buyTokens(tokenMint, solAmount, slippageBps = 500) {
        console.log(`[PUMP] Buying with ${solAmount / LAMPORTS_PER_SOL} SOL...`);

        try {
            // Get quote first
            const quoteRes = await axios.get(`${CONFIG.PUMP_PORTAL_API}/quote`, {
                params: {
                    mint: tokenMint,
                    amount: solAmount,
                    side: 'buy',
                    slippage: slippageBps / 100,
                }
            });

            if (!quoteRes.data?.success) {
                throw new Error('Failed to get quote');
            }

            // Execute trade via PumpPortal transaction API
            const tradeRes = await axios.post(`${CONFIG.PUMP_PORTAL_API}/trade`, {
                publicKey: this.wallet.publicKey.toBase58(),
                action: 'buy',
                mint: tokenMint,
                amount: solAmount,
                denominatedInSol: true,
                slippage: slippageBps / 100,
                priorityFee: CONFIG.PRIORITY_FEE / 1000000,
            });

            if (tradeRes.data?.transaction) {
                // Sign and send the transaction
                const txBuffer = Buffer.from(tradeRes.data.transaction, 'base64');
                const tx = Transaction.from(txBuffer);
                tx.sign(this.wallet);

                const sig = await this.connection.sendRawTransaction(tx.serialize(), {
                    skipPreflight: false,
                    preflightCommitment: 'confirmed',
                });

                await this.connection.confirmTransaction(sig, 'confirmed');

                console.log(`[PUMP] Buy success! TX: ${sig}`);
                return {
                    success: true,
                    signature: sig,
                    solSpent: solAmount,
                    tokensReceived: quoteRes.data.expectedOutput,
                };
            }

            throw new Error('No transaction returned');

        } catch (error) {
            console.error(`[PUMP] Buy failed: ${error.message}`);
            return { success: false, error: error.message };
        }
    }

    /**
     * Sell tokens via PumpPortal
     */
    async sellTokens(tokenMint, tokenAmount, slippageBps = 500) {
        console.log(`[PUMP] Selling ${tokenAmount} tokens...`);

        try {
            const tradeRes = await axios.post(`${CONFIG.PUMP_PORTAL_API}/trade`, {
                publicKey: this.wallet.publicKey.toBase58(),
                action: 'sell',
                mint: tokenMint,
                amount: tokenAmount,
                denominatedInSol: false,
                slippage: slippageBps / 100,
                priorityFee: CONFIG.PRIORITY_FEE / 1000000,
            });

            if (tradeRes.data?.transaction) {
                const txBuffer = Buffer.from(tradeRes.data.transaction, 'base64');
                const tx = Transaction.from(txBuffer);
                tx.sign(this.wallet);

                const sig = await this.connection.sendRawTransaction(tx.serialize());
                await this.connection.confirmTransaction(sig, 'confirmed');

                console.log(`[PUMP] Sell success! TX: ${sig}`);
                return { success: true, signature: sig };
            }

            throw new Error('No transaction returned');

        } catch (error) {
            console.error(`[PUMP] Sell failed: ${error.message}`);
            return { success: false, error: error.message };
        }
    }

    /**
     * Get token price from Pump.fun
     */
    async getTokenPrice(tokenMint) {
        try {
            const res = await axios.get(`${CONFIG.PUMP_FUN_API}/coins/${tokenMint}`);
            if (res.data) {
                return {
                    priceUsd: res.data.usd_market_cap / res.data.total_supply,
                    priceSol: res.data.virtual_sol_reserves / res.data.virtual_token_reserves,
                    marketCap: res.data.usd_market_cap,
                    bondingCurve: res.data.bonding_curve,
                    complete: res.data.complete,
                };
            }
        } catch (e) {
            console.error(`[PUMP] Price fetch error: ${e.message}`);
        }
        return null;
    }

    /**
     * Claim creator fees from Pump.fun via PumpPortal
     * This claims accumulated creator fees for tokens created on pump.fun
     */
    async claimCreatorFees(tokenMint) {
        console.log(`[PUMP] Claiming creator fees for ${tokenMint.slice(0, 8)}...`);

        try {
            return await this.withRetry(async () => {
                // Get balance before claim
                const balanceBefore = await this.connection.getBalance(this.wallet.publicKey);

                // Request claim transaction from PumpPortal using trade-local endpoint
                // IMPORTANT: form-urlencoded + arraybuffer response
                const res = await axios.post(`${CONFIG.PUMP_PORTAL_API}/trade-local`,
                    new URLSearchParams({
                        publicKey: this.wallet.publicKey.toBase58(),
                        action: 'collectCreatorFee',
                        mint: tokenMint,
                        priorityFee: '0.000005',
                    }).toString(),
                    {
                        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                        timeout: 30000,
                        responseType: 'arraybuffer'
                    }
                );

                if (res.data && res.data.byteLength > 0) {
                    // Sign and send versioned transaction (trade-local returns raw binary v0 tx)
                    const tx = VersionedTransaction.deserialize(new Uint8Array(res.data));
                    tx.sign([this.wallet]);

                    const sig = await this.connection.sendRawTransaction(tx.serialize(), {
                        skipPreflight: true,
                        maxRetries: 3,
                    });
                    console.log(`[PUMP] Transaction sent: ${sig}`);

                    // Wait for confirmation with timeout
                    await Promise.race([
                        this.connection.confirmTransaction(sig, 'confirmed'),
                        new Promise((_, reject) => setTimeout(() => reject(new Error('Confirmation timeout')), 60000))
                    ]);

                    // Get transaction details to find actual fee paid (v0 tx support)
                    const txDetails = await this.connection.getTransaction(sig, {
                        commitment: 'confirmed',
                        maxSupportedTransactionVersion: 0
                    });
                    const txFee = txDetails?.meta?.fee || 5000; // Default to 5000 lamports

                    // Get balance after claim
                    const balanceAfter = await this.connection.getBalance(this.wallet.publicKey);
                    const balanceChange = balanceAfter - balanceBefore;

                    // FIX: Add tx fee back to get actual claimed amount
                    const claimed = balanceChange + txFee;

                    console.log(`[PUMP] Claimed ${claimed / LAMPORTS_PER_SOL} SOL! TX: ${sig}`);

                    return {
                        success: true,
                        signature: sig,
                        amountClaimed: Math.max(0, claimed),
                        txFee,
                        balanceBefore,
                        balanceAfter,
                    };
                }

                // No transaction = no fees to claim
                console.log(`[PUMP] No fees available to claim`);
                return { success: true, amountClaimed: 0, reason: 'no_fees_available' };
            });

        } catch (error) {
            // Handle "no fees" gracefully
            if (error.response?.status === 400 || error.message?.includes('no fees')) {
                console.log(`[PUMP] No creator fees to claim`);
                return { success: true, amountClaimed: 0, reason: 'no_fees_available' };
            }
            console.error(`[PUMP] Claim failed: ${error.message}`);
            return { success: false, error: error.message };
        }
    }
}

// ═══════════════════════════════════════════════════════════════════
// PUMPSWAP LP CLIENT
// ═══════════════════════════════════════════════════════════════════

class PumpSwapClient {
    constructor(connection, wallet) {
        this.connection = connection;
        this.wallet = wallet;
    }

    /**
     * Add liquidity to PumpSwap pool
     * Note: PumpSwap uses a different mechanism than traditional AMMs
     */
    async addLiquidity(tokenMint, solAmount, tokenAmount) {
        console.log(`[PUMPSWAP] Adding liquidity: ${solAmount / LAMPORTS_PER_SOL} SOL + ${tokenAmount} tokens`);

        try {
            // PumpSwap liquidity add via their API
            const res = await axios.post(`${CONFIG.PUMP_PORTAL_API}/liquidity/add`, {
                publicKey: this.wallet.publicKey.toBase58(),
                mint: tokenMint,
                solAmount: solAmount,
                tokenAmount: tokenAmount,
                priorityFee: CONFIG.PRIORITY_FEE / 1000000,
            });

            if (res.data?.transaction) {
                const txBuffer = Buffer.from(res.data.transaction, 'base64');
                const tx = Transaction.from(txBuffer);
                tx.sign(this.wallet);

                const sig = await this.connection.sendRawTransaction(tx.serialize());
                await this.connection.confirmTransaction(sig, 'confirmed');

                console.log(`[PUMPSWAP] LP added! TX: ${sig}`);
                return {
                    success: true,
                    signature: sig,
                    lpTokens: res.data.lpTokensReceived,
                    lpMint: res.data.lpMint,
                };
            }

            throw new Error('No transaction returned');

        } catch (error) {
            // Fallback: If PumpSwap LP not available, just buy tokens and burn
            console.log(`[PUMPSWAP] LP add not available, falling back to buy+burn`);
            return { success: false, fallback: true, error: error.message };
        }
    }

    /**
     * Burn LP tokens
     */
    async burnLPTokens(lpMint, amount) {
        console.log(`[PUMPSWAP] Burning ${amount} LP tokens...`);

        try {
            const lpMintPubkey = new PublicKey(lpMint);
            const lpATA = await getAssociatedTokenAddress(lpMintPubkey, this.wallet.publicKey);

            const burnIx = createBurnInstruction(
                lpATA,
                lpMintPubkey,
                this.wallet.publicKey,
                amount
            );

            const tx = new Transaction().add(
                ComputeBudgetProgram.setComputeUnitPrice({ microLamports: CONFIG.PRIORITY_FEE }),
                burnIx
            );

            const sig = await sendAndConfirmTransaction(this.connection, tx, [this.wallet]);

            console.log(`[PUMPSWAP] LP burned! TX: ${sig}`);
            return { success: true, signature: sig, amount };

        } catch (error) {
            console.error(`[PUMPSWAP] LP burn failed: ${error.message}`);
            return { success: false, error: error.message };
        }
    }
}

// ═══════════════════════════════════════════════════════════════════
// MAIN FEE DISTRIBUTOR
// ═══════════════════════════════════════════════════════════════════

class FeeDistributor {
    constructor(connection, tokenMint, feeWalletKeypair, options = {}) {
        this.connection = connection;
        this.tokenMint = new PublicKey(tokenMint);
        this.tokenMintStr = tokenMint;
        this.feeWallet = feeWalletKeypair;

        // Initialize components
        this.rsi = new RSICalculator(options.rsiPeriod || 14);
        this.pumpPortal = new PumpPortalClient(connection, feeWalletKeypair);
        this.pumpSwap = new PumpSwapClient(connection, feeWalletKeypair);

        // Accumulated fees (when operations fail or RSI says wait)
        this.accumulated = {
            burn: 0,
            buyback: 0,
            holderReward: 0,
            lpPool: 0,
        };

        // Stats
        this.stats = {
            totalClaimed: 0,
            totalDistributed: 0,
            totalBurned: 0,
            totalBuyback: 0,
            totalHolderRewards: 0,
            totalLPBurned: 0,
            claims: 0,
            distributions: 0,
        };

        console.log(`[FEE] Distributor initialized for ${tokenMint.slice(0, 8)}...`);
    }

    /**
     * Update price for RSI calculation
     */
    async updatePrice(price = null) {
        if (price) {
            this.rsi.addPrice(price);
            return;
        }

        // Auto-fetch from Pump.fun
        const priceData = await this.pumpPortal.getTokenPrice(this.tokenMintStr);
        if (priceData?.priceSol) {
            this.rsi.addPrice(priceData.priceSol);
        }
    }

    /**
     * Calculate fee split
     */
    calculateSplit(totalFee) {
        const burn = Math.floor(totalFee * 0.25);
        const buyback = Math.floor(totalFee * 0.25);
        const holder = Math.floor(totalFee * 0.25);
        const lp = totalFee - burn - buyback - holder; // Remainder to avoid rounding loss

        return { burn, buyback, holderReward: holder, lpPool: lp, total: totalFee };
    }

    /**
     * MAIN: Distribute collected fees
     */
    async distributeFees(totalFeeLamports) {
        if (totalFeeLamports < CONFIG.MIN_FEE_THRESHOLD_LAMPORTS) {
            console.log(`[FEE] Below threshold (${totalFeeLamports}), skipping...`);
            return { success: false, reason: 'below_threshold' };
        }

        const split = this.calculateSplit(totalFeeLamports);

        console.log('\n' + '═'.repeat(50));
        console.log('FEE DISTRIBUTION');
        console.log('═'.repeat(50));
        console.log(`Total: ${totalFeeLamports / LAMPORTS_PER_SOL} SOL`);
        console.log(`🔥 Burn: ${split.burn / LAMPORTS_PER_SOL} SOL (25%)`);
        console.log(`📈 Buyback: ${split.buyback / LAMPORTS_PER_SOL} SOL (25%)`);
        console.log(`🎲 Holder: ${split.holderReward / LAMPORTS_PER_SOL} SOL (25%)`);
        console.log(`💧 LP+Burn: ${split.lpPool / LAMPORTS_PER_SOL} SOL (25%)`);
        console.log('═'.repeat(50));

        const results = {
            timestamp: Date.now(),
            split,
            burn: null,
            buyback: null,
            holderReward: null,
            lpPool: null,
        };

        // Execute all four fee operations
        results.burn = await this.executeBurn(split.burn);
        results.buyback = await this.executeRSIBuyback(split.buyback);
        results.holderReward = await this.distributeToRandomHolder(split.holderReward);
        results.lpPool = await this.addToLPAndBurn(split.lpPool);

        // Update stats
        this.stats.totalDistributed += totalFeeLamports;
        this.stats.distributions++;

        console.log('\n[FEE] Distribution complete!\n');
        return { success: true, results };
    }

    // ═══════════════════════════════════════════════════════════════
    // 1. BURN (25%)
    // ═══════════════════════════════════════════════════════════════

    async executeBurn(amountLamports) {
        const total = amountLamports + this.accumulated.burn;
        if (total <= 0) return { success: false, reason: 'no_amount' };

        console.log(`\n🔥 BURN: ${total / LAMPORTS_PER_SOL} SOL worth of tokens`);

        try {
            // First buy tokens with the SOL
            const buyResult = await this.pumpPortal.buyTokens(
                this.tokenMintStr,
                total,
                CONFIG.SLIPPAGE_BPS
            );

            if (!buyResult.success) {
                this.accumulated.burn += amountLamports;
                return { success: false, error: buyResult.error, accumulated: this.accumulated.burn };
            }

            // Now burn the tokens we just bought
            const feeATA = await getAssociatedTokenAddress(this.tokenMint, this.feeWallet.publicKey);
            const ataInfo = await getAccount(this.connection, feeATA);
            const tokensToBurn = ataInfo.amount;

            const burnIx = createBurnInstruction(
                feeATA,
                this.tokenMint,
                this.feeWallet.publicKey,
                tokensToBurn
            );

            const tx = new Transaction().add(
                ComputeBudgetProgram.setComputeUnitPrice({ microLamports: CONFIG.PRIORITY_FEE }),
                burnIx
            );

            const sig = await sendAndConfirmTransaction(this.connection, tx, [this.feeWallet]);

            console.log(`🔥 Burned ${tokensToBurn} tokens! TX: ${sig}`);

            this.accumulated.burn = 0;
            this.stats.totalBurned += Number(tokensToBurn);

            return {
                success: true,
                solSpent: total,
                tokensBurned: Number(tokensToBurn),
                buySignature: buyResult.signature,
                burnSignature: sig,
            };

        } catch (error) {
            console.error(`🔥 Burn failed: ${error.message}`);
            this.accumulated.burn += amountLamports;
            return { success: false, error: error.message };
        }
    }

    // ═══════════════════════════════════════════════════════════════
    // 2. RSI BUYBACK (25%)
    // ═══════════════════════════════════════════════════════════════

    async executeRSIBuyback(amountLamports) {
        const rsiData = this.rsi.shouldBuyback();

        console.log(`\n📈 BUYBACK: RSI=${rsiData.rsi} | ${rsiData.reason}`);
        console.log(`   Multiplier: ${rsiData.multiplier}x | Should buy: ${rsiData.shouldBuy}`);

        // If RSI says don't buy, accumulate
        if (!rsiData.shouldBuy) {
            this.accumulated.buyback += amountLamports;
            console.log(`   Accumulating: ${this.accumulated.buyback / LAMPORTS_PER_SOL} SOL`);
            return {
                success: true,
                action: 'accumulated',
                rsi: rsiData.rsi,
                accumulated: this.accumulated.buyback,
            };
        }

        // Calculate buy amount with multiplier
        const baseAmount = amountLamports + this.accumulated.buyback;
        const buyAmount = Math.floor(baseAmount * rsiData.multiplier);

        if (buyAmount <= 0) {
            return { success: false, reason: 'no_amount' };
        }

        console.log(`   Executing buyback: ${buyAmount / LAMPORTS_PER_SOL} SOL`);

        try {
            const buyResult = await this.pumpPortal.buyTokens(
                this.tokenMintStr,
                buyAmount,
                CONFIG.SLIPPAGE_BPS
            );

            if (buyResult.success) {
                this.accumulated.buyback = 0;
                this.stats.totalBuyback += buyAmount;

                return {
                    success: true,
                    action: 'executed',
                    rsi: rsiData.rsi,
                    multiplier: rsiData.multiplier,
                    solSpent: buyAmount,
                    tokensReceived: buyResult.tokensReceived,
                    signature: buyResult.signature,
                };
            }

            // Failed - accumulate for later
            this.accumulated.buyback += amountLamports;
            return { success: false, error: buyResult.error };

        } catch (error) {
            this.accumulated.buyback += amountLamports;
            return { success: false, error: error.message };
        }
    }

    // ═══════════════════════════════════════════════════════════════
    // 3. RANDOM HOLDER DISTRIBUTION (25%)
    // ═══════════════════════════════════════════════════════════════

    async distributeToRandomHolder(amountLamports) {
        const total = amountLamports + this.accumulated.holderReward;
        if (total <= 0) return { success: false, reason: 'no_amount' };

        console.log(`\n🎲 HOLDER REWARD: ${total / LAMPORTS_PER_SOL} SOL`);

        try {
            // Get all token holders
            const holders = await this.getTokenHolders();

            if (holders.length < CONFIG.MIN_HOLDERS_FOR_DISTRIBUTION) {
                console.log(`   Only ${holders.length} holders, need ${CONFIG.MIN_HOLDERS_FOR_DISTRIBUTION}`);
                this.accumulated.holderReward += amountLamports;
                return { success: false, reason: 'insufficient_holders' };
            }

            // Select random holder (weighted by balance)
            const winner = this.selectWeightedRandom(holders);
            console.log(`   🎯 Winner: ${winner.address.slice(0, 8)}... (${winner.balance} tokens)`);

            // First buy tokens with the SOL
            const buyResult = await this.pumpPortal.buyTokens(
                this.tokenMintStr,
                total,
                CONFIG.SLIPPAGE_BPS
            );

            if (!buyResult.success) {
                this.accumulated.holderReward += amountLamports;
                return { success: false, error: buyResult.error };
            }

            // Transfer tokens to winner
            const transferResult = await this.transferTokensToHolder(
                winner.address,
                buyResult.tokensReceived
            );

            if (transferResult.success) {
                this.accumulated.holderReward = 0;
                this.stats.totalHolderRewards += total;

                console.log(`   ✅ Sent ${buyResult.tokensReceived} tokens to ${winner.address.slice(0, 8)}...`);
                return {
                    success: true,
                    winner: winner.address,
                    solSpent: total,
                    tokensRewarded: buyResult.tokensReceived,
                    buySignature: buyResult.signature,
                    transferSignature: transferResult.signature,
                };
            }

            return { success: false, error: transferResult.error };

        } catch (error) {
            console.error(`   Failed: ${error.message}`);
            this.accumulated.holderReward += amountLamports;
            return { success: false, error: error.message };
        }
    }

    // ═══════════════════════════════════════════════════════════════
    // 4. LP POOL + AUTO BURN (25%)
    // ═══════════════════════════════════════════════════════════════

    async addToLPAndBurn(amountLamports) {
        const total = amountLamports + this.accumulated.lpPool;
        if (total <= 0) return { success: false, reason: 'no_amount' };

        console.log(`\n💧 LP + BURN: ${total / LAMPORTS_PER_SOL} SOL`);

        try {
            // Split: half for SOL side, half to buy tokens for token side
            const solForLP = Math.floor(total / 2);
            const solForTokens = total - solForLP;

            // Buy tokens for the token side of LP
            const buyResult = await this.pumpPortal.buyTokens(
                this.tokenMintStr,
                solForTokens,
                CONFIG.SLIPPAGE_BPS
            );

            if (!buyResult.success) {
                this.accumulated.lpPool += amountLamports;
                return { success: false, error: buyResult.error };
            }

            // Try to add liquidity
            const lpResult = await this.pumpSwap.addLiquidity(
                this.tokenMintStr,
                solForLP,
                buyResult.tokensReceived
            );

            if (lpResult.success) {
                // Burn the LP tokens
                const burnResult = await this.pumpSwap.burnLPTokens(
                    lpResult.lpMint,
                    lpResult.lpTokens
                );

                this.accumulated.lpPool = 0;
                this.stats.totalLPBurned += lpResult.lpTokens;

                console.log(`   ✅ Added LP and burned ${lpResult.lpTokens} LP tokens`);
                return {
                    success: true,
                    solAdded: solForLP,
                    tokensAdded: buyResult.tokensReceived,
                    lpTokensBurned: lpResult.lpTokens,
                    addLPSignature: lpResult.signature,
                    burnLPSignature: burnResult.signature,
                };
            }

            // Fallback: If LP add fails, just burn the tokens we bought
            if (lpResult.fallback) {
                console.log(`   LP not available, burning tokens instead...`);

                const feeATA = await getAssociatedTokenAddress(this.tokenMint, this.feeWallet.publicKey);
                const ataInfo = await getAccount(this.connection, feeATA);

                const burnIx = createBurnInstruction(
                    feeATA,
                    this.tokenMint,
                    this.feeWallet.publicKey,
                    ataInfo.amount
                );

                const tx = new Transaction().add(
                    ComputeBudgetProgram.setComputeUnitPrice({ microLamports: CONFIG.PRIORITY_FEE }),
                    burnIx
                );

                const sig = await sendAndConfirmTransaction(this.connection, tx, [this.feeWallet]);

                this.accumulated.lpPool = 0;
                this.stats.totalBurned += Number(ataInfo.amount);

                console.log(`   ✅ Fallback: Burned ${ataInfo.amount} tokens`);
                return {
                    success: true,
                    fallback: true,
                    solSpent: total,
                    tokensBurned: Number(ataInfo.amount),
                    signature: sig,
                };
            }

            return { success: false, error: lpResult.error };

        } catch (error) {
            console.error(`   Failed: ${error.message}`);
            this.accumulated.lpPool += amountLamports;
            return { success: false, error: error.message };
        }
    }

    // ═══════════════════════════════════════════════════════════════
    // HELPER METHODS
    // ═══════════════════════════════════════════════════════════════

    /**
     * Get all token holders
     */
    async getTokenHolders() {
        try {
            const accounts = await this.connection.getProgramAccounts(TOKEN_PROGRAM_ID, {
                filters: [
                    { dataSize: 165 },
                    { memcmp: { offset: 0, bytes: this.tokenMint.toBase58() } },
                ],
            });

            const holders = [];

            for (const { account } of accounts) {
                // SPL Token Account layout:
                // 0-32: mint
                // 32-64: owner
                // 64-72: amount (u64)
                const owner = new PublicKey(account.data.slice(32, 64));
                const amount = account.data.readBigUInt64LE(64);

                // Exclude zero balances and our own wallet
                if (amount > 0n && owner.toBase58() !== this.feeWallet.publicKey.toBase58()) {
                    holders.push({
                        address: owner.toBase58(),
                        balance: Number(amount),
                    });
                }
            }

            console.log(`   Found ${holders.length} eligible holders`);
            return holders;

        } catch (error) {
            console.error(`   Error getting holders: ${error.message}`);
            return [];
        }
    }

    /**
     * Select random holder weighted by balance
     */
    selectWeightedRandom(holders) {
        const totalBalance = holders.reduce((sum, h) => sum + h.balance, 0);
        let random = Math.random() * totalBalance;

        for (const holder of holders) {
            random -= holder.balance;
            if (random <= 0) {
                return holder;
            }
        }

        return holders[holders.length - 1];
    }

    /**
     * Transfer tokens to a holder
     */
    async transferTokensToHolder(toAddress, amount) {
        try {
            const fromATA = await getAssociatedTokenAddress(
                this.tokenMint,
                this.feeWallet.publicKey
            );

            const toPublicKey = new PublicKey(toAddress);
            const toATA = await getOrCreateAssociatedTokenAccount(
                this.connection,
                this.feeWallet,
                this.tokenMint,
                toPublicKey
            );

            const transferIx = createTransferInstruction(
                fromATA,
                toATA.address,
                this.feeWallet.publicKey,
                amount
            );

            const tx = new Transaction().add(
                ComputeBudgetProgram.setComputeUnitPrice({ microLamports: CONFIG.PRIORITY_FEE }),
                transferIx
            );

            const sig = await sendAndConfirmTransaction(this.connection, tx, [this.feeWallet]);

            return { success: true, signature: sig };

        } catch (error) {
            return { success: false, error: error.message };
        }
    }

    /**
     * Get current status
     */
    getStatus() {
        return {
            rsi: this.rsi.calculate(),
            rsiAction: this.rsi.shouldBuyback(),
            accumulated: { ...this.accumulated },
            stats: { ...this.stats },
        };
    }

    /**
     * Force flush accumulated fees
     */
    async flushAccumulated() {
        const total =
            this.accumulated.burn +
            this.accumulated.buyback +
            this.accumulated.holderReward +
            this.accumulated.lpPool;

        if (total > 0) {
            console.log(`[FEE] Flushing ${total / LAMPORTS_PER_SOL} SOL accumulated fees...`);
            return await this.distributeFees(total);
        }

        return { success: false, reason: 'nothing_accumulated' };
    }

    /**
     * AUTO-CLAIM AND DISTRIBUTE
     * Claims creator fees from Pump.fun, then distributes them 25/25/25/25
     */
    async claimAndDistribute() {
        console.log('\n' + '═'.repeat(50));
        console.log('AUTO-CLAIM + DISTRIBUTE');
        console.log('═'.repeat(50));

        // Step 1: Claim creator fees
        const claimResult = await this.pumpPortal.claimCreatorFees(this.tokenMintStr);

        if (!claimResult.success) {
            console.log(`[FEE] Claim failed: ${claimResult.error}`);
            return { success: false, reason: 'claim_failed', error: claimResult.error };
        }

        const claimed = claimResult.amountClaimed || 0;

        if (claimed <= 0) {
            console.log(`[FEE] No fees claimed, nothing to distribute`);
            return { success: true, claimed: 0, reason: 'no_fees_to_claim' };
        }

        // Update stats
        this.stats.totalClaimed += claimed;
        this.stats.claims++;

        console.log(`\n💰 Claimed: ${claimed / LAMPORTS_PER_SOL} SOL`);
        console.log(`   TX: ${claimResult.signature}`);

        // Step 2: Distribute the claimed fees
        // Reserve a small amount for transaction fees (0.005 SOL)
        const reserveForTxFees = 5000000; // 0.005 SOL in lamports
        const toDistribute = Math.max(0, claimed - reserveForTxFees);

        if (toDistribute < CONFIG.MIN_FEE_THRESHOLD_LAMPORTS) {
            console.log(`[FEE] Claimed amount too small to distribute after reserves`);
            return {
                success: true,
                claimed,
                distributed: 0,
                reason: 'below_threshold_after_reserves',
                claimSignature: claimResult.signature,
            };
        }

        // Distribute
        const distributeResult = await this.distributeFees(toDistribute);

        return {
            success: true,
            claimed,
            distributed: toDistribute,
            claimSignature: claimResult.signature,
            distribution: distributeResult,
        };
    }

    /**
     * Start auto-claim loop
     * Runs every intervalMs, claims fees and distributes them
     */
    startAutoClaimLoop(intervalMs = 10 * 60 * 1000) {
        console.log(`\n🤖 Starting auto-claim loop (every ${intervalMs / 60000} minutes)`);
        console.log(`   Token: ${this.tokenMintStr.slice(0, 8)}...`);
        console.log(`   Wallet: ${this.feeWallet.publicKey.toBase58().slice(0, 8)}...`);
        console.log(`   Press Ctrl+C to stop\n`);

        // Run immediately
        this.claimAndDistribute().catch(e => console.error(`[FEE] Error: ${e.message}`));

        // Then run on interval
        this.autoClaimInterval = setInterval(async () => {
            try {
                await this.updatePrice(); // Update RSI
                await this.claimAndDistribute();
            } catch (e) {
                console.error(`[FEE] Auto-claim error: ${e.message}`);
            }
        }, intervalMs);

        return this.autoClaimInterval;
    }

    /**
     * Stop auto-claim loop
     */
    stopAutoClaimLoop() {
        if (this.autoClaimInterval) {
            clearInterval(this.autoClaimInterval);
            this.autoClaimInterval = null;
            console.log(`\n⏹️  Auto-claim loop stopped`);
        }
    }
}

// ═══════════════════════════════════════════════════════════════════
// EXPORTS
// ═══════════════════════════════════════════════════════════════════

module.exports = {
    FeeDistributor,
    RSICalculator,
    PumpPortalClient,
    PumpSwapClient,
    CONFIG,
};
