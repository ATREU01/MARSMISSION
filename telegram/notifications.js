/**
 * LAUNCHR - Notification System
 *
 * Handles all outbound notifications from the engine to Telegram users.
 *
 * SECURITY ARCHITECTURE:
 * ═══════════════════════════════════════════════════════════════════════
 *
 *   ENGINE                    NOTIFICATIONS               TELEGRAM
 *   ──────                    ─────────────               ────────
 *   Claim event     ───────►  Format message  ───────►  User notification
 *   Distribution    ───────►  Check prefs     ───────►  User notification
 *   Error/Alert     ───────►  Rate limit      ───────►  User notification
 *
 * ═══════════════════════════════════════════════════════════════════════
 *
 * WHAT WE SEND:
 * - Transaction confirmations (claim, distribute)
 * - Engine status updates
 * - Error alerts
 * - Daily summaries (optional)
 *
 * WHAT WE NEVER SEND:
 * - Private keys or sensitive data
 * - Full wallet addresses
 * - Unsolicited promotional content
 */

const https = require('https');
const sessionBridge = require('./session-bridge');

// ═══════════════════════════════════════════════════════════════════════
// CONFIGURATION
// ═══════════════════════════════════════════════════════════════════════

const NOTIFICATION_CONFIG = {
    // Rate limiting
    MAX_PER_MINUTE: 10,
    MAX_PER_HOUR: 60,

    // Retry settings
    MAX_RETRIES: 3,
    RETRY_DELAY_MS: 1000,

    // Message queue
    QUEUE_MAX_SIZE: 1000,
};

// Rate limit tracking: { chatId: { minute: count, hour: count, lastMinute: ts, lastHour: ts } }
const rateLimits = new Map();

// Message queue for batching
const messageQueue = [];
let queueProcessing = false;

// Bot token (set via init)
let botToken = null;
let botBaseUrl = null;

// ═══════════════════════════════════════════════════════════════════════
// INITIALIZATION
// ═══════════════════════════════════════════════════════════════════════

/**
 * Initialize the notification system with bot token
 */
function init(token) {
    if (!token) {
        console.warn('[NOTIFICATIONS] No bot token provided');
        return false;
    }

    botToken = token;
    botBaseUrl = `https://api.telegram.org/bot${token}`;

    console.log('[NOTIFICATIONS] System initialized');
    return true;
}

// ═══════════════════════════════════════════════════════════════════════
// MESSAGE TEMPLATES
// ═══════════════════════════════════════════════════════════════════════

const TEMPLATES = {
    /**
     * Fee claim notification
     */
    CLAIM: (data) => `
<b>CLAIM COMPLETE</b>

Claimed: <b>${formatSOL(data.amount)} SOL</b>
Token: <code>${data.mintPreview || 'Unknown'}</code>
TX: <a href="https://solscan.io/tx/${data.signature}">${data.signature?.slice(0, 8) || 'View'}...</a>

<i>${new Date().toLocaleTimeString()}</i>
`.trim(),

    /**
     * Distribution notification
     */
    DISTRIBUTION: (data) => `
<b>DISTRIBUTION COMPLETE</b>

Distributed: <b>${formatSOL(data.amount)} SOL</b>

<b>Allocations:</b>
Market Making: ${data.allocations?.marketMaking || 0}%
Buyback & Burn: ${data.allocations?.buybackBurn || 0}%
Liquidity: ${data.allocations?.liquidity || 0}%
Creator Revenue: ${data.allocations?.creatorRevenue || 0}%

RSI: ${data.rsi?.toFixed(1) || '--'}
`.trim(),

    /**
     * Combined claim + distribute
     */
    CYCLE_COMPLETE: (data) => `
<b>ENGINE CYCLE COMPLETE</b>

Claimed: <b>${formatSOL(data.claimed)} SOL</b>
Distributed: <b>${formatSOL(data.distributed)} SOL</b>

<b>Breakdown:</b>
Market Making: ${formatSOL(data.breakdown?.marketMaking || 0)} SOL
Buyback & Burn: ${formatSOL(data.breakdown?.buybackBurn || 0)} SOL
Liquidity: ${formatSOL(data.breakdown?.liquidity || 0)} SOL
Creator Revenue: ${formatSOL(data.breakdown?.creatorRevenue || 0)} SOL

RSI: ${data.rsi?.toFixed(1) || '--'} | Next cycle: ~60s
`.trim(),

    /**
     * Engine started
     */
    ENGINE_STARTED: (data) => `
<b>ENGINE ACTIVATED</b>

Your LAUNCHR engine is now running.

Token: <code>${data.mintPreview}</code>
Strategy: ${data.strategy || 'Balanced'}

The engine will:
• Claim fees every ~60 seconds
• Distribute according to your allocations
• Optimize based on market conditions

Use /status to check anytime.
Use /stop to pause the engine.
`.trim(),

    /**
     * Engine stopped
     */
    ENGINE_STOPPED: (data) => `
<b>ENGINE PAUSED</b>

Your LAUNCHR engine has been paused.

<b>Session Stats:</b>
Total Claimed: ${formatSOL(data.totalClaimed || 0)} SOL
Total Distributed: ${formatSOL(data.totalDistributed || 0)} SOL
Cycles: ${data.cycles || 0}

Use /start to resume anytime.
`.trim(),

    /**
     * Error notification
     */
    ERROR: (data) => `
<b>ENGINE ALERT</b>

${data.message || 'An error occurred'}

${data.details ? `<i>${data.details}</i>` : ''}

The engine will retry automatically.
If issues persist, use /status to check.
`.trim(),

    /**
     * Low balance warning
     */
    LOW_BALANCE: (data) => `
<b>LOW BALANCE WARNING</b>

Your wallet balance is low:
<b>${formatSOL(data.balance)} SOL</b>

The engine needs SOL for transaction fees.
Please top up your wallet to continue operations.

Wallet: <code>${data.walletPreview}</code>
`.trim(),

    /**
     * Daily summary
     */
    DAILY_SUMMARY: (data) => `
<b>DAILY SUMMARY</b>

<b>24 Hour Stats:</b>
Claimed: ${formatSOL(data.claimed24h)} SOL
Distributed: ${formatSOL(data.distributed24h)} SOL
Cycles: ${data.cycles24h}

<b>All Time:</b>
Claimed: ${formatSOL(data.totalClaimed)} SOL
Distributed: ${formatSOL(data.totalDistributed)} SOL

<b>Token Performance:</b>
RSI: ${data.rsi?.toFixed(1) || '--'}
Trend: ${data.trend || 'Neutral'}

Keep building!
`.trim(),

    /**
     * Link success
     */
    LINK_SUCCESS: (data) => `
<b>WALLET LINKED</b>

Your wallet is now connected to LAUNCHR!

Wallet: <code>${data.walletPreview}</code>

<b>Next Steps:</b>
1. Use /token to set your token mint
2. Use /allocations to configure distribution
3. Use /start to activate the engine

Need help? Use /guide for a full walkthrough.
`.trim(),

    /**
     * Unlink confirmation
     */
    UNLINK_SUCCESS: () => `
<b>DISCONNECTED</b>

Your wallet has been unlinked.
All session data has been cleared.

Your funds remain safe in your wallet.
We never had access to your private keys.

Use /link to connect again anytime.
`.trim(),
};

// ═══════════════════════════════════════════════════════════════════════
// CORE FUNCTIONS
// ═══════════════════════════════════════════════════════════════════════

/**
 * Send a notification to a user
 */
async function send(chatId, type, data = {}) {
    if (!botToken) {
        console.error('[NOTIFICATIONS] Not initialized');
        return false;
    }

    // Check rate limit
    if (!checkRateLimit(chatId)) {
        console.warn(`[NOTIFICATIONS] Rate limited: ${chatId}`);
        return false;
    }

    // Check user preferences
    const session = sessionBridge.getSession(chatId);
    if (session && !shouldNotify(session.notifications, type)) {
        return false; // User has disabled this notification type
    }

    // Get template
    const template = TEMPLATES[type.toUpperCase()];
    if (!template) {
        console.error(`[NOTIFICATIONS] Unknown template: ${type}`);
        return false;
    }

    // Format message
    const text = template(data);

    // Queue the message
    queueMessage(chatId, text);

    return true;
}

/**
 * Send raw message (for custom notifications)
 */
async function sendRaw(chatId, text, options = {}) {
    if (!botToken) return false;
    if (!checkRateLimit(chatId)) return false;

    queueMessage(chatId, text, options);
    return true;
}

/**
 * Queue a message for sending
 */
function queueMessage(chatId, text, options = {}) {
    if (messageQueue.length >= NOTIFICATION_CONFIG.QUEUE_MAX_SIZE) {
        messageQueue.shift(); // Remove oldest
    }

    messageQueue.push({
        chatId,
        text,
        options,
        timestamp: Date.now(),
        retries: 0,
    });

    processQueue();
}

/**
 * Process the message queue
 */
async function processQueue() {
    if (queueProcessing) return;
    if (messageQueue.length === 0) return;

    queueProcessing = true;

    while (messageQueue.length > 0) {
        const msg = messageQueue.shift();

        try {
            await sendTelegram(msg.chatId, msg.text, msg.options);
        } catch (e) {
            console.error(`[NOTIFICATIONS] Send failed: ${e.message}`);

            // Retry logic
            if (msg.retries < NOTIFICATION_CONFIG.MAX_RETRIES) {
                msg.retries++;
                messageQueue.push(msg);
                await sleep(NOTIFICATION_CONFIG.RETRY_DELAY_MS * msg.retries);
            }
        }

        // Small delay between messages to avoid rate limits
        await sleep(50);
    }

    queueProcessing = false;
}

/**
 * Send message via Telegram API
 */
async function sendTelegram(chatId, text, options = {}) {
    return new Promise((resolve, reject) => {
        const data = JSON.stringify({
            chat_id: chatId,
            text,
            parse_mode: 'HTML',
            disable_web_page_preview: true,
            ...options,
        });

        const url = `${botBaseUrl}/sendMessage`;

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
                        resolve(result);
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

// ═══════════════════════════════════════════════════════════════════════
// BROADCAST FUNCTIONS (For system-wide notifications)
// ═══════════════════════════════════════════════════════════════════════

/**
 * Broadcast to all linked users
 */
async function broadcast(text, filter = null) {
    const sessions = sessionBridge.getAllLinkedSessions();
    let sent = 0;

    for (const session of sessions) {
        if (filter && !filter(session)) continue;

        try {
            await sendRaw(session.chatId, text);
            sent++;
        } catch (e) {
            console.error(`[BROADCAST] Failed for ${session.chatId}: ${e.message}`);
        }

        await sleep(100); // Avoid rate limits
    }

    console.log(`[BROADCAST] Sent to ${sent}/${sessions.length} users`);
    return sent;
}

/**
 * Broadcast system announcement
 */
async function broadcastAnnouncement(title, message) {
    const text = `
<b>${title}</b>

${message}

<i>- LAUNCHR Team</i>
`.trim();

    return broadcast(text);
}

// ═══════════════════════════════════════════════════════════════════════
// RATE LIMITING
// ═══════════════════════════════════════════════════════════════════════

function checkRateLimit(chatId) {
    const chatIdStr = String(chatId);
    const now = Date.now();
    const limit = rateLimits.get(chatIdStr) || {
        minute: 0,
        hour: 0,
        lastMinute: now,
        lastHour: now,
    };

    // Reset minute counter if new minute
    if (now - limit.lastMinute > 60000) {
        limit.minute = 0;
        limit.lastMinute = now;
    }

    // Reset hour counter if new hour
    if (now - limit.lastHour > 3600000) {
        limit.hour = 0;
        limit.lastHour = now;
    }

    // Check limits
    if (limit.minute >= NOTIFICATION_CONFIG.MAX_PER_MINUTE) {
        return false;
    }
    if (limit.hour >= NOTIFICATION_CONFIG.MAX_PER_HOUR) {
        return false;
    }

    // Increment counters
    limit.minute++;
    limit.hour++;
    rateLimits.set(chatIdStr, limit);

    return true;
}

// ═══════════════════════════════════════════════════════════════════════
// PREFERENCE CHECKING
// ═══════════════════════════════════════════════════════════════════════

function shouldNotify(prefs, type) {
    if (!prefs) return true; // Default to yes

    const typeMap = {
        CLAIM: 'claims',
        DISTRIBUTION: 'distributions',
        CYCLE_COMPLETE: 'distributions',
        ERROR: 'alerts',
        LOW_BALANCE: 'alerts',
        DAILY_SUMMARY: 'dailySummary',
    };

    const prefKey = typeMap[type.toUpperCase()];
    if (!prefKey) return true; // Unknown type, allow

    return prefs[prefKey] !== false;
}

// ═══════════════════════════════════════════════════════════════════════
// UTILITIES
// ═══════════════════════════════════════════════════════════════════════

function formatSOL(lamports) {
    if (typeof lamports === 'number' && lamports > 1000) {
        // Assume lamports
        return (lamports / 1e9).toFixed(6);
    }
    return Number(lamports || 0).toFixed(6);
}

function sleep(ms) {
    return new Promise(r => setTimeout(r, ms));
}

// ═══════════════════════════════════════════════════════════════════════
// EXPORTS
// ═══════════════════════════════════════════════════════════════════════

module.exports = {
    // Init
    init,

    // Core
    send,
    sendRaw,

    // Broadcast
    broadcast,
    broadcastAnnouncement,

    // Templates (for custom use)
    TEMPLATES,

    // Utils
    formatSOL,
};
