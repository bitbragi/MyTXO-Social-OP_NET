<p align="center">
  <img src="https://testnet.myscribe.org/logo.png" alt="MyScribe" width="80" />
</p>

<h1 align="center">MyScribe</h1>
<h3 align="center">Social Identity, DeFi & NFT Marketplace — Natively on Bitcoin L1</h3>

<p align="center">
  <strong>10 smart contracts. Zero bridges. Pure Bitcoin.</strong>
</p>

<p align="center">
  <a href="https://testnet.myscribe.org">Live Testnet</a> · <a href="https://market.myscribe.org">NFT Marketplace</a> · <a href="#contracts">Contract Docs</a> · <a href="#deploy">Deploy Guide</a>
</p>

---

## The Pitch

What if your social identity, your tokens, your votes, and your NFT collection all lived on Bitcoin — not a sidechain, not a bridge, not an L2 — but **Bitcoin itself**?

**MyScribe** is a full-stack social platform built entirely on [OPNet](https://opnet.org), a smart contract runtime that executes directly on Bitcoin L1 via Tapscript-encoded calldata. Every profile, every post, every token transfer, every governance vote, and every NFT trade settles on the Bitcoin blockchain.

This repo contains **all 10 smart contracts** powering the MyScribe ecosystem:

| Layer | Contracts | What They Do |
|-------|-----------|-------------|
| **Social** | Factory, Profile, Social | On-chain identity, content NFTs, friend graph, guestbooks, Re-NFTs |
| **DeFi** | Token, Presale, Faucet, Rewards, Governance | Reflection token with 6% tax, presale, faucet, rewards pool, governance voting |
| **Marketplace** | Collection, Marketplace | Deploy NFT collections, list/buy/bid with royalties and platform fees |

---

## Why This Matters

Most "Bitcoin DeFi" projects are really Ethereum bridges wearing a Bitcoin skin. MyScribe is different:

- **No bridges.** Contracts compile to WASM and execute on OPNet's Bitcoin L1 VM.
- **No separate chain.** State lives in Bitcoin transactions, secured by Bitcoin miners.
- **Real utility.** Users have on-chain identities, social graphs, soulbound NFTs, reflection rewards, and governance — all in one ecosystem.
- **Composable.** The contracts call each other: governance reads your token balance, the faucet checks your registration, the marketplace transfers collection NFTs and splits royalties.

---

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                        MyScribe Ecosystem                       │
├─────────────────┬─────────────────────┬─────────────────────────┤
│   Social Layer  │     DeFi Layer      │   Marketplace Layer     │
│                 │                     │                         │
│  Factory ◄──────┤  ScribeToken (OP20) │  Collection (OP721)     │
│  Profile (721)  │  ├── 6% reflection  │  ├── mint w/ inscription│
│  Social         │  ├── tax exclusions │  ├── deployer-only mint │
│  ├── friends    │  ├── airdrop        │  └── per-token URI      │
│  ├── guestbook  │  └── reentrancy     │                         │
│  ├── Re-NFTs    │                     │  Marketplace            │
│  ├── Top 8      │  Presale            │  ├── list / buy / bid   │
│  └── legend     │  ├── BTC → SCRIBE   │  ├── royalties (≤10%)   │
│     score       │  └── round caps     │  ├── platform fee (≤5%) │
│                 │                     │  └── cross-contract 721 │
│                 │  Faucet             │                         │
│                 │  ├── claim cooldown │                         │
│                 │  └── registry gate  │                         │
│                 │                     │                         │
│                 │  Rewards            │                         │
│                 │  ├── admin allocate │                         │
│                 │  └── pull claims    │                         │
│                 │                     │                         │
│                 │  Governance         │                         │
│                 │  ├── token-weighted │                         │
│                 │  └── bitmap votes   │                         │
└─────────────────┴─────────────────────┴─────────────────────────┘
          ▲                   ▲                      ▲
          │                   │                      │
          └───── Bitcoin L1 (OPNet Tapscript) ───────┘
```

---

<a id="contracts"></a>

## Contract Reference

### 1. ScribeToken — Reflection Token (OP20)

**`contracts/src/token/ScribeToken.ts`**

A SafeMoon-style reflection token with a 6% transfer tax. When any non-excluded address transfers tokens, 6% is removed from circulation and passively redistributed to all non-excluded holders proportionally — no staking, no claiming, just hold.

**Tokenomics:**
- Total supply: **21,000,000,000 SCRIBE** (21 billion)
- Transfer tax: **6%** (redistributed as reflections)
- Excluded addresses pay no tax and receive no reflections

**How reflections work:**

The contract maintains two accounting systems: `rOwned` (reflection-space balance) and `tOwned` (token-space balance for excluded addresses). Every tax deduction reduces the global `rTotal` without reducing `tTotal`, which increases the effective balance of every non-excluded holder.

```
balanceOf(holder) = rOwned[holder] × tTotal / rTotal
```

As `rTotal` shrinks from taxes, each unit of `rOwned` is worth more `tTotal`, creating passive yield.

**Key methods:**
| Method | Access | Description |
|--------|--------|-------------|
| `transfer(to, amount)` | Public | Transfer with 6% tax (exempt if excluded) |
| `transferFrom(from, to, amount)` | Public | Allowance-based transfer with tax |
| `setTaxExcluded(account, excluded)` | Deployer | Exclude/include address from tax |
| `setTaxEnabled(enabled)` | Deployer | Toggle tax globally |
| `mint(address, amount)` | Deployer | Mint tokens |
| `airdrop(calldata)` | Deployer | Batch airdrop to multiple addresses |
| `balanceOf(owner)` | View | Reflection-aware effective balance |
| `getReflectionInfo(account)` | View | Exclusion status, tax state, total fees collected |

**Security:** Custom reentrancy guard (`_guardEnter` / `_guardExit`) protects `_reflectTransfer`. Events: `Transfer`, `TaxTransfer`, `ExclusionChanged`, `Minted`.

---

### 2. ScribePresale — BTC-to-Token Sale

**`contracts/src/presale/ScribePresale.ts`**

Handles token distribution via direct BTC payments. Users send BTC to the treasury address; the contract verifies the on-chain payment via `sumOutputsTo()` and mints SCRIBE proportionally.

**Key methods:**
| Method | Access | Description |
|--------|--------|-------------|
| `purchase()` | Public (payable) | Verify BTC sent, mint SCRIBE at current rate |
| `pause()` / `unpause()` | Owner | Pause/unpause the presale |
| `withdrawTokens(amount)` | Owner | Recover tokens to owner |
| `getState()` | View | Round info, sats raised, rate, pause status |
| `getContribution(address)` | View | Sats contributed by address |

**Security:** Extends `ReentrancyGuard`. CEI pattern — state updates before `TransferHelper.transfer`. Per-address and per-round caps prevent whale domination.

---

### 3. MyScribeFactory — Profile Registry

**`contracts/src/factory/MyScribeFactory.ts`**

The on-chain username registry. Maps wallet addresses to profile contract addresses and username keys. O(1) lookups via `StoredMapU256`.

**Key methods:**
| Method | Access | Description |
|--------|--------|-------------|
| `register(usernameKey, contractAddress)` | Public | Register profile + username |
| `unregister(target)` | Owner | Remove a registration |
| `resolveUsername(usernameKey)` | View | Username → profile address |
| `resolveAddress(walletAddress)` | View | Wallet → profile address |
| `isRegistered(walletAddress)` | View | Check registration status |
| `getProfileCount()` | View | Total registered profiles |

**Security:** Extends `ReentrancyGuard`. Owner-only `unregister` for moderation.

---

### 4. MyScribeProfile — Identity NFTs (OP721)

**`contracts/src/profile/MyScribeProfile.ts`**

Each user's profile is an OP721 collection. Token #0 is a soulbound Creator Card (non-transferable identity). Subsequent tokens are either blurbs (transferable content NFTs) or guestbook entries (soulbound).

**Token types:**
| Type | ID Range | Transferable | Description |
|------|----------|-------------|-------------|
| Identity | 0 | No (soulbound) | Creator Card |
| Blurb | 1+ | Yes | Content posts minted as NFTs |
| Guestbook | After blurbs | No (soulbound) | Visitor signatures |

**Key methods:**
| Method | Access | Description |
|--------|--------|-------------|
| `updateProfile(displayName, bio, avatar, css, playlist)` | Owner | Update profile fields |
| `mintBlurb(content, publishToFeed, inscriptionId)` | Owner | Mint content NFT (≤280 chars) |
| `signGuestbook(message)` | Public | Sign guestbook (≤500 chars, soulbound) |
| `getProfile()` | View | All profile fields + counts |
| `getTokenContent(tokenId)` | View | Token type, content, inscription, signer |

**Security:** Soulbound enforcement in `_transfer` — identity and guestbook tokens revert on transfer. Length limits on all string inputs.

---

### 5. MyScribeSocial — Social Graph

**`contracts/src/social/MyScribeSocial.ts`**

The on-chain social graph. Manages friend requests, mutual friendships, Top 8, Re-NFTs (resharing), and a "Legend Score" that measures on-chain social engagement.

**Key methods:**
| Method | Access | Description |
|--------|--------|-------------|
| `sendFriendRequest(myProfile, target)` | Public | Send or auto-accept friend request |
| `acceptFriendRequest(myProfile, requester)` | Public | Accept pending request |
| `denyFriendRequest` / `removeFriend` / `cancelFriendRequest` | Public | Manage friendships |
| `reNFT(myProfile, contentHash, message, contract, tokenId)` | Public | Mint a Re-NFT (reshare) |
| `setTop8(myProfile, count, addr0..addr7)` | Public | Set your Top 8 friends |
| `setBackground(myProfile, txid, outputIndex)` | Public | Set profile background inscription |
| `getLegendScore(profile)` | View | Engagement score from social activity |

**Re-NFTs:** One per user per content hash. First writer sets the canonical source. Legend Score weights: avatar, playlist, friends, guestbook entries, blurbs.

**Security:** Extends `ReentrancyGuard`. `MapOfMap` for O(1) friend lookups.

---

### 6. ScribeFaucet — Token Distribution

**`contracts/src/faucet/ScribeFaucet.ts`**

Distributes SCRIBE tokens with configurable claim amounts, cooldown periods, and optional registration gating.

**Key methods:**
| Method | Access | Description |
|--------|--------|-------------|
| `claim()` | Public | Claim tokens (once per cooldown) |
| `fund(amount)` | Public | Donate SCRIBE to the faucet |
| `setClaimAmount(amount)` | Owner | Configure tokens per claim |
| `setCooldownBlocks(blocks)` | Owner | Set block cooldown between claims |
| `setRegisteredOnly(enabled)` | Owner | Restrict to registered profiles |
| `getState(claimant)` | View | Config + claimant's last claim block |

**Security:** Extends `ReentrancyGuard`. CEI pattern in `claim()`.

---

### 7. ScribeRewards — Rewards Pool

**`contracts/src/rewards/ScribeRewards.ts`**

A pre-funded rewards pool (15% of total supply = 3.15B SCRIBE). The owner allocates rewards to addresses; recipients pull-claim at their convenience.

**Key methods:**
| Method | Access | Description |
|--------|--------|-------------|
| `claimRewards()` | Public | Claim all pending rewards |
| `allocateReward(recipient, amount)` | Owner | Allocate rewards to address |
| `batchAllocate(calldata)` | Owner | Batch allocate to multiple addresses |
| `withdrawTokens(amount)` | Owner | Recover unallocated tokens |
| `getClaimable(account)` | View | Allocated, claimed, and pending amounts |
| `getState()` | View | Total allocated, total claimed, pause status |

**Security:** Extends `ReentrancyGuard`. CEI in `claimRewards()`. Pull-based pattern prevents reentrancy on claim. Events: `RewardAllocated`, `RewardClaimed`.

---

### 8. ScribeGovernance — Token-Weighted Voting

**`contracts/src/governance/ScribeGovernance.ts`**

On-chain governance where voting power equals your SCRIBE balance. The contract performs a cross-contract `balanceOf` call to ScribeToken at vote time — no snapshots, no delegation, no staking.

**Key methods:**
| Method | Access | Description |
|--------|--------|-------------|
| `createProposal(descriptionHash, durationBlocks)` | Owner | Create a new proposal |
| `vote(proposalId, support)` | Public | Vote for/against (power = balance) |
| `getProposal(proposalId)` | View | Description hash, votes for/against, status |
| `getVote(proposalId, voter)` | View | Whether voter has voted and their position |
| `getProposalCount()` | View | Total proposals created |

**Cross-contract call:**
```
Blockchain.call(scribeTokenAddress, BALANCE_OF_SELECTOR, encodedVoterAddress)
```

**Double-vote prevention:** Uses a `u256` bitmap — bit N represents proposal N. Each voter gets one bitmap slot. Supports up to 255 proposals per bitmap word. Events: `ProposalCreated`, `VoteCast`.

**Security:** Extends `ReentrancyGuard`.

---

### 9. MyScribeMarketplace — NFT Trading

**`contracts/src/marketplace/MyScribeMarketplace.ts`**

A full-featured NFT marketplace supporting listings, purchases, and bids with configurable royalties and platform fees.

**Key methods:**
| Method | Access | Description |
|--------|--------|-------------|
| `listNFT(collection, tokenId, price)` | Public | List an NFT for sale |
| `cancelListing(listingId)` | Seller | Cancel active listing |
| `buyNFT(listingId)` | Public | Purchase listed NFT |
| `placeBid(collection, tokenId, amount)` | Public | Place bid on any NFT |
| `cancelBid(bidId)` | Bidder | Cancel active bid |
| `acceptBid(bidId)` | NFT Owner | Accept a bid |
| `registerCollection(collection, royaltyBps, recipient)` | Public | Register collection with royalties |
| `setPlatformFee(bps)` / `setPlatformFeeRecipient(addr)` | Deployer | Configure platform fees |

**Fee structure:**
- Royalties: 0–10% (per collection, set at registration)
- Platform fee: 0–5% (global, deployer-configurable)
- Remaining goes to seller

**Cross-contract calls:** `ownerOf`, `isApprovedForAll`, `safeTransferFrom` on OP721 collections. Events: `ListingCreated`, `ListingCancelled`, `ListingSold`, `BidPlaced`, `BidCancelled`, `BidAccepted`, `CollectionRegistered`.

---

### 10. MyScribeCollection — NFT Collections (OP721)

**`contracts/src/collection/MyScribeCollection.ts`**

Deploy custom NFT collections on Bitcoin. Each token can be linked to a Bitcoin inscription ID for on-chain media.

**Key methods:**
| Method | Access | Description |
|--------|--------|-------------|
| `mint(tokenId, inscriptionId)` | Deployer | Mint NFT with inscription link |
| `getTokenURI(tokenId)` | View | Get inscription ID as URI |
| Standard OP721 | Public | `transferFrom`, `safeTransferFrom`, etc. |

**Deployment params:** name, symbol, maxSupply, description, icon (inscription), banner (inscription), website URL.

---

<a id="deploy"></a>

## Deployment Guide

### Prerequisites

- Node.js 18+
- An OPNet testnet wallet with BTC for gas

### 1. Setup

```bash
git clone https://github.com/bitbragi/MyScribe-Social-Market.git
cd MyScribe-Social-Market

cp .env.example .env

cd scripts && npm install && cd ..
cd contracts && npm install && cd ..
```

### 2. Generate Wallet

```bash
node scripts/generate-wallet.mjs
```

This creates a new wallet and writes `MNEMONIC` and `WALLET_ADDRESS` to your `.env`. Fund it with testnet BTC from the [OPNet faucet](https://faucet.opnet.org).

### 3. Build Contracts

```bash
cd contracts
npm run build
```

Outputs 10 `.wasm` files to `contracts/build/`.

### 4. Deploy

Deploy in order — some contracts reference others:

```bash
cd scripts

# Core token
node deploy.mjs

# Social layer
# (Factory, Profile, and Social deploy scripts depend on your setup)

# DeFi
node deploy-rewards.mjs
node deploy-governance.mjs
node deploy-faucet.mjs

# Configure
node setup-tax-exclusions.mjs    # Exclude DeFi contracts from 6% tax
node fund-rewards.mjs            # Fund rewards pool with 15% supply
node fund-faucet.mjs             # Fund the faucet
```

Each script reads from `.env` and writes deployed addresses back to it.

### 5. Verify

After deployment, check your contracts on the [OPNet Testnet Explorer](https://testnet.opnet.org).

---

## Tech Stack

| Component | Technology |
|-----------|-----------|
| Smart contracts | AssemblyScript → WASM |
| Runtime | [OPNet](https://opnet.org) (Bitcoin L1 Tapscript VM) |
| Token standards | OP20 (fungible), OP721 (non-fungible) |
| Contract SDK | `@btc-vision/btc-runtime` |
| Deployment | Node.js scripts with `@btc-vision/transaction` |
| Frontend | Next.js 15 / React 19 / TailwindCSS |
| Live testnet | [testnet.myscribe.org](https://testnet.myscribe.org) |
| NFT marketplace | [market.myscribe.org](https://market.myscribe.org) |

---

## Security

All contracts follow these security practices:

- **Reentrancy guards** on all state-mutating external calls
- **CEI pattern** (Checks-Effects-Interactions) throughout
- **SafeMath** for all `u256` arithmetic
- **Access control** via `_onlyOwner()` with `Address.equals()` (not `===`/`!==`)
- **Soulbound enforcement** for identity and guestbook NFTs
- **Input validation** with length limits on all user-provided strings
- **No raw PSBT construction** — all deployments use `TransactionFactory`
- **Pull-based claims** for rewards (no push-based distribution)

---

## Live Deployment

MyScribe is **live on OPNet Testnet** right now:

- **App**: [testnet.myscribe.org](https://testnet.myscribe.org)
- **Marketplace**: [market.myscribe.org](https://market.myscribe.org)
- **Token**: `0x237490fdd044a3d776aa30b36f040477bc5d853dc35fa8217a3a4013303aeca7`

---

## License

MIT — fork it, build on it, make Bitcoin social.
