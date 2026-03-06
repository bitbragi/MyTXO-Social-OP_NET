# MyTXO Social -- OPNet Smart Contracts

**A decentralized social platform where every profile is a smart contract on Bitcoin L1.**

Live testnet: **[testnet.mytxo.space](https://testnet.mytxo.space)**

---

## What is MyTXO?

MyTXO is a fully on-chain social network built on [OPNet](https://opnet.org) -- Bitcoin L1 smart contracts using Tapscript-encoded calldata. There is no database. Every user deploys their own OP721 smart contract, every post is an NFT, and every social interaction is recorded immutably on Bitcoin.

This repository contains the **smart contract layer** -- six AssemblyScript contracts that power the platform. The full-stack application (Next.js frontend, wallet integration, feed scanning, inscription flows) lives in a separate private repository and is available at the live testnet link above.

## Contract Architecture

```
                    ┌──────────────────────────┐
                    │      MyTXOFactory         │
                    │  Username registry        │
                    │  Wallet -> Profile lookup  │
                    │  Profile count tracking    │
                    └────────────┬───────────────┘
                                 │ deploys & registers
                    ┌────────────▼───────────────┐
                    │    MyTXOProfile (per-user)  │
                    │    OP721 NFT contract       │
                    │    Token #0: Creator Card   │
                    │    Token #1+: Blurbs        │
                    │    Token #N+: Guestbook     │
                    │    On-chain tokenURI()      │
                    └────────────────────────────┘
                                 │
                    ┌────────────▼───────────────┐
                    │      MyTXOSocial           │
                    │  Bidirectional friendships  │
                    │  Re-NFTs (social minting)   │
                    │  Top 8 friends list         │
                    │  Background inscriptions    │
                    │  Legend Score computation    │
                    └────────────────────────────┘
                                 │
           ┌─────────────────────┼─────────────────────┐
           │                     │                     │
  ┌────────▼────────┐  ┌────────▼────────┐  ┌────────▼────────┐
  │   MytxoToken     │  │  MytxoPresale   │  │   MytxoFaucet   │
  │   OP_20 token    │  │  BTC presale    │  │  Token faucet   │
  │   21B supply     │  │  Cap enforcement│  │  Cooldown-based │
  └─────────────────┘  └─────────────────┘  └─────────────────┘
```

## Contracts

### MyTXOFactory (`contracts/src/factory/`)

Global username registry and profile directory. Maps usernames (packed as u256 keys) to profile contract addresses, and wallet addresses to deployed profile contracts. All lookups are O(1) via `StoredMapU256`.

**Write methods:** `register`, `unregister`
**View methods:** `resolveUsername`, `resolveAddress`, `getUsernameKey`, `isRegistered`, `getProfileCount`
**Events:** `ProfileRegistered`, `ProfileUnregistered`

### MyTXOProfile (`contracts/src/profile/`)

Per-user OP721 NFT contract. Deployed once per user during registration.

- **Token #0** -- Creator Card (soulbound identity NFT). Stores username, display name, bio, avatar inscription ID, CSS inscription ID, and playlist pointer.
- **Token #1+** -- Blurbs (280-character posts with optional Ordinals inscription attachments). Transferable.
- **Token #N+** -- Guestbook entries (messages signed by visitors). Soulbound.

Implements full on-chain `tokenURI()` returning base64-encoded JSON metadata with traits, descriptions, and Ordinals content URLs. Soulbound transfer restrictions enforced at the contract level.

**Write methods:** `updateProfile`, `mintBlurb`, `signGuestbook`
**View methods:** `getProfile`, `getTokenInfo`, `getTokenContent`, `tokenURI`, `balanceOf`, `ownerOf`, `totalSupply`
**Events:** `ProfileUpdated`, `BlurbMinted`, `GuestbookSigned`

### MyTXOSocial (`contracts/src/social/`)

Singleton social graph contract. Manages all inter-user social features.

- **Friendships** -- Bidirectional friend system with enumerable pending/accepted lists. Send, accept, deny, cancel, remove. Swap-and-pop removal for O(1) list operations.
- **Re-NFTs** -- Users "re-mint" another user's blurb as a social endorsement. One per user per content hash. Enumerable per-content and per-user. Tracks original source contract and token ID.
- **Top 8** -- MySpace-style curated friends list (max 8 entries). Stored per-user with ordered slots.
- **Background Inscriptions** -- Per-user background image stored as txid + output index.
- **Legend Score** -- On-chain reputation computed from friend count, guestbook entries, blurb count, avatar presence, and playlist presence. Capped sub-scores prevent gaming.

All list operations use index maps for O(1) append/remove.

**Write methods:** `sendFriendRequest`, `acceptFriendRequest`, `denyFriendRequest`, `removeFriend`, `cancelFriendRequest`, `reNFT`, `setTop8`, `setBackground`
**View methods:** `getCounts`, `getFriendshipStatus`, `getFriendsList`, `getPendingRequesters`, `getReNFTCount`, `hasReNFTd`, `getReNFTs`, `getUserReNFTs`, `getReNFTSource`, `getTop8`, `getBackground`, `getLegendScore`
**Events:** `FriendRequestSent`, `FriendRequestAccepted`, `FriendRequestDenied`, `FriendRemoved`, `FriendRequestCancelled`, `ReNFTMinted`, `Top8Updated`

### MytxoToken (`contracts/src/token/`)

Standard OP_20 token with 21 billion supply and 18 decimals. Entire supply minted to deployer on deployment. Includes deployer-only `mint` and batch `airdrop` methods.

### MytxoPresale (`contracts/src/presale/`)

Native BTC presale contract. Users send BTC to the treasury address as part of the transaction. The contract verifies BTC outputs, enforces per-address and per-round caps, and transfers tokens from its balance to the buyer. Follows CEI (Checks-Effects-Interactions) pattern with reentrancy protection. Owner can pause/unpause and withdraw remaining tokens.

### MytxoFaucet (`contracts/src/faucet/`)

Testnet token faucet with configurable claim amount and cooldown window. Anyone can call `claim()` once per cooldown period. Funded via `fund()` which pulls tokens via `safeTransferFrom`. Owner controls: claim amount, cooldown blocks, pause/unpause, registered-only mode.

## Building

```bash
cd contracts
npm install
npm run build        # Build all 6 contracts
npm run build:social # Build individual contract
```

Build output goes to `contracts/build/*.wasm`.

### Dependencies

- `@btc-vision/btc-runtime` -- OPNet smart contract runtime
- `@btc-vision/opnet-transform` -- AssemblyScript compiler transform for OPNet decorators
- `@btc-vision/as-bignum` -- 256-bit integer support

## Key Design Decisions

**Per-user profile contracts.** Each user gets their own OP721, not a shared token contract. This means each user's NFTs (Creator Card, blurbs, guestbook entries) live in their own namespace with independent supply tracking and transfer rules.

**Soulbound tokens.** Identity (Creator Card) and guestbook entry tokens override `_transfer()` to prevent movement. Blurb NFTs remain transferable.

**Profile address consistency.** All social methods accept an explicit `myProfile` address parameter rather than using `Blockchain.tx.sender`. This is critical because the wallet address and the profile contract address are different on OPNet -- the wallet deploys the profile contract, but all data must be keyed by the profile contract address for consistent lookups.

**Enumerable lists with index maps.** Friend lists, pending request lists, and Re-NFT lists use a dual-map pattern: a `list` map (index -> value) and an `index` map (value -> stored index). This enables O(1) append and O(1) swap-and-pop removal while maintaining enumerable iteration.

**On-chain tokenURI.** Profile contracts generate full JSON metadata on-chain (base64-encoded data URIs) rather than pointing to off-chain servers. Metadata includes Ordinals content URLs for images.

## Live Demo

Visit **[testnet.mytxo.space](https://testnet.mytxo.space)** to see the full platform running on OPNet Testnet. Features include:

- Profile registration with personal smart contract deployment
- Blurb posting with Ordinals inscription attachments (images, 3D models, HTML, audio)
- On-chain guestbook signing
- Bidirectional friend system with notification bell
- Re-NFTs (social minting of other users' content)
- Top 8 friends curation
- Custom CSS profile themes via inscriptions
- Profile music via audio inscriptions
- Real-time on-chain feed with event filtering
- $MYTXO token presale and faucet
- Discover search for finding users

## Network

All contracts are deployed on **OPNet Testnet** (`networks.opnetTestnet` from `@btc-vision/bitcoin`).

OPNet Testnet RPC: `https://testnet.opnet.org`

## License

All rights reserved. Copyright 2025-2026 MyTXO.

Source code is provided for hackathon evaluation purposes. See the live demo for the full platform experience.

---

**Built on Bitcoin L1. Powered by OPNet smart contracts.**
