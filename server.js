const http = require('http');
const crypto = require('crypto');
const { Connection, Keypair, LAMPORTS_PER_SOL, PublicKey } = require('@solana/web3.js');
const { FeeDistributor } = require('./fee-distributor');
const bs58 = require('bs58');

// Security constants
const MAX_BODY_SIZE = 10 * 1024; // 10KB max request body
const SESSION_TOKEN_BYTES = 32;

let distributor = null;
let connection = null;
let wallet = null;
let logs = [];
let autoClaimInterval = null;
let sessionToken = null; // Auth token for this session

// HTML escape to prevent XSS
function escapeHtml(str) {
    return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#039;');
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

// Check auth token
function isAuthorized(req) {
    if (!sessionToken) return false;
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

    if (req.method === 'OPTIONS') {
        res.writeHead(200);
        res.end();
        return;
    }

    if (url.pathname === '/' && req.method === 'GET') {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(getHTML());
        return;
    }

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

            connection = new Connection(
                process.env.RPC_URL || 'https://api.mainnet-beta.solana.com',
                'confirmed'
            );
            wallet = Keypair.fromSecretKey(decodedKey);
            distributor = new FeeDistributor(connection, data.tokenMint, wallet);

            // Generate session token for subsequent requests
            sessionToken = crypto.randomBytes(SESSION_TOKEN_BYTES).toString('hex');

            log('Connected: ' + wallet.publicKey.toBase58().slice(0,8) + '...');
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
                success: true,
                wallet: wallet.publicKey.toBase58(),
                token: sessionToken
            }));
        } catch (e) {
            log('Config error: ' + e.message);
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: false, error: e.message }));
        }
        return;
    }

    if (url.pathname === '/api/status' && req.method === 'GET') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        if (!distributor) {
            res.end(JSON.stringify({ configured: false }));
            return;
        }
        try {
            const balance = await connection.getBalance(wallet.publicKey);
            const status = distributor.getStatus();
            res.end(JSON.stringify({
                configured: true,
                wallet: wallet.publicKey.toBase58(),
                balance: balance / LAMPORTS_PER_SOL,
                tokenMint: status.tokenMint,
                stats: status.stats,
                rsi: status.rsi,
                autoClaimActive: autoClaimInterval !== null
            }));
        } catch (e) {
            res.end(JSON.stringify({ configured: true, error: e.message }));
        }
        return;
    }

    if (url.pathname === '/api/claim' && req.method === 'POST') {
        if (!isAuthorized(req)) {
            res.writeHead(401, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: false, error: 'Unauthorized' }));
            return;
        }
        if (!distributor) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: false, error: 'Not configured' }));
            return;
        }
        try {
            log('Starting claim + distribute...');
            await distributor.updatePrice();
            const result = await distributor.claimAndDistribute();
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

    if (url.pathname === '/api/distribute' && req.method === 'POST') {
        if (!isAuthorized(req)) {
            res.writeHead(401, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: false, error: 'Unauthorized' }));
            return;
        }
        if (!distributor) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: false, error: 'Not configured' }));
            return;
        }
        try {
            const data = await parseBody(req);
            const amount = parseFloat(data.amount) * LAMPORTS_PER_SOL;
            if (isNaN(amount) || amount <= 0) {
                throw new Error('Invalid amount');
            }
            log('Manual distribute: ' + data.amount + ' SOL');
            await distributor.updatePrice();
            const result = await distributor.distributeFees(amount);
            log('Distribution complete');
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(result));
        } catch (e) {
            log('Error: ' + e.message);
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: false, error: e.message }));
        }
        return;
    }

    if (url.pathname === '/api/auto/start' && req.method === 'POST') {
        if (!isAuthorized(req)) {
            res.writeHead(401, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: false, error: 'Unauthorized' }));
            return;
        }
        if (!distributor) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: false, error: 'Not configured' }));
            return;
        }
        if (autoClaimInterval) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: false, error: 'Already running' }));
            return;
        }
        const intervalMs = 10 * 60 * 1000;
        log('Auto-claim started (every 10 min)');
        const runClaim = async () => {
            try {
                if (!distributor) {
                    log('Auto: Distributor not available');
                    return;
                }
                await distributor.updatePrice();
                const result = await distributor.claimAndDistribute();
                if (result.claimed > 0) {
                    log('Auto: Claimed ' + (result.claimed / LAMPORTS_PER_SOL).toFixed(4) + ' SOL');
                }
            } catch (e) {
                log('Auto error: ' + e.message);
            }
        };
        runClaim();
        autoClaimInterval = setInterval(runClaim, intervalMs);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true }));
        return;
    }

    if (url.pathname === '/api/auto/stop' && req.method === 'POST') {
        if (!isAuthorized(req)) {
            res.writeHead(401, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: false, error: 'Unauthorized' }));
            return;
        }
        if (autoClaimInterval) {
            clearInterval(autoClaimInterval);
            autoClaimInterval = null;
            log('Auto-claim stopped');
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true }));
        return;
    }

    if (url.pathname === '/api/logs' && req.method === 'GET') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        // Escape logs to prevent XSS when rendered as HTML
        const escapedLogs = logs.map(l => escapeHtml(l));
        res.end(JSON.stringify({ logs: escapedLogs }));
        return;
    }

    res.writeHead(404);
    res.end('Not found');
});

function getHTML() {
    return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>STARFIRE</title>
    <link rel="icon" href="https://em-content.zobj.net/source/apple/391/comet_2604-fe0f.png">
    <link href="https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600;700;800;900&display=swap" rel="stylesheet">
    <style>
        * { box-sizing: border-box; margin: 0; padding: 0; }

        :root {
            --fire-1: #ff4d00;
            --fire-2: #ff8c00;
            --fire-3: #ffb700;
            --bg-dark: #050505;
            --bg-card: rgba(255,255,255,0.03);
            --border: rgba(255,255,255,0.06);
            --text: #ffffff;
            --text-dim: rgba(255,255,255,0.5);
        }

        body {
            font-family: 'Inter', -apple-system, sans-serif;
            background: var(--bg-dark);
            color: var(--text);
            min-height: 100vh;
            overflow-x: hidden;
        }

        /* Animated background */
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
            background: radial-gradient(ellipse at 30% 20%, rgba(255, 77, 0, 0.15) 0%, transparent 50%),
                        radial-gradient(ellipse at 70% 80%, rgba(255, 140, 0, 0.1) 0%, transparent 50%),
                        radial-gradient(ellipse at 50% 50%, rgba(255, 183, 0, 0.05) 0%, transparent 70%);
            animation: pulse 8s ease-in-out infinite;
        }

        @keyframes pulse {
            0%, 100% { transform: scale(1) rotate(0deg); opacity: 1; }
            50% { transform: scale(1.1) rotate(5deg); opacity: 0.8; }
        }

        .glow-orb {
            position: absolute;
            border-radius: 50%;
            filter: blur(80px);
            animation: float 6s ease-in-out infinite;
        }

        .glow-orb-1 {
            width: 400px;
            height: 400px;
            background: rgba(255, 77, 0, 0.3);
            top: -100px;
            right: -100px;
            animation-delay: 0s;
        }

        .glow-orb-2 {
            width: 300px;
            height: 300px;
            background: rgba(255, 140, 0, 0.2);
            bottom: -50px;
            left: -50px;
            animation-delay: -3s;
        }

        @keyframes float {
            0%, 100% { transform: translate(0, 0); }
            50% { transform: translate(30px, 30px); }
        }

        /* Header */
        .header {
            position: relative;
            padding: 60px 20px;
            text-align: center;
            z-index: 1;
            overflow: hidden;
        }

        .header::before {
            content: '';
            position: absolute;
            top: 0;
            left: 0;
            right: 0;
            height: 1px;
            background: linear-gradient(90deg, transparent, var(--fire-1), var(--fire-2), var(--fire-1), transparent);
        }

        .header::after {
            content: '';
            position: absolute;
            bottom: 0;
            left: 50%;
            transform: translateX(-50%);
            width: 80%;
            height: 1px;
            background: linear-gradient(90deg, transparent, var(--border), transparent);
        }

        .logo {
            font-size: 56px;
            font-weight: 900;
            letter-spacing: 12px;
            background: linear-gradient(135deg, var(--fire-1) 0%, var(--fire-2) 50%, var(--fire-3) 100%);
            -webkit-background-clip: text;
            -webkit-text-fill-color: transparent;
            background-clip: text;
            text-shadow: 0 0 80px rgba(255, 77, 0, 0.5);
            position: relative;
            display: inline-block;
        }

        .logo::before {
            content: 'STARFIRE';
            position: absolute;
            top: 0;
            left: 0;
            background: linear-gradient(135deg, var(--fire-1), var(--fire-2), var(--fire-3));
            -webkit-background-clip: text;
            -webkit-text-fill-color: transparent;
            filter: blur(30px);
            opacity: 0.5;
            z-index: -1;
        }

        .tagline {
            margin-top: 16px;
            font-size: 14px;
            font-weight: 400;
            letter-spacing: 4px;
            text-transform: uppercase;
            color: var(--text-dim);
        }

        /* Container */
        .container {
            max-width: 1100px;
            margin: 0 auto;
            padding: 20px;
            position: relative;
            z-index: 1;
        }

        /* Grid */
        .grid {
            display: grid;
            grid-template-columns: repeat(12, 1fr);
            gap: 20px;
        }

        .col-6 { grid-column: span 6; }
        .col-12 { grid-column: span 12; }

        @media (max-width: 900px) {
            .col-6 { grid-column: span 12; }
        }

        /* Cards */
        .card {
            background: var(--bg-card);
            border: 1px solid var(--border);
            border-radius: 20px;
            padding: 28px;
            position: relative;
            overflow: hidden;
            backdrop-filter: blur(20px);
            transition: all 0.4s cubic-bezier(0.4, 0, 0.2, 1);
        }

        .card::before {
            content: '';
            position: absolute;
            top: 0;
            left: 0;
            right: 0;
            height: 1px;
            background: linear-gradient(90deg, transparent, rgba(255,255,255,0.1), transparent);
        }

        .card:hover {
            border-color: rgba(255, 77, 0, 0.2);
            transform: translateY(-2px);
            box-shadow: 0 20px 40px -20px rgba(255, 77, 0, 0.2);
        }

        .card-title {
            font-size: 11px;
            font-weight: 600;
            letter-spacing: 3px;
            text-transform: uppercase;
            color: var(--text-dim);
            margin-bottom: 24px;
            display: flex;
            align-items: center;
            gap: 10px;
        }

        .card-title::before {
            content: '';
            width: 8px;
            height: 8px;
            border-radius: 50%;
            background: linear-gradient(135deg, var(--fire-1), var(--fire-2));
            box-shadow: 0 0 10px var(--fire-1);
        }

        /* Inputs */
        input {
            width: 100%;
            padding: 16px 20px;
            border-radius: 12px;
            border: 1px solid var(--border);
            background: rgba(0,0,0,0.4);
            color: var(--text);
            font-size: 14px;
            font-family: inherit;
            margin-bottom: 14px;
            transition: all 0.3s ease;
        }

        input:focus {
            outline: none;
            border-color: var(--fire-1);
            box-shadow: 0 0 0 4px rgba(255, 77, 0, 0.1), 0 0 20px rgba(255, 77, 0, 0.1);
        }

        input::placeholder { color: rgba(255,255,255,0.25); }

        /* Buttons */
        .btn {
            width: 100%;
            padding: 16px 24px;
            border-radius: 12px;
            border: none;
            font-size: 13px;
            font-weight: 700;
            font-family: inherit;
            cursor: pointer;
            transition: all 0.3s cubic-bezier(0.4, 0, 0.2, 1);
            text-transform: uppercase;
            letter-spacing: 2px;
            position: relative;
            overflow: hidden;
        }

        .btn::before {
            content: '';
            position: absolute;
            top: 0;
            left: -100%;
            width: 100%;
            height: 100%;
            background: linear-gradient(90deg, transparent, rgba(255,255,255,0.2), transparent);
            transition: left 0.5s ease;
        }

        .btn:hover::before {
            left: 100%;
        }

        .btn-primary {
            background: linear-gradient(135deg, var(--fire-1) 0%, var(--fire-2) 100%);
            color: white;
            box-shadow: 0 4px 20px rgba(255, 77, 0, 0.3);
        }

        .btn-primary:hover {
            transform: translateY(-2px);
            box-shadow: 0 8px 30px rgba(255, 77, 0, 0.4);
        }

        .btn-secondary {
            background: rgba(255,255,255,0.05);
            color: var(--text);
            border: 1px solid var(--border);
        }

        .btn-secondary:hover {
            background: rgba(255,255,255,0.1);
            border-color: rgba(255,255,255,0.2);
        }

        .btn-success {
            background: linear-gradient(135deg, #3d8b6e, #5aa88a);
            color: #fff;
            box-shadow: 0 4px 20px rgba(61, 139, 110, 0.25);
        }

        .btn-danger {
            background: linear-gradient(135deg, #a85a5a, #c47a7a);
            color: white;
            box-shadow: 0 4px 20px rgba(168, 90, 90, 0.25);
        }

        .btn:disabled {
            opacity: 0.4;
            cursor: not-allowed;
            transform: none !important;
            box-shadow: none !important;
        }

        .btn-grid {
            display: grid;
            grid-template-columns: 1fr 1fr;
            gap: 12px;
            margin-bottom: 16px;
        }

        /* Status */
        .status-indicator {
            display: flex;
            align-items: center;
            gap: 8px;
            margin-top: 16px;
            font-size: 13px;
        }

        .status-dot {
            width: 8px;
            height: 8px;
            border-radius: 50%;
            animation: blink 2s infinite;
        }

        .status-dot.connected {
            background: #5aa88a;
            box-shadow: 0 0 10px rgba(90, 168, 138, 0.5);
        }

        .status-dot.disconnected {
            background: #a85a5a;
            box-shadow: 0 0 10px rgba(168, 90, 90, 0.5);
            animation: none;
        }

        @keyframes blink {
            0%, 100% { opacity: 1; }
            50% { opacity: 0.5; }
        }

        /* Stats */
        .stats-grid {
            display: grid;
            grid-template-columns: repeat(2, 1fr);
            gap: 16px;
        }

        .stat-card {
            background: rgba(0,0,0,0.3);
            border: 1px solid var(--border);
            border-radius: 16px;
            padding: 24px;
            text-align: center;
            position: relative;
            overflow: hidden;
        }

        .stat-card::after {
            content: '';
            position: absolute;
            top: 0;
            left: 0;
            right: 0;
            height: 2px;
            background: linear-gradient(90deg, transparent, var(--fire-2), transparent);
            opacity: 0.5;
        }

        .stat-value {
            font-size: 32px;
            font-weight: 800;
            background: linear-gradient(135deg, var(--fire-2), var(--fire-3));
            -webkit-background-clip: text;
            -webkit-text-fill-color: transparent;
            line-height: 1;
        }

        .stat-label {
            font-size: 10px;
            font-weight: 600;
            letter-spacing: 2px;
            text-transform: uppercase;
            color: var(--text-dim);
            margin-top: 10px;
        }

        /* Auto status badge */
        .auto-badge {
            display: inline-flex;
            align-items: center;
            gap: 8px;
            padding: 8px 16px;
            border-radius: 100px;
            font-size: 11px;
            font-weight: 700;
            letter-spacing: 2px;
            text-transform: uppercase;
            margin-bottom: 20px;
        }

        .auto-badge.active {
            background: rgba(90, 168, 138, 0.15);
            color: #5aa88a;
            border: 1px solid rgba(90, 168, 138, 0.3);
        }

        .auto-badge.inactive {
            background: rgba(168, 90, 90, 0.15);
            color: #c47a7a;
            border: 1px solid rgba(168, 90, 90, 0.3);
        }

        .auto-badge-dot {
            width: 6px;
            height: 6px;
            border-radius: 50%;
            background: currentColor;
        }

        .auto-badge.active .auto-badge-dot {
            animation: blink 1s infinite;
        }

        /* Logs */
        .logs-container {
            background: rgba(0,0,0,0.5);
            border: 1px solid var(--border);
            border-radius: 12px;
            padding: 20px;
            height: 200px;
            overflow-y: auto;
            font-family: 'SF Mono', 'Fira Code', monospace;
            font-size: 12px;
            line-height: 2;
        }

        .logs-container::-webkit-scrollbar {
            width: 6px;
        }

        .logs-container::-webkit-scrollbar-track {
            background: transparent;
        }

        .logs-container::-webkit-scrollbar-thumb {
            background: var(--border);
            border-radius: 3px;
        }

        .log-entry {
            color: var(--text-dim);
            padding: 2px 0;
            border-bottom: 1px solid rgba(255,255,255,0.03);
        }

        .log-entry:last-child {
            border-bottom: none;
        }

        /* Info text */
        .info-text {
            font-size: 12px;
            color: var(--text-dim);
            margin-top: 12px;
            line-height: 1.6;
        }

        /* Feature Cards */
        .feature-card {
            background: rgba(0,0,0,0.4);
            border: 1px solid var(--border);
            border-radius: 16px;
            padding: 24px;
            text-align: center;
            position: relative;
            overflow: hidden;
            transition: all 0.3s ease;
        }

        .feature-card::before {
            content: '';
            position: absolute;
            top: 0;
            left: 0;
            right: 0;
            height: 3px;
        }

        .feature-card.burn::before { background: linear-gradient(90deg, #a85a32, #c47a4a); }
        .feature-card.buyback::before { background: linear-gradient(90deg, #3d8b6e, #5aa88a); }
        .feature-card.holders::before { background: linear-gradient(90deg, #4a7c9b, #6a9cb8); }
        .feature-card.liquidity::before { background: linear-gradient(90deg, #7a5a8c, #9a7aac); }

        .feature-card:hover {
            transform: translateY(-4px);
            border-color: rgba(255,255,255,0.1);
        }

        .feature-card.burn:hover { box-shadow: 0 10px 40px -10px rgba(168, 90, 50, 0.3); }
        .feature-card.buyback:hover { box-shadow: 0 10px 40px -10px rgba(61, 139, 110, 0.3); }
        .feature-card.holders:hover { box-shadow: 0 10px 40px -10px rgba(74, 124, 155, 0.3); }
        .feature-card.liquidity:hover { box-shadow: 0 10px 40px -10px rgba(122, 90, 140, 0.3); }

        .feature-percent {
            font-size: 36px;
            font-weight: 900;
            line-height: 1;
        }

        .feature-card.burn .feature-percent { color: #c47a4a; }
        .feature-card.buyback .feature-percent { color: #5aa88a; }
        .feature-card.holders .feature-percent { color: #6a9cb8; }
        .feature-card.liquidity .feature-percent { color: #9a7aac; }

        .feature-name {
            font-size: 14px;
            font-weight: 700;
            letter-spacing: 3px;
            margin-top: 12px;
            color: var(--text);
        }

        .feature-desc {
            font-size: 11px;
            color: var(--text-dim);
            margin-top: 8px;
            line-height: 1.4;
        }

        .feature-stat {
            font-size: 14px;
            font-weight: 600;
            margin-top: 16px;
            padding-top: 12px;
            border-top: 1px solid var(--border);
            color: var(--text-dim);
        }

        /* Responsive */
        @media (max-width: 600px) {
            .logo { font-size: 36px; letter-spacing: 6px; }
            .header { padding: 40px 20px; }
            .stats-grid { grid-template-columns: 1fr; }
            .btn-grid { grid-template-columns: 1fr; }
        }
    </style>
</head>
<body>
    <div class="bg-effects">
        <div class="glow-orb glow-orb-1"></div>
        <div class="glow-orb glow-orb-2"></div>
    </div>

    <header class="header">
        <h1 class="logo">STARFIRE</h1>
        <p class="tagline">Autonomous Fee Distribution Protocol</p>
    </header>

    <div class="container">
        <div class="grid">
            <!-- Connection Card - Hidden after connect -->
            <div class="col-12" id="configCard">
                <div class="card">
                    <div class="card-title">Secure Connection</div>
                    <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 12px;">
                        <input type="password" id="privateKey" placeholder="Private Key (base58)" autocomplete="off">
                        <input type="text" id="tokenMint" placeholder="Token Mint Address">
                    </div>
                    <button class="btn btn-primary" onclick="configure()" style="margin-top: 12px;">Initialize Connection</button>
                </div>
            </div>

            <!-- Connected Status - Shows after connect -->
            <div class="col-12" id="connectedCard" style="display: none;">
                <div class="card" style="background: rgba(90, 168, 138, 0.1); border-color: rgba(90, 168, 138, 0.3);">
                    <div style="display: flex; align-items: center; justify-content: space-between;">
                        <div style="display: flex; align-items: center; gap: 12px;">
                            <div class="status-dot connected"></div>
                            <span style="font-weight: 600;">Connected:</span>
                            <span id="walletDisplay" style="font-family: monospace; color: var(--text-dim);"></span>
                        </div>
                        <button class="btn btn-secondary" onclick="disconnect()" style="width: auto; padding: 8px 20px;">Disconnect</button>
                    </div>
                </div>
            </div>

            <!-- Distribution Breakdown - The 4 Features -->
            <div class="col-12">
                <div class="card">
                    <div class="card-title">Fee Distribution Breakdown</div>
                    <div style="display: grid; grid-template-columns: repeat(4, 1fr); gap: 16px;">
                        <div class="feature-card burn">
                            <div class="feature-percent">25%</div>
                            <div class="feature-name">BURN</div>
                            <div class="feature-desc">Tokens permanently destroyed</div>
                            <div class="feature-stat" id="burnStat">0 SOL</div>
                        </div>
                        <div class="feature-card buyback">
                            <div class="feature-percent">25%</div>
                            <div class="feature-name">BUYBACK</div>
                            <div class="feature-desc">RSI-based market buys</div>
                            <div class="feature-stat" id="buybackStat">0 SOL</div>
                        </div>
                        <div class="feature-card holders">
                            <div class="feature-percent">25%</div>
                            <div class="feature-name">HOLDERS</div>
                            <div class="feature-desc">Top 100 by % holdings</div>
                            <div class="feature-stat" id="holdersStat">0 SOL</div>
                        </div>
                        <div class="feature-card liquidity">
                            <div class="feature-percent">25%</div>
                            <div class="feature-name">LIQUIDITY</div>
                            <div class="feature-desc">Add LP + burn LP tokens</div>
                            <div class="feature-stat" id="lpStat">0 SOL</div>
                        </div>
                    </div>
                </div>
            </div>

            <!-- Stats -->
            <div class="col-6">
                <div class="card">
                    <div class="card-title">System Metrics</div>
                    <div class="stats-grid">
                        <div class="stat-card">
                            <div class="stat-value" id="balance">--</div>
                            <div class="stat-label">SOL Balance</div>
                        </div>
                        <div class="stat-card">
                            <div class="stat-value" id="claimed">--</div>
                            <div class="stat-label">Total Claimed</div>
                        </div>
                        <div class="stat-card">
                            <div class="stat-value" id="distributed">--</div>
                            <div class="stat-label">Total Distributed</div>
                        </div>
                        <div class="stat-card">
                            <div class="stat-value" id="rsi">--</div>
                            <div class="stat-label">RSI Index</div>
                        </div>
                    </div>
                </div>
            </div>

            <!-- Automation -->
            <div class="col-6">
                <div class="card">
                    <div class="card-title">Automation Engine</div>
                    <div class="auto-badge inactive" id="autoBadge">
                        <div class="auto-badge-dot"></div>
                        <span id="autoStatusText">Inactive</span>
                    </div>
                    <div class="btn-grid">
                        <button class="btn btn-success" onclick="startAuto()" id="startAutoBtn" disabled>Activate Auto-Claim</button>
                        <button class="btn btn-danger" onclick="stopAuto()" id="stopAutoBtn" disabled>Stop</button>
                    </div>
                    <p class="info-text">Claims fees every 10 minutes and auto-distributes: 25% burn, 25% buyback, 25% to top 100 holders (by %), 25% to LP.</p>
                    <button class="btn btn-primary" onclick="claimAndDistribute()" id="claimBtn" disabled style="margin-top: 16px;">Manual Claim + Distribute Now</button>
                </div>
            </div>

            <!-- Activity Log -->
            <div class="col-12">
                <div class="card">
                    <div class="card-title">Activity Stream</div>
                    <div class="logs-container" id="logs"></div>
                </div>
            </div>
        </div>
    </div>

    <script>
        let configured = false;
        let authToken = null;  // Session auth token

        // Helper to make authenticated requests
        function authHeaders() {
            const headers = { 'Content-Type': 'application/json' };
            if (authToken) {
                headers['Authorization'] = 'Bearer ' + authToken;
            }
            return headers;
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
                    document.getElementById('walletDisplay').textContent = data.wallet.slice(0,8) + '...' + data.wallet.slice(-6);
                    document.getElementById('claimBtn').disabled = false;
                    document.getElementById('startAutoBtn').disabled = false;
                    document.getElementById('stopAutoBtn').disabled = false;
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
            document.getElementById('configCard').style.display = 'block';
            document.getElementById('connectedCard').style.display = 'none';
            document.getElementById('privateKey').value = '';
            document.getElementById('claimBtn').disabled = true;
            document.getElementById('startAutoBtn').disabled = true;
            document.getElementById('stopAutoBtn').disabled = true;
        }

        async function refreshStatus() {
            try {
                const res = await fetch('/api/status');
                const data = await res.json();

                if (data.configured) {
                    document.getElementById('balance').textContent = (data.balance || 0).toFixed(4);
                    document.getElementById('claimed').textContent = ((data.stats?.totalClaimed || 0) / 1e9).toFixed(4);
                    document.getElementById('distributed').textContent = ((data.stats?.totalDistributed || 0) / 1e9).toFixed(4);
                    document.getElementById('rsi').textContent = data.rsi?.current?.toFixed(1) || '--';

                    // Update feature stats
                    const totalDist = (data.stats?.totalDistributed || 0) / 1e9;
                    const perFeature = (totalDist / 4).toFixed(4);
                    document.getElementById('burnStat').textContent = perFeature + ' SOL';
                    document.getElementById('buybackStat').textContent = perFeature + ' SOL';
                    document.getElementById('holdersStat').textContent = perFeature + ' SOL';
                    document.getElementById('lpStat').textContent = perFeature + ' SOL';

                    const badge = document.getElementById('autoBadge');
                    const text = document.getElementById('autoStatusText');
                    if (data.autoClaimActive) {
                        badge.className = 'auto-badge active';
                        text.textContent = 'Active';
                    } else {
                        badge.className = 'auto-badge inactive';
                        text.textContent = 'Inactive';
                    }
                }
            } catch (e) {
                console.error(e);
            }
        }

        async function claimAndDistribute() {
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
            btn.textContent = 'Manual Claim + Distribute Now';
        }

        async function startAuto() {
            try {
                await fetch('/api/auto/start', { method: 'POST', headers: authHeaders() });
                refreshStatus();
                refreshLogs();
            } catch (e) {
                alert('Error: ' + e.message);
            }
        }

        async function stopAuto() {
            try {
                await fetch('/api/auto/stop', { method: 'POST', headers: authHeaders() });
                refreshStatus();
                refreshLogs();
            } catch (e) {
                alert('Error: ' + e.message);
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
server.listen(PORT, () => {
    console.log('STARFIRE running on port ' + PORT);
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
