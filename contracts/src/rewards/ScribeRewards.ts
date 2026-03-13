import { u256 } from '@btc-vision/as-bignum/assembly';
import {
    Address,
    AddressMap,
    Blockchain,
    BytesWriter,
    Calldata,
    NetEvent,
    Revert,
    SafeMath,
    StoredAddress,
    StoredBoolean,
    StoredU256,
    TransferHelper,
} from '@btc-vision/btc-runtime/runtime';
import { AddressMemoryMap } from '@btc-vision/btc-runtime/runtime/memory/AddressMemoryMap';
import { ReentrancyGuard } from '@btc-vision/btc-runtime/runtime/contracts/ReentrancyGuard';
import { ADDRESS_BYTE_LENGTH, U256_BYTE_LENGTH } from '@btc-vision/btc-runtime/runtime/utils';
import { EMPTY_POINTER } from '@btc-vision/btc-runtime/runtime/math/bytes';

// ── Events ──────────────────────────────────────────────────────────────

class RewardAllocatedEvent extends NetEvent {
    constructor(recipient: Address, amount: u256) {
        const data: BytesWriter = new BytesWriter(ADDRESS_BYTE_LENGTH + U256_BYTE_LENGTH);
        data.writeAddress(recipient);
        data.writeU256(amount);
        super('RewardAllocated', data);
    }
}

class RewardClaimedEvent extends NetEvent {
    constructor(claimant: Address, amount: u256) {
        const data: BytesWriter = new BytesWriter(ADDRESS_BYTE_LENGTH + U256_BYTE_LENGTH);
        data.writeAddress(claimant);
        data.writeU256(amount);
        super('RewardClaimed', data);
    }
}

// ── Storage pointers ────────────────────────────────────────────────────

const ownerPointer: u16 = Blockchain.nextPointer;
const tokenAddressPointer: u16 = Blockchain.nextPointer;
const pausedPointer: u16 = Blockchain.nextPointer;
const allocatedMapPointer: u16 = Blockchain.nextPointer;
const claimedMapPointer: u16 = Blockchain.nextPointer;
const totalAllocatedPointer: u16 = Blockchain.nextPointer;
const totalClaimedPointer: u16 = Blockchain.nextPointer;

/**
 * ScribeRewards — Admin-allocated rewards pool for $SCRIBE.
 *
 * Pre-funded with 15 % of total token supply at deployment.  The owner
 * (backend or multisig) calls allocateReward() / batchAllocate() to
 * assign rewards to individual users.  Users call claimRewards() to
 * pull their allocated tokens.
 *
 * This contract should be added to ScribeToken's tax-exclusion list so
 * that reward claims are not subject to the 6 % reflection tax.
 */
@final
export class ScribeRewards extends ReentrancyGuard {
    private readonly owner: StoredAddress;
    private readonly tokenAddress: StoredAddress;
    private readonly paused: StoredBoolean;
    private readonly allocatedMap: AddressMemoryMap;
    private readonly claimedMap: AddressMemoryMap;
    private readonly totalAllocated: StoredU256;
    private readonly totalClaimed: StoredU256;

    public constructor() {
        super();

        this.owner = new StoredAddress(ownerPointer);
        this.tokenAddress = new StoredAddress(tokenAddressPointer);
        this.paused = new StoredBoolean(pausedPointer, false);
        this.allocatedMap = new AddressMemoryMap(allocatedMapPointer);
        this.claimedMap = new AddressMemoryMap(claimedMapPointer);
        this.totalAllocated = new StoredU256(totalAllocatedPointer, EMPTY_POINTER);
        this.totalClaimed = new StoredU256(totalClaimedPointer, EMPTY_POINTER);
    }

    // ── Deployment ──────────────────────────────────────────────────────

    public override onDeployment(calldata: Calldata): void {
        const ownerAddr: Address = calldata.readAddress();
        const tokenAddr: Address = calldata.readAddress();

        this.owner.value = ownerAddr;
        this.tokenAddress.value = tokenAddr;
        this.paused.value = false;
        this.totalAllocated.value = u256.Zero;
        this.totalClaimed.value = u256.Zero;
    }

    // ── User methods ────────────────────────────────────────────────────

    /**
     * claimRewards() — pull all unclaimed rewards to caller's wallet.
     * Follows CEI: effects before interactions.
     */
    @method()
    @emit('RewardClaimed')
    @returns({ name: 'claimed', type: ABIDataTypes.UINT256 })
    public claimRewards(_calldata: Calldata): BytesWriter {
        if (this.paused.value) {
            throw new Revert('Rewards paused');
        }

        const claimant: Address = Blockchain.tx.sender;
        const allocated: u256 = this.allocatedMap.get(claimant);
        const claimed: u256 = this.claimedMap.get(claimant);

        if (allocated <= claimed) {
            throw new Revert('No rewards to claim');
        }

        const pending: u256 = SafeMath.sub(allocated, claimed);

        // Effects
        this.claimedMap.set(claimant, allocated);
        this.totalClaimed.value = SafeMath.add(this.totalClaimed.value, pending);

        // Interaction (last — CEI pattern)
        TransferHelper.transfer(this.tokenAddress.value, claimant, pending);

        this.emitEvent(new RewardClaimedEvent(claimant, pending));

        const writer: BytesWriter = new BytesWriter(U256_BYTE_LENGTH);
        writer.writeU256(pending);
        return writer;
    }

    // ── Admin methods ───────────────────────────────────────────────────

    /**
     * allocateReward(address, amount) — assign reward tokens to a user.
     * Tokens are NOT transferred yet; the user must call claimRewards().
     */
    @method(
        { name: 'recipient', type: ABIDataTypes.ADDRESS },
        { name: 'amount', type: ABIDataTypes.UINT256 },
    )
    @emit('RewardAllocated')
    @returns()
    public allocateReward(calldata: Calldata): BytesWriter {
        this._onlyOwner();

        const recipient: Address = calldata.readAddress();
        const amount: u256 = calldata.readU256();

        if (amount.isZero()) {
            throw new Revert('Amount must be > 0');
        }

        this._allocate(recipient, amount);
        this.emitEvent(new RewardAllocatedEvent(recipient, amount));

        return new BytesWriter(0);
    }

    /**
     * batchAllocate(addressAmountTuples) — assign rewards to many users
     * in a single transaction.
     */
    @method({
        name: 'addressAndAmount',
        type: ABIDataTypes.ADDRESS_UINT256_TUPLE,
    })
    @emit('RewardAllocated')
    @returns()
    public batchAllocate(calldata: Calldata): BytesWriter {
        this._onlyOwner();

        const entries: AddressMap<u256> = calldata.readAddressMapU256();
        const addresses: Address[] = entries.keys();

        for (let i: i32 = 0; i < addresses.length; i++) {
            const addr: Address = addresses[i];
            if (!addr) {
                throw new Revert('Invalid address in batch');
            }
            const amount: u256 = entries.get(addr);
            if (amount.isZero()) {
                throw new Revert('Amount must be > 0');
            }
            this._allocate(addr, amount);
            this.emitEvent(new RewardAllocatedEvent(addr, amount));
        }

        return new BytesWriter(0);
    }

    @method()
    @returns()
    public pause(_calldata: Calldata): BytesWriter {
        this._onlyOwner();
        this.paused.value = true;
        return new BytesWriter(0);
    }

    @method()
    @returns()
    public unpause(_calldata: Calldata): BytesWriter {
        this._onlyOwner();
        this.paused.value = false;
        return new BytesWriter(0);
    }

    /**
     * withdrawTokens(amount) — owner can recover unallocated tokens.
     * Cannot withdraw more than unallocated balance.
     */
    @method({ name: 'amount', type: ABIDataTypes.UINT256 })
    @returns()
    public withdrawTokens(calldata: Calldata): BytesWriter {
        this._onlyOwner();
        const amount: u256 = calldata.readU256();
        if (amount.isZero()) {
            throw new Revert('Amount must be > 0');
        }

        TransferHelper.transfer(this.tokenAddress.value, this.owner.value, amount);
        return new BytesWriter(0);
    }

    // ── View methods ────────────────────────────────────────────────────

    @view
    @method({ name: 'account', type: ABIDataTypes.ADDRESS })
    @returns(
        { name: 'allocated', type: ABIDataTypes.UINT256 },
        { name: 'claimed', type: ABIDataTypes.UINT256 },
        { name: 'pending', type: ABIDataTypes.UINT256 },
    )
    public getClaimable(calldata: Calldata): BytesWriter {
        const account: Address = calldata.readAddress();
        const allocated: u256 = this.allocatedMap.get(account);
        const claimed: u256 = this.claimedMap.get(account);
        const pending: u256 = allocated > claimed
            ? SafeMath.sub(allocated, claimed)
            : u256.Zero;

        const writer: BytesWriter = new BytesWriter(U256_BYTE_LENGTH * 3);
        writer.writeU256(allocated);
        writer.writeU256(claimed);
        writer.writeU256(pending);
        return writer;
    }

    @view
    @method()
    @returns(
        { name: 'totalAllocated', type: ABIDataTypes.UINT256 },
        { name: 'totalClaimed', type: ABIDataTypes.UINT256 },
        { name: 'paused', type: ABIDataTypes.BOOL },
    )
    public getState(_calldata: Calldata): BytesWriter {
        const writer: BytesWriter = new BytesWriter(U256_BYTE_LENGTH * 2 + 1);
        writer.writeU256(this.totalAllocated.value);
        writer.writeU256(this.totalClaimed.value);
        writer.writeBoolean(this.paused.value);
        return writer;
    }

    // ── Internal ────────────────────────────────────────────────────────

    private _allocate(recipient: Address, amount: u256): void {
        const prev: u256 = this.allocatedMap.get(recipient);
        this.allocatedMap.set(recipient, SafeMath.add(prev, amount));
        this.totalAllocated.value = SafeMath.add(this.totalAllocated.value, amount);
    }

    private _onlyOwner(): void {
        if (!Blockchain.tx.sender.equals(this.owner.value)) {
            throw new Revert('Only owner');
        }
    }
}
