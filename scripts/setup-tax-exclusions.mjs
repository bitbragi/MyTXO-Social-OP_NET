#!/usr/bin/env node
/**
 * Set tax exclusions on ScribeToken for system contracts.
 * Excludes: rewards, presale, faucet (deployer is excluded at deployment).
 *
 * Prerequisites:
 * - All contracts deployed, addresses in .env
 *
 * Usage: node opnet/scripts/setup-tax-exclusions.mjs
 */

import { readFileSync, existsSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { JSONRpcProvider, getContract, ABIDataTypes, BitcoinAbiTypes } from 'opnet';
import { networks } from '@btc-vision/bitcoin';
import { Wallet, Address } from '@btc-vision/transaction';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '../..');
const ENV_PATH = resolve(ROOT, '.env');

const SCRIBE_TOKEN_ABI = [
    {
        name: 'setTaxExcluded',
        type: BitcoinAbiTypes.Function,
        constant: false,
        payable: false,
        inputs: [
            { name: 'account', type: ABIDataTypes.ADDRESS },
            { name: 'excluded', type: ABIDataTypes.BOOL },
        ],
        outputs: [],
    },
];

function loadEnv() {
    if (!existsSync(ENV_PATH)) throw new Error('.env file not found');
    const vars = {};
    for (const line of readFileSync(ENV_PATH, 'utf-8').split('\n')) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#')) continue;
        const eq = trimmed.indexOf('=');
        if (eq > 0) vars[trimmed.slice(0, eq)] = trimmed.slice(eq + 1);
    }
    return vars;
}

async function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function main() {
    const env = loadEnv();
    const deployerKey = env.OPNET_DEPLOYER_KEY;
    const mldsaKey = env.OPNET_DEPLOYER_MLDSA;
    const tokenAddress = env.SCRIBE_TOKEN_ADDRESS;

    if (!deployerKey || !mldsaKey || !tokenAddress) {
        console.error('OPNET_DEPLOYER_KEY, OPNET_DEPLOYER_MLDSA, and SCRIBE_TOKEN_ADDRESS required.');
        process.exit(1);
    }

    const contractsToExclude = [];
    if (env.REWARDS_CONTRACT_ADDRESS) contractsToExclude.push({ name: 'Rewards', addr: env.REWARDS_CONTRACT_ADDRESS });
    if (env.PRESALE_CONTRACT_ADDRESS) contractsToExclude.push({ name: 'Presale', addr: env.PRESALE_CONTRACT_ADDRESS });
    if (env.FAUCET_CONTRACT_ADDRESS)  contractsToExclude.push({ name: 'Faucet',  addr: env.FAUCET_CONTRACT_ADDRESS });
    if (env.GOVERNANCE_CONTRACT_ADDRESS) contractsToExclude.push({ name: 'Governance', addr: env.GOVERNANCE_CONTRACT_ADDRESS });

    if (contractsToExclude.length === 0) {
        console.log('No contract addresses found in .env to exclude. Deploy contracts first.');
        process.exit(0);
    }

    const rpcUrl = env.OPNET_RPC_URL || 'https://testnet.opnet.org';
    console.log(`Connecting to OP_NET at ${rpcUrl}...`);

    const provider = new JSONRpcProvider({ url: rpcUrl, network: networks.opnetTestnet });
    const wallet = Wallet.fromPrivateKeys(deployerKey, mldsaKey, networks.opnetTestnet);

    const token = getContract(
        Address.fromString(tokenAddress),
        SCRIBE_TOKEN_ABI,
        provider,
        networks.opnetTestnet,
        wallet.address,
    );

    console.log(`\nSetting tax exclusions on ScribeToken (${tokenAddress}):`);

    for (const { name, addr } of contractsToExclude) {
        console.log(`\n  Excluding ${name}: ${addr}`);
        const targetAddr = Address.fromString(addr);

        const sim = await token.setTaxExcluded(targetAddr, true);
        if (sim.revert) {
            console.error(`  Simulation failed for ${name}: ${sim.revert}`);
            continue;
        }

        const receipt = await sim.sendTransaction({
            signer: wallet.keypair,
            mldsaSigner: wallet.mldsaKeypair,
            refundTo: wallet.p2tr,
            maximumAllowedSatToSpend: 50000n,
            feeRate: 1,
            network: networks.opnetTestnet,
        });

        console.log(`  TX: ${receipt.transactionId}`);
        await sleep(3_000);
    }

    console.log('\nAll exclusions set.');
    await provider.close();
}

main().catch(err => { console.error('Setup failed:', err.message || err); process.exit(1); });
