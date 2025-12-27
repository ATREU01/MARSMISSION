const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { Connection, Keypair, LAMPORTS_PER_SOL, PublicKey } = require('@solana/web3.js');
const { LaunchrEngine } = require('./launchr-engine');
const bs58 = require('bs58');
const tracker = require('./tracker');
const profiles = require('./profiles');
const { LaunchrBot } = require('./telegram-bot');

// ═══════════════════════════════════════════════════════════════════════════
// PRODUCTION CONFIGURATION - All Revenue Goes Here
// ═══════════════════════════════════════════════════════════════════════════

const PRODUCTION_CONFIG = {
    // Main Fee Wallet - ALL REVENUE GOES HERE
    FEE_WALLET_PRIVATE_KEY: process.env.FEE_WALLET_PRIVATE_KEY || '',

    // Privy configuration (for embedded wallets)
    PRIVY_APP_ID: process.env.PRIVY_APP_ID || '',

    // Helius RPC (Solana)
    HELIUS_RPC: process.env.HELIUS_RPC || process.env.RPC_URL || 'https://api.mainnet-beta.solana.com',

    // Fee Structure
    PLATFORM_FEE_PERCENT: 1,      // 1% of all fees to LAUNCHR distribution pool
    CREATOR_FEE_PERCENT: 99,       // 99% to creator's allocation engine
};

// Get fee wallet public key if private key is set
let FEE_WALLET_PUBLIC_KEY = '';
if (PRODUCTION_CONFIG.FEE_WALLET_PRIVATE_KEY) {
    try {
        const keypair = Keypair.fromSecretKey(bs58.decode(PRODUCTION_CONFIG.FEE_WALLET_PRIVATE_KEY));
        FEE_WALLET_PUBLIC_KEY = keypair.publicKey.toBase58();
        console.log(`[REVENUE] Fee wallet configured: ${FEE_WALLET_PUBLIC_KEY.slice(0, 8)}...`);
    } catch (e) {
        console.error('[REVENUE] Invalid fee wallet private key');
    }
}

console.log('[CONFIG] Production config loaded:');
console.log(`  - Privy App ID: ${PRODUCTION_CONFIG.PRIVY_APP_ID ? 'SET' : 'NOT SET'}`);
console.log(`  - Helius RPC: ${PRODUCTION_CONFIG.HELIUS_RPC ? 'SET' : 'NOT SET'}`);
console.log(`  - Fee Wallet: ${FEE_WALLET_PUBLIC_KEY ? 'SET' : 'NOT SET'}`);

// ═══════════════════════════════════════════════════════════════════════════
// VANITY KEYPAIR POOL - Pre-generated keypairs ending in "LCHr" (LAUNCHr)
// ═══════════════════════════════════════════════════════════════════════════

// Use /app/data/ for Railway volume persistence, fallback to local for dev
const DATA_DIR = process.env.RAILWAY_ENVIRONMENT ? '/app/data' : __dirname;
try { if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true }); } catch (e) {}

const VANITY_POOL_FILE = path.join(DATA_DIR, '.vanity-pool.json');
const VANITY_SUFFIX = 'LCHr'; // 4 chars = LCHr (LAUNCHr), findable in minutes
const VANITY_POOL_TARGET = 10; // Keep 10 keypairs ready
const VANITY_POOL_MIN = 3; // Start generating when below this

console.log(`[VANITY] Data directory: ${DATA_DIR}`);

let vanityPool = [];
let vanityGenerating = false;
let vanityGeneratorStats = { attempts: 0, found: 0, lastFoundAt: null };

// Rate limiting for vanity keypair endpoint (module-level for persistence)
const vanityRateLimits = {};
const VANITY_RATE_LIMIT_MS = 60000; // 1 minute between requests per IP

// VAULT: Secure storage for dispensed keypairs (secretKey never exposed to frontend)
// Maps vaultId -> { secretKey, publicKey, dispensedAt, expiresAt }
const vanityVault = new Map();
const VAULT_EXPIRY_MS = 30 * 60 * 1000; // Vault entries expire after 30 minutes
const VAULT_CLEANUP_INTERVAL = 5 * 60 * 1000; // Clean up expired entries every 5 minutes

// Generate secure vault ID
function generateVaultId() {
    const bytes = require('crypto').randomBytes(32);
    return bytes.toString('hex');
}

// Clean up expired vault entries
function cleanupVault() {
    const now = Date.now();
    let cleaned = 0;
    for (const [vaultId, entry] of vanityVault.entries()) {
        if (entry.expiresAt < now) {
            vanityVault.delete(vaultId);
            cleaned++;
        }
    }
    if (cleaned > 0) {
        console.log(`[VAULT] Cleaned ${cleaned} expired entries. Active: ${vanityVault.size}`);
    }
}

// Start vault cleanup interval
setInterval(cleanupVault, VAULT_CLEANUP_INTERVAL);

// Load existing pool from disk
function loadVanityPool() {
    try {
        if (fs.existsSync(VANITY_POOL_FILE)) {
            const data = JSON.parse(fs.readFileSync(VANITY_POOL_FILE, 'utf8'));
            vanityPool = data.pool || [];
            vanityGeneratorStats = data.stats || vanityGeneratorStats;
            console.log(`[VANITY] Loaded ${vanityPool.length} pre-generated keypairs from disk`);
        }
    } catch (e) {
        console.error('[VANITY] Failed to load pool:', e.message);
        vanityPool = [];
    }
}

// Save pool to disk
function saveVanityPool() {
    try {
        fs.writeFileSync(VANITY_POOL_FILE, JSON.stringify({
            pool: vanityPool,
            stats: vanityGeneratorStats,
            updatedAt: Date.now()
        }, null, 2));
    } catch (e) {
        console.error('[VANITY] Failed to save pool:', e.message);
    }
}

// Generate a single vanity keypair (blocking - use in worker)
function tryGenerateVanityKeypair() {
    const keypair = Keypair.generate();
    const address = keypair.publicKey.toBase58();
    vanityGeneratorStats.attempts++;

    if (address.toLowerCase().endsWith(VANITY_SUFFIX.toLowerCase())) {
        return {
            publicKey: address,
            secretKey: bs58.encode(keypair.secretKey),
            generatedAt: Date.now()
        };
    }
    return null;
}

// Background generator - runs continuously when pool is low
async function runVanityGenerator() {
    if (vanityGenerating) return;
    vanityGenerating = true;

    console.log(`[VANITY] Starting background generator (pool: ${vanityPool.length}/${VANITY_POOL_TARGET})`);

    let batchAttempts = 0;
    const batchSize = 10000; // Check pool status every 10k attempts

    while (vanityPool.length < VANITY_POOL_TARGET) {
        // Generate in small batches to not block event loop
        for (let i = 0; i < 100; i++) {
            const result = tryGenerateVanityKeypair();
            if (result) {
                vanityPool.push(result);
                vanityGeneratorStats.found++;
                vanityGeneratorStats.lastFoundAt = Date.now();
                console.log(`[VANITY] Found keypair #${vanityGeneratorStats.found}: ${result.publicKey} (${vanityGeneratorStats.attempts.toLocaleString()} attempts)`);
                saveVanityPool();

                if (vanityPool.length >= VANITY_POOL_TARGET) break;
            }
            batchAttempts++;
        }

        // Log progress every batch
        if (batchAttempts >= batchSize) {
            console.log(`[VANITY] Progress: ${vanityGeneratorStats.attempts.toLocaleString()} attempts, pool: ${vanityPool.length}/${VANITY_POOL_TARGET}`);
            batchAttempts = 0;
        }

        // Yield to event loop
        await new Promise(r => setImmediate(r));
    }

    vanityGenerating = false;
    console.log(`[VANITY] Generator paused - pool full (${vanityPool.length}/${VANITY_POOL_TARGET})`);
}

// Get a vanity keypair from the pool
function getVanityKeypair() {
    if (vanityPool.length === 0) {
        return null;
    }

    const keypair = vanityPool.shift(); // Remove from pool
    saveVanityPool();

    // Start generator if pool is low
    if (vanityPool.length < VANITY_POOL_MIN) {
        setImmediate(() => runVanityGenerator());
    }

    return keypair;
}

// Initialize vanity pool on startup
loadVanityPool();
if (vanityPool.length < VANITY_POOL_TARGET) {
    // Start generating in background after a short delay
    setTimeout(() => runVanityGenerator(), 5000);
}

console.log(`[VANITY] Pool status: ${vanityPool.length}/${VANITY_POOL_TARGET} keypairs ready`);

// ═══════════════════════════════════════════════════════════════════════════
// CONFIG INJECTION - Inject env vars into client-side HTML
// ═══════════════════════════════════════════════════════════════════════════

function injectConfig(html) {
    // Inject the runtime config into the HTML
    const configScript = `
    <script>
        // LAUNCHR Production Config (injected by server)
        window.LAUNCHR_CONFIG = {
            PRIVY_APP_ID: '${PRODUCTION_CONFIG.PRIVY_APP_ID}',
            SOLANA_RPC: '${PRODUCTION_CONFIG.HELIUS_RPC}',
            FEE_WALLET: '${FEE_WALLET_PUBLIC_KEY}',
            PLATFORM_FEE: ${PRODUCTION_CONFIG.PLATFORM_FEE_PERCENT},
            SEED_SOL: ${PRODUCTION_CONFIG.SEED_SOL_PER_LAUNCH},
        };
    </script>
    `;

    // Replace placeholders with actual values
    let injected = html
        .replace(/YOUR_PRIVY_APP_ID/g, PRODUCTION_CONFIG.PRIVY_APP_ID)
        .replace(/YOUR_HELIUS_API_KEY/g, PRODUCTION_CONFIG.HELIUS_RPC.split('api-key=')[1] || '')
        .replace('https://mainnet.helius-rpc.com/?api-key=YOUR_HELIUS_API_KEY', PRODUCTION_CONFIG.HELIUS_RPC);

    // Inject config script after <head>
    injected = injected.replace('<head>', '<head>' + configScript);

    return injected;
}

// Cache landing page HTML (with config injection)
let landingPageCache = null;
function getLandingHTML() {
    // Always read fresh in development, cache in production
    try {
        const html = fs.readFileSync(path.join(__dirname, 'website', 'index.html'), 'utf8');
        return injectConfig(html);
    } catch (e) {
        // Fallback redirect to /app if landing page not found
        return '<html><head><meta http-equiv="refresh" content="0;url=/app"></head></html>';
    }
}

// Terms & Conditions Page
function getTermsHTML() {
    return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Terms & Conditions - LAUNCHR</title>
    <style>
        * { margin: 0; padding: 0; box-sizing: border-box; }
        body {
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
            background: #0a0a0a;
            color: #e5e5e5;
            line-height: 1.8;
            padding: 40px 20px;
        }
        .container {
            max-width: 800px;
            margin: 0 auto;
            background: #111;
            border: 1px solid #222;
            border-radius: 16px;
            padding: 40px;
        }
        h1 { color: #10b981; font-size: 28px; margin-bottom: 8px; }
        h2 { color: #fff; font-size: 20px; margin: 32px 0 16px 0; border-bottom: 1px solid #333; padding-bottom: 8px; }
        p { margin-bottom: 16px; color: #aaa; }
        ul { margin: 16px 0 16px 24px; }
        li { margin-bottom: 8px; color: #aaa; }
        .warning { background: rgba(239,68,68,0.1); border: 1px solid rgba(239,68,68,0.3); border-radius: 8px; padding: 16px; margin: 24px 0; }
        .warning strong { color: #ef4444; }
        .back-link { display: inline-block; margin-top: 32px; color: #10b981; text-decoration: none; }
        .back-link:hover { text-decoration: underline; }
        .updated { font-size: 12px; color: #666; margin-top: 8px; }
    </style>
</head>
<body>
    <div class="container">
        <h1>Terms & Conditions</h1>
        <p class="updated">Last Updated: December 2024</p>

        <div class="warning">
            <strong>IMPORTANT NOTICE:</strong> LAUNCHR is a meme coin and entertainment platform created for educational and recreational purposes only.
            By accessing or using this platform, you agree to be bound by these terms.
        </div>

        <h2>1. Nature of the Platform</h2>
        <p>LAUNCHR is a cryptocurrency token and associated software tools operating on the Solana blockchain. This project is:</p>
        <ul>
            <li>Created purely for <strong>entertainment and educational purposes</strong></li>
            <li>A "meme coin" with <strong>no intrinsic value</strong></li>
            <li>NOT an investment vehicle or security</li>
            <li>NOT intended to generate financial returns for holders</li>
        </ul>

        <h2>2. No Financial Advice</h2>
        <p>Nothing on this platform constitutes financial, investment, legal, or tax advice. The creators and operators of LAUNCHR:</p>
        <ul>
            <li>Are NOT licensed financial advisors</li>
            <li>Make NO representations about future value or returns</li>
            <li>Do NOT recommend purchasing, selling, or holding any cryptocurrency</li>
            <li>Strongly advise you to consult qualified professionals before any financial decisions</li>
        </ul>

        <h2>3. Risk Acknowledgment</h2>
        <p>By using this platform, you acknowledge and accept that:</p>
        <ul>
            <li>Cryptocurrency investments are <strong>extremely high risk</strong></li>
            <li>You may lose <strong>100% of any funds</strong> used to purchase tokens</li>
            <li>Meme coins are particularly volatile and speculative</li>
            <li>Smart contracts may contain bugs or vulnerabilities</li>
            <li>Blockchain transactions are irreversible</li>
            <li>Regulatory changes may affect cryptocurrency at any time</li>
        </ul>

        <h2>4. No Expectation of Profit</h2>
        <p>LAUNCHR tokens are distributed and traded with <strong>NO expectation of profit</strong> derived from the efforts of others. Any value fluctuation is due solely to market dynamics and community interest, not the promise or efforts of the development team.</p>

        <h2>5. Educational Purpose</h2>
        <p>This platform demonstrates concepts including:</p>
        <ul>
            <li>Automated fee distribution mechanisms</li>
            <li>Token buyback and burn mechanics</li>
            <li>Market making algorithms</li>
            <li>Liquidity provision strategies</li>
        </ul>
        <p>These features are provided for educational exploration of DeFi concepts.</p>

        <h2>6. No Warranty</h2>
        <p>This software and platform are provided "AS IS" without warranty of any kind, express or implied, including but not limited to warranties of merchantability, fitness for a particular purpose, and non-infringement.</p>

        <h2>7. Limitation of Liability</h2>
        <p>In no event shall the creators, developers, or operators of LAUNCHR be liable for any direct, indirect, incidental, special, consequential, or punitive damages, including but not limited to loss of profits, data, or other intangible losses resulting from:</p>
        <ul>
            <li>Use or inability to use the platform</li>
            <li>Any transactions made through the platform</li>
            <li>Unauthorized access to your wallet or data</li>
            <li>Bugs, viruses, or errors in the software</li>
            <li>Any third-party actions or content</li>
        </ul>

        <h2>8. User Responsibilities</h2>
        <p>You are solely responsible for:</p>
        <ul>
            <li>Securing your private keys and wallet</li>
            <li>Understanding the risks of cryptocurrency</li>
            <li>Complying with your local laws and regulations</li>
            <li>Any tax obligations arising from your activities</li>
            <li>Your own financial decisions</li>
        </ul>

        <h2>9. Regulatory Compliance</h2>
        <p>LAUNCHR does not target or solicit users in jurisdictions where cryptocurrency activities are prohibited. Users are responsible for ensuring their participation complies with their local laws.</p>

        <h2>10. Modifications</h2>
        <p>We reserve the right to modify these terms at any time. Continued use of the platform after changes constitutes acceptance of the modified terms.</p>

        <h2>11. Governing Law</h2>
        <p>These terms shall be governed by and construed in accordance with applicable laws, without regard to conflict of law principles.</p>

        <div class="warning">
            <strong>REMEMBER:</strong> This is a meme coin for fun and education. Never invest more than you can afford to lose completely.
            Do Your Own Research (DYOR). Have fun, but be responsible!
        </div>

        <a href="/" class="back-link">&larr; Back to LAUNCHR</a>
    </div>
</body>
</html>`;
}

// Product Roadmap Page - Premium Design
function getRoadmapHTML() {
    return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Roadmap - LAUNCHR</title>
    <link href="https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600;700;800;900&display=swap" rel="stylesheet">
    <style>
        *{margin:0;padding:0;box-sizing:border-box}
        :root{--gold:#F7B32B;--gold-glow:rgba(247,179,43,0.12);--green:#10B981;--green-glow:rgba(16,185,129,0.12);--bg:#000;--surface:#080808;--surface-2:#0f0f0f;--border:rgba(255,255,255,0.06);--text:#fff;--text-2:rgba(255,255,255,0.7);--text-3:rgba(255,255,255,0.4);--red:#ef4444}
        body{font-family:'Inter',-apple-system,sans-serif;background:var(--bg);color:var(--text);line-height:1.6}
        .nav{position:fixed;top:0;left:0;right:0;padding:16px 32px;display:flex;justify-content:space-between;align-items:center;z-index:100;background:rgba(0,0,0,0.85);backdrop-filter:blur(20px);border-bottom:1px solid var(--border)}
        .nav-logo{display:flex;align-items:center;gap:10px;text-decoration:none;color:var(--text);font-weight:700;font-size:16px}
        .nav-logo img{width:28px;height:28px;border-radius:6px}
        .nav-links{display:flex;gap:28px}
        .nav-links a{color:var(--text-2);text-decoration:none;font-size:13px;font-weight:500;transition:color .2s}
        .nav-links a:hover{color:var(--gold)}
        .nav-btn{padding:8px 16px;background:var(--gold);color:#000;font-weight:600;font-size:13px;border-radius:6px;text-decoration:none;transition:all .2s}
        .nav-btn:hover{box-shadow:0 4px 12px rgba(247,179,43,0.3)}
        .hero{min-height:60vh;display:flex;flex-direction:column;justify-content:center;align-items:center;text-align:center;padding:140px 24px 60px;background:radial-gradient(ellipse 70% 50% at 50% 0%,rgba(247,179,43,0.06),transparent)}
        .hero-badge{display:inline-flex;align-items:center;gap:8px;padding:6px 14px;background:var(--gold-glow);border:1px solid rgba(247,179,43,0.15);border-radius:100px;font-size:11px;font-weight:600;color:var(--gold);text-transform:uppercase;letter-spacing:1px;margin-bottom:24px}
        .hero-badge::before{content:'';width:6px;height:6px;background:var(--gold);border-radius:50%;animation:pulse 2s infinite}
        @keyframes pulse{0%,100%{opacity:1}50%{opacity:.4}}
        .hero h1{font-size:clamp(40px,8vw,72px);font-weight:900;letter-spacing:-2px;line-height:1;margin-bottom:20px}
        .hero h1 span{color:var(--gold)}
        .hero-sub{font-size:18px;color:var(--text-2);max-width:500px}
        .content{max-width:900px;margin:0 auto;padding:0 24px 60px}
        .phase{margin-bottom:60px}
        .phase-header{display:flex;align-items:center;gap:12px;margin-bottom:24px}
        .phase-dot{width:10px;height:10px;border-radius:50%}
        .phase-dot.live{background:var(--green);box-shadow:0 0 12px var(--green)}
        .phase-dot.building{background:var(--gold);box-shadow:0 0 12px var(--gold)}
        .phase-dot.planned{background:var(--text-3)}
        .phase-label{font-size:12px;font-weight:700;text-transform:uppercase;letter-spacing:1.5px;color:var(--text-3)}
        .phase-label.live{color:var(--green)}
        .phase-label.building{color:var(--gold)}
        .cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(260px,1fr));gap:16px}
        .card{background:var(--surface);border:1px solid var(--border);border-radius:16px;padding:24px;transition:all .25s}
        .card:hover{border-color:rgba(247,179,43,0.2);transform:translateY(-2px);box-shadow:0 16px 32px rgba(0,0,0,0.3)}
        .card-icon{width:40px;height:40px;border-radius:10px;display:flex;align-items:center;justify-content:center;margin-bottom:16px}
        .card-icon.green{background:var(--green-glow)}
        .card-icon.green svg{stroke:var(--green)}
        .card-icon.gold{background:var(--gold-glow)}
        .card-icon.gold svg{stroke:var(--gold)}
        .card-icon.gray{background:rgba(255,255,255,0.05)}
        .card-icon.gray svg{stroke:var(--text-3)}
        .card-icon svg{width:20px;height:20px}
        .card h3{font-size:16px;font-weight:700;margin-bottom:8px;letter-spacing:-0.3px}
        .card p{font-size:13px;color:var(--text-2);line-height:1.5}
        .card-checks{margin-top:16px;display:flex;flex-direction:column;gap:6px}
        .card-check{display:flex;align-items:center;gap:8px;font-size:12px;color:var(--text-2)}
        .card-check svg{width:14px;height:14px;stroke:var(--green);flex-shrink:0}
        .cta{text-align:center;padding:60px 24px;background:var(--surface);border-top:1px solid var(--border)}
        .cta h2{font-size:28px;font-weight:800;margin-bottom:12px;letter-spacing:-0.5px}
        .cta p{color:var(--text-2);margin-bottom:24px;font-size:15px}
        .cta-btn{display:inline-flex;align-items:center;gap:8px;padding:14px 28px;background:var(--gold);color:#000;font-weight:700;font-size:15px;border-radius:10px;text-decoration:none;transition:all .2s}
        .cta-btn:hover{transform:translateY(-2px);box-shadow:0 8px 24px rgba(247,179,43,0.3)}
        .cta-btn svg{width:18px;height:18px}
        .disclaimer{max-width:900px;margin:0 auto;padding:40px 24px;border-top:1px solid var(--border)}
        .disclaimer-box{padding:20px;background:rgba(239,68,68,0.05);border:1px solid rgba(239,68,68,0.15);border-radius:12px}
        .disclaimer-box p{font-size:11px;color:var(--text-3);text-align:center;line-height:1.7}
        .disclaimer-box strong{color:var(--red)}
        .disclaimer-links{display:flex;justify-content:center;gap:16px;margin-top:16px}
        .disclaimer-links a{font-size:11px;color:var(--gold);text-decoration:none}
        .disclaimer-links a:hover{text-decoration:underline}
        @media(max-width:768px){.nav-links{display:none}.cards{grid-template-columns:1fr}}
    </style>
</head>
<body>
    <nav class="nav">
        <a href="/" class="nav-logo"><img src="/website/logo-icon.jpg" alt="">LAUNCHR</a>
        <div class="nav-links">
            <a href="/">Home</a>
            <a href="/launchpad">Launchpad</a>
            <a href="/dashboard">Dashboard</a>
            <a href="/docs">Docs</a>
        </div>
        <a href="/launchpad" class="nav-btn">Launch</a>
    </nav>

    <section class="hero">
        <div class="hero-badge">Roadmap 2025</div>
        <h1>Building <span>LAUNCHR</span></h1>
        <p class="hero-sub">The infrastructure layer for pump.fun launches. Ship fast, iterate faster.</p>
    </section>

    <div class="content">
        <div class="phase">
            <div class="phase-header">
                <div class="phase-dot live"></div>
                <span class="phase-label live">Live &mdash; Shipped</span>
            </div>
            <div class="cards">
                <div class="card">
                    <div class="card-icon green"><svg viewBox="0 0 24 24" fill="none" stroke-width="2"><path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z"/></svg></div>
                    <h3>Pump.fun Launch</h3>
                    <p>One-click token deployment with automatic fee routing.</p>
                    <div class="card-checks">
                        <div class="card-check"><svg viewBox="0 0 24 24" fill="none" stroke-width="2"><path d="M20 6L9 17l-5-5"/></svg>Instant token creation</div>
                        <div class="card-check"><svg viewBox="0 0 24 24" fill="none" stroke-width="2"><path d="M20 6L9 17l-5-5"/></svg>1% distribution pool</div>
                        <div class="card-check"><svg viewBox="0 0 24 24" fill="none" stroke-width="2"><path d="M20 6L9 17l-5-5"/></svg>Graduation tracking</div>
                    </div>
                </div>
                <div class="card">
                    <div class="card-icon green"><svg viewBox="0 0 24 24" fill="none" stroke-width="2"><rect x="3" y="3" width="18" height="18" rx="2"/><path d="M3 9h18M9 21V9"/></svg></div>
                    <h3>Creator Dashboard</h3>
                    <p>Full control over your 99% fee allocation.</p>
                    <div class="card-checks">
                        <div class="card-check"><svg viewBox="0 0 24 24" fill="none" stroke-width="2"><path d="M20 6L9 17l-5-5"/></svg>Buyback, burn, LP, revenue</div>
                        <div class="card-check"><svg viewBox="0 0 24 24" fill="none" stroke-width="2"><path d="M20 6L9 17l-5-5"/></svg>Strategy presets</div>
                        <div class="card-check"><svg viewBox="0 0 24 24" fill="none" stroke-width="2"><path d="M20 6L9 17l-5-5"/></svg>Auto-claim engine</div>
                    </div>
                </div>
                <div class="card">
                    <div class="card-icon green"><svg viewBox="0 0 24 24" fill="none" stroke-width="2"><path d="M21 15a2 2 0 01-2 2H7l-4 4V5a2 2 0 012-2h14a2 2 0 012 2z"/></svg></div>
                    <h3>Telegram Bot</h3>
                    <p>Launch and manage from Telegram.</p>
                    <div class="card-checks">
                        <div class="card-check"><svg viewBox="0 0 24 24" fill="none" stroke-width="2"><path d="M20 6L9 17l-5-5"/></svg>/launch command</div>
                        <div class="card-check"><svg viewBox="0 0 24 24" fill="none" stroke-width="2"><path d="M20 6L9 17l-5-5"/></svg>Real-time alerts</div>
                    </div>
                </div>
            </div>
        </div>

        <div class="phase">
            <div class="phase-header">
                <div class="phase-dot building"></div>
                <span class="phase-label building">Building &mdash; In Progress</span>
            </div>
            <div class="cards">
                <div class="card">
                    <div class="card-icon gold"><svg viewBox="0 0 24 24" fill="none" stroke-width="2"><path d="M3 3v18h18"/><path d="M18 17V9M13 17V5M8 17v-3"/></svg></div>
                    <h3>Advanced Analytics</h3>
                    <p>Deep insights into performance, holders, and fee metrics.</p>
                </div>
                <div class="card">
                    <div class="card-icon gold"><svg viewBox="0 0 24 24" fill="none" stroke-width="2"><rect x="2" y="7" width="20" height="14" rx="2"/><path d="M16 21V5a2 2 0 00-2-2h-4a2 2 0 00-2 2v16"/></svg></div>
                    <h3>Multi-Token Manager</h3>
                    <p>Manage all launches from one dashboard.</p>
                </div>
            </div>
        </div>

        <div class="phase">
            <div class="phase-header">
                <div class="phase-dot planned"></div>
                <span class="phase-label">Planned &mdash; Future</span>
            </div>
            <div class="cards">
                <div class="card">
                    <div class="card-icon gray"><svg viewBox="0 0 24 24" fill="none" stroke-width="2"><circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2"/></svg></div>
                    <h3>Raydium Native</h3>
                    <p>Direct AMM pool creation for advanced strategies.</p>
                </div>
                <div class="card">
                    <div class="card-icon gray"><svg viewBox="0 0 24 24" fill="none" stroke-width="2"><path d="M12 2v4m0 12v4M4.93 4.93l2.83 2.83m8.48 8.48l2.83 2.83M2 12h4m12 0h4M4.93 19.07l2.83-2.83m8.48-8.48l2.83-2.83"/></svg></div>
                    <h3>Auto-Strategy</h3>
                    <p>Intelligent allocation based on market conditions.</p>
                </div>
            </div>
        </div>
    </div>

    <section class="cta">
        <h2>Start building today</h2>
        <p>Launch your token in under a minute.</p>
        <a href="/launchpad" class="cta-btn">Launch Token <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M5 12h14M12 5l7 7-7 7"/></svg></a>
    </section>

    <div class="disclaimer">
        <div class="disclaimer-box">
            <p><strong>DISCLAIMER:</strong> LAUNCHR is a meme coin with no intrinsic value or expectation of financial return. This is NOT financial advice. Cryptocurrency investments are extremely risky and may result in total loss of funds. DYOR. Only invest what you can afford to lose.</p>
            <div class="disclaimer-links">
                <a href="/terms">Terms & Conditions</a>
                <a href="/docs">Documentation</a>
                <a href="https://t.me/LAUNCHR_V2_BOT">Telegram</a>
            </div>
        </div>
    </div>
</body>
</html>`;
}

// Security constants
const MAX_BODY_SIZE = 10 * 1024; // 10KB max request body
const SESSION_TOKEN_BYTES = 32;
const WEB_SESSION_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours for web sessions

// Rate limiting configuration
const RATE_LIMIT = {
    general: { max: 100, windowMs: 60 * 1000 },     // 100 req/min general
    sensitive: { max: 10, windowMs: 60 * 1000 },    // 10 req/min for sensitive ops
};
const requestCounts = new Map(); // IP -> { count, resetTime }
const failedAttempts = new Map(); // IP -> { count, lockoutUntil }
const FAIL2BAN_THRESHOLD = 5;
const FAIL2BAN_LOCKOUT_MS = 15 * 60 * 1000; // 15 min lockout

let engine = null;
let connection = null;
let wallet = null;
let logs = [];
let autoClaimInterval = null;
let priceUpdateInterval = null; // Updates price every 10s for RSI
let sessionToken = null; // Auth token for this session
let sessionCreatedAt = null; // When session was created

// Auto-fund configuration
let autoFundConfig = {
    enabled: false,
    sourceWallet: null,
    encryptedSourceKey: null,
    minBalance: 0.05 * LAMPORTS_PER_SOL,  // 0.05 SOL minimum
    fundAmount: 0.1 * LAMPORTS_PER_SOL,    // 0.1 SOL per refill
    lastFunded: 0
};

// Rate limiting function
function checkRateLimit(ip, type = 'general') {
    const now = Date.now();
    const limit = RATE_LIMIT[type] || RATE_LIMIT.general;
    const key = `${ip}:${type}`;

    // Check fail2ban lockout first
    const failed = failedAttempts.get(ip);
    if (failed && failed.lockoutUntil > now) {
        return { allowed: false, reason: 'IP temporarily blocked' };
    }

    // Check rate limit
    let record = requestCounts.get(key);
    if (!record || now > record.resetTime) {
        record = { count: 0, resetTime: now + limit.windowMs };
        requestCounts.set(key, record);
    }

    record.count++;
    if (record.count > limit.max) {
        return { allowed: false, reason: 'Rate limit exceeded' };
    }

    return { allowed: true };
}

// Record failed auth attempt (fail2ban style)
function recordFailedAuth(ip) {
    const now = Date.now();
    let record = failedAttempts.get(ip) || { count: 0, lockoutUntil: 0 };

    // Reset if lockout expired
    if (record.lockoutUntil < now) {
        record.count = 0;
    }

    record.count++;
    if (record.count >= FAIL2BAN_THRESHOLD) {
        record.lockoutUntil = now + FAIL2BAN_LOCKOUT_MS;
        log(`SECURITY: IP ${ip.slice(0, 10)}... locked out for 15 minutes`);
    }

    failedAttempts.set(ip, record);
}

// Check if web session is still valid
function isSessionValid() {
    if (!sessionToken || !sessionCreatedAt) return false;
    if (Date.now() - sessionCreatedAt > WEB_SESSION_TTL_MS) {
        log('Session expired after 24 hours');
        sessionToken = null;
        sessionCreatedAt = null;
        engine = null;
        wallet = null;
        return false;
    }
    return true;
}

// Encrypt source key for auto-fund (using crypto)
function encryptKey(key) {
    const encKey = crypto.randomBytes(32);
    const iv = crypto.randomBytes(16);
    const cipher = crypto.createCipheriv('aes-256-gcm', encKey, iv);
    let encrypted = cipher.update(key, 'utf8', 'hex');
    encrypted += cipher.final('hex');
    return { encrypted, iv: iv.toString('hex'), authTag: cipher.getAuthTag().toString('hex'), encKey: encKey.toString('hex') };
}

function decryptKey(data) {
    const decipher = crypto.createDecipheriv('aes-256-gcm', Buffer.from(data.encKey, 'hex'), Buffer.from(data.iv, 'hex'));
    decipher.setAuthTag(Buffer.from(data.authTag, 'hex'));
    let decrypted = decipher.update(data.encrypted, 'hex', 'utf8');
    decrypted += decipher.final('utf8');
    return decrypted;
}

// HTML escape to prevent XSS
function escapeHtml(str) {
    return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#039;');
}

// Format timestamp to "X ago" format
function formatTimeAgo(timestamp) {
    if (!timestamp) return 'Unknown';
    const seconds = Math.floor((Date.now() - timestamp) / 1000);
    if (seconds < 60) return `${seconds}s ago`;
    const minutes = Math.floor(seconds / 60);
    if (minutes < 60) return `${minutes}m ago`;
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return `${hours}h ago`;
    const days = Math.floor(hours / 24);
    return `${days}d ago`;
}

// Safe body parser with size limit
function parseBody(req, maxSize = MAX_BODY_SIZE) {
    return new Promise((resolve, reject) => {
        let body = '';
        let size = 0;

        req.on('data', chunk => {
            size += chunk.length;
            if (size > maxSize) {
                req.destroy();
                reject(new Error('Request body too large'));
                return;
            }
            body += chunk;
        });

        req.on('end', () => {
            try {
                resolve(JSON.parse(body));
            } catch (e) {
                reject(new Error('Invalid JSON'));
            }
        });

        req.on('error', reject);
    });
}

// Validate Solana public key format
function isValidPublicKey(str) {
    try {
        new PublicKey(str);
        return true;
    } catch {
        return false;
    }
}

// Check auth token and session validity
function isAuthorized(req) {
    if (!isSessionValid()) return false;
    const authHeader = req.headers['authorization'];
    return authHeader === `Bearer ${sessionToken}`;
}

function log(msg) {
    const timestamp = new Date().toLocaleTimeString();
    // Sanitize log message to prevent log injection
    const sanitized = String(msg).replace(/[\r\n]/g, ' ');
    const entry = `[${timestamp}] ${sanitized}`;
    logs.push(entry);
    if (logs.length > 100) logs.shift();
    console.log(entry);
}

const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host}`);

    // Get origin for CORS - only allow same-origin or configured origins
    const origin = req.headers.origin;
    const allowedOrigins = process.env.ALLOWED_ORIGINS?.split(',') || [];

    // CORS headers - restrict to same origin by default
    if (origin && (allowedOrigins.includes(origin) || allowedOrigins.includes('*'))) {
        res.setHeader('Access-Control-Allow-Origin', origin);
    }
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    res.setHeader('Access-Control-Allow-Credentials', 'true');

    // ═══════════════════════════════════════════════════════════════════════════
    // SECURITY HEADERS - CIA-LEVEL PROTECTION
    // ═══════════════════════════════════════════════════════════════════════════
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('X-XSS-Protection', '1; mode=block');
    res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
    res.setHeader('Permissions-Policy', 'geolocation=(), microphone=(), camera=()');
    res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');

    if (req.method === 'OPTIONS') {
        res.writeHead(200);
        res.end();
        return;
    }

    // Serve Landing Page
    if (url.pathname === '/' && req.method === 'GET') {
        res.writeHead(200, {
            'Content-Type': 'text/html; charset=utf-8',
            'Cache-Control': 'no-cache, no-store, must-revalidate',
            'Pragma': 'no-cache',
            'Expires': '0'
        });
        res.end(getLandingHTML());
        return;
    }

    // Serve Terms & Conditions
    if (url.pathname === '/terms' && req.method === 'GET') {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(getTermsHTML());
        return;
    }

    // Serve Product Roadmap
    if (url.pathname === '/roadmap' && req.method === 'GET') {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(getRoadmapHTML());
        return;
    }

    // Serve favicon
    if (url.pathname === '/favicon.ico' && req.method === 'GET') {
        try {
            const favicon = fs.readFileSync(path.join(__dirname, 'website', 'logo-icon.jpg'));
            res.writeHead(200, {
                'Content-Type': 'image/jpeg',
                'Cache-Control': 'public, max-age=604800'
            });
            res.end(favicon);
        } catch (e) {
            res.writeHead(404);
            res.end();
        }
        return;
    }

    // Serve logo images explicitly
    if ((url.pathname === '/website/logo-icon.jpg' || url.pathname === '/website/logo-full.jpg' || url.pathname === '/website/phantom_icon.png') && req.method === 'GET') {
        try {
            const filename = url.pathname.replace('/website/', '');
            const img = fs.readFileSync(path.join(__dirname, 'website', filename));
            const ext = filename.endsWith('.png') ? 'image/png' : 'image/jpeg';
            res.writeHead(200, { 'Content-Type': ext, 'Cache-Control': 'public, max-age=86400' });
            res.end(img);
        } catch (e) {
            res.writeHead(404);
            res.end('Image not found');
        }
        return;
    }

    // Serve Launchpad (with config injection)
    if (url.pathname === '/launchpad' && req.method === 'GET') {
        try {
            const html = fs.readFileSync(path.join(__dirname, 'website', 'launchpad.html'), 'utf8');
            res.writeHead(200, {
                'Content-Type': 'text/html; charset=utf-8',
                'Cache-Control': 'no-cache, no-store, must-revalidate',
                'Pragma': 'no-cache',
                'Expires': '0'
            });
            res.end(injectConfig(html));
        } catch (e) {
            res.writeHead(302, { 'Location': '/' });
            res.end();
        }
        return;
    }

    // Serve Creator Dashboard (full HTML with config injection)
    if (url.pathname === '/dashboard' && req.method === 'GET') {
        try {
            const html = fs.readFileSync(path.join(__dirname, 'website', 'dashboard.html'), 'utf8');
            res.writeHead(200, {
                'Content-Type': 'text/html; charset=utf-8',
                'Cache-Control': 'no-cache, no-store, must-revalidate',
                'Pragma': 'no-cache',
                'Expires': '0'
            });
            res.end(injectConfig(html));
        } catch (e) {
            res.writeHead(302, { 'Location': '/' });
            res.end();
        }
        return;
    }

    // Serve Auth page (React Privy popup)
    if (url.pathname === '/auth' && req.method === 'GET') {
        try {
            const html = fs.readFileSync(path.join(__dirname, 'frontend', 'dist', 'index.html'), 'utf8');
            res.writeHead(200, {
                'Content-Type': 'text/html; charset=utf-8',
                'Cache-Control': 'no-cache, no-store, must-revalidate'
            });
            res.end(injectConfig(html));
        } catch (e) {
            res.writeHead(302, { 'Location': '/' });
            res.end();
        }
        return;
    }

    // Serve Documentation (with config injection)
    if (url.pathname === '/docs' && req.method === 'GET') {
        try {
            const html = fs.readFileSync(path.join(__dirname, 'website', 'docs.html'), 'utf8');
            res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
            res.end(injectConfig(html));
        } catch (e) {
            res.writeHead(302, { 'Location': '/' });
            res.end();
        }
        return;
    }

    // Serve Profile page (with config injection)
    if (url.pathname.startsWith('/profile/') && req.method === 'GET') {
        try {
            const html = fs.readFileSync(path.join(__dirname, 'website', 'profile.html'), 'utf8');
            res.writeHead(200, {
                'Content-Type': 'text/html; charset=utf-8',
                'Cache-Control': 'no-cache, no-store, must-revalidate'
            });
            res.end(injectConfig(html));
        } catch (e) {
            res.writeHead(302, { 'Location': '/' });
            res.end();
        }
        return;
    }

    // Phantom Wallet Integration - Manifest
    if ((url.pathname === '/phantom/manifest.json' || url.pathname === '/.well-known/phantom.json') && req.method === 'GET') {
        try {
            const manifest = fs.readFileSync(path.join(__dirname, 'website', 'phantom-manifest.json'), 'utf8');
            res.writeHead(200, {
                'Content-Type': 'application/json',
                'Access-Control-Allow-Origin': '*',
                'Cache-Control': 'public, max-age=3600'
            });
            res.end(manifest);
        } catch (e) {
            res.writeHead(404, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Manifest not found' }));
        }
        return;
    }

    // Serve static files from frontend/dist folder (Vite build output)
    if ((url.pathname.startsWith('/assets/') || url.pathname.startsWith('/website/')) && req.method === 'GET') {
        // Map /website/ to frontend/dist for backwards compatibility
        const basePath = url.pathname.startsWith('/website/')
            ? path.join(__dirname, 'frontend', 'dist', url.pathname.replace('/website/', ''))
            : path.join(__dirname, 'frontend', 'dist', url.pathname);
        const ext = path.extname(basePath).toLowerCase();
        const mimeTypes = {
            '.jpg': 'image/jpeg',
            '.jpeg': 'image/jpeg',
            '.png': 'image/png',
            '.svg': 'image/svg+xml',
            '.ico': 'image/x-icon',
            '.css': 'text/css',
            '.js': 'application/javascript'
        };
        const contentType = mimeTypes[ext] || 'application/octet-stream';

        try {
            const data = fs.readFileSync(basePath);
            res.writeHead(200, { 'Content-Type': contentType, 'Cache-Control': 'public, max-age=86400' });
            res.end(data);
            return;
        } catch (e) {
            res.writeHead(404);
            res.end('Not found');
            return;
        }
    }

    // Serve Dashboard App
    if (url.pathname === '/app' && req.method === 'GET') {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(getHTML());
        return;
    }

    // API: Configure
    if (url.pathname === '/api/configure' && req.method === 'POST') {
        try {
            const data = await parseBody(req);

            // Validate required fields
            if (!data.privateKey || typeof data.privateKey !== 'string') {
                throw new Error('Private key is required');
            }
            if (!data.tokenMint || typeof data.tokenMint !== 'string') {
                throw new Error('Token mint is required');
            }

            // Validate token mint format
            if (!isValidPublicKey(data.tokenMint)) {
                throw new Error('Invalid token mint address');
            }

            // Validate private key format (base58)
            let decodedKey;
            try {
                decodedKey = bs58.decode(data.privateKey);
                if (decodedKey.length !== 64) {
                    throw new Error('Invalid key length');
                }
            } catch {
                throw new Error('Invalid private key format');
            }

            // Use RPC URL with robust fallback (empty string check)
            const rpcUrl = process.env.RPC_URL && process.env.RPC_URL.startsWith('http')
                ? process.env.RPC_URL
                : 'https://api.mainnet-beta.solana.com';
            connection = new Connection(rpcUrl, 'confirmed');
            wallet = Keypair.fromSecretKey(decodedKey);
            engine = new LaunchrEngine(connection, data.tokenMint, wallet);

            // Generate session token for subsequent requests
            sessionToken = crypto.randomBytes(SESSION_TOKEN_BYTES).toString('hex');
            sessionCreatedAt = Date.now();

            // Track this token in the registry
            tracker.registerToken(data.tokenMint, wallet.publicKey.toBase58());

            log('Connected: ' + wallet.publicKey.toBase58().slice(0, 8) + '...');
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
                success: true,
                wallet: wallet.publicKey.toBase58(),
                token: sessionToken  // Client stores this for auth
            }));
        } catch (e) {
            log('Config error: ' + e.message);
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: false, error: e.message }));
        }
        return;
    }

    // API: Get Status
    if (url.pathname === '/api/status' && req.method === 'GET') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        if (!engine) {
            res.end(JSON.stringify({ configured: false }));
            return;
        }
        try {
            const balance = await connection.getBalance(wallet.publicKey);
            const status = engine.getStatus();
            res.end(JSON.stringify({
                configured: true,
                wallet: wallet.publicKey.toBase58(),
                balance: balance / LAMPORTS_PER_SOL,
                ...status,
                autoClaimActive: autoClaimInterval !== null,
            }));
        } catch (e) {
            res.end(JSON.stringify({ configured: true, error: e.message }));
        }
        return;
    }

    // API: Update Allocations (requires auth)
    if (url.pathname === '/api/allocations' && req.method === 'POST') {
        if (!isAuthorized(req)) {
            res.writeHead(401, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: false, error: 'Unauthorized' }));
            return;
        }
        if (!engine) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: false, error: 'Not configured' }));
            return;
        }
        try {
            const data = await parseBody(req);

            // Validate allocation values
            const validKeys = ['marketMaking', 'buybackBurn', 'liquidity', 'creatorRevenue'];
            for (const key of validKeys) {
                if (typeof data[key] !== 'number' || data[key] < 0 || data[key] > 100) {
                    throw new Error(`Invalid allocation for ${key}: must be 0-100`);
                }
            }

            // Validate total is exactly 100%
            const total = validKeys.reduce((sum, key) => sum + (data[key] || 0), 0);
            if (Math.abs(total - 100) > 0.01) {
                throw new Error(`Allocations must sum to 100% (currently ${total}%)`);
            }

            engine.setAllocations(data);
            log('Allocations updated: ' + JSON.stringify(data));
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: true, allocations: engine.getAllocations() }));
        } catch (e) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: false, error: e.message }));
        }
        return;
    }

    // API: Toggle Feature (requires auth)
    if (url.pathname === '/api/feature' && req.method === 'POST') {
        if (!isAuthorized(req)) {
            res.writeHead(401, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: false, error: 'Unauthorized' }));
            return;
        }
        if (!engine) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: false, error: 'Not configured' }));
            return;
        }
        try {
            const data = await parseBody(req);

            // Validate feature name
            const validFeatures = ['marketMaking', 'buybackBurn', 'liquidity', 'creatorRevenue'];
            if (!validFeatures.includes(data.feature)) {
                throw new Error('Invalid feature name');
            }
            if (typeof data.enabled !== 'boolean') {
                throw new Error('enabled must be a boolean');
            }

            engine.setFeatureEnabled(data.feature, data.enabled);
            log(`Feature ${data.feature}: ${data.enabled ? 'enabled' : 'disabled'}`);
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: true }));
        } catch (e) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: false, error: e.message }));
        }
        return;
    }

    // API: Claim and Distribute (requires auth)
    if (url.pathname === '/api/claim' && req.method === 'POST') {
        if (!isAuthorized(req)) {
            res.writeHead(401, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: false, error: 'Unauthorized' }));
            return;
        }
        if (!engine) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: false, error: 'Not configured' }));
            return;
        }
        try {
            log('Starting claim + distribute...');
            await engine.updatePrice();
            const result = await engine.claimAndDistribute();
            if (result.claimed > 0) {
                log('Claimed: ' + (result.claimed / LAMPORTS_PER_SOL).toFixed(4) + ' SOL');
                log('Distributed: ' + (result.distributed / LAMPORTS_PER_SOL).toFixed(4) + ' SOL');
            } else {
                log('No fees to claim');
            }
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(result));
        } catch (e) {
            log('Error: ' + e.message);
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: false, error: e.message }));
        }
        return;
    }

    // API: Distribute from wallet balance (requires auth)
    if (url.pathname === '/api/distribute' && req.method === 'POST') {
        if (!isAuthorized(req)) {
            res.writeHead(401, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: false, error: 'Unauthorized' }));
            return;
        }
        if (!engine) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: false, error: 'Not configured' }));
            return;
        }
        try {
            const data = await parseBody(req);
            const amount = data.amount ? parseFloat(data.amount) : 0;

            if (amount <= 0) {
                throw new Error('Invalid amount');
            }

            const lamports = Math.floor(amount * LAMPORTS_PER_SOL);
            log(`Distributing ${amount} SOL from wallet...`);

            const result = await engine.distributeFees(lamports);

            if (result.distributed > 0) {
                log('Distributed: ' + (result.distributed / LAMPORTS_PER_SOL).toFixed(4) + ' SOL');
            }

            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(result));
        } catch (e) {
            log('Distribute error: ' + e.message);
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: false, error: e.message }));
        }
        return;
    }

    // API: Start Auto (requires auth)
    if (url.pathname === '/api/auto/start' && req.method === 'POST') {
        if (!isAuthorized(req)) {
            res.writeHead(401, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: false, error: 'Unauthorized' }));
            return;
        }
        if (!engine) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: false, error: 'Not configured' }));
            return;
        }
        if (autoClaimInterval) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: false, error: 'Already running' }));
            return;
        }

        const intervalMs = 1 * 60 * 1000;
        log('Auto-claim started (every 1 min)');

        const runClaim = async () => {
            try {
                // Check balance and auto-fund if needed
                if (autoFundConfig.enabled && autoFundConfig.encryptedSourceKey) {
                    const balance = await connection.getBalance(wallet.publicKey);
                    if (balance < autoFundConfig.minBalance) {
                        try {
                            const sourceKey = decryptKey(autoFundConfig.encryptedSourceKey);
                            const sourceKeypair = Keypair.fromSecretKey(bs58.decode(sourceKey));
                            const { SystemProgram, Transaction } = require('@solana/web3.js');
                            const tx = new Transaction().add(
                                SystemProgram.transfer({
                                    fromPubkey: sourceKeypair.publicKey,
                                    toPubkey: wallet.publicKey,
                                    lamports: autoFundConfig.fundAmount,
                                })
                            );
                            const sig = await connection.sendTransaction(tx, [sourceKeypair]);
                            // Don't block - just wait briefly
                            await new Promise(r => setTimeout(r, 2000));
                            autoFundConfig.lastFunded = Date.now();
                            log('Auto-fund: Added ' + (autoFundConfig.fundAmount / LAMPORTS_PER_SOL).toFixed(4) + ' SOL');
                        } catch (fundErr) {
                            log('Auto-fund error: ' + fundErr.message);
                        }
                    }
                }

                await engine.updatePrice();
                const result = await engine.claimAndDistribute();
                if (result.claimed > 0) {
                    log('Auto: Claimed ' + (result.claimed / LAMPORTS_PER_SOL).toFixed(4) + ' SOL');
                }
            } catch (e) {
                log('Auto error: ' + e.message);
            }
        };

        runClaim();
        autoClaimInterval = setInterval(runClaim, intervalMs);

        // Start price updates every 10s to build RSI data
        if (!priceUpdateInterval) {
            priceUpdateInterval = setInterval(async () => {
                if (engine) {
                    await engine.updatePrice();
                }
            }, 10000);
        }

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true }));
        return;
    }

    // API: Stop Auto (requires auth)
    if (url.pathname === '/api/auto/stop' && req.method === 'POST') {
        if (!isAuthorized(req)) {
            res.writeHead(401, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: false, error: 'Unauthorized' }));
            return;
        }
        if (autoClaimInterval) {
            clearInterval(autoClaimInterval);
            autoClaimInterval = null;
        }
        if (priceUpdateInterval) {
            clearInterval(priceUpdateInterval);
            priceUpdateInterval = null;
        }
        log('Auto-claim stopped');
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true }));
        return;
    }

    // API: Configure Auto-Fund (requires auth)
    if (url.pathname === '/api/autofund/configure' && req.method === 'POST') {
        if (!isAuthorized(req)) {
            res.writeHead(401, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: false, error: 'Unauthorized' }));
            return;
        }
        try {
            const data = await parseBody(req);

            if (data.enabled === false) {
                // Disable auto-fund and wipe the source key
                autoFundConfig.enabled = false;
                autoFundConfig.encryptedSourceKey = null;
                autoFundConfig.sourceWallet = null;
                log('Auto-fund disabled');
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ success: true, enabled: false }));
                return;
            }

            // Enable auto-fund with source wallet
            if (!data.sourceKey || typeof data.sourceKey !== 'string') {
                throw new Error('Source wallet private key required');
            }

            // Validate source key format
            let sourceKeypair;
            try {
                sourceKeypair = Keypair.fromSecretKey(bs58.decode(data.sourceKey));
            } catch {
                throw new Error('Invalid source wallet private key format');
            }

            // Encrypt and store source key
            autoFundConfig.enabled = true;
            autoFundConfig.encryptedSourceKey = encryptKey(data.sourceKey);
            autoFundConfig.sourceWallet = sourceKeypair.publicKey.toBase58();

            // Optional: set min balance and fund amount
            if (data.minBalance !== undefined) {
                autoFundConfig.minBalance = Math.floor(data.minBalance * LAMPORTS_PER_SOL);
            }
            if (data.fundAmount !== undefined) {
                autoFundConfig.fundAmount = Math.floor(data.fundAmount * LAMPORTS_PER_SOL);
            }

            log('Auto-fund enabled from wallet ' + autoFundConfig.sourceWallet.slice(0, 8) + '...');
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
                success: true,
                enabled: true,
                sourceWallet: autoFundConfig.sourceWallet,
                minBalance: autoFundConfig.minBalance / LAMPORTS_PER_SOL,
                fundAmount: autoFundConfig.fundAmount / LAMPORTS_PER_SOL
            }));
        } catch (e) {
            log('Auto-fund config error: ' + e.message);
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: false, error: e.message }));
        }
        return;
    }

    // API: Manual Fund Wallet (requires wallet to be configured)
    if (url.pathname === '/api/fund' && req.method === 'POST') {
        // Security comes from requiring source private key, not session token
        if (!wallet) {
            res.writeHead(401, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: false, error: 'Connect wallet first' }));
            return;
        }
        try {
            const data = await parseBody(req);

            if (!data.sourceKey || typeof data.sourceKey !== 'string') {
                throw new Error('Source wallet private key required');
            }
            if (!data.amount || data.amount <= 0) {
                throw new Error('Invalid amount');
            }

            // Validate and decode source key
            let sourceKeypair;
            try {
                sourceKeypair = Keypair.fromSecretKey(bs58.decode(data.sourceKey));
            } catch {
                throw new Error('Invalid source wallet key');
            }

            // Send the transaction
            const { SystemProgram, Transaction } = require('@solana/web3.js');
            const lamports = Math.floor(data.amount * LAMPORTS_PER_SOL);

            const tx = new Transaction().add(
                SystemProgram.transfer({
                    fromPubkey: sourceKeypair.publicKey,
                    toPubkey: wallet.publicKey,
                    lamports: lamports,
                })
            );

            const sig = await connection.sendTransaction(tx, [sourceKeypair]);

            // Don't block on confirmation - just wait briefly for tx to propagate
            await new Promise(r => setTimeout(r, 2000));

            log('Manual fund: Added ' + data.amount.toFixed(4) + ' SOL from ' + sourceKeypair.publicKey.toBase58().slice(0, 8) + '...');

            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: true, signature: sig }));
        } catch (e) {
            log('Manual fund error: ' + e.message);
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: false, error: e.message }));
        }
        return;
    }

    // API: Get Logs (escape HTML to prevent XSS)
    if (url.pathname === '/api/logs' && req.method === 'GET') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        // Escape logs to prevent XSS when rendered as HTML
        const escapedLogs = logs.map(l => escapeHtml(l));
        res.end(JSON.stringify({ logs: escapedLogs }));
        return;
    }

    // API: Smart Optimizer - Optimize allocations using AI
    if (url.pathname === '/api/ai/optimize' && req.method === 'POST') {
        if (!isAuthorized(req)) {
            res.writeHead(401, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: false, error: 'Unauthorized' }));
            return;
        }

        try {
            const data = await parseBody(req);
            const { rsi, balance, currentAllocations, tokenPrice, marketCap } = data;

            // Use server-side API key from environment
            const apiKey = process.env.CLAUDE_API_KEY;
            if (!apiKey) {
                throw new Error('AI service not configured');
            }

            // Call Claude API for optimization
            const prompt = `You are the LAUNCHR Smart Optimizer, an AI that optimizes token fee allocations.

Current market data:
- RSI: ${rsi || 'unknown'}
- Token Price: ${tokenPrice || 'unknown'}
- Market Cap: ${marketCap || 'unknown'}
- Available Balance: ${balance || 0} SOL
- Current Allocations: Market Making ${currentAllocations?.marketMaking || 25}%, Buyback & Burn ${currentAllocations?.buybackBurn || 25}%, Liquidity ${currentAllocations?.liquidity || 25}%, Creator Revenue ${currentAllocations?.creatorRevenue || 25}%

Based on this data, provide optimal allocation percentages for the 4 channels. Consider:
- Low RSI (<30) = oversold, good for buybacks
- High RSI (>70) = overbought, reduce buying
- Low liquidity = prioritize LP additions
- Sustainable revenue for long-term development

Respond ONLY with valid JSON in this exact format:
{"marketMaking": XX, "buybackBurn": XX, "liquidity": XX, "creatorRevenue": XX, "reasoning": "brief explanation"}

The 4 percentages must sum to 100.`;

            const response = await fetch('https://api.anthropic.com/v1/messages', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'x-api-key': apiKey,
                    'anthropic-version': '2023-06-01'
                },
                body: JSON.stringify({
                    model: 'claude-3-haiku-20240307',
                    max_tokens: 256,
                    messages: [{ role: 'user', content: prompt }]
                })
            });

            if (!response.ok) {
                throw new Error('Claude API error: ' + response.status);
            }

            const result = await response.json();
            const content = result.content[0].text;

            // Parse the JSON response
            const optimized = JSON.parse(content);

            // Validate
            const total = optimized.marketMaking + optimized.buybackBurn + optimized.liquidity + optimized.creatorRevenue;
            if (Math.abs(total - 100) > 1) {
                throw new Error('AI returned invalid allocations (not 100%)');
            }

            log(`Optimizer: MM=${optimized.marketMaking}%, BB=${optimized.buybackBurn}%, LP=${optimized.liquidity}%, CR=${optimized.creatorRevenue}%`);

            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: true, allocations: optimized }));
            return;
        } catch (error) {
            log('Optimizer error: ' + error.message);
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: false, error: error.message }));
            return;
        }
    }

    // API: Public tracker stats
    if (url.pathname === '/api/tracker/stats' && req.method === 'GET') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(tracker.getPublicStats()));
        return;
    }

    // Tracker page
    if (url.pathname === '/tracker' && req.method === 'GET') {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(getTrackerHTML());
        return;
    }

    // API: Get launchpad tokens (live list)
    if (url.pathname === '/api/tokens' && req.method === 'GET') {
        try {
            const data = tracker.getTokens();
            const tokens = (data.tokens || [])
                .sort((a, b) => b.lastSeen - a.lastSeen)
                .slice(0, 50)
                .map(t => ({
                    mint: t.mint,
                    name: t.name || 'Unknown Token',
                    symbol: t.symbol || 'TOKEN',
                    image: t.image || null,
                    path: t.path || 'pump',
                    mcap: t.mcap || 0,
                    volume: t.volume || 0,
                    price: t.price || 0,
                    change: t.change || 0,
                    progress: t.progress || 0,
                    graduated: t.graduated || false,
                    graduatedAt: t.graduatedAt || null,
                    time: formatTimeAgo(t.lastSeen || t.registeredAt),
                    createdAt: t.registeredAt,
                    lastMetricsUpdate: t.lastMetricsUpdate || null,
                }));
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ tokens }));
        } catch (e) {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ tokens: [] }));
        }
        return;
    }

    // API: Proxy for Pump.fun individual token with caching (ALICE pattern)
    if (url.pathname.startsWith('/api/pump/coin/') && req.method === 'GET') {
        const mint = url.pathname.replace('/api/pump/coin/', '');
        if (!mint || mint.length < 30) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Invalid mint address' }));
            return;
        }

        const CACHE_TTL = 30000;
        const cacheKey = `pump_token_${mint}`;

        if (!global.pumpCache) global.pumpCache = new Map();

        // Check cache
        const cached = global.pumpCache.get(cacheKey);
        if (cached && Date.now() - cached.ts < CACHE_TTL) {
            res.writeHead(200, { 'Content-Type': 'application/json', 'X-Cache': 'HIT' });
            res.end(JSON.stringify(cached.data));
            return;
        }

        try {
            const pumpUrl = `https://frontend-api.pump.fun/coins/${mint}`;
            const controller = new AbortController();
            const timeout = setTimeout(() => controller.abort(), 5000);

            const pumpRes = await fetch(pumpUrl, {
                headers: { 'Accept': 'application/json', 'User-Agent': 'Mozilla/5.0' },
                signal: controller.signal
            });
            clearTimeout(timeout);

            const data = pumpRes.ok ? await pumpRes.json() : null;

            if (data) {
                global.pumpCache.set(cacheKey, { data, ts: Date.now() });
            }

            res.writeHead(200, { 'Content-Type': 'application/json', 'X-Cache': 'MISS' });
            res.end(JSON.stringify(data));
        } catch (e) {
            console.error('[PUMP] Token proxy error:', e.message);
            res.writeHead(200, { 'Content-Type': 'application/json', 'X-Cache': 'ERROR' });
            res.end(JSON.stringify(cached?.data || null));
        }
        return;
    }

    // API: Proxy for Pump.fun API with caching + rate limiting (ALICE pattern)
    if (url.pathname === '/api/pump/coins' && req.method === 'GET') {
        const CACHE_TTL = 30000; // 30 seconds cache
        const MIN_INTERVAL = 500; // 500ms between requests (2 RPS max)

        const sort = url.searchParams.get('sort') || 'created_timestamp';
        const order = url.searchParams.get('order') || 'DESC';
        const limit = url.searchParams.get('limit') || '20';
        const offset = url.searchParams.get('offset') || '0';
        const cacheKey = `pump_${sort}_${order}_${limit}_${offset}`;

        // Initialize cache
        if (!global.pumpCache) global.pumpCache = new Map();
        if (!global.lastPumpReq) global.lastPumpReq = 0;

        // Check cache first
        const cached = global.pumpCache.get(cacheKey);
        if (cached && Date.now() - cached.ts < CACHE_TTL) {
            res.writeHead(200, { 'Content-Type': 'application/json', 'X-Cache': 'HIT' });
            res.end(JSON.stringify(cached.data));
            return;
        }

        // Rate limit - return stale cache or empty if too fast
        const now = Date.now();
        if (now - global.lastPumpReq < MIN_INTERVAL) {
            res.writeHead(200, { 'Content-Type': 'application/json', 'X-Cache': 'RATE' });
            res.end(JSON.stringify(cached?.data || []));
            return;
        }
        global.lastPumpReq = now;

        // Fetch with timeout + graceful failure (ALICE pattern)
        try {
            const pumpUrl = `https://frontend-api.pump.fun/coins?offset=${offset}&limit=${limit}&sort=${sort}&order=${order}&includeNsfw=false`;
            const controller = new AbortController();
            const timeout = setTimeout(() => controller.abort(), 5000);

            const pumpRes = await fetch(pumpUrl, {
                headers: { 'Accept': 'application/json', 'User-Agent': 'Mozilla/5.0' },
                signal: controller.signal
            });
            clearTimeout(timeout);

            // Graceful: return empty array on bad response, don't throw
            const data = pumpRes.ok ? await pumpRes.json() : [];

            // Cache result
            global.pumpCache.set(cacheKey, { data, ts: Date.now() });

            res.writeHead(200, { 'Content-Type': 'application/json', 'X-Cache': 'MISS' });
            res.end(JSON.stringify(data));
        } catch (e) {
            // Graceful failure - return cached or empty, never error
            console.error('[PUMP] Proxy error:', e.message);
            res.writeHead(200, { 'Content-Type': 'application/json', 'X-Cache': 'ERROR' });
            res.end(JSON.stringify(cached?.data || []));
        }
        return;
    }

    // API: Register a new token (called after successful launch)
    if (url.pathname === '/api/register-token' && req.method === 'POST') {
        try {
            const data = await parseBody(req);
            if (!data.mint || !data.creator) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'mint and creator required' }));
                return;
            }

            const result = tracker.registerToken(data.mint, data.creator, {
                name: data.name || 'Unknown Token',
                symbol: data.symbol || 'TOKEN',
                image: data.image || null,
                path: data.path || 'pump',
                description: data.description || '',
                socials: data.socials || {}
            });

            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: true, ...result }));
        } catch (e) {
            console.error('[API] register-token error:', e);
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: false, error: e.message }));
        }
        return;
    }

    // API: Get tokens by creator wallet (My Launches)
    if (url.pathname === '/api/my-tokens' && req.method === 'GET') {
        try {
            const wallet = url.searchParams.get('wallet');
            if (!wallet) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'Wallet address required' }));
                return;
            }

            const tokens = tracker.getTokensByCreator(wallet)
                .sort((a, b) => b.registeredAt - a.registeredAt)
                .map(t => ({
                    mint: t.mint,
                    name: t.name || 'Unknown Token',
                    symbol: t.symbol || 'TOKEN',
                    image: t.image || null,
                    path: t.path || 'pump',
                    mcap: t.mcap || 0,
                    volume: t.volume || 0,
                    price: t.price || 0,
                    change: t.change || 0,
                    holders: t.holders || 0,
                    progress: t.progress || 0,
                    graduated: t.graduated || false,
                    graduatedAt: t.graduatedAt || null,
                    createdAt: t.registeredAt,
                    time: formatTimeAgo(t.registeredAt),
                    stats: t.stats || { totalClaimed: 0, totalDistributed: 0 },
                    lastMetricsUpdate: t.lastMetricsUpdate || null,
                }));

            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ tokens }));
        } catch (e) {
            console.error('[API] my-tokens error:', e);
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ tokens: [] }));
        }
        return;
    }

    // API: Get leaderboard (top tokens by mcap)
    if (url.pathname === '/api/leaderboard' && req.method === 'GET') {
        try {
            const data = tracker.getTokens();
            const leaderboard = (data.tokens || [])
                .filter(t => t.mcap > 0)
                .sort((a, b) => (b.mcap || 0) - (a.mcap || 0))
                .slice(0, 10)
                .map((t, index) => ({
                    rank: index + 1,
                    mint: t.mint,
                    name: t.name || 'Unknown Token',
                    symbol: t.symbol || 'TOKEN',
                    image: t.image || null,
                    mcap: t.mcap || 0,
                    volume: t.volume || 0,
                    progress: t.progress || 0,
                    graduated: t.graduated || false,
                    path: t.path === 'launchr' ? 'Launchr' : 'Pump.fun',
                    reward: index < 3 ? 'Winner' : null,
                }));
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ leaderboard }));
        } catch (e) {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ leaderboard: [] }));
        }
        return;
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // PROFILE API ENDPOINTS
    // ═══════════════════════════════════════════════════════════════════════════

    // API: Check username availability (must be before general profile GET)
    if (url.pathname === '/api/profile/check-username' && req.method === 'GET') {
        try {
            const username = url.searchParams.get('username');
            const wallet = url.searchParams.get('wallet');

            if (!username) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'Username required' }));
                return;
            }

            const available = profiles.isUsernameAvailable(username, wallet);
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ available }));
        } catch (e) {
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Internal server error' }));
        }
        return;
    }

    // API: Get followers list (must be before general profile GET)
    if (url.pathname.match(/^\/api\/profile\/[^/]+\/followers$/) && req.method === 'GET') {
        try {
            const wallet = url.pathname.split('/')[3];
            const limit = parseInt(url.searchParams.get('limit') || '50');
            const offset = parseInt(url.searchParams.get('offset') || '0');

            const followers = profiles.getFollowers(wallet, limit, offset);
            const total = profiles.getFollowerCount(wallet);

            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ followers, total }));
        } catch (e) {
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Internal server error' }));
        }
        return;
    }

    // API: Get following list (must be before general profile GET)
    if (url.pathname.match(/^\/api\/profile\/[^/]+\/following$/) && req.method === 'GET') {
        try {
            const wallet = url.pathname.split('/')[3];
            const limit = parseInt(url.searchParams.get('limit') || '50');
            const offset = parseInt(url.searchParams.get('offset') || '0');

            const following = profiles.getFollowing(wallet, limit, offset);
            const total = profiles.getFollowingCount(wallet);

            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ following, total }));
        } catch (e) {
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Internal server error' }));
        }
        return;
    }

    // API: Get user profile by wallet or username
    if (url.pathname.startsWith('/api/profile/') && req.method === 'GET') {
        try {
            const identifier = url.pathname.split('/api/profile/')[1];
            if (!identifier) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'Wallet or username required' }));
                return;
            }

            let profile;
            // Check if it's a wallet address (base58, typically 32-44 chars)
            if (identifier.length >= 32 && identifier.length <= 44) {
                profile = profiles.getProfile(identifier);
            } else {
                // Try to find by username
                profile = profiles.getProfileByUsername(identifier);
            }

            if (!profile) {
                res.writeHead(404, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'Profile not found' }));
                return;
            }

            // Get user's created tokens
            const createdTokens = tracker.getTokensByCreator(profile.wallet);

            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
                profile,
                createdCoins: createdTokens.length,
                tokens: createdTokens.map(t => ({
                    mint: t.mint,
                    name: t.name || 'Unknown',
                    symbol: t.symbol || 'TOKEN',
                    image: t.image || null,
                    mcap: t.mcap || 0,
                    createdAt: t.registeredAt,
                    graduated: t.graduated || false
                }))
            }));
        } catch (e) {
            console.error('[API] profile error:', e);
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Internal server error' }));
        }
        return;
    }

    // API: Update user profile
    if (url.pathname === '/api/profile' && req.method === 'POST') {
        let body = '';
        req.on('data', chunk => body += chunk);
        req.on('end', () => {
            try {
                const data = JSON.parse(body);
                const { wallet, username, displayName, avatar, bio, twitter, telegram, website } = data;

                if (!wallet) {
                    res.writeHead(400, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ error: 'Wallet address required' }));
                    return;
                }

                // Check if username is taken
                if (username && !profiles.isUsernameAvailable(username, wallet)) {
                    res.writeHead(400, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ error: 'Username already taken' }));
                    return;
                }

                const updatedProfile = profiles.updateProfile(wallet, {
                    username,
                    displayName,
                    avatar,
                    bio,
                    twitter,
                    telegram,
                    website
                });

                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ profile: updatedProfile }));
            } catch (e) {
                console.error('[API] update profile error:', e);
                res.writeHead(500, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'Internal server error' }));
            }
        });
        return;
    }

    // API: Follow a user
    if (url.pathname === '/api/follow' && req.method === 'POST') {
        let body = '';
        req.on('data', chunk => body += chunk);
        req.on('end', () => {
            try {
                const data = JSON.parse(body);
                const { follower, following } = data;

                if (!follower || !following) {
                    res.writeHead(400, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ error: 'Follower and following wallets required' }));
                    return;
                }

                const result = profiles.followUser(follower, following);
                res.writeHead(result.success ? 200 : 400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify(result));
            } catch (e) {
                console.error('[API] follow error:', e);
                res.writeHead(500, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'Internal server error' }));
            }
        });
        return;
    }

    // API: Unfollow a user
    if (url.pathname === '/api/unfollow' && req.method === 'POST') {
        let body = '';
        req.on('data', chunk => body += chunk);
        req.on('end', () => {
            try {
                const data = JSON.parse(body);
                const { follower, following } = data;

                if (!follower || !following) {
                    res.writeHead(400, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ error: 'Follower and following wallets required' }));
                    return;
                }

                const result = profiles.unfollowUser(follower, following);
                res.writeHead(result.success ? 200 : 400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify(result));
            } catch (e) {
                console.error('[API] unfollow error:', e);
                res.writeHead(500, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'Internal server error' }));
            }
        });
        return;
    }

    // API: Check if following
    if (url.pathname === '/api/is-following' && req.method === 'GET') {
        try {
            const follower = url.searchParams.get('follower');
            const following = url.searchParams.get('following');

            if (!follower || !following) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'Follower and following wallets required' }));
                return;
            }

            const isFollowing = profiles.isFollowing(follower, following);
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ isFollowing }));
        } catch (e) {
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Internal server error' }));
        }
        return;
    }

    // API: Get platform stats
    if (url.pathname === '/api/stats' && req.method === 'GET') {
        try {
            const data = tracker.getTokens();
            const tokens = data.tokens || [];
            const stats = {
                totalLaunches: tokens.length,
                vanityTokens: tokens.length, // Tokens with vanity addresses
                totalVolume: tokens.reduce((sum, t) => sum + (t.volume || 0), 0),
                holderRewards: (data.stats?.totalDistributed || 0) * 0.01, // 1% to holders
                graduated: tokens.filter(t => t.graduated).length,
            };
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(stats));
        } catch (e) {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ totalLaunches: 0, vanityTokens: 0, totalVolume: 0, holderRewards: 0, graduated: 0 }));
        }
        return;
    }

    // API: Get timer (legacy endpoint)
    if (url.pathname === '/api/timer' && req.method === 'GET') {
        // Timer endpoint - returns countdown data
        const now = Date.now();
        const twoHours = 2 * 60 * 60 * 1000;
        const nextReward = Math.ceil(now / twoHours) * twoHours;
        const secondsRemaining = Math.floor((nextReward - now) / 1000);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ secondsRemaining, nextRewardTime: nextReward }));
        return;
    }

    // API: Get vanity keypair (mint address ending in "launchr") - RATE LIMITED
    if (url.pathname === '/api/vanity-keypair' && req.method === 'GET') {
        // Rate limit by IP
        const clientIP = req.headers['x-forwarded-for']?.split(',')[0] || req.socket.remoteAddress || 'unknown';
        const lastRequest = vanityRateLimits[clientIP] || 0;
        const now = Date.now();

        if (now - lastRequest < VANITY_RATE_LIMIT_MS) {
            const waitSeconds = Math.ceil((VANITY_RATE_LIMIT_MS - (now - lastRequest)) / 1000);
            res.writeHead(429, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
                success: false,
                error: `Rate limited. Please wait ${waitSeconds} seconds.`,
                retryAfter: waitSeconds
            }));
            return;
        }

        vanityRateLimits[clientIP] = now;

        // Clean old rate limit entries every 100 requests
        if (Object.keys(vanityRateLimits).length > 1000) {
            const cutoff = now - VANITY_RATE_LIMIT_MS * 2;
            for (const ip in vanityRateLimits) {
                if (vanityRateLimits[ip] < cutoff) delete vanityRateLimits[ip];
            }
        }
        const keypair = getVanityKeypair();
        res.writeHead(200, { 'Content-Type': 'application/json' });

        if (keypair) {
            // VAULT: Store secretKey server-side, return only vaultId to client
            const vaultId = generateVaultId();
            const now = Date.now();
            vanityVault.set(vaultId, {
                secretKey: keypair.secretKey,
                publicKey: keypair.publicKey,
                dispensedAt: now,
                expiresAt: now + VAULT_EXPIRY_MS,
                used: false
            });

            console.log(`[VAULT] Stored keypair ${keypair.publicKey} with vaultId (${vanityVault.size} active, ${vanityPool.length} in pool)`);

            res.end(JSON.stringify({
                success: true,
                publicKey: keypair.publicKey,
                vaultId: vaultId,  // Client uses this to request server-side signing
                expiresIn: VAULT_EXPIRY_MS / 1000, // Seconds until vault entry expires
                poolRemaining: vanityPool.length,
                generatorStats: {
                    totalAttempts: vanityGeneratorStats.attempts,
                    totalFound: vanityGeneratorStats.found
                }
            }));
        } else {
            // Pool empty - tell client to generate locally or wait
            console.log('[VANITY] Pool empty - client should generate locally');
            res.end(JSON.stringify({
                success: false,
                error: 'No vanity keypairs available',
                poolRemaining: 0,
                generating: vanityGenerating,
                generatorStats: {
                    totalAttempts: vanityGeneratorStats.attempts,
                    totalFound: vanityGeneratorStats.found
                }
            }));

            // Trigger generator if not running
            if (!vanityGenerating) {
                setImmediate(() => runVanityGenerator());
            }
        }
        return;
    }

    // API: Vanity pool status (for monitoring)
    if (url.pathname === '/api/vanity-status' && req.method === 'GET') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
            poolSize: vanityPool.length,
            targetSize: VANITY_POOL_TARGET,
            minSize: VANITY_POOL_MIN,
            isGenerating: vanityGenerating,
            stats: vanityGeneratorStats,
            suffix: VANITY_SUFFIX,
            vaultActive: vanityVault.size
        }));
        return;
    }

    // API: VAULT - Sign transaction with mint keypair (secretKey never exposed)
    if (url.pathname === '/api/vault/sign' && req.method === 'POST') {
        let body = [];
        req.on('data', chunk => body.push(chunk));
        req.on('end', async () => {
            try {
                const data = JSON.parse(Buffer.concat(body).toString());
                const { vaultId, transaction } = data;

                if (!vaultId || !transaction) {
                    res.writeHead(400, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ success: false, error: 'Missing vaultId or transaction' }));
                    return;
                }

                // Look up vault entry
                const vaultEntry = vanityVault.get(vaultId);
                if (!vaultEntry) {
                    res.writeHead(404, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ success: false, error: 'Vault entry not found or expired' }));
                    return;
                }

                // Check if already used (one-time use)
                if (vaultEntry.used) {
                    res.writeHead(403, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ success: false, error: 'Vault entry already used' }));
                    return;
                }

                // Check expiry
                if (Date.now() > vaultEntry.expiresAt) {
                    vanityVault.delete(vaultId);
                    res.writeHead(410, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ success: false, error: 'Vault entry expired' }));
                    return;
                }

                // Decode transaction and sign with mint keypair
                const { VersionedTransaction } = require('@solana/web3.js');
                const txBuffer = Buffer.from(transaction, 'base64');
                const tx = VersionedTransaction.deserialize(txBuffer);

                // Recreate keypair from stored secretKey
                const secretKeyBytes = bs58.decode(vaultEntry.secretKey);
                const mintKeypair = Keypair.fromSecretKey(secretKeyBytes);

                // Sign transaction with mint keypair
                tx.sign([mintKeypair]);

                // Mark vault entry as used
                vaultEntry.used = true;
                vaultEntry.usedAt = Date.now();

                // Serialize signed transaction
                const signedTxBuffer = Buffer.from(tx.serialize());
                const signedTxBase64 = signedTxBuffer.toString('base64');

                console.log(`[VAULT] Signed transaction for mint ${vaultEntry.publicKey}`);

                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({
                    success: true,
                    signedTransaction: signedTxBase64,
                    publicKey: vaultEntry.publicKey
                }));

                // Clean up used entry after short delay (allow retries on network failure)
                setTimeout(() => {
                    if (vanityVault.has(vaultId) && vanityVault.get(vaultId).used) {
                        vanityVault.delete(vaultId);
                        console.log(`[VAULT] Cleaned up used entry for ${vaultEntry.publicKey}`);
                    }
                }, 60000); // Keep for 1 minute after use for retries

            } catch (e) {
                console.error('[VAULT] Sign error:', e);
                res.writeHead(500, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ success: false, error: 'Failed to sign transaction: ' + e.message }));
            }
        });
        return;
    }

    // API: IPFS Proxy for Pump.fun (to avoid CORS)
    if (url.pathname === '/api/ipfs-upload' && req.method === 'POST') {
        let body = [];
        req.on('data', chunk => body.push(chunk));
        req.on('end', async () => {
            try {
                const rawBody = Buffer.concat(body);

                // Forward the request to pump.fun
                const response = await fetch('https://pump.fun/api/ipfs', {
                    method: 'POST',
                    headers: {
                        'Content-Type': req.headers['content-type'],
                        'Content-Length': rawBody.length
                    },
                    body: rawBody
                });

                const data = await response.json();
                console.log('[IPFS PROXY] Upload successful:', JSON.stringify(data, null, 2));

                // Extract image URL from metadata if available
                let imageUrl = null;
                if (data.metadata?.image) {
                    imageUrl = data.metadata.image;
                } else if (data.metadataUri) {
                    // Construct image URL from metadata URI (pump.fun pattern)
                    // Metadata: https://cf-ipfs.com/ipfs/XXX -> Image is usually in the metadata
                    try {
                        const metaRes = await fetch(data.metadataUri);
                        if (metaRes.ok) {
                            const metadata = await metaRes.json();
                            imageUrl = metadata.image || null;
                            console.log('[IPFS PROXY] Fetched image URL:', imageUrl);
                        }
                    } catch (e) {
                        console.log('[IPFS PROXY] Could not fetch metadata for image:', e.message);
                    }
                }

                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ ...data, imageUrl }));
            } catch (e) {
                console.error('[IPFS PROXY] Error:', e.message);
                res.writeHead(500, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: e.message }));
            }
        });
        return;
    }

    res.writeHead(404);
    res.end('Not found');
});

function getTrackerHTML() {
    return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>LAUNCHR - Token Tracker</title>
    <link rel="icon" href="/website/logo-icon.jpg" type="image/jpeg">
    <link href="https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600;700;800;900&family=JetBrains+Mono:wght@400;500;600&display=swap" rel="stylesheet">
    <style>
        * { box-sizing: border-box; margin: 0; padding: 0; }
        :root {
            --bg: #000000;
            --card: rgba(255,255,255,0.03);
            --border: rgba(255,255,255,0.08);
            --text: #ffffff;
            --text-dim: rgba(255,255,255,0.5);
            --accent: #a855f7;
        }
        body {
            font-family: 'Inter', -apple-system, sans-serif;
            background: var(--bg);
            color: var(--text);
            min-height: 100vh;
        }
        .bg-glow {
            position: fixed;
            inset: 0;
            background: radial-gradient(ellipse at 50% 0%, rgba(168,85,247,0.1) 0%, transparent 50%);
            pointer-events: none;
        }
        nav {
            position: fixed;
            top: 0; left: 0; right: 0;
            z-index: 100;
            padding: 16px 32px;
            display: flex;
            justify-content: space-between;
            align-items: center;
            background: rgba(0,0,0,0.85);
            backdrop-filter: blur(20px);
            border-bottom: 1px solid var(--border);
        }
        .nav-brand {
            display: flex;
            align-items: center;
            gap: 12px;
            text-decoration: none;
            color: var(--text);
        }
        .nav-brand img { height: 28px; border-radius: 6px; }
        .nav-brand span { font-weight: 700; font-size: 16px; letter-spacing: 2px; }
        .nav-links { display: flex; align-items: center; gap: 24px; }
        .nav-links a { color: var(--text-dim); text-decoration: none; font-size: 13px; font-weight: 500; }
        .nav-links a:hover { color: var(--text); }
        .btn { padding: 10px 20px; border-radius: 8px; font-size: 13px; font-weight: 600; text-decoration: none; background: var(--text); color: var(--bg); }

        .container {
            max-width: 900px;
            margin: 0 auto;
            padding: 120px 24px 60px;
            position: relative;
            z-index: 1;
        }
        .header {
            text-align: center;
            margin-bottom: 60px;
        }
        .header h1 {
            font-size: 42px;
            font-weight: 800;
            margin-bottom: 12px;
            letter-spacing: -1px;
        }
        .header p {
            color: var(--text-dim);
            font-size: 16px;
        }

        .stats-grid {
            display: grid;
            grid-template-columns: repeat(3, 1fr);
            gap: 20px;
            margin-bottom: 48px;
        }
        .stat-card {
            background: var(--card);
            border: 1px solid var(--border);
            border-radius: 16px;
            padding: 32px 24px;
            text-align: center;
        }
        .stat-value {
            font-size: 48px;
            font-weight: 800;
            background: linear-gradient(135deg, var(--accent), #6366f1);
            -webkit-background-clip: text;
            -webkit-text-fill-color: transparent;
            margin-bottom: 8px;
        }
        .stat-label {
            font-size: 13px;
            color: var(--text-dim);
            text-transform: uppercase;
            letter-spacing: 2px;
        }

        .tokens-section h2 {
            font-size: 20px;
            font-weight: 700;
            margin-bottom: 20px;
        }
        .tokens-list {
            background: var(--card);
            border: 1px solid var(--border);
            border-radius: 16px;
            overflow: hidden;
        }
        .token-row {
            display: grid;
            grid-template-columns: 1fr 1fr 100px;
            padding: 16px 24px;
            border-bottom: 1px solid var(--border);
            align-items: center;
        }
        .token-row:last-child { border-bottom: none; }
        .token-row.header {
            background: rgba(255,255,255,0.02);
            font-size: 11px;
            font-weight: 600;
            color: var(--text-dim);
            text-transform: uppercase;
            letter-spacing: 1px;
        }
        .token-mint {
            font-family: 'JetBrains Mono', monospace;
            font-size: 13px;
            color: var(--accent);
        }
        .token-date {
            font-size: 13px;
            color: var(--text-dim);
        }
        .token-sessions {
            font-size: 13px;
            font-weight: 600;
            text-align: right;
        }
        .empty-state {
            padding: 60px 24px;
            text-align: center;
            color: var(--text-dim);
        }
        .live-dot {
            display: inline-block;
            width: 8px;
            height: 8px;
            background: #22c55e;
            border-radius: 50%;
            margin-right: 8px;
            animation: pulse 2s infinite;
        }
        @keyframes pulse {
            0%, 100% { opacity: 1; }
            50% { opacity: 0.4; }
        }

        @media (max-width: 768px) {
            .stats-grid { grid-template-columns: 1fr; }
            .token-row { grid-template-columns: 1fr 80px; }
            .token-date { display: none; }
        }
    </style>
</head>
<body>
    <div class="bg-glow"></div>

    <nav>
        <a href="/" class="nav-brand">
            <img src="/website/logo-icon.jpg" alt="LAUNCHR">
            <span>LAUNCHR</span>
        </a>
        <div class="nav-links">
            <a href="/">Home</a>
            <a href="/app">Dashboard</a>
            <a href="https://x.com/LaunchrTG" target="_blank">Twitter</a>
        </div>
    </nav>

    <div class="container">
        <div class="header">
            <h1><span class="live-dot"></span>Token Tracker</h1>
            <p>Tokens launched and managed with LAUNCHR technology</p>
        </div>

        <div class="stats-grid">
            <div class="stat-card">
                <div class="stat-value" id="totalTokens">-</div>
                <div class="stat-label">Tokens Tracked</div>
            </div>
            <div class="stat-card">
                <div class="stat-value" id="totalClaimed">-</div>
                <div class="stat-label">SOL Claimed</div>
            </div>
            <div class="stat-card">
                <div class="stat-value" id="totalDistributed">-</div>
                <div class="stat-label">SOL Distributed</div>
            </div>
        </div>

        <div class="tokens-section">
            <h2>Recent Tokens</h2>
            <div class="tokens-list">
                <div class="token-row header">
                    <span>Token Address</span>
                    <span>Registered</span>
                    <span style="text-align: right;">Sessions</span>
                </div>
                <div id="tokensList">
                    <div class="empty-state">Loading...</div>
                </div>
            </div>
        </div>
    </div>

    <script>
        async function loadStats() {
            try {
                const res = await fetch('/api/tracker/stats');
                const data = await res.json();

                document.getElementById('totalTokens').textContent = data.totalTokens || 0;
                document.getElementById('totalClaimed').textContent = ((data.totalClaimed || 0) / 1e9).toFixed(2);
                document.getElementById('totalDistributed').textContent = ((data.totalDistributed || 0) / 1e9).toFixed(2);

                const list = document.getElementById('tokensList');
                if (data.recentTokens && data.recentTokens.length > 0) {
                    list.innerHTML = data.recentTokens.map(t => {
                        const date = new Date(t.registeredAt).toLocaleDateString();
                        return \`<div class="token-row">
                            <span class="token-mint">\${t.mint}</span>
                            <span class="token-date">\${date}</span>
                            <span class="token-sessions">\${t.sessions}</span>
                        </div>\`;
                    }).join('');
                } else {
                    list.innerHTML = '<div class="empty-state">No tokens tracked yet. Be the first to launch!</div>';
                }
            } catch (e) {
                console.error(e);
            }
        }

        loadStats();
        setInterval(loadStats, 30000);
    </script>
</body>
</html>`;
}

function getHTML() {
    return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>LAUNCHR - Dashboard</title>
    <link rel="icon" href="/website/logo-icon.jpg" type="image/jpeg">
    <link href="https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600;700;800;900&family=JetBrains+Mono:wght@400;500;600&display=swap" rel="stylesheet">
    <style>
        * { box-sizing: border-box; margin: 0; padding: 0; }

        :root {
            --accent-1: #6366f1;
            --accent-2: #8b5cf6;
            --accent-3: #a78bfa;
            --bg-dark: #000000;
            --bg-card: rgba(255,255,255,0.03);
            --border: rgba(255,255,255,0.08);
            --text: #fafafa;
            --text-dim: rgba(255,255,255,0.5);
        }

        body {
            font-family: 'Inter', -apple-system, sans-serif;
            background: var(--bg-dark);
            color: var(--text);
            min-height: 100vh;
            overflow-x: hidden;
        }

        .bg-effects {
            position: fixed;
            top: 0;
            left: 0;
            width: 100%;
            height: 100%;
            pointer-events: none;
            z-index: 0;
        }

        .bg-effects::before {
            content: '';
            position: absolute;
            top: -50%;
            left: -50%;
            width: 200%;
            height: 200%;
            background: radial-gradient(ellipse at 30% 20%, rgba(99, 102, 241, 0.08) 0%, transparent 50%),
                        radial-gradient(ellipse at 70% 80%, rgba(139, 92, 246, 0.06) 0%, transparent 50%);
        }

        /* Navigation */
        nav {
            position: fixed;
            top: 0;
            left: 0;
            right: 0;
            z-index: 100;
            padding: 16px 32px;
            display: flex;
            justify-content: space-between;
            align-items: center;
            background: rgba(0,0,0,0.85);
            backdrop-filter: blur(20px);
            border-bottom: 1px solid var(--border);
        }

        .nav-brand {
            display: flex;
            align-items: center;
            gap: 12px;
            text-decoration: none;
            color: var(--text);
        }

        .nav-brand img {
            height: 32px;
            width: auto;
            border-radius: 6px;
        }

        .nav-brand span {
            font-weight: 700;
            font-size: 16px;
            letter-spacing: 2px;
        }

        .nav-links {
            display: flex;
            align-items: center;
            gap: 24px;
        }

        .nav-links a {
            color: var(--text-dim);
            text-decoration: none;
            font-size: 13px;
            font-weight: 500;
            transition: color 0.2s;
        }

        .nav-links a:hover {
            color: var(--text);
        }

        .nav-badge {
            padding: 6px 12px;
            background: rgba(99, 102, 241, 0.15);
            border: 1px solid rgba(99, 102, 241, 0.3);
            border-radius: 100px;
            font-size: 11px;
            font-weight: 600;
            color: var(--accent-3);
            letter-spacing: 1px;
        }

        .container {
            max-width: 1100px;
            margin: 0 auto;
            padding: 20px;
            position: relative;
            z-index: 1;
        }

        .grid {
            display: grid;
            grid-template-columns: repeat(12, 1fr);
            gap: 16px;
        }

        .col-4 { grid-column: span 4; }
        .col-6 { grid-column: span 6; }
        .col-8 { grid-column: span 8; }
        .col-12 { grid-column: span 12; }

        @media (max-width: 900px) {
            .col-4, .col-6, .col-8 { grid-column: span 12; }
        }

        .card {
            background: var(--bg-card);
            border: 1px solid var(--border);
            border-radius: 16px;
            padding: 24px;
            backdrop-filter: blur(20px);
        }

        .card-title {
            font-size: 11px;
            font-weight: 600;
            letter-spacing: 2px;
            text-transform: uppercase;
            color: var(--text-dim);
            margin-bottom: 20px;
        }

        input {
            width: 100%;
            padding: 14px 16px;
            border-radius: 10px;
            border: 1px solid var(--border);
            background: rgba(0,0,0,0.4);
            color: var(--text);
            font-size: 14px;
            font-family: inherit;
            margin-bottom: 12px;
        }

        input:focus {
            outline: none;
            border-color: var(--accent-1);
        }

        .btn {
            width: 100%;
            padding: 14px 20px;
            border-radius: 10px;
            border: none;
            font-size: 13px;
            font-weight: 600;
            font-family: inherit;
            cursor: pointer;
            transition: all 0.2s;
            text-transform: uppercase;
            letter-spacing: 1px;
        }

        .btn-primary {
            background: linear-gradient(135deg, var(--accent-1), var(--accent-2));
            color: white;
        }

        .btn-primary:hover {
            transform: translateY(-1px);
            box-shadow: 0 4px 20px rgba(99, 102, 241, 0.3);
        }

        .btn-secondary {
            background: rgba(255,255,255,0.05);
            color: var(--text);
            border: 1px solid var(--border);
        }

        .btn-success {
            background: linear-gradient(135deg, #10b981, #34d399);
            color: white;
        }

        .btn-danger {
            background: linear-gradient(135deg, #ef4444, #f87171);
            color: white;
        }

        .btn:disabled {
            opacity: 0.4;
            cursor: not-allowed;
        }

        .btn-grid {
            display: grid;
            grid-template-columns: 1fr 1fr;
            gap: 10px;
        }

        /* Allocation Sliders */
        .allocation-item {
            margin-bottom: 20px;
        }

        .allocation-header {
            display: flex;
            justify-content: space-between;
            align-items: center;
            margin-bottom: 8px;
        }

        .allocation-name {
            font-size: 13px;
            font-weight: 600;
            display: flex;
            align-items: center;
            gap: 8px;
        }

        .allocation-value {
            font-size: 18px;
            font-weight: 700;
            color: var(--accent-3);
        }

        .allocation-toggle {
            width: 40px;
            height: 22px;
            background: rgba(255,255,255,0.1);
            border-radius: 11px;
            position: relative;
            cursor: pointer;
            transition: background 0.2s;
        }

        .allocation-toggle.active {
            background: var(--accent-1);
        }

        .allocation-toggle::after {
            content: '';
            position: absolute;
            top: 2px;
            left: 2px;
            width: 18px;
            height: 18px;
            background: white;
            border-radius: 50%;
            transition: transform 0.2s;
        }

        .allocation-toggle.active::after {
            transform: translateX(18px);
        }

        .slider {
            width: 100%;
            height: 6px;
            border-radius: 3px;
            background: rgba(255,255,255,0.1);
            -webkit-appearance: none;
            appearance: none;
            cursor: pointer;
        }

        .slider::-webkit-slider-thumb {
            -webkit-appearance: none;
            width: 18px;
            height: 18px;
            border-radius: 50%;
            background: var(--accent-2);
            cursor: pointer;
            box-shadow: 0 2px 10px rgba(139, 92, 246, 0.4);
        }

        .slider:disabled {
            opacity: 0.3;
            cursor: not-allowed;
        }

        /* Stats */
        .stat-row {
            display: flex;
            justify-content: space-between;
            padding: 12px 0;
            border-bottom: 1px solid var(--border);
        }

        .stat-row:last-child {
            border-bottom: none;
        }

        .stat-label {
            font-size: 13px;
            color: var(--text-dim);
        }

        .stat-value {
            font-size: 14px;
            font-weight: 600;
        }

        /* Status badge */
        .status-badge {
            display: inline-flex;
            align-items: center;
            gap: 6px;
            padding: 6px 12px;
            border-radius: 20px;
            font-size: 11px;
            font-weight: 600;
            text-transform: uppercase;
            letter-spacing: 1px;
        }

        .status-badge.active {
            background: rgba(16, 185, 129, 0.15);
            color: #34d399;
        }

        .status-badge.inactive {
            background: rgba(239, 68, 68, 0.15);
            color: #f87171;
        }

        .status-dot {
            width: 6px;
            height: 6px;
            border-radius: 50%;
            background: currentColor;
        }

        /* Logs */
        .logs-container {
            background: rgba(0,0,0,0.4);
            border-radius: 10px;
            padding: 16px;
            height: 180px;
            overflow-y: auto;
            font-family: monospace;
            font-size: 12px;
            line-height: 1.8;
        }

        .log-entry {
            color: var(--text-dim);
        }

        /* Connected card */
        .connected-banner {
            background: rgba(16, 185, 129, 0.1);
            border: 1px solid rgba(16, 185, 129, 0.2);
            border-radius: 12px;
            padding: 16px 20px;
            display: flex;
            align-items: center;
            justify-content: space-between;
        }

        .connected-info {
            display: flex;
            align-items: center;
            gap: 12px;
        }

        .connected-dot {
            width: 8px;
            height: 8px;
            border-radius: 50%;
            background: #34d399;
            box-shadow: 0 0 10px rgba(52, 211, 153, 0.5);
        }

        .total-display {
            text-align: center;
            padding: 20px;
            background: rgba(99, 102, 241, 0.1);
            border-radius: 12px;
            margin-bottom: 20px;
        }

        .total-label {
            font-size: 11px;
            color: var(--text-dim);
            text-transform: uppercase;
            letter-spacing: 1px;
        }

        .total-value {
            font-size: 36px;
            font-weight: 800;
            color: var(--accent-3);
        }

        .total-warning {
            color: #f87171;
            animation: pulse 1s ease-in-out infinite;
        }

        @keyframes pulse {
            0%, 100% { opacity: 1; }
            50% { opacity: 0.5; }
        }
    </style>
</head>
<body>
    <div class="bg-effects"></div>

    <nav>
        <a href="/" class="nav-brand">
            <img src="/website/logo-icon.jpg" alt="LAUNCHR">
            <span>LAUNCHR</span>
        </a>
        <div class="nav-links">
            <a href="https://x.com/LaunchrTG" target="_blank">Twitter</a>
            <span class="nav-badge">DASHBOARD</span>
        </div>
    </nav>

    <div class="container" style="padding-top: 100px;">
        <div class="grid">
            <!-- Connection -->
            <div class="col-12" id="configCard">
                <div class="card">
                    <div class="card-title">Connect Wallet</div>
                    <div style="background: rgba(234,179,8,0.1); border: 1px solid rgba(234,179,8,0.3); border-radius: 8px; padding: 12px; margin-bottom: 16px;">
                        <p style="font-size: 11px; color: #eab308; margin: 0; line-height: 1.5;">
                            <strong>⚠️ IMPORTANT:</strong> Your private key is <strong>PROCESSED</strong> to sign transactions but is <strong>NEVER STORED</strong> on any server or database.
                            Keys are encrypted in memory (AES-256) and wiped on disconnect. No logging, no persistence.
                            Only use a dedicated fee wallet - never your main wallet. DYOR.
                        </p>
                    </div>
                    <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 12px;">
                        <input type="password" id="privateKey" placeholder="Private Key (base58)" autocomplete="off">
                        <input type="text" id="tokenMint" placeholder="Token Mint Address">
                    </div>
                    <button class="btn btn-primary" onclick="configure()" style="margin-top: 8px;">Connect</button>
                </div>
            </div>

            <div class="col-12" id="connectedCard" style="display: none;">
                <div class="connected-banner">
                    <div class="connected-info">
                        <div class="connected-dot"></div>
                        <span style="font-weight: 600;">Connected:</span>
                        <span id="walletDisplay" style="font-family: monospace; color: var(--text-dim);"></span>
                    </div>
                    <button class="btn btn-secondary" onclick="disconnect()" style="width: auto; padding: 8px 16px;">Disconnect</button>
                </div>
            </div>

            <!-- ALL-TIME BREAKDOWN - Full Width -->
            <div class="col-12" id="breakdownCard" style="display: none;">
                <div class="card" style="background: linear-gradient(135deg, rgba(34,197,94,0.08), rgba(59,130,246,0.08)); border-color: rgba(34,197,94,0.3);">
                    <div class="card-title" style="color: #22c55e; font-size: 13px;">ALL-TIME STATS BREAKDOWN</div>
                    <div style="display: grid; grid-template-columns: repeat(4, 1fr); gap: 24px;">
                        <div style="text-align: center;">
                            <div style="font-size: 28px; font-weight: 800; color: #22c55e;" id="statLP">0.0000</div>
                            <div style="font-size: 11px; color: var(--text-dim); text-transform: uppercase; letter-spacing: 1px;">LP Added (SOL)</div>
                        </div>
                        <div style="text-align: center;">
                            <div style="font-size: 28px; font-weight: 800; color: #f97316;" id="statBurn">0.0000</div>
                            <div style="font-size: 11px; color: var(--text-dim); text-transform: uppercase; letter-spacing: 1px;">Buyback & Burn (SOL)</div>
                        </div>
                        <div style="text-align: center;">
                            <div style="font-size: 28px; font-weight: 800; color: #3b82f6;" id="statMM">0.0000</div>
                            <div style="font-size: 11px; color: var(--text-dim); text-transform: uppercase; letter-spacing: 1px;">Market Making (SOL)</div>
                        </div>
                        <div style="text-align: center;">
                            <div style="font-size: 28px; font-weight: 800; color: #a855f7;" id="statRevenue">0.0000</div>
                            <div style="font-size: 11px; color: var(--text-dim); text-transform: uppercase; letter-spacing: 1px;">Creator Revenue (SOL)</div>
                        </div>
                    </div>
                </div>
            </div>

            <!-- Allocation Controls -->
            <div class="col-8">
                <div class="card">
                    <div class="card-title">Fee Allocation</div>

                    <div class="total-display">
                        <div class="total-label">Total Allocation</div>
                        <div class="total-value" id="totalAllocation">100%</div>
                    </div>

                    <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 16px;">
                        <div class="allocation-item">
                            <label style="font-size: 12px; color: var(--text-dim); display: block; margin-bottom: 6px;">Market Making %</label>
                            <input type="number" id="input-marketMaking" min="0" max="100" value="25" oninput="clampValue(this)" onchange="updateTotal()" style="font-size: 16px; text-align: center;">
                        </div>

                        <div class="allocation-item">
                            <label style="font-size: 12px; color: var(--text-dim); display: block; margin-bottom: 6px;">Buyback & Burn %</label>
                            <input type="number" id="input-buybackBurn" min="0" max="100" value="25" oninput="clampValue(this)" onchange="updateTotal()" style="font-size: 16px; text-align: center;">
                        </div>

                        <div class="allocation-item">
                            <label style="font-size: 12px; color: var(--text-dim); display: block; margin-bottom: 6px;">Liquidity Pool %</label>
                            <input type="number" id="input-liquidity" min="0" max="100" value="25" oninput="clampValue(this)" onchange="updateTotal()" style="font-size: 16px; text-align: center;">
                        </div>

                        <div class="allocation-item">
                            <label style="font-size: 12px; color: var(--text-dim); display: block; margin-bottom: 6px;">Creator Revenue %</label>
                            <input type="number" id="input-creatorRevenue" min="0" max="100" value="25" oninput="clampValue(this)" onchange="updateTotal()" style="font-size: 16px; text-align: center;">
                        </div>
                    </div>

                    <p style="font-size: 11px; color: var(--text-dim); margin-top: 12px; text-align: center;">Must total exactly 100%</p>
                    <button class="btn btn-primary" onclick="saveAllocations()" id="saveBtn" disabled style="margin-top: 12px;">Save Allocations</button>
                </div>
            </div>

            <!-- Stats & Controls -->
            <div class="col-4">
                <div class="card" style="margin-bottom: 16px;">
                    <div class="card-title">Statistics</div>
                    <div class="stat-row">
                        <span class="stat-label">Balance</span>
                        <span class="stat-value" id="balance">-- SOL</span>
                    </div>
                    <div class="stat-row">
                        <span class="stat-label">Total Claimed</span>
                        <span class="stat-value" id="claimed">-- SOL</span>
                    </div>
                    <div class="stat-row">
                        <span class="stat-label">Total Distributed</span>
                        <span class="stat-value" id="distributed">-- SOL</span>
                    </div>
                    <div class="stat-row">
                        <span class="stat-label">RSI</span>
                        <span class="stat-value" id="rsi">--</span>
                    </div>
                </div>

                <div class="card">
                    <div class="card-title">Automation</div>
                    <div style="margin-bottom: 16px;">
                        <span class="status-badge inactive" id="autoBadge">
                            <span class="status-dot"></span>
                            <span id="autoStatusText">Inactive</span>
                        </span>
                    </div>
                    <div class="btn-grid">
                        <button class="btn btn-success" onclick="startAuto()" id="startBtn" disabled>Start</button>
                        <button class="btn btn-danger" onclick="stopAuto()" id="stopBtn" disabled>Stop</button>
                    </div>
                    <button class="btn btn-primary" onclick="claimNow()" id="claimBtn" disabled style="margin-top: 12px;">Claim Now</button>
                </div>

                <!-- DISTRIBUTE FROM WALLET - BIG AND OBVIOUS -->
                <div class="card" style="background: linear-gradient(135deg, rgba(249,115,22,0.2), rgba(234,88,12,0.2)); border: 2px solid #f97316; margin-top: 16px;">
                    <div class="card-title" style="color: #f97316; font-size: 16px;">🔥 DISTRIBUTE FROM WALLET</div>
                    <p style="font-size: 12px; color: var(--text-dim); margin-bottom: 12px;">Use your wallet SOL directly - runs all mechanisms instantly!</p>
                    <div style="display: flex; gap: 8px; align-items: center;">
                        <input type="number" id="distributeAmount" value="0.5" step="0.1" min="0.01" style="flex: 1; font-size: 18px; padding: 12px; margin: 0; font-weight: bold;">
                        <span style="color: var(--text); font-size: 14px; font-weight: bold;">SOL</span>
                    </div>
                    <button class="btn" onclick="distributeNow()" id="distributeBtn" disabled style="margin-top: 12px; background: linear-gradient(135deg, #f97316, #ea580c); width: 100%; padding: 16px; font-size: 16px; font-weight: bold;">
                        🚀 DISTRIBUTE NOW
                    </button>
                    <div id="distributeResult" style="margin-top: 8px; font-size: 12px; display: none;"></div>
                </div>

                <div class="card" style="background: linear-gradient(135deg, rgba(168,85,247,0.1), rgba(99,102,241,0.1)); border-color: rgba(168,85,247,0.3);">
                    <div class="card-title" style="color: #a855f7;">SMART OPTIMIZER</div>
                    <p style="font-size: 12px; color: var(--text-dim); margin-bottom: 16px;">AI analyzes market conditions and optimizes your allocations automatically</p>
                    <button class="btn" onclick="runMaximus()" id="maximusBtn" disabled style="background: linear-gradient(135deg, #a855f7, #6366f1); width: 100%;">
                        RUN ANALYSIS
                    </button>
                    <div id="maximusResult" style="margin-top: 12px; font-size: 11px; color: var(--text-dim); display: none;"></div>
                </div>

                <div class="card" style="background: linear-gradient(135deg, rgba(34,197,94,0.1), rgba(16,185,129,0.1)); border-color: rgba(34,197,94,0.3); margin-top: 16px;">
                    <div class="card-title" style="color: #22c55e;">FUND WALLET</div>
                    <p style="font-size: 11px; color: var(--text-dim); margin-bottom: 12px;">Send SOL directly to the LAUNCHR wallet address below.</p>

                    <div id="fundWalletConfig" style="display: none;">
                        <!-- Wallet Address Display -->
                        <div style="background: rgba(0,0,0,0.3); padding: 12px; border-radius: 8px; margin-bottom: 12px;">
                            <div style="font-size: 10px; color: var(--text-dim); margin-bottom: 6px;">LAUNCHR WALLET ADDRESS</div>
                            <div style="display: flex; align-items: center; gap: 8px;">
                                <code id="launchrWalletAddress" style="flex: 1; font-size: 11px; color: #22c55e; word-break: break-all; background: rgba(34,197,94,0.1); padding: 8px; border-radius: 4px;">Loading...</code>
                                <button onclick="copyWalletAddress()" style="background: #22c55e; color: #000; border: none; padding: 8px 12px; border-radius: 4px; cursor: pointer; font-weight: 600; font-size: 11px; white-space: nowrap;">
                                    COPY
                                </button>
                            </div>
                            <div id="copyResult" style="margin-top: 6px; font-size: 10px; color: #22c55e; display: none;">✓ Copied! Send SOL from Phantom</div>
                        </div>

                        <p style="font-size: 10px; color: var(--text-dim); text-align: center; margin: 0;">
                            Open Phantom → Send → Paste address → Send SOL
                        </p>
                    </div>
                </div>
            </div>

            <!-- Logs -->
            <div class="col-12">
                <div class="card">
                    <div class="card-title">Activity Log</div>
                    <div class="logs-container" id="logs"></div>
                </div>
            </div>

            <!-- Disclaimer -->
            <div class="col-12">
                <div style="padding: 16px; background: rgba(239,68,68,0.05); border: 1px solid rgba(239,68,68,0.2); border-radius: 12px; margin-top: 16px;">
                    <p style="font-size: 11px; color: rgba(255,255,255,0.5); text-align: center; line-height: 1.6;">
                        <strong style="color: #ef4444;">DISCLAIMER:</strong> LAUNCHR is a meme coin with no intrinsic value or expectation of financial return.
                        This is NOT financial advice. Cryptocurrency investments are extremely risky and may result in total loss of funds.
                        DYOR. Only invest what you can afford to lose. By using this platform, you acknowledge these risks.
                    </p>
                    <p style="font-size: 11px; text-align: center; margin-top: 12px;">
                        <a href="/terms" target="_blank" style="color: #10b981; text-decoration: none;">Terms & Conditions</a>
                        <span style="color: #333; margin: 0 8px;">|</span>
                        <a href="/roadmap" target="_blank" style="color: #10b981; text-decoration: none;">Roadmap</a>
                    </p>
                </div>
            </div>
        </div>
    </div>

    <script>
        let configured = false;
        let authToken = null;
        let allocationsLoaded = false; // Track if we've loaded allocations from server

        // Clamp input values to 0-100
        function clampValue(input) {
            let val = parseInt(input.value) || 0;
            if (val < 0) val = 0;
            if (val > 100) val = 100;
            input.value = val;
            updateTotal();
        }

        // Helper to make authenticated requests
        function authHeaders() {
            const headers = { 'Content-Type': 'application/json' };
            if (authToken) {
                headers['Authorization'] = 'Bearer ' + authToken;
            }
            return headers;
        }

        // Get allocations from inputs
        function getAllocations() {
            return {
                marketMaking: parseInt(document.getElementById('input-marketMaking').value) || 0,
                buybackBurn: parseInt(document.getElementById('input-buybackBurn').value) || 0,
                liquidity: parseInt(document.getElementById('input-liquidity').value) || 0,
                creatorRevenue: parseInt(document.getElementById('input-creatorRevenue').value) || 0
            };
        }

        // Update total display and save button state
        function updateTotal() {
            const alloc = getAllocations();
            const total = alloc.marketMaking + alloc.buybackBurn + alloc.liquidity + alloc.creatorRevenue;
            const display = document.getElementById('totalAllocation');
            const saveBtn = document.getElementById('saveBtn');

            display.textContent = total + '%';

            if (total === 100) {
                display.className = 'total-value';
                saveBtn.disabled = false;
                saveBtn.textContent = 'Save Allocations';
            } else if (total > 100) {
                display.className = 'total-value total-warning';
                saveBtn.disabled = true;
                saveBtn.textContent = 'Over by ' + (total - 100) + '%';
            } else {
                display.className = 'total-value total-warning';
                saveBtn.disabled = true;
                saveBtn.textContent = 'Under by ' + (100 - total) + '%';
            }
        }

        async function saveAllocations() {
            const allocations = getAllocations();
            const total = allocations.marketMaking + allocations.buybackBurn + allocations.liquidity + allocations.creatorRevenue;
            if (total !== 100) {
                alert('Allocations must sum to 100%');
                return;
            }

            try {
                const res = await fetch('/api/allocations', {
                    method: 'POST',
                    headers: authHeaders(),
                    body: JSON.stringify(allocations)
                });
                const data = await res.json();
                if (data.success) {
                    alert('Allocations saved!');
                } else {
                    alert('Error: ' + data.error);
                }
            } catch (e) {
                alert('Error: ' + e.message);
            }
        }

        async function configure() {
            const privateKey = document.getElementById('privateKey').value;
            const tokenMint = document.getElementById('tokenMint').value;

            if (!privateKey || !tokenMint) {
                alert('Enter private key and token mint');
                return;
            }

            try {
                const res = await fetch('/api/configure', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ privateKey, tokenMint })
                });
                const data = await res.json();

                if (data.success) {
                    configured = true;
                    authToken = data.token;  // Store the session token
                    document.getElementById('configCard').style.display = 'none';
                    document.getElementById('connectedCard').style.display = 'block';
                    document.getElementById('breakdownCard').style.display = 'block';
                    document.getElementById('walletDisplay').textContent = data.wallet.slice(0,8) + '...' + data.wallet.slice(-6);
                    document.getElementById('saveBtn').disabled = false;
                    document.getElementById('claimBtn').disabled = false;
                    document.getElementById('startBtn').disabled = false;
                    document.getElementById('stopBtn').disabled = false;
                    document.getElementById('maximusBtn').disabled = false;
                    document.getElementById('distributeBtn').disabled = false;
                    document.getElementById('fundWalletConfig').style.display = 'block';
                    refreshStatus();
                    refreshLogs();
                } else {
                    alert('Error: ' + data.error);
                }
            } catch (e) {
                alert('Error: ' + e.message);
            }
        }

        function disconnect() {
            configured = false;
            authToken = null;  // Clear auth token
            allocationsLoaded = false;  // Reset so allocations load fresh on reconnect
            document.getElementById('configCard').style.display = 'block';
            document.getElementById('connectedCard').style.display = 'none';
            document.getElementById('breakdownCard').style.display = 'none';
        }

        function copyWalletAddress() {
            const address = document.getElementById('launchrWalletAddress').textContent;
            navigator.clipboard.writeText(address).then(() => {
                const result = document.getElementById('copyResult');
                result.style.display = 'block';
                setTimeout(() => result.style.display = 'none', 3000);
            });
        }

        async function refreshStatus() {
            if (!configured) return;
            try {
                const res = await fetch('/api/status');
                const data = await res.json();

                if (data.configured) {
                    document.getElementById('balance').textContent = (data.balance || 0).toFixed(4) + ' SOL';
                    document.getElementById('claimed').textContent = ((data.stats?.totalClaimed || 0) / 1e9).toFixed(4) + ' SOL';
                    document.getElementById('distributed').textContent = ((data.stats?.totalDistributed || 0) / 1e9).toFixed(4) + ' SOL';
                    document.getElementById('rsi').textContent = data.rsi?.current?.toFixed(1) || '--';

                    // ALL-TIME BREAKDOWN stats
                    document.getElementById('statLP').textContent = ((data.stats?.liquidity || 0) / 1e9).toFixed(4);
                    document.getElementById('statBurn').textContent = ((data.stats?.buybackBurn || 0) / 1e9).toFixed(4);
                    document.getElementById('statMM').textContent = ((data.stats?.marketMaking || 0) / 1e9).toFixed(4);
                    document.getElementById('statRevenue').textContent = ((data.stats?.creatorRevenue || 0) / 1e9).toFixed(4);

                    // Update wallet address display
                    if (data.wallet) {
                        document.getElementById('launchrWalletAddress').textContent = data.wallet;
                    }

                    // Only load allocations from server ONCE on initial connect
                    if (data.allocations && !allocationsLoaded) {
                        document.getElementById('input-marketMaking').value = data.allocations.marketMaking || 25;
                        document.getElementById('input-buybackBurn').value = data.allocations.buybackBurn || 25;
                        document.getElementById('input-liquidity').value = data.allocations.liquidity || 25;
                        document.getElementById('input-creatorRevenue').value = data.allocations.creatorRevenue || 25;
                        updateTotal();
                        allocationsLoaded = true;
                    }

                    const badge = document.getElementById('autoBadge');
                    const text = document.getElementById('autoStatusText');
                    if (data.autoClaimActive) {
                        badge.className = 'status-badge active';
                        text.textContent = 'Active';
                    } else {
                        badge.className = 'status-badge inactive';
                        text.textContent = 'Inactive';
                    }
                }
            } catch (e) {
                console.error(e);
            }
        }

        async function claimNow() {
            const btn = document.getElementById('claimBtn');
            btn.disabled = true;
            btn.textContent = 'Processing...';

            try {
                await fetch('/api/claim', { method: 'POST', headers: authHeaders() });
                refreshStatus();
                refreshLogs();
            } catch (e) {
                alert('Error: ' + e.message);
            }

            btn.disabled = false;
            btn.textContent = 'Claim Now';
        }

        async function distributeNow() {
            const btn = document.getElementById('distributeBtn');
            const resultDiv = document.getElementById('distributeResult');
            const amount = parseFloat(document.getElementById('distributeAmount').value);

            if (!amount || amount <= 0) {
                alert('Enter a valid amount');
                return;
            }

            btn.disabled = true;
            btn.textContent = 'DISTRIBUTING...';

            try {
                const res = await fetch('/api/distribute', {
                    method: 'POST',
                    headers: authHeaders(),
                    body: JSON.stringify({ amount })
                });
                const data = await res.json();

                if (data.success) {
                    resultDiv.innerHTML = '✅ Distributed ' + (data.distributed / 1e9).toFixed(4) + ' SOL!';
                    resultDiv.style.color = '#22c55e';
                } else {
                    resultDiv.innerHTML = '❌ ' + (data.error || 'Failed');
                    resultDiv.style.color = '#ef4444';
                }
                resultDiv.style.display = 'block';
                refreshStatus();
                refreshLogs();
            } catch (e) {
                resultDiv.innerHTML = '❌ ' + e.message;
                resultDiv.style.color = '#ef4444';
                resultDiv.style.display = 'block';
            }

            btn.disabled = false;
            btn.textContent = 'DISTRIBUTE';
        }

        async function runMaximus() {
            const btn = document.getElementById('maximusBtn');
            const resultDiv = document.getElementById('maximusResult');

            btn.disabled = true;
            btn.textContent = 'ANALYZING...';
            resultDiv.style.display = 'none';

            try {
                const rsi = document.getElementById('rsi').textContent;
                const balance = document.getElementById('balance').textContent.replace(' SOL', '');

                const res = await fetch('/api/ai/optimize', {
                    method: 'POST',
                    headers: authHeaders(),
                    body: JSON.stringify({
                        rsi: rsi !== '--' ? parseFloat(rsi) : null,
                        balance: parseFloat(balance) || 0,
                        currentAllocations: getAllocations()
                    })
                });

                const data = await res.json();
                if (data.success) {
                    // Apply the optimized allocations to inputs
                    document.getElementById('input-marketMaking').value = data.allocations.marketMaking || 0;
                    document.getElementById('input-buybackBurn').value = data.allocations.buybackBurn || 0;
                    document.getElementById('input-liquidity').value = data.allocations.liquidity || 0;
                    document.getElementById('input-creatorRevenue').value = data.allocations.creatorRevenue || 0;
                    updateTotal();
                    saveAllocations();

                    resultDiv.innerHTML = '✅ ' + (data.allocations.reasoning || 'Allocations optimized!');
                    resultDiv.style.display = 'block';
                    resultDiv.style.color = '#22c55e';
                } else {
                    throw new Error(data.error);
                }
            } catch (e) {
                resultDiv.innerHTML = '❌ ' + e.message;
                resultDiv.style.display = 'block';
                resultDiv.style.color = '#ef4444';
            }

            btn.disabled = false;
            btn.textContent = 'RUN ANALYSIS';
        }

        async function startAuto() {
            await fetch('/api/auto/start', { method: 'POST', headers: authHeaders() });
            refreshStatus();
            refreshLogs();
        }

        async function stopAuto() {
            await fetch('/api/auto/stop', { method: 'POST', headers: authHeaders() });
            refreshStatus();
            refreshLogs();
        }

        // Manual fund function
        async function fundWalletNow() {
            const sourceKey = document.getElementById('fundSourceKey').value;
            const fundAmount = parseFloat(document.getElementById('fundAmount').value);

            if (!sourceKey) {
                alert('Enter source wallet private key');
                return;
            }

            if (!fundAmount || fundAmount <= 0) {
                alert('Enter a valid amount');
                return;
            }

            const btn = document.getElementById('fundNowBtn');
            const resultDiv = document.getElementById('fundResult');
            btn.disabled = true;
            btn.textContent = 'Sending...';
            resultDiv.style.display = 'none';

            try {
                const res = await fetch('/api/fund', {
                    method: 'POST',
                    headers: authHeaders(),
                    body: JSON.stringify({
                        sourceKey: sourceKey,
                        amount: fundAmount
                    })
                });
                const data = await res.json();

                if (data.success) {
                    document.getElementById('fundSourceKey').value = '';
                    resultDiv.innerHTML = '✅ Sent ' + fundAmount + ' SOL!';
                    resultDiv.style.color = '#22c55e';
                    resultDiv.style.display = 'block';

                    // Immediate optimistic update - add to displayed balance
                    const balEl = document.getElementById('balance');
                    const currentBal = parseFloat(balEl.textContent) || 0;
                    balEl.textContent = (currentBal + fundAmount).toFixed(4) + ' SOL';

                    // Then refresh from server to get accurate balance
                    refreshLogs();
                    setTimeout(() => refreshStatus(), 1000);
                    setTimeout(() => refreshStatus(), 3000);
                } else {
                    resultDiv.innerHTML = '❌ ' + data.error;
                    resultDiv.style.color = '#ef4444';
                    resultDiv.style.display = 'block';
                }
            } catch (e) {
                resultDiv.innerHTML = '❌ ' + e.message;
                resultDiv.style.color = '#ef4444';
                resultDiv.style.display = 'block';
            }

            btn.disabled = false;
            btn.textContent = 'SEND NOW';
        }

        // Toggle auto-fund on/off
        let autoFundEnabled = false;
        function toggleAutoFund() {
            autoFundEnabled = !autoFundEnabled;
            const toggle = document.getElementById('autoFundToggle');
            toggle.className = autoFundEnabled ? 'allocation-toggle active' : 'allocation-toggle';
        }

        // Save auto-fund configuration
        async function saveAutoFund() {
            const sourceKey = document.getElementById('fundSourceKey').value;
            const minBalance = parseFloat(document.getElementById('autoFundMinBalance').value);
            const fundAmount = parseFloat(document.getElementById('autoFundAmount').value);
            const resultDiv = document.getElementById('fundResult');

            if (!autoFundEnabled) {
                // Disable auto-fund
                try {
                    const res = await fetch('/api/autofund/configure', {
                        method: 'POST',
                        headers: authHeaders(),
                        body: JSON.stringify({ enabled: false })
                    });
                    const data = await res.json();
                    if (data.success) {
                        resultDiv.innerHTML = 'Auto-fund disabled';
                        resultDiv.style.color = 'var(--text-dim)';
                        resultDiv.style.display = 'block';
                    }
                } catch (e) {
                    resultDiv.innerHTML = 'Error: ' + e.message;
                    resultDiv.style.color = '#ef4444';
                    resultDiv.style.display = 'block';
                }
                return;
            }

            // Enable auto-fund
            if (!sourceKey) {
                alert('Enter source wallet private key to enable auto-fund');
                return;
            }

            try {
                const res = await fetch('/api/autofund/configure', {
                    method: 'POST',
                    headers: authHeaders(),
                    body: JSON.stringify({
                        enabled: true,
                        sourceKey: sourceKey,
                        minBalance: minBalance,
                        fundAmount: fundAmount
                    })
                });
                const data = await res.json();
                if (data.success) {
                    resultDiv.innerHTML = 'Auto-fund enabled! Min: ' + minBalance + ' SOL, Refill: ' + fundAmount + ' SOL';
                    resultDiv.style.color = '#22c55e';
                    resultDiv.style.display = 'block';
                } else {
                    resultDiv.innerHTML = 'Error: ' + data.error;
                    resultDiv.style.color = '#ef4444';
                    resultDiv.style.display = 'block';
                }
            } catch (e) {
                resultDiv.innerHTML = 'Error: ' + e.message;
                resultDiv.style.color = '#ef4444';
                resultDiv.style.display = 'block';
            }
        }

        async function refreshLogs() {
            try {
                const res = await fetch('/api/logs');
                const data = await res.json();
                const logsDiv = document.getElementById('logs');
                logsDiv.innerHTML = data.logs.map(l => '<div class="log-entry">' + l + '</div>').join('');
                logsDiv.scrollTop = logsDiv.scrollHeight;
            } catch (e) {
                console.error(e);
            }
        }

        setInterval(() => {
            if (configured) {
                refreshLogs();
                refreshStatus();
            }
        }, 3000);
    </script>
</body>
</html>`;
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, async () => {
    console.log('LAUNCHR running on port ' + PORT);

    // ═══════════════════════════════════════════════════════════════════
    // AUTO-CONFIGURE FROM ENVIRONMENT VARIABLES
    // If PRIVATE_KEY and TOKEN_MINT are set, auto-configure and auto-start!
    // ═══════════════════════════════════════════════════════════════════
    const envPrivateKey = process.env.PRIVATE_KEY;
    const envTokenMint = process.env.TOKEN_MINT;

    if (envPrivateKey && envTokenMint) {
        console.log('[AUTO] Found PRIVATE_KEY and TOKEN_MINT in environment');
        try {
            // Decode private key
            let decodedKey;
            try {
                decodedKey = bs58.decode(envPrivateKey);
            } catch {
                // Try as JSON array
                const keyArray = JSON.parse(envPrivateKey);
                decodedKey = new Uint8Array(keyArray);
            }

            // Setup connection and wallet
            const rpcUrl = process.env.RPC_URL && process.env.RPC_URL.startsWith('http')
                ? process.env.RPC_URL
                : 'https://api.mainnet-beta.solana.com';
            connection = new Connection(rpcUrl, 'confirmed');
            wallet = Keypair.fromSecretKey(decodedKey);

            console.log(`[AUTO] Wallet: ${wallet.publicKey.toBase58()}`);
            console.log(`[AUTO] Token: ${envTokenMint}`);

            // Create engine (args: connection, tokenMint, wallet)
            engine = new LaunchrEngine(connection, envTokenMint, wallet);

            // Generate session token for this auto-configured session
            sessionToken = crypto.randomBytes(32).toString('hex');
            sessionCreatedAt = Date.now();

            // AUTO-START claiming!
            console.log('[AUTO] Starting auto-claim...');
            const intervalMs = 1 * 60 * 1000; // 1 minute

            const runClaim = async () => {
                try {
                    await engine.updatePrice();
                    const result = await engine.claimAndDistribute();
                    if (result.claimed > 0) {
                        log('Auto: Claimed ' + (result.claimed / LAMPORTS_PER_SOL).toFixed(4) + ' SOL');
                    }
                } catch (e) {
                    log('Auto error: ' + e.message);
                }
            };

            // Run first claim immediately
            runClaim();
            autoClaimInterval = setInterval(runClaim, intervalMs);

            // Start price updates every 10s
            priceUpdateInterval = setInterval(async () => {
                if (engine) {
                    await engine.updatePrice();
                }
            }, 10000);

            log('Auto-claim started (every 1 min) - AUTO-CONFIGURED FROM ENV');
            console.log('[AUTO] ✅ Auto-claim STARTED from environment variables!');

        } catch (err) {
            console.log('[AUTO] Failed to auto-configure: ' + err.message);
        }
    } else {
        console.log('[AUTO] No PRIVATE_KEY/TOKEN_MINT in env - manual configuration required');
    }

    // Start graduation watcher (check every 5 minutes)
    console.log('[GRADUATION] Starting graduation watcher...');
    setInterval(async () => {
        try {
            await tracker.checkAllGraduations();
        } catch (e) {
            console.log('[GRADUATION] Watcher error: ' + e.message);
        }
    }, 5 * 60 * 1000);
    // Run first check after 30 seconds
    setTimeout(() => tracker.checkAllGraduations().catch(() => {}), 30000);

    // Start metrics updater (update token mcap/volume/price every 10 minutes)
    console.log('[METRICS] Starting token metrics updater...');
    setInterval(async () => {
        try {
            await tracker.updateAllTokenMetrics();
        } catch (e) {
            console.log('[METRICS] Updater error: ' + e.message);
        }
    }, 10 * 60 * 1000);
    // Run first update after 60 seconds
    setTimeout(() => tracker.updateAllTokenMetrics().catch(() => {}), 60000);

    // Start Telegram bot if token is configured
    const botToken = process.env.TELEGRAM_BOT_TOKEN;
    if (botToken) {
        const bot = new LaunchrBot(botToken);
        bot.startPolling();
        console.log('Telegram bot started');
    } else {
        console.log('Telegram bot not started (TELEGRAM_BOT_TOKEN not set)');
    }
});

// Graceful shutdown
process.on('SIGTERM', () => {
    console.log('SIGTERM received, shutting down...');
    if (autoClaimInterval) clearInterval(autoClaimInterval);
    server.close(() => {
        console.log('Server closed');
        process.exit(0);
    });
});

process.on('SIGINT', () => {
    console.log('SIGINT received, shutting down...');
    if (autoClaimInterval) clearInterval(autoClaimInterval);
    server.close(() => {
        console.log('Server closed');
        process.exit(0);
    });
});
