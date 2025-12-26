#!/usr/bin/env node

/**
 * STARFIRE FEE DISTRIBUTION CLI
 *
 * Interactive command-line interface for managing fee distribution
 * Supports both PumpFun (bonding curve) and PumpSwap (graduated)
 */

const { Connection, Keypair, LAMPORTS_PER_SOL, PublicKey } = require('@solana/web3.js');
const { FeeDistributor, CONFIG } = require('./fee-distributor');
const bs58 = require('bs58');
const readline = require('readline');

// ═══════════════════════════════════════════════════════════════════
// CLI COLORS
// ═══════════════════════════════════════════════════════════════════

const colors = {
    reset: '\x1b[0m',
    bright: '\x1b[1m',
    red: '\x1b[31m',
    green: '\x1b[32m',
    yellow: '\x1b[33m',
    blue: '\x1b[34m',
    magenta: '\x1b[35m',
    cyan: '\x1b[36m',
};

const c = {
    error: (s) => `${colors.red}${s}${colors.reset}`,
    success: (s) => `${colors.green}${s}${colors.reset}`,
    warn: (s) => `${colors.yellow}${s}${colors.reset}`,
    info: (s) => `${colors.cyan}${s}${colors.reset}`,
    highlight: (s) => `${colors.bright}${colors.magenta}${s}${colors.reset}`,
    dim: (s) => `\x1b[2m${s}${colors.reset}`,
};

// ═══════════════════════════════════════════════════════════════════
// CLI CLASS
// ═══════════════════════════════════════════════════════════════════

class StarfireCLI {
    constructor() {
        this.connection = null;
        this.wallet = null;
        this.tokenMint = null;
        this.distributor = null;
        this.priceInterval = null;
        this.isRunning = false;

        this.rl = readline.createInterface({
            input: process.stdin,
            output: process.stdout,
        });
    }

    // ═══════════════════════════════════════════════════════════════
    // DISPLAY METHODS
    // ═══════════════════════════════════════════════════════════════

    clearScreen() {
        console.clear();
    }

    printBanner() {
        console.log(c.highlight(`
╔═══════════════════════════════════════════════════════════════╗
║                                                               ║
║     ███████╗████████╗ █████╗ ██████╗ ███████╗██╗██████╗ ███████╗    ║
║     ██╔════╝╚══██╔══╝██╔══██╗██╔══██╗██╔════╝██║██╔══██╗██╔════╝    ║
║     ███████╗   ██║   ███████║██████╔╝█████╗  ██║██████╔╝█████╗      ║
║     ╚════██║   ██║   ██╔══██║██╔══██╗██╔══╝  ██║██╔══██╗██╔══╝      ║
║     ███████║   ██║   ██║  ██║██║  ██║██║     ██║██║  ██║███████╗    ║
║     ╚══════╝   ╚═╝   ╚═╝  ╚═╝╚═╝  ╚═╝╚═╝     ╚═╝╚═╝  ╚═╝╚══════╝    ║
║                                                               ║
║              FEE DISTRIBUTION SYSTEM v1.0                     ║
║           PumpFun + PumpSwap Integration                      ║
╚═══════════════════════════════════════════════════════════════╝
`));
    }

    printMenu() {
        console.log(`
${c.info('══════════════════ MAIN MENU ══════════════════')}

  ${c.highlight('1)')} Configure Wallet & Token
  ${c.highlight('2)')} View Current Status
  ${c.highlight('3)')} Distribute Fees (Manual)
  ${c.highlight('4)')} ${c.success('⚡ AUTO-CLAIM + DISTRIBUTE')} ${c.dim('(Recommended)')}
  ${c.highlight('5)')} Check Token Info (Bonded/Unbonded)
  ${c.highlight('6)')} View RSI & Buyback Strategy
  ${c.highlight('7)')} Flush Accumulated Fees
  ${c.highlight('8)')} View Distribution Stats
  ${c.highlight('9)')} Claim Fees Once (Manual)

  ${c.highlight('0)')} Exit

${c.info('═══════════════════════════════════════════════')}
`);
    }

    printStatus() {
        if (!this.distributor) {
            console.log(c.warn('\n⚠️  Not configured. Run option 1 first.\n'));
            return;
        }

        const status = this.distributor.getStatus();

        console.log(`
${c.info('══════════════════ STATUS ══════════════════')}

  ${c.highlight('Wallet:')} ${this.wallet.publicKey.toBase58().slice(0, 20)}...
  ${c.highlight('Token:')}  ${this.tokenMint.slice(0, 20)}...

  ${c.highlight('RSI:')} ${status.rsi.rsi} ${status.rsi.ready ? c.success('(Ready)') : c.warn('(Collecting data...)')}
  ${c.highlight('Action:')} ${this.formatRSIAction(status.rsiAction)}

  ${c.info('─── Accumulated Fees ───')}
  🔥 Burn:    ${(status.accumulated.burn / LAMPORTS_PER_SOL).toFixed(6)} SOL
  📈 Buyback: ${(status.accumulated.buyback / LAMPORTS_PER_SOL).toFixed(6)} SOL
  🎲 Holder:  ${(status.accumulated.holderReward / LAMPORTS_PER_SOL).toFixed(6)} SOL
  💧 LP:      ${(status.accumulated.lpPool / LAMPORTS_PER_SOL).toFixed(6)} SOL

${c.info('═══════════════════════════════════════════════')}
`);
    }

    formatRSIAction(action) {
        const colors = {
            'strong_buy': c.success('🚀 STRONG BUY (2x)'),
            'oversold': c.success('📈 OVERSOLD (1.5x)'),
            'buy_zone': c.info('📊 BUY ZONE (1x)'),
            'weak_buy': c.warn('📉 WEAK BUY (0.5x)'),
            'accumulating': c.dim('⏳ ACCUMULATING'),
            'insufficient_data': c.warn('📊 Collecting price data...'),
        };
        return colors[action.reason] || action.reason;
    }

    // ═══════════════════════════════════════════════════════════════
    // USER INPUT METHODS
    // ═══════════════════════════════════════════════════════════════

    async prompt(question) {
        return new Promise((resolve) => {
            this.rl.question(question, resolve);
        });
    }

    async promptSecret(question) {
        return new Promise((resolve) => {
            process.stdout.write(question);

            const stdin = process.stdin;
            const oldMode = stdin.isRaw;
            stdin.setRawMode(true);
            stdin.resume();

            let input = '';

            const onData = (char) => {
                char = char.toString();

                if (char === '\n' || char === '\r') {
                    stdin.setRawMode(oldMode);
                    stdin.removeListener('data', onData);
                    console.log();
                    resolve(input);
                } else if (char === '\u0003') {
                    process.exit();
                } else if (char === '\u007F') {
                    input = input.slice(0, -1);
                    process.stdout.write('\b \b');
                } else {
                    input += char;
                    process.stdout.write('*');
                }
            };

            stdin.on('data', onData);
        });
    }

    // ═══════════════════════════════════════════════════════════════
    // CONFIGURATION
    // ═══════════════════════════════════════════════════════════════

    async configure() {
        console.log(c.info('\n═══════════════ CONFIGURATION ═══════════════\n'));

        // RPC URL
        const rpcUrl = await this.prompt(`RPC URL ${c.dim('(Enter for mainnet)')}: `);
        const rpc = rpcUrl.trim() || 'https://api.mainnet-beta.solana.com';

        // Private key
        console.log(c.warn('\n⚠️  Your private key is never stored or transmitted.'));
        const privateKey = await this.prompt(`Fee Wallet Private Key ${c.dim('(base58)')}: `);

        if (!privateKey.trim()) {
            console.log(c.error('\n❌ Private key is required.\n'));
            return;
        }

        // Token mint
        const tokenMint = await this.prompt(`Token Mint Address: `);

        if (!tokenMint.trim()) {
            console.log(c.error('\n❌ Token mint is required.\n'));
            return;
        }

        // Validate and initialize
        try {
            this.connection = new Connection(rpc, 'confirmed');
            this.wallet = Keypair.fromSecretKey(bs58.decode(privateKey.trim()));
            this.tokenMint = tokenMint.trim();

            // Validate token mint
            new PublicKey(this.tokenMint);

            this.distributor = new FeeDistributor(
                this.connection,
                this.tokenMint,
                this.wallet
            );

            console.log(c.success('\n✅ Configuration successful!'));
            console.log(`   Wallet: ${this.wallet.publicKey.toBase58().slice(0, 20)}...`);
            console.log(`   Token:  ${this.tokenMint.slice(0, 20)}...`);
            console.log();

            // Start price feed
            await this.startPriceFeed();

        } catch (e) {
            console.log(c.error(`\n❌ Error: ${e.message}\n`));
        }
    }

    // ═══════════════════════════════════════════════════════════════
    // OPERATIONS
    // ═══════════════════════════════════════════════════════════════

    async startPriceFeed() {
        if (this.priceInterval) {
            clearInterval(this.priceInterval);
        }

        console.log(c.info('📊 Starting price feed for RSI calculation...'));

        // Initial update
        await this.distributor.updatePrice();

        // Update every 30 seconds
        this.priceInterval = setInterval(async () => {
            await this.distributor.updatePrice();
        }, 30000);
    }

    async distributeFees() {
        if (!this.distributor) {
            console.log(c.warn('\n⚠️  Not configured. Run option 1 first.\n'));
            return;
        }

        const amountStr = await this.prompt(`\nEnter fee amount in SOL: `);
        const amount = parseFloat(amountStr);

        if (isNaN(amount) || amount <= 0) {
            console.log(c.error('\n❌ Invalid amount.\n'));
            return;
        }

        console.log(c.info(`\n🚀 Distributing ${amount} SOL in fees...\n`));

        const result = await this.distributor.distributeFees(
            Math.floor(amount * LAMPORTS_PER_SOL)
        );

        if (result.success) {
            console.log(c.success('\n✅ Distribution complete!\n'));
            console.log(JSON.stringify(result.results, null, 2));
        } else {
            console.log(c.error(`\n❌ Distribution failed: ${result.reason}\n`));
        }
    }

    async startAutoMode() {
        if (!this.distributor) {
            console.log(c.warn('\n⚠️  Not configured. Run option 1 first.\n'));
            return;
        }

        const intervalStr = await this.prompt(`\nClaim interval in minutes ${c.dim('(default: 10)')}: `);
        const intervalMinutes = parseInt(intervalStr) || 10;
        const intervalMs = intervalMinutes * 60 * 1000;

        console.log(c.info(`\n🤖 AUTO-CLAIM + DISTRIBUTE MODE`));
        console.log(c.info(`   Claiming creator fees every ${intervalMinutes} minutes`));
        console.log(c.info(`   Distributing: 25% burn / 25% buyback / 25% holder / 25% LP`));
        console.log(c.warn(`   Press Ctrl+C to stop\n`));

        console.log(c.highlight('\n═══════════════════════════════════════════════'));
        console.log(c.highlight('   STARTING AUTO-CLAIM LOOP'));
        console.log(c.highlight('═══════════════════════════════════════════════\n'));

        this.isRunning = true;

        const claimAndDistributeLoop = async () => {
            if (!this.isRunning) return;

            const timestamp = new Date().toLocaleTimeString();
            console.log(`\n[${timestamp}] ${c.info('Checking for claimable creator fees...')}`);

            try {
                const result = await this.distributor.claimAndDistribute();

                if (result.success) {
                    if (result.claimed > 0) {
                        console.log(c.success(`\n✅ Claimed ${(result.claimed / LAMPORTS_PER_SOL).toFixed(6)} SOL`));
                        if (result.distributed > 0) {
                            console.log(c.success(`✅ Distributed ${(result.distributed / LAMPORTS_PER_SOL).toFixed(6)} SOL`));
                        }
                    } else {
                        console.log(c.dim(`   No fees to claim yet`));
                    }
                } else {
                    console.log(c.warn(`   Claim/distribute issue: ${result.reason || result.error}`));
                }

                // Show next check time
                const nextCheck = new Date(Date.now() + intervalMs).toLocaleTimeString();
                console.log(c.dim(`\n   Next check: ${nextCheck}`));

            } catch (e) {
                console.log(c.error(`   Error: ${e.message}`));
            }

            if (this.isRunning) {
                setTimeout(claimAndDistributeLoop, intervalMs);
            }
        };

        // Run immediately, then on interval
        claimAndDistributeLoop();

        // Wait for Ctrl+C
        await new Promise((resolve) => {
            const handler = () => {
                this.isRunning = false;
                this.distributor.stopAutoClaimLoop();
                console.log(c.warn('\n\n⏹️  Auto-claim mode stopped.\n'));
                process.removeListener('SIGINT', handler);
                resolve();
            };
            process.on('SIGINT', handler);
        });
    }

    async claimFeesOnce() {
        if (!this.distributor) {
            console.log(c.warn('\n⚠️  Not configured. Run option 1 first.\n'));
            return;
        }

        console.log(c.info('\n💰 Claiming creator fees from Pump.fun...\n'));

        try {
            const result = await this.distributor.claimAndDistribute();

            if (result.success) {
                if (result.claimed > 0) {
                    console.log(c.success(`\n✅ Claimed: ${(result.claimed / LAMPORTS_PER_SOL).toFixed(6)} SOL`));
                    console.log(`   Claim TX: ${result.claimSignature}`);
                    if (result.distributed > 0) {
                        console.log(c.success(`✅ Distributed: ${(result.distributed / LAMPORTS_PER_SOL).toFixed(6)} SOL`));
                    }
                } else {
                    console.log(c.warn('\n⚠️  No creator fees available to claim.\n'));
                    console.log(c.dim('   Fees accumulate as people trade your token on Pump.fun'));
                }
            } else {
                console.log(c.error(`\n❌ Claim failed: ${result.reason || result.error}\n`));
            }
        } catch (e) {
            console.log(c.error(`\n❌ Error: ${e.message}\n`));
        }
    }

    async checkTokenInfo() {
        if (!this.distributor) {
            console.log(c.warn('\n⚠️  Not configured. Run option 1 first.\n'));
            return;
        }

        console.log(c.info('\n🔍 Fetching token info...\n'));

        try {
            const priceData = await this.distributor.pumpPortal.getTokenPrice(this.tokenMint);

            if (priceData) {
                console.log(`
${c.info('══════════════ TOKEN INFO ══════════════')}

  ${c.highlight('Status:')}     ${priceData.complete ? c.success('🎓 GRADUATED (PumpSwap)') : c.warn('📈 BONDING CURVE (PumpFun)')}
  ${c.highlight('Price USD:')} $${priceData.priceUsd?.toFixed(10) || 'N/A'}
  ${c.highlight('Price SOL:')} ${priceData.priceSol?.toFixed(10) || 'N/A'} SOL
  ${c.highlight('Market Cap:')} $${priceData.marketCap?.toLocaleString() || 'N/A'}

  ${priceData.complete
    ? c.success('✅ Token has graduated! Using PumpSwap for trades.')
    : c.info('📊 Token still on bonding curve. Using PumpFun.')}

${c.info('═════════════════════════════════════════')}
`);
            } else {
                console.log(c.error('❌ Could not fetch token info. Check mint address.\n'));
            }
        } catch (e) {
            console.log(c.error(`❌ Error: ${e.message}\n`));
        }
    }

    viewRSI() {
        if (!this.distributor) {
            console.log(c.warn('\n⚠️  Not configured. Run option 1 first.\n'));
            return;
        }

        const status = this.distributor.getStatus();

        console.log(`
${c.info('══════════════ RSI STRATEGY ══════════════')}

  ${c.highlight('Current RSI:')} ${status.rsi.rsi}
  ${c.highlight('Data Points:')} ${status.rsi.dataPoints || 'N/A'}/${CONFIG.RSI.PERIOD + 1}
  ${c.highlight('Status:')} ${status.rsi.ready ? c.success('Ready') : c.warn('Collecting...')}

  ${c.info('─── Buyback Multipliers ───')}
  RSI < 20:  ${c.success('2.0x')} (Strong Buy)
  RSI < 30:  ${c.success('1.5x')} (Oversold)
  RSI < 40:  ${c.info('1.0x')}  (Buy Zone)
  RSI < 50:  ${c.warn('0.5x')}  (Weak Buy)
  RSI >= 50: ${c.dim('0x')}    (Accumulate)

  ${c.highlight('Current Action:')} ${this.formatRSIAction(status.rsiAction)}
  ${c.highlight('Multiplier:')} ${status.rsiAction.multiplier}x

${c.info('═════════════════════════════════════════')}
`);
    }

    async flushAccumulated() {
        if (!this.distributor) {
            console.log(c.warn('\n⚠️  Not configured. Run option 1 first.\n'));
            return;
        }

        const status = this.distributor.getStatus();
        const total = status.accumulated.burn + status.accumulated.buyback +
                      status.accumulated.holderReward + status.accumulated.lpPool;

        if (total === 0) {
            console.log(c.warn('\n⚠️  No accumulated fees to flush.\n'));
            return;
        }

        console.log(c.info(`\n💧 Flushing ${(total / LAMPORTS_PER_SOL).toFixed(6)} SOL accumulated fees...\n`));

        const result = await this.distributor.flushAccumulated();

        if (result.success) {
            console.log(c.success('\n✅ Flush complete!\n'));
        } else {
            console.log(c.error(`\n❌ Flush failed: ${result.reason}\n`));
        }
    }

    viewStats() {
        if (!this.distributor) {
            console.log(c.warn('\n⚠️  Not configured. Run option 1 first.\n'));
            return;
        }

        const status = this.distributor.getStatus();

        console.log(`
${c.info('══════════════ STATISTICS ══════════════')}

  ${c.highlight('💰 Total Claimed:')}    ${(status.stats.totalClaimed / LAMPORTS_PER_SOL).toFixed(6)} SOL
  ${c.highlight('📊 Total Distributed:')} ${(status.stats.totalDistributed / LAMPORTS_PER_SOL).toFixed(6)} SOL
  ${c.highlight('🔄 Claims:')}           ${status.stats.claims}
  ${c.highlight('📤 Distributions:')}    ${status.stats.distributions}

  ${c.info('─── Breakdown ───')}
  🔥 Tokens Burned:    ${status.stats.totalBurned.toLocaleString()}
  📈 Buyback SOL:      ${(status.stats.totalBuyback / LAMPORTS_PER_SOL).toFixed(6)} SOL
  🎲 Holder Rewards:   ${(status.stats.totalHolderRewards / LAMPORTS_PER_SOL).toFixed(6)} SOL
  💧 LP Tokens Burned: ${status.stats.totalLPBurned.toLocaleString()}

${c.info('═════════════════════════════════════════')}
`);
    }

    // ═══════════════════════════════════════════════════════════════
    // MAIN LOOP
    // ═══════════════════════════════════════════════════════════════

    async run() {
        this.clearScreen();
        this.printBanner();

        // Check for env vars
        if (process.env.FEE_WALLET_PRIVATE_KEY && process.env.TOKEN_MINT) {
            console.log(c.info('📋 Found environment variables, auto-configuring...\n'));
            try {
                const rpc = process.env.RPC_URL || 'https://api.mainnet-beta.solana.com';
                this.connection = new Connection(rpc, 'confirmed');
                this.wallet = Keypair.fromSecretKey(bs58.decode(process.env.FEE_WALLET_PRIVATE_KEY));
                this.tokenMint = process.env.TOKEN_MINT;
                this.distributor = new FeeDistributor(this.connection, this.tokenMint, this.wallet);
                console.log(c.success('✅ Auto-configured from environment!\n'));
                await this.startPriceFeed();
            } catch (e) {
                console.log(c.error(`❌ Auto-config failed: ${e.message}\n`));
            }
        }

        while (true) {
            this.printMenu();
            const choice = await this.prompt('Select option: ');

            switch (choice.trim()) {
                case '1':
                    await this.configure();
                    break;
                case '2':
                    this.printStatus();
                    break;
                case '3':
                    await this.distributeFees();
                    break;
                case '4':
                    await this.startAutoMode();
                    break;
                case '5':
                    await this.checkTokenInfo();
                    break;
                case '6':
                    this.viewRSI();
                    break;
                case '7':
                    await this.flushAccumulated();
                    break;
                case '8':
                    this.viewStats();
                    break;
                case '9':
                    await this.claimFeesOnce();
                    break;
                case '0':
                case 'exit':
                case 'quit':
                    console.log(c.info('\n👋 Goodbye!\n'));
                    process.exit(0);
                default:
                    console.log(c.warn('\n⚠️  Invalid option.\n'));
            }

            await this.prompt('\nPress Enter to continue...');
            this.clearScreen();
            this.printBanner();
        }
    }
}

// ═══════════════════════════════════════════════════════════════════
// START CLI
// ═══════════════════════════════════════════════════════════════════

const cli = new StarfireCLI();
cli.run().catch((e) => {
    console.error('Fatal error:', e);
    process.exit(1);
});
