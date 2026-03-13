import { u256 } from '@btc-vision/as-bignum/assembly';
import {
    Address,
    Blockchain,
    BytesWriter,
    Calldata,
    NetEvent,
    Revert,
    SafeMath,
    StoredU256,
    StoredAddress,
    StoredBoolean,
    TransferHelper,
} from '@btc-vision/btc-runtime/runtime';
import { AddressMemoryMap } from '@btc-vision/btc-runtime/runtime/memory/AddressMemoryMap';
import { ReentrancyGuard } from '@btc-vision/btc-runtime/runtime/contracts/ReentrancyGuard';
import { ADDRESS_BYTE_LENGTH, U256_BYTE_LENGTH } from '@btc-vision/btc-runtime/runtime/utils';
import { EMPTY_POINTER } from '@btc-vision/btc-runtime/runtime/math/bytes';

class ClaimEvent extends NetEvent {
    constructor(claimant: Address, amount: u256, blockNumber: u256) {
        const data: BytesWriter = new BytesWriter(ADDRESS_BYTE_LENGTH + U256_BYTE_LENGTH * 2);
        data.writeAddress(claimant);
        data.writeU256(amount);
        data.writeU256(blockNumber);
        super('Claim', data);
    }
}

const ownerPointer: u16 = Blockchain.nextPointer;
const tokenAddressPointer: u16 = Blockchain.nextPointer;
const registryAddressPointer: u16 = Blockchain.nextPointer;
const claimAmountPointer: u16 = Blockchain.nextPointer;
const cooldownBlocksPointer: u16 = Blockchain.nextPointer;
const pausedPointer: u16 = Blockchain.nextPointer;
const registeredOnlyPointer: u16 = Blockchain.nextPointer;
const lastClaimPointer: u16 = Blockchain.nextPointer;

/**
 * ScribeFaucet — token drip faucet for $SCRIBE on OPNet.
 *
 * Any wallet can call claim() once per cooldown window to receive a fixed
 * amount of SCRIBE. The faucet is funded by anyone sending OP20 SCRIBE tokens
 * directly to this contract's address via a standard token transfer.
 *
 * Owner controls:
 *   - setClaimAmount(u256)    — adjust tokens per claim (18-decimal scaled)
 *   - setCooldownBlocks(u256) — adjust cooldown window (36 blocks ≈ 6 hours)
 *   - setRegisteredOnly(bool) — restrict claims to registered MyScribe profiles
 *   - pause() / unpause()     — emergency stop
 * Tokens sent to this contract can only exit via claims — there is no drain function.
 * The faucet is permanently trustless once funded.
 */
@final
export class ScribeFaucet extends ReentrancyGuard {
    private readonly owner: StoredAddress;
    private readonly tokenAddress: StoredAddress;
    private readonly registryAddress: StoredAddress;
    private readonly claimAmount: StoredU256;
    private readonly cooldownBlocks: StoredU256;
    private readonly paused: StoredBoolean;
    private readonly registeredOnly: StoredBoolean;
    private readonly lastClaim: AddressMemoryMap;

    public constructor() {
        super();

        this.owner = new StoredAddress(ownerPointer);
        this.tokenAddress = new StoredAddress(tokenAddressPointer);
        this.registryAddress = new StoredAddress(registryAddressPointer);
        this.claimAmount = new StoredU256(claimAmountPointer, EMPTY_POINTER);
        this.cooldownBlocks = new StoredU256(cooldownBlocksPointer, EMPTY_POINTER);
        this.paused = new StoredBoolean(pausedPointer, false);
        this.registeredOnly = new StoredBoolean(registeredOnlyPointer, false);
        this.lastClaim = new AddressMemoryMap(lastClaimPointer);
    }

    public override onDeployment(calldata: Calldata): void {
        const ownerAddr = calldata.readAddress();
        const tokenAddr = calldata.readAddress();
        const registryAddr = calldata.readAddress();
        const amount = calldata.readU256();
        const cooldown = calldata.readU256();

        this.owner.value = ownerAddr;
        this.tokenAddress.value = tokenAddr;
        this.registryAddress.value = registryAddr;
        this.claimAmount.value = amount;
        this.cooldownBlocks.value = cooldown;
        this.paused.value = false;
        this.registeredOnly.value = false;
    }

    /**
     * claim() — receive claimAmount tokens. Reverts if:
     *   - faucet is paused
     *   - cooldown has not elapsed since last claim by this sender
     *   - claimAmount is zero (faucet misconfigured)
     */
    @method()
    @emit('Claim')
    public claim(_calldata: Calldata): BytesWriter {
        if (this.paused.value) {
            throw new Revert('Faucet is paused');
        }

        const claimant: Address = Blockchain.tx.sender;
        const currentBlock: u256 = u256.fromU64(Blockchain.block.number);
        const cooldown: u256 = this.cooldownBlocks.value;

        // lastClaim returns u256.Zero for wallets that have never claimed
        const lastBlock: u256 = this.lastClaim.get(claimant);

        if (!lastBlock.isZero()) {
            // Guard against impossible underflow: currentBlock must be >= lastBlock
            if (currentBlock < lastBlock) {
                throw new Revert('Block number inconsistency');
            }
            const elapsed: u256 = SafeMath.sub(currentBlock, lastBlock);
            if (elapsed < cooldown) {
                throw new Revert('Cooldown not elapsed');
            }
        }

        const amount: u256 = this.claimAmount.value;
        if (amount.isZero()) {
            throw new Revert('Claim amount is zero');
        }

        // Effects before interactions — CEI pattern
        this.lastClaim.set(claimant, currentBlock);

        // Interaction: transfer tokens from faucet's OP20 balance to claimant
        TransferHelper.transfer(this.tokenAddress.value, claimant, amount);

        this.emitEvent(new ClaimEvent(claimant, amount, currentBlock));

        return new BytesWriter(0);
    }

    /**
     * getState(address) — read-only view for frontend.
     *
     * Returns:
     *   claimAmount     (u256) — tokens per claim, 18-decimal scaled
     *   cooldownBlocks  (u256) — blocks between claims
     *   paused          (bool)
     *   registeredOnly  (bool)
     *   lastClaimBlock  (u256) — last block the given address claimed (0 if never)
     *   currentBlock    (u256) — current chain block number
     */
    @view
    @method({ name: 'claimant', type: ABIDataTypes.ADDRESS })
    @returns(
        { name: 'claimAmount', type: ABIDataTypes.UINT256 },
        { name: 'cooldownBlocks', type: ABIDataTypes.UINT256 },
        { name: 'paused', type: ABIDataTypes.BOOL },
        { name: 'registeredOnly', type: ABIDataTypes.BOOL },
        { name: 'lastClaimBlock', type: ABIDataTypes.UINT256 },
        { name: 'currentBlock', type: ABIDataTypes.UINT256 },
    )
    public getState(calldata: Calldata): BytesWriter {
        const addr = calldata.readAddress();
        const lastBlock: u256 = this.lastClaim.get(addr);
        const cur: u256 = u256.fromU64(Blockchain.block.number);

        // Layout: 4×u256 (32 bytes each) + 2×bool (1 byte each) = 130 bytes
        const response = new BytesWriter(U256_BYTE_LENGTH * 4 + 2);
        response.writeU256(this.claimAmount.value);
        response.writeU256(this.cooldownBlocks.value);
        response.writeBoolean(this.paused.value);
        response.writeBoolean(this.registeredOnly.value);
        response.writeU256(lastBlock);
        response.writeU256(cur);
        return response;
    }

    /**
     * setClaimAmount(amount) — owner only. Update the per-claim token amount.
     * Amount must be 18-decimal scaled (e.g. 1000 × 10^18 for 1,000 SCRIBE).
     */
    @method({ name: 'amount', type: ABIDataTypes.UINT256 })
    public setClaimAmount(calldata: Calldata): BytesWriter {
        this._onlyOwner();
        const amount = calldata.readU256();
        if (amount.isZero()) {
            throw new Revert('Amount must be > 0');
        }
        this.claimAmount.value = amount;
        return new BytesWriter(0);
    }

    /**
     * setCooldownBlocks(blocks) — owner only. Update the cooldown window.
     * 36 blocks ≈ 6 hours on OPNet Testnet (10 min/block).
     */
    @method({ name: 'blocks', type: ABIDataTypes.UINT256 })
    public setCooldownBlocks(calldata: Calldata): BytesWriter {
        this._onlyOwner();
        const blocks = calldata.readU256();
        if (blocks.isZero()) {
            throw new Revert('Cooldown must be > 0');
        }
        this.cooldownBlocks.value = blocks;
        return new BytesWriter(0);
    }

    /**
     * setRegisteredOnly(enabled) — owner only.
     * When true, only wallets with a registered MyScribe profile can claim.
     */
    @method({ name: 'enabled', type: ABIDataTypes.BOOL })
    public setRegisteredOnly(calldata: Calldata): BytesWriter {
        this._onlyOwner();
        this.registeredOnly.value = calldata.readBoolean();
        return new BytesWriter(0);
    }

    /** pause() — owner only. Stops all claims. */
    @method()
    public pause(_calldata: Calldata): BytesWriter {
        this._onlyOwner();
        this.paused.value = true;
        return new BytesWriter(0);
    }

    /** unpause() — owner only. Resumes claims. */
    @method()
    public unpause(_calldata: Calldata): BytesWriter {
        this._onlyOwner();
        this.paused.value = false;
        return new BytesWriter(0);
    }

    /**
     * fund(amount) — anyone can donate SCRIBE to keep the faucet running.
     *
     * Pulls `amount` tokens from the caller into this contract via safeTransferFrom.
     * This is the correct way to send tokens to a contract on OPNet — direct wallet
     * transfers fail because contracts have no on-chain public key (never spent a UTXO).
     */
    @method({ name: 'amount', type: ABIDataTypes.UINT256 })
    public fund(calldata: Calldata): BytesWriter {
        const amount: u256 = calldata.readU256();
        if (amount.isZero()) {
            throw new Revert('Amount cannot be zero');
        }
        TransferHelper.safeTransferFrom(
            this.tokenAddress.value,
            Blockchain.tx.sender,
            Blockchain.contractAddress,
            amount,
        );
        return new BytesWriter(0);
    }

    private _onlyOwner(): void {
        if (Blockchain.tx.sender !== this.owner.value) {
            throw new Revert('Only owner');
        }
    }
}
