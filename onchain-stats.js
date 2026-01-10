/**
 * ON-CHAIN STATS SERVICE
 *
 * Fetches REAL stats from the Solana blockchain via Helius RPC.
 * No more internal state that resets - this is THE TRUTH from the chain.
 *
 * For each token using TEK:
 * - Total Claimed: SOL claimed from Pump.fun creator fees
 * - Total Distributed: SOL distributed via burn/buyback/holder/LP
 * - Holder Pool: 1% sent to LAUNCHR_OPS_WALLET
 * - Pending: SOL sitting in fee wallet waiting to distribute
 */

const { Connection, PublicKey, LAMPORTS_PER_SOL } = require('@solana/web3.js');

// ═══════════════════════════════════════════════════════════════════
// CONFIGURATION
// ═══════════════════════════════════════════════════════════════════

const CONFIG = {
    HELIUS_API_KEY: process.env.HELIUS_API_KEY || '',
    HELIUS_RPC: process.env.HELIUS_RPC || 'https://mainnet.helius-rpc.com',

    // Pump.fun program IDs for identifying transactions
    PUMP_PROGRAM_ID: '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P',
    PUMPSWAP_PROGRAM_ID: 'pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA',

    // LAUNCHR ops wallet - receives 1% of all fees
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
        this.rpcUrl = CONFIG.HELIUS_API_KEY
            ? `${CONFIG.HELIUS_RPC}/?api-key=${CONFIG.HELIUS_API_KEY}`
            : CONFIG.HELIUS_RPC;
        this.connection = new Connection(this.rpcUrl, 'confirmed');
        this.cache = new Map();

        console.log(`[ONCHAIN-STATS] Initialized with Helius RPC`);
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
     * Fetch real on-chain statistics by parsing transaction history
     */
    async fetchOnChainStats(tokenMint, feeWalletAddress) {
        if (!feeWalletAddress) {
            return this.getEmptyStats();
        }

        const feeWallet = new PublicKey(feeWalletAddress);

        // Get transaction history for the fee wallet
        const signatures = await this.getSignatures(feeWalletAddress, 1000);

        if (signatures.length === 0) {
            console.log(`[ONCHAIN-STATS] No transactions found for ${feeWalletAddress.slice(0, 8)}...`);
            return this.getEmptyStats();
        }

        console.log(`[ONCHAIN-STATS] Found ${signatures.length} transactions, parsing...`);

        // Parse transactions to extract stats
        const stats = await this.parseTransactions(signatures, feeWalletAddress, tokenMint);

        // Get current balance (pending)
        const balance = await this.connection.getBalance(feeWallet);
        stats.pending = balance;
        stats.pendingSOL = balance / LAMPORTS_PER_SOL;

        return stats;
    }

    /**
     * Get transaction signatures for an address
     */
    async getSignatures(address, limit = 1000) {
        try {
            const sigs = await this.connection.getSignaturesForAddress(
                new PublicKey(address),
                { limit },
                'confirmed'
            );
            return sigs;
        } catch (e) {
            console.error(`[ONCHAIN-STATS] Error fetching signatures: ${e.message}`);
            return [];
        }
    }

    /**
     * Parse transactions to extract fee claim and distribution data
     */
    async parseTransactions(signatures, feeWalletAddress, tokenMint) {
        const stats = this.getEmptyStats();
        const opsWallet = CONFIG.LAUNCHR_OPS_WALLET.toLowerCase();

        // Batch fetch transactions (Helius supports up to 100 per request)
        const batches = this.chunkArray(signatures, 100);

        for (const batch of batches) {
            try {
                const txs = await this.connection.getTransactions(
                    batch.map(s => s.signature),
                    { maxSupportedTransactionVersion: 0 }
                );

                for (let i = 0; i < txs.length; i++) {
                    const tx = txs[i];
                    if (!tx || !tx.meta) continue;

                    const sig = batch[i];
                    const preBalances = tx.meta.preBalances;
                    const postBalances = tx.meta.postBalances;
                    const accountKeys = tx.transaction.message.staticAccountKeys ||
                                       tx.transaction.message.accountKeys || [];

                    // Find fee wallet index
                    const feeWalletIndex = accountKeys.findIndex(
                        k => k.toBase58().toLowerCase() === feeWalletAddress.toLowerCase()
                    );

                    if (feeWalletIndex === -1) continue;

                    // Calculate balance change for fee wallet
                    const balanceChange = postBalances[feeWalletIndex] - preBalances[feeWalletIndex];

                    // Check if this involves Pump.fun program (creator fee claim)
                    const involvesPump = tx.meta.logMessages?.some(log =>
                        log.includes(CONFIG.PUMP_PROGRAM_ID) ||
                        log.includes('collect') ||
                        log.includes('CreatorFee')
                    );

                    // Incoming SOL = claim
                    if (balanceChange > 0) {
                        stats.totalClaimed += balanceChange;
                        stats.claimCount++;
                    }

                    // Outgoing SOL = distribution
                    if (balanceChange < 0) {
                        const outgoing = Math.abs(balanceChange);

                        // Check if going to ops wallet (1% holder fee)
                        const opsWalletIndex = accountKeys.findIndex(
                            k => k.toBase58().toLowerCase() === opsWallet
                        );

                        if (opsWalletIndex !== -1) {
                            const opsChange = postBalances[opsWalletIndex] - preBalances[opsWalletIndex];
                            if (opsChange > 0) {
                                stats.holderPool += opsChange;
                            }
                        }

                        // Total distributed (excluding tx fees)
                        const fee = tx.meta.fee || 5000;
                        const actualDistributed = outgoing - fee;
                        if (actualDistributed > 0) {
                            stats.totalDistributed += actualDistributed;
                            stats.distributeCount++;
                        }
                    }
                }
            } catch (e) {
                console.error(`[ONCHAIN-STATS] Batch parse error: ${e.message}`);
            }
        }

        // Convert to SOL
        stats.totalClaimedSOL = stats.totalClaimed / LAMPORTS_PER_SOL;
        stats.totalDistributedSOL = stats.totalDistributed / LAMPORTS_PER_SOL;
        stats.holderPoolSOL = stats.holderPool / LAMPORTS_PER_SOL;

        console.log(`[ONCHAIN-STATS] Parsed: Claimed=${stats.totalClaimedSOL.toFixed(4)} SOL, Distributed=${stats.totalDistributedSOL.toFixed(4)} SOL, HolderPool=${stats.holderPoolSOL.toFixed(4)} SOL`);

        return stats;
    }

    /**
     * Get stats for LAUNCHR_OPS_WALLET (the 1% from ALL tokens)
     * This shows total platform revenue
     */
    async getPlatformStats() {
        const cacheKey = 'platform:ops';
        const cached = this.getFromCache(cacheKey);
        if (cached) return cached;

        console.log(`[ONCHAIN-STATS] Fetching platform stats for ops wallet...`);

        try {
            const opsWallet = CONFIG.LAUNCHR_OPS_WALLET;
            const balance = await this.connection.getBalance(new PublicKey(opsWallet));

            // Get incoming transactions to ops wallet
            const signatures = await this.getSignatures(opsWallet, 1000);

            let totalReceived = 0;
            let transactionCount = 0;

            // Batch fetch
            const batches = this.chunkArray(signatures, 100);
            for (const batch of batches) {
                try {
                    const txs = await this.connection.getTransactions(
                        batch.map(s => s.signature),
                        { maxSupportedTransactionVersion: 0 }
                    );

                    for (const tx of txs) {
                        if (!tx || !tx.meta) continue;

                        const accountKeys = tx.transaction.message.staticAccountKeys ||
                                           tx.transaction.message.accountKeys || [];

                        const opsIndex = accountKeys.findIndex(
                            k => k.toBase58() === opsWallet
                        );

                        if (opsIndex !== -1) {
                            const change = tx.meta.postBalances[opsIndex] - tx.meta.preBalances[opsIndex];
                            if (change > 0) {
                                totalReceived += change;
                                transactionCount++;
                            }
                        }
                    }
                } catch (e) {
                    // Continue on errors
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
