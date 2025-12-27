/**
 * LAUNCHR FEE ROUTER
 *
 * Handles fee routing for all launches on LAUNCHR:
 *
 * When creator fees are claimed:
 *   1% → LAUNCHR Distribution Pool (automatic)
 *   99% → Creator's allocation engine (buyback, burn, LP, revenue)
 *
 * The distribution pool distributes to LAUNCHR token holders proportionally.
 */

const { Connection, PublicKey, Keypair, Transaction, SystemProgram, LAMPORTS_PER_SOL } = require('@solana/web3.js');
const { TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID, getAssociatedTokenAddress, getAccount, createTransferInstruction } = require('@solana/spl-token');
const { LaunchrEngine } = require('./launchr-engine');
const fs = require('fs');
const path = require('path');

// ═══════════════════════════════════════════════════════════════════
// CONFIGURATION
// ═══════════════════════════════════════════════════════════════════

const FEE_CONFIG = {
    // Fee split
    LAUNCHR_HOLDER_FEE_BPS: 100, // 1% to LAUNCHR holders
    CREATOR_FEE_BPS: 9900, // 99% to creator's allocation

    // LAUNCHR token
    LAUNCHR_TOKEN_MINT: process.env.LAUNCHR_TOKEN_MINT || '',

    // Pool addresses (set these to your actual pool addresses)
    HOLDER_POOL_ADDRESS: process.env.HOLDER_POOL_ADDRESS || '',
    TREASURY_ADDRESS: process.env.TREASURY_ADDRESS || '',

    // Minimum thresholds
    MIN_CLAIM_THRESHOLD: 0.001 * LAMPORTS_PER_SOL, // 0.001 SOL
    MIN_DISTRIBUTION_THRESHOLD: 0.1 * LAMPORTS_PER_SOL, // 0.1 SOL

    // Persistence
    FEE_LEDGER_FILE: path.join(__dirname, '.fee-ledger.json'),
    HOLDER_SNAPSHOT_FILE: path.join(__dirname, '.holder-snapshot.json'),
};

// ═══════════════════════════════════════════════════════════════════
// FEE ROUTER
// ═══════════════════════════════════════════════════════════════════

class FeeRouter {
    constructor(connection, wallet) {
        this.connection = connection;
        this.wallet = wallet;

        // Track launches and their engines
        this.launches = new Map();
        this.engines = new Map();

        // Accumulated holder fees
        this.holderPool = {
            balance: 0,
            pendingDistribution: 0,
            totalCollected: 0,
            totalDistributed: 0,
            distributions: [],
        };

        // Fee ledger for transparency
        this.ledger = [];

        // Load state
        this.loadState();
    }

    /**
     * Register a launch with the fee router
     */
    registerLaunch(mint, engine, launchData = {}) {
        this.launches.set(mint, {
            mint,
            creator: launchData.creator || this.wallet.publicKey.toBase58(),
            registeredAt: Date.now(),
            totalFeesClaimed: 0,
            totalToHolder: 0,
            totalToCreator: 0,
            ...launchData,
        });

        this.engines.set(mint, engine);
        console.log(`[FEE-ROUTER] Registered: ${mint.slice(0, 8)}...`);
    }

    /**
     * Process claimed fees - routes 1% to holder pool, 99% to creator
     */
    async processFees(mint, claimedAmount) {
        if (claimedAmount < FEE_CONFIG.MIN_CLAIM_THRESHOLD) {
            console.log(`[FEE-ROUTER] Amount too small: ${claimedAmount / LAMPORTS_PER_SOL} SOL`);
            return { success: false, reason: 'below_threshold' };
        }

        const launch = this.launches.get(mint);
        const engine = this.engines.get(mint);

        if (!launch || !engine) {
            console.log(`[FEE-ROUTER] Launch not found: ${mint}`);
            return { success: false, reason: 'launch_not_found' };
        }

        // Calculate split
        const holderAmount = Math.floor(claimedAmount * FEE_CONFIG.LAUNCHR_HOLDER_FEE_BPS / 10000);
        const creatorAmount = claimedAmount - holderAmount;

        console.log('\n' + '─'.repeat(40));
        console.log(`[FEE-ROUTER] Processing ${claimedAmount / LAMPORTS_PER_SOL} SOL`);
        console.log(`  → Holder pool (1%): ${holderAmount / LAMPORTS_PER_SOL} SOL`);
        console.log(`  → Creator (99%): ${creatorAmount / LAMPORTS_PER_SOL} SOL`);
        console.log('─'.repeat(40));

        // Route to holder pool
        const holderResult = await this.routeToHolderPool(holderAmount, mint);

        // Route to creator's allocation engine
        const creatorResult = await this.routeToCreator(engine, creatorAmount);

        // Update launch stats
        launch.totalFeesClaimed += claimedAmount;
        launch.totalToHolder += holderAmount;
        launch.totalToCreator += creatorAmount;

        // Log to ledger
        this.logFeeEvent({
            type: 'fee_split',
            mint,
            totalClaimed: claimedAmount,
            holderAmount,
            creatorAmount,
            timestamp: Date.now(),
            holderResult,
            creatorResult,
        });

        this.saveState();

        return {
            success: true,
            claimed: claimedAmount,
            toHolder: holderAmount,
            toCreator: creatorAmount,
            holderResult,
            creatorResult,
        };
    }

    /**
     * Route fees to LAUNCHR holder pool
     */
    async routeToHolderPool(amount, sourceMint) {
        if (amount <= 0) return { success: true, amount: 0 };

        // Add to pending pool balance
        this.holderPool.balance += amount;
        this.holderPool.pendingDistribution += amount;
        this.holderPool.totalCollected += amount;

        console.log(`[HOLDER-POOL] +${amount / LAMPORTS_PER_SOL} SOL | Total: ${this.holderPool.balance / LAMPORTS_PER_SOL} SOL`);

        // If we have a treasury address, transfer there
        if (FEE_CONFIG.HOLDER_POOL_ADDRESS) {
            try {
                const tx = new Transaction().add(
                    SystemProgram.transfer({
                        fromPubkey: this.wallet.publicKey,
                        toPubkey: new PublicKey(FEE_CONFIG.HOLDER_POOL_ADDRESS),
                        lamports: amount,
                    })
                );

                const sig = await this.connection.sendTransaction(tx, [this.wallet]);
                console.log(`[HOLDER-POOL] Transfer TX: ${sig}`);

                return { success: true, amount, signature: sig };

            } catch (e) {
                console.log(`[HOLDER-POOL] Transfer failed: ${e.message}`);
                // Keep in local tracking even if transfer fails
            }
        }

        return { success: true, amount, pending: true };
    }

    /**
     * Route fees to creator's allocation engine
     */
    async routeToCreator(engine, amount) {
        if (amount <= 0) return { success: true, amount: 0 };

        try {
            // Use the engine's distribution function
            const result = await engine.distributeFees(amount);

            return {
                success: true,
                amount,
                distributed: result.distributed,
                results: result.results,
            };

        } catch (e) {
            console.log(`[CREATOR] Distribution failed: ${e.message}`);
            return { success: false, amount, error: e.message };
        }
    }

    /**
     * Auto-claim and process fees for a launch
     */
    async claimAndProcess(mint) {
        const engine = this.engines.get(mint);
        if (!engine) {
            return { success: false, reason: 'engine_not_found' };
        }

        console.log(`\n[FEE-ROUTER] Auto-claiming fees for ${mint.slice(0, 8)}...`);

        // Claim fees via engine
        const claimResult = await engine.claimFees();

        if (!claimResult.success) {
            console.log(`[FEE-ROUTER] Claim failed: ${claimResult.error}`);
            return { success: false, reason: 'claim_failed', error: claimResult.error };
        }

        if (claimResult.claimed <= 0) {
            console.log('[FEE-ROUTER] No fees to claim');
            return { success: true, claimed: 0 };
        }

        // Process the claimed fees through router
        return this.processFees(mint, claimResult.claimed);
    }

    /**
     * Distribute accumulated holder pool to LAUNCHR holders
     */
    async distributeToHolders() {
        if (this.holderPool.pendingDistribution < FEE_CONFIG.MIN_DISTRIBUTION_THRESHOLD) {
            console.log(`[HOLDER-POOL] Below distribution threshold: ${this.holderPool.pendingDistribution / LAMPORTS_PER_SOL} SOL`);
            return { success: false, reason: 'below_threshold' };
        }

        console.log('\n' + '═'.repeat(50));
        console.log('HOLDER DISTRIBUTION');
        console.log('═'.repeat(50));
        console.log(`Distributing: ${this.holderPool.pendingDistribution / LAMPORTS_PER_SOL} SOL`);

        // Get LAUNCHR token holders
        const holders = await this.getHolders();

        if (holders.length === 0) {
            console.log('[HOLDER-POOL] No holders found');
            return { success: false, reason: 'no_holders' };
        }

        console.log(`Holders: ${holders.length}`);

        // Calculate total supply held
        const totalSupply = holders.reduce((sum, h) => sum + h.balance, 0n);
        console.log(`Total held: ${totalSupply.toString()}`);

        const distributions = [];
        const amountToDistribute = this.holderPool.pendingDistribution;

        // Distribute proportionally
        for (const holder of holders) {
            // Calculate share: (holder balance / total supply) * amount
            const share = Number(holder.balance * BigInt(amountToDistribute) / totalSupply);

            if (share > 0) {
                distributions.push({
                    address: holder.address,
                    balance: Number(holder.balance),
                    share,
                    percentage: (Number(holder.balance) / Number(totalSupply) * 100).toFixed(4),
                });
            }
        }

        console.log(`\nTop 10 distributions:`);
        distributions.slice(0, 10).forEach((d, i) => {
            console.log(`  ${i + 1}. ${d.address.slice(0, 8)}... ${d.percentage}% = ${d.share / LAMPORTS_PER_SOL} SOL`);
        });

        // Execute transfers
        let successCount = 0;
        let failCount = 0;
        let totalDistributed = 0;

        for (const dist of distributions) {
            try {
                const tx = new Transaction().add(
                    SystemProgram.transfer({
                        fromPubkey: this.wallet.publicKey,
                        toPubkey: new PublicKey(dist.address),
                        lamports: dist.share,
                    })
                );

                await this.connection.sendTransaction(tx, [this.wallet]);
                successCount++;
                totalDistributed += dist.share;

            } catch (e) {
                failCount++;
                console.log(`  Failed: ${dist.address.slice(0, 8)}... - ${e.message}`);
            }
        }

        // Update pool stats
        this.holderPool.pendingDistribution = 0;
        this.holderPool.totalDistributed += totalDistributed;
        this.holderPool.distributions.push({
            timestamp: Date.now(),
            amount: amountToDistribute,
            distributed: totalDistributed,
            holders: distributions.length,
            successCount,
            failCount,
        });

        this.saveState();

        console.log('═'.repeat(50));
        console.log(`Distributed: ${totalDistributed / LAMPORTS_PER_SOL} SOL to ${successCount} holders`);
        if (failCount > 0) console.log(`Failed: ${failCount}`);
        console.log('═'.repeat(50) + '\n');

        return {
            success: true,
            distributed: totalDistributed,
            holders: successCount,
            failed: failCount,
        };
    }

    /**
     * Get LAUNCHR token holders
     */
    async getHolders() {
        if (!FEE_CONFIG.LAUNCHR_TOKEN_MINT) {
            console.log('[HOLDER-POOL] No LAUNCHR token mint configured');
            return [];
        }

        try {
            const mintPubkey = new PublicKey(FEE_CONFIG.LAUNCHR_TOKEN_MINT);

            // Try Token-2022 first, then regular Token program
            let accounts = await this.connection.getProgramAccounts(TOKEN_2022_PROGRAM_ID, {
                filters: [
                    { dataSize: 165 },
                    { memcmp: { offset: 0, bytes: FEE_CONFIG.LAUNCHR_TOKEN_MINT } },
                ],
            });

            if (accounts.length === 0) {
                accounts = await this.connection.getProgramAccounts(TOKEN_PROGRAM_ID, {
                    filters: [
                        { dataSize: 165 },
                        { memcmp: { offset: 0, bytes: FEE_CONFIG.LAUNCHR_TOKEN_MINT } },
                    ],
                });
            }

            const holders = [];
            for (const { account } of accounts) {
                const owner = new PublicKey(account.data.slice(32, 64));
                const amount = account.data.readBigUInt64LE(64);

                if (amount > 0n) {
                    holders.push({
                        address: owner.toBase58(),
                        balance: amount,
                    });
                }
            }

            // Sort by balance descending
            holders.sort((a, b) => Number(b.balance - a.balance));

            // Save snapshot
            this.saveHolderSnapshot(holders);

            return holders;

        } catch (e) {
            console.error(`[HOLDER-POOL] Error fetching holders: ${e.message}`);
            return [];
        }
    }

    /**
     * Log fee event to ledger
     */
    logFeeEvent(event) {
        this.ledger.push(event);

        // Keep last 1000 events
        if (this.ledger.length > 1000) {
            this.ledger = this.ledger.slice(-1000);
        }
    }

    /**
     * Get fee stats for a launch
     */
    getLaunchStats(mint) {
        const launch = this.launches.get(mint);
        if (!launch) return null;

        return {
            mint,
            totalFeesClaimed: launch.totalFeesClaimed,
            totalToHolder: launch.totalToHolder,
            totalToCreator: launch.totalToCreator,
            holderPercentage: '1%',
            creatorPercentage: '99%',
        };
    }

    /**
     * Get holder pool stats
     */
    getHolderPoolStats() {
        return {
            ...this.holderPool,
            pendingDistributionSol: this.holderPool.pendingDistribution / LAMPORTS_PER_SOL,
            totalCollectedSol: this.holderPool.totalCollected / LAMPORTS_PER_SOL,
            totalDistributedSol: this.holderPool.totalDistributed / LAMPORTS_PER_SOL,
        };
    }

    /**
     * Get global fee stats
     */
    getGlobalStats() {
        let totalClaimed = 0;
        let totalToHolder = 0;
        let totalToCreator = 0;

        for (const launch of this.launches.values()) {
            totalClaimed += launch.totalFeesClaimed;
            totalToHolder += launch.totalToHolder;
            totalToCreator += launch.totalToCreator;
        }

        return {
            totalLaunches: this.launches.size,
            totalFeesClaimed: totalClaimed,
            totalFeesClaimedSol: totalClaimed / LAMPORTS_PER_SOL,
            totalToHolder,
            totalToHolderSol: totalToHolder / LAMPORTS_PER_SOL,
            totalToCreator,
            totalToCreatorSol: totalToCreator / LAMPORTS_PER_SOL,
            holderPool: this.getHolderPoolStats(),
        };
    }

    /**
     * Save state to file
     */
    saveState() {
        try {
            const data = {
                holderPool: this.holderPool,
                launches: Array.from(this.launches.entries()),
                ledger: this.ledger.slice(-100), // Keep last 100 events
                savedAt: Date.now(),
            };

            fs.writeFileSync(FEE_CONFIG.FEE_LEDGER_FILE, JSON.stringify(data, null, 2));

        } catch (e) {
            console.error(`[FEE-ROUTER] Save error: ${e.message}`);
        }
    }

    /**
     * Load state from file
     */
    loadState() {
        try {
            if (fs.existsSync(FEE_CONFIG.FEE_LEDGER_FILE)) {
                const data = JSON.parse(fs.readFileSync(FEE_CONFIG.FEE_LEDGER_FILE, 'utf8'));

                this.holderPool = data.holderPool || this.holderPool;
                this.launches = new Map(data.launches || []);
                this.ledger = data.ledger || [];

                console.log(`[FEE-ROUTER] Loaded ${this.launches.size} launches, pool: ${this.holderPool.balance / LAMPORTS_PER_SOL} SOL`);
            }
        } catch (e) {
            console.error(`[FEE-ROUTER] Load error: ${e.message}`);
        }
    }

    /**
     * Save holder snapshot for distribution records
     */
    saveHolderSnapshot(holders) {
        try {
            const snapshot = {
                timestamp: Date.now(),
                count: holders.length,
                totalSupply: holders.reduce((sum, h) => sum + Number(h.balance), 0),
                holders: holders.slice(0, 100).map(h => ({
                    address: h.address,
                    balance: Number(h.balance),
                })),
            };

            fs.writeFileSync(FEE_CONFIG.HOLDER_SNAPSHOT_FILE, JSON.stringify(snapshot, null, 2));

        } catch (e) {
            // Silent fail
        }
    }

    /**
     * Start auto-claim loop for all registered launches
     */
    startAutoClaimLoop(intervalMs = 10 * 60 * 1000) {
        console.log(`\n[FEE-ROUTER] Starting auto-claim loop (every ${intervalMs / 60000} min)`);

        setInterval(async () => {
            for (const mint of this.launches.keys()) {
                try {
                    await this.claimAndProcess(mint);
                } catch (e) {
                    console.error(`[FEE-ROUTER] Auto-claim error for ${mint.slice(0, 8)}...: ${e.message}`);
                }
            }
        }, intervalMs);
    }

    /**
     * Start holder distribution loop
     */
    startDistributionLoop(intervalMs = 60 * 60 * 1000) {
        console.log(`[FEE-ROUTER] Starting distribution loop (every ${intervalMs / 60000} min)`);

        setInterval(async () => {
            try {
                await this.distributeToHolders();
            } catch (e) {
                console.error(`[FEE-ROUTER] Distribution error: ${e.message}`);
            }
        }, intervalMs);
    }
}

// ═══════════════════════════════════════════════════════════════════
// EXPORTS
// ═══════════════════════════════════════════════════════════════════

module.exports = {
    FeeRouter,
    FEE_CONFIG,
};
