/**
 * LAUNCHR - Legal Disclaimers & Compliance Module
 *
 * This module contains all legal text, disclaimers, and compliance
 * requirements for operating in the United States and globally.
 *
 * CRITICAL: These disclaimers are essential for legal protection.
 * They establish that:
 *
 * 1. LAUNCHR is NOT a custodial service (we never hold private keys)
 * 2. LAUNCHR is NOT a money transmitter (we don't move funds)
 * 3. LAUNCHR is NOT an investment advisor (no financial advice)
 * 4. LAUNCHR is an entertainment/utility tool for meme coins
 * 5. Users assume ALL risk and responsibility
 * 6. No guarantees of profit or returns
 *
 * CONSULT WITH A LEGAL PROFESSIONAL FOR YOUR SPECIFIC SITUATION.
 */

// ═══════════════════════════════════════════════════════════════════════
// DISCLAIMER TEXT BLOCKS
// ═══════════════════════════════════════════════════════════════════════

const DISCLAIMERS = {
    /**
     * Full legal disclaimer (shown on first use and /legal command)
     */
    FULL: `
<b>IMPORTANT LEGAL NOTICE</b>

LAUNCHR is an <b>EXPERIMENTAL SOFTWARE TOOL</b> provided for <b>ENTERTAINMENT AND EDUCATIONAL PURPOSES ONLY</b>.

<b>NOT A CUSTODIAL SERVICE</b>
LAUNCHR does NOT store, control, or have access to your private keys. All wallet authentication is handled by third-party providers (Privy) using Multi-Party Computation (MPC). You maintain full custody of your assets at all times.

<b>NOT A MONEY TRANSMITTER</b>
LAUNCHR does NOT transmit, receive, or hold funds on behalf of users. All transactions are executed directly on the Solana blockchain by users themselves.

<b>NOT FINANCIAL ADVICE</b>
Nothing provided by LAUNCHR constitutes financial, investment, legal, or tax advice. LAUNCHR does NOT recommend any investment decisions. Meme coins are highly speculative and may lose all value.

<b>NO GUARANTEES</b>
LAUNCHR makes NO guarantees about:
• Token performance or value
• Profit or returns
• Software reliability or uptime
• Protection from losses

<b>USER RESPONSIBILITIES</b>
By using LAUNCHR, you confirm:
• You are solely responsible for your actions
• You understand the risks of cryptocurrency
• You will not hold LAUNCHR liable for any losses
• You comply with all applicable laws in your jurisdiction
• You are of legal age in your jurisdiction

<b>MEME COINS</b>
Tokens created or managed through LAUNCHR are "meme coins" - digital tokens with no inherent value, utility guarantees, or backing. They are for entertainment purposes only.

<b>AS-IS SOFTWARE</b>
LAUNCHR is provided "AS IS" without warranty of any kind, express or implied, including but not limited to the warranties of merchantability, fitness for a particular purpose, and noninfringement.

<b>LIMITATION OF LIABILITY</b>
In no event shall LAUNCHR, its developers, affiliates, or contributors be liable for any claim, damages, or other liability arising from the use of this software.

By continuing to use LAUNCHR, you acknowledge that you have read, understood, and agree to these terms.
`.trim(),

    /**
     * Short disclaimer (shown with sensitive operations)
     */
    SHORT: `
<i>LAUNCHR is experimental software for entertainment purposes only. Not financial advice. You are solely responsible for your actions. <a href="https://www.launchronsol.xyz/legal">Full terms</a></i>
`.trim(),

    /**
     * Wallet connection disclaimer
     */
    WALLET_CONNECT: `
<b>WALLET CONNECTION</b>

You are about to connect your wallet via our secure web interface.

<b>Security Measures:</b>
• Your private key is NEVER sent to our servers
• Authentication uses Privy MPC (Multi-Party Computation)
• You maintain full custody of your wallet
• Connection can be revoked anytime

<b>What We Access:</b>
• Your public wallet address (for display only)
• Permission to request transaction signatures
• You approve each transaction individually

<b>What We NEVER Access:</b>
• Your private key (NEVER)
• Your seed phrase (NEVER)
• Ability to move funds without your approval (NEVER)

<i>By connecting, you accept our <a href="https://www.launchronsol.xyz/terms">Terms of Service</a> and <a href="https://www.launchronsol.xyz/privacy">Privacy Policy</a>.</i>
`.trim(),

    /**
     * Engine activation disclaimer
     */
    ENGINE_ACTIVATE: `
<b>AUTOMATED ENGINE ACTIVATION</b>

You are about to activate the LAUNCHR fee distribution engine.

<b>What This Does:</b>
• Automatically claims your Pump.fun creator fees
• Distributes fees according to your allocations
• Executes transactions on your behalf (with your pre-approval)

<b>Risks:</b>
• Transactions incur Solana network fees
• Market conditions affect buyback effectiveness
• Engine operates based on algorithms, not judgment
• You may experience losses

<b>Your Control:</b>
• You can pause/stop the engine anytime
• You can change allocations anytime
• You can disconnect and revoke access anytime

<i>By activating, you accept full responsibility for all engine actions.</i>
`.trim(),

    /**
     * Token creation disclaimer
     */
    TOKEN_CREATE: `
<b>TOKEN CREATION NOTICE</b>

You are about to create a new token on Pump.fun.

<b>Important:</b>
• Token creation is <b>PERMANENT</b> and <b>IRREVERSIBLE</b>
• You are responsible for all token activity
• Created tokens have NO guaranteed value
• Most meme coins lose significant value

<b>Legal Responsibility:</b>
• You must comply with all applicable laws
• You must not create tokens that violate securities laws
• You must not engage in fraud or manipulation
• You are solely liable for your token

<b>LAUNCHR's Role:</b>
• We provide tools only
• We make no endorsement of your token
• We are not responsible for your token's performance
• We may delist tokens that violate our policies

<i>By creating a token, you accept full legal and financial responsibility.</i>
`.trim(),

    /**
     * Risk warning (for high-risk actions)
     */
    RISK_WARNING: `
<b>HIGH RISK WARNING</b>

Cryptocurrency and meme coins are <b>EXTREMELY VOLATILE</b> and <b>HIGH RISK</b>.

You could lose <b>100% OF YOUR INVESTMENT</b>.

Only use funds you can afford to lose completely.

<i>This is not financial advice. DYOR.</i>
`.trim(),

    /**
     * US-specific disclaimer
     */
    US_DISCLAIMER: `
<b>UNITED STATES USERS</b>

LAUNCHR is NOT registered with:
• The Securities and Exchange Commission (SEC)
• The Commodity Futures Trading Commission (CFTC)
• FinCEN as a Money Services Business
• Any state financial regulatory agency

Tokens created or managed through LAUNCHR:
• Are NOT securities offerings
• Are NOT investment contracts
• Have NO expectation of profit from others' efforts
• Are utility/meme tokens for entertainment only

If you are uncertain about the legal status of using LAUNCHR in your jurisdiction, consult a qualified attorney before proceeding.
`.trim(),

    /**
     * Non-custodial statement (for compliance)
     */
    NON_CUSTODIAL: `
<b>NON-CUSTODIAL STATEMENT</b>

LAUNCHR is a <b>NON-CUSTODIAL</b> software tool.

• We do NOT have access to your private keys
• We do NOT hold or control your funds
• We CANNOT move your funds without your explicit approval
• All transactions require YOUR signature

You maintain <b>FULL CUSTODY</b> of your assets at all times.

We use Privy for authentication, which implements Multi-Party Computation (MPC). This means your full private key never exists in any single location.
`.trim(),

    /**
     * Privacy statement
     */
    PRIVACY: `
<b>PRIVACY STATEMENT</b>

<b>What We Collect:</b>
• Telegram user ID (for session management)
• Wallet public address (truncated, for display)
• Usage analytics (anonymized)

<b>What We DON'T Collect:</b>
• Private keys (NEVER)
• Personal identifying information
• Location data
• Financial records

<b>Data Retention:</b>
• Session data: 30 days after last activity
• You can request deletion anytime via /unlink

<b>Third Parties:</b>
• Privy (authentication)
• Solana blockchain (transactions, public by nature)
• Telegram (messaging platform)

See full privacy policy: https://www.launchronsol.xyz/privacy
`.trim(),
};

// ═══════════════════════════════════════════════════════════════════════
// ACCEPTANCE TRACKING
// ═══════════════════════════════════════════════════════════════════════

// In-memory acceptance tracking (also persisted via session-bridge)
const acceptanceLog = new Map();

/**
 * Check if user has accepted terms
 */
function hasAcceptedTerms(chatId) {
    const chatIdStr = String(chatId);
    return acceptanceLog.has(chatIdStr);
}

/**
 * Record user's acceptance of terms
 */
function recordAcceptance(chatId, username = null) {
    const chatIdStr = String(chatId);

    acceptanceLog.set(chatIdStr, {
        acceptedAt: Date.now(),
        username: username || null,
        version: TERMS_VERSION,
    });

    // Log for compliance audit trail
    console.log(`[LEGAL] Terms accepted: chatId=${chatIdStr.slice(0, 4)}... version=${TERMS_VERSION}`);

    return true;
}

/**
 * Get acceptance record
 */
function getAcceptance(chatId) {
    return acceptanceLog.get(String(chatId)) || null;
}

// Current terms version (increment when terms change)
const TERMS_VERSION = '1.0.0';

// ═══════════════════════════════════════════════════════════════════════
// INLINE KEYBOARD BUTTONS FOR ACCEPTANCE
// ═══════════════════════════════════════════════════════════════════════

const ACCEPT_KEYBOARD = {
    inline_keyboard: [
        [
            { text: 'I Accept the Terms', callback_data: 'legal_accept' },
        ],
        [
            { text: 'View Full Terms', url: 'https://www.launchronsol.xyz/terms' },
            { text: 'Cancel', callback_data: 'legal_cancel' },
        ],
    ],
};

const CONFIRM_RISK_KEYBOARD = {
    inline_keyboard: [
        [
            { text: 'I Understand the Risks', callback_data: 'risk_accept' },
        ],
        [
            { text: 'Cancel', callback_data: 'risk_cancel' },
        ],
    ],
};

// ═══════════════════════════════════════════════════════════════════════
// UTILITY FUNCTIONS
// ═══════════════════════════════════════════════════════════════════════

/**
 * Get disclaimer for a specific context
 */
function getDisclaimer(type) {
    return DISCLAIMERS[type.toUpperCase()] || DISCLAIMERS.SHORT;
}

/**
 * Format disclaimer with user-specific info
 */
function formatDisclaimer(type, data = {}) {
    let text = getDisclaimer(type);

    // Replace placeholders if any
    if (data.username) {
        text = text.replace('{{username}}', data.username);
    }
    if (data.wallet) {
        text = text.replace('{{wallet}}', data.wallet);
    }

    return text;
}

/**
 * Check if action requires risk warning
 */
function requiresRiskWarning(action) {
    const highRiskActions = [
        'create_token',
        'activate_engine',
        'set_allocations',
        'execute_trade',
    ];
    return highRiskActions.includes(action);
}

/**
 * Get the terms version
 */
function getTermsVersion() {
    return TERMS_VERSION;
}

// ═══════════════════════════════════════════════════════════════════════
// EXPORTS
// ═══════════════════════════════════════════════════════════════════════

module.exports = {
    // Disclaimer texts
    DISCLAIMERS,

    // Keyboards
    ACCEPT_KEYBOARD,
    CONFIRM_RISK_KEYBOARD,

    // Functions
    getDisclaimer,
    formatDisclaimer,
    hasAcceptedTerms,
    recordAcceptance,
    getAcceptance,
    requiresRiskWarning,
    getTermsVersion,

    // Version
    TERMS_VERSION,
};
