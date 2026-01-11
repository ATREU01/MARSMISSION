/**
 * ON-CHAIN STATS SERVICE
 *
 * Fetches REAL stats from the Solana blockchain via Helius API.
 * No more internal state that resets - this is THE TRUTH from the chain.
 *
 * For each token using TEK:
 * - Total Claimed: SOL claimed from Pump.fun creator fees
 * - Total Distributed: SOL distributed via burn/buyback/holder/LP
 * - Holder Pool: 1% sent to LAUNCHR_OPS_WALLET
 * - Pending: SOL sitting in fee wallet waiting to distribute
 */

const { Connection, PublicKey, LAMPORTS_PER_SOL } = require('@solana/web3.js');
const axios = require('axios');

// ═══════════════════════════════════════════════════════════════════
// CONFIGURATION
// ═══════════════════════════════════════════════════════════════════

const CONFIG = {
    HELIUS_API_KEY: process.env.HELIUS_API_KEY || '',
    HELIUS_RPC: process.env.HELIUS_RPC || 'https://mainnet.helius-rpc.com',
    HELIUS_API: 'https://api.helius.xyz/v0',

    // Pump.fun program IDs for identifying transactions
    PUMP_PROGRAM_ID: '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P',
    PUMPSWAP_PROGRAM_ID: 'pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA',

    // LAUNCHR ops wallet - receives 1% of all fees AND claims LAUNCHR token fees
    LAUNCHR_OPS_WALLET: process.env.LAUNCHR_OPS_WALLET || 'GAnPTu7xSfb9CdVsfYZw84hoHeeibJN4NJounbnrq9U7',

    // LAUNCHR token mint
    LAUNCHR_TOKEN_MINT: process.env.LAUNCHR_TOKEN_MINT || '86ZnAujEVLmtnNazeCeT1zYR7hn2PeF5ZPEwUkTdpump',

    // Cache TTL
    CACHE_TTL_MS: 30000, // 30 seconds
};

// ═══════════════════════════════════════════════════════════════════
// ON-CHAIN STATS SERVICE
// ═══════════════════════════════════════════════════════════════════

class OnChainStats {
    constructor() {
        // Use HELIUS_RPC directly - it should already be the full URL with API key
        // Format: https://mainnet.helius-rpc.com/?api-key=YOUR_KEY
        this.rpcUrl = process.env.HELIUS_RPC || CONFIG.HELIUS_RPC;

        // If HELIUS_RPC doesn't have api-key and we have HELIUS_API_KEY, construct it
        if (!this.rpcUrl.includes('api-key') && CONFIG.HELIUS_API_KEY) {
            this.rpcUrl = `https://mainnet.helius-rpc.com/?api-key=${CONFIG.HELIUS_API_KEY}`;
        }

        this.connection = new Connection(this.rpcUrl, 'confirmed');
        this.cache = new Map();

        console.log(`[ONCHAIN-STATS] Initialized with RPC: ${this.rpcUrl.replace(/api-key=[^&]+/, 'api-key=REDACTED')}`);
    }

    /**
     * FAST: Get just the fee wallet balance (pending amount)
     * This is very quick - single RPC call
     */
    async getBalanceOnly(feeWalletAddress) {
        if (!feeWalletAddress) return 0;
        try {
            const balance = await this.connection.getBalance(new PublicKey(feeWalletAddress));
            return balance;
        } catch (e) {
            console.error(`[ONCHAIN-STATS] getBalanceOnly error: ${e.message}`);
            return 0;
        }
    }

    /**
     * FAST: Get stats with timeout - returns cached/empty if fetch takes too long
     * @param timeoutMs - max time to wait (default 8 seconds)
     */
    async getTokenStatsWithTimeout(tokenMint, feeWalletAddress, timeoutMs = 8000) {
        const cacheKey = `stats:${tokenMint}:${feeWalletAddress}`;
        const cached = this.getFromCache(cacheKey);
        if (cached) {
            console.log(`[ONCHAIN-STATS] Returning cached stats for ${feeWalletAddress?.slice(0, 8)}`);
            return cached;
        }

        // Check if we have cached RPC totals (the expensive part)
        const rpcCacheKey = `rpc_totals:${feeWalletAddress}`;
        const cachedRPCTotals = this.cache.get(rpcCacheKey);
        if (cachedRPCTotals && Date.now() - cachedRPCTotals.timestamp < 1800000) {
            // We have cached RPC totals, so full fetch will be fast
            console.log(`[ONCHAIN-STATS] Have cached RPC totals, doing full fetch`);
            return this.getTokenStats(tokenMint, feeWalletAddress);
        }

        // No cached RPC totals - this will be slow, use timeout
        console.log(`[ONCHAIN-STATS] No cached totals, using ${timeoutMs}ms timeout for ${feeWalletAddress?.slice(0, 8)}`);

        try {
            const stats = await Promise.race([
                this.fetchOnChainStats(tokenMint, feeWalletAddress),
                new Promise((_, reject) =>
                    setTimeout(() => reject(new Error('Timeout')), timeoutMs)
                )
            ]);
            this.setCache(cacheKey, stats);
            return stats;
        } catch (e) {
            if (e.message === 'Timeout') {
                console.log(`[ONCHAIN-STATS] Fetch timed out, trying GMGN fallback`);

                // Try GMGN as faster fallback
                try {
                    const gmgnStats = await this.fetchGMGNStats(tokenMint, feeWalletAddress);
                    if (gmgnStats && gmgnStats.totalDistributed > 0) {
                        console.log(`[ONCHAIN-STATS] Got GMGN stats: ${gmgnStats.totalDistributedSOL.toFixed(4)} SOL distributed`);
                        return { ...gmgnStats, _timedOut: true, _source: 'gmgn' };
                    }
                } catch (gmgnErr) {
                    console.log(`[ONCHAIN-STATS] GMGN fallback failed: ${gmgnErr.message}`);
                }

                // Final fallback: just the balance
                const balance = await this.getBalanceOnly(feeWalletAddress);
                return {
                    ...this.getEmptyStats(),
                    pending: balance,
                    pendingSOL: balance / LAMPORTS_PER_SOL,
                    _timedOut: true,
                    _source: 'balance-only',
                };
            }
            throw e;
        }
    }

    /**
     * Get stats for a specific token's TEK usage
     * Uses pre/post balance method for ACCURATE totals (doesn't rely on token filter)
     * This is THE TRUTH - balance changes on chain don't lie
     */
    async getTokenStats(tokenMint, feeWalletAddress) {
        const cacheKey = `stats:${tokenMint}:${feeWalletAddress}`;
        const cached = this.getFromCache(cacheKey);
        if (cached) return cached;

        console.log(`[ONCHAIN-STATS] Fetching REAL on-chain stats for ${feeWalletAddress?.slice(0, 8)}...`);

        // Use the full on-chain fetch which uses pre/post balances for accuracy
        const stats = await this.fetchOnChainStats(tokenMint, feeWalletAddress);

        this.setCache(cacheKey, stats);
        return stats;
    }

    /**
     * Get ALL transactions for a specific TOKEN using Helius getTransactionsForAddress RPC
     * Optimized with reasonable limits to prevent crashes
     */
    async getTokenTransactions(walletAddress, tokenMint) {
        let totalBought = 0;
        let burnAmount = 0;
        let swapAmount = 0;
        let lpAmount = 0;
        let txCount = 0;

        // Check cache first (cache for 10 minutes)
        const cacheKey = `token_txs:${walletAddress}:${tokenMint}`;
        const cached = this.cache.get(cacheKey);
        if (cached && Date.now() - cached.timestamp < 600000) {
            console.log(`[ONCHAIN-STATS] Using cached token transactions`);
            return cached.data;
        }

        try {
            console.log(`[ONCHAIN-STATS] Fetching token transactions for ${walletAddress.slice(0, 8)}, token ${tokenMint.slice(0, 8)}...`);

            let paginationToken = null;
            let pages = 0;
            let totalFetched = 0;
            const MAX_PAGES = 500; // Reasonable limit: 50k transactions max

            // Use Helius getTransactionsForAddress RPC method
            while (pages < MAX_PAGES) {
                const params = {
                    transactionDetails: 'full',
                    encoding: 'jsonParsed',
                    maxSupportedTransactionVersion: 0,
                    limit: 100,
                    filters: { status: 'succeeded' }
                };

                if (paginationToken) {
                    params.paginationToken = paginationToken;
                }

                const response = await axios.post(this.rpcUrl, {
                    jsonrpc: '2.0',
                    id: `tx-${pages}`,
                    method: 'getTransactionsForAddress',
                    params: [walletAddress, params]
                }, { timeout: 30000 });

                if (!response.data?.result?.data || response.data.result.data.length === 0) {
                    break;
                }

                const txs = response.data.result.data;
                totalFetched += txs.length;

                // Process transactions involving our token
                for (const txData of txs) {
                    const tx = txData.transaction;
                    const meta = txData.meta;
                    if (!tx || !meta) continue;

                    // Check if tx involves our token
                    const involvesToken = meta.postTokenBalances?.some(tb => tb.mint === tokenMint) ||
                                         meta.preTokenBalances?.some(tb => tb.mint === tokenMint);

                    if (involvesToken) {
                        // Get wallet's SOL balance change
                        const accountKeys = tx.message?.accountKeys || [];
                        const walletIndex = accountKeys.findIndex(k =>
                            (typeof k === 'string' ? k : k.pubkey) === walletAddress
                        );

                        if (walletIndex !== -1 && meta.preBalances && meta.postBalances) {
                            const preBalance = meta.preBalances[walletIndex];
                            const postBalance = meta.postBalances[walletIndex];
                            const balanceChange = postBalance - preBalance;

                            // SOL spent = negative balance change (exclude tx fee)
                            if (balanceChange < 0) {
                                // Don't subtract fee - it's already in the balance change
                                const solSpent = Math.abs(balanceChange) / LAMPORTS_PER_SOL;

                                if (solSpent > 0.0001) { // Ignore dust
                                    totalBought += solSpent;
                                    txCount++;

                                    // Simple categorization
                                    const logStr = (meta.logMessages || []).join(' ').toLowerCase();
                                    if (logStr.includes('burn')) {
                                        burnAmount += solSpent;
                                    } else if (logStr.includes('liquidity')) {
                                        lpAmount += solSpent;
                                    } else {
                                        swapAmount += solSpent;
                                    }
                                }
                            }
                        }
                    }
                }

                pages++;
                paginationToken = response.data.result.paginationToken;

                // Progress logging
                if (pages % 50 === 0) {
                    console.log(`[ONCHAIN-STATS] Page ${pages}: ${totalFetched} txs, ${txCount} buys = ${totalBought.toFixed(2)} SOL`);
                }

                if (!paginationToken) break;
                await new Promise(r => setTimeout(r, 25)); // Small delay
            }

            console.log(`[ONCHAIN-STATS] Done: ${totalFetched} txs scanned, ${txCount} token buys = ${totalBought.toFixed(4)} SOL`);

        } catch (e) {
            console.error(`[ONCHAIN-STATS] Error: ${e.message}`);
        }

        const result = { totalBought, burnAmount, swapAmount, lpAmount, txCount };

        // Cache for 10 minutes
        this.cache.set(cacheKey, { data: result, timestamp: Date.now() });

        return result;
    }

    /**
     * Fetch token stats from GMGN API
     * GMGN has accurate per-token holder activity data
     */
    async fetchGMGNStats(tokenMint, feeWalletAddress) {
        if (!feeWalletAddress) return null;

        try {
            // GMGN API for wallet's activity on specific token
            const url = `https://gmgn.ai/defi/quotation/v1/wallet_activity/sol/${feeWalletAddress}?type=buy&type=sell&token=${tokenMint}&limit=100`;
            console.log(`[ONCHAIN-STATS] Fetching GMGN data for ${feeWalletAddress.slice(0, 8)}...`);

            const response = await axios.get(url, {
                timeout: 15000,
                headers: {
                    'User-Agent': 'Mozilla/5.0 (compatible; LAUNCHR/1.0)',
                    'Accept': 'application/json'
                }
            });

            if (!response.data || !response.data.data) {
                console.log(`[ONCHAIN-STATS] GMGN returned no data`);
                return null;
            }

            const activities = response.data.data.activities || response.data.data || [];
            console.log(`[ONCHAIN-STATS] GMGN returned ${activities.length} activities`);

            const stats = this.getEmptyStats();
            let totalBought = 0;
            let totalSold = 0;

            for (const activity of activities) {
                const solAmount = parseFloat(activity.sol_amount || activity.quote_amount || 0);
                if (activity.event_type === 'buy' || activity.type === 'buy') {
                    totalBought += solAmount;
                } else if (activity.event_type === 'sell' || activity.type === 'sell') {
                    totalSold += solAmount;
                }
            }

            // Total distributed = what was spent buying tokens (for burns, buybacks, etc)
            stats.totalDistributed = Math.round(totalBought * LAMPORTS_PER_SOL);
            stats.totalDistributedSOL = totalBought;

            // Get current balance
            try {
                const balance = await this.connection.getBalance(new PublicKey(feeWalletAddress));
                stats.pending = balance;
                stats.pendingSOL = balance / LAMPORTS_PER_SOL;
            } catch (e) {
                console.log(`[ONCHAIN-STATS] Could not get balance: ${e.message}`);
            }

            // Estimate breakdown based on typical allocations (25% each)
            // This is approximate - persisted stats are more accurate for breakdown
            const distributed = stats.totalDistributed;
            stats.totalBurned = Math.round(distributed * 0.30); // ~30% to burns
            stats.totalBuyback = Math.round(distributed * 0.30); // ~30% to buyback
            stats.totalLiquidity = Math.round(distributed * 0.25); // ~25% to LP
            // Remaining ~15% to creator revenue (not shown)

            stats.totalBurnedSOL = stats.totalBurned / LAMPORTS_PER_SOL;
            stats.totalBuybackSOL = stats.totalBuyback / LAMPORTS_PER_SOL;
            stats.totalLiquiditySOL = stats.totalLiquidity / LAMPORTS_PER_SOL;

            console.log(`[ONCHAIN-STATS] GMGN stats: Bought=${totalBought.toFixed(4)} SOL, Sold=${totalSold.toFixed(4)} SOL`);

            return stats;

        } catch (e) {
            console.error(`[ONCHAIN-STATS] GMGN fetch error: ${e.message}`);
            return null;
        }
    }

    /**
     * Fetch real on-chain statistics using Helius parsed transaction API
     * COMBINED APPROACH: Use parsed API for categorization, RPC for accurate totals
     */
    async fetchOnChainStats(tokenMint, feeWalletAddress) {
        if (!feeWalletAddress) {
            return this.getEmptyStats();
        }

        console.log(`[ONCHAIN-STATS] Fetching FULL on-chain data for ${feeWalletAddress}...`);

        const stats = this.getEmptyStats();

        try {
            // STEP 1: Get accurate totals from RPC (pre/post balance method)
            // This is the SOURCE OF TRUTH for total claimed/distributed
            const rpcTotals = await this.getRPCTotals(feeWalletAddress);
            stats.totalClaimed = rpcTotals.totalIn;
            stats.totalDistributed = rpcTotals.totalOut;
            stats.claimCount = rpcTotals.inCount;
            stats.distributeCount = rpcTotals.outCount;

            console.log(`[ONCHAIN-STATS] RPC TOTALS: In=${(rpcTotals.totalIn / LAMPORTS_PER_SOL).toFixed(4)} SOL, Out=${(rpcTotals.totalOut / LAMPORTS_PER_SOL).toFixed(4)} SOL`);

            // STEP 2: Get categorization from Helius parsed API (better for tx types)
            const transactions = await this.getHeliusParsedTransactions(feeWalletAddress);
            console.log(`[ONCHAIN-STATS] Found ${transactions.length} parsed transactions for categorization`);

            if (transactions.length > 0) {
                // Categorize distributions based on parsed transaction types
                const BURN_ADDRESS = '1nc1nerator11111111111111111111111111111111';
                const PUMP_PROGRAMS = ['6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P', 'pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA'];

                let burnAmount = 0, buybackAmount = 0, liquidityAmount = 0;

                for (const tx of transactions) {
                    // Look for outgoing SOL (distributions)
                    if (tx.nativeTransfers) {
                        for (const transfer of tx.nativeTransfers) {
                            if (transfer.fromUserAccount === feeWalletAddress && transfer.amount > 0) {
                                const category = this.categorizeTransaction(tx, transfer, BURN_ADDRESS, PUMP_PROGRAMS);
                                if (category === 'burn') {
                                    burnAmount += transfer.amount;
                                    stats.burnCount++;
                                } else if (category === 'buyback') {
                                    buybackAmount += transfer.amount;
                                    stats.buybackCount++;
                                } else if (category === 'liquidity') {
                                    liquidityAmount += transfer.amount;
                                    stats.liquidityCount++;
                                }
                            }
                        }
                    }
                }

                // Use categorized amounts if we have them
                const categorizedTotal = burnAmount + buybackAmount + liquidityAmount;
                if (categorizedTotal > 0) {
                    // Scale categories proportionally to match actual distributed total
                    const scale = stats.totalDistributed / categorizedTotal;
                    stats.totalBurned = Math.round(burnAmount * scale);
                    stats.totalBuyback = Math.round(buybackAmount * scale);
                    stats.totalLiquidity = Math.round(liquidityAmount * scale);
                    console.log(`[ONCHAIN-STATS] Categorized: Burn=${(stats.totalBurned / LAMPORTS_PER_SOL).toFixed(4)}, Buyback=${(stats.totalBuyback / LAMPORTS_PER_SOL).toFixed(4)}, LP=${(stats.totalLiquidity / LAMPORTS_PER_SOL).toFixed(4)}`);
                }
            }

            // Get current balance (pending)
            const balance = await this.connection.getBalance(new PublicKey(feeWalletAddress));
            stats.pending = balance;
            stats.pendingSOL = balance / LAMPORTS_PER_SOL;

            // Convert to SOL
            stats.totalClaimedSOL = stats.totalClaimed / LAMPORTS_PER_SOL;
            stats.totalDistributedSOL = stats.totalDistributed / LAMPORTS_PER_SOL;
            stats.totalBurnedSOL = stats.totalBurned / LAMPORTS_PER_SOL;
            stats.totalBuybackSOL = stats.totalBuyback / LAMPORTS_PER_SOL;
            stats.totalLiquiditySOL = stats.totalLiquidity / LAMPORTS_PER_SOL;

            console.log(`[ONCHAIN-STATS] FINAL: Claimed=${stats.totalClaimedSOL.toFixed(4)} SOL, Distributed=${stats.totalDistributedSOL.toFixed(4)} SOL, Pending=${stats.pendingSOL.toFixed(4)} SOL`);

            return stats;

        } catch (e) {
            console.error(`[ONCHAIN-STATS] Error: ${e.message}`);
            // Fallback to RPC-only method
            return await this.fetchOnChainStatsViaRPC(tokenMint, feeWalletAddress);
        }
    }

    /**
     * Get accurate totals using RPC pre/post balances
     * SCANS ALL TRANSACTIONS - this is the source of truth
     */
    async getRPCTotals(feeWalletAddress) {
        const feeWallet = new PublicKey(feeWalletAddress);
        let totalIn = 0, totalOut = 0, inCount = 0, outCount = 0;

        // Check cache first (cache for 30 minutes - this is expensive)
        const cacheKey = `rpc_totals:${feeWalletAddress}`;
        const cachedEntry = this.cache.get(cacheKey);
        if (cachedEntry && Date.now() - cachedEntry.timestamp < 1800000) { // 30 min cache
            console.log(`[ONCHAIN-STATS] Using cached RPC totals (valid for ${Math.round((1800000 - (Date.now() - cachedEntry.timestamp)) / 60000)} more minutes)`);
            return cachedEntry.data;
        }

        try {
            // Fetch ALL signatures - no limit
            // This is necessary for accurate totals
            const MAX_SIGNATURES = 100000; // Safety cap
            let allSignatures = [];
            let lastSig = null;
            let pageCount = 0;

            while (allSignatures.length < MAX_SIGNATURES) {
                const options = { limit: 1000 };
                if (lastSig) options.before = lastSig;

                const sigs = await this.connection.getSignaturesForAddress(feeWallet, options, 'confirmed');
                if (sigs.length === 0) break;

                allSignatures.push(...sigs);
                lastSig = sigs[sigs.length - 1].signature;
                pageCount++;

                if (pageCount % 10 === 0) {
                    console.log(`[ONCHAIN-STATS] Fetched ${allSignatures.length} signatures...`);
                }

                if (sigs.length < 1000) break; // No more pages

                // Rate limit protection
                await new Promise(r => setTimeout(r, 100));
            }

            console.log(`[ONCHAIN-STATS] Processing ${allSignatures.length} total signatures`);

            // Process in batches with rate limit handling
            const batches = this.chunkArray(allSignatures, 100);
            let processedCount = 0;

            for (let i = 0; i < batches.length; i++) {
                const batch = batches[i];
                try {
                    const txs = await this.connection.getTransactions(
                        batch.map(s => s.signature),
                        { maxSupportedTransactionVersion: 0 }
                    );

                    for (const tx of txs) {
                        if (!tx || !tx.meta) continue;

                        const preBalances = tx.meta.preBalances;
                        const postBalances = tx.meta.postBalances;
                        const accountKeys = tx.transaction.message.staticAccountKeys ||
                                           tx.transaction.message.accountKeys || [];

                        // Find fee wallet index
                        const walletIndex = accountKeys.findIndex(k => k.toBase58() === feeWalletAddress);
                        if (walletIndex === -1) continue;

                        // Calculate balance change
                        const balanceChange = postBalances[walletIndex] - preBalances[walletIndex];
                        const txFee = walletIndex === 0 ? (tx.meta.fee || 0) : 0;

                        if (balanceChange > 0) {
                            totalIn += balanceChange;
                            inCount++;
                        } else if (balanceChange < 0) {
                            const netOut = Math.abs(balanceChange) - txFee;
                            if (netOut > 0) {
                                totalOut += netOut;
                                outCount++;
                            }
                        }
                    }

                    processedCount += batch.length;

                    // Progress logging every 5000 transactions
                    if (processedCount % 5000 === 0) {
                        console.log(`[ONCHAIN-STATS] Processed ${processedCount}/${allSignatures.length} txs - In: ${(totalIn / LAMPORTS_PER_SOL).toFixed(2)} SOL, Out: ${(totalOut / LAMPORTS_PER_SOL).toFixed(2)} SOL`);
                    }

                    // Rate limit protection
                    await new Promise(r => setTimeout(r, 50));
                } catch (e) {
                    console.error(`[ONCHAIN-STATS] Batch ${i}/${batches.length} error: ${e.message}`);
                    // Wait longer on rate limit errors
                    if (e.message.includes('429')) {
                        console.log(`[ONCHAIN-STATS] Rate limited, waiting 3s...`);
                        await new Promise(r => setTimeout(r, 3000));
                        i--; // Retry this batch
                    }
                }
            }

        } catch (e) {
            console.error(`[ONCHAIN-STATS] getRPCTotals error: ${e.message}`);
        }

        const result = { totalIn, totalOut, inCount, outCount };

        // Cache for 30 minutes (this is expensive to compute)
        this.cache.set(cacheKey, { data: result, timestamp: Date.now() });

        console.log(`[ONCHAIN-STATS] RPC Totals: In=${(totalIn / LAMPORTS_PER_SOL).toFixed(4)}, Out=${(totalOut / LAMPORTS_PER_SOL).toFixed(4)}`);
        return result;
    }

    /**
     * Get ALL parsed transactions from Helius API with pagination
     * Fetches complete transaction history for accurate stats
     */
    async getHeliusParsedTransactions(address, limit = 100) {
        if (!CONFIG.HELIUS_API_KEY) {
            console.log(`[ONCHAIN-STATS] No HELIUS_API_KEY set, using RPC fallback`);
            return [];
        }

        const allTransactions = [];
        let lastSignature = null;
        let pageCount = 0;
        const maxPages = 20; // Safety limit: 20 pages * 100 = 2000 transactions max

        try {
            while (pageCount < maxPages) {
                // Helius parsed transaction history endpoint with pagination
                let url = `${CONFIG.HELIUS_API}/addresses/${address}/transactions?api-key=${CONFIG.HELIUS_API_KEY}&limit=100`;
                if (lastSignature) {
                    url += `&before=${lastSignature}`;
                }

                if (pageCount === 0) {
                    console.log(`[ONCHAIN-STATS] Fetching ALL transactions for ${address.slice(0, 8)}...`);
                }

                const response = await axios.get(url, { timeout: 30000 });

                if (!response.data || !Array.isArray(response.data) || response.data.length === 0) {
                    break; // No more transactions
                }

                allTransactions.push(...response.data);
                pageCount++;

                // Get last signature for pagination
                lastSignature = response.data[response.data.length - 1].signature;

                // If we got less than 100, we've reached the end
                if (response.data.length < 100) {
                    break;
                }

                // Small delay to be nice to the API
                await new Promise(r => setTimeout(r, 100));
            }

            console.log(`[ONCHAIN-STATS] Fetched ${allTransactions.length} total transactions (${pageCount} pages)`);
            return allTransactions;

        } catch (e) {
            console.error(`[ONCHAIN-STATS] Helius API error: ${e.message}`);
            if (e.response) {
                console.error(`[ONCHAIN-STATS] Response status: ${e.response.status}`);
                console.error(`[ONCHAIN-STATS] Response data: ${JSON.stringify(e.response.data)}`);
            }
            // Return what we have so far
            return allTransactions;
        }
    }

    /**
     * Fallback: Fetch stats via RPC (if Helius API fails)
     */
    async fetchOnChainStatsViaRPC(tokenMint, feeWalletAddress) {
        console.log(`[ONCHAIN-STATS] Using RPC fallback for ${feeWalletAddress.slice(0, 8)}...`);

        const stats = this.getEmptyStats();

        try {
            const feeWallet = new PublicKey(feeWalletAddress);

            // Get signatures
            const signatures = await this.connection.getSignaturesForAddress(
                feeWallet,
                { limit: 1000 },
                'confirmed'
            );

            console.log(`[ONCHAIN-STATS] RPC found ${signatures.length} signatures`);

            if (signatures.length === 0) {
                const balance = await this.connection.getBalance(feeWallet);
                stats.pending = balance;
                stats.pendingSOL = balance / LAMPORTS_PER_SOL;
                return stats;
            }

            // Batch fetch transactions
            const batches = this.chunkArray(signatures, 50);

            for (const batch of batches) {
                try {
                    const txs = await this.connection.getTransactions(
                        batch.map(s => s.signature),
                        { maxSupportedTransactionVersion: 0 }
                    );

                    for (let i = 0; i < txs.length; i++) {
                        const tx = txs[i];
                        if (!tx || !tx.meta) continue;

                        const preBalances = tx.meta.preBalances;
                        const postBalances = tx.meta.postBalances;
                        const accountKeys = tx.transaction.message.staticAccountKeys ||
                                           tx.transaction.message.accountKeys || [];

                        // Find fee wallet index
                        const feeWalletIndex = accountKeys.findIndex(
                            k => k.toBase58() === feeWalletAddress
                        );

                        if (feeWalletIndex === -1) continue;

                        // Calculate balance change
                        const balanceChange = postBalances[feeWalletIndex] - preBalances[feeWalletIndex];
                        const txFee = tx.meta.fee || 5000;

                        // Incoming SOL (excluding any refunds from failed txs)
                        if (balanceChange > 0) {
                            stats.totalClaimed += balanceChange;
                            stats.claimCount++;
                        }

                        // Outgoing SOL (excluding tx fees)
                        if (balanceChange < 0) {
                            const netOutgoing = Math.abs(balanceChange) - txFee;
                            if (netOutgoing > 0) {
                                stats.totalDistributed += netOutgoing;
                                stats.distributeCount++;
                            }
                        }
                    }
                } catch (e) {
                    console.error(`[ONCHAIN-STATS] RPC batch error: ${e.message}`);
                }
            }

            // Get current balance
            const balance = await this.connection.getBalance(feeWallet);
            stats.pending = balance;
            stats.pendingSOL = balance / LAMPORTS_PER_SOL;

            // Convert to SOL
            stats.totalClaimedSOL = stats.totalClaimed / LAMPORTS_PER_SOL;
            stats.totalDistributedSOL = stats.totalDistributed / LAMPORTS_PER_SOL;
            stats.holderPoolSOL = stats.holderPool / LAMPORTS_PER_SOL;

            console.log(`[ONCHAIN-STATS] RPC RESULTS: Claimed=${stats.totalClaimedSOL.toFixed(4)} SOL, Distributed=${stats.totalDistributedSOL.toFixed(4)} SOL`);

            return stats;

        } catch (e) {
            console.error(`[ONCHAIN-STATS] RPC fallback error: ${e.message}`);
            return stats;
        }
    }

    /**
     * Get stats for LAUNCHR_OPS_WALLET (the 1% from ALL tokens)
     * This shows total platform revenue - uses Helius API
     */
    async getPlatformStats() {
        const cacheKey = 'platform:ops';
        const cached = this.getFromCache(cacheKey);
        if (cached) return cached;

        console.log(`[ONCHAIN-STATS] Fetching platform stats for ops wallet...`);

        try {
            const opsWallet = CONFIG.LAUNCHR_OPS_WALLET;
            const balance = await this.connection.getBalance(new PublicKey(opsWallet));

            // Use Helius parsed transactions
            const transactions = await this.getHeliusParsedTransactions(opsWallet, 100);

            let totalReceived = 0;
            let transactionCount = 0;

            for (const tx of transactions) {
                if (tx.nativeTransfers) {
                    for (const transfer of tx.nativeTransfers) {
                        if (transfer.toUserAccount === opsWallet) {
                            totalReceived += transfer.amount;
                            transactionCount++;
                        }
                    }
                }
            }

            const stats = {
                opsWallet,
                currentBalance: balance,
                currentBalanceSOL: balance / LAMPORTS_PER_SOL,
                totalReceived,
                totalReceivedSOL: totalReceived / LAMPORTS_PER_SOL,
                transactionCount,
                lastUpdated: Date.now(),
            };

            this.setCache(cacheKey, stats);
            return stats;
        } catch (e) {
            console.error(`[ONCHAIN-STATS] Platform stats error: ${e.message}`);
            return {
                opsWallet: CONFIG.LAUNCHR_OPS_WALLET,
                currentBalance: 0,
                currentBalanceSOL: 0,
                totalReceived: 0,
                totalReceivedSOL: 0,
                transactionCount: 0,
                error: e.message,
            };
        }
    }

    /**
     * Get combined stats for dashboard display
     * Returns data in the format the frontend expects
     * Includes breakdown: burned, buyback, liquidity
     */
    async getStatsForDashboard(tokenMint, feeWalletAddress) {
        const tokenStats = await this.getTokenStats(tokenMint, feeWalletAddress);

        return {
            success: true,
            // In lamports
            totalClaimed: tokenStats.totalClaimed,
            totalDistributed: tokenStats.totalDistributed,
            pending: tokenStats.pending,
            // Breakdown in lamports
            totalBurned: tokenStats.totalBurned,
            totalBuyback: tokenStats.totalBuyback,
            totalLiquidity: tokenStats.totalLiquidity,
            // In SOL (for display)
            totalClaimedSOL: tokenStats.totalClaimedSOL,
            totalDistributedSOL: tokenStats.totalDistributedSOL,
            pendingSOL: tokenStats.pendingSOL,
            // Breakdown in SOL
            totalBurnedSOL: tokenStats.totalBurnedSOL,
            totalBuybackSOL: tokenStats.totalBuybackSOL,
            totalLiquiditySOL: tokenStats.totalLiquiditySOL,
            // Counts
            claimCount: tokenStats.claimCount,
            distributeCount: tokenStats.distributeCount,
            burnCount: tokenStats.burnCount,
            buybackCount: tokenStats.buybackCount,
            liquidityCount: tokenStats.liquidityCount,
            // Meta
            tokenMint,
            feeWallet: feeWalletAddress,
            lastUpdated: Date.now(),
            source: 'onchain',
        };
    }

    /**
     * FAST: Get stats for dashboard with timeout to prevent browser timeout
     * Uses persisted stats as primary source, on-chain for pending balance
     * @param timeoutMs - max time for on-chain fetch (default 8 seconds)
     */
    async getStatsForDashboardFast(tokenMint, feeWalletAddress, timeoutMs = 8000) {
        const tokenStats = await this.getTokenStatsWithTimeout(tokenMint, feeWalletAddress, timeoutMs);

        return {
            success: true,
            // In lamports
            totalClaimed: tokenStats.totalClaimed,
            totalDistributed: tokenStats.totalDistributed,
            pending: tokenStats.pending,
            // Breakdown in lamports
            totalBurned: tokenStats.totalBurned,
            totalBuyback: tokenStats.totalBuyback,
            totalLiquidity: tokenStats.totalLiquidity,
            // In SOL (for display)
            totalClaimedSOL: tokenStats.totalClaimedSOL,
            totalDistributedSOL: tokenStats.totalDistributedSOL,
            pendingSOL: tokenStats.pendingSOL,
            // Breakdown in SOL
            totalBurnedSOL: tokenStats.totalBurnedSOL,
            totalBuybackSOL: tokenStats.totalBuybackSOL,
            totalLiquiditySOL: tokenStats.totalLiquiditySOL,
            // Counts
            claimCount: tokenStats.claimCount,
            distributeCount: tokenStats.distributeCount,
            burnCount: tokenStats.burnCount,
            buybackCount: tokenStats.buybackCount,
            liquidityCount: tokenStats.liquidityCount,
            // Meta
            tokenMint,
            feeWallet: feeWalletAddress,
            lastUpdated: Date.now(),
            source: tokenStats._timedOut ? 'balance-only' : 'onchain',
            _timedOut: tokenStats._timedOut || false,
        };
    }

    /**
     * Check if a transaction is a burn transaction
     */
    isBurnTransaction(tx, burnAddress) {
        const txType = (tx.type || '').toUpperCase();
        const description = (tx.description || '').toLowerCase();

        // Direct burn type
        if (txType === 'BURN' || txType === 'TOKEN_BURN' || txType.includes('BURN')) {
            return true;
        }

        // Description mentions burn
        if (description.includes('burn') || description.includes('burned')) {
            return true;
        }

        // Token transfers to burn address
        if (tx.tokenTransfers) {
            for (const tt of tx.tokenTransfers) {
                if (tt.toUserAccount === burnAddress || tt.toTokenAccount === burnAddress) {
                    return true;
                }
            }
        }

        // Check for burn instructions
        if (tx.instructions) {
            for (const ix of tx.instructions) {
                const ixType = (ix.type || '').toLowerCase();
                if (ixType === 'burn' || ixType === 'burnchecked' || ixType.includes('burn')) {
                    return true;
                }
            }
        }

        return false;
    }

    /**
     * Categorize a transaction as burn, buyback, or liquidity
     * BURNS: SOL spent buying tokens that were then burned (check tokenTransfers + type)
     * BUYBACK: SOL spent buying tokens that were kept (market support)
     * LIQUIDITY: SOL added to LP pools
     */
    categorizeTransaction(tx, transfer, burnAddress, pumpPrograms) {
        const txType = (tx.type || '').toUpperCase();
        const txSource = (tx.source || '').toUpperCase();
        const description = (tx.description || '').toLowerCase();

        // PRIORITY 1: Check if this transaction burned tokens
        // This is the key fix - burns are TOKEN operations, not SOL transfers to burn address
        if (txType === 'BURN' || txType.includes('BURN')) {
            return 'burn';
        }

        // Check for burn in description (Helius often describes burns)
        if (description.includes('burn') || description.includes('burned')) {
            return 'burn';
        }

        // Check token transfers for burns - tokens going to burn address or null
        if (tx.tokenTransfers && tx.tokenTransfers.length > 0) {
            for (const tokenTransfer of tx.tokenTransfers) {
                // Token sent to burn address
                if (tokenTransfer.toUserAccount === burnAddress ||
                    tokenTransfer.toTokenAccount === burnAddress) {
                    return 'burn';
                }
                // Token burned (no destination)
                if (!tokenTransfer.toUserAccount && !tokenTransfer.toTokenAccount) {
                    return 'burn';
                }
            }
        }

        // Check instructions for burn operations
        if (tx.instructions) {
            for (const ix of tx.instructions) {
                const ixType = (ix.type || '').toLowerCase();
                const ixProgram = (ix.programId || '').toLowerCase();
                if (ixType.includes('burn') || ixType === 'burnChecked' || ixType === 'burn') {
                    return 'burn';
                }
            }
        }

        // Check events for burns
        if (tx.events && tx.events.nft) {
            // NFT burns
            return 'burn';
        }

        // PRIORITY 2: Check for liquidity adds
        if (txType === 'ADD_LIQUIDITY' ||
            txType.includes('LIQUIDITY') ||
            description.includes('liquidity') ||
            description.includes('add lp') ||
            description.includes('lp ')) {
            return 'liquidity';
        }

        // PRIORITY 3: Everything else going to Pump/swap is buyback
        if (txType === 'SWAP' ||
            txType.includes('SWAP') ||
            txSource.includes('PUMP') ||
            txSource.includes('RAYDIUM') ||
            txSource.includes('JUPITER') ||
            description.includes('swap') ||
            description.includes('bought') ||
            description.includes('sold')) {
            return 'buyback';
        }

        // Check if transaction involves pump programs
        if (tx.instructions) {
            for (const ix of tx.instructions) {
                if (pumpPrograms.includes(ix.programId)) {
                    return 'buyback';
                }
            }
        }

        // Default: uncategorized (could be transfer, etc)
        return 'other';
    }

    /**
     * Empty stats object - includes breakdown by category
     */
    getEmptyStats() {
        return {
            totalClaimed: 0,
            totalDistributed: 0,
            pending: 0,
            // Breakdown by category
            totalBurned: 0,
            totalBuyback: 0,
            totalLiquidity: 0,
            // SOL values
            totalClaimedSOL: 0,
            totalDistributedSOL: 0,
            pendingSOL: 0,
            totalBurnedSOL: 0,
            totalBuybackSOL: 0,
            totalLiquiditySOL: 0,
            // Counts
            claimCount: 0,
            distributeCount: 0,
            burnCount: 0,
            buybackCount: 0,
            liquidityCount: 0,
        };
    }

    /**
     * Cache helpers
     */
    getFromCache(key) {
        const entry = this.cache.get(key);
        if (!entry) return null;
        if (Date.now() - entry.timestamp > CONFIG.CACHE_TTL_MS) {
            this.cache.delete(key);
            return null;
        }
        return entry.data;
    }

    setCache(key, data) {
        this.cache.set(key, { data, timestamp: Date.now() });
    }

    clearCache() {
        this.cache.clear();
    }

    /**
     * Utility: chunk array
     */
    chunkArray(arr, size) {
        const chunks = [];
        for (let i = 0; i < arr.length; i += size) {
            chunks.push(arr.slice(i, i + size));
        }
        return chunks;
    }
}

// ═══════════════════════════════════════════════════════════════════
// SINGLETON INSTANCE
// ═══════════════════════════════════════════════════════════════════

let instance = null;

function getOnChainStats() {
    if (!instance) {
        instance = new OnChainStats();
    }
    return instance;
}

// ═══════════════════════════════════════════════════════════════════
// EXPORTS
// ═══════════════════════════════════════════════════════════════════

module.exports = {
    OnChainStats,
    getOnChainStats,
    CONFIG,
};
