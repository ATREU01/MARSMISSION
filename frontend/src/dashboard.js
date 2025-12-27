// ═══════════════════════════════════════════════════════════════════════
// PRIVY SDK IMPORT - Properly bundled by Vite
// ═══════════════════════════════════════════════════════════════════════
import Privy from '@privy-io/js-sdk-core';

// Make Privy available for initialization
window.PrivySDK = Privy;

// ═══════════════════════════════════════════════════════════════════════
// FORMATTING HELPER FUNCTIONS (ALICE-style)
// ═══════════════════════════════════════════════════════════════════════

// Format numbers as $XXK, $XXM, $XXB
function formatNum(n) {
    if (!n || isNaN(n)) return '$0';
    n = parseFloat(n);
    if (n >= 1e9) return `$${(n/1e9).toFixed(2)}B`;
    if (n >= 1e6) return `$${(n/1e6).toFixed(2)}M`;
    if (n >= 1e3) return `$${(n/1e3).toFixed(2)}K`;
    return `$${n.toFixed(2)}`;
}

// Format prices with appropriate decimals for micro prices
function formatPrice(p) {
    if (!p || isNaN(p)) return '$0.00';
    p = parseFloat(p);
    if (p === 0) return '$0.00';
    if (p >= 1) return `$${p.toFixed(2)}`;
    if (p >= 0.01) return `$${p.toFixed(4)}`;
    if (p >= 0.0001) return `$${p.toFixed(6)}`;
    // Very small prices - use exponential notation
    const exp = Math.floor(Math.log10(p));
    const mantissa = p / Math.pow(10, exp);
    return `$${mantissa.toFixed(2)}e${exp}`;
}

// Format percentages with +/- signs
function formatPct(n, decimals = 2) {
    if (n === null || n === undefined || isNaN(n)) return '0%';
    n = parseFloat(n);
    const sign = n >= 0 ? '+' : '';
    return `${sign}${n.toFixed(decimals)}%`;
}

// Get CSS class based on value sign
function getPctClass(n) {
    if (!n || isNaN(n)) return '';
    return parseFloat(n) >= 0 ? 'positive' : 'negative';
}

// Get badge class based on threshold
function getBadgeClass(value, goodThreshold, warnThreshold) {
    if (value >= goodThreshold) return 'good';
    if (value >= warnThreshold) return 'warn';
    return 'bad';
}

// Get safety icon class
function getSafetyClass(isPassing) {
    return isPassing ? 'pass' : 'fail';
}

// ═══════════════════════════════════════════════════════════════════════
// FEE ALLOCATION FUNCTIONS (INPUT-BASED)
// ═══════════════════════════════════════════════════════════════════════

// Clamp input values to 0-100
function clampValue(input) {
    let val = parseInt(input.value) || 0;
    if (val < 0) val = 0;
    if (val > 100) val = 100;
    input.value = val;
    updateTotal();
}

// Get allocations from inputs
function getAllocations() {
    return {
        marketMaking: parseInt(document.getElementById('input-marketMaking')?.value) || 0,
        buybackBurn: parseInt(document.getElementById('input-buybackBurn')?.value) || 0,
        liquidity: parseInt(document.getElementById('input-liquidity')?.value) || 0,
        creatorRevenue: parseInt(document.getElementById('input-creatorRevenue')?.value) || 0
    };
}

// Update total display and save button state
function updateTotal() {
    const alloc = getAllocations();
    const total = alloc.marketMaking + alloc.buybackBurn + alloc.liquidity + alloc.creatorRevenue;
    const display = document.getElementById('totalAllocation');
    const saveBtn = document.getElementById('saveAllocBtn');

    if (!display) return;

    display.textContent = total + '%';

    if (total === 100) {
        display.style.color = 'var(--gold)';
        if (saveBtn) {
            saveBtn.disabled = false;
            saveBtn.textContent = 'Save Allocations';
        }
    } else if (total > 100) {
        display.style.color = 'var(--error)';
        display.style.animation = 'pulse 1s ease-in-out infinite';
        if (saveBtn) {
            saveBtn.disabled = true;
            saveBtn.textContent = 'Over by ' + (total - 100) + '%';
        }
    } else {
        display.style.color = 'var(--warning)';
        display.style.animation = 'pulse 1s ease-in-out infinite';
        if (saveBtn) {
            saveBtn.disabled = true;
            saveBtn.textContent = 'Under by ' + (100 - total) + '%';
        }
    }
}

// Save allocations to server
async function saveAllocations() {
    const allocations = getAllocations();
    const total = allocations.marketMaking + allocations.buybackBurn + allocations.liquidity + allocations.creatorRevenue;
    if (total !== 100) {
        showNotification('Allocations must sum to 100%', 'error');
        return;
    }

    try {
        const res = await fetch('/api/allocations', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(allocations)
        });
        const data = await res.json();
        if (data.success) {
            showNotification('Allocations saved!', 'success');
        } else {
            showNotification('Error: ' + data.error, 'error');
        }
    } catch (e) {
        showNotification('Error: ' + e.message, 'error');
    }
}

// Smart Optimizer - AI analysis
async function runMaximus() {
    const btn = document.getElementById('maximusBtn');
    const resultDiv = document.getElementById('maximusResult');

    if (!btn) return;

    btn.disabled = true;
    btn.textContent = 'ANALYZING...';
    if (resultDiv) resultDiv.style.display = 'none';

    try {
        const res = await fetch('/api/ai/optimize', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                rsi: null,
                balance: walletBalance || 0,
                currentAllocations: getAllocations()
            })
        });

        const data = await res.json();
        if (data.success && data.allocations) {
            // Apply the optimized allocations to inputs
            const mmInput = document.getElementById('input-marketMaking');
            const bbInput = document.getElementById('input-buybackBurn');
            const liqInput = document.getElementById('input-liquidity');
            const crInput = document.getElementById('input-creatorRevenue');

            if (mmInput) mmInput.value = data.allocations.marketMaking || 0;
            if (bbInput) bbInput.value = data.allocations.buybackBurn || 0;
            if (liqInput) liqInput.value = data.allocations.liquidity || 0;
            if (crInput) crInput.value = data.allocations.creatorRevenue || 0;

            updateTotal();

            // Auto-save
            await saveAllocations();

            if (resultDiv) {
                resultDiv.innerHTML = '✅ ' + (data.allocations.reasoning || 'Allocations optimized!');
                resultDiv.style.display = 'block';
                resultDiv.style.color = 'var(--success)';
            }
        } else {
            throw new Error(data.error || 'Optimization failed');
        }
    } catch (e) {
        if (resultDiv) {
            resultDiv.innerHTML = '❌ ' + e.message;
            resultDiv.style.display = 'block';
            resultDiv.style.color = 'var(--error)';
        }
    }

    btn.disabled = false;
    btn.textContent = 'RUN ANALYSIS';
}

// ═══════════════════════════════════════════════════════════════════════
// CONFIGURATION
// ═══════════════════════════════════════════════════════════════════════
const SOLANA_RPC = window.LAUNCHR_CONFIG?.SOLANA_RPC || 'https://api.mainnet-beta.solana.com';
const PRIVY_APP_ID = window.LAUNCHR_CONFIG?.PRIVY_APP_ID || '';
const FEE_WALLET = window.LAUNCHR_CONFIG?.FEE_WALLET || '';

let privyClient = null;
let privyIframe = null;
let privyUser = null;
let connectedWallet = null;
let walletBalance = 0;
let selectedLaunchPath = 'pumpfun';

// ═══════════════════════════════════════════════════════════════════════
// INITIALIZATION
// ═══════════════════════════════════════════════════════════════════════
document.addEventListener('DOMContentLoaded', async () => {
    await initPrivy();
    const stored = localStorage.getItem('connectedWallet');
    if (stored) handleWalletConnected(stored);

    // Fetch initial stats
    fetchDashboardStats();

    // Initialize allocation total on page load
    updateTotal();

    // Auto-refresh stats every 30 seconds
    setInterval(fetchDashboardStats, 30000);
});

// ═══════════════════════════════════════════════════════════════════════
// DATA FETCHING
// ═══════════════════════════════════════════════════════════════════════
async function fetchDashboardStats() {
    try {
        const res = await fetch('/api/tracker/stats');
        const data = await res.json();

        // Update holder pool
        const holderPool = (data.totalDistributed || 0) * 0.01;
        document.getElementById('holderPoolAmount').textContent = holderPool.toFixed(2) + ' SOL';
        document.getElementById('totalCollected').textContent = (data.totalClaimed || 0).toFixed(2) + ' SOL';
        document.getElementById('totalDistributed').textContent = (data.totalDistributed || 0).toFixed(2) + ' SOL';
        document.getElementById('holderCount').textContent = data.totalTokens || 0;

        // Update stats
        document.getElementById('statClaimed').textContent = (data.totalClaimed || 0).toFixed(2);
        document.getElementById('statHolderPool').textContent = holderPool.toFixed(2);
        document.getElementById('statDistributed').textContent = ((data.totalDistributed || 0) * 0.99).toFixed(2);
    } catch (e) {
        console.error('[STATS] Failed to fetch:', e);
    }
}

// ═══════════════════════════════════════════════════════════════════════
// WALLET FUNCTIONS
// ═══════════════════════════════════════════════════════════════════════
async function initPrivy() {
    if (!PRIVY_APP_ID) {
        console.log('[PRIVY] App ID not configured - Privy disabled');
        return;
    }

    try {
        // Use the bundled Privy SDK (imported at top of file via Vite)
        const PrivyClass = window.PrivySDK;

        if (!PrivyClass) {
            console.error('[PRIVY] SDK not loaded - check Vite build');
            return;
        }

        // Custom storage adapter using localStorage
        const storage = {
            get: (key) => localStorage.getItem(key),
            put: (key, value) => localStorage.setItem(key, value),
            del: (key) => localStorage.removeItem(key),
            getKeys: () => Object.keys(localStorage),
        };

        // Initialize Privy client
        console.log('[PRIVY] Initializing with appId:', PRIVY_APP_ID.substring(0, 8) + '...');
        privyClient = new PrivyClass({
            appId: PRIVY_APP_ID,
            storage: storage
        });

        // IMPORTANT: Call initialize() to complete SDK setup
        await privyClient.initialize();
        console.log('[PRIVY] SDK initialized');

        // Check if embeddedWallet is available
        if (privyClient.embeddedWallet && typeof privyClient.embeddedWallet.getURL === 'function') {
            // Set up iframe for embedded wallet secure context
            const iframeUrl = privyClient.embeddedWallet.getURL();
            privyIframe = document.createElement('iframe');
            privyIframe.src = iframeUrl;
            privyIframe.style.cssText = 'display:none;position:absolute;width:0;height:0;border:none;';
            privyIframe.id = 'privy-iframe';
            document.body.appendChild(privyIframe);

            // Wait for iframe to load before setting up message poster
            privyIframe.onload = () => {
                if (privyClient.setMessagePoster) {
                    privyClient.setMessagePoster(privyIframe.contentWindow);
                }
                console.log('[PRIVY] Iframe loaded and message poster set');
            };

            // Set up message listener for iframe communication
            window.addEventListener('message', (e) => {
                if (privyIframe && e.source === privyIframe.contentWindow) {
                    if (privyClient.embeddedWallet?.onMessage) {
                        privyClient.embeddedWallet.onMessage(e.data);
                    }
                }
            });
        } else {
            console.log('[PRIVY] Embedded wallet not available, using standard auth');
        }

        console.log('[PRIVY] Initialized successfully');
    } catch (e) {
        console.error('[PRIVY] Init error:', e.message, e);
    }
}

async function connectWallet() {
    if (connectedWallet) { showWalletModal(); return; }
    showWalletSelectModal();
}

function showWalletSelectModal() {
    const hasPhantom = window.solana?.isPhantom;
    const hasSolflare = window.solflare?.isSolflare;
    const hasPrivy = !!PRIVY_APP_ID;

    const modal = document.createElement('div');
    modal.className = 'modal-overlay';
    modal.id = 'walletSelectModal';
    modal.onclick = (e) => { if(e.target === modal) modal.remove(); };
    modal.innerHTML = `
        <div class="modal" style="max-width:380px;">
            <div class="modal-header">
                <span class="modal-title">Connect Wallet</span>
                <button class="modal-close" onclick="document.getElementById('walletSelectModal').remove()">&times;</button>
            </div>
            <div class="modal-body" style="padding:20px;">
                <p style="color:var(--text-secondary);font-size:13px;margin-bottom:16px;text-align:center;">
                    Choose your preferred wallet to connect
                </p>
                <div style="display:flex;flex-direction:column;gap:10px;">
                    <button class="wallet-option privy-option" onclick="connectPrivy()">
                        <svg width="28" height="28" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
                            <rect width="24" height="24" rx="6" fill="#8B5CF6"/>
                            <path d="M12 6L18 10V14L12 18L6 14V10L12 6Z" fill="white"/>
                        </svg>
                        <span>Privy</span>
                        <span class="wallet-detected">Email Wallet</span>
                    </button>
                    <button class="wallet-option ${hasPhantom ? '' : 'disabled'}" onclick="${hasPhantom ? 'connectPhantom()' : ''}" ${hasPhantom ? '' : 'disabled'}>
                        <img src="/website/phantom_icon.png" alt="Phantom" style="width:28px;height:28px;border-radius:6px;">
                        <span>Phantom</span>
                        ${hasPhantom ? '<span class="wallet-detected">Detected</span>' : '<span class="wallet-not-detected">Not installed</span>'}
                    </button>
                    <button class="wallet-option ${hasSolflare ? '' : 'disabled'}" onclick="${hasSolflare ? 'connectSolflare()' : ''}" ${hasSolflare ? '' : 'disabled'}>
                        <img src="https://solflare.com/favicon.ico" alt="Solflare" style="width:28px;height:28px;border-radius:6px;">
                        <span>Solflare</span>
                        ${hasSolflare ? '<span class="wallet-detected">Detected</span>' : '<span class="wallet-not-detected">Not installed</span>'}
                    </button>
                </div>
            </div>
        </div>
    `;
    document.body.appendChild(modal);

    if (!document.getElementById('wallet-select-styles')) {
        const style = document.createElement('style');
        style.id = 'wallet-select-styles';
        style.textContent = `
            .wallet-option { display:flex;align-items:center;gap:12px;padding:14px 16px;background:var(--bg);border:1px solid var(--border);border-radius:var(--radius);cursor:pointer;transition:all 0.15s;font-size:15px;font-weight:500;color:var(--text); }
            .wallet-option:hover:not(.disabled) { border-color:var(--gold);background:var(--gold-dim); }
            .wallet-option.disabled { opacity:0.5;cursor:not-allowed; }
            .wallet-option span:first-of-type { flex:1;text-align:left; }
            .wallet-detected { font-size:11px;color:var(--success);background:var(--success-dim);padding:3px 8px;border-radius:10px; }
            .wallet-not-detected { font-size:11px;color:var(--text-muted); }
            .wallet-option.privy-option { border-color:rgba(139,92,246,0.3);background:rgba(139,92,246,0.1); }
            .wallet-option.privy-option:hover { border-color:#8B5CF6;background:rgba(139,92,246,0.2); }
        `;
        document.head.appendChild(style);
    }
}

async function connectPhantom() {
    document.getElementById('walletSelectModal')?.remove();
    try {
        const res = await window.solana.connect();
        handleWalletConnected(res.publicKey.toString());
    } catch (e) {
        console.error('[PHANTOM]', e);
        showNotification('Failed to connect Phantom', 'error');
    }
}

async function connectSolflare() {
    document.getElementById('walletSelectModal')?.remove();
    try {
        await window.solflare.connect();
        handleWalletConnected(window.solflare.publicKey.toString());
    } catch (e) {
        console.error('[SOLFLARE]', e);
        showNotification('Failed to connect Solflare', 'error');
    }
}

async function connectPrivy() {
    document.getElementById('walletSelectModal')?.remove();

    if (!privyClient) {
        showNotification('Privy not initialized. Please check browser console for details.', 'error');
        return;
    }

    try {
        // Show loading modal
        const loadingModal = document.createElement('div');
        loadingModal.id = 'privyLoadingModal';
        loadingModal.className = 'modal-overlay';
        loadingModal.innerHTML = `
            <div class="modal" style="max-width:360px;text-align:center;padding:40px;">
                <div style="font-size:24px;margin-bottom:16px;">🔐</div>
                <h3 style="margin-bottom:12px;">Connecting to Privy</h3>
                <p style="color:var(--text-secondary);font-size:14px;">Please enter your email to login or create a wallet...</p>
            </div>
        `;
        document.body.appendChild(loadingModal);

        // Prompt for email
        const email = prompt('Enter your email address to login or create a Privy wallet:');
        loadingModal.remove();

        if (!email) {
            showNotification('Login cancelled', 'info');
            return;
        }

        // Send OTP code to email
        showNotification('Sending verification code to ' + email + '...', 'info');
        await privyClient.auth.email.sendCode(email);

        // Prompt for OTP
        const otp = prompt('Enter the 6-digit code sent to ' + email + ':');
        if (!otp) {
            showNotification('Verification cancelled', 'info');
            return;
        }

        // Verify OTP and login
        showNotification('Verifying code...', 'info');
        const session = await privyClient.auth.email.loginWithCode(email, otp);

        if (session?.user) {
            privyUser = session.user;

            // Check for existing Solana wallet
            let solanaWallet = session.user.linkedAccounts?.find(
                a => a.type === 'wallet' && a.chainType === 'solana'
            );

            // If no Solana wallet, create one
            if (!solanaWallet) {
                showNotification('Creating Solana wallet...', 'info');
                const { user: updatedUser } = await privyClient.embeddedWallet.createSolana();
                privyUser = updatedUser;
                solanaWallet = updatedUser.linkedAccounts?.find(
                    a => a.type === 'wallet' && a.chainType === 'solana'
                );
            }

            if (solanaWallet?.address) {
                handleWalletConnected(solanaWallet.address);
                showNotification('Connected with Privy wallet!', 'success');
            } else {
                showNotification('Failed to get wallet address', 'error');
            }
        } else {
            showNotification('Login failed', 'error');
        }
    } catch (e) {
        console.error('[PRIVY]', e);
        showNotification('Privy error: ' + e.message, 'error');
    }
}

async function handleWalletConnected(address) {
    connectedWallet = address;
    const btn = document.getElementById('connectBtn');
    btn.textContent = address.slice(0, 4) + '...' + address.slice(-4);
    btn.classList.add('wallet-connected');
    await fetchBalance(address);
    localStorage.setItem('connectedWallet', address);
    updateLaunchButton();
    document.getElementById('tokenSelector').style.display = 'flex';
    document.getElementById('myLaunchesCard').style.display = 'block';
    // Fetch user's launched tokens
    await fetchMyTokens();
}

async function fetchBalance(address) {
    try {
        const res = await fetch(SOLANA_RPC, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getBalance', params: [address] }),
        });
        const data = await res.json();
        if (data.result?.value !== undefined) {
            walletBalance = data.result.value / 1e9;
            document.getElementById('walletBalance').textContent = walletBalance.toFixed(4);
        }
    } catch (e) { console.error('[BALANCE]', e); }
}

async function disconnectWallet() {
    if (privyClient) try { await privyClient.logout(); } catch (e) {}
    if (window.solana?.isPhantom) try { await window.solana.disconnect(); } catch (e) {}
    if (window.solflare?.isSolflare) try { await window.solflare.disconnect(); } catch (e) {}
    connectedWallet = null;
    walletBalance = 0;
    localStorage.removeItem('connectedWallet');
    document.getElementById('connectBtn').textContent = 'Connect Wallet';
    document.getElementById('connectBtn').classList.remove('wallet-connected');
    document.getElementById('tokenSelector').style.display = 'none';
    document.getElementById('myLaunchesCard').style.display = 'none';
    closeWalletModal();
    updateLaunchButton();
}

function showWalletModal() {
    if (!connectedWallet) return;
    document.getElementById('walletAddress').textContent = connectedWallet;
    document.getElementById('walletBalance').textContent = walletBalance.toFixed(4);
    document.getElementById('walletModal').style.display = 'flex';
}

function closeWalletModal() {
    document.getElementById('walletModal').style.display = 'none';
}

function copyWalletAddress() {
    navigator.clipboard.writeText(connectedWallet);
}

// ═══════════════════════════════════════════════════════════════════════
// LAUNCH MODAL
// ═══════════════════════════════════════════════════════════════════════
function showLaunchModal() {
    document.getElementById('launchModal').style.display = 'flex';
    updateLaunchButton();
}

function closeLaunchModal() {
    document.getElementById('launchModal').style.display = 'none';
}

function selectPath(path) {
    selectedLaunchPath = path;
    document.querySelectorAll('.path-option').forEach(opt => {
        opt.classList.remove('active', 'purple');
        if (opt.dataset.path === path) {
            opt.classList.add('active');
            if (path === 'pumpfun') opt.classList.add('purple');
        }
    });
}

function updateLaunchButton() {
    const btn = document.getElementById('launchTokenBtn');
    btn.textContent = connectedWallet ? 'Deploy Token' : 'Connect Wallet to Launch';
}

// ═══════════════════════════════════════════════════════════════════════
// TOKEN DEPLOYMENT - REAL PUMPPORTAL INTEGRATION
// ═══════════════════════════════════════════════════════════════════════

// Upload token metadata to Pump.fun IPFS
async function uploadTokenMetadata(name, symbol, description, imageFile, socials = {}) {
    const formData = new FormData();

    if (imageFile) {
        formData.append('file', imageFile);
    } else {
        throw new Error('Token icon is required');
    }

    formData.append('name', name);
    formData.append('symbol', symbol);
    formData.append('description', description || `${name} ($${symbol}) - Launched via LAUNCHR`);
    formData.append('twitter', socials.twitter || '');
    formData.append('telegram', socials.telegram || '');
    formData.append('website', socials.website || '');
    formData.append('showName', 'true');

    console.log('[DEPLOY] Uploading metadata to IPFS...');

    const response = await fetch('/api/ipfs-upload', {
        method: 'POST',
        body: formData,
    });

    if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`IPFS upload failed: ${response.status} - ${errorText}`);
    }

    const data = await response.json();
    console.log('[DEPLOY] IPFS upload successful:', data);

    return {
        metadataUri: data.metadataUri,
        metadata: data.metadata || { name, symbol, description }
    };
}

// Generate a new mint keypair for the token (tries vanity pool first)
async function generateMintKeypair() {
    const { Keypair } = solanaWeb3;

    // Try to get a vanity keypair from the server pool (ends in "launchr")
    try {
        const res = await fetch('/api/vanity-keypair');
        if (res.ok) {
            const data = await res.json();
            if (data.success && data.secretKey) {
                const secretKey = bs58.decode(data.secretKey);
                const mintKeypair = Keypair.fromSecretKey(secretKey);
                console.log('[DEPLOY] Got vanity mint address:', mintKeypair.publicKey.toString());
                return mintKeypair;
            }
        }
    } catch (e) {
        console.log('[DEPLOY] Vanity pool unavailable, using random keypair');
    }

    // Fallback to random keypair
    const mintKeypair = Keypair.generate();
    console.log('[DEPLOY] Generated random mint address:', mintKeypair.publicKey.toString());
    return mintKeypair;
}

async function createTokenViaPumpPortal(walletAddress, mintKeypair, tokenMetadata, initialBuySOL = 0) {
    const { VersionedTransaction, Connection } = solanaWeb3;
    const connection = new Connection(SOLANA_RPC, 'confirmed');

    const requestBody = {
        publicKey: walletAddress,
        action: 'create',
        tokenMetadata: {
            name: tokenMetadata.metadata.name,
            symbol: tokenMetadata.metadata.symbol,
            uri: tokenMetadata.metadataUri
        },
        mint: mintKeypair.publicKey.toString(),
        denominatedInSol: 'true',
        amount: initialBuySOL,
        slippage: 10,
        priorityFee: 0.0005,
        pool: 'pump'
    };

    console.log('[DEPLOY] Creating token via PumpPortal:', requestBody);

    const response = await fetch('https://pumpportal.fun/api/trade-local', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(requestBody)
    });

    if (response.status !== 200) {
        const errorText = await response.text();
        throw new Error(`PumpPortal API error: ${response.status} - ${errorText}`);
    }

    const txBuffer = await response.arrayBuffer();
    console.log('[DEPLOY] Received transaction buffer, size:', txBuffer.byteLength);

    const tx = VersionedTransaction.deserialize(new Uint8Array(txBuffer));
    console.log('[DEPLOY] Transaction deserialized successfully');

    return { transaction: tx, connection, mintKeypair };
}

async function signAndSendTransaction(tx, connection, mintKeypair) {
    console.log('[DEPLOY] Signing transaction with mint keypair...');
    console.log('[DEPLOY] Mint pubkey:', mintKeypair.publicKey.toString());

    // CRITICAL: Sign with mint keypair FIRST (this authorizes the new token creation)
    tx.sign([mintKeypair]);
    console.log('[DEPLOY] Mint keypair signature added');

    let signature;

    // Now have the user's wallet sign (this authorizes the SOL payment)
    if (window.solana?.isPhantom) {
        console.log('[DEPLOY] Using Phantom wallet for signing...');
        try {
            const signedTx = await window.solana.signTransaction(tx);
            console.log('[DEPLOY] Phantom signed, sending transaction...');
            signature = await connection.sendRawTransaction(signedTx.serialize(), {
                skipPreflight: true,  // Skip preflight for faster execution
                preflightCommitment: 'confirmed',
                maxRetries: 3
            });
        } catch (walletError) {
            console.error('[DEPLOY] Phantom signing error:', walletError);
            throw new Error('Wallet signing failed: ' + walletError.message);
        }
    } else if (window.solflare?.isSolflare) {
        console.log('[DEPLOY] Using Solflare wallet for signing...');
        try {
            const signedTx = await window.solflare.signTransaction(tx);
            console.log('[DEPLOY] Solflare signed, sending transaction...');
            signature = await connection.sendRawTransaction(signedTx.serialize(), {
                skipPreflight: true,
                preflightCommitment: 'confirmed',
                maxRetries: 3
            });
        } catch (walletError) {
            console.error('[DEPLOY] Solflare signing error:', walletError);
            throw new Error('Wallet signing failed: ' + walletError.message);
        }
    } else if (privyClient) {
        console.log('[DEPLOY] Using Privy wallet for signing...');
        try {
            const user = await privyClient.getUser();
            if (user?.wallet) {
                const signedTx = await privyClient.signTransaction(tx);
                signature = await connection.sendRawTransaction(signedTx.serialize(), {
                    skipPreflight: true,
                    preflightCommitment: 'confirmed',
                    maxRetries: 3
                });
            } else {
                throw new Error('No Privy wallet connected');
            }
        } catch (walletError) {
            console.error('[DEPLOY] Privy signing error:', walletError);
            throw new Error('Wallet signing failed: ' + walletError.message);
        }
    } else {
        throw new Error('No compatible wallet found. Please connect Phantom, Solflare, or Privy.');
    }

    console.log('[DEPLOY] Transaction sent! Signature:', signature);
    console.log('[DEPLOY] View on Solscan: https://solscan.io/tx/' + signature);
    console.log('[DEPLOY] Waiting for confirmation...');

    try {
        const confirmation = await connection.confirmTransaction(signature, 'confirmed');
        if (confirmation.value.err) {
            console.error('[DEPLOY] Transaction error:', confirmation.value.err);
            throw new Error('Transaction failed: ' + JSON.stringify(confirmation.value.err));
        }
    } catch (confirmError) {
        // Even if confirmation times out, the TX might still succeed
        console.warn('[DEPLOY] Confirmation timeout, checking status...');
        const status = await connection.getSignatureStatus(signature);
        if (status.value?.err) {
            throw new Error('Transaction failed: ' + JSON.stringify(status.value.err));
        }
    }

    console.log('[DEPLOY] Transaction confirmed successfully!');
    return signature;
}

function showNotification(message, type = 'info') {
    const existing = document.querySelector('.notification-toast');
    if (existing) existing.remove();

    const toast = document.createElement('div');
    toast.className = 'notification-toast';
    toast.style.cssText = `
        position: fixed;
        top: 80px;
        right: 20px;
        padding: 16px 24px;
        background: ${type === 'error' ? 'var(--error)' : type === 'success' ? 'var(--success)' : 'var(--surface-3)'};
        color: ${type === 'error' || type === 'success' ? '#000' : 'var(--text)'};
        border-radius: var(--radius);
        font-size: 14px;
        font-weight: 500;
        z-index: 3000;
        box-shadow: 0 4px 20px rgba(0,0,0,0.3);
        animation: slideIn 0.3s ease;
    `;
    toast.textContent = message;
    document.body.appendChild(toast);

    if (!document.getElementById('notification-styles')) {
        const style = document.createElement('style');
        style.id = 'notification-styles';
        style.textContent = `
            @keyframes slideIn {
                from { transform: translateX(100%); opacity: 0; }
                to { transform: translateX(0); opacity: 1; }
            }
        `;
        document.head.appendChild(style);
    }

    setTimeout(() => toast.remove(), 5000);
}

function escapeHtml(str) {
    if (!str) return '';
    return String(str).replace(/[&<>"'`]/g, m => ({
        '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;','`':'&#96;'
    })[m] || m);
}

function showLaunchSuccess(name, symbol, mintAddress, signature) {
    const modal = document.createElement('div');
    modal.className = 'modal-overlay';
    modal.id = 'successModal';
    modal.onclick = (e) => { if(e.target === modal) modal.remove(); };
    modal.innerHTML = `
        <div class="modal" style="max-width:500px;">
            <div class="modal-header" style="background: linear-gradient(135deg, var(--success-dim), var(--surface));">
                <span class="modal-title" style="color: var(--success);">Token Launched!</span>
                <button class="modal-close" onclick="document.getElementById('successModal').remove()">&times;</button>
            </div>
            <div class="modal-body" style="text-align:center;">
                <h3 style="font-size:24px;margin-bottom:8px;">${escapeHtml(name)}</h3>
                <div style="color:var(--gold);font-size:18px;margin-bottom:20px;">$${escapeHtml(symbol)}</div>
                <div style="background:var(--bg);padding:16px;border-radius:var(--radius);margin-bottom:16px;">
                    <div style="font-size:11px;color:var(--text-muted);margin-bottom:6px;">MINT ADDRESS</div>
                    <div style="font-family:'JetBrains Mono',monospace;font-size:12px;word-break:break-all;color:var(--text);">${escapeHtml(mintAddress)}</div>
                </div>
                <div class="modal-actions" style="flex-direction:column;gap:10px;">
                    <a href="https://pump.fun/coin/${encodeURIComponent(mintAddress)}" target="_blank" rel="noopener noreferrer" class="btn btn-primary" style="width:100%;">View on Pump.fun</a>
                    <a href="https://solscan.io/tx/${encodeURIComponent(signature)}" target="_blank" rel="noopener noreferrer" class="btn btn-secondary" style="width:100%;">View Transaction</a>
                    <button class="btn btn-ghost" style="width:100%;" onclick="navigator.clipboard.writeText('${mintAddress}');this.textContent='Copied!';">Copy Mint Address</button>
                </div>
            </div>
        </div>
    `;
    document.body.appendChild(modal);
}

// Image preview helper
function previewImage(input, previewId) {
    const preview = document.getElementById(previewId);
    const uploadDiv = input.closest('.image-upload');

    if (input.files && input.files[0]) {
        const reader = new FileReader();
        reader.onload = function(e) {
            preview.innerHTML = `<img src="${e.target.result}" alt="Preview">`;
            uploadDiv.classList.add('has-image');
        };
        reader.readAsDataURL(input.files[0]);
    }
}

// Dev buy slider helpers
function updateDevBuyDisplayDash() {
    const slider = document.getElementById('devBuySliderDash');
    const input = document.getElementById('devBuyAmountDash');
    input.value = slider.value;
}

function syncDevBuySliderDash() {
    const slider = document.getElementById('devBuySliderDash');
    const input = document.getElementById('devBuyAmountDash');
    let val = parseFloat(input.value) || 0;
    if (val < 0) val = 0;
    if (val > 5) val = 5;
    input.value = val;
    slider.value = val;
}

async function launchToken() {
    if (!connectedWallet) {
        connectWallet();
        return;
    }

    const name = document.getElementById('tokenNameInput').value.trim();
    const symbol = document.getElementById('tokenSymbolInput').value.trim().toUpperCase();
    const description = document.getElementById('tokenDescInput').value.trim();

    // Get image file
    const imageInput = document.getElementById('tokenImageInput');
    const imageFile = imageInput.files && imageInput.files[0] ? imageInput.files[0] : null;

    // Get social links
    const socials = {
        twitter: document.getElementById('tokenTwitterInput').value.trim(),
        telegram: document.getElementById('tokenTelegramInput').value.trim(),
        website: document.getElementById('tokenWebsiteInput').value.trim(),
        discord: document.getElementById('tokenDiscordInput').value.trim()
    };

    // Get initial dev buy amount
    const devBuyAmount = parseFloat(document.getElementById('devBuyAmountDash').value) || 0;

    if (!name || !symbol) {
        showNotification('Please enter token name and symbol', 'error');
        return;
    }

    if (symbol.length > 10) {
        showNotification('Symbol must be 10 characters or less', 'error');
        return;
    }

    if (!imageFile) {
        showNotification('Please upload a token icon', 'error');
        return;
    }

    const btn = document.getElementById('launchTokenBtn');
    const originalText = btn.textContent;
    btn.disabled = true;
    btn.textContent = 'Uploading metadata...';
    btn.style.opacity = '0.7';

    try {
        const tokenMetadata = await uploadTokenMetadata(name, symbol, description, imageFile, socials);

        btn.textContent = 'Getting vanity address...';
        const mintKeypair = await generateMintKeypair();

        btn.textContent = 'Creating token...';
        const { transaction, connection } = await createTokenViaPumpPortal(
            connectedWallet,
            mintKeypair,
            tokenMetadata,
            devBuyAmount // Initial dev buy amount in SOL
        );

        btn.textContent = 'Waiting for signature...';

        const signature = await signAndSendTransaction(transaction, connection, mintKeypair);

        btn.textContent = 'Token launched!';

        const mintAddress = mintKeypair.publicKey.toString();
        console.log('[DEPLOY] Token created successfully!');
        console.log('[DEPLOY] Mint address:', mintAddress);
        console.log('[DEPLOY] Transaction:', signature);

        showNotification(`Token ${symbol} launched successfully!`, 'success');
        showLaunchSuccess(name, symbol, mintAddress, signature);
        closeLaunchModal();

        // Register the token in our tracker
        await registerTokenAfterLaunch(mintAddress, name, symbol, tokenMetadata.metadataUri, socials);

    } catch (error) {
        console.error('[DEPLOY] Error:', error);
        showNotification(error.message || 'Token launch failed', 'error');
    } finally {
        btn.disabled = false;
        btn.textContent = originalText;
        btn.style.opacity = '1';
    }
}

// ═══════════════════════════════════════════════════════════════════════
// ALLOCATION STRATEGIES
// ═══════════════════════════════════════════════════════════════════════
const strategies = {
    balanced: [25, 25, 25, 25],
    growth: [40, 10, 40, 10],
    burn: [10, 60, 20, 10],
    lp: [20, 10, 60, 10],
    revenue: [10, 10, 10, 70],
    custom: [25, 25, 25, 25],
};

function applyStrategy(name) {
    const values = strategies[name] || strategies.balanced;
    const inputs = ['input-marketMaking', 'input-buybackBurn', 'input-liquidity', 'input-creatorRevenue'];
    inputs.forEach((id, i) => {
        const input = document.getElementById(id);
        if (input) input.value = values[i];
    });
    updateTotal();
}

// ═══════════════════════════════════════════════════════════════════════
// TOKEN ANALYTICS UPDATE FUNCTION
// ═══════════════════════════════════════════════════════════════════════

function updateTokenAnalytics(tokenData) {
    // Default/demo data if no real data provided
    const data = tokenData || {
        marketCap: 125000,
        liquidity: 45000,
        volume24h: 89000,
        holders: 342,
        transactions: 1247,
        score: 78,
        priceChange1m: 2.5,
        priceChange5m: 8.3,
        priceChange1h: -3.2,
        priceChange24h: 45.7,
        buys24h: 856,
        sells24h: 391,
        liqDepth: 12.5,
        volMcapRatio: 0.71,
        flow5m: 2340,
        momentum: 82,
        top10Pct: 28.5,
        noMint: true,
        noFreeze: true,
        organic: 85,
        bundlerPct: 2.3,
        insiderPct: 5.1,
        devHoldPct: 3.2,
        verified: true
    };

    // Update main stats
    const mcapEl = document.getElementById('analyticsMcap');
    const liqEl = document.getElementById('analyticsLiq');
    const volEl = document.getElementById('analyticsVol');
    const holdersEl = document.getElementById('analyticsHolders');
    const txnsEl = document.getElementById('analyticsTxns');
    const scoreEl = document.getElementById('analyticsScore');

    if (mcapEl) mcapEl.textContent = formatNum(data.marketCap);
    if (liqEl) liqEl.textContent = formatNum(data.liquidity);
    if (volEl) volEl.textContent = formatNum(data.volume24h);
    if (holdersEl) holdersEl.textContent = data.holders?.toLocaleString() || '0';
    if (txnsEl) txnsEl.textContent = data.transactions?.toLocaleString() || '0';
    if (scoreEl) scoreEl.textContent = data.score || '--';

    // Update price changes
    const priceChanges = [
        { id: 'priceChange1m', value: data.priceChange1m },
        { id: 'priceChange5m', value: data.priceChange5m },
        { id: 'priceChange1h', value: data.priceChange1h },
        { id: 'priceChange24h', value: data.priceChange24h }
    ];

    priceChanges.forEach(({ id, value }) => {
        const el = document.getElementById(id);
        if (el) {
            el.textContent = formatPct(value);
            el.className = `price-change-value ${getPctClass(value)}`;
        }
    });

    // Update trade metrics
    const buys24hEl = document.getElementById('buys24h');
    const sells24hEl = document.getElementById('sells24h');
    const liqDepthEl = document.getElementById('liqDepth');
    const volMcapEl = document.getElementById('volMcap');
    const flow5mEl = document.getElementById('flow5m');
    const momentumEl = document.getElementById('momentum');

    if (buys24hEl) buys24hEl.textContent = data.buys24h?.toLocaleString() || '0';
    if (sells24hEl) sells24hEl.textContent = data.sells24h?.toLocaleString() || '0';
    if (liqDepthEl) liqDepthEl.textContent = `${data.liqDepth?.toFixed(1) || '0'}%`;
    if (volMcapEl) volMcapEl.textContent = `${((data.volMcapRatio || 0) * 100).toFixed(0)}%`;
    if (flow5mEl) flow5mEl.textContent = data.flow5m > 0 ? `+${formatNum(data.flow5m)}` : formatNum(data.flow5m);
    if (momentumEl) momentumEl.textContent = `${data.momentum || 0}/100`;

    // Update metric badges
    const liqDepthBadge = document.getElementById('liqDepthBadge');
    const volMcapBadge = document.getElementById('volMcapBadge');
    const flowBadge = document.getElementById('flowBadge');
    const momentumBadge = document.getElementById('momentumBadge');

    if (liqDepthBadge) {
        liqDepthBadge.className = `trade-metric-badge ${getBadgeClass(data.liqDepth || 0, 10, 5)}`;
        liqDepthBadge.textContent = data.liqDepth >= 10 ? 'Good' : data.liqDepth >= 5 ? 'Fair' : 'Low';
    }
    if (volMcapBadge) {
        const ratio = (data.volMcapRatio || 0) * 100;
        volMcapBadge.className = `trade-metric-badge ${getBadgeClass(ratio, 50, 20)}`;
        volMcapBadge.textContent = ratio >= 50 ? 'Active' : ratio >= 20 ? 'Normal' : 'Low';
    }
    if (flowBadge) {
        flowBadge.className = `trade-metric-badge ${data.flow5m > 0 ? 'good' : data.flow5m < 0 ? 'bad' : 'warn'}`;
        flowBadge.textContent = data.flow5m > 0 ? 'Bullish' : data.flow5m < 0 ? 'Bearish' : 'Neutral';
    }
    if (momentumBadge) {
        momentumBadge.className = `trade-metric-badge ${getBadgeClass(data.momentum || 0, 70, 40)}`;
        momentumBadge.textContent = data.momentum >= 70 ? 'Strong' : data.momentum >= 40 ? 'Normal' : 'Weak';
    }

    // Update safety panel
    const safetyScore = document.getElementById('safetyScore');
    if (safetyScore) {
        const score = data.score || 0;
        safetyScore.textContent = score;
        safetyScore.className = `safety-score-value ${score >= 70 ? 'safe' : score >= 40 ? 'warn' : 'danger'}`;
    }

    // Update safety indicators
    const safetyIndicators = [
        { iconId: 'top10Icon', valueId: 'top10Value', pass: (data.top10Pct || 0) < 50, value: `${data.top10Pct?.toFixed(1) || 0}%` },
        { iconId: 'holdersIcon', valueId: 'holdersValue', pass: (data.holders || 0) >= 100, value: data.holders?.toLocaleString() || '0' },
        { iconId: 'noMintIcon', valueId: 'noMintValue', pass: data.noMint !== false, value: data.noMint ? 'Yes' : 'No' },
        { iconId: 'noFreezeIcon', valueId: 'noFreezeValue', pass: data.noFreeze !== false, value: data.noFreeze ? 'Yes' : 'No' },
        { iconId: 'organicIcon', valueId: 'organicValue', pass: (data.organic || 0) >= 60, value: `${data.organic || 0}%` },
        { iconId: 'bundlerIcon', valueId: 'bundlerValue', pass: (data.bundlerPct || 0) < 10, value: `${data.bundlerPct?.toFixed(1) || 0}%` },
        { iconId: 'insiderIcon', valueId: 'insiderValue', pass: (data.insiderPct || 0) < 15, value: `${data.insiderPct?.toFixed(1) || 0}%` },
        { iconId: 'devHoldIcon', valueId: 'devHoldValue', pass: (data.devHoldPct || 0) < 10, value: `${data.devHoldPct?.toFixed(1) || 0}%` },
        { iconId: 'verifiedIcon', valueId: 'verifiedValue', pass: data.verified, value: data.verified ? 'Yes' : 'No' }
    ];

    safetyIndicators.forEach(({ iconId, valueId, pass, value }) => {
        const iconEl = document.getElementById(iconId);
        const valueEl = document.getElementById(valueId);
        if (iconEl) {
            iconEl.className = `safety-indicator-icon ${getSafetyClass(pass)}`;
            iconEl.innerHTML = pass ? '&#x2713;' : '&#x2717;';
        }
        if (valueEl) valueEl.textContent = value;
    });
}

// Initialize analytics with demo data on page load
document.addEventListener('DOMContentLoaded', () => {
    // Delay a bit to ensure DOM is ready
    setTimeout(() => {
        updateTokenAnalytics();
    }, 500);
});

// ═══════════════════════════════════════════════════════════════════════
// MY TOKENS FUNCTIONS
// ═══════════════════════════════════════════════════════════════════════

let myTokens = [];
let selectedToken = null;

async function fetchMyTokens() {
    if (!connectedWallet) return;

    try {
        const res = await fetch(`/api/my-tokens?wallet=${connectedWallet}`);
        const data = await res.json();
        myTokens = data.tokens || [];
        renderMyTokens();
    } catch (e) {
        console.error('[MY-TOKENS] Failed to fetch:', e);
        myTokens = [];
        renderMyTokens();
    }
}

function refreshMyTokens() {
    fetchMyTokens();
    showNotification('Refreshing tokens...', 'info');
}

function renderMyTokens() {
    const container = document.getElementById('myLaunchesContent');
    const countEl = document.getElementById('myLaunchesCount');

    countEl.textContent = `${myTokens.length} token${myTokens.length !== 1 ? 's' : ''}`;

    if (myTokens.length === 0) {
        container.innerHTML = `
            <div class="my-launches-empty">
                <p>No tokens launched yet.</p>
                <button class="btn btn-primary btn-sm" onclick="showLaunchModal()" style="margin-top:12px;">Launch Your First Token</button>
            </div>
        `;
        return;
    }

    container.innerHTML = `
        <div class="my-launches-grid">
            ${myTokens.map(token => `
                <div class="token-card ${selectedToken === token.mint ? 'selected' : ''}" onclick="selectToken('${token.mint}')">
                    <div class="token-card-header">
                        <div class="token-card-img">
                            ${token.image ? `<img src="${escapeHtml(token.image)}" alt="${escapeHtml(token.symbol)}">` : token.symbol?.slice(0, 2) || '??'}
                        </div>
                        <div>
                            <div class="token-card-name">${escapeHtml(token.name)}</div>
                            <div class="token-card-symbol">$${escapeHtml(token.symbol)}</div>
                        </div>
                    </div>
                    <div class="token-card-stats">
                        <div class="token-card-stat">
                            <span class="token-card-stat-label">MCap</span>
                            <span class="token-card-stat-value">${formatNum(token.mcap)}</span>
                        </div>
                        <div class="token-card-stat">
                            <span class="token-card-stat-label">Volume</span>
                            <span class="token-card-stat-value">${formatNum(token.volume)}</span>
                        </div>
                        <div class="token-card-stat">
                            <span class="token-card-stat-label">Holders</span>
                            <span class="token-card-stat-value">${token.holders || 0}</span>
                        </div>
                        <div class="token-card-stat">
                            <span class="token-card-stat-label">Launched</span>
                            <span class="token-card-stat-value">${token.time || 'Recently'}</span>
                        </div>
                    </div>
                    <div class="token-card-mint">${token.mint.slice(0, 8)}...${token.mint.slice(-6)}</div>
                </div>
            `).join('')}
        </div>
    `;
}

function selectTokenLocal(mint) {
    selectedToken = mint;
    const token = myTokens.find(t => t.mint === mint);

    if (token) {
        // Update token selector
        document.getElementById('tokenName').textContent = token.name || 'Unknown Token';
        document.getElementById('tokenMint').textContent = mint;
        document.getElementById('tokenAvatar').innerHTML = token.image
            ? `<img src="${escapeHtml(token.image)}" style="width:100%;height:100%;object-fit:cover;border-radius:inherit;">`
            : token.symbol?.slice(0, 2) || '??';
        document.getElementById('tokenPath').textContent = token.path === 'launchr' ? 'LAUNCHR' : 'PUMP';
        document.getElementById('tokenPath').className = `path-badge ${token.path === 'launchr' ? 'launchr' : 'pumpfun'}`;

        // Update analytics with real token data only (no placeholders)
        updateTokenAnalytics({
            marketCap: token.mcap || 0,
            liquidity: 0,  // Would need to fetch from Pump.fun
            volume24h: token.volume || 0,
            holders: token.holders || 0,
            transactions: 0,
            score: 0,
            priceChange1m: 0,
            priceChange5m: 0,
            priceChange1h: 0,
            priceChange24h: token.change || 0,
            buys24h: 0,
            sells24h: 0,
            liqDepth: 0,
            volMcapRatio: token.mcap > 0 ? (token.volume || 0) / token.mcap : 0,
            flow5m: 0,
            momentum: 0,
            top10Pct: 0,
            noMint: true,
            noFreeze: true,
            organic: 0,
            bundlerPct: 0,
            insiderPct: 0,
            devHoldPct: 0,
            verified: false
        });
    }

    // Re-render to show selection
    renderMyTokens();
}

// Register token after successful launch
async function registerTokenAfterLaunch(mint, name, symbol, imageUri, socials) {
    try {
        const res = await fetch('/api/register-token', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                mint,
                creator: connectedWallet,
                name,
                symbol,
                image: imageUri,
                path: 'pump',
                socials
            })
        });
        const data = await res.json();
        if (data.success) {
            console.log('[REGISTER] Token registered:', mint);
            // Refresh the token list
            await fetchMyTokens();
        }
    } catch (e) {
        console.error('[REGISTER] Failed to register token:', e);
    }
}

// ═══════════════════════════════════════════════════════════════════════
// TRADING FUNCTIONS
// ═══════════════════════════════════════════════════════════════════════

let tradeMode = 'buy';
let currentTokenPrice = 0;
let currentTokenData = null;

function setTradeMode(mode) {
    tradeMode = mode;
    const buyTab = document.getElementById('buyTab');
    const sellTab = document.getElementById('sellTab');
    const tradeBtn = document.getElementById('tradeBtn');
    const inputLabel = document.getElementById('tradeInputLabel');
    const inputSuffix = document.getElementById('tradeInputSuffix');

    buyTab.classList.toggle('active', mode === 'buy');
    sellTab.classList.toggle('active', mode === 'sell');
    tradeBtn.className = `trading-btn ${mode}`;

    if (mode === 'buy') {
        inputLabel.textContent = 'You pay';
        inputSuffix.textContent = 'SOL';
        tradeBtn.textContent = selectedToken ? `Buy ${currentTokenData?.symbol || 'Token'}` : 'Select a token';
    } else {
        inputLabel.textContent = 'You sell';
        inputSuffix.textContent = currentTokenData?.symbol || 'TOKEN';
        tradeBtn.textContent = selectedToken ? `Sell ${currentTokenData?.symbol || 'Token'}` : 'Select a token';
    }
    updateTradeEstimate();
}

function setTradePreset(amount) {
    document.getElementById('tradeAmount').value = amount;
    updateTradeEstimate();
}

function updateTradeEstimate() {
    const amount = parseFloat(document.getElementById('tradeAmount').value) || 0;
    const receiveEl = document.getElementById('tradeReceive');
    const impactEl = document.getElementById('tradePriceImpact');

    if (!currentTokenPrice || amount <= 0) {
        receiveEl.textContent = '0';
        impactEl.textContent = '0%';
        return;
    }

    if (tradeMode === 'buy') {
        // Estimate tokens received for SOL
        const tokensOut = amount / currentTokenPrice;
        receiveEl.textContent = formatNum(tokensOut).replace('$', '') + ` ${currentTokenData?.symbol || ''}`;
        impactEl.textContent = amount > 1 ? `~${(amount * 0.5).toFixed(1)}%` : '<0.5%';
    } else {
        // Estimate SOL received for tokens
        const solOut = amount * currentTokenPrice;
        receiveEl.textContent = solOut.toFixed(4) + ' SOL';
        impactEl.textContent = '<1%';
    }
}

async function executeTrade() {
    if (!connectedWallet || !selectedToken) {
        showNotification('Connect wallet and select a token first', 'error');
        return;
    }

    const amount = parseFloat(document.getElementById('tradeAmount').value) || 0;
    if (amount <= 0) {
        showNotification('Enter an amount', 'error');
        return;
    }

    const btn = document.getElementById('tradeBtn');
    const originalText = btn.textContent;
    btn.disabled = true;
    btn.textContent = 'Processing...';

    try {
        // Use PumpPortal API for trading
        const action = tradeMode === 'buy' ? 'buy' : 'sell';
        console.log(`[TRADE] Executing ${action} for ${amount} ${tradeMode === 'buy' ? 'SOL' : currentTokenData?.symbol}`);

        const response = await fetch('https://pumpportal.fun/api/trade-local', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                publicKey: connectedWallet,
                action: action,
                mint: selectedToken,
                amount: amount,  // Amount in SOL for buy, tokens for sell (when denominatedInSol is set appropriately)
                denominatedInSol: tradeMode === 'buy' ? 'true' : 'false',
                slippage: 10,  // 10% slippage for volatile memecoins
                priorityFee: 0.0005,  // Reasonable priority fee
                pool: 'pump'
            })
        });

        if (response.ok) {
            const data = await response.arrayBuffer();
            const tx = VersionedTransaction.deserialize(new Uint8Array(data));

            // Sign with user's wallet
            let signedTx;
            if (window.solana?.isPhantom) {
                signedTx = await window.solana.signTransaction(tx);
            } else if (window.solflare?.isSolflare) {
                signedTx = await window.solflare.signTransaction(tx);
            } else if (privyClient) {
                console.log('[TRADE] Using Privy wallet for signing...');
                const user = await privyClient.getUser();
                if (user?.wallet?.address) {
                    signedTx = await privyClient.signTransaction(tx);
                } else {
                    throw new Error('No Privy wallet connected');
                }
            } else {
                throw new Error('No wallet available for signing');
            }

            // Send transaction
            const connection = new solanaWeb3.Connection(SOLANA_RPC);
            const sig = await connection.sendRawTransaction(signedTx.serialize());
            await connection.confirmTransaction(sig, 'confirmed');

            showNotification(`${tradeMode === 'buy' ? 'Bought' : 'Sold'} successfully! TX: ${sig.slice(0, 8)}...`, 'success');
            await fetchBalance(connectedWallet);
        } else {
            throw new Error('Trade failed');
        }
    } catch (e) {
        console.error('[TRADE]', e);
        showNotification(e.message || 'Trade failed', 'error');
    } finally {
        btn.disabled = false;
        btn.textContent = originalText;
    }
}

// ═══════════════════════════════════════════════════════════════════════
// LIVE TOKEN DATA (Helius + Pump.fun)
// ═══════════════════════════════════════════════════════════════════════

async function fetchTokenDataFromHelius(mint) {
    try {
        // Use DAS API via our RPC
        const response = await fetch(SOLANA_RPC, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                jsonrpc: '2.0',
                id: 1,
                method: 'getAsset',
                params: { id: mint }
            })
        });
        const data = await response.json();
        if (data.result) {
            return {
                name: data.result.content?.metadata?.name || 'Unknown',
                symbol: data.result.content?.metadata?.symbol || '???',
                image: data.result.content?.links?.image || null,
                description: data.result.content?.metadata?.description || ''
            };
        }
    } catch (e) {
        console.error('[HELIUS] Asset fetch error:', e);
    }
    return null;
}

async function fetchPumpFunTokenData(mint) {
    try {
        const response = await fetch(`https://frontend-api.pump.fun/coins/${mint}`);
        if (response.ok) {
            const data = await response.json();
            return {
                name: data.name,
                symbol: data.symbol,
                image: data.image_uri,
                description: data.description,
                mcap: data.usd_market_cap || 0,
                price: data.price || 0,
                volume24h: data.volume_24h || 0,
                holders: data.holder_count || 0,
                creator: data.creator,
                created: data.created_timestamp,
                bondingCurve: data.bonding_curve,
                virtualSolReserves: data.virtual_sol_reserves,
                virtualTokenReserves: data.virtual_token_reserves,
                realSolReserves: data.real_sol_reserves,
                realTokenReserves: data.real_token_reserves,
                complete: data.complete
            };
        }
    } catch (e) {
        console.error('[PUMP] Token fetch error:', e);
    }
    return null;
}

async function fetchLiveTokens() {
    try {
        // Fetch new tokens from Pump.fun
        const response = await fetch('https://frontend-api.pump.fun/coins?offset=0&limit=50&sort=created_timestamp&order=DESC&includeNsfw=false');
        if (response.ok) {
            const tokens = await response.json();
            return tokens.map(t => ({
                mint: t.mint,
                name: t.name,
                symbol: t.symbol,
                image: t.image_uri,
                mcap: t.usd_market_cap || 0,
                volume: t.volume_24h || 0,
                price: t.price || 0,
                complete: t.complete,
                created: t.created_timestamp
            }));
        }
    } catch (e) {
        console.error('[PUMP] Live tokens error:', e);
    }
    return [];
}

// Update selectToken to fetch real data
async function selectToken(mint) {
    selectedToken = mint;
    const token = myTokens.find(t => t.mint === mint);

    // Show trading panel
    document.getElementById('tradingPanel').style.display = 'block';

    // Fetch real token data from Pump.fun
    showNotification('Loading token data...', 'info');
    const pumpData = await fetchPumpFunTokenData(mint);

    if (pumpData) {
        currentTokenData = pumpData;
        currentTokenPrice = pumpData.price || 0;

        // Update token selector
        document.getElementById('tokenName').textContent = pumpData.name || 'Unknown';
        document.getElementById('tokenMint').textContent = mint;
        document.getElementById('tokenAvatar').innerHTML = pumpData.image
            ? `<img src="${escapeHtml(pumpData.image)}" style="width:100%;height:100%;object-fit:cover;border-radius:inherit;">`
            : (pumpData.symbol?.slice(0, 2) || '??');
        document.getElementById('tokenPath').textContent = pumpData.complete ? 'GRADUATED' : 'PUMP';

        // Update trading panel
        document.getElementById('tradingTokenLabel').textContent = `${pumpData.symbol} / SOL`;
        document.getElementById('tradeBalance').textContent = `Balance: ${walletBalance.toFixed(4)} SOL`;
        document.getElementById('tradeBtn').disabled = false;
        setTradeMode(tradeMode);

        // Calculate real analytics from Pump.fun data
        // Bonding curve: exactly 85 SOL to graduate
        const BONDING_CURVE_TARGET = 85; // 85 SOL exactly
        const realSolInCurve = (pumpData.realSolReserves || 0) / 1e9;
        const progress = Math.min((realSolInCurve / BONDING_CURVE_TARGET) * 100, 100);
        const virtualSol = (pumpData.virtualSolReserves || 0) / 1e9;
        const realTokens = (pumpData.realTokenReserves || 0) / 1e6;

        // Liquidity depth = real SOL in curve
        const liqDepthPct = pumpData.mcap > 0 ? (realSolInCurve * 200 / pumpData.mcap) * 100 : 0;

        updateTokenAnalytics({
            marketCap: pumpData.mcap || 0,
            liquidity: realSolInCurve,  // Real SOL in bonding curve
            volume24h: pumpData.volume24h || 0,
            holders: pumpData.holders || 0,
            transactions: 0,  // Not available from API
            score: pumpData.complete ? 100 : Math.floor(progress),
            priceChange1m: 0,  // Would need historical data
            priceChange5m: 0,
            priceChange1h: 0,
            priceChange24h: 0,
            buys24h: 0,  // Not available from simple API
            sells24h: 0,
            liqDepth: liqDepthPct,
            volMcapRatio: pumpData.mcap > 0 ? (pumpData.volume24h || 0) / pumpData.mcap : 0,
            flow5m: 0,
            momentum: Math.floor(progress),  // Use bonding curve progress as momentum
            top10Pct: 0,  // Would need holder analysis
            noMint: true,  // Pump.fun tokens have no mint authority
            noFreeze: true,  // Pump.fun tokens have no freeze authority
            organic: 0,
            bundlerPct: 0,
            insiderPct: 0,
            devHoldPct: 0,
            verified: pumpData.complete,
            // Extra data for display
            bondingProgress: progress,
            solInCurve: realSolInCurve,
            solTarget: BONDING_CURVE_TARGET
        });

        showNotification(`Loaded ${pumpData.symbol} data`, 'success');
    } else if (token) {
        // Fallback to local data when Pump.fun API fails
        currentTokenData = token;
        currentTokenPrice = token.price || 0;

        document.getElementById('tokenName').textContent = token.name || 'Unknown Token';
        document.getElementById('tokenMint').textContent = mint;
        document.getElementById('tokenAvatar').innerHTML = token.image
            ? `<img src="${escapeHtml(token.image)}" style="width:100%;height:100%;object-fit:cover;border-radius:inherit;">`
            : token.symbol?.slice(0, 2) || '??';
        document.getElementById('tokenPath').textContent = token.path === 'launchr' ? 'LAUNCHR' : 'PUMP';
        document.getElementById('tradingTokenLabel').textContent = `${token.symbol} / SOL`;
        document.getElementById('tradeBalance').textContent = `Balance: ${walletBalance.toFixed(4)} SOL`;
        document.getElementById('tradeBtn').disabled = false;
        setTradeMode(tradeMode);

        showNotification(`Using local data for ${token.symbol}`, 'info');
    } else {
        showNotification('Token not found', 'error');
    }

    renderMyTokens();
}
