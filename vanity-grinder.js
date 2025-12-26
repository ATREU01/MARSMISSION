/**
 * VANITY ADDRESS GRINDER
 *
 * Mines Solana keypairs to find addresses matching a pattern
 * Example: Find token addresses ending in "launchr"
 *
 * Usage:
 *   node vanity-grinder.js --suffix launchr --workers 4
 *   node vanity-grinder.js --prefix LAU --suffix chr
 */

const { Keypair } = require('@solana/web3.js');
const { Worker, isMainThread, parentPort, workerData } = require('worker_threads');
const os = require('os');
const fs = require('fs');
const path = require('path');
const bs58 = require('bs58');

// ═══════════════════════════════════════════════════════════════════
// CONFIGURATION
// ═══════════════════════════════════════════════════════════════════

const CONFIG = {
    OUTPUT_FILE: path.join(__dirname, '.vanity-keys.json'),
    PROGRESS_INTERVAL: 5000, // Log progress every 5 seconds
    SAVE_ALL_CLOSE_MATCHES: true, // Save addresses that are close to matching
    CLOSE_MATCH_THRESHOLD: 2, // How many chars off is considered "close"
};

// ═══════════════════════════════════════════════════════════════════
// WORKER THREAD CODE
// ═══════════════════════════════════════════════════════════════════

if (!isMainThread) {
    const { prefix, suffix, caseSensitive } = workerData;

    let checked = 0;
    let lastReport = Date.now();

    const normalizeCase = (str) => caseSensitive ? str : str.toLowerCase();
    const prefixNorm = normalizeCase(prefix || '');
    const suffixNorm = normalizeCase(suffix || '');

    while (true) {
        const keypair = Keypair.generate();
        const address = keypair.publicKey.toBase58();
        const addressNorm = normalizeCase(address);

        checked++;

        // Check for match
        const prefixMatch = !prefixNorm || addressNorm.startsWith(prefixNorm);
        const suffixMatch = !suffixNorm || addressNorm.endsWith(suffixNorm);

        if (prefixMatch && suffixMatch) {
            parentPort.postMessage({
                type: 'found',
                address,
                secretKey: Array.from(keypair.secretKey),
                checked,
            });
            break;
        }

        // Report progress periodically
        if (Date.now() - lastReport > 1000) {
            parentPort.postMessage({
                type: 'progress',
                checked,
            });
            lastReport = Date.now();
            checked = 0;
        }
    }
}

// ═══════════════════════════════════════════════════════════════════
// MAIN THREAD CODE
// ═══════════════════════════════════════════════════════════════════

if (isMainThread) {
    class VanityGrinder {
        constructor(options = {}) {
            this.prefix = options.prefix || '';
            this.suffix = options.suffix || '';
            this.caseSensitive = options.caseSensitive || false;
            this.numWorkers = options.workers || os.cpus().length;

            this.workers = [];
            this.totalChecked = 0;
            this.startTime = null;
            this.found = null;
        }

        /**
         * Estimate difficulty based on pattern length
         * Base58 alphabet: 123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz
         * = 58 characters
         */
        estimateDifficulty() {
            const patternLength = (this.prefix?.length || 0) + (this.suffix?.length || 0);

            if (patternLength === 0) return { attempts: 1, time: '< 1 second' };

            // Each character has 1/58 chance (case sensitive) or ~1/34 chance (case insensitive)
            const charProbability = this.caseSensitive ? 58 : 34;
            const attempts = Math.pow(charProbability, patternLength);

            // Rough estimate: ~100K attempts per second per core
            const attemptsPerSecond = 100000 * this.numWorkers;
            const seconds = attempts / attemptsPerSecond;

            let timeEstimate;
            if (seconds < 60) timeEstimate = `~${Math.round(seconds)} seconds`;
            else if (seconds < 3600) timeEstimate = `~${Math.round(seconds / 60)} minutes`;
            else if (seconds < 86400) timeEstimate = `~${Math.round(seconds / 3600)} hours`;
            else if (seconds < 604800) timeEstimate = `~${Math.round(seconds / 86400)} days`;
            else if (seconds < 31536000) timeEstimate = `~${Math.round(seconds / 604800)} weeks`;
            else timeEstimate = `~${Math.round(seconds / 31536000)} years`;

            return {
                patternLength,
                attempts: attempts.toLocaleString(),
                probability: `1 in ${attempts.toLocaleString()}`,
                timeEstimate,
                workers: this.numWorkers,
            };
        }

        /**
         * Start grinding
         */
        start() {
            return new Promise((resolve, reject) => {
                console.log('\n' + '═'.repeat(50));
                console.log('VANITY ADDRESS GRINDER');
                console.log('═'.repeat(50));

                if (this.prefix) console.log(`Prefix: ${this.prefix}`);
                if (this.suffix) console.log(`Suffix: ${this.suffix}`);
                console.log(`Case sensitive: ${this.caseSensitive}`);
                console.log(`Workers: ${this.numWorkers}`);

                const estimate = this.estimateDifficulty();
                console.log(`\nDifficulty estimate:`);
                console.log(`  Pattern length: ${estimate.patternLength} chars`);
                console.log(`  Probability: ${estimate.probability}`);
                console.log(`  Expected time: ${estimate.timeEstimate}`);
                console.log('═'.repeat(50) + '\n');

                if (estimate.patternLength > 7) {
                    console.log('⚠️  Warning: Long patterns may take extremely long to find!');
                    console.log('   Consider using a shorter pattern.\n');
                }

                this.startTime = Date.now();

                // Progress reporting
                const progressInterval = setInterval(() => {
                    const elapsed = (Date.now() - this.startTime) / 1000;
                    const rate = Math.round(this.totalChecked / elapsed);
                    console.log(`[GRIND] ${this.totalChecked.toLocaleString()} checked | ${rate.toLocaleString()}/sec | ${Math.round(elapsed)}s elapsed`);
                }, CONFIG.PROGRESS_INTERVAL);

                // Spawn workers
                for (let i = 0; i < this.numWorkers; i++) {
                    const worker = new Worker(__filename, {
                        workerData: {
                            prefix: this.prefix,
                            suffix: this.suffix,
                            caseSensitive: this.caseSensitive,
                        },
                    });

                    worker.on('message', (msg) => {
                        if (msg.type === 'progress') {
                            this.totalChecked += msg.checked;
                        } else if (msg.type === 'found') {
                            this.totalChecked += msg.checked;
                            this.found = {
                                address: msg.address,
                                secretKey: Uint8Array.from(msg.secretKey),
                            };

                            // Stop all workers
                            this.workers.forEach(w => w.terminate());
                            clearInterval(progressInterval);

                            const elapsed = (Date.now() - this.startTime) / 1000;
                            console.log('\n' + '═'.repeat(50));
                            console.log('✅ FOUND!');
                            console.log('═'.repeat(50));
                            console.log(`Address: ${this.found.address}`);
                            console.log(`Total checked: ${this.totalChecked.toLocaleString()}`);
                            console.log(`Time: ${elapsed.toFixed(1)}s`);
                            console.log(`Rate: ${Math.round(this.totalChecked / elapsed).toLocaleString()}/sec`);
                            console.log('═'.repeat(50) + '\n');

                            // Save to file
                            this.saveResult();

                            resolve(this.found);
                        }
                    });

                    worker.on('error', (err) => {
                        console.error(`Worker ${i} error:`, err);
                    });

                    this.workers.push(worker);
                }
            });
        }

        /**
         * Save found keypair to file
         */
        saveResult() {
            if (!this.found) return;

            const result = {
                address: this.found.address,
                secretKey: bs58.encode(this.found.secretKey),
                secretKeyArray: Array.from(this.found.secretKey),
                foundAt: new Date().toISOString(),
                pattern: {
                    prefix: this.prefix,
                    suffix: this.suffix,
                    caseSensitive: this.caseSensitive,
                },
                stats: {
                    totalChecked: this.totalChecked,
                    timeSeconds: (Date.now() - this.startTime) / 1000,
                },
            };

            // Append to existing file or create new
            let existing = [];
            try {
                if (fs.existsSync(CONFIG.OUTPUT_FILE)) {
                    existing = JSON.parse(fs.readFileSync(CONFIG.OUTPUT_FILE, 'utf8'));
                }
            } catch (e) {}

            existing.push(result);
            fs.writeFileSync(CONFIG.OUTPUT_FILE, JSON.stringify(existing, null, 2));
            console.log(`Saved to: ${CONFIG.OUTPUT_FILE}`);
        }

        /**
         * Stop all workers
         */
        stop() {
            this.workers.forEach(w => w.terminate());
        }
    }

    // ═══════════════════════════════════════════════════════════════
    // CLI
    // ═══════════════════════════════════════════════════════════════

    function parseArgs() {
        const args = process.argv.slice(2);
        const options = {
            prefix: '',
            suffix: '',
            caseSensitive: false,
            workers: os.cpus().length,
        };

        for (let i = 0; i < args.length; i++) {
            switch (args[i]) {
                case '--prefix':
                case '-p':
                    options.prefix = args[++i];
                    break;
                case '--suffix':
                case '-s':
                    options.suffix = args[++i];
                    break;
                case '--case-sensitive':
                case '-c':
                    options.caseSensitive = true;
                    break;
                case '--workers':
                case '-w':
                    options.workers = parseInt(args[++i], 10);
                    break;
                case '--help':
                case '-h':
                    console.log(`
Vanity Address Grinder - Find Solana addresses matching a pattern

Usage:
  node vanity-grinder.js [options]

Options:
  --prefix, -p <str>    Address must start with this string
  --suffix, -s <str>    Address must end with this string
  --case-sensitive, -c  Match exact case (default: case insensitive)
  --workers, -w <num>   Number of worker threads (default: CPU cores)
  --help, -h            Show this help

Examples:
  node vanity-grinder.js --suffix launchr
  node vanity-grinder.js --prefix LAU --suffix chr
  node vanity-grinder.js --suffix pump --workers 8

Note: Solana addresses use base58 (no 0, O, I, l characters).
      Longer patterns take exponentially longer to find!
                    `);
                    process.exit(0);
                    break;
            }
        }

        return options;
    }

    // Run if called directly
    if (require.main === module) {
        const options = parseArgs();

        if (!options.prefix && !options.suffix) {
            console.log('Error: Must specify --prefix or --suffix (or both)');
            console.log('Use --help for usage information');
            process.exit(1);
        }

        const grinder = new VanityGrinder(options);
        grinder.start().catch(console.error);
    }

    module.exports = { VanityGrinder };
}
