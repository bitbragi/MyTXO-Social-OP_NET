import { u256 } from '@btc-vision/as-bignum/assembly';
import {
    Address,
    Blockchain,
    BytesWriter,
    Calldata,
    NetEvent,
    Revert,
    SafeMath,
    StoredAddress,
    StoredU256,
} from '@btc-vision/btc-runtime/runtime';
import { AddressMemoryMap } from '@btc-vision/btc-runtime/runtime/memory/AddressMemoryMap';
import { ReentrancyGuard } from '@btc-vision/btc-runtime/runtime/contracts/ReentrancyGuard';
import { ADDRESS_BYTE_LENGTH, U256_BYTE_LENGTH } from '@btc-vision/btc-runtime/runtime/utils';
import { EMPTY_POINTER } from '@btc-vision/btc-runtime/runtime/math/bytes';

// ── Cross-contract selector ─────────────────────────────────────────────
const BALANCE_OF_SELECTOR: u32 = 0x70a08231; // balanceOf(address)

// ── Events ──────────────────────────────────────────────────────────────

class ProposalCreatedEvent extends NetEvent {
    constructor(proposalId: u256, descHash: u256, endBlock: u256) {
        const data: BytesWriter = new BytesWriter(U256_BYTE_LENGTH * 3);
        data.writeU256(proposalId);
        data.writeU256(descHash);
        data.writeU256(endBlock);
        super('ProposalCreated', data);
    }
}

class VoteCastEvent extends NetEvent {
    constructor(proposalId: u256, voter: Address, support: boolean, weight: u256) {
        const data: BytesWriter = new BytesWriter(
            U256_BYTE_LENGTH * 2 + ADDRESS_BYTE_LENGTH + 1,
        );
        data.writeU256(proposalId);
        data.writeAddress(voter);
        data.writeBoolean(support);
        data.writeU256(weight);
        super('VoteCast', data);
    }
}

// ── Storage pointers ────────────────────────────────────────────────────

const ownerPointer: u16 = Blockchain.nextPointer;
const tokenAddressPointer: u16 = Blockchain.nextPointer;
const proposalCountPointer: u16 = Blockchain.nextPointer;

// Per-proposal data: key = Address.fromUint8Array(proposalId.toUint8Array())
const votesForPointer: u16 = Blockchain.nextPointer;
const votesAgainstPointer: u16 = Blockchain.nextPointer;
const startBlockPointer: u16 = Blockchain.nextPointer;
const endBlockPointer: u16 = Blockchain.nextPointer;
const descHashPointer: u16 = Blockchain.nextPointer;

// Per-voter bitmaps: key = voter Address
// Bit N = voted on proposal N (supports proposals 1–255)
const votedBitmapPointer: u16 = Blockchain.nextPointer;
// Bit N set = voted FOR proposal N; unset = voted AGAINST
const supportBitmapPointer: u16 = Blockchain.nextPointer;

// Maximum proposal ID that fits in a u256 bitmap (bits 0..255)
const MAX_PROPOSAL_ID: u64 = 255;

/**
 * ScribeGovernance — Simple token-weighted on-chain voting.
 *
 * Voting power = balanceOf(voter) on the ScribeToken contract.  Admin
 * creates proposals; any token holder votes once per proposal.
 *
 * Double-vote prevention uses a per-voter u256 bitmap — bit N set means
 * the voter has voted on proposal N.  This supports up to 255 proposals
 * before needing an upgrade.
 */
@final
export class ScribeGovernance extends ReentrancyGuard {
    private readonly owner: StoredAddress;
    private readonly tokenAddress: StoredAddress;
    private readonly proposalCount: StoredU256;

    private readonly votesForMap: AddressMemoryMap;
    private readonly votesAgainstMap: AddressMemoryMap;
    private readonly startBlockMap: AddressMemoryMap;
    private readonly endBlockMap: AddressMemoryMap;
    private readonly descHashMap: AddressMemoryMap;

    private readonly votedBitmap: AddressMemoryMap;
    private readonly supportBitmap: AddressMemoryMap;

    public constructor() {
        super();

        this.owner = new StoredAddress(ownerPointer);
        this.tokenAddress = new StoredAddress(tokenAddressPointer);
        this.proposalCount = new StoredU256(proposalCountPointer, EMPTY_POINTER);

        this.votesForMap = new AddressMemoryMap(votesForPointer);
        this.votesAgainstMap = new AddressMemoryMap(votesAgainstPointer);
        this.startBlockMap = new AddressMemoryMap(startBlockPointer);
        this.endBlockMap = new AddressMemoryMap(endBlockPointer);
        this.descHashMap = new AddressMemoryMap(descHashPointer);

        this.votedBitmap = new AddressMemoryMap(votedBitmapPointer);
        this.supportBitmap = new AddressMemoryMap(supportBitmapPointer);
    }

    // ── Deployment ──────────────────────────────────────────────────────

    public override onDeployment(calldata: Calldata): void {
        const ownerAddr: Address = calldata.readAddress();
        const tokenAddr: Address = calldata.readAddress();

        this.owner.value = ownerAddr;
        this.tokenAddress.value = tokenAddr;
        this.proposalCount.value = u256.Zero;
    }

    // ── Admin: create proposal ──────────────────────────────────────────

    @method(
        { name: 'descriptionHash', type: ABIDataTypes.UINT256 },
        { name: 'durationBlocks', type: ABIDataTypes.UINT256 },
    )
    @emit('ProposalCreated')
    @returns({ name: 'proposalId', type: ABIDataTypes.UINT256 })
    public createProposal(calldata: Calldata): BytesWriter {
        this._onlyOwner();

        const descHash: u256 = calldata.readU256();
        const durationBlocks: u256 = calldata.readU256();

        if (durationBlocks.isZero()) {
            throw new Revert('Duration must be > 0');
        }

        const proposalId: u256 = SafeMath.add(this.proposalCount.value, u256.One);

        // Bitmap limit: proposal IDs 1–255
        if (proposalId.lo1 > MAX_PROPOSAL_ID || proposalId.lo2 != 0 || proposalId.hi1 != 0 || proposalId.hi2 != 0) {
            throw new Revert('Max proposals reached');
        }

        const currentBlock: u256 = u256.fromU64(Blockchain.block.number);
        const endBlock: u256 = SafeMath.add(currentBlock, durationBlocks);

        const pKey: Address = this._proposalKey(proposalId);
        this.startBlockMap.set(pKey, currentBlock);
        this.endBlockMap.set(pKey, endBlock);
        this.descHashMap.set(pKey, descHash);
        this.votesForMap.set(pKey, u256.Zero);
        this.votesAgainstMap.set(pKey, u256.Zero);
        this.proposalCount.value = proposalId;

        this.emitEvent(new ProposalCreatedEvent(proposalId, descHash, endBlock));

        const writer: BytesWriter = new BytesWriter(U256_BYTE_LENGTH);
        writer.writeU256(proposalId);
        return writer;
    }

    // ── User: vote ──────────────────────────────────────────────────────

    @method(
        { name: 'proposalId', type: ABIDataTypes.UINT256 },
        { name: 'support', type: ABIDataTypes.BOOL },
    )
    @emit('VoteCast')
    @returns()
    public vote(calldata: Calldata): BytesWriter {
        const proposalId: u256 = calldata.readU256();
        const support: boolean = calldata.readBoolean();
        const voter: Address = Blockchain.tx.sender;

        if (proposalId.isZero() || proposalId > this.proposalCount.value) {
            throw new Revert('Invalid proposal');
        }

        const pKey: Address = this._proposalKey(proposalId);
        const currentBlock: u256 = u256.fromU64(Blockchain.block.number);
        const endBlock: u256 = this.endBlockMap.get(pKey);

        if (currentBlock > endBlock) {
            throw new Revert('Voting ended');
        }

        // Bitmap double-vote check
        const bitIndex: i32 = <i32>proposalId.lo1;
        const bit: u256 = u256.shl(u256.One, bitIndex);
        const currentBitmap: u256 = this.votedBitmap.get(voter);

        if (!u256.and(currentBitmap, bit).isZero()) {
            throw new Revert('Already voted');
        }

        // Cross-contract call to get voting power
        const weight: u256 = this._getVotingPower(voter);
        if (weight.isZero()) {
            throw new Revert('No voting power');
        }

        // Effects: mark voted
        this.votedBitmap.set(voter, u256.or(currentBitmap, bit));

        if (support) {
            const currentSupport: u256 = this.supportBitmap.get(voter);
            this.supportBitmap.set(voter, u256.or(currentSupport, bit));
            this.votesForMap.set(pKey, SafeMath.add(this.votesForMap.get(pKey), weight));
        } else {
            this.votesAgainstMap.set(
                pKey,
                SafeMath.add(this.votesAgainstMap.get(pKey), weight),
            );
        }

        this.emitEvent(new VoteCastEvent(proposalId, voter, support, weight));

        return new BytesWriter(0);
    }

    // ── View methods ────────────────────────────────────────────────────

    @view
    @method({ name: 'proposalId', type: ABIDataTypes.UINT256 })
    @returns(
        { name: 'descriptionHash', type: ABIDataTypes.UINT256 },
        { name: 'startBlock', type: ABIDataTypes.UINT256 },
        { name: 'endBlock', type: ABIDataTypes.UINT256 },
        { name: 'votesFor', type: ABIDataTypes.UINT256 },
        { name: 'votesAgainst', type: ABIDataTypes.UINT256 },
        { name: 'proposalCount', type: ABIDataTypes.UINT256 },
    )
    public getProposal(calldata: Calldata): BytesWriter {
        const proposalId: u256 = calldata.readU256();
        const pKey: Address = this._proposalKey(proposalId);

        const writer: BytesWriter = new BytesWriter(U256_BYTE_LENGTH * 6);
        writer.writeU256(this.descHashMap.get(pKey));
        writer.writeU256(this.startBlockMap.get(pKey));
        writer.writeU256(this.endBlockMap.get(pKey));
        writer.writeU256(this.votesForMap.get(pKey));
        writer.writeU256(this.votesAgainstMap.get(pKey));
        writer.writeU256(this.proposalCount.value);
        return writer;
    }

    @view
    @method(
        { name: 'proposalId', type: ABIDataTypes.UINT256 },
        { name: 'voter', type: ABIDataTypes.ADDRESS },
    )
    @returns(
        { name: 'hasVoted', type: ABIDataTypes.BOOL },
        { name: 'support', type: ABIDataTypes.BOOL },
    )
    public getVote(calldata: Calldata): BytesWriter {
        const proposalId: u256 = calldata.readU256();
        const voter: Address = calldata.readAddress();

        const bitIndex: i32 = <i32>proposalId.lo1;
        const bit: u256 = u256.shl(u256.One, bitIndex);

        const voted: bool = !u256.and(this.votedBitmap.get(voter), bit).isZero();
        const supportVote: bool = !u256.and(this.supportBitmap.get(voter), bit).isZero();

        const writer: BytesWriter = new BytesWriter(2);
        writer.writeBoolean(voted);
        writer.writeBoolean(supportVote);
        return writer;
    }

    @view
    @method()
    @returns({ name: 'count', type: ABIDataTypes.UINT256 })
    public getProposalCount(_calldata: Calldata): BytesWriter {
        const writer: BytesWriter = new BytesWriter(U256_BYTE_LENGTH);
        writer.writeU256(this.proposalCount.value);
        return writer;
    }

    // ── Internal ────────────────────────────────────────────────────────

    private _proposalKey(proposalId: u256): Address {
        const bytes: Uint8Array = proposalId.toUint8Array();
        return Address.fromUint8Array(bytes);
    }

    private _getVotingPower(voter: Address): u256 {
        const writer: BytesWriter = new BytesWriter(36);
        writer.writeSelector(BALANCE_OF_SELECTOR);
        writer.writeAddress(voter);

        const result = Blockchain.call(this.tokenAddress.value, writer, true);
        return result.data.readU256();
    }

    private _onlyOwner(): void {
        if (!Blockchain.tx.sender.equals(this.owner.value)) {
            throw new Revert('Only owner');
        }
    }
}
