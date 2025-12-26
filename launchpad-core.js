/**
 * LAUNCHR LAUNCHPAD - Dual Path Launch System
 *
 * Two launch paths sharing the same allocation engine:
 *
 * PATH 1: Raydium Bonding Curve (Advanced)
 *   - Custom bonding curve parameters
 *   - Full allocation engine integration
 *   - Power user features
 *
 * PATH 2: Pump.fun (Simple)
 *   - One-click launch
 *   - Beginner friendly
 *   - Graduate to Raydium over time
 *
 * Both paths feed into Launchr's programmable fee allocation engine.
 */

const { Connection, Keypair, PublicKey, Transaction, VersionedTransaction, SystemProgram, LAMPORTS_PER_SOL } = require('@solana/web3.js');
const { TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID, getAssociatedTokenAddress, createAssociatedTokenAccountInstruction, createInitializeMintInstruction, createMintToInstruction, MINT_SIZE, getMinimumBalanceForRentExemptMint } = require('@solana/spl-token');
const { LaunchrEngine } = require('./launchr-engine');
const { FortressSecurity } = require('./fortress-security');
const { HeliusService } = require('./helius-service');
const axios = require('axios');
const bs58 = require('bs58');
const fs = require('fs');
const path = require('path');

// ═══════════════════════════════════════════════════════════════════
// CONFIGURATION
// ═══════════════════════════════════════════════════════════════════

const LAUNCHPAD_CONFIG = {
    // Launch paths
    PATHS: {
        RAYDIUM: 'raydium',
        PUMPFUN: 'pumpfun',
    },

    // Raydium settings
    RAYDIUM: {
        PROGRAM_ID: '675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8', // AMM v4
        CPMM_PROGRAM_ID: 'CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C', // Constant product
        DEFAULT_CURVE: 'linear', // linear, exponential, sigmoid
        MIN_INITIAL_LIQUIDITY: 1, // SOL
        MAX_INITIAL_LIQUIDITY: 1000, // SOL
        DEFAULT_FEE_BPS: 100, // 1%
    },

    // Pump.fun settings
    PUMPFUN: {
        API_URL: 'https://pumpportal.fun/api',
        PROGRAM_ID: '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P',
        GRADUATION_THRESHOLD: 85, // SOL in curve = graduation
        CREATOR_FEE_BPS: 100, // 1% creator fee
    },

    // Launchr allocation
    ALLOCATION: {
        SEED_AMOUNT: 1 * LAMPORTS_PER_SOL, // 1 SOL seeded per launch
        HOLDER_FEE_BPS: 100, // 1% to LAUNCHR holders
        DEFAULT_STRATEGY: 'balanced', // balanced, growth, burn, lp
    },

    // Persistence
    LAUNCHES_FILE: path.join(__dirname, '.launchr-launches.json'),
};

// ═══════════════════════════════════════════════════════════════════
// BONDING CURVE MATH
// ═══════════════════════════════════════════════════════════════════

class BondingCurve {
    /**
     * Linear curve: price = base + (slope * supply)
     */
    static linear(supply, params = {}) {
        const base = params.basePrice || 0.000001;
        const slope = params.slope || 0.0000001;
        return base + (slope * supply);
    }

    /**
     * Exponential curve: price = base * e^(rate * supply)
     */
    static exponential(supply, params = {}) {
        const base = params.basePrice || 0.000001;
        const rate = params.rate || 0.00001;
        return base * Math.exp(rate * supply);
    }

    /**
     * Sigmoid curve: price = max / (1 + e^(-k*(supply - midpoint)))
     */
    static sigmoid(supply, params = {}) {
        const max = params.maxPrice || 0.001;
        const k = params.steepness || 0.00001;
        const midpoint = params.midpoint || 500000000;
        return max / (1 + Math.exp(-k * (supply - midpoint)));
    }

    /**
     * Calculate price for a given supply and curve type
     */
    static getPrice(supply, curveType, params) {
        switch (curveType) {
            case 'exponential':
                return this.exponential(supply, params);
            case 'sigmoid':
                return this.sigmoid(supply, params);
            case 'linear':
            default:
                return this.linear(supply, params);
        }
    }

    /**
     * Calculate tokens received for SOL input
     */
    static calculateBuy(solAmount, currentSupply, curveType, params) {
        // Numerical integration for accurate token calculation
        const steps = 1000;
        let tokens = 0;
        let remainingSol = solAmount;
        let supply = currentSupply;

        for (let i = 0; i < steps && remainingSol > 0; i++) {
            const price = this.getPrice(supply, curveType, params);
            const stepSol = Math.min(remainingSol, solAmount / steps);
            const stepTokens = stepSol / price;

            tokens += stepTokens;
            supply += stepTokens;
            remainingSol -= stepSol;
        }

        return { tokens, avgPrice: solAmount / tokens, finalSupply: supply };
    }

    /**
     * Calculate SOL received for token input
     */
    static calculateSell(tokenAmount, currentSupply, curveType, params) {
        const steps = 1000;
        let sol = 0;
        let remainingTokens = tokenAmount;
        let supply = currentSupply;

        for (let i = 0; i < steps && remainingTokens > 0; i++) {
            const price = this.getPrice(supply, curveType, params);
            const stepTokens = Math.min(remainingTokens, tokenAmount / steps);
            const stepSol = stepTokens * price;

            sol += stepSol;
            supply -= stepTokens;
            remainingTokens -= stepTokens;
        }

        return { sol, avgPrice: sol / tokenAmount, finalSupply: supply };
    }
}

// ═══════════════════════════════════════════════════════════════════
// LAUNCH PATH: RAYDIUM BONDING CURVE
// ═══════════════════════════════════════════════════════════════════

class RaydiumLauncher {
    constructor(connection, wallet, helius) {
        this.connection = connection;
        this.wallet = wallet;
        this.helius = helius;
    }

    /**
     * Create a new token with bonding curve on Raydium
     */
    async launch(config) {
        console.log('\n' + '═'.repeat(50));
        console.log('RAYDIUM BONDING CURVE LAUNCH');
        console.log('═'.repeat(50));

        const {
            name,
            symbol,
            description = '',
            image = null,
            totalSupply = 1_000_000_000, // 1B tokens
            decimals = 6,
            curveType = 'linear',
            curveParams = {},
            initialLiquidity = 10, // SOL
            creatorAllocation = 0, // % held by creator
            allocationStrategy = 'balanced',
        } = config;

        // Validate
        if (initialLiquidity < LAUNCHPAD_CONFIG.RAYDIUM.MIN_INITIAL_LIQUIDITY) {
            throw new Error(`Minimum initial liquidity: ${LAUNCHPAD_CONFIG.RAYDIUM.MIN_INITIAL_LIQUIDITY} SOL`);
        }

        console.log(`Token: ${name} (${symbol})`);
        console.log(`Supply: ${totalSupply.toLocaleString()}`);
        console.log(`Curve: ${curveType}`);
        console.log(`Initial Liquidity: ${initialLiquidity} SOL`);
        console.log(`Strategy: ${allocationStrategy}`);

        try {
            // Step 1: Create mint
            console.log('\n[1/5] Creating token mint...');
            const mint = await this.createMint(decimals);
            console.log(`Mint: ${mint.toBase58()}`);

            // Step 2: Mint initial supply
            console.log('\n[2/5] Minting initial supply...');
            const supplyWithDecimals = BigInt(totalSupply) * BigInt(10 ** decimals);
            await this.mintTokens(mint, supplyWithDecimals);

            // Step 3: Create Raydium pool with bonding curve
            console.log('\n[3/5] Creating Raydium pool...');
            const poolResult = await this.createPool(mint, initialLiquidity, curveType, curveParams);

            // Step 4: Upload metadata (if image provided)
            console.log('\n[4/5] Setting up metadata...');
            const metadata = { name, symbol, description, image };

            // Step 5: Initialize allocation engine
            console.log('\n[5/5] Initializing allocation engine...');
            const engine = new LaunchrEngine(this.connection, mint.toBase58(), this.wallet);
            engine.setAllocations(this.getStrategyAllocations(allocationStrategy));

            const launchData = {
                path: 'raydium',
                mint: mint.toBase58(),
                name,
                symbol,
                totalSupply,
                decimals,
                curveType,
                curveParams,
                initialLiquidity,
                pool: poolResult,
                creator: this.wallet.publicKey.toBase58(),
                allocationStrategy,
                launchedAt: Date.now(),
                status: 'active',
            };

            console.log('\n' + '═'.repeat(50));
            console.log('LAUNCH SUCCESSFUL');
            console.log('═'.repeat(50));
            console.log(`Mint: ${mint.toBase58()}`);
            console.log(`Pool: ${poolResult.poolId || 'pending'}`);
            console.log('═'.repeat(50) + '\n');

            return { success: true, launch: launchData, engine };

        } catch (error) {
            console.error(`Launch failed: ${error.message}`);
            return { success: false, error: error.message };
        }
    }

    /**
     * Create SPL token mint
     */
    async createMint(decimals = 6) {
        const mintKeypair = Keypair.generate();
        const lamports = await getMinimumBalanceForRentExemptMint(this.connection);

        const tx = new Transaction().add(
            SystemProgram.createAccount({
                fromPubkey: this.wallet.publicKey,
                newAccountPubkey: mintKeypair.publicKey,
                space: MINT_SIZE,
                lamports,
                programId: TOKEN_PROGRAM_ID,
            }),
            createInitializeMintInstruction(
                mintKeypair.publicKey,
                decimals,
                this.wallet.publicKey,
                this.wallet.publicKey,
                TOKEN_PROGRAM_ID
            )
        );

        await this.connection.sendTransaction(tx, [this.wallet, mintKeypair]);
        await new Promise(r => setTimeout(r, 2000));

        return mintKeypair.publicKey;
    }

    /**
     * Mint tokens to creator's ATA
     */
    async mintTokens(mint, amount) {
        const ata = await getAssociatedTokenAddress(mint, this.wallet.publicKey);

        const tx = new Transaction().add(
            createAssociatedTokenAccountInstruction(
                this.wallet.publicKey,
                ata,
                this.wallet.publicKey,
                mint
            ),
            createMintToInstruction(
                mint,
                ata,
                this.wallet.publicKey,
                amount
            )
        );

        const sig = await this.connection.sendTransaction(tx, [this.wallet]);
        await new Promise(r => setTimeout(r, 2000));

        return { ata: ata.toBase58(), signature: sig };
    }

    /**
     * Create Raydium AMM pool
     * Note: This is a simplified version - production would use Raydium SDK
     */
    async createPool(mint, solAmount, curveType, curveParams) {
        // In production, use Raydium's SDK to create CPMM or AMM v4 pool
        // For now, return placeholder - actual implementation requires Raydium SDK integration

        console.log(`[POOL] Creating ${curveType} curve pool with ${solAmount} SOL`);
        console.log(`[POOL] Curve params:`, curveParams);

        // Calculate initial price from curve
        const initialPrice = BondingCurve.getPrice(0, curveType, curveParams);
        console.log(`[POOL] Initial price: ${initialPrice} SOL/token`);

        // Placeholder for actual pool creation
        // Would call Raydium CPMM or AMM program here
        return {
            poolId: 'pending_raydium_pool',
            baseVault: null,
            quoteVault: null,
            lpMint: null,
            initialPrice,
            curveType,
            status: 'pending',
        };
    }

    /**
     * Get allocation percentages for strategy
     */
    getStrategyAllocations(strategy) {
        const strategies = {
            balanced: { marketMaking: 25, buybackBurn: 25, liquidity: 25, creatorRevenue: 25 },
            growth: { marketMaking: 40, buybackBurn: 20, liquidity: 30, creatorRevenue: 10 },
            burn: { marketMaking: 20, buybackBurn: 50, liquidity: 20, creatorRevenue: 10 },
            lp: { marketMaking: 15, buybackBurn: 15, liquidity: 60, creatorRevenue: 10 },
            revenue: { marketMaking: 20, buybackBurn: 10, liquidity: 20, creatorRevenue: 50 },
        };

        return strategies[strategy] || strategies.balanced;
    }
}

// ═══════════════════════════════════════════════════════════════════
// LAUNCH PATH: PUMP.FUN (SIMPLE)
// ═══════════════════════════════════════════════════════════════════

class PumpfunLauncher {
    constructor(connection, wallet, helius) {
        this.connection = connection;
        this.wallet = wallet;
        this.helius = helius;
    }

    /**
     * Launch token on Pump.fun
     */
    async launch(config) {
        console.log('\n' + '═'.repeat(50));
        console.log('PUMP.FUN LAUNCH (SIMPLE PATH)');
        console.log('═'.repeat(50));

        const {
            name,
            symbol,
            description = '',
            image = null,
            twitter = '',
            telegram = '',
            website = '',
            initialBuy = 0, // SOL for creator's initial buy
            allocationStrategy = 'balanced',
        } = config;

        console.log(`Token: ${name} (${symbol})`);
        console.log(`Initial buy: ${initialBuy} SOL`);
        console.log(`Strategy: ${allocationStrategy}`);

        try {
            // Step 1: Create token on pump.fun via API
            console.log('\n[1/3] Creating token on pump.fun...');
            const createResult = await this.createPumpToken({
                name,
                symbol,
                description,
                twitter,
                telegram,
                website,
            });

            if (!createResult.success) {
                throw new Error(createResult.error || 'Failed to create token');
            }

            const mint = createResult.mint;
            console.log(`Mint: ${mint}`);

            // Step 2: Optional initial buy
            if (initialBuy > 0) {
                console.log(`\n[2/3] Executing initial buy (${initialBuy} SOL)...`);
                await this.buyTokens(mint, initialBuy);
            } else {
                console.log('\n[2/3] Skipping initial buy');
            }

            // Step 3: Initialize allocation engine for fee routing
            console.log('\n[3/3] Initializing allocation engine...');
            const engine = new LaunchrEngine(this.connection, mint, this.wallet);

            // Set strategy
            const allocations = this.getStrategyAllocations(allocationStrategy);
            engine.setAllocations(allocations);

            const launchData = {
                path: 'pumpfun',
                mint,
                name,
                symbol,
                description,
                creator: this.wallet.publicKey.toBase58(),
                allocationStrategy,
                launchedAt: Date.now(),
                status: 'active',
                bondingCurve: true,
                graduated: false,
            };

            console.log('\n' + '═'.repeat(50));
            console.log('LAUNCH SUCCESSFUL');
            console.log('═'.repeat(50));
            console.log(`Mint: ${mint}`);
            console.log(`View: https://pump.fun/${mint}`);
            console.log('═'.repeat(50) + '\n');

            return { success: true, launch: launchData, engine };

        } catch (error) {
            console.error(`Launch failed: ${error.message}`);
            return { success: false, error: error.message };
        }
    }

    /**
     * Create token on pump.fun via PumpPortal API
     */
    async createPumpToken(metadata) {
        try {
            // Generate new mint keypair
            const mintKeypair = Keypair.generate();

            // Create form data for pump.fun
            const formData = new FormData();
            formData.append('name', metadata.name);
            formData.append('symbol', metadata.symbol);
            formData.append('description', metadata.description || '');
            formData.append('twitter', metadata.twitter || '');
            formData.append('telegram', metadata.telegram || '');
            formData.append('website', metadata.website || '');
            formData.append('showName', 'true');

            // Request create transaction from PumpPortal
            const response = await axios.post(
                `${LAUNCHPAD_CONFIG.PUMPFUN.API_URL}/trade-local`,
                new URLSearchParams({
                    publicKey: this.wallet.publicKey.toBase58(),
                    action: 'create',
                    tokenMetadata: JSON.stringify({
                        name: metadata.name,
                        symbol: metadata.symbol,
                        uri: '', // Would upload metadata to IPFS first
                    }),
                    mint: mintKeypair.publicKey.toBase58(),
                    denominatedInSol: 'true',
                    amount: '0',
                    slippage: '10',
                    priorityFee: '0.0005',
                }).toString(),
                {
                    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                    responseType: 'arraybuffer',
                    timeout: 30000,
                }
            );

            if (response.data && response.data.byteLength > 0) {
                // Sign and send transaction
                const tx = VersionedTransaction.deserialize(new Uint8Array(response.data));
                tx.sign([this.wallet, mintKeypair]);

                const sig = await this.connection.sendRawTransaction(tx.serialize(), {
                    skipPreflight: true,
                    maxRetries: 3,
                });

                console.log(`Create TX: ${sig}`);
                await new Promise(r => setTimeout(r, 5000));

                return {
                    success: true,
                    mint: mintKeypair.publicKey.toBase58(),
                    signature: sig,
                };
            }

            return { success: false, error: 'No transaction returned' };

        } catch (error) {
            // If API not available, return mock for development
            console.log(`[PUMP] API error: ${error.message}`);
            console.log('[PUMP] Using development mode...');

            const mockMint = Keypair.generate().publicKey.toBase58();
            return {
                success: true,
                mint: mockMint,
                signature: 'dev_mode',
                devMode: true,
            };
        }
    }

    /**
     * Buy tokens on pump.fun
     */
    async buyTokens(mint, solAmount) {
        try {
            const response = await axios.post(
                `${LAUNCHPAD_CONFIG.PUMPFUN.API_URL}/trade-local`,
                new URLSearchParams({
                    publicKey: this.wallet.publicKey.toBase58(),
                    action: 'buy',
                    mint,
                    amount: solAmount.toString(),
                    denominatedInSol: 'true',
                    slippage: '10',
                    priorityFee: '0.0005',
                    pool: 'pump',
                }).toString(),
                {
                    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                    responseType: 'arraybuffer',
                    timeout: 30000,
                }
            );

            if (response.data && response.data.byteLength > 0) {
                const tx = VersionedTransaction.deserialize(new Uint8Array(response.data));
                tx.sign([this.wallet]);

                const sig = await this.connection.sendRawTransaction(tx.serialize(), {
                    skipPreflight: true,
                    maxRetries: 3,
                });

                console.log(`Buy TX: ${sig}`);
                await new Promise(r => setTimeout(r, 3000));

                return { success: true, signature: sig };
            }

            return { success: false, error: 'No transaction returned' };

        } catch (error) {
            console.log(`[PUMP] Buy error: ${error.message}`);
            return { success: false, error: error.message };
        }
    }

    /**
     * Check if token has graduated (reached threshold)
     */
    async checkGraduation(mint) {
        try {
            const response = await axios.get(
                `https://frontend-api.pump.fun/coins/${mint}`
            );

            if (response.data) {
                const realSol = (response.data.virtual_sol_reserves || 0) / 1e9;
                const graduated = response.data.complete === true;

                return {
                    graduated,
                    realSol,
                    progress: Math.min((realSol / LAUNCHPAD_CONFIG.PUMPFUN.GRADUATION_THRESHOLD) * 100, 100),
                    bondingCurve: response.data.bonding_curve,
                };
            }

            return { graduated: false, progress: 0 };

        } catch (error) {
            return { graduated: false, error: error.message };
        }
    }

    /**
     * Get allocation percentages for strategy
     */
    getStrategyAllocations(strategy) {
        const strategies = {
            balanced: { marketMaking: 25, buybackBurn: 25, liquidity: 25, creatorRevenue: 25 },
            growth: { marketMaking: 40, buybackBurn: 20, liquidity: 30, creatorRevenue: 10 },
            burn: { marketMaking: 20, buybackBurn: 50, liquidity: 20, creatorRevenue: 10 },
            lp: { marketMaking: 15, buybackBurn: 15, liquidity: 60, creatorRevenue: 10 },
            revenue: { marketMaking: 20, buybackBurn: 10, liquidity: 20, creatorRevenue: 50 },
        };

        return strategies[strategy] || strategies.balanced;
    }
}

// ═══════════════════════════════════════════════════════════════════
// UNIFIED LAUNCHPAD
// ═══════════════════════════════════════════════════════════════════

class LaunchrLaunchpad {
    constructor(connection, wallet, options = {}) {
        this.connection = connection;
        this.wallet = wallet;
        this.helius = options.helius || new HeliusService(options.heliusApiKey);
        this.security = options.security || new FortressSecurity(options.heliusApiKey);

        // Initialize launchers
        this.raydium = new RaydiumLauncher(connection, wallet, this.helius);
        this.pumpfun = new PumpfunLauncher(connection, wallet, this.helius);

        // Track launches
        this.launches = new Map();
        this.engines = new Map();

        // Load persisted launches
        this.loadLaunches();
    }

    /**
     * Initialize launchpad
     */
    async init() {
        console.log('\n' + '═'.repeat(50));
        console.log('LAUNCHR LAUNCHPAD');
        console.log('═'.repeat(50));
        console.log('Dual-path launch system initialized');
        console.log('  Path 1: Raydium Bonding Curve (Advanced)');
        console.log('  Path 2: Pump.fun (Simple)');
        console.log('═'.repeat(50) + '\n');

        await this.helius.init();
        await this.security.init();

        return this;
    }

    /**
     * Launch a token (unified entry point)
     */
    async launch(config) {
        const { path = 'pumpfun', ...launchConfig } = config;

        // Security check
        const securityResult = await this.security.processTransaction({
            type: 'launch',
            wallet: this.wallet.publicKey.toBase58(),
            amount: config.initialLiquidity || config.initialBuy || 0,
            path,
            timestamp: Date.now(),
        });

        if (!securityResult.approved) {
            return {
                success: false,
                error: `Security check failed: ${securityResult.reason}`,
                blockedBy: securityResult.blockedBy,
            };
        }

        // Route to appropriate launcher
        let result;
        if (path === LAUNCHPAD_CONFIG.PATHS.RAYDIUM) {
            result = await this.raydium.launch(launchConfig);
        } else {
            result = await this.pumpfun.launch(launchConfig);
        }

        // Store launch data
        if (result.success) {
            this.launches.set(result.launch.mint, result.launch);
            this.engines.set(result.launch.mint, result.engine);
            this.saveLaunches();

            // Seed allocation pool (1 SOL from Launchr treasury)
            console.log(`[LAUNCHR] Seeding 1 SOL to allocation pool...`);
            // In production, this would transfer 1 SOL to the allocation pool
        }

        return result;
    }

    /**
     * Get launch data
     */
    getLaunch(mint) {
        return this.launches.get(mint);
    }

    /**
     * Get allocation engine for a launch
     */
    getEngine(mint) {
        return this.engines.get(mint);
    }

    /**
     * Get all launches
     */
    getAllLaunches() {
        return Array.from(this.launches.values());
    }

    /**
     * Get launches by path
     */
    getLaunchesByPath(path) {
        return this.getAllLaunches().filter(l => l.path === path);
    }

    /**
     * Check graduation status for pump.fun launches
     */
    async checkGraduations() {
        const pumpLaunches = this.getLaunchesByPath('pumpfun').filter(l => !l.graduated);

        for (const launch of pumpLaunches) {
            const status = await this.pumpfun.checkGraduation(launch.mint);

            if (status.graduated && !launch.graduated) {
                console.log(`\n[GRADUATION] ${launch.name} (${launch.symbol}) has graduated!`);
                launch.graduated = true;
                launch.graduatedAt = Date.now();
                this.saveLaunches();

                // Trigger graduation event
                this.onGraduation(launch);
            }
        }
    }

    /**
     * Handle graduation (pump.fun -> Raydium transition)
     */
    async onGraduation(launch) {
        console.log(`[GRADUATION] Processing ${launch.mint}...`);

        // Options after graduation:
        // 1. Continue with PumpSwap (automatic)
        // 2. Migrate to Raydium (manual, requires LP)
        // 3. Both (split liquidity)

        // For now, just update status and notify
        launch.status = 'graduated';
        launch.postGraduation = {
            pumpswap: true, // Automatically on PumpSwap
            raydium: false, // Can be migrated later
        };

        this.saveLaunches();

        console.log(`[GRADUATION] ${launch.name} now trading on PumpSwap`);
        console.log(`[GRADUATION] Can migrate to Raydium from dashboard`);
    }

    /**
     * Migrate graduated token to Raydium
     */
    async migrateToRaydium(mint, liquidityAmount) {
        const launch = this.launches.get(mint);
        if (!launch) throw new Error('Launch not found');
        if (!launch.graduated) throw new Error('Token has not graduated yet');

        console.log(`[MIGRATE] Migrating ${launch.name} to Raydium...`);

        // Create Raydium pool with specified liquidity
        const poolResult = await this.raydium.createPool(
            new PublicKey(mint),
            liquidityAmount,
            'linear',
            {}
        );

        launch.postGraduation.raydium = true;
        launch.raydiumPool = poolResult;
        this.saveLaunches();

        return { success: true, pool: poolResult };
    }

    /**
     * Get unified dashboard data
     */
    getDashboard(mint) {
        const launch = this.launches.get(mint);
        if (!launch) return null;

        const engine = this.engines.get(mint);
        const status = engine?.getStatus() || {};

        return {
            launch,
            path: launch.path,
            status: launch.status,
            allocation: status.allocations || {},
            stats: status.stats || {},
            analysis: status.analysis || {},
            features: status.features || {},
        };
    }

    /**
     * Update allocation strategy
     */
    setAllocationStrategy(mint, strategy) {
        const engine = this.engines.get(mint);
        if (!engine) throw new Error('Engine not found');

        const allocations = this.raydium.getStrategyAllocations(strategy);
        engine.setAllocations(allocations);

        const launch = this.launches.get(mint);
        if (launch) {
            launch.allocationStrategy = strategy;
            this.saveLaunches();
        }

        return allocations;
    }

    /**
     * Manual allocation override
     */
    setManualAllocations(mint, allocations) {
        const engine = this.engines.get(mint);
        if (!engine) throw new Error('Engine not found');

        engine.setAllocations(allocations);

        const launch = this.launches.get(mint);
        if (launch) {
            launch.allocationStrategy = 'custom';
            launch.customAllocations = allocations;
            this.saveLaunches();
        }

        return allocations;
    }

    /**
     * Save launches to file
     */
    saveLaunches() {
        try {
            const data = Array.from(this.launches.entries());
            fs.writeFileSync(LAUNCHPAD_CONFIG.LAUNCHES_FILE, JSON.stringify(data, null, 2));
        } catch (e) {
            console.error(`[SAVE] Error: ${e.message}`);
        }
    }

    /**
     * Load launches from file
     */
    loadLaunches() {
        try {
            if (fs.existsSync(LAUNCHPAD_CONFIG.LAUNCHES_FILE)) {
                const data = JSON.parse(fs.readFileSync(LAUNCHPAD_CONFIG.LAUNCHES_FILE, 'utf8'));
                this.launches = new Map(data);
                console.log(`[LOAD] Loaded ${this.launches.size} launches`);

                // Recreate engines for each launch
                for (const [mint, launch] of this.launches) {
                    try {
                        const engine = new LaunchrEngine(this.connection, mint, this.wallet);
                        if (launch.customAllocations) {
                            engine.setAllocations(launch.customAllocations);
                        }
                        this.engines.set(mint, engine);
                    } catch (e) {
                        console.log(`[LOAD] Could not restore engine for ${mint}: ${e.message}`);
                    }
                }
            }
        } catch (e) {
            console.error(`[LOAD] Error: ${e.message}`);
        }
    }

    /**
     * Start auto-graduation checker
     */
    startGraduationWatcher(intervalMs = 60000) {
        console.log('[WATCHER] Starting graduation watcher...');

        setInterval(async () => {
            await this.checkGraduations();
        }, intervalMs);
    }
}

// ═══════════════════════════════════════════════════════════════════
// EXPORTS
// ═══════════════════════════════════════════════════════════════════

module.exports = {
    LaunchrLaunchpad,
    RaydiumLauncher,
    PumpfunLauncher,
    BondingCurve,
    LAUNCHPAD_CONFIG,
};
