#!/usr/bin/env node
/**
 * Transfer SCRIBE tokens from deployer to presale contract.
 *
 * Prerequisites:
 * - Deployer wallet funded with tBTC
 * - Token and presale contracts deployed
 * - .env has OPNET_DEPLOYER_KEY, OPNET_DEPLOYER_MLDSA, SCRIBE_TOKEN_ADDRESS, PRESALE_CONTRACT_ADDRESS
 *
 * Usage: node opnet/scripts/fund-presale.mjs [amount]
 * Default amount: 1_000_000 (1M tokens for round 0)
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
    const raw = BigInt(process.argv[2] || '1000000');
    const amount = raw * 10n**DECIMALS;
    const env = loadEnv();
    const deployerKey = env.OPNET_DEPLOYER_KEY;
    const mldsaKey = env.OPNET_DEPLOYER_MLDSA;
    const tokenAddress = env.SCRIBE_TOKEN_ADDRESS;
    const presaleAddress = env.PRESALE_CONTRACT_ADDRESS;

    if (!deployerKey || !mldsaKey) {
        console.error('OPNET_DEPLOYER_KEY and OPNET_DEPLOYER_MLDSA required in .env');
        process.exit(1);
    }
    if (!tokenAddress || !presaleAddress) {
        console.error('SCRIBE_TOKEN_ADDRESS and PRESALE_CONTRACT_ADDRESS required in .env');
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
        wallet.address
    );

    const presaleAddr = Address.fromString(presaleAddress);
    console.log(`Transferring ${amount} SCRIBE to presale ${presaleAddress}...`);

    const sim = await token.transfer(presaleAddr, amount);
    if (sim.revert) {
        console.error('Simulation failed:', sim.revert);
        process.exit(1);
    }

    const utxos = await provider.utxoManager.getUTXOs({ address: wallet.p2tr });
    if (utxos.length === 0) {
        console.error('No UTXOs. Fund deployer first.');
        process.exit(1);
    }

    const receipt = await sim.sendTransaction({
        signer: wallet.keypair,
        mldsaSigner: wallet.mldsaKeypair,
        refundTo: wallet.p2tr,
        maximumAllowedSatToSpend: 50000n,
        feeRate: 1, // 1 sat/vB for testnet
        network: networks.opnetTestnet,
    });

    console.log(`Transfer tx: ${receipt.transactionId}`);
    console.log('Done. Presale is funded.');
    await provider.close();
}

main().catch((err) => {
    console.error('Fund failed:', err.message || err);
    process.exit(1);
});
