#!/usr/bin/env node
/**
 * Generate an OP_NET deployment wallet (testnet) with ECDSA + ML-DSA keys.
 * Outputs the P2TR address (opt1p...), WIF, and ML-DSA key, appends to .env.
 *
 * Usage: node opnet/scripts/generate-wallet.mjs
 */

import { Wallet } from '@btc-vision/transaction';
import { networks } from '@btc-vision/bitcoin';
import { readFileSync, writeFileSync, existsSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '../..');
const ENV_PATH = resolve(ROOT, '.env');

const NETWORK = networks.opnetTestnet;

const wallet = Wallet.generate(NETWORK);
const wif = wallet.toWIF();
const address = wallet.p2tr;
const mldsaKey = wallet.quantumPrivateKeyHex;

console.log('═'.repeat(60));
console.log('  OP_NET Deployment Wallet (Testnet)');
console.log('═'.repeat(60));
console.log('');
console.log(`  P2TR Address:     ${address}`);
console.log(`  WIF Key:          ${wif}`);
console.log(`  ML-DSA Key:       ${mldsaKey.slice(0, 20)}...${mldsaKey.slice(-20)} (${mldsaKey.length} chars)`);
console.log(`  Network:          opnetTestnet`);
console.log('');

if (existsSync(ENV_PATH)) {
  let envContent = readFileSync(ENV_PATH, 'utf-8');

  const keyRegex = /^OPNET_DEPLOYER_KEY=.*$/m;
  const addrRegex = /^OPNET_DEPLOYER_ADDRESS=.*$/m;
  const mldsaRegex = /^OPNET_DEPLOYER_MLDSA=.*$/m;

  if (keyRegex.test(envContent)) {
    envContent = envContent.replace(keyRegex, `OPNET_DEPLOYER_KEY=${wif}`);
    envContent = envContent.replace(addrRegex, `OPNET_DEPLOYER_ADDRESS=${address}`);
    envContent = envContent.replace(/# OP_NET Deployment Wallet \(.*?\)/, '# OP_NET Deployment Wallet (testnet)');
    if (mldsaRegex.test(envContent)) {
      envContent = envContent.replace(mldsaRegex, `OPNET_DEPLOYER_MLDSA=${mldsaKey}`);
    } else {
      envContent = envContent.replace(
        /^OPNET_DEPLOYER_ADDRESS=.*$/m,
        `OPNET_DEPLOYER_ADDRESS=${address}\nOPNET_DEPLOYER_MLDSA=${mldsaKey}`
      );
    }
    writeFileSync(ENV_PATH, envContent);
    console.log('  Replaced deployer keys in .env');
  } else {
    const addition = `\n# OP_NET Deployment Wallet (testnet)\nOPNET_DEPLOYER_KEY=${wif}\nOPNET_DEPLOYER_ADDRESS=${address}\nOPNET_DEPLOYER_MLDSA=${mldsaKey}\n`;
    writeFileSync(ENV_PATH, envContent + addition);
    console.log('  Added deployer keys to .env');
  }
} else {
  console.log('  No .env found — add these manually:');
  console.log(`  OPNET_DEPLOYER_KEY=${wif}`);
  console.log(`  OPNET_DEPLOYER_ADDRESS=${address}`);
  console.log(`  OPNET_DEPLOYER_MLDSA=${mldsaKey}`);
}

console.log('');
console.log('═'.repeat(60));
console.log('  NEXT: Send testnet BTC to the address above, then run:');
console.log('  node opnet/scripts/deploy.mjs');
console.log('═'.repeat(60));
