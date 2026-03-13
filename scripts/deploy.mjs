#!/usr/bin/env node
/**
 * Deploy MyScribe contracts to OP_NET testnet.
 *
 * Prerequisites:
 * 1. Run `node opnet/scripts/generate-wallet.mjs` to create a deployer wallet
 * 2. Send testnet BTC to the deployer address
 * 3. Build contracts: cd opnet/contracts && npm run build
 *
 * Usage:
 *   node opnet/scripts/deploy.mjs                    # Deploy all undeployed contracts
 *   node opnet/scripts/deploy.mjs --token-only       # Deploy only token
 *   node opnet/scripts/deploy.mjs --presale-only     # Deploy only presale
 *   node opnet/scripts/deploy.mjs --factory-only     # Deploy only factory
 *   node opnet/scripts/deploy.mjs --social-only      # Deploy only social
 *   node opnet/scripts/deploy.mjs --factory --social  # Deploy factory + social
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
        content += `${key}=${value}\n`;
    }
    writeFileSync(ENV_PATH, content);
}

async function sleep(ms) {
    return new Promise(r => setTimeout(r, ms));
}

async function waitForConfirmation(provider, txId, label, maxWait = 120_000) {
    console.log(`  Waiting for ${label} confirmation (txId: ${txId})...`);
    const start = Date.now();
    while (Date.now() - start < maxWait) {
        try {
            const receipt = await provider.getTransactionReceipt(txId);
            if (receipt) {
                console.log(`  ${label} confirmed!`);
                return receipt;
            }
        } catch { /* not yet */ }
        await sleep(5_000);
    }
    console.warn(`  ${label} not confirmed after ${maxWait / 1000}s — continuing anyway`);
    return null;
}

async function deployContract(provider, wallet, factory, wasmPath, label, calldata, utxoOverride) {
    console.log(`\n─── Deploying ${label} ───`);

    if (!existsSync(wasmPath)) {
        throw new Error(`WASM file not found: ${wasmPath}. Run 'npm run build' in opnet/contracts/ first.`);
    }

    const bytecode = new Uint8Array(readFileSync(wasmPath));
    console.log(`  Bytecode size: ${bytecode.length} bytes`);

    const utxos = utxoOverride || await provider.utxoManager.getUTXOs({
        address: wallet.p2tr,
    });
    console.log(`  UTXOs available: ${utxos.length}`);

    if (utxos.length === 0) {
        throw new Error(`No UTXOs for ${wallet.p2tr}. Send testnet BTC to this address first.`);
    }

    const challenge = await provider.getChallenge();

    const deploymentParams = {
        signer: wallet.keypair,
        mldsaSigner: wallet.mldsaKeypair,
        network: networks.opnetTestnet,
        from: wallet.p2tr,
        utxos,
        bytecode,
        calldata,
        challenge,
        feeRate: 5,
        priorityFee: 0n,
        gasSatFee: 10_000n,
        linkMLDSAPublicKeyToAddress: true,
        revealMLDSAPublicKey: true,
    };

    console.log(`  Signing deployment transaction...`);
    const deployment = await factory.signDeployment(deploymentParams);

    console.log(`  Broadcasting funding tx...`);
    const fundingResult = await provider.sendRawTransaction(deployment.transaction[0], false);
    if (!fundingResult || !fundingResult.success) {
        throw new Error(`Funding tx failed: ${fundingResult?.error || fundingResult?.result || 'Unknown error'}`);
    }
    const fundingTxId = fundingResult.result;
    console.log(`  Funding tx: ${fundingTxId}`);

    console.log(`  Broadcasting reveal tx...`);
    const revealResult = await provider.sendRawTransaction(deployment.transaction[1], false);
    if (!revealResult || !revealResult.success) {
        throw new Error(`Reveal tx failed: ${revealResult?.error || revealResult?.result || 'Unknown error'}`);
    }
    const revealTxId = revealResult.result;
    console.log(`  Reveal tx: ${revealTxId}`);

    const contractP2op = deployment.contractAddress;
    const contractHex = deployment.contractPubKey;
    console.log(`  ${label} contract address (P2OP): ${contractP2op}`);
    console.log(`  ${label} contract address (hex):  ${contractHex}`);

    return { fundingTxId, revealTxId, contractAddress: contractHex, contractP2op, utxos: deployment.utxos };
}

function parseFlags(args) {
    const has = (flag) => args.includes(flag);
    const explicit = has('--token-only') || has('--presale-only') ||
        has('--factory-only') || has('--social-only') ||
        has('--token') || has('--presale') || has('--factory') || has('--social');

    return {
        token:    explicit ? (has('--token-only') || has('--token')) : true,
        presale:  explicit ? (has('--presale-only') || has('--presale')) : true,
        factory:  explicit ? (has('--factory-only') || has('--factory')) : true,
        social:   explicit ? (has('--social-only') || has('--social')) : true,
    };
}

async function main() {
    const flags = parseFlags(process.argv.slice(2));

    const env = loadEnv();
    const deployerKey = env.OPNET_DEPLOYER_KEY;
    const mldsaKey = env.OPNET_DEPLOYER_MLDSA;
    if (!deployerKey) {
        console.error('OPNET_DEPLOYER_KEY not set in .env. Run generate-wallet.mjs first.');
        process.exit(1);
    }
    if (!mldsaKey) {
        console.error('OPNET_DEPLOYER_MLDSA not set in .env. Regenerate wallet with generate-wallet.mjs.');
        process.exit(1);
    }

    const rpcUrl = env.OPNET_RPC_URL || 'https://testnet.opnet.org';
    console.log(`Connecting to OP_NET at ${rpcUrl}...`);

    const provider = new JSONRpcProvider({ url: rpcUrl, network: networks.opnetTestnet });
    const wallet = Wallet.fromPrivateKeys(deployerKey, mldsaKey, networks.opnetTestnet);
    const factory = new TransactionFactory();

    console.log(`Deployer address: ${wallet.p2tr}`);

    const balance = await provider.getBalance(wallet.p2tr);
    console.log(`Deployer confirmed balance: ${balance} sats`);

    const checkUtxos = await provider.utxoManager.getUTXOs({ address: wallet.p2tr });
    const utxoTotal = checkUtxos.reduce((sum, u) => sum + BigInt(u.value), 0n);
    console.log(`UTXOs: ${checkUtxos.length} (total: ${utxoTotal} sats)`);

    if (checkUtxos.length === 0) {
        console.error('No UTXOs available. Send testnet BTC to the deployer address first.');
        process.exit(1);
    }

    let tokenAddress = env.SCRIBE_TOKEN_ADDRESS;
    let presaleAddress = env.PRESALE_CONTRACT_ADDRESS;
    let factoryAddress = env.FACTORY_CONTRACT_ADDRESS;
    let socialAddress = env.SOCIAL_CONTRACT_ADDRESS;
    let nextUtxos = null;

    // ── Token ────────────────────────────────────────────────────────────
    if (flags.token && !tokenAddress) {
        const tokenWasm = resolve(CONTRACTS_DIR, 'ScribeToken.wasm');
        const tokenResult = await deployContract(provider, wallet, factory, tokenWasm, 'ScribeToken');
        tokenAddress = tokenResult.contractAddress;
        nextUtxos = tokenResult.utxos;
        appendEnv('SCRIBE_TOKEN_ADDRESS', tokenAddress);
        appendEnv('SCRIBE_TOKEN_P2OP', tokenResult.contractP2op);
        console.log(`  Saved SCRIBE_TOKEN_ADDRESS=${tokenAddress} to .env`);
        await waitForConfirmation(provider, tokenResult.revealTxId, 'ScribeToken');
    } else if (flags.token && tokenAddress) {
        console.log(`\n─── ScribeToken already deployed: ${tokenAddress} ───`);
    }

    // ── Presale ──────────────────────────────────────────────────────────
    if (flags.presale && !presaleAddress) {
        if (!tokenAddress) {
            console.error('SCRIBE_TOKEN_ADDRESS not set. Deploy the token first or set it in .env.');
            process.exit(1);
        }

        // Round 1: 275k sats, ~91 tokens/sat, 50k max per address
        const presaleCalldata = new BinaryWriter();
        presaleCalldata.writeAddress(wallet.address);
        presaleCalldata.writeAddress(Address.fromString(tokenAddress));
        presaleCalldata.writeU256(91n * 10n**18n);
        presaleCalldata.writeU256(50_000n);
        presaleCalldata.writeU256(275_000n);
        presaleCalldata.writeU256(1n);
        presaleCalldata.writeStringWithLength(wallet.p2tr);

        const presaleWasm = resolve(CONTRACTS_DIR, 'ScribePresale.wasm');
        const presaleResult = await deployContract(
            provider, wallet, factory, presaleWasm, 'ScribePresale',
            presaleCalldata.getBuffer(), nextUtxos
        );
        presaleAddress = presaleResult.contractAddress;
        nextUtxos = presaleResult.utxos;
        appendEnv('PRESALE_CONTRACT_ADDRESS', presaleAddress);
        appendEnv('PRESALE_CONTRACT_P2OP', presaleResult.contractP2op);
        appendEnv('NEXT_PUBLIC_PRESALE_ADDRESS', presaleAddress);
        console.log(`  Saved PRESALE_CONTRACT_ADDRESS=${presaleAddress} to .env`);
        await waitForConfirmation(provider, presaleResult.revealTxId, 'ScribePresale');
    } else if (flags.presale && presaleAddress) {
        console.log(`\n─── ScribePresale already deployed: ${presaleAddress} ───`);
    }

    // ── Factory ──────────────────────────────────────────────────────────
    if (flags.factory && !factoryAddress) {
        const factoryCalldata = new BinaryWriter();
        factoryCalldata.writeAddress(wallet.address);

        const factoryWasm = resolve(CONTRACTS_DIR, 'MyScribeFactory.wasm');
        const factoryResult = await deployContract(
            provider, wallet, factory, factoryWasm, 'MyScribeFactory',
            factoryCalldata.getBuffer(), nextUtxos
        );
        factoryAddress = factoryResult.contractAddress;
        nextUtxos = factoryResult.utxos;
        appendEnv('FACTORY_CONTRACT_ADDRESS', factoryAddress);
        appendEnv('FACTORY_CONTRACT_P2OP', factoryResult.contractP2op);
        appendEnv('NEXT_PUBLIC_FACTORY_ADDRESS', factoryAddress);
        console.log(`  Saved FACTORY_CONTRACT_ADDRESS=${factoryAddress} to .env`);
        await waitForConfirmation(provider, factoryResult.revealTxId, 'MyScribeFactory');
    } else if (flags.factory && factoryAddress) {
        console.log(`\n─── MyScribeFactory already deployed: ${factoryAddress} ───`);
    }

    // ── Social ───────────────────────────────────────────────────────────
    if (flags.social && !socialAddress) {
        const socialCalldata = new BinaryWriter();
        socialCalldata.writeAddress(wallet.address);

        const socialWasm = resolve(CONTRACTS_DIR, 'MyScribeSocial.wasm');
        const socialResult = await deployContract(
            provider, wallet, factory, socialWasm, 'MyScribeSocial',
            socialCalldata.getBuffer(), nextUtxos
        );
        socialAddress = socialResult.contractAddress;
        nextUtxos = socialResult.utxos;
        appendEnv('SOCIAL_CONTRACT_ADDRESS', socialAddress);
        appendEnv('SOCIAL_CONTRACT_P2OP', socialResult.contractP2op);
        appendEnv('NEXT_PUBLIC_SOCIAL_ADDRESS', socialAddress);
        console.log(`  Saved SOCIAL_CONTRACT_ADDRESS=${socialAddress} to .env`);
        await waitForConfirmation(provider, socialResult.revealTxId, 'MyScribeSocial');
    } else if (flags.social && socialAddress) {
        console.log(`\n─── MyScribeSocial already deployed: ${socialAddress} ───`);
    }

    console.log('\n═══════════════════════════════════════════════');
    console.log('  Deployment Summary');
    console.log('═══════════════════════════════════════════════');
    console.log(`  Token:    ${tokenAddress || 'not deployed'}`);
    console.log(`  Presale:  ${presaleAddress || 'not deployed'}`);
    console.log(`  Factory:  ${factoryAddress || 'not deployed'}`);
    console.log(`  Social:   ${socialAddress || 'not deployed'}`);
    console.log(`  Network:  opnetTestnet`);
    console.log('');
    console.log('  Per-user Profile contracts are deployed from the frontend.');
    console.log('  Profile WASM path: opnet/contracts/build/MyScribeProfile.wasm');
    console.log('');
    console.log('  NEXT STEPS:');
    console.log('  1. Rebuild the frontend: npm run dev');
    console.log('  2. Test registration at myscribe.org/register');
    console.log('═══════════════════════════════════════════════');
}

main().catch(err => {
    console.error('Deploy failed:', err.message || err);
    console.error(err.stack);
    process.exit(1);
});
