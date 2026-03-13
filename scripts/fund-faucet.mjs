#!/usr/bin/env node
/**
 * Fund the ScribeFaucet contract with SCRIBE tokens.
 *
 * Transfers tokens from the deployer's wallet to the faucet contract address
 * so users can start claiming. Anyone with SCRIBE tokens can also send them
 * directly to the faucet's P2OP address via a standard OP20 transfer.
 *
 * Prerequisites:
 * - Deployer wallet funded with tBTC
 * - Token and faucet contracts deployed
 * - .env has: OPNET_DEPLOYER_KEY, OPNET_DEPLOYER_MLDSA,
 *             SCRIBE_TOKEN_ADDRESS, FAUCET_CONTRACT_ADDRESS
 *
 * Usage:
 *   node opnet/scripts/fund-faucet.mjs           # default: 1,000,000 SCRIBE
 *   node opnet/scripts/fund-faucet.mjs 500000    # custom amount (no decimals)
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
    const rawAmount = BigInt(process.argv[2] || '1000000');
    const amount = rawAmount * 10n ** DECIMALS;

    const env = loadEnv();
    const deployerKey = env.OPNET_DEPLOYER_KEY;
    const mldsaKey = env.OPNET_DEPLOYER_MLDSA;
    const tokenAddress = env.SCRIBE_TOKEN_ADDRESS;
    const faucetAddress = env.FAUCET_CONTRACT_ADDRESS;

    if (!deployerKey || !mldsaKey) {
        console.error('OPNET_DEPLOYER_KEY and OPNET_DEPLOYER_MLDSA required in .env');
        process.exit(1);
    }
    if (!tokenAddress) {
        console.error('SCRIBE_TOKEN_ADDRESS required in .env');
        process.exit(1);
    }
    if (!faucetAddress) {
        console.error('FAUCET_CONTRACT_ADDRESS required in .env. Deploy the faucet first.');
        process.exit(1);
    }

    const rpcUrl = env.OPNET_RPC_URL || 'https://testnet.opnet.org';
    console.log(`Connecting to OP_NET at ${rpcUrl}...`);

    const provider = new JSONRpcProvider({ url: rpcUrl, network: networks.opnetTestnet });
    const wallet = Wallet.fromPrivateKeys(deployerKey, mldsaKey, networks.opnetTestnet);

    console.log(`Deployer: ${wallet.p2tr}`);
    console.log(`Faucet:   ${faucetAddress}`);
    console.log(`Amount:   ${rawAmount.toLocaleString()} SCRIBE (${amount} raw)`);

    const token = getContract(
        Address.fromString(tokenAddress),
        OP_20_ABI,
        provider,
        networks.opnetTestnet,
        wallet.address,
    );

    const faucetAddr = Address.fromString(faucetAddress);

    const sim = await token.transfer(faucetAddr, amount);
    if (sim.revert) {
        console.error('Simulation failed:', sim.revert);
        process.exit(1);
    }

    const utxos = await provider.utxoManager.getUTXOs({ address: wallet.p2tr });
    if (utxos.length === 0) {
        console.error('No UTXOs. Fund deployer wallet with testnet BTC first.');
        process.exit(1);
    }

    const receipt = await sim.sendTransaction({
        signer: wallet.keypair,
        mldsaSigner: wallet.mldsaKeypair,
        refundTo: wallet.p2tr,
        maximumAllowedSatToSpend: 50_000n,
        feeRate: 1,
        network: networks.opnetTestnet,
    });

    console.log(`\nTransfer tx: ${receipt.transactionId}`);
    console.log(`Faucet funded with ${rawAmount.toLocaleString()} SCRIBE.`);
    console.log('\nUsers can also donate directly by transferring SCRIBE to:');
    console.log(`  ${faucetAddress}`);

    await provider.close();
}

main().catch(err => {
    console.error('Fund failed:', err.message || err);
    process.exit(1);
});
