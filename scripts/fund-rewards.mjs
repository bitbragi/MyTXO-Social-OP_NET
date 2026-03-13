#!/usr/bin/env node
/**
 * Transfer 15% of SCRIBE supply (3.15B tokens) from deployer to ScribeRewards.
 *
 * Prerequisites:
 * - Token + Rewards contracts deployed
 * - .env has OPNET_DEPLOYER_KEY, OPNET_DEPLOYER_MLDSA, SCRIBE_TOKEN_ADDRESS, REWARDS_CONTRACT_ADDRESS
 *
 * Usage: node opnet/scripts/fund-rewards.mjs [amount_in_tokens]
 * Default: 3_150_000_000 (15% of 21B)
 */

import { readFileSync, existsSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { JSONRpcProvider, getContract, OP_20_ABI } from 'opnet';
import { networks } from '@btc-vision/bitcoin';
import { Wallet, Address } from '@btc-vision/transaction';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '../..');
const ENV_PATH = resolve(ROOT, '.env');

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

async function main() {
    const DECIMALS = 18n;
    const raw = BigInt(process.argv[2] || '3150000000'); // 15% of 21B
    const amount = raw * 10n**DECIMALS;

    const env = loadEnv();
    const deployerKey = env.OPNET_DEPLOYER_KEY;
    const mldsaKey = env.OPNET_DEPLOYER_MLDSA;
    const tokenAddress = env.SCRIBE_TOKEN_ADDRESS;
    const rewardsAddress = env.REWARDS_CONTRACT_ADDRESS;

    if (!deployerKey || !mldsaKey) {
        console.error('OPNET_DEPLOYER_KEY and OPNET_DEPLOYER_MLDSA required.');
        process.exit(1);
    }
    if (!tokenAddress || !rewardsAddress) {
        console.error('SCRIBE_TOKEN_ADDRESS and REWARDS_CONTRACT_ADDRESS required.');
        process.exit(1);
    }

    const rpcUrl = env.OPNET_RPC_URL || 'https://testnet.opnet.org';
    console.log(`Connecting to OP_NET at ${rpcUrl}...`);

    const provider = new JSONRpcProvider({ url: rpcUrl, network: networks.opnetTestnet });
    const wallet = Wallet.fromPrivateKeys(deployerKey, mldsaKey, networks.opnetTestnet);

    const token = getContract(
        Address.fromString(tokenAddress),
        OP_20_ABI,
        provider,
        networks.opnetTestnet,
        wallet.address,
    );

    const rewardsAddr = Address.fromString(rewardsAddress);
    console.log(`Transferring ${raw.toLocaleString()} SCRIBE to rewards ${rewardsAddress}...`);

    const sim = await token.transfer(rewardsAddr, amount);
    if (sim.revert) {
        console.error('Simulation failed:', sim.revert);
        process.exit(1);
    }

    const receipt = await sim.sendTransaction({
        signer: wallet.keypair,
        mldsaSigner: wallet.mldsaKeypair,
        refundTo: wallet.p2tr,
        maximumAllowedSatToSpend: 50000n,
        feeRate: 1,
        network: networks.opnetTestnet,
    });

    console.log(`Transfer tx: ${receipt.transactionId}`);
    console.log(`Done. Rewards pool funded with ${raw.toLocaleString()} SCRIBE (15% of supply).`);
    await provider.close();
}

main().catch(err => { console.error('Fund failed:', err.message || err); process.exit(1); });
