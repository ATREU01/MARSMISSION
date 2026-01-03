// ═══════════════════════════════════════════════════════════════════════════
// LAUNCHR Bot v3.0 | Conversational Token Creation | Privy Integration
// ═══════════════════════════════════════════════════════════════════════════
const https = require('https');
const crypto = require('crypto');
const axios = require('axios');
const FormData = require('form-data');
const tracker = require('./tracker');
const sessions = require('./tg-sessions');
const { LaunchrEngine } = require('./launchr-engine');
const { Connection, Keypair, VersionedTransaction } = require('@solana/web3.js');
const bs58 = require('bs58');

// PumpPortal API endpoint
const PUMPPORTAL_API = 'https://pumpportal.fun/api';

console.log('═══════════════════════════════════════════════════════════════');
console.log('[TELEGRAM-BOT] v3.0 LOADED - CONVERSATIONAL CREATE FLOW');
console.log('═══════════════════════════════════════════════════════════════');

// ═══════════════════════════════════════════════════════════════════════════
// CONVERSATION STATE MANAGER
// Tracks multi-step flows like token creation
// ═══════════════════════════════════════════════════════════════════════════
const conversations = new Map(); // chatId -> { step, data, expiresAt }

const CONVERSATION_TIMEOUT = 30 * 60 * 1000; // 30 minutes

function getConversation(chatId) {
    const conv = conversations.get(chatId);
    if (conv && conv.expiresAt > Date.now()) {
        return conv;
    }
    conversations.delete(chatId);
    return null;
}

function setConversation(chatId, step, data = {}) {
    conversations.set(chatId, {
        step,
        data,
        expiresAt: Date.now() + CONVERSATION_TIMEOUT
    });
}

function clearConversation(chatId) {
    conversations.delete(chatId);
}

// Generate unique link token for Privy connection
function generateLinkToken() {
    return crypto.randomBytes(32).toString('hex');
}

// Store pending Privy links
const pendingPrivyLinks = new Map(); // token -> { chatId, expiresAt }

class LaunchrBot {
    constructor(token) {
        this.token = token;
        this.baseUrl = `https://api.telegram.org/bot${token}`;
        this.offset = 0;
        console.log('[TELEGRAM-BOT] LaunchrBot constructor called - v2.1');
        this.commands = {
            '/start': this.handleStart.bind(this),
            '/ping': this.handlePing.bind(this),
            '/create': this.handleCreate.bind(this),
            '/existing': this.handleExisting.bind(this),
            '/help': this.handleHelp.bind(this),
            '/track': this.handleTrack.bind(this),
            '/stats': this.handleStats.bind(this),
            '/recent': this.handleRecent.bind(this),
            '/launch': this.handleLaunch.bind(this),
            '/guide': this.handleGuide.bind(this),
            '/connect': this.handleConnect.bind(this),
            '/disconnect': this.handleDisconnect.bind(this),
            '/mystatus': this.handleMyStatus.bind(this),
            '/setalloc': this.handleSetAlloc.bind(this),
            '/autofund': this.handleAutoFund.bind(this)
        };

        // Engine management - CIA-level security
        this.engines = new Map();  // chatId -> LaunchrEngine instance
        this.engineInterval = null;

        // Solana connection (mainnet) - robust fallback
        const rpcUrl = process.env.SOLANA_RPC_URL && process.env.SOLANA_RPC_URL.startsWith('http')
            ? process.env.SOLANA_RPC_URL
            : 'https://api.mainnet-beta.solana.com';
        this.connection = new Connection(rpcUrl, { commitment: 'confirmed' });

        // Engine loop interval (60 seconds between cycles)
        this.ENGINE_CYCLE_MS = 60 * 1000;
    }

    // Register commands with Telegram (shows menu when typing /)
    async registerCommands() {
        const commands = [
            { command: 'create', description: 'Launch a new token on Pump.fun' },
            { command: 'existing', description: 'Import an existing Pump.fun token' },
            { command: 'start', description: 'Welcome message' },
            { command: 'connect', description: '🔐 Connect wallet (DM only)' },
            { command: 'mystatus', description: '📊 Your session status' },
            { command: 'guide', description: 'Complete guide to LAUNCHR' },
            { command: 'stats', description: 'Platform statistics' },
            { command: 'help', description: 'Show all commands' }
        ];

        try {
            await this.request('setMyCommands', { commands });
            console.log('Bot commands registered');
        } catch (e) {
            console.error('Failed to register commands:', e.message || e.code || e);
        }
    }

    // Make API request to Telegram
    async request(method, params = {}) {
        return new Promise((resolve, reject) => {
            const url = `${this.baseUrl}/${method}`;
            const data = JSON.stringify(params);

            const req = https.request(url, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Content-Length': Buffer.byteLength(data)
                }
            }, (res) => {
                let body = '';
                res.on('data', chunk => body += chunk);
                res.on('end', () => {
                    try {
                        resolve(JSON.parse(body));
                    } catch (e) {
                        reject(e);
                    }
                });
            });

            req.on('error', reject);
            req.write(data);
            req.end();
        });
    }

    // Send message
    async sendMessage(chatId, text, options = {}) {
        return this.request('sendMessage', {
            chat_id: chatId,
            text,
            parse_mode: 'HTML',
            disable_web_page_preview: true,
            ...options
        });
    }

    // Delete message (for security - remove messages containing keys)
    async deleteMessage(chatId, messageId) {
        try {
            await this.request('deleteMessage', {
                chat_id: chatId,
                message_id: messageId
            });
        } catch (e) {
            // Silently fail - message may already be deleted
        }
    }

    // ═══════════════════════════════════════════════════════════════
    // TOKEN LAUNCH METHODS - PumpPortal Integration
    // ═══════════════════════════════════════════════════════════════

    /**
     * Download file from Telegram (for image uploads)
     */
    async downloadTelegramFile(fileId) {
        try {
            // Get file path from Telegram
            const fileInfo = await this.request('getFile', { file_id: fileId });
            if (!fileInfo.ok) return null;

            const filePath = fileInfo.result.file_path;
            const fileUrl = `https://api.telegram.org/file/bot${this.token}/${filePath}`;

            // Download the file
            const response = await axios.get(fileUrl, { responseType: 'arraybuffer' });
            return Buffer.from(response.data);
        } catch (e) {
            console.error('[DOWNLOAD] Failed to download file:', e.message);
            return null;
        }
    }

    /**
     * Upload metadata to IPFS via PumpPortal
     */
    async uploadMetadataToIPFS(tokenData, imageBuffer) {
        try {
            const formData = new FormData();
            formData.append('name', tokenData.name);
            formData.append('symbol', tokenData.symbol);
            formData.append('description', tokenData.description || `${tokenData.name} - Launched via LAUNCHR`);
            formData.append('twitter', tokenData.twitter || '');
            formData.append('telegram', '');
            formData.append('website', 'https://www.launchr.xyz');
            formData.append('showName', 'true');

            if (imageBuffer) {
                formData.append('file', imageBuffer, {
                    filename: 'token-image.png',
                    contentType: 'image/png'
                });
            }

            const response = await axios.post(
                `${PUMPPORTAL_API}/ipfs`,
                formData,
                {
                    headers: formData.getHeaders(),
                    timeout: 60000
                }
            );

            if (response.data && response.data.metadataUri) {
                return response.data.metadataUri;
            }
            return null;
        } catch (e) {
            console.error('[IPFS] Upload failed:', e.message);
            return null;
        }
    }

    /**
     * Grind for vanity address (synchronous, short patterns only)
     */
    async grindVanityAddress(suffix, maxSeconds = 120) {
        console.log(`[VANITY] Grinding for suffix: ${suffix}`);
        const startTime = Date.now();
        const maxMs = maxSeconds * 1000;
        let checked = 0;

        while (Date.now() - startTime < maxMs) {
            const keypair = Keypair.generate();
            const address = keypair.publicKey.toBase58().toLowerCase();
            checked++;

            if (address.endsWith(suffix.toLowerCase())) {
                console.log(`[VANITY] Found after ${checked} attempts!`);
                return keypair;
            }

            // Yield every 10k to prevent blocking
            if (checked % 10000 === 0) {
                await new Promise(r => setImmediate(r));
            }
        }

        console.log(`[VANITY] Timeout after ${checked} attempts`);
        return null; // Timeout
    }

    /**
     * Launch token on Pump.fun via PumpPortal
     */
    async launchTokenOnPump(tokenData, mintKeypair, walletKeypair, devBuySOL = 0) {
        try {
            console.log(`[LAUNCH] Creating ${tokenData.name} ($${tokenData.symbol})`);

            // Upload metadata first
            let imageBuffer = null;
            if (tokenData.photoFileId) {
                imageBuffer = await this.downloadTelegramFile(tokenData.photoFileId);
            }

            const metadataUri = await this.uploadMetadataToIPFS(tokenData, imageBuffer);
            if (!metadataUri) {
                console.log('[LAUNCH] Using fallback metadata approach');
            }

            // Create token via PumpPortal
            const createParams = new URLSearchParams({
                publicKey: walletKeypair.publicKey.toBase58(),
                action: 'create',
                tokenMetadata: JSON.stringify({
                    name: tokenData.name,
                    symbol: tokenData.symbol,
                    uri: metadataUri || ''
                }),
                mint: mintKeypair.publicKey.toBase58(),
                denominatedInSol: 'true',
                amount: devBuySOL.toString(),
                slippage: '15',
                priorityFee: '0.001',
                pool: 'pump'
            });

            const response = await axios.post(
                `${PUMPPORTAL_API}/trade-local`,
                createParams.toString(),
                {
                    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                    responseType: 'arraybuffer',
                    timeout: 30000
                }
            );

            if (!response.data || response.data.byteLength === 0) {
                throw new Error('No transaction returned from PumpPortal');
            }

            // Deserialize and sign
            const tx = VersionedTransaction.deserialize(new Uint8Array(response.data));
            tx.sign([walletKeypair, mintKeypair]);

            // Send transaction
            const sig = await this.connection.sendRawTransaction(tx.serialize(), {
                skipPreflight: true,
                maxRetries: 3
            });

            console.log(`[LAUNCH] Transaction sent: ${sig}`);

            // Wait for confirmation
            await this.connection.confirmTransaction(sig, 'confirmed');

            return {
                success: true,
                mint: mintKeypair.publicKey.toBase58(),
                signature: sig
            };

        } catch (e) {
            console.error('[LAUNCH] Failed:', e.message);
            return {
                success: false,
                error: e.message
            };
        }
    }

    // ═══════════════════════════════════════════════════════════════
    // ENGINE LOOP - The actual fee distribution technology
    // ═══════════════════════════════════════════════════════════════

    // Create engine instance for a user session
    createEngine(chatId, privateKey, mint, allocations) {
        try {
            // Decode private key securely
            const keypair = Keypair.fromSecretKey(bs58.decode(privateKey));

            // Create engine instance
            const engine = new LaunchrEngine(this.connection, mint, keypair);

            // Set user's allocations
            engine.setAllocations({
                marketMaking: allocations.marketMaking,
                buybackBurn: allocations.buybackBurn,
                liquidity: allocations.liquidityPool,
                creatorRevenue: allocations.creatorRevenue,
            });

            // Enable features based on allocations
            engine.features.marketMaking = allocations.marketMaking > 0;
            engine.features.buybackBurn = allocations.buybackBurn > 0;
            engine.features.liquidity = allocations.liquidityPool > 0;
            engine.features.creatorRevenue = allocations.creatorRevenue > 0;

            this.engines.set(chatId, engine);
            console.log(`[ENGINE] Created for user ${chatId}`);
            return engine;
        } catch (error) {
            console.error(`[ENGINE] Failed to create for user ${chatId}:`, error.message);
            return null;
        }
    }

    // Destroy engine instance securely
    destroyEngine(chatId) {
        const engine = this.engines.get(chatId);
        if (engine) {
            // Clear any sensitive data
            engine.wallet = null;
            this.engines.delete(chatId);
            console.log(`[ENGINE] Destroyed for user ${chatId}`);
        }
    }

    // Start the engine loop
    startEngineLoop() {
        if (this.engineInterval) return; // Already running

        console.log('[ENGINE] Starting fee distribution loop...');

        this.engineInterval = setInterval(async () => {
            await this.runEngineCycle();
        }, this.ENGINE_CYCLE_MS);

        // Run immediately on start
        this.runEngineCycle();
    }

    // Stop the engine loop
    stopEngineLoop() {
        if (this.engineInterval) {
            clearInterval(this.engineInterval);
            this.engineInterval = null;
            console.log('[ENGINE] Loop stopped');
        }
    }

    // Run one cycle for all active sessions
    async runEngineCycle() {
        const activeSessions = sessions.getActiveSessions();

        if (activeSessions.length === 0) {
            return; // No active sessions
        }

        console.log(`[ENGINE] Running cycle for ${activeSessions.length} active session(s)`);

        for (const session of activeSessions) {
            try {
                // Get or create engine for this session
                let engine = this.engines.get(session.chatId);

                if (!engine) {
                    engine = this.createEngine(
                        session.chatId,
                        session.privateKey,
                        session.mint,
                        session.allocations
                    );
                }

                if (!engine) {
                    console.error(`[ENGINE] Could not create engine for ${session.chatId}`);
                    continue;
                }

                // Check balance and auto-fund if needed
                if (session.autoFund && session.autoFund.enabled && session.autoFund.sourceKey) {
                    try {
                        const balance = await this.connection.getBalance(engine.wallet.publicKey);
                        if (balance < session.autoFund.minBalance) {
                            console.log(`[AUTOFUND] Balance low for ${session.chatId}: ${balance / 1e9} SOL`);
                            const sourceKeypair = Keypair.fromSecretKey(bs58.decode(session.autoFund.sourceKey));
                            const { SystemProgram, Transaction } = require('@solana/web3.js');
                            const tx = new Transaction().add(
                                SystemProgram.transfer({
                                    fromPubkey: sourceKeypair.publicKey,
                                    toPubkey: engine.wallet.publicKey,
                                    lamports: session.autoFund.fundAmount,
                                })
                            );
                            const sig = await this.connection.sendTransaction(tx, [sourceKeypair]);
                            await this.connection.confirmTransaction(sig, 'confirmed');
                            sessions.recordFund(session.chatId, session.autoFund.fundAmount);
                            console.log(`[AUTOFUND] Funded ${session.chatId} with ${session.autoFund.fundAmount / 1e9} SOL`);

                            await this.sendMessage(session.chatId, `
💰 <b>AUTO-FUND EXECUTED</b>

Your launcher wallet was running low, so we topped it up!
Added: ${(session.autoFund.fundAmount / 1e9).toFixed(4)} SOL
                            `.trim());
                        }
                    } catch (fundErr) {
                        console.error(`[AUTOFUND] Error for ${session.chatId}:`, fundErr.message);
                    }
                }

                // Update allocations in case user changed them
                engine.setAllocations({
                    marketMaking: session.allocations.marketMaking,
                    buybackBurn: session.allocations.buybackBurn,
                    liquidity: session.allocations.liquidityPool,
                    creatorRevenue: session.allocations.creatorRevenue,
                });

                // Update price data for RSI
                await engine.updatePrice();

                // Execute claim and distribute
                const result = await engine.claimAndDistribute();

                // Update session stats
                if (result.claimed > 0 || result.distributed > 0) {
                    sessions.updateStats(session.chatId, result.claimed, result.distributed);

                    // Notify user of successful distribution
                    await this.sendMessage(session.chatId, `
⚡ <b>DISTRIBUTION COMPLETE</b>

💰 Claimed: ${(result.claimed / 1e9).toFixed(6)} SOL
📤 Distributed: ${(result.distributed / 1e9).toFixed(6)} SOL

RSI: ${engine.rsi.value.toFixed(1)}
                    `.trim());

                    console.log(`[ENGINE] User ${session.chatId}: Claimed ${result.claimed}, Distributed ${result.distributed}`);
                }
            } catch (error) {
                console.error(`[ENGINE] Error for user ${session.chatId}:`, error.message);
            }
        }
    }

    // Start polling for updates
    async startPolling() {
        console.log('═══════════════════════════════════════════════════════════════');
        console.log('[TELEGRAM-BOT] startPolling() called - v2.1 DEBUG BUILD');
        console.log('[TELEGRAM-BOT] Available commands:', Object.keys(this.commands).join(', '));
        console.log('═══════════════════════════════════════════════════════════════');
        console.log('LAUNCHR Bot started polling...');

        // Register commands so they show when user types /
        await this.registerCommands();
        console.log('[TELEGRAM-BOT] Commands registered with Telegram API');

        // Start the engine loop for fee distribution
        this.startEngineLoop();

        while (true) {
            try {
                const updates = await this.request('getUpdates', {
                    offset: this.offset,
                    timeout: 30
                });

                if (updates.ok && updates.result.length > 0) {
                    for (const update of updates.result) {
                        this.offset = update.update_id + 1;
                        await this.handleUpdate(update);
                    }
                }
            } catch (e) {
                console.error('Polling error:', e.message || e.code || e);
                await new Promise(r => setTimeout(r, 5000));
            }
        }
    }

    // Handle incoming update
    async handleUpdate(update) {
        const msg = update.message;
        if (!msg) return;

        const chatId = msg.chat.id;
        const text = msg.text ? msg.text.trim() : '';
        const photo = msg.photo; // For image uploads

        // Check if user is in a conversation flow
        const conv = getConversation(chatId);
        if (conv) {
            // Handle conversation step
            try {
                await this.handleConversationStep(chatId, conv, text, photo, msg);
                return;
            } catch (e) {
                console.error('Conversation error:', e.message);
                clearConversation(chatId);
                await this.sendMessage(chatId, '❌ Something went wrong. Type /create to start over.');
                return;
            }
        }

        // No conversation - check for commands
        if (!text) return;

        // Allow /cancel to exit any flow
        if (text.toLowerCase() === '/cancel') {
            clearConversation(chatId);
            await this.sendMessage(chatId, '✅ Cancelled. Type /start to see options.');
            return;
        }

        const [command, ...args] = text.split(' ');
        const handler = this.commands[command.toLowerCase()];
        if (handler) {
            try {
                await handler(chatId, args, msg);
            } catch (e) {
                console.error('Command error:', e.message);
                await this.sendMessage(chatId, '❌ Error processing command');
            }
        }
    }

    // Handle conversation steps for multi-step flows
    async handleConversationStep(chatId, conv, text, photo, msg) {
        const { step, data } = conv;

        // Allow cancel at any point
        if (text.toLowerCase() === '/cancel') {
            clearConversation(chatId);
            await this.sendMessage(chatId, '✅ Token creation cancelled.');
            return;
        }

        switch (step) {
            case 'create_await_wallet':
                // User should have connected wallet, check if they're back
                if (text.toLowerCase() === 'done' || text.toLowerCase() === 'connected') {
                    // Check if their wallet is linked
                    // For now, proceed to next step
                    setConversation(chatId, 'create_name', data);
                    await this.sendMessage(chatId, `
✅ <b>Wallet connected!</b>

Now let's create your token.

<b>What's your token NAME?</b>
(Example: "MoonDog" or "Pepe 2.0")
                    `.trim());
                } else {
                    await this.sendMessage(chatId, `
👉 <a href="https://www.launchr.xyz/tg-connect?id=${chatId}">TAP HERE TO CONNECT WALLET</a>

After connecting, come back and type <b>done</b>

Or type /cancel to exit.
                    `.trim());
                }
                break;

            case 'create_name':
                if (!text || text.length < 1 || text.length > 32) {
                    await this.sendMessage(chatId, '❌ Name must be 1-32 characters. Try again:');
                    return;
                }
                data.name = text;
                setConversation(chatId, 'create_symbol', data);
                await this.sendMessage(chatId, `
✅ Name: <b>${text}</b>

<b>What's your token SYMBOL?</b>
(Example: "MDOG" - max 10 characters)
                `.trim());
                break;

            case 'create_symbol':
                if (!text || text.length < 1 || text.length > 10) {
                    await this.sendMessage(chatId, '❌ Symbol must be 1-10 characters. Try again:');
                    return;
                }
                data.symbol = text.toUpperCase();
                setConversation(chatId, 'create_image', data);
                await this.sendMessage(chatId, `
✅ Symbol: <b>${data.symbol}</b>

<b>Send me your token IMAGE</b> 📷
(Square image works best, or type "skip" to use default)
                `.trim());
                break;

            case 'create_image':
                if (photo && photo.length > 0) {
                    // Get the largest photo
                    const largestPhoto = photo[photo.length - 1];
                    data.photoFileId = largestPhoto.file_id;
                    data.hasImage = true;
                } else if (text.toLowerCase() === 'skip') {
                    data.hasImage = false;
                } else {
                    await this.sendMessage(chatId, '📷 Please send an image or type "skip"');
                    return;
                }
                setConversation(chatId, 'create_description', data);
                await this.sendMessage(chatId, `
✅ Image: ${data.hasImage ? 'Uploaded!' : 'Using default'}

<b>DESCRIPTION</b> (optional)
What's your token about? Or type "skip"
                `.trim());
                break;

            case 'create_description':
                data.description = (text.toLowerCase() === 'skip') ? '' : text;
                setConversation(chatId, 'create_twitter', data);
                await this.sendMessage(chatId, `
✅ Description saved!

<b>TWITTER</b> (optional)
Enter your Twitter handle or type "skip"
(Example: @MoonDogToken)
                `.trim());
                break;

            case 'create_twitter':
                data.twitter = (text.toLowerCase() === 'skip') ? '' : text.replace('@', '');
                setConversation(chatId, 'create_vanity', data);
                await this.sendMessage(chatId, `
✅ Twitter saved!

<b>🎰 VANITY ADDRESS</b> (optional)

Want a custom token address?
Examples:
• Ends with "pump" → ...xxxPUMP
• Ends with "moon" → ...xxxMOON

Enter your preferred ending (2-5 chars) or type "skip"

<i>Note: Custom addresses may take a few minutes to generate.</i>
                `.trim());
                break;

            case 'create_vanity':
                if (text.toLowerCase() === 'skip') {
                    data.vanity = null;
                } else if (text.length >= 2 && text.length <= 5 && /^[a-zA-Z0-9]+$/.test(text)) {
                    data.vanity = text.toLowerCase();
                } else if (text.length > 5) {
                    await this.sendMessage(chatId, '❌ Vanity suffix must be 2-5 characters. Try again or type "skip":');
                    return;
                } else {
                    data.vanity = null;
                }

                setConversation(chatId, 'create_devbuy', data);
                await this.sendMessage(chatId, `
✅ Vanity: ${data.vanity ? data.vanity.toUpperCase() : 'Random address'}

<b>💰 INITIAL DEV BUY</b> (optional)

How much SOL to buy at launch?
• Enter amount (e.g., "0.5" or "1")
• Or type "0" or "skip" for no initial buy

<i>This buys tokens right at launch price.</i>
                `.trim());
                break;

            case 'create_devbuy':
                const devBuyAmount = parseFloat(text);
                if (text.toLowerCase() === 'skip' || text === '0') {
                    data.devBuy = 0;
                } else if (!isNaN(devBuyAmount) && devBuyAmount >= 0 && devBuyAmount <= 10) {
                    data.devBuy = devBuyAmount;
                } else {
                    await this.sendMessage(chatId, '❌ Enter a number between 0-10 SOL, or type "skip":');
                    return;
                }

                setConversation(chatId, 'create_confirm', data);
                await this.sendMessage(chatId, `
🚀 <b>READY TO LAUNCH!</b>

<b>━━━ TOKEN DETAILS ━━━</b>
<b>Name:</b> ${data.name}
<b>Symbol:</b> ${data.symbol}
<b>Image:</b> ${data.hasImage ? '✅ Uploaded' : '📷 Default'}
<b>Description:</b> ${data.description || '(none)'}
<b>Twitter:</b> ${data.twitter ? '@' + data.twitter : '(none)'}

<b>━━━ LAUNCH OPTIONS ━━━</b>
<b>Vanity Address:</b> ${data.vanity ? '...' + data.vanity.toUpperCase() : 'Random'}
<b>Dev Buy:</b> ${data.devBuy > 0 ? data.devBuy + ' SOL' : 'None'}

<b>━━━━━━━━━━━━━━━━━━━━</b>

Type <b>LAUNCH</b> to create your token!
Or /cancel to abort.
                `.trim());
                break;

            case 'create_confirm':
                if (text.toUpperCase() === 'LAUNCH') {
                    clearConversation(chatId);

                    await this.sendMessage(chatId, '🚀 <b>LAUNCHING YOUR TOKEN...</b>\n\nThis may take a moment...');

                    try {
                        // Step 1: Get or create mint keypair
                        let mintKeypair;
                        if (data.vanity) {
                            await this.sendMessage(chatId, `🎰 Grinding for vanity address ending in <b>${data.vanity.toUpperCase()}</b>...\n\n<i>This may take 1-2 minutes...</i>`);
                            mintKeypair = await this.grindVanityAddress(data.vanity, 120);

                            if (!mintKeypair) {
                                await this.sendMessage(chatId, `⏰ Vanity grinding timed out. Using random address instead.`);
                                mintKeypair = Keypair.generate();
                            } else {
                                await this.sendMessage(chatId, `✅ Found vanity address: <code>...${mintKeypair.publicKey.toBase58().slice(-8)}</code>`);
                            }
                        } else {
                            mintKeypair = Keypair.generate();
                        }

                        // Step 2: Check if user has connected wallet via Privy
                        // For now, store the pending launch and redirect to website
                        const launchId = crypto.randomBytes(16).toString('hex');

                        // Store pending launch data for website to pick up
                        const pendingLaunch = {
                            launchId,
                            chatId,
                            tokenData: {
                                name: data.name,
                                symbol: data.symbol,
                                description: data.description || '',
                                twitter: data.twitter || '',
                                hasImage: data.hasImage,
                                photoFileId: data.photoFileId || null
                            },
                            mintKeypair: {
                                publicKey: mintKeypair.publicKey.toBase58(),
                                secretKey: bs58.encode(mintKeypair.secretKey)
                            },
                            devBuy: data.devBuy || 0,
                            createdAt: Date.now(),
                            status: 'pending_wallet'
                        };

                        // Store in memory (in production, use Redis/DB)
                        if (!global.pendingLaunches) global.pendingLaunches = new Map();
                        global.pendingLaunches.set(launchId, pendingLaunch);

                        // Clean up old pending launches (older than 1 hour)
                        const oneHourAgo = Date.now() - (60 * 60 * 1000);
                        for (const [id, launch] of global.pendingLaunches) {
                            if (launch.createdAt < oneHourAgo) {
                                global.pendingLaunches.delete(id);
                            }
                        }

                        await this.sendMessage(chatId, `
✅ <b>TOKEN READY TO LAUNCH!</b>

<b>━━━ TOKEN INFO ━━━</b>
<b>Name:</b> ${data.name}
<b>Symbol:</b> $${data.symbol}
<b>Mint:</b> <code>${mintKeypair.publicKey.toBase58().slice(0, 8)}...${mintKeypair.publicKey.toBase58().slice(-8)}</code>
${data.vanity ? `<b>Vanity:</b> ✅ ...${mintKeypair.publicKey.toBase58().slice(-6).toUpperCase()}` : ''}
${data.devBuy > 0 ? `<b>Dev Buy:</b> ${data.devBuy} SOL` : ''}

<b>━━━ FINAL STEP ━━━</b>

👉 <a href="https://www.launchr.xyz/launch/${launchId}">TAP HERE TO SIGN & LAUNCH</a>

<b>What happens:</b>
1. Connect your wallet (Phantom/Solflare)
2. Sign the transaction
3. Your token goes LIVE on Pump.fun! 🚀

<i>Link expires in 1 hour.</i>

<b>━━━━━━━━━━━━━━━━━━━━</b>

<i>🔒 Non-custodial: Your wallet signs directly.</i>
<i>⚠️ Meme coins are speculative. DYOR.</i>
                        `.trim());

                        // Register token in tracker
                        tracker.registerToken(mintKeypair.publicKey.toBase58(), null, {
                            source: 'telegram-create',
                            name: data.name,
                            symbol: data.symbol,
                            status: 'pending'
                        });

                    } catch (launchError) {
                        console.error('[LAUNCH] Error:', launchError.message);
                        await this.sendMessage(chatId, `
❌ <b>LAUNCH FAILED</b>

Error: ${launchError.message}

Please try again with /create or contact support.
                        `.trim());
                    }
                } else {
                    await this.sendMessage(chatId, 'Type <b>LAUNCH</b> to confirm, or /cancel to abort.');
                }
                break;

            default:
                clearConversation(chatId);
                await this.sendMessage(chatId, '❌ Unknown state. Type /create to start over.');
        }
    }

    // /start command
    async handleStart(chatId) {
        console.log('[TELEGRAM-BOT] handleStart() CALLED - chatId:', chatId);
        const text = `
<b>🚀 LAUNCHR</b>
<i>Automated Fee Distribution for Pump.fun</i>

<b>━━━ WHAT DO YOU WANT TO DO? ━━━</b>

<b>/create</b> - Launch a NEW meme coin
<b>/existing</b> - Connect an EXISTING token

<b>━━━ HOW IT WORKS ━━━</b>

1️⃣ Create or import your token
2️⃣ Connect via our secure dashboard
3️⃣ Set your fee allocations
4️⃣ ORBIT runs 24/7 automatically

<b>━━━ YOUR FEES GO TO ━━━</b>

• Market Making (RSI-timed buys)
• Buyback & Burn (deflation)
• Liquidity Pool (depth)
• Creator Revenue (you)

<b>━━━ LINKS ━━━</b>

🌐 <a href="https://www.launchr.xyz">Website</a>
🚀 <a href="https://www.launchr.xyz/launchpad">Launchpad</a>
📊 <a href="https://www.launchr.xyz/dashboard">Dashboard</a>

<i>🔒 Non-custodial. We NEVER hold your keys.</i>
<i>⚠️ Meme coins are speculative. DYOR.</i>
        `.trim();

        await this.sendMessage(chatId, text);
    }

    // /ping command - Test deployment
    async handlePing(chatId) {
        await this.sendMessage(chatId, `🏓 PONG!\n\nBot Version: 3.0 - CONVERSATIONAL CREATE FLOW\nFeatures: Vanity Mint, Dev Buy, IPFS Upload\nDeployed: ${new Date().toISOString()}\n\n✅ NEW code is running!`);
    }

    // /create command - Launch new token (CONVERSATIONAL FLOW)
    async handleCreate(chatId, args, msg) {
        // Start the conversation flow
        setConversation(chatId, 'create_await_wallet', {});

        const text = `
<b>🚀 LET'S CREATE YOUR TOKEN!</b>

First, connect your wallet so we can launch for you.

👉 <a href="https://www.launchr.xyz/tg-connect?id=${chatId}">TAP HERE TO CONNECT WALLET</a>

After connecting, come back here and type <b>done</b>

<b>━━━━━━━━━━━━━━━━━━━━</b>

<b>What happens next:</b>
1. You'll enter token name & symbol
2. Upload an image (optional)
3. Add description & socials
4. Confirm and LAUNCH! 🚀

<b>🔒 NON-CUSTODIAL</b>
We use Privy MPC - we never hold your keys.

Type /cancel anytime to exit.
        `.trim();

        await this.sendMessage(chatId, text);
    }

    // /existing command - Import existing token
    async handleExisting(chatId, args, msg) {
        const text = `
<b>🔗 IMPORT EXISTING TOKEN</b>

Already launched on Pump.fun? Let's connect it!

<b>STEP 1 - GO TO DASHBOARD:</b>
👉 <a href="https://www.launchr.xyz/dashboard">TAP HERE TO OPEN</a>

<b>STEP 2 - ON THE WEBSITE:</b>
• Connect your wallet (same one you launched with)
• Your tokens appear under "My Launches"
• Click on your token

<b>STEP 3 - SET ALLOCATIONS:</b>
• Market Making % (RSI-timed buys)
• Buyback & Burn % (deflation)
• Liquidity Pool % (depth)
• Creator Revenue % (your wallet)

<b>STEP 4 - ENABLE ORBIT:</b>
• Click "Enable 24/7 Automation"
• Sign with your wallet
• Done! Fees auto-distribute!

<b>STEP 5 - COME BACK HERE!</b>
Once set up, come back to check status anytime.

<b>━━━━━━━━━━━━━━━━━━━━</b>

<b>🔒 100% NON-CUSTODIAL</b>
We NEVER hold your keys. Privy MPC = secure.

<i>⚠️ Meme coins are speculative. DYOR.</i>
        `.trim();

        await this.sendMessage(chatId, text);
    }

    // /help command
    async handleHelp(chatId) {
        const text = `
<b>LAUNCHR Commands</b>

<b>Main Actions:</b>
/create - Launch a new token on Pump.fun
/existing - Import an existing Pump.fun token

<b>Getting Started:</b>
/start - Welcome & options
/connect - Connect your wallet (DM only)
/guide - Complete walkthrough

<b>After Connecting:</b>
/mystatus - Your session status
/setalloc - Set fee allocations
/disconnect - Stop & disconnect

<b>Tracking:</b>
/track [mint] - Track a token
/stats - Platform statistics

<b>Links:</b>
🌐 <a href="https://www.launchr.xyz">Website</a>
📊 <a href="https://www.launchr.xyz/dashboard">Dashboard</a>

<i>LAUNCHR is non-custodial. Your keys, your control.</i>
        `.trim();

        await this.sendMessage(chatId, text);
    }

    // /track command
    async handleTrack(chatId, args, msg) {
        if (!args[0]) {
            await this.sendMessage(chatId, '❌ Please provide a token mint address\n\nUsage: /track [mint_address]');
            return;
        }

        const mint = args[0];

        // Basic validation (Solana addresses are 32-44 chars base58)
        if (mint.length < 32 || mint.length > 44) {
            await this.sendMessage(chatId, '❌ Invalid mint address format');
            return;
        }

        // Register the token
        const result = tracker.registerToken(mint, null, {
            source: 'telegram',
            registeredBy: msg.from.username || msg.from.id
        });

        if (result.registered) {
            await this.sendMessage(chatId, `
✅ <b>Token Tracked!</b>

<code>${mint}</code>

Your token is now listed on the LAUNCHR tracker.
View it at: https://www.launchr.xyz/tracker

Use the dashboard at https://www.launchr.xyz/dashboard to configure fee allocations.
            `.trim());
        } else {
            await this.sendMessage(chatId, `
✅ <b>Token Already Tracked</b>

<code>${mint}</code>

Sessions: ${result.token.sessions}
First tracked: ${new Date(result.token.registeredAt).toLocaleDateString()}

View at: https://www.launchr.xyz/tracker
            `.trim());
        }
    }

    // /stats command
    async handleStats(chatId) {
        const stats = tracker.getPublicStats();

        const text = `
<b>📊 LAUNCHR Stats</b>

<b>${stats.totalTokens}</b> Tokens Tracked
<b>${(stats.totalClaimed / 1e9).toFixed(2)}</b> SOL Claimed
<b>${(stats.totalDistributed / 1e9).toFixed(2)}</b> SOL Distributed

View live tracker: https://www.launchr.xyz/tracker
        `.trim();

        await this.sendMessage(chatId, text);
    }

    // /recent command
    async handleRecent(chatId) {
        const stats = tracker.getPublicStats();

        if (!stats.recentTokens || stats.recentTokens.length === 0) {
            await this.sendMessage(chatId, 'No tokens tracked yet. Be the first!\n\nUse /track [mint] to track your token.');
            return;
        }

        let text = '<b>🕐 Recent Tokens</b>\n\n';

        stats.recentTokens.slice(0, 5).forEach((t, i) => {
            const date = new Date(t.registeredAt).toLocaleDateString();
            text += `${i + 1}. <code>${t.mint}</code>\n   📅 ${date} • ${t.sessions} sessions\n\n`;
        });

        text += 'View all: https://www.launchr.xyz/tracker';

        await this.sendMessage(chatId, text);
    }

    // /launch command
    async handleLaunch(chatId) {
        const text = `
<b>🚀 How to Launch with LAUNCHR</b>

<b>Step 1:</b> Create your token on Pump.fun

<b>Step 2:</b> Connect right here in Telegram:
<code>/connect [your_private_key] [mint_address]</code>

<b>Step 3:</b> Set your fee allocations:
<code>/setalloc [mm] [bb] [lp] [cr]</code>
(Must total 100%)

<b>That's it!</b> Engine runs automatically.

<b>Allocations:</b>
• MM = Market Making (RSI-timed trades)
• BB = Buyback & Burn (deflationary)
• LP = Liquidity Pool (locked)
• CR = Creator Revenue (your wallet)

<b>Other Commands:</b>
/mystatus - Check your session
/disconnect - Stop & disconnect

🔒 Your key is encrypted and auto-deleted.
        `.trim();

        await this.sendMessage(chatId, text);
    }

    // /guide command - comprehensive guide
    async handleGuide(chatId) {
        const text = `
<b>📖 COMPLETE GUIDE TO LAUNCHR</b>

━━━━━━━━━━━━━━━━━━━━━━

<b>🔥 WHAT IS LAUNCHR?</b>

LAUNCHR is the <b>first-of-its-kind</b> programmable liquidity engine for Pump.fun tokens. It automatically captures and distributes your creator fees into strategic actions that grow your token.

━━━━━━━━━━━━━━━━━━━━━━

<b>💡 THE PROBLEM</b>

When you launch on Pump.fun, you earn creator fees - but most creators just pocket them. This provides zero value to holders and doesn't help your token grow.

<b>✅ THE SOLUTION</b>

LAUNCHR automatically routes your fees into:

<b>1. Market Making (RSI-Timed)</b>
Smart trades based on RSI indicators. Buys when oversold, sells when overbought. Creates healthy price action.

<b>2. Buyback & Burn</b>
Automatically buys your token and burns it forever. Reduces supply = deflationary pressure.

<b>3. Liquidity Pool</b>
Adds locked LP to increase depth. More liquidity = less slippage = better trading.

<b>4. Creator Revenue</b>
Your cut. Goes straight to your wallet.

━━━━━━━━━━━━━━━━━━━━━━

<b>🤖 SMART OPTIMIZATION</b>

Our AI engine analyzes market conditions and auto-adjusts your allocations in real-time:
• High volatility? More market making
• Price dumping? More buybacks
• Low liquidity? More LP adds

Set it and forget it.

━━━━━━━━━━━━━━━━━━━━━━

<b>🚀 HOW TO START</b>

1️⃣ Create token on Pump.fun
2️⃣ Visit https://www.launchr.xyz/dashboard
3️⃣ Enter your creator wallet key + mint
4️⃣ Set allocation percentages
5️⃣ Click START

Your token is now powered by LAUNCHR.

━━━━━━━━━━━━━━━━━━━━━━

<b>📊 TRACKING</b>

All LAUNCHR tokens are listed on our public tracker:
🌐 https://www.launchr.xyz/tracker

Track via Telegram:
/track [mint_address]

━━━━━━━━━━━━━━━━━━━━━━

<b>🔗 LINKS</b>

🌐 Website: https://www.launchr.xyz
📊 Dashboard: https://www.launchr.xyz/dashboard
📈 Tracker: https://www.launchr.xyz/tracker
🐦 Twitter: @LaunchrTG

━━━━━━━━━━━━━━━━━━━━━━

<b>First of its kind. Programmable liquidity.</b>
        `.trim();

        await this.sendMessage(chatId, text);
    }

    // ═══════════════════════════════════════════════════════════════
    // SECURE WALLET CONNECTION - CIA LEVEL
    // ═══════════════════════════════════════════════════════════════

    // /connect - Secure wallet connection (DM ONLY)
    async handleConnect(chatId, args, msg) {
        // SECURITY: Only allow in private DMs
        if (msg.chat.type !== 'private') {
            await this.sendMessage(chatId, '🔒 <b>Security Notice</b>\n\nThis command only works in private DMs.\n\nMessage me directly: @LAUNCHR_V2_BOT');
            return;
        }

        // SECURITY: Immediately delete the message containing the key
        await this.deleteMessage(chatId, msg.message_id);

        // Check if already connected
        if (sessions.has(chatId)) {
            await this.sendMessage(chatId, '⚠️ You already have an active session.\n\nUse /disconnect first, or /mystatus to check status.');
            return;
        }

        // Validate args
        if (args.length < 2) {
            await this.sendMessage(chatId, `
🔐 <b>SECURE CONNECT</b>

<b>Usage:</b>
<code>/connect [private_key] [mint_address]</code>

<b>Example:</b>
<code>/connect 5KQb7...xyz ABC123...mint</code>

⚠️ <b>IMPORTANT - READ CAREFULLY:</b>
Your private key is <b>PROCESSED</b> to sign transactions but is <b>NEVER STORED</b> on any server or database.

<b>Security measures:</b>
• DM only (never works in groups)
• Your message is auto-deleted instantly
• Key is encrypted with AES-256 in RAM only
• Key is wiped from memory on /disconnect
• No logging, no database, no persistence
• Open source - verify the code yourself

⚠️ <b>RISK:</b> You are sharing your private key with this bot. Only use a dedicated fee wallet, never your main wallet. DYOR.

🔒 Military-grade encryption. Your key, your responsibility.
            `.trim());
            return;
        }

        const [privateKey, mint] = args;

        // Validate private key format (base58, ~88 chars for Solana)
        if (privateKey.length < 64 || privateKey.length > 90) {
            await this.sendMessage(chatId, '❌ Invalid private key format.\n\nMust be base58 encoded Solana private key.');
            return;
        }

        // Validate mint address (32-44 chars base58)
        if (mint.length < 32 || mint.length > 44) {
            await this.sendMessage(chatId, '❌ Invalid mint address format.');
            return;
        }

        // Create encrypted session
        sessions.create(chatId, privateKey, mint);
        sessions.setActive(chatId, true);

        // Register token in tracker
        tracker.registerToken(mint, null, {
            source: 'telegram-connect',
            registeredBy: msg.from.username || msg.from.id
        });

        // Create engine instance immediately
        const session = sessions.get(chatId);
        const engine = this.createEngine(chatId, privateKey, mint, session.allocations);

        if (!engine) {
            sessions.destroy(chatId);
            await this.sendMessage(chatId, '❌ <b>Failed to initialize engine.</b>\n\nPlease check your private key format and try again.');
            return;
        }

        await this.sendMessage(chatId, `
✅ <b>CONNECTED</b>

🔐 Wallet connected securely
🪙 Token: <code>${mint.slice(0, 8)}...${mint.slice(-6)}</code>

<b>Default Allocations:</b>
• Market Making: 25%
• Buyback & Burn: 25%
• Liquidity Pool: 25%
• Creator Revenue: 25%

<b>Commands:</b>
/setalloc - Change allocations
/mystatus - View status
/disconnect - Stop & disconnect

⚡ <b>Engine is now ACTIVE</b>
Running first distribution cycle...
        `.trim());

        console.log(`[CONNECT] User ${msg.from.id} connected token ${mint.slice(0, 8)}...`);

        // Run first cycle immediately (don't wait for loop)
        try {
            await engine.updatePrice();
            const result = await engine.claimAndDistribute();

            if (result.claimed > 0) {
                sessions.updateStats(chatId, result.claimed, result.distributed);
                await this.sendMessage(chatId, `
🎉 <b>FIRST DISTRIBUTION</b>

💰 Claimed: ${(result.claimed / 1e9).toFixed(6)} SOL
📤 Distributed: ${(result.distributed / 1e9).toFixed(6)} SOL

Engine will continue every 60 seconds.
                `.trim());
            } else {
                await this.sendMessage(chatId, `
✅ <b>Engine initialized</b>

No pending fees to claim yet.
Engine will check every 60 seconds.
                `.trim());
            }
        } catch (err) {
            console.error(`[CONNECT] First cycle error for ${chatId}:`, err.message);
        }
    }

    // /disconnect - Secure disconnect
    async handleDisconnect(chatId, args, msg) {
        if (!sessions.has(chatId)) {
            await this.sendMessage(chatId, '❌ No active session.\n\nUse /connect to start.');
            return;
        }

        const session = sessions.get(chatId);
        const mint = session.mint;
        const stats = session.stats;

        // Destroy engine instance first (secure cleanup)
        this.destroyEngine(chatId);

        // Securely destroy session
        sessions.destroy(chatId);

        await this.sendMessage(chatId, `
🔌 <b>DISCONNECTED</b>

Session ended securely.
🔐 Private key wiped from memory.
⚙️ Engine stopped and destroyed.

<b>Session Stats:</b>
• SOL Claimed: ${(stats.claimed / 1e9).toFixed(4)}
• SOL Distributed: ${(stats.distributed / 1e9).toFixed(4)}
• Cycles: ${stats.cycles}

Token: <code>${mint.slice(0, 8)}...${mint.slice(-6)}</code>

Thanks for using LAUNCHR. 🚀
        `.trim());

        console.log(`[DISCONNECT] User ${msg.from.id} disconnected`);
    }

    // /mystatus - Check session status
    async handleMyStatus(chatId, args, msg) {
        if (!sessions.has(chatId)) {
            await this.sendMessage(chatId, '❌ No active session.\n\nUse /connect to start.');
            return;
        }

        const session = sessions.get(chatId);
        const engine = this.engines.get(chatId);

        // Get full analysis from 10-factor analyzer
        let analysisText = 'Initializing...';
        let signalEmoji = '⏳';

        if (engine && engine.analyzer) {
            const analysis = engine.analyzer.getAnalysis();
            const rec = analysis.recommendation;

            // Signal emoji based on recommendation
            if (rec.action === 'STRONG_BUY') signalEmoji = '🟢🟢';
            else if (rec.action === 'BUY') signalEmoji = '🟢';
            else if (rec.action === 'STRONG_SELL') signalEmoji = '🔴🔴';
            else if (rec.action === 'SELL') signalEmoji = '🔴';
            else if (rec.action === 'HOLD') signalEmoji = '🟡';
            else signalEmoji = '⏳';

            analysisText = `
<b>10-Factor Analysis:</b>
• Signal: ${signalEmoji} <b>${rec.action}</b> (${rec.reason})
• Buy Score: ${analysis.buyScore}/100
• Confidence: ${analysis.confidence}%

<b>Key Metrics:</b>
• RSI: ${analysis.metrics.rsi.toFixed(1)}
• Momentum: ${analysis.metrics.momentum.toFixed(1)}
• Buy Pressure: ${analysis.metrics.buyPressure.toFixed(1)}
• Trend: ${analysis.metrics.trendStrength.toFixed(1)}
• Volatility: ${analysis.metrics.volatility.toFixed(1)}`;
        }

        await this.sendMessage(chatId, `
📊 <b>SESSION STATUS</b>

<b>Status:</b> ${session.active ? '🟢 ENGINE RUNNING' : '🔴 PAUSED'}
<b>Token:</b> <code>${session.mint.slice(0, 8)}...${session.mint.slice(-6)}</code>

${analysisText}

<b>Allocations:</b>
• Market Making: ${session.allocations.marketMaking}%
• Buyback & Burn: ${session.allocations.buybackBurn}%
• Liquidity Pool: ${session.allocations.liquidityPool}%
• Creator Revenue: ${session.allocations.creatorRevenue}%

<b>Stats:</b>
• SOL Claimed: ${(session.stats.claimed / 1e9).toFixed(6)}
• SOL Distributed: ${(session.stats.distributed / 1e9).toFixed(6)}
• Cycles: ${session.stats.cycles}
• Running since: ${new Date(session.createdAt).toLocaleString()}

<b>Commands:</b>
/setalloc - Change allocations
/disconnect - Stop & disconnect
        `.trim());
    }

    // /setalloc - Set allocation percentages
    async handleSetAlloc(chatId, args, msg) {
        if (!sessions.has(chatId)) {
            await this.sendMessage(chatId, '❌ No active session.\n\nUse /connect first.');
            return;
        }

        // Check for args
        if (args.length < 4) {
            const session = sessions.get(chatId);
            await this.sendMessage(chatId, `
⚙️ <b>SET ALLOCATIONS</b>

<b>Usage:</b>
<code>/setalloc [mm] [bb] [lp] [cr]</code>

<b>Current:</b>
• Market Making: ${session.allocations.marketMaking}%
• Buyback & Burn: ${session.allocations.buybackBurn}%
• Liquidity Pool: ${session.allocations.liquidityPool}%
• Creator Revenue: ${session.allocations.creatorRevenue}%

<b>Example:</b>
<code>/setalloc 30 30 20 20</code>

⚠️ Must total 100%
            `.trim());
            return;
        }

        const [mm, bb, lp, cr] = args.map(n => parseInt(n, 10));

        // Validate
        if ([mm, bb, lp, cr].some(n => isNaN(n) || n < 0 || n > 100)) {
            await this.sendMessage(chatId, '❌ Invalid values. Each must be 0-100.');
            return;
        }

        if (mm + bb + lp + cr !== 100) {
            await this.sendMessage(chatId, `❌ Allocations must total 100%.\n\nYou entered: ${mm + bb + lp + cr}%`);
            return;
        }

        sessions.setAllocations(chatId, {
            marketMaking: mm,
            buybackBurn: bb,
            liquidityPool: lp,
            creatorRevenue: cr
        });

        await this.sendMessage(chatId, `
✅ <b>ALLOCATIONS UPDATED</b>

• Market Making: ${mm}%
• Buyback & Burn: ${bb}%
• Liquidity Pool: ${lp}%
• Creator Revenue: ${cr}%

Changes take effect on next cycle.
        `.trim());
    }

    // /autofund - Configure auto-funding of the launcher wallet
    async handleAutoFund(chatId, args, msg) {
        // SECURITY: Only allow in private DMs
        if (msg.chat.type !== 'private') {
            await this.sendMessage(chatId, '🔒 <b>Security Notice</b>\n\nThis command only works in private DMs.\n\nMessage me directly: @LAUNCHR_V2_BOT');
            return;
        }

        if (!sessions.has(chatId)) {
            await this.sendMessage(chatId, '❌ No active session.\n\nUse /connect first.');
            return;
        }

        // SECURITY: Immediately delete the message if it contains a key
        if (args.length >= 1 && args[0] !== 'off' && args[0] !== 'status') {
            await this.deleteMessage(chatId, msg.message_id);
        }

        const session = sessions.get(chatId);

        // Check for subcommands: off, status, or configure
        if (args.length === 0 || args[0] === 'help') {
            const currentConfig = sessions.getAutoFundConfig(chatId);
            await this.sendMessage(chatId, `
💰 <b>AUTO-FUND</b>

Auto-fund keeps your launcher wallet topped up so it never runs out of SOL for transaction fees.

<b>Usage:</b>
<code>/autofund [source_key] [min] [amount]</code>

<b>Parameters:</b>
• source_key - Private key of wallet to fund FROM
• min - Minimum balance before refill (default: 0.05 SOL)
• amount - Amount to add each time (default: 0.1 SOL)

<b>Examples:</b>
<code>/autofund 5KQb7...xyz 0.05 0.1</code>
<code>/autofund off</code>
<code>/autofund status</code>

<b>Current Status:</b> ${currentConfig?.enabled ? '🟢 ENABLED' : '🔴 DISABLED'}
${currentConfig?.enabled ? `Source: ${currentConfig.sourceWallet?.slice(0, 8)}...${currentConfig.sourceWallet?.slice(-6)}` : ''}

⚠️ <b>Security:</b> Your funding wallet key is encrypted with AES-256-GCM and held in memory only. This message will be auto-deleted.
            `.trim());
            return;
        }

        if (args[0] === 'off') {
            sessions.disableAutoFund(chatId);
            await this.sendMessage(chatId, `
🔴 <b>AUTO-FUND DISABLED</b>

Your funding wallet key has been securely wiped from memory.
            `.trim());
            return;
        }

        if (args[0] === 'status') {
            const config = sessions.getAutoFundConfig(chatId);
            if (!config || !config.enabled) {
                await this.sendMessage(chatId, '🔴 <b>Auto-fund is DISABLED</b>\n\nUse <code>/autofund [source_key]</code> to enable.');
                return;
            }
            await this.sendMessage(chatId, `
💰 <b>AUTO-FUND STATUS</b>

<b>Status:</b> 🟢 ENABLED
<b>Source Wallet:</b> <code>${config.sourceWallet?.slice(0, 8)}...${config.sourceWallet?.slice(-6)}</code>
<b>Min Balance:</b> ${(config.minBalance / 1e9).toFixed(4)} SOL
<b>Fund Amount:</b> ${(config.fundAmount / 1e9).toFixed(4)} SOL
<b>Last Funded:</b> ${config.lastFunded ? new Date(config.lastFunded).toLocaleString() : 'Never'}

When your launcher wallet drops below ${(config.minBalance / 1e9).toFixed(4)} SOL, it will automatically receive ${(config.fundAmount / 1e9).toFixed(4)} SOL from your source wallet.
            `.trim());
            return;
        }

        // Configure auto-fund with source key
        const sourceKey = args[0];
        const minBalance = args[1] ? parseFloat(args[1]) : 0.05;
        const fundAmount = args[2] ? parseFloat(args[2]) : 0.1;

        // Validate source key format (base58, ~88 chars for Solana)
        if (sourceKey.length < 64 || sourceKey.length > 90) {
            await this.sendMessage(chatId, '❌ Invalid source wallet key format.\n\nMust be base58 encoded Solana private key.');
            return;
        }

        // Validate min and amount
        if (isNaN(minBalance) || minBalance <= 0 || minBalance > 10) {
            await this.sendMessage(chatId, '❌ Invalid minimum balance. Must be between 0.001 and 10 SOL.');
            return;
        }
        if (isNaN(fundAmount) || fundAmount <= 0 || fundAmount > 10) {
            await this.sendMessage(chatId, '❌ Invalid fund amount. Must be between 0.001 and 10 SOL.');
            return;
        }

        // Validate the source key by trying to create a keypair
        let sourceKeypair;
        try {
            sourceKeypair = Keypair.fromSecretKey(bs58.decode(sourceKey));
        } catch {
            await this.sendMessage(chatId, '❌ Invalid source wallet private key.\n\nCould not decode the key.');
            return;
        }

        // Configure auto-fund in session
        sessions.setAutoFund(chatId, {
            enabled: true,
            sourceKey: sourceKey,
            sourceWallet: sourceKeypair.publicKey.toBase58(),
            minBalance: Math.floor(minBalance * 1e9),
            fundAmount: Math.floor(fundAmount * 1e9)
        });

        await this.sendMessage(chatId, `
💰 <b>AUTO-FUND ENABLED</b>

<b>Source Wallet:</b> <code>${sourceKeypair.publicKey.toBase58().slice(0, 8)}...${sourceKeypair.publicKey.toBase58().slice(-6)}</code>
<b>Min Balance:</b> ${minBalance} SOL
<b>Fund Amount:</b> ${fundAmount} SOL

When your launcher wallet drops below ${minBalance} SOL, it will automatically receive ${fundAmount} SOL from your source wallet.

⚠️ Make sure your source wallet has enough SOL!

<b>Commands:</b>
/autofund status - Check status
/autofund off - Disable auto-fund
        `.trim());

        console.log(`[AUTOFUND] Enabled for user ${msg.from.id}`);
    }
}

// Start bot if running directly
if (require.main === module) {
    const token = process.env.TELEGRAM_BOT_TOKEN;
    if (!token) {
        console.error('TELEGRAM_BOT_TOKEN environment variable required');
        process.exit(1);
    }

    const bot = new LaunchrBot(token);
    bot.startPolling();
}

module.exports = { LaunchrBot };
