/**
 * LAUNCHR - Secure Telegram Bot v2
 *
 * CIA-LEVEL SECURITY ARCHITECTURE
 * ═══════════════════════════════════════════════════════════════════════
 *
 * This bot NEVER handles private keys. Period.
 *
 * All wallet operations happen through:
 * 1. Web interface with Privy MPC authentication
 * 2. Users click a secure link from Telegram
 * 3. Authenticate on web, link back to Telegram session
 * 4. Bot receives read-only status updates
 *
 * USER FLOW:
 * ─────────────────────────────────────────────────────────────────────
 *
 *   User: /start
 *        │
 *        ▼
 *   Bot: Welcome! [Create Token] or [Import Existing]
 *        │
 *        ├── Create ─────► Web link ─────► Pump.fun creation flow
 *        │                                        │
 *        └── Import ─────► /link command          │
 *                               │                  │
 *                               ▼                  ▼
 *                          Secure link ───► Web authentication
 *                               │                  │
 *                               │                  │
 *                               ▼                  ▼
 *                          Session linked ◄────────┘
 *                               │
 *                               ▼
 *                          /status, /allocations, /start, /stop
 *                          (all read-only or via web callbacks)
 *
 * ═══════════════════════════════════════════════════════════════════════
 */

const https = require('https');
const linkTokens = require('./link-tokens');
const sessionBridge = require('./session-bridge');
const legal = require('./legal');
const notifications = require('./notifications');

// ═══════════════════════════════════════════════════════════════════════
// BOT CONFIGURATION
// ═══════════════════════════════════════════════════════════════════════

const BOT_CONFIG = {
    // Web URLs
    WEB_BASE_URL: process.env.LAUNCHR_WEB_URL || 'https://www.launchronsol.xyz',

    // Polling settings
    POLL_TIMEOUT: 30,
    POLL_ERROR_DELAY: 5000,

    // Bot info
    BOT_USERNAME: process.env.TELEGRAM_BOT_USERNAME || 'LAUNCHR_V2_BOT',
};

// ═══════════════════════════════════════════════════════════════════════
// BOT CLASS
// ═══════════════════════════════════════════════════════════════════════

class SecureLaunchrBot {
    constructor(token) {
        if (!token) {
            throw new Error('Bot token required');
        }

        this.token = token;
        this.baseUrl = `https://api.telegram.org/bot${token}`;
        this.offset = 0;
        this.running = false;

        // Initialize notifications system
        notifications.init(token);

        // Command handlers
        this.commands = {
            '/start': this.handleStart.bind(this),
            '/create': this.handleCreate.bind(this),
            '/existing': this.handleExisting.bind(this),
            '/help': this.handleHelp.bind(this),
            '/link': this.handleLink.bind(this),
            '/unlink': this.handleUnlink.bind(this),
            '/status': this.handleStatus.bind(this),
            '/legal': this.handleLegal.bind(this),
            '/privacy': this.handlePrivacy.bind(this),
            '/guide': this.handleGuide.bind(this),
            '/alerts': this.handleAlerts.bind(this),
            '/dashboard': this.handleDashboard.bind(this),
        };

        // Callback query handlers
        this.callbacks = {
            'legal_accept': this.handleLegalAccept.bind(this),
            'legal_cancel': this.handleLegalCancel.bind(this),
            'action_create': this.handleActionCreate.bind(this),
            'action_import': this.handleActionImport.bind(this),
            'action_unlink': this.handleActionUnlink.bind(this),
            'alerts_toggle': this.handleAlertsToggle.bind(this),
        };

        console.log('[BOT] SecureLaunchrBot initialized');
    }

    // ═══════════════════════════════════════════════════════════════════
    // TELEGRAM API METHODS
    // ═══════════════════════════════════════════════════════════════════

    async request(method, params = {}) {
        return new Promise((resolve, reject) => {
            const url = `${this.baseUrl}/${method}`;
            const data = JSON.stringify(params);

            const req = https.request(url, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Content-Length': Buffer.byteLength(data),
                },
            }, (res) => {
                let body = '';
                res.on('data', chunk => body += chunk);
                res.on('end', () => {
                    try {
                        const result = JSON.parse(body);
                        if (result.ok) {
                            resolve(result.result);
                        } else {
                            reject(new Error(result.description || 'Unknown error'));
                        }
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

    async sendMessage(chatId, text, options = {}) {
        return this.request('sendMessage', {
            chat_id: chatId,
            text,
            parse_mode: 'HTML',
            disable_web_page_preview: true,
            ...options,
        });
    }

    async answerCallback(callbackId, text = '', options = {}) {
        return this.request('answerCallbackQuery', {
            callback_query_id: callbackId,
            text,
            ...options,
        });
    }

    async editMessage(chatId, messageId, text, options = {}) {
        return this.request('editMessageText', {
            chat_id: chatId,
            message_id: messageId,
            text,
            parse_mode: 'HTML',
            disable_web_page_preview: true,
            ...options,
        });
    }

    // ═══════════════════════════════════════════════════════════════════
    // COMMAND HANDLERS
    // ═══════════════════════════════════════════════════════════════════

    /**
     * /start - Welcome message with Create/Import options
     */
    async handleStart(chatId, args, msg) {
        // Check if deep link (e.g., /start link_abc123)
        if (args[0]?.startsWith('link_')) {
            // Handle link callback (user clicked link from web)
            return this.handleLinkCallback(chatId, args[0].replace('link_', ''), msg);
        }

        const keyboard = {
            inline_keyboard: [
                [
                    { text: 'Create New Token', callback_data: 'action_create' },
                    { text: 'Import Existing', callback_data: 'action_import' },
                ],
                [
                    { text: 'View Guide', url: `${BOT_CONFIG.WEB_BASE_URL}/guide` },
                    { text: 'Dashboard', url: `${BOT_CONFIG.WEB_BASE_URL}/dashboard` },
                ],
            ],
        };

        const text = `
<b>LAUNCHR</b>
<i>Programmable Liquidity for Pump.fun</i>

The first AI-powered fee allocation engine.

<b>Commands:</b>
/create - Launch a new token on Pump.fun
/existing - Import an existing Pump.fun token

<b>What would you like to do?</b>

<b>/create</b> - Launch a new token on Pump.fun with LAUNCHR's automated fee distribution built-in.

<b>/existing</b> - Connect an existing Pump.fun token to LAUNCHR to automate your creator fee allocations.

<i>All wallet connections are secure and non-custodial.</i>
`.trim();

        await this.sendMessage(chatId, text, { reply_markup: keyboard });
    }

    /**
     * /help - Show all commands
     */
    async handleHelp(chatId) {
        const text = `
<b>LAUNCHR Commands</b>

<b>Main Actions:</b>
/create - Launch a new token on Pump.fun
/existing - Import an existing Pump.fun token

<b>Getting Started:</b>
/start - Welcome & options
/link - Connect your wallet
/guide - Complete walkthrough

<b>After Linking:</b>
/status - Your session status
/dashboard - Open web dashboard
/alerts - Notification settings

<b>Account:</b>
/unlink - Disconnect wallet
/legal - Terms & disclaimers
/privacy - Privacy policy
/help - This message

<b>Support:</b>
Website: ${BOT_CONFIG.WEB_BASE_URL}
Twitter: @LaunchrTG

<i>LAUNCHR is non-custodial. We never have access to your private keys.</i>
`.trim();

        await this.sendMessage(chatId, text);
    }

    /**
     * /link - Generate secure link to connect wallet
     */
    async handleLink(chatId, args, msg) {
        // Check if already linked
        if (sessionBridge.isLinked(chatId)) {
            const session = sessionBridge.getSession(chatId);
            const text = `
<b>Already Connected</b>

Wallet: <code>${session.walletPreview}</code>
${session.mint ? `Token: <code>${session.mintPreview}</code>` : 'Token: Not set'}
Status: ${session.engine?.active ? 'Engine Running' : 'Engine Paused'}

Use /unlink to disconnect first.
`.trim();

            await this.sendMessage(chatId, text);
            return;
        }

        // Create pending session
        const sessionResult = sessionBridge.createPendingSession(chatId, {
            username: msg.from?.username,
        });

        if (!sessionResult.success) {
            await this.sendMessage(chatId, `Error: ${sessionResult.error}`);
            return;
        }

        // Generate secure link token
        const tokenResult = linkTokens.generateToken(chatId, { action: 'link' });

        if (!tokenResult.success) {
            await this.sendMessage(chatId, `Error: ${tokenResult.error}`);
            return;
        }

        const keyboard = {
            inline_keyboard: [
                [
                    { text: 'Connect Wallet', url: tokenResult.linkUrl },
                ],
                [
                    { text: 'Why is this secure?', callback_data: 'info_security' },
                ],
            ],
        };

        const text = `
<b>SECURE WALLET CONNECTION</b>

Click the button below to connect your wallet securely via our website.

<b>Security Measures:</b>
• Your private key NEVER leaves your device
• Authentication uses Privy MPC
• We CANNOT access your funds without your approval
• This link expires in 5 minutes

<b>What happens:</b>
1. Click "Connect Wallet"
2. Authenticate with your preferred method
3. Approve the connection
4. Return here for confirmation

<i>Link expires: ${new Date(tokenResult.expiresAt).toLocaleTimeString()}</i>
`.trim();

        await this.sendMessage(chatId, text, { reply_markup: keyboard });
    }

    /**
     * Handle link callback (when user returns from web)
     */
    async handleLinkCallback(chatId, token, msg) {
        // This is called via deep link: /start link_abc123
        // The token was already consumed by the web flow
        // We just need to confirm the link

        const session = sessionBridge.getSession(chatId);

        if (session?.linked) {
            await notifications.send(chatId, 'LINK_SUCCESS', {
                walletPreview: session.walletPreview,
            });
        } else {
            await this.sendMessage(chatId, `
<b>Link In Progress</b>

If you completed authentication on the website, your session should be active.

Use /status to check, or /link to try again.
`.trim());
        }
    }

    /**
     * /unlink - Disconnect wallet
     */
    async handleUnlink(chatId) {
        const result = sessionBridge.unlinkSession(chatId);

        if (result.success) {
            await notifications.send(chatId, 'UNLINK_SUCCESS', {});
        } else {
            await this.sendMessage(chatId, 'No active session to disconnect.');
        }
    }

    /**
     * /status - Show session status
     */
    async handleStatus(chatId) {
        const session = sessionBridge.getSession(chatId);

        if (!session || !session.linked) {
            await this.sendMessage(chatId, `
<b>Not Connected</b>

Use /link to connect your wallet.
`.trim());
            return;
        }

        const engine = session.engine || {};
        const stats = engine.stats || {};

        const keyboard = {
            inline_keyboard: [
                [
                    { text: 'Open Dashboard', url: `${BOT_CONFIG.WEB_BASE_URL}/dashboard` },
                ],
                [
                    { text: 'Refresh', callback_data: 'status_refresh' },
                ],
            ],
        };

        const text = `
<b>SESSION STATUS</b>

<b>Connection:</b>
Wallet: <code>${session.walletPreview}</code>
${session.mint ? `Token: <code>${session.mintPreview}</code>` : 'Token: <i>Not configured</i>'}

<b>Engine:</b> ${engine.active ? 'ACTIVE' : 'PAUSED'}
${engine.lastCycle ? `Last Cycle: ${new Date(engine.lastCycle).toLocaleTimeString()}` : ''}

<b>Stats:</b>
Claimed: ${formatSOL(stats.totalClaimed)} SOL
Distributed: ${formatSOL(stats.totalDistributed)} SOL
Cycles: ${stats.cycles || 0}

${engine.allocations ? `
<b>Allocations:</b>
• Market Making: ${engine.allocations.marketMaking || 0}%
• Buyback & Burn: ${engine.allocations.buybackBurn || 0}%
• Liquidity: ${engine.allocations.liquidity || 0}%
• Creator Revenue: ${engine.allocations.creatorRevenue || 0}%
` : ''}

<i>Linked: ${new Date(session.linkedAt).toLocaleDateString()}</i>
`.trim();

        await this.sendMessage(chatId, text, { reply_markup: keyboard });
    }

    /**
     * /legal - Show legal disclaimers
     */
    async handleLegal(chatId) {
        await this.sendMessage(chatId, legal.getDisclaimer('FULL'));
    }

    /**
     * /privacy - Show privacy policy
     */
    async handlePrivacy(chatId) {
        await this.sendMessage(chatId, legal.getDisclaimer('PRIVACY'));
    }

    /**
     * /guide - Complete walkthrough
     */
    async handleGuide(chatId) {
        const text = `
<b>LAUNCHR COMPLETE GUIDE</b>

<b>WHAT IS LAUNCHR?</b>

LAUNCHR automatically routes your Pump.fun creator fees into strategic actions:

• <b>Market Making</b> - RSI-timed trades for healthy price action
• <b>Buyback & Burn</b> - Deflationary token burns
• <b>Liquidity Pool</b> - Locked LP for stability
• <b>Creator Revenue</b> - Profits to your wallet

<b>HOW TO START</b>

<b>Option 1: Create New Token</b>
1. Use /start and click "Create Token"
2. Fill in token details on the website
3. Launch on Pump.fun with LAUNCHR built-in
4. Engine runs automatically

<b>Option 2: Import Existing Token</b>
1. Use /link to connect your wallet
2. Your Pump.fun tokens appear in dashboard
3. Configure allocations
4. Activate the engine

<b>SECURITY</b>

• We NEVER see your private keys
• All signing uses Privy MPC
• You maintain full custody
• Revoke access anytime

<b>COMMANDS</b>

/link - Connect wallet
/status - Check your session
/dashboard - Open web interface
/alerts - Notification settings
/unlink - Disconnect

<b>LINKS</b>

Website: ${BOT_CONFIG.WEB_BASE_URL}
Dashboard: ${BOT_CONFIG.WEB_BASE_URL}/dashboard
Twitter: @LaunchrTG

<i>Questions? DM us on Twitter.</i>
`.trim();

        await this.sendMessage(chatId, text);
    }

    /**
     * /alerts - Notification settings
     */
    async handleAlerts(chatId) {
        const session = sessionBridge.getSession(chatId);
        const prefs = session?.notifications || {
            claims: true,
            distributions: true,
            alerts: true,
            dailySummary: false,
        };

        const keyboard = {
            inline_keyboard: [
                [
                    {
                        text: `${prefs.claims ? '✅' : '❌'} Claims`,
                        callback_data: 'alerts_toggle_claims',
                    },
                    {
                        text: `${prefs.distributions ? '✅' : '❌'} Distributions`,
                        callback_data: 'alerts_toggle_distributions',
                    },
                ],
                [
                    {
                        text: `${prefs.alerts ? '✅' : '❌'} Alerts`,
                        callback_data: 'alerts_toggle_alerts',
                    },
                    {
                        text: `${prefs.dailySummary ? '✅' : '❌'} Daily Summary`,
                        callback_data: 'alerts_toggle_dailySummary',
                    },
                ],
            ],
        };

        const text = `
<b>NOTIFICATION SETTINGS</b>

Tap to toggle notifications:

<b>Claims</b> - When fees are claimed
<b>Distributions</b> - When fees are distributed
<b>Alerts</b> - Errors and warnings
<b>Daily Summary</b> - 24hr stats recap
`.trim();

        await this.sendMessage(chatId, text, { reply_markup: keyboard });
    }

    /**
     * /create - Redirect to web for token creation
     */
    async handleCreate(chatId) {
        const keyboard = {
            inline_keyboard: [
                [
                    { text: 'Create on Website', url: `${BOT_CONFIG.WEB_BASE_URL}/create` },
                ],
            ],
        };

        await this.sendMessage(chatId, `
<b>CREATE NEW TOKEN</b>

Launch a new token on Pump.fun with LAUNCHR's automated fee distribution built-in.

Token creation happens on our secure website with Privy authentication.

<b>What you'll get:</b>
• Automated fee claiming
• Smart distribution engine
• RSI-timed market making
• Buyback & burn mechanics

Click below to start:
`.trim(), { reply_markup: keyboard });
    }

    /**
     * /existing - Import an existing Pump.fun token
     */
    async handleExisting(chatId, args, msg) {
        // Check if already linked
        if (sessionBridge.isLinked(chatId)) {
            const session = sessionBridge.getSession(chatId);
            const keyboard = {
                inline_keyboard: [
                    [
                        { text: 'Open Dashboard', url: `${BOT_CONFIG.WEB_BASE_URL}/dashboard` },
                    ],
                    [
                        { text: 'Disconnect Wallet', callback_data: 'action_unlink' },
                    ],
                ],
            };

            await this.sendMessage(chatId, `
<b>WALLET ALREADY CONNECTED</b>

Wallet: <code>${session.walletPreview}</code>
${session.mint ? `Token: <code>${session.mintPreview}</code>` : 'Token: <i>Not configured</i>'}
Status: ${session.engine?.active ? 'Engine Running' : 'Engine Paused'}

Open the dashboard to import your existing Pump.fun tokens.
`.trim(), { reply_markup: keyboard });
            return;
        }

        // Check if terms accepted
        if (!legal.hasAcceptedTerms(chatId)) {
            await this.sendMessage(chatId, legal.getDisclaimer('SHORT') + '\n\n' + legal.getDisclaimer('WALLET_CONNECT'), {
                reply_markup: legal.ACCEPT_KEYBOARD,
            });
            return;
        }

        // Create pending session
        const sessionResult = sessionBridge.createPendingSession(chatId, {
            username: msg.from?.username,
        });

        if (!sessionResult.success) {
            await this.sendMessage(chatId, `Error: ${sessionResult.error}`);
            return;
        }

        // Generate secure link token
        const tokenResult = linkTokens.generateToken(chatId, { action: 'import' });

        if (!tokenResult.success) {
            await this.sendMessage(chatId, `Error: ${tokenResult.error}`);
            return;
        }

        const keyboard = {
            inline_keyboard: [
                [
                    { text: 'Connect Wallet & Import', url: tokenResult.linkUrl },
                ],
                [
                    { text: 'Why is this secure?', callback_data: 'info_security' },
                ],
            ],
        };

        await this.sendMessage(chatId, `
<b>IMPORT EXISTING TOKEN</b>

Connect your wallet to import your existing Pump.fun tokens into LAUNCHR.

<b>What happens:</b>
1. Click "Connect Wallet & Import"
2. Authenticate with your preferred method
3. Select your Pump.fun token
4. Configure fee allocations
5. Activate the engine

<b>Security:</b>
• Your private key NEVER leaves your device
• We CANNOT access your funds without approval
• This link expires in 5 minutes

<i>Link expires: ${new Date(tokenResult.expiresAt).toLocaleTimeString()}</i>
`.trim(), { reply_markup: keyboard });
    }

    /**
     * /dashboard - Link to web dashboard
     */
    async handleDashboard(chatId) {
        const session = sessionBridge.getSession(chatId);

        const keyboard = {
            inline_keyboard: [
                [
                    { text: 'Open Dashboard', url: `${BOT_CONFIG.WEB_BASE_URL}/dashboard` },
                ],
            ],
        };

        let text = `<b>DASHBOARD</b>\n\n`;

        if (session?.linked) {
            text += `Your wallet is connected. Open the dashboard to:\n\n`;
            text += `• Configure allocations\n`;
            text += `• Start/stop engine\n`;
            text += `• View detailed analytics\n`;
            text += `• Manage your tokens\n`;
        } else {
            text += `Connect your wallet to access the full dashboard.\n\n`;
            text += `Use /link first, or connect directly on the website.`;
        }

        await this.sendMessage(chatId, text, { reply_markup: keyboard });
    }

    // ═══════════════════════════════════════════════════════════════════
    // CALLBACK HANDLERS
    // ═══════════════════════════════════════════════════════════════════

    async handleLegalAccept(chatId, callbackId, msg) {
        legal.recordAcceptance(chatId, msg.from?.username);
        await this.answerCallback(callbackId, 'Terms accepted');
        await this.editMessage(chatId, msg.message.message_id, `
<b>Terms Accepted</b>

Thank you for accepting our terms.

You can now use /link to connect your wallet.
`.trim());
    }

    async handleLegalCancel(chatId, callbackId) {
        await this.answerCallback(callbackId, 'Cancelled');
    }

    async handleActionCreate(chatId, callbackId) {
        await this.answerCallback(callbackId);
        await this.handleCreate(chatId);
    }

    async handleActionImport(chatId, callbackId, msg) {
        await this.answerCallback(callbackId);

        // Check if terms accepted
        if (!legal.hasAcceptedTerms(chatId)) {
            await this.sendMessage(chatId, legal.getDisclaimer('SHORT') + '\n\n' + legal.getDisclaimer('WALLET_CONNECT'), {
                reply_markup: legal.ACCEPT_KEYBOARD,
            });
            return;
        }

        await this.handleExisting(chatId, [], msg);
    }

    async handleActionUnlink(chatId, callbackId) {
        await this.answerCallback(callbackId);
        await this.handleUnlink(chatId);
    }

    async handleAlertsToggle(chatId, callbackId, msg, data) {
        const pref = data.replace('alerts_toggle_', '');
        const session = sessionBridge.getSession(chatId);

        if (!session) {
            await this.answerCallback(callbackId, 'Not connected');
            return;
        }

        const currentPrefs = session.notifications || {};
        const newValue = !currentPrefs[pref];

        sessionBridge.setNotifications(chatId, { [pref]: newValue });

        await this.answerCallback(callbackId, `${pref} ${newValue ? 'enabled' : 'disabled'}`);

        // Refresh the alerts message
        await this.handleAlerts(chatId);
    }

    // ═══════════════════════════════════════════════════════════════════
    // POLLING & MESSAGE HANDLING
    // ═══════════════════════════════════════════════════════════════════

    async registerCommands() {
        const commands = [
            { command: 'create', description: 'Launch a new token on Pump.fun' },
            { command: 'existing', description: 'Import an existing Pump.fun token' },
            { command: 'start', description: 'Welcome & get started' },
            { command: 'status', description: 'Your session status' },
            { command: 'dashboard', description: 'Open web dashboard' },
            { command: 'guide', description: 'Complete walkthrough' },
            { command: 'alerts', description: 'Notification settings' },
            { command: 'link', description: 'Connect your wallet' },
            { command: 'unlink', description: 'Disconnect wallet' },
            { command: 'help', description: 'Show all commands' },
        ];

        try {
            await this.request('setMyCommands', { commands });
            console.log('[BOT] Commands registered');
        } catch (e) {
            console.error('[BOT] Failed to register commands:', e.message);
        }
    }

    async handleUpdate(update) {
        try {
            // Handle callback queries (button presses)
            if (update.callback_query) {
                const query = update.callback_query;
                const chatId = query.message?.chat?.id;
                const data = query.data;

                // Find matching callback handler
                for (const [prefix, handler] of Object.entries(this.callbacks)) {
                    if (data.startsWith(prefix)) {
                        await handler(chatId, query.id, query, data);
                        return;
                    }
                }

                await this.answerCallback(query.id);
                return;
            }

            // Handle messages
            if (update.message?.text) {
                const msg = update.message;
                const chatId = msg.chat.id;
                const text = msg.text.trim();
                const [command, ...args] = text.split(' ');

                const handler = this.commands[command.toLowerCase()];
                if (handler) {
                    await handler(chatId, args, msg);
                }
            }
        } catch (e) {
            console.error('[BOT] Update handler error:', e.message);
        }
    }

    async startPolling() {
        console.log('[BOT] Starting polling...');
        this.running = true;

        await this.registerCommands();

        while (this.running) {
            try {
                const updates = await this.request('getUpdates', {
                    offset: this.offset,
                    timeout: BOT_CONFIG.POLL_TIMEOUT,
                });

                for (const update of updates) {
                    this.offset = update.update_id + 1;
                    await this.handleUpdate(update);
                }
            } catch (e) {
                console.error('[BOT] Polling error:', e.message);
                await new Promise(r => setTimeout(r, BOT_CONFIG.POLL_ERROR_DELAY));
            }
        }
    }

    stopPolling() {
        this.running = false;
        console.log('[BOT] Polling stopped');
    }
}

// ═══════════════════════════════════════════════════════════════════════
// UTILITIES
// ═══════════════════════════════════════════════════════════════════════

function formatSOL(lamports) {
    if (typeof lamports === 'number' && lamports > 1000) {
        return (lamports / 1e9).toFixed(6);
    }
    return Number(lamports || 0).toFixed(6);
}

// ═══════════════════════════════════════════════════════════════════════
// EXPORTS
// ═══════════════════════════════════════════════════════════════════════

module.exports = { SecureLaunchrBot };
