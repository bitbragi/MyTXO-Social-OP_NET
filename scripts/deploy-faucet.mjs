#!/usr/bin/env node
/**
 * Deploy ScribeFaucet to OP_NET testnet.
 *
 * Prerequisites:
 * 1. Run `node opnet/scripts/generate-wallet.mjs` (if not done)
 * 2. Send testnet BTC to the deployer address
 * 3. Build faucet contract: cd opnet/contracts && npm run build:faucet
 * 4. Token and Registry contracts must already be deployed (.env must have
 *    SCRIBE_TOKEN_ADDRESS and REGISTRY_CONTRACT_ADDRESS)
 *
 * Usage:
 *   node opnet/scripts/deploy-faucet.mjs
 *
 * Env vars written on success:
 *   FAUCET_CONTRACT_ADDRESS   — hex pubkey (used for cross-contract calls)
 *   FAUCET_CONTRACT_P2OP      — P2OP address (human-readable)
 *   NEXT_PUBLIC_FAUCET_ADDRESS — exposed to frontend
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
const CONTRACTS_DIR = resolve(__dirname, '../contracts/build');

// Faucet parameters — adjust as needed
const CLAIM_AMOUNT_SCRIBE = 1_000n;                     // 1,000 SCRIBE per claim
const CLAIM_AMOUNT_RAW = CLAIM_AMOUNT_SCRIBE * 10n**18n; // scaled to 18 decimals
const COOLDOWN_BLOCKS = 36n;                             // ~6 hours at 10 min/block

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

async function sleep(ms) {
    return new Promise(r => setTimeout(r, ms));
}

async function waitForConfirmation(provider, txId, label, maxWait = 120_000) {
    console.log(`  Waiting for ${label} (txId: ${txId})...`);
    const start = Date.now();
    while (Date.now() - start < maxWait) {
        try {
            const receipt = await provider.getTransactionReceipt(txId);
            if (receipt) {
                console.log(`  ✓ ${label} confirmed!`);
                return receipt;
            }
        } catch { /* not yet */ }
        await sleep(5_000);
    }
    console.warn(`  ${label} not confirmed after ${maxWait / 1000}s — continuing anyway`);
    return null;
}

async function main() {
    const env = loadEnv();

    const deployerKey = env.OPNET_DEPLOYER_KEY;
    const mldsaKey = env.OPNET_DEPLOYER_MLDSA;
    if (!deployerKey) {
        console.error('OPNET_DEPLOYER_KEY not set in .env. Run generate-wallet.mjs first.');
        process.exit(1);
    }
    if (!mldsaKey) {
        console.error('OPNET_DEPLOYER_MLDSA not set in .env. Run generate-wallet.mjs first.');
        process.exit(1);
    }

    const tokenAddress = env.SCRIBE_TOKEN_ADDRESS;
    const registryAddress = env.REGISTRY_CONTRACT_ADDRESS;
    if (!tokenAddress) {
        console.error('SCRIBE_TOKEN_ADDRESS not set in .env. Deploy the token first.');
        process.exit(1);
    }
    if (!registryAddress) {
        console.error('REGISTRY_CONTRACT_ADDRESS not set in .env. Deploy the registry first.');
        process.exit(1);
    }

    if (env.FAUCET_CONTRACT_ADDRESS) {
        console.log(`\nFaucet already deployed: ${env.FAUCET_CONTRACT_ADDRESS}`);
        console.log('Remove FAUCET_CONTRACT_ADDRESS from .env to redeploy.');
        process.exit(0);
    }

    const faucetWasm = resolve(CONTRACTS_DIR, 'ScribeFaucet.wasm');
    if (!existsSync(faucetWasm)) {
        console.error(`WASM not found: ${faucetWasm}`);
        console.error("Run 'npm run build:faucet' in opnet/contracts/ first.");
        process.exit(1);
    }

    const rpcUrl = env.OPNET_RPC_URL || 'https://testnet.opnet.org';
    console.log(`\nConnecting to OP_NET at ${rpcUrl}...`);

    const provider = new JSONRpcProvider({ url: rpcUrl, network: networks.opnetTestnet });
    const wallet = Wallet.fromPrivateKeys(deployerKey, mldsaKey, networks.opnetTestnet);
    const factory = new TransactionFactory();

    console.log(`Deployer address: ${wallet.p2tr}`);

    const utxos = await provider.utxoManager.getUTXOs({ address: wallet.p2tr });
    const utxoTotal = utxos.reduce((sum, u) => sum + BigInt(u.value), 0n);
    console.log(`UTXOs: ${utxos.length} (total: ${utxoTotal} sats)`);

    if (utxos.length === 0) {
        console.error('No UTXOs. Fund the deployer address with testnet BTC first.');
        process.exit(1);
    }

    // Build constructor calldata:
    //   owner          (address) — deployer
    //   tokenAddress   (address) — MyScribe OP20
    //   registryAddress(address) — MyScribeRegistry (for future registeredOnly checks)
    //   claimAmount    (u256)    — 1000 × 10^18
    //   cooldownBlocks (u256)    — 36 blocks ≈ 6h
    const calldata = new BinaryWriter();
    calldata.writeAddress(wallet.address);
    calldata.writeAddress(Address.fromString(tokenAddress));
    calldata.writeAddress(Address.fromString(registryAddress));
    calldata.writeU256(CLAIM_AMOUNT_RAW);
    calldata.writeU256(COOLDOWN_BLOCKS);

    const calldataBytes = calldata.getBuffer();
    console.log(`\nConstructor calldata: ${calldataBytes.length} bytes`);
    if (calldataBytes.length === 513) {
        console.error('CRITICAL: Calldata is exactly 513 bytes — known OPNet node bug!');
        console.error('Adjust CLAIM_AMOUNT_SCRIBE or COOLDOWN_BLOCKS slightly to change the size.');
        process.exit(1);
    }

    const bytecode = new Uint8Array(readFileSync(faucetWasm));
    console.log(`Bytecode size: ${bytecode.length} bytes`);

    const challenge = await provider.getChallenge();

    console.log('\n─── Deploying ScribeFaucet ───');
    const deployment = await factory.signDeployment({
        signer: wallet.keypair,
        mldsaSigner: wallet.mldsaKeypair,
        network: networks.opnetTestnet,
        from: wallet.p2tr,
        utxos,
        bytecode,
        calldata: calldataBytes,
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
        throw new Error(`Funding tx failed: ${fundingResult?.error || fundingResult?.result || 'Unknown'}`);
    }
    console.log(`  Funding tx: ${fundingResult.result}`);

    console.log('Broadcasting reveal tx...');
    const revealResult = await provider.sendRawTransaction(deployment.transaction[1], false);
    if (!revealResult?.success) {
        throw new Error(`Reveal tx failed: ${revealResult?.error || revealResult?.result || 'Unknown'}`);
    }
    console.log(`  Reveal tx: ${revealResult.result}`);

    const contractHex = deployment.contractPubKey;
    const contractP2op = deployment.contractAddress;
    console.log(`\nFaucet contract address (P2OP): ${contractP2op}`);
    console.log(`Faucet contract address (hex):  ${contractHex}`);

    appendEnv('FAUCET_CONTRACT_ADDRESS', contractHex);
    appendEnv('FAUCET_CONTRACT_P2OP', contractP2op);
    appendEnv('NEXT_PUBLIC_FAUCET_ADDRESS', contractHex);
    appendEnv('NEXT_PUBLIC_FAUCET_P2OP', contractP2op);
    console.log('\nAddresses saved to .env');

    await waitForConfirmation(provider, revealResult.result, 'ScribeFaucet deployment');

    console.log('\n═══════════════════════════════════════════════');
    console.log('  ScribeFaucet deployed successfully!');
    console.log('═══════════════════════════════════════════════');
    console.log(`  Contract (hex):  ${contractHex}`);
    console.log(`  Contract (P2OP): ${contractP2op}`);
    console.log(`  Claim amount:    ${CLAIM_AMOUNT_SCRIBE.toLocaleString()} SCRIBE`);
    console.log(`  Cooldown:        ${COOLDOWN_BLOCKS} blocks (~6 hours)`);
    console.log('');
    console.log('  NEXT STEPS:');
    console.log('  1. Fund the faucet: node opnet/scripts/fund-faucet.mjs');
    console.log('  2. Restart the app: docker compose up -d --build app');
    console.log('═══════════════════════════════════════════════');

    await provider.close();
}

main().catch(err => {
    console.error('Deploy failed:', err.message || err);
    console.error(err.stack);
    process.exit(1);
});
