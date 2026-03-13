#!/usr/bin/env node
/**
 * Deploy ScribeGovernance to OP_NET testnet.
 *
 * Prerequisites:
 * 1. Deployer wallet funded with tBTC
 * 2. ScribeToken deployed (SCRIBE_TOKEN_ADDRESS in .env)
 * 3. Build: cd opnet/contracts && npm run build
 *
 * Usage: node opnet/scripts/deploy-governance.mjs
 *
 * Env vars written:
 *   GOVERNANCE_CONTRACT_ADDRESS, GOVERNANCE_CONTRACT_P2OP, NEXT_PUBLIC_GOVERNANCE_ADDRESS
 */

import { readFileSync, writeFileSync, existsSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { JSONRpcProvider } from 'opnet';
import { networks } from '@btc-vision/bitcoin';
import { TransactionFactory, Wallet, BinaryWriter, Address } from '@btc-vision/transaction';

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

function appendEnv(key, value) {
    let content = readFileSync(ENV_PATH, 'utf-8');
    const regex = new RegExp(`^${key}=.*$`, 'm');
    if (regex.test(content)) {
        content = content.replace(regex, `${key}=${value}`);
    } else {
        content += `\n${key}=${value}`;
    }
    writeFileSync(ENV_PATH, content);
}

async function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function waitForConfirmation(provider, txId, label, maxWait = 120_000) {
    console.log(`  Waiting for ${label} (txId: ${txId})...`);
    const start = Date.now();
    while (Date.now() - start < maxWait) {
        try {
            const receipt = await provider.getTransactionReceipt(txId);
            if (receipt) { console.log(`  ${label} confirmed!`); return receipt; }
        } catch { /* not yet */ }
        await sleep(5_000);
    }
    console.warn(`  ${label} not confirmed after ${maxWait / 1000}s — continuing`);
    return null;
}

async function main() {
    const env = loadEnv();
    const deployerKey = env.OPNET_DEPLOYER_KEY;
    const mldsaKey = env.OPNET_DEPLOYER_MLDSA;
    const tokenAddress = env.SCRIBE_TOKEN_ADDRESS;

    if (!deployerKey || !mldsaKey) {
        console.error('OPNET_DEPLOYER_KEY and OPNET_DEPLOYER_MLDSA required.');
        process.exit(1);
    }
    if (!tokenAddress) {
        console.error('SCRIBE_TOKEN_ADDRESS not set. Deploy the token first.');
        process.exit(1);
    }
    if (env.GOVERNANCE_CONTRACT_ADDRESS) {
        console.log(`Governance already deployed: ${env.GOVERNANCE_CONTRACT_ADDRESS}`);
        console.log('Remove GOVERNANCE_CONTRACT_ADDRESS from .env to redeploy.');
        process.exit(0);
    }

    const wasmPath = resolve(__dirname, '../contracts/build/ScribeGovernance.wasm');
    if (!existsSync(wasmPath)) {
        console.error(`WASM not found: ${wasmPath}. Build contracts first.`);
        process.exit(1);
    }

    const rpcUrl = env.OPNET_RPC_URL || 'https://testnet.opnet.org';
    console.log(`Connecting to OP_NET at ${rpcUrl}...`);

    const provider = new JSONRpcProvider({ url: rpcUrl, network: networks.opnetTestnet });
    const wallet = Wallet.fromPrivateKeys(deployerKey, mldsaKey, networks.opnetTestnet);
    const factory = new TransactionFactory();

    console.log(`Deployer: ${wallet.p2tr}`);

    const utxos = await provider.utxoManager.getUTXOs({ address: wallet.p2tr });
    if (utxos.length === 0) {
        console.error('No UTXOs. Fund deployer first.');
        process.exit(1);
    }

    // Calldata: owner (address), tokenAddress (address)
    const calldata = new BinaryWriter();
    calldata.writeAddress(wallet.address);
    calldata.writeAddress(Address.fromString(tokenAddress));

    const bytecode = new Uint8Array(readFileSync(wasmPath));
    const challenge = await provider.getChallenge();

    console.log('\n--- Deploying ScribeGovernance ---');
    const deployment = await factory.signDeployment({
        signer: wallet.keypair,
        mldsaSigner: wallet.mldsaKeypair,
        network: networks.opnetTestnet,
        from: wallet.p2tr,
        utxos,
        bytecode,
        calldata: calldata.getBuffer(),
        challenge,
        feeRate: 5,
        priorityFee: 0n,
        gasSatFee: 10_000n,
        linkMLDSAPublicKeyToAddress: true,
        revealMLDSAPublicKey: true,
    });

    console.log('Broadcasting funding tx...');
    const fundingResult = await provider.sendRawTransaction(deployment.transaction[0], false);
    if (!fundingResult?.success) {
        throw new Error(`Funding tx failed: ${fundingResult?.error || fundingResult?.result}`);
    }
    console.log(`  Funding tx: ${fundingResult.result}`);

    console.log('Broadcasting reveal tx...');
    const revealResult = await provider.sendRawTransaction(deployment.transaction[1], false);
    if (!revealResult?.success) {
        throw new Error(`Reveal tx failed: ${revealResult?.error || revealResult?.result}`);
    }
    console.log(`  Reveal tx: ${revealResult.result}`);

    const contractHex = deployment.contractPubKey;
    const contractP2op = deployment.contractAddress;

    appendEnv('GOVERNANCE_CONTRACT_ADDRESS', contractHex);
    appendEnv('GOVERNANCE_CONTRACT_P2OP', contractP2op);
    appendEnv('NEXT_PUBLIC_GOVERNANCE_ADDRESS', contractHex);

    await waitForConfirmation(provider, revealResult.result, 'ScribeGovernance deployment');

    console.log('\n===============================================');
    console.log('  ScribeGovernance deployed!');
    console.log(`  Contract (hex):  ${contractHex}`);
    console.log(`  Contract (P2OP): ${contractP2op}`);
    console.log('===============================================');

    await provider.close();
}

main().catch(err => { console.error('Deploy failed:', err.message || err); process.exit(1); });
