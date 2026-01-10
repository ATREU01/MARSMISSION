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
     * Get stats for a specific token's TEK usage
     * This is what the dashboard needs - REAL on-chain data
     */
    async getTokenStats(tokenMint, feeWalletAddress) {
        const cacheKey = `stats:${tokenMint}:${feeWalletAddress}`;
        const cached = this.getFromCache(cacheKey);
        if (cached) return cached;

        console.log(`[ONCHAIN-STATS] Fetching on-chain stats for ${tokenMint.slice(0, 8)}...`);

        try {
            const stats = await this.fetchOnChainStats(tokenMint, feeWalletAddress);
            this.setCache(cacheKey, stats);
            return stats;
        } catch (e) {
            console.error(`[ONCHAIN-STATS] Error: ${e.message}`);
            return this.getEmptyStats();
        }
    }

    /**
     * Fetch real on-chain statistics using Helius parsed transaction API
     * This is the REAL DEAL - actual blockchain data
     */
    async fetchOnChainStats(tokenMint, feeWalletAddress) {
        if (!feeWalletAddress) {
            return this.getEmptyStats();
        }

        console.log(`[ONCHAIN-STATS] Fetching parsed transactions for ${feeWalletAddress}...`);

        const stats = this.getEmptyStats();

        try {
            // Use Helius parsed transaction history API - MUCH more reliable
            const transactions = await this.getHeliusParsedTransactions(feeWalletAddress);

            if (transactions.length === 0) {
                console.log(`[ONCHAIN-STATS] No transactions found, trying RPC fallback...`);
                // Fallback to RPC-based parsing
                return await this.fetchOnChainStatsViaRPC(tokenMint, feeWalletAddress);
            }

            console.log(`[ONCHAIN-STATS] Found ${transactions.length} parsed transactions`);

            // Parse Helius transaction data
            for (const tx of transactions) {
                // Look for native SOL transfers
                if (tx.nativeTransfers && tx.nativeTransfers.length > 0) {
                    for (const transfer of tx.nativeTransfers) {
                        // Incoming SOL to fee wallet = claimed fees
                        if (transfer.toUserAccount === feeWalletAddress) {
                            stats.totalClaimed += transfer.amount;
                            stats.claimCount++;
                        }
                        // Outgoing SOL from fee wallet = distributed fees
                        if (transfer.fromUserAccount === feeWalletAddress) {
                            stats.totalDistributed += transfer.amount;
                            stats.distributeCount++;
                        }
                    }
                }

                // Also check accountData for balance changes
                if (tx.accountData) {
                    for (const account of tx.accountData) {
                        if (account.account === feeWalletAddress && account.nativeBalanceChange) {
                            const change = account.nativeBalanceChange;
                            if (change > 0) {
                                // Don't double count if we already got it from nativeTransfers
                                if (!tx.nativeTransfers || tx.nativeTransfers.length === 0) {
                                    stats.totalClaimed += change;
                                    stats.claimCount++;
                                }
                            }
                        }
                    }
                }
            }

            // Get current balance (pending)
            const balance = await this.connection.getBalance(new PublicKey(feeWalletAddress));
            stats.pending = balance;
            stats.pendingSOL = balance / LAMPORTS_PER_SOL;

            // Convert to SOL
            stats.totalClaimedSOL = stats.totalClaimed / LAMPORTS_PER_SOL;
            stats.totalDistributedSOL = stats.totalDistributed / LAMPORTS_PER_SOL;
            stats.holderPoolSOL = stats.holderPool / LAMPORTS_PER_SOL;

            console.log(`[ONCHAIN-STATS] RESULTS: Claimed=${stats.totalClaimedSOL.toFixed(4)} SOL, Distributed=${stats.totalDistributedSOL.toFixed(4)} SOL, Pending=${stats.pendingSOL.toFixed(4)} SOL`);

            return stats;

        } catch (e) {
            console.error(`[ONCHAIN-STATS] Helius API error: ${e.message}, trying RPC fallback...`);
            return await this.fetchOnChainStatsViaRPC(tokenMint, feeWalletAddress);
        }
    }

    /**
     * Get parsed transactions from Helius API
     */
    async getHeliusParsedTransactions(address, limit = 100) {
        if (!CONFIG.HELIUS_API_KEY) {
            console.log(`[ONCHAIN-STATS] No HELIUS_API_KEY set, using RPC fallback`);
            return [];
        }

        try {
            // Helius parsed transaction history endpoint
            const url = `${CONFIG.HELIUS_API}/addresses/${address}/transactions?api-key=${CONFIG.HELIUS_API_KEY}&limit=${limit}`;
            console.log(`[ONCHAIN-STATS] Calling Helius API: ${url.replace(CONFIG.HELIUS_API_KEY, 'REDACTED')}`);

            const response = await axios.get(url, { timeout: 30000 });

            if (response.data && Array.isArray(response.data)) {
                return response.data;
            }

            return [];
        } catch (e) {
            console.error(`[ONCHAIN-STATS] Helius API error: ${e.message}`);
            if (e.response) {
                console.error(`[ONCHAIN-STATS] Response status: ${e.response.status}`);
                console.error(`[ONCHAIN-STATS] Response data: ${JSON.stringify(e.response.data)}`);
            }
            return [];
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
     */
    async getStatsForDashboard(tokenMint, feeWalletAddress) {
        const tokenStats = await this.getTokenStats(tokenMint, feeWalletAddress);

        return {
            success: true,
            // In lamports (frontend will convert)
            totalClaimed: tokenStats.totalClaimed,
            totalDistributed: tokenStats.totalDistributed,
            holderPool: tokenStats.holderPool,
            pending: tokenStats.pending,
            // In SOL (for display)
            totalClaimedSOL: tokenStats.totalClaimedSOL,
            totalDistributedSOL: tokenStats.totalDistributedSOL,
            holderPoolSOL: tokenStats.holderPoolSOL,
            pendingSOL: tokenStats.pendingSOL,
            // Counts
            claimCount: tokenStats.claimCount,
            distributeCount: tokenStats.distributeCount,
            // Meta
            tokenMint,
            feeWallet: feeWalletAddress,
            lastUpdated: Date.now(),
            source: 'onchain',
        };
    }

    /**
     * Empty stats object
     */
    getEmptyStats() {
        return {
            totalClaimed: 0,
            totalDistributed: 0,
            holderPool: 0,
            pending: 0,
            totalClaimedSOL: 0,
            totalDistributedSOL: 0,
            holderPoolSOL: 0,
            pendingSOL: 0,
            claimCount: 0,
            distributeCount: 0,
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
