const { Connection, Keypair, LAMPORTS_PER_SOL } = require('@solana/web3.js');
const { FeeDistributor } = require('./fee-distributor');
const bs58 = require('bs58');

// ═══════════════════════════════════════════════════════════════════
// STARFIRE AUTO-CLAIM + DISTRIBUTE
// ═══════════════════════════════════════════════════════════════════
//
// This script automatically:
// 1. Claims creator fees from Pump.fun every 10 minutes
// 2. Distributes claimed fees: 25% burn / 25% buyback / 25% holder / 25% LP
//
// Environment Variables:
//   FEE_WALLET_PRIVATE_KEY - Creator wallet private key (base58)
//   TOKEN_MINT             - Token mint address
//   RPC_URL                - (Optional) Solana RPC URL
//   CLAIM_INTERVAL_MINUTES - (Optional) Claim interval, default 10
//
// ═══════════════════════════════════════════════════════════════════

console.log(`
╔═══════════════════════════════════════════════════════════════╗
║                     STARFIRE v1.0                             ║
║            AUTO-CLAIM + DISTRIBUTE                            ║
║                                                               ║
║   🔥 25% Burn    📈 25% RSI Buyback                           ║
║   🎲 25% Holder  💧 25% LP + Burn                             ║
╚═══════════════════════════════════════════════════════════════╝
`);

// ═══════════════════════════════════════════════════════════════════
// CONFIGURATION
// ═══════════════════════════════════════════════════════════════════

const RPC_URL = process.env.RPC_URL || 'https://api.mainnet-beta.solana.com';
const PRIVATE_KEY = process.env.FEE_WALLET_PRIVATE_KEY;
const TOKEN_MINT = process.env.TOKEN_MINT;
const CLAIM_INTERVAL_MINUTES = parseInt(process.env.CLAIM_INTERVAL_MINUTES) || 10;

// Validate required env vars
if (!PRIVATE_KEY) {
    console.error('❌ ERROR: FEE_WALLET_PRIVATE_KEY environment variable is required');
    console.error('   This should be the creator wallet that made the token on Pump.fun');
    console.error('');
    console.error('   Example:');
    console.error('   FEE_WALLET_PRIVATE_KEY=your_base58_key TOKEN_MINT=your_token npm run auto');
    process.exit(1);
}

if (!TOKEN_MINT) {
    console.error('❌ ERROR: TOKEN_MINT environment variable is required');
    console.error('   This is your token\'s contract address from Pump.fun');
    process.exit(1);
}

// ═══════════════════════════════════════════════════════════════════
// SETUP
// ═══════════════════════════════════════════════════════════════════

const connection = new Connection(RPC_URL, 'confirmed');

let feeWallet;
try {
    feeWallet = Keypair.fromSecretKey(bs58.decode(PRIVATE_KEY));
} catch (e) {
    console.error('❌ ERROR: Invalid private key format. Must be base58 encoded.');
    process.exit(1);
}

console.log(`✅ Wallet:  ${feeWallet.publicKey.toBase58()}`);
console.log(`✅ Token:   ${TOKEN_MINT}`);
console.log(`✅ RPC:     ${RPC_URL.slice(0, 40)}...`);
console.log(`✅ Interval: ${CLAIM_INTERVAL_MINUTES} minutes`);
console.log('');

// Initialize distributor
const distributor = new FeeDistributor(connection, TOKEN_MINT, feeWallet);

// ═══════════════════════════════════════════════════════════════════
// AUTO-CLAIM LOOP
// ═══════════════════════════════════════════════════════════════════

async function runAutoClaimLoop() {
    const intervalMs = CLAIM_INTERVAL_MINUTES * 60 * 1000;

    console.log('═'.repeat(60));
    console.log('🚀 STARTING AUTO-CLAIM LOOP');
    console.log('═'.repeat(60));
    console.log(`   Claiming creator fees every ${CLAIM_INTERVAL_MINUTES} minutes`);
    console.log(`   Distributing: 25% burn / 25% buyback / 25% holder / 25% LP`);
    console.log('   Press Ctrl+C to stop');
    console.log('═'.repeat(60));
    console.log('');

    // Track stats
    let totalClaimed = 0;
    let totalDistributed = 0;
    let claimCount = 0;

    const claimAndDistribute = async () => {
        const timestamp = new Date().toLocaleString();
        console.log(`\n[${timestamp}] Checking for claimable creator fees...`);

        try {
            // Update price for RSI
            await distributor.updatePrice();

            // Claim and distribute
            const result = await distributor.claimAndDistribute();

            if (result.success) {
                if (result.claimed > 0) {
                    totalClaimed += result.claimed;
                    claimCount++;

                    console.log(`\n✅ CLAIMED: ${(result.claimed / LAMPORTS_PER_SOL).toFixed(6)} SOL`);
                    console.log(`   TX: ${result.claimSignature}`);

                    if (result.distributed > 0) {
                        totalDistributed += result.distributed;
                        console.log(`✅ DISTRIBUTED: ${(result.distributed / LAMPORTS_PER_SOL).toFixed(6)} SOL`);
                        console.log(`   🔥 Burn: ${(result.distributed * 0.25 / LAMPORTS_PER_SOL).toFixed(6)} SOL`);
                        console.log(`   📈 Buyback: ${(result.distributed * 0.25 / LAMPORTS_PER_SOL).toFixed(6)} SOL`);
                        console.log(`   🎲 Holder: ${(result.distributed * 0.25 / LAMPORTS_PER_SOL).toFixed(6)} SOL`);
                        console.log(`   💧 LP: ${(result.distributed * 0.25 / LAMPORTS_PER_SOL).toFixed(6)} SOL`);
                    }
                } else {
                    console.log(`   No fees to claim yet`);
                }
            } else {
                console.log(`   ⚠️ Issue: ${result.reason || result.error}`);
            }

            // Show session stats
            console.log(`\n📊 Session Stats: ${claimCount} claims | ${(totalClaimed / LAMPORTS_PER_SOL).toFixed(6)} SOL claimed | ${(totalDistributed / LAMPORTS_PER_SOL).toFixed(6)} SOL distributed`);

            // Next check time
            const nextCheck = new Date(Date.now() + intervalMs).toLocaleTimeString();
            console.log(`⏰ Next check: ${nextCheck}`);

        } catch (e) {
            console.error(`   ❌ Error: ${e.message}`);
        }
    };

    // Run immediately
    await claimAndDistribute();

    // Then run on interval
    const intervalId = setInterval(claimAndDistribute, intervalMs);

    // Handle graceful shutdown
    process.on('SIGINT', () => {
        console.log('\n\n⏹️  Stopping auto-claim loop...');
        clearInterval(intervalId);

        console.log('\n═'.repeat(60));
        console.log('📊 FINAL SESSION STATS');
        console.log('═'.repeat(60));
        console.log(`   Total Claims: ${claimCount}`);
        console.log(`   Total Claimed: ${(totalClaimed / LAMPORTS_PER_SOL).toFixed(6)} SOL`);
        console.log(`   Total Distributed: ${(totalDistributed / LAMPORTS_PER_SOL).toFixed(6)} SOL`);
        console.log('═'.repeat(60));
        console.log('\n👋 Goodbye!\n');

        process.exit(0);
    });

    // Keep alive
    console.log('\n🤖 Auto-claim loop running. Press Ctrl+C to stop.\n');
}

// ═══════════════════════════════════════════════════════════════════
// START
// ═══════════════════════════════════════════════════════════════════

runAutoClaimLoop().catch((e) => {
    console.error('Fatal error:', e);
    process.exit(1);
});
