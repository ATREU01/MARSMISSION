/**
 * HELIUS SERVICE - Real-time Solana Data via Helius RPC
 *
 * Provides:
 * - Token data fetching (metadata, holders, volume)
 * - Bonding curve state parsing
 * - Real-time WebSocket subscriptions
 * - Transaction history and parsing
 * - DAS API for enriched token data
 */

const { Connection, PublicKey } = require('@solana/web3.js');
const WebSocket = require('ws');

// ═══════════════════════════════════════════════════════════════════
// CONFIGURATION
// ═══════════════════════════════════════════════════════════════════

const HELIUS_CONFIG = {
    API_KEY: process.env.HELIUS_API_KEY || '',
    RPC_URL: 'https://mainnet.helius-rpc.com',
    WS_URL: 'wss://mainnet.helius-rpc.com',
    API_URL: 'https://api.helius.xyz/v0',

    // Program IDs
    PUMP_PROGRAM_ID: '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P',
    PUMPSWAP_PROGRAM_ID: 'pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA',
    TOKEN_PROGRAM_ID: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
    TOKEN_2022_PROGRAM_ID: 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb',

    // Launchpad settings
    GRADUATION_SOL: 85,
    BONDING_CURVE_SIZE: 165,
};

// ═══════════════════════════════════════════════════════════════════
// HELIUS SERVICE CLASS
// ═══════════════════════════════════════════════════════════════════

class HeliusService {
    constructor(apiKey) {
        this.apiKey = apiKey || HELIUS_CONFIG.API_KEY;
        this.rpcUrl = `${HELIUS_CONFIG.RPC_URL}/?api-key=${this.apiKey}`;
        this.wsUrl = `${HELIUS_CONFIG.WS_URL}/?api-key=${this.apiKey}`;
        this.apiUrl = HELIUS_CONFIG.API_URL;
        this.connection = null;
        this.wsConnection = null;
        this.subscriptions = new Map();
        this.cache = new Map();
        this.cacheTTL = 30000; // 30 seconds
    }

    /**
     * Initialize connection
     */
    async init() {
        if (!this.apiKey) {
            console.log('[HELIUS] No API key - some features unavailable');
            return false;
        }

        try {
            this.connection = new Connection(this.rpcUrl, 'confirmed');
            const slot = await this.connection.getSlot();
            console.log(`[HELIUS] Connected - Slot: ${slot}`);
            return true;
        } catch (e) {
            console.error(`[HELIUS] Connection failed: ${e.message}`);
            return false;
        }
    }

    /**
     * Make RPC call to Helius
     */
    async rpc(method, params = []) {
        const response = await fetch(this.rpcUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                jsonrpc: '2.0',
                id: Date.now(),
                method,
                params,
            }),
        });

        const json = await response.json();
        if (json.error) throw new Error(json.error.message);
        return json.result;
    }

    /**
     * Make API call to Helius
     */
    async api(endpoint, options = {}) {
        const url = `${this.apiUrl}${endpoint}?api-key=${this.apiKey}`;
        const response = await fetch(url, {
            method: options.method || 'GET',
            headers: { 'Content-Type': 'application/json', ...options.headers },
            body: options.body ? JSON.stringify(options.body) : undefined,
        });

        return response.json();
    }

    // ─────────────────────────────────────────────────────────────────
    // TOKEN DATA
    // ─────────────────────────────────────────────────────────────────

    /**
     * Get token metadata via DAS
     */
    async getAsset(mint) {
        const cacheKey = `asset:${mint}`;
        const cached = this.getCache(cacheKey);
        if (cached) return cached;

        try {
            const result = await this.rpc('getAsset', { id: mint });
            this.setCache(cacheKey, result);
            return result;
        } catch (e) {
            return null;
        }
    }

    /**
     * Get multiple assets
     */
    async getAssetBatch(mints) {
        try {
            const result = await this.rpc('getAssetBatch', { ids: mints });
            return result || [];
        } catch (e) {
            return [];
        }
    }

    /**
     * Get token accounts for a wallet
     */
    async getTokenAccounts(wallet) {
        try {
            const result = await this.rpc('getAssetsByOwner', {
                ownerAddress: wallet,
                page: 1,
                limit: 100,
                displayOptions: {
                    showFungible: true,
                    showNativeBalance: true,
                },
            });
            return result;
        } catch (e) {
            return null;
        }
    }

    /**
     * Get token holders
     */
    async getTokenHolders(mint, limit = 100) {
        try {
            // Use getProgramAccounts to find all token accounts for this mint
            const accounts = await this.connection.getProgramAccounts(
                new PublicKey(HELIUS_CONFIG.TOKEN_2022_PROGRAM_ID),
                {
                    filters: [
                        { dataSize: 165 },
                        { memcmp: { offset: 0, bytes: mint } },
                    ],
                }
            );

            const holders = [];
            for (const { account, pubkey } of accounts) {
                const owner = new PublicKey(account.data.slice(32, 64));
                const amount = account.data.readBigUInt64LE(64);
                if (amount > 0n) {
                    holders.push({
                        address: owner.toBase58(),
                        tokenAccount: pubkey.toBase58(),
                        balance: Number(amount),
                    });
                }
            }

            // Sort by balance descending
            holders.sort((a, b) => b.balance - a.balance);
            return holders.slice(0, limit);
        } catch (e) {
            console.error(`[HELIUS] Get holders error: ${e.message}`);
            return [];
        }
    }

    // ─────────────────────────────────────────────────────────────────
    // BONDING CURVE DATA
    // ─────────────────────────────────────────────────────────────────

    /**
     * Get all bonding curves from Pump.fun program
     */
    async getBondingCurves() {
        try {
            const accounts = await this.rpc('getProgramAccounts', [
                HELIUS_CONFIG.PUMP_PROGRAM_ID,
                {
                    encoding: 'base64',
                    commitment: 'confirmed',
                },
            ]);

            const curves = [];
            for (const acc of accounts || []) {
                const parsed = this.parseBondingCurve(acc.account.data[0]);
                if (parsed) {
                    curves.push({
                        pubkey: acc.pubkey,
                        ...parsed,
                    });
                }
            }

            return curves;
        } catch (e) {
            console.error(`[HELIUS] Get curves error: ${e.message}`);
            return [];
        }
    }

    /**
     * Parse bonding curve account data
     * Structure varies - adjust offsets based on actual program IDL
     */
    parseBondingCurve(base64Data) {
        try {
            const buffer = Buffer.from(base64Data, 'base64');
            if (buffer.length < 120) return null;

            // These offsets need to match your program's account structure
            // Adjust based on your IDL
            const mint = new PublicKey(buffer.slice(8, 40)).toBase58();
            const creator = new PublicKey(buffer.slice(40, 72)).toBase58();
            const virtualSolReserves = Number(buffer.readBigUInt64LE(72)) / 1e9;
            const virtualTokenReserves = Number(buffer.readBigUInt64LE(80)) / 1e6;
            const realSolReserves = Number(buffer.readBigUInt64LE(88)) / 1e9;
            const realTokenReserves = Number(buffer.readBigUInt64LE(96)) / 1e6;
            const totalSupply = Number(buffer.readBigUInt64LE(104)) / 1e6;

            // Calculate price and progress
            const price = virtualSolReserves / virtualTokenReserves;
            const mcap = price * totalSupply;
            const progress = Math.min((realSolReserves / HELIUS_CONFIG.GRADUATION_SOL) * 100, 100);
            const graduated = progress >= 100;

            return {
                mint,
                creator,
                virtualSolReserves,
                virtualTokenReserves,
                realSolReserves,
                realTokenReserves,
                totalSupply,
                price,
                mcap,
                progress,
                graduated,
            };
        } catch (e) {
            return null;
        }
    }

    // ─────────────────────────────────────────────────────────────────
    // TRANSACTIONS
    // ─────────────────────────────────────────────────────────────────

    /**
     * Get parsed transactions for an address
     */
    async getTransactions(address, limit = 50) {
        try {
            const result = await this.api(`/addresses/${address}/transactions`, {
                method: 'GET',
            });
            return result?.slice(0, limit) || [];
        } catch (e) {
            return [];
        }
    }

    /**
     * Parse a single transaction
     */
    async parseTransaction(signature) {
        try {
            const result = await this.api('/transactions', {
                method: 'POST',
                body: { transactions: [signature] },
            });
            return result?.[0] || null;
        } catch (e) {
            return null;
        }
    }

    /**
     * Get transaction signatures for an address
     */
    async getSignatures(address, limit = 100) {
        try {
            return await this.rpc('getSignaturesForAddress', [
                address,
                { limit, commitment: 'confirmed' },
            ]);
        } catch (e) {
            return [];
        }
    }

    // ─────────────────────────────────────────────────────────────────
    // WEBSOCKET SUBSCRIPTIONS
    // ─────────────────────────────────────────────────────────────────

    /**
     * Connect WebSocket
     */
    connectWebSocket() {
        if (this.wsConnection) return;

        this.wsConnection = new WebSocket(this.wsUrl);

        this.wsConnection.on('open', () => {
            console.log('[HELIUS] WebSocket connected');
        });

        this.wsConnection.on('message', (data) => {
            try {
                const msg = JSON.parse(data.toString());
                if (msg.method === 'logsNotification') {
                    const subId = msg.params?.subscription;
                    const callback = this.subscriptions.get(subId);
                    if (callback) callback(msg.params.result);
                }
            } catch (e) {
                // Ignore parse errors
            }
        });

        this.wsConnection.on('close', () => {
            console.log('[HELIUS] WebSocket closed');
            this.wsConnection = null;
            // Reconnect after 5 seconds
            setTimeout(() => this.connectWebSocket(), 5000);
        });

        this.wsConnection.on('error', (e) => {
            console.error(`[HELIUS] WebSocket error: ${e.message}`);
        });
    }

    /**
     * Subscribe to program logs
     */
    subscribeLogs(programId, callback) {
        if (!this.wsConnection) this.connectWebSocket();

        const subId = Date.now();
        this.subscriptions.set(subId, callback);

        this.wsConnection.send(JSON.stringify({
            jsonrpc: '2.0',
            id: subId,
            method: 'logsSubscribe',
            params: [
                { mentions: [programId] },
                { commitment: 'confirmed' },
            ],
        }));

        return () => {
            this.subscriptions.delete(subId);
        };
    }

    /**
     * Subscribe to account changes
     */
    subscribeAccount(address, callback) {
        if (!this.connection) return null;

        return this.connection.onAccountChange(
            new PublicKey(address),
            callback,
            'confirmed'
        );
    }

    // ─────────────────────────────────────────────────────────────────
    // WEBHOOKS (Enhanced Transaction Parsing)
    // ─────────────────────────────────────────────────────────────────

    /**
     * Create a webhook for transaction notifications
     */
    async createWebhook(config) {
        try {
            return await this.api('/webhooks', {
                method: 'POST',
                body: {
                    webhookURL: config.url,
                    transactionTypes: config.types || ['ANY'],
                    accountAddresses: config.addresses || [],
                    webhookType: config.type || 'enhanced',
                    txnStatus: 'all',
                },
            });
        } catch (e) {
            console.error(`[HELIUS] Webhook error: ${e.message}`);
            return null;
        }
    }

    // ─────────────────────────────────────────────────────────────────
    // CACHING
    // ─────────────────────────────────────────────────────────────────

    getCache(key) {
        const entry = this.cache.get(key);
        if (!entry) return null;
        if (Date.now() - entry.timestamp > this.cacheTTL) {
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

    // ─────────────────────────────────────────────────────────────────
    // LAUNCHPAD SPECIFIC
    // ─────────────────────────────────────────────────────────────────

    /**
     * Get launchpad tokens with full data
     */
    async getLaunchpadTokens(programId) {
        const curves = await this.getBondingCurves();
        if (!curves.length) return [];

        // Get metadata for all mints
        const mints = curves.map(c => c.mint);
        const metadata = await this.getAssetBatch(mints);

        // Merge metadata with curve data
        const metaMap = new Map();
        for (const meta of metadata) {
            if (meta?.id) metaMap.set(meta.id, meta);
        }

        return curves.map(curve => {
            const meta = metaMap.get(curve.mint);
            return {
                ...curve,
                name: meta?.content?.metadata?.name || 'Unknown',
                symbol: meta?.content?.metadata?.symbol || '???',
                image: meta?.content?.links?.image || null,
                description: meta?.content?.metadata?.description || '',
            };
        }).sort((a, b) => b.mcap - a.mcap);
    }

    /**
     * Get activity feed for program
     */
    async getActivityFeed(programId, limit = 50) {
        const txs = await this.getTransactions(programId, limit);

        return txs.map(tx => {
            // Detect transaction type from description or instructions
            let type = 'unknown';
            const desc = tx.description?.toLowerCase() || '';

            if (desc.includes('buy') || desc.includes('swap')) type = 'buy';
            else if (desc.includes('sell')) type = 'sell';
            else if (desc.includes('create') || desc.includes('init')) type = 'create';
            else if (desc.includes('claim')) type = 'claim';

            return {
                signature: tx.signature,
                type,
                timestamp: tx.timestamp,
                fee: tx.fee,
                feePayer: tx.feePayer,
                amount: tx.nativeTransfers?.[0]?.amount / 1e9 || 0,
                description: tx.description,
            };
        });
    }

    /**
     * Get volume stats
     */
    async getVolumeStats(programId, hours = 24) {
        const txs = await this.getTransactions(programId, 1000);
        const cutoff = Date.now() / 1000 - hours * 3600;

        const recentTxs = txs.filter(tx => tx.timestamp > cutoff);

        let volume = 0;
        let buys = 0;
        let sells = 0;

        for (const tx of recentTxs) {
            const amount = tx.nativeTransfers?.[0]?.amount / 1e9 || 0;
            volume += amount;

            const desc = tx.description?.toLowerCase() || '';
            if (desc.includes('buy')) buys++;
            if (desc.includes('sell')) sells++;
        }

        return {
            volume,
            transactions: recentTxs.length,
            buys,
            sells,
            hours,
        };
    }
}

// ═══════════════════════════════════════════════════════════════════
// EXPORTS
// ═══════════════════════════════════════════════════════════════════

module.exports = {
    HeliusService,
    HELIUS_CONFIG,
};
