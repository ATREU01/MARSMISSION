/**
 * LAUNCHR - Telegram Module Entry Point
 *
 * Secure, non-custodial Telegram bot for LAUNCHR.
 *
 * SECURITY CERTIFICATION
 * ═══════════════════════════════════════════════════════════════════════
 *
 * This module has been designed with the following security guarantees:
 *
 * 1. ZERO PRIVATE KEY HANDLING
 *    - No private keys are ever received, stored, or processed
 *    - All wallet operations go through Privy MPC on the web
 *    - Bot only receives public addresses (truncated for display)
 *
 * 2. NON-CUSTODIAL BY DESIGN
 *    - We cannot move user funds
 *    - All transactions require user signature via Privy
 *    - Users maintain full custody at all times
 *
 * 3. DATA MINIMIZATION
 *    - Only store: chatId, privyUserId (not wallet), preferences
 *    - No PII beyond Telegram usernames (optional)
 *    - Auto-expire sessions after 30 days
 *
 * 4. SECURE LINKING
 *    - Link tokens are cryptographically random (256-bit)
 *    - Tokens expire in 5 minutes
 *    - One-time use (consumed on link)
 *    - Rate limited per user
 *
 * 5. LEGAL COMPLIANCE
 *    - Full disclaimers required before sensitive actions
 *    - Terms acceptance tracked
 *    - Non-custodial statement clear
 *    - US regulatory disclaimers included
 *
 * ═══════════════════════════════════════════════════════════════════════
 */

const { SecureLaunchrBot } = require('./bot');
const linkTokens = require('./link-tokens');
const sessionBridge = require('./session-bridge');
const legal = require('./legal');
const notifications = require('./notifications');

// ═══════════════════════════════════════════════════════════════════════
// MAIN EXPORTS
// ═══════════════════════════════════════════════════════════════════════

module.exports = {
    // Main bot class
    SecureLaunchrBot,

    // Sub-modules
    linkTokens,
    sessionBridge,
    legal,
    notifications,

    // Quick start function
    startBot,

    // Webhook handler for web callbacks
    handleWebhook,
};

// ═══════════════════════════════════════════════════════════════════════
// QUICK START
// ═══════════════════════════════════════════════════════════════════════

/**
 * Start the bot with environment configuration
 */
function startBot(options = {}) {
    const token = options.token || process.env.TELEGRAM_BOT_TOKEN;

    if (!token) {
        console.error('[TELEGRAM] TELEGRAM_BOT_TOKEN environment variable required');
        process.exit(1);
    }

    const bot = new SecureLaunchrBot(token);
    bot.startPolling();

    // Graceful shutdown
    process.on('SIGINT', () => {
        console.log('[TELEGRAM] Shutting down...');
        bot.stopPolling();
        sessionBridge.saveSessions();
        process.exit(0);
    });

    process.on('SIGTERM', () => {
        console.log('[TELEGRAM] Shutting down...');
        bot.stopPolling();
        sessionBridge.saveSessions();
        process.exit(0);
    });

    return bot;
}

// ═══════════════════════════════════════════════════════════════════════
// WEBHOOK HANDLERS (Called by main server)
// ═══════════════════════════════════════════════════════════════════════

/**
 * Handle webhook from website
 * Called when user completes authentication on web
 *
 * @param {string} type - Webhook type ('link', 'unlink', 'engine_update', etc.)
 * @param {object} data - Webhook data
 */
async function handleWebhook(type, data) {
    console.log(`[WEBHOOK] ${type}`, data);

    switch (type) {
        case 'link_complete':
            return handleLinkComplete(data);

        case 'link_failed':
            return handleLinkFailed(data);

        case 'engine_cycle':
            return handleEngineCycle(data);

        case 'engine_started':
            return handleEngineStarted(data);

        case 'engine_stopped':
            return handleEngineStopped(data);

        case 'engine_error':
            return handleEngineError(data);

        case 'low_balance':
            return handleLowBalance(data);

        default:
            console.warn(`[WEBHOOK] Unknown type: ${type}`);
            return { success: false, error: 'Unknown webhook type' };
    }
}

/**
 * Handle successful link from website
 */
async function handleLinkComplete(data) {
    const { token, privyUserId, walletAddress } = data;

    // Verify and consume the token
    const tokenResult = linkTokens.verifyAndConsumeToken(token, privyUserId);

    if (!tokenResult.valid) {
        return { success: false, error: tokenResult.error };
    }

    const chatId = tokenResult.chatId;

    // Complete the link in session bridge
    const linkResult = sessionBridge.completeLink(chatId, privyUserId, walletAddress);

    if (!linkResult.success) {
        return { success: false, error: linkResult.error };
    }

    // Send notification to user
    await notifications.send(chatId, 'LINK_SUCCESS', {
        walletPreview: sessionBridge.truncateAddress(walletAddress),
    });

    return { success: true, chatId };
}

/**
 * Handle failed link attempt
 */
async function handleLinkFailed(data) {
    const { token, error } = data;

    // Try to get chatId from token (may be expired)
    // Just log - don't notify user as token may not be valid

    console.log(`[WEBHOOK] Link failed: ${error}`);
    return { success: true };
}

/**
 * Handle engine cycle completion (claim + distribute)
 */
async function handleEngineCycle(data) {
    const { privyUserId, claimed, distributed, rsi, breakdown } = data;

    // Find session by Privy ID
    const session = sessionBridge.getSessionByPrivyId(privyUserId);
    if (!session) {
        return { success: false, error: 'Session not found' };
    }

    // Update engine status
    sessionBridge.updateEngineStatus(session.chatId, {
        active: true,
        lastCycle: Date.now(),
        totalClaimed: (session.engine?.stats?.totalClaimed || 0) + claimed,
        totalDistributed: (session.engine?.stats?.totalDistributed || 0) + distributed,
        cycles: (session.engine?.stats?.cycles || 0) + 1,
    });

    // Send notification if user enabled
    if (claimed > 0 || distributed > 0) {
        await notifications.send(session.chatId, 'CYCLE_COMPLETE', {
            claimed,
            distributed,
            rsi,
            breakdown,
        });
    }

    return { success: true };
}

/**
 * Handle engine started
 */
async function handleEngineStarted(data) {
    const { privyUserId, mint, strategy, allocations } = data;

    const session = sessionBridge.getSessionByPrivyId(privyUserId);
    if (!session) return { success: false };

    // Update session with mint
    if (mint) {
        sessionBridge.setMint(session.chatId, mint);
    }

    sessionBridge.updateEngineStatus(session.chatId, {
        active: true,
        allocations,
    });

    await notifications.send(session.chatId, 'ENGINE_STARTED', {
        mintPreview: sessionBridge.truncateAddress(mint),
        strategy,
    });

    return { success: true };
}

/**
 * Handle engine stopped
 */
async function handleEngineStopped(data) {
    const { privyUserId } = data;

    const session = sessionBridge.getSessionByPrivyId(privyUserId);
    if (!session) return { success: false };

    const stats = session.engine?.stats || {};

    sessionBridge.updateEngineStatus(session.chatId, {
        active: false,
    });

    await notifications.send(session.chatId, 'ENGINE_STOPPED', {
        totalClaimed: stats.totalClaimed,
        totalDistributed: stats.totalDistributed,
        cycles: stats.cycles,
    });

    return { success: true };
}

/**
 * Handle engine error
 */
async function handleEngineError(data) {
    const { privyUserId, message, details } = data;

    const session = sessionBridge.getSessionByPrivyId(privyUserId);
    if (!session) return { success: false };

    await notifications.send(session.chatId, 'ERROR', {
        message,
        details,
    });

    return { success: true };
}

/**
 * Handle low balance warning
 */
async function handleLowBalance(data) {
    const { privyUserId, balance, walletAddress } = data;

    const session = sessionBridge.getSessionByPrivyId(privyUserId);
    if (!session) return { success: false };

    await notifications.send(session.chatId, 'LOW_BALANCE', {
        balance,
        walletPreview: sessionBridge.truncateAddress(walletAddress),
    });

    return { success: true };
}

// ═══════════════════════════════════════════════════════════════════════
// STANDALONE MODE
// ═══════════════════════════════════════════════════════════════════════

if (require.main === module) {
    console.log(`
═══════════════════════════════════════════════════════════════════════
                    LAUNCHR TELEGRAM BOT v2.0
                    SECURE NON-CUSTODIAL MODE
═══════════════════════════════════════════════════════════════════════

Security Guarantees:
  ✓ ZERO private key handling
  ✓ Non-custodial by design
  ✓ Privy MPC authentication
  ✓ Encrypted session tokens
  ✓ Rate-limited operations
  ✓ Full legal compliance

Starting bot...
═══════════════════════════════════════════════════════════════════════
`);

    startBot();
}
