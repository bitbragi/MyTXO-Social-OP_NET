import { u256 } from '@btc-vision/as-bignum/assembly';
import {
    Address,
    AddressMemoryMap,
    Blockchain,
    BytesWriter,
    Calldata,
    MapOfMap,
    NetEvent,
    Revert,
    SafeMath,
    StoredAddress,
    StoredMapU256,
} from '@btc-vision/btc-runtime/runtime';
import { ReentrancyGuard } from '@btc-vision/btc-runtime/runtime/contracts/ReentrancyGuard';
import { ADDRESS_BYTE_LENGTH, U256_BYTE_LENGTH } from '@btc-vision/btc-runtime/runtime/utils';


// ── Events ──────────────────────────────────────────────────────────────────

class FriendRequestSentEvent extends NetEvent {
    constructor(sender: Address, target: Address) {
        const data: BytesWriter = new BytesWriter(ADDRESS_BYTE_LENGTH * 2);
        data.writeAddress(sender);
        data.writeAddress(target);
        super('FriendRequestSent', data);
    }
}

class FriendRequestAcceptedEvent extends NetEvent {
    constructor(accepter: Address, requester: Address) {
        const data: BytesWriter = new BytesWriter(ADDRESS_BYTE_LENGTH * 2);
        data.writeAddress(accepter);
        data.writeAddress(requester);
        super('FriendRequestAccepted', data);
    }
}

class FriendRequestDeniedEvent extends NetEvent {
    constructor(denier: Address, requester: Address) {
        const data: BytesWriter = new BytesWriter(ADDRESS_BYTE_LENGTH * 2);
        data.writeAddress(denier);
        data.writeAddress(requester);
        super('FriendRequestDenied', data);
    }
}

class FriendRemovedEvent extends NetEvent {
    constructor(remover: Address, target: Address) {
        const data: BytesWriter = new BytesWriter(ADDRESS_BYTE_LENGTH * 2);
        data.writeAddress(remover);
        data.writeAddress(target);
        super('FriendRemoved', data);
    }
}

class FriendRequestCancelledEvent extends NetEvent {
    constructor(canceller: Address, target: Address) {
        const data: BytesWriter = new BytesWriter(ADDRESS_BYTE_LENGTH * 2);
        data.writeAddress(canceller);
        data.writeAddress(target);
        super('FriendRequestCancelled', data);
    }
}

class ReNFTMintedEvent extends NetEvent {
    constructor(
        retweeter: Address,
        contentHash: u256,
        hasMessage: bool,
        originalContract: Address,
        originalTokenId: u256,
    ) {
        const data: BytesWriter = new BytesWriter(
            ADDRESS_BYTE_LENGTH + U256_BYTE_LENGTH + 1 + ADDRESS_BYTE_LENGTH + U256_BYTE_LENGTH,
        );
        data.writeAddress(retweeter);
        data.writeU256(contentHash);
        data.writeBoolean(hasMessage);
        data.writeAddress(originalContract);
        data.writeU256(originalTokenId);
        super('ReNFTMinted', data);
    }
}

class Top8UpdatedEvent extends NetEvent {
    constructor(user: Address, count: u256) {
        const data: BytesWriter = new BytesWriter(ADDRESS_BYTE_LENGTH + U256_BYTE_LENGTH);
        data.writeAddress(user);
        data.writeU256(count);
        super('Top8Updated', data);
    }
}

// ── Storage Pointers ────────────────────────────────────────────────────────

const ownerPointer: u16 = Blockchain.nextPointer;
const friendCountsPointer: u16 = Blockchain.nextPointer;
const pendingInCountsPointer: u16 = Blockchain.nextPointer;
const pendingRequestsPointer: u16 = Blockchain.nextPointer;
const friendsPointer: u16 = Blockchain.nextPointer;

const pendingInListPointer: u16 = Blockchain.nextPointer;
const pendingInIndexPointer: u16 = Blockchain.nextPointer;
const friendListPointer: u16 = Blockchain.nextPointer;
const friendListIndexPointer: u16 = Blockchain.nextPointer;

// Re-NFT storage
const reNFTCountsPointer: u16 = Blockchain.nextPointer;
const reNFTListPointer: u16 = Blockchain.nextPointer;
const reNFTIndexPointer: u16 = Blockchain.nextPointer;
const reNFTMessageHashPointer: u16 = Blockchain.nextPointer;
const userReNFTListPointer: u16 = Blockchain.nextPointer;
const userReNFTCountsPointer: u16 = Blockchain.nextPointer;

// Re-NFT source tracking (originalContract, originalTokenId per contentHash)
const reNFTSourceContractPointer: u16 = Blockchain.nextPointer;
const reNFTSourceTokenIdPointer: u16 = Blockchain.nextPointer;

// Top 8 storage
const top8ListPointer: u16 = Blockchain.nextPointer;
const top8CountPointer: u16 = Blockchain.nextPointer;

// Background inscription storage: txid + output index per user
const bgTxidPointer: u16 = Blockchain.nextPointer;
const bgIdxPointer: u16 = Blockchain.nextPointer;

/**
 * MyTXOSocial — Social interactions for the MyTXO platform.
 *
 * Manages:
 * - MySpace-style bidirectional friendships (send/accept/deny/remove)
 * - Re-NFTs: users "re-mint" another user's blurb with an optional quote message
 * - Legend score computation
 *
 * Friendship state: 0=none, 1=pending, 2=mutual friends.
 * Re-NFTs: one per user per content hash. Enumerable per-content and per-user.
 */
@final
export class MyTXOSocial extends ReentrancyGuard {
    private readonly owner: StoredAddress;
    private readonly friendCounts: AddressMemoryMap;
    private readonly pendingInCounts: AddressMemoryMap;
    private readonly pendingRequests: MapOfMap<u256>;
    private readonly friends: MapOfMap<u256>;

    private readonly pendingInList: MapOfMap<u256>;
    private readonly pendingInIndex: MapOfMap<u256>;
    private readonly friendList: MapOfMap<u256>;
    private readonly friendListIndex: MapOfMap<u256>;

    // Re-NFT: per-content enumerable list of retweeters
    private readonly reNFTCounts: StoredMapU256;
    private readonly reNFTList: MapOfMap<u256>;
    private readonly reNFTIndex: MapOfMap<u256>;
    private readonly reNFTMessageHash: MapOfMap<u256>;

    // Re-NFT: per-user enumerable list of content hashes
    private readonly userReNFTList: MapOfMap<u256>;
    private readonly userReNFTCounts: AddressMemoryMap;

    // Re-NFT source: keyed by contentHash-as-address → original contract/tokenId
    private readonly reNFTSourceContracts: AddressMemoryMap;
    private readonly reNFTSourceTokenIds: StoredMapU256;

    // Top 8: per-user ordered list of up to 8 friend addresses
    private readonly top8List: MapOfMap<u256>;
    private readonly top8Counts: AddressMemoryMap;

    // Background inscription: txid + output index per user
    private readonly bgTxids: AddressMemoryMap;
    private readonly bgIdxs: AddressMemoryMap;

    public constructor() {
        super();
        this.owner = new StoredAddress(ownerPointer);
        this.friendCounts = new AddressMemoryMap(friendCountsPointer);
        this.pendingInCounts = new AddressMemoryMap(pendingInCountsPointer);
        this.pendingRequests = new MapOfMap<u256>(pendingRequestsPointer);
        this.friends = new MapOfMap<u256>(friendsPointer);

        this.pendingInList = new MapOfMap<u256>(pendingInListPointer);
        this.pendingInIndex = new MapOfMap<u256>(pendingInIndexPointer);
        this.friendList = new MapOfMap<u256>(friendListPointer);
        this.friendListIndex = new MapOfMap<u256>(friendListIndexPointer);

        this.reNFTCounts = new StoredMapU256(reNFTCountsPointer);
        this.reNFTList = new MapOfMap<u256>(reNFTListPointer);
        this.reNFTIndex = new MapOfMap<u256>(reNFTIndexPointer);
        this.reNFTMessageHash = new MapOfMap<u256>(reNFTMessageHashPointer);
        this.userReNFTList = new MapOfMap<u256>(userReNFTListPointer);
        this.userReNFTCounts = new AddressMemoryMap(userReNFTCountsPointer);

        this.reNFTSourceContracts = new AddressMemoryMap(reNFTSourceContractPointer);
        this.reNFTSourceTokenIds = new StoredMapU256(reNFTSourceTokenIdPointer);

        this.top8List = new MapOfMap<u256>(top8ListPointer);
        this.top8Counts = new AddressMemoryMap(top8CountPointer);

        this.bgTxids = new AddressMemoryMap(bgTxidPointer);
        this.bgIdxs = new AddressMemoryMap(bgIdxPointer);
    }

    public override onDeployment(calldata: Calldata): void {
        const ownerAddr: Address = calldata.readAddress();
        this.owner.value = ownerAddr;
    }

    public override onUpdate(_calldata: Calldata): void {
        super.onUpdate(_calldata);
    }

    // ── Friendship Methods ──────────────────────────────────────────────────

    @method(
        { name: 'myProfile', type: ABIDataTypes.ADDRESS },
        { name: 'target', type: ABIDataTypes.ADDRESS },
    )
    @returns({ name: 'success', type: ABIDataTypes.BOOL })
    public sendFriendRequest(calldata: Calldata): BytesWriter {
        const myProfile: Address = calldata.readAddress();
        const target: Address = calldata.readAddress();

        if (myProfile == target) {
            throw new Revert('Cannot friend yourself');
        }

        if (this.friends.get(myProfile).get(target) == u256.One) {
            throw new Revert('Already friends');
        }

        if (this.pendingRequests.get(myProfile).get(target) == u256.One) {
            throw new Revert('Request already pending');
        }

        if (this.pendingRequests.get(target).get(myProfile) == u256.One) {
            return this._acceptFriend(myProfile, target);
        }

        const senderNested = this.pendingRequests.get(myProfile);
        senderNested.set(target, u256.One);
        this.pendingRequests.set(myProfile, senderNested);

        const count: u256 = this.pendingInCounts.get(target);
        this._pendingInListAppend(target, myProfile, count);
        this.pendingInCounts.set(target, SafeMath.add(count, u256.One));

        this.emitEvent(new FriendRequestSentEvent(myProfile, target));

        const response: BytesWriter = new BytesWriter(1);
        response.writeBoolean(true);
        return response;
    }

    @method(
        { name: 'myProfile', type: ABIDataTypes.ADDRESS },
        { name: 'requester', type: ABIDataTypes.ADDRESS },
    )
    @returns({ name: 'success', type: ABIDataTypes.BOOL })
    public acceptFriendRequest(calldata: Calldata): BytesWriter {
        const myProfile: Address = calldata.readAddress();
        const requester: Address = calldata.readAddress();
        return this._acceptFriend(myProfile, requester);
    }

    @method(
        { name: 'myProfile', type: ABIDataTypes.ADDRESS },
        { name: 'requester', type: ABIDataTypes.ADDRESS },
    )
    @returns({ name: 'success', type: ABIDataTypes.BOOL })
    public denyFriendRequest(calldata: Calldata): BytesWriter {
        const myProfile: Address = calldata.readAddress();
        const requester: Address = calldata.readAddress();

        if (this.pendingRequests.get(requester).get(myProfile) != u256.One) {
            throw new Revert('No pending request from this user');
        }

        const requesterNested = this.pendingRequests.get(requester);
        requesterNested.set(myProfile, u256.Zero);
        this.pendingRequests.set(requester, requesterNested);

        const count: u256 = this.pendingInCounts.get(myProfile);
        this._pendingInListRemove(myProfile, requester, count);
        if (count > u256.Zero) {
            this.pendingInCounts.set(myProfile, SafeMath.sub(count, u256.One));
        }

        this.emitEvent(new FriendRequestDeniedEvent(myProfile, requester));

        const response: BytesWriter = new BytesWriter(1);
        response.writeBoolean(true);
        return response;
    }

    @method(
        { name: 'myProfile', type: ABIDataTypes.ADDRESS },
        { name: 'target', type: ABIDataTypes.ADDRESS },
    )
    @returns({ name: 'success', type: ABIDataTypes.BOOL })
    public removeFriend(calldata: Calldata): BytesWriter {
        const myProfile: Address = calldata.readAddress();
        const target: Address = calldata.readAddress();

        if (this.friends.get(myProfile).get(target) != u256.One) {
            throw new Revert('Not friends');
        }

        const senderNested = this.friends.get(myProfile);
        senderNested.set(target, u256.Zero);
        this.friends.set(myProfile, senderNested);

        const targetNested = this.friends.get(target);
        targetNested.set(myProfile, u256.Zero);
        this.friends.set(target, targetNested);

        const senderCount: u256 = this.friendCounts.get(myProfile);
        if (senderCount > u256.Zero) {
            this._friendListRemove(myProfile, target, senderCount);
            this.friendCounts.set(myProfile, SafeMath.sub(senderCount, u256.One));
        }

        const targetCount: u256 = this.friendCounts.get(target);
        if (targetCount > u256.Zero) {
            this._friendListRemove(target, myProfile, targetCount);
            this.friendCounts.set(target, SafeMath.sub(targetCount, u256.One));
        }

        this.emitEvent(new FriendRemovedEvent(myProfile, target));

        const response: BytesWriter = new BytesWriter(1);
        response.writeBoolean(true);
        return response;
    }

    @method(
        { name: 'myProfile', type: ABIDataTypes.ADDRESS },
        { name: 'target', type: ABIDataTypes.ADDRESS },
    )
    @returns({ name: 'success', type: ABIDataTypes.BOOL })
    public cancelFriendRequest(calldata: Calldata): BytesWriter {
        const myProfile: Address = calldata.readAddress();
        const target: Address = calldata.readAddress();

        if (this.pendingRequests.get(myProfile).get(target) != u256.One) {
            throw new Revert('No pending request to cancel');
        }

        const senderNested = this.pendingRequests.get(myProfile);
        senderNested.set(target, u256.Zero);
        this.pendingRequests.set(myProfile, senderNested);

        const count: u256 = this.pendingInCounts.get(target);
        this._pendingInListRemove(target, myProfile, count);
        if (count > u256.Zero) {
            this.pendingInCounts.set(target, SafeMath.sub(count, u256.One));
        }

        this.emitEvent(new FriendRequestCancelledEvent(myProfile, target));

        const response: BytesWriter = new BytesWriter(1);
        response.writeBoolean(true);
        return response;
    }

    // ── Re-NFT Methods ──────────────────────────────────────────────────────

    @method(
        { name: 'myProfile', type: ABIDataTypes.ADDRESS },
        { name: 'contentHash', type: ABIDataTypes.UINT256 },
        { name: 'message', type: ABIDataTypes.STRING },
        { name: 'originalContract', type: ABIDataTypes.ADDRESS },
        { name: 'originalTokenId', type: ABIDataTypes.UINT256 },
    )
    @returns({ name: 'success', type: ABIDataTypes.BOOL })
    public reNFT(calldata: Calldata): BytesWriter {
        const myProfile: Address = calldata.readAddress();
        const contentHash: u256 = calldata.readU256();
        const message: string = calldata.readStringWithLength();
        const originalContract: Address = calldata.readAddress();
        const originalTokenId: u256 = calldata.readU256();

        const contentAddr: Address = this.u256ToAddress(contentHash);

        // One Re-NFT per user per content
        const existingIdx: u256 = this.reNFTIndex.get(contentAddr).get(myProfile);
        if (existingIdx != u256.Zero) {
            throw new Revert('Already Re-NFTd');
        }

        // Add to per-content enumerable list
        const contentCount: u256 = this.reNFTCounts.get(contentHash);
        const contentNested = this.reNFTList.get(contentAddr);
        const countAddr: Address = this.u256ToAddress(contentCount);
        contentNested.set(countAddr, this.addressToU256(myProfile));
        this.reNFTList.set(contentAddr, contentNested);

        const storedIdx: u256 = SafeMath.add(contentCount, u256.One);
        const indexNested = this.reNFTIndex.get(contentAddr);
        indexNested.set(myProfile, storedIdx);
        this.reNFTIndex.set(contentAddr, indexNested);

        this.reNFTCounts.set(contentHash, SafeMath.add(contentCount, u256.One));

        // Store message flag if message is non-empty
        const hasMessage: bool = message.length > 0;
        if (hasMessage) {
            const msgNested = this.reNFTMessageHash.get(contentAddr);
            msgNested.set(myProfile, u256.One);
            this.reNFTMessageHash.set(contentAddr, msgNested);
        }

        // Store original source (first writer wins -- source is immutable per contentHash)
        const existingSource: u256 = this.reNFTSourceContracts.get(contentAddr);
        if (existingSource == u256.Zero) {
            this.reNFTSourceContracts.set(contentAddr, this.addressToU256(originalContract));
            this.reNFTSourceTokenIds.set(contentHash, originalTokenId);
        }

        // Add to per-user enumerable list
        const userCount: u256 = this.userReNFTCounts.get(myProfile);
        const userNested = this.userReNFTList.get(myProfile);
        const userCountAddr: Address = this.u256ToAddress(userCount);
        userNested.set(userCountAddr, contentHash);
        this.userReNFTList.set(myProfile, userNested);
        this.userReNFTCounts.set(myProfile, SafeMath.add(userCount, u256.One));

        this.emitEvent(
            new ReNFTMintedEvent(myProfile, contentHash, hasMessage, originalContract, originalTokenId),
        );

        const response: BytesWriter = new BytesWriter(1);
        response.writeBoolean(true);
        return response;
    }

    // ── Top 8 Methods ───────────────────────────────────────────────────────

    @method(
        { name: 'myProfile', type: ABIDataTypes.ADDRESS },
        { name: 'count', type: ABIDataTypes.UINT256 },
    )
    @returns({ name: 'success', type: ABIDataTypes.BOOL })
    public setTop8(calldata: Calldata): BytesWriter {
        const myProfile: Address = calldata.readAddress();
        const count: u256 = calldata.readU256();
        const countU64: u64 = count.toU64();

        if (countU64 > 8) {
            throw new Revert('Top 8 max is 8');
        }

        const profileNested = this.top8List.get(myProfile);

        // Clear old slots
        const oldCount: u256 = this.top8Counts.get(myProfile);
        const oldCountU64: u64 = oldCount.toU64();
        for (let i: u64 = 0; i < oldCountU64; i++) {
            const idxAddr: Address = this.u256ToAddress(u256.fromU64(i));
            profileNested.set(idxAddr, u256.Zero);
        }

        // Write new slots
        for (let i: u64 = 0; i < countU64; i++) {
            const friendAddr: Address = calldata.readAddress();
            const idxAddr: Address = this.u256ToAddress(u256.fromU64(i));
            profileNested.set(idxAddr, this.addressToU256(friendAddr));
        }

        this.top8List.set(myProfile, profileNested);
        this.top8Counts.set(myProfile, count);

        this.emitEvent(new Top8UpdatedEvent(myProfile, count));

        const response: BytesWriter = new BytesWriter(1);
        response.writeBoolean(true);
        return response;
    }

    @view
    @method({ name: 'user', type: ABIDataTypes.ADDRESS })
    @returns({ name: 'count', type: ABIDataTypes.UINT256 })
    public getTop8(calldata: Calldata): BytesWriter {
        const user: Address = calldata.readAddress();
        const count: u256 = this.top8Counts.get(user);
        const countU64: u64 = count.toU64();

        const response: BytesWriter = new BytesWriter(
            U256_BYTE_LENGTH + U256_BYTE_LENGTH * i32(countU64),
        );
        response.writeU256(count);

        const userNested = this.top8List.get(user);
        for (let i: u64 = 0; i < countU64; i++) {
            const idxAddr: Address = this.u256ToAddress(u256.fromU64(i));
            response.writeU256(userNested.get(idxAddr));
        }

        return response;
    }

    // ── Background Inscription Methods ──────────────────────────────────────

    @method(
        { name: 'myProfile', type: ABIDataTypes.ADDRESS },
        { name: 'txid', type: ABIDataTypes.UINT256 },
        { name: 'outputIndex', type: ABIDataTypes.UINT256 },
    )
    @returns({ name: 'success', type: ABIDataTypes.BOOL })
    public setBackground(calldata: Calldata): BytesWriter {
        const myProfile: Address = calldata.readAddress();
        const txid: u256 = calldata.readU256();
        const outputIndex: u256 = calldata.readU256();

        this.bgTxids.set(myProfile, txid);
        this.bgIdxs.set(myProfile, outputIndex);

        const response: BytesWriter = new BytesWriter(1);
        response.writeBoolean(true);
        return response;
    }

    @view
    @method({ name: 'user', type: ABIDataTypes.ADDRESS })
    @returns(
        { name: 'txid', type: ABIDataTypes.UINT256 },
        { name: 'outputIndex', type: ABIDataTypes.UINT256 },
    )
    public getBackground(calldata: Calldata): BytesWriter {
        const user: Address = calldata.readAddress();
        const response: BytesWriter = new BytesWriter(U256_BYTE_LENGTH * 2);
        response.writeU256(this.bgTxids.get(user));
        response.writeU256(this.bgIdxs.get(user));
        return response;
    }

    // ── View Methods ────────────────────────────────────────────────────────

    @view
    @method({ name: 'user', type: ABIDataTypes.ADDRESS })
    @returns(
        { name: 'friendCount', type: ABIDataTypes.UINT256 },
        { name: 'pendingInCount', type: ABIDataTypes.UINT256 },
    )
    public getCounts(calldata: Calldata): BytesWriter {
        const user: Address = calldata.readAddress();
        const response: BytesWriter = new BytesWriter(U256_BYTE_LENGTH * 2);
        response.writeU256(this.friendCounts.get(user));
        response.writeU256(this.pendingInCounts.get(user));
        return response;
    }

    @view
    @method(
        { name: 'userA', type: ABIDataTypes.ADDRESS },
        { name: 'userB', type: ABIDataTypes.ADDRESS },
    )
    @returns(
        { name: 'areFriends', type: ABIDataTypes.BOOL },
        { name: 'aPendingToB', type: ABIDataTypes.BOOL },
        { name: 'bPendingToA', type: ABIDataTypes.BOOL },
    )
    public getFriendshipStatus(calldata: Calldata): BytesWriter {
        const userA: Address = calldata.readAddress();
        const userB: Address = calldata.readAddress();

        const response: BytesWriter = new BytesWriter(3);
        response.writeBoolean(this.friends.get(userA).get(userB) == u256.One);
        response.writeBoolean(this.pendingRequests.get(userA).get(userB) == u256.One);
        response.writeBoolean(this.pendingRequests.get(userB).get(userA) == u256.One);
        return response;
    }

    @view
    @method({ name: 'contentHash', type: ABIDataTypes.UINT256 })
    @returns({ name: 'count', type: ABIDataTypes.UINT256 })
    public getReNFTCount(calldata: Calldata): BytesWriter {
        const contentHash: u256 = calldata.readU256();
        const response: BytesWriter = new BytesWriter(U256_BYTE_LENGTH);
        response.writeU256(this.reNFTCounts.get(contentHash));
        return response;
    }

    @view
    @method(
        { name: 'user', type: ABIDataTypes.ADDRESS },
        { name: 'contentHash', type: ABIDataTypes.UINT256 },
    )
    @returns({ name: 'hasReNFTd', type: ABIDataTypes.BOOL })
    public hasReNFTd(calldata: Calldata): BytesWriter {
        const user: Address = calldata.readAddress();
        const contentHash: u256 = calldata.readU256();
        const contentAddr: Address = this.u256ToAddress(contentHash);
        const storedIdx: u256 = this.reNFTIndex.get(contentAddr).get(user);
        const response: BytesWriter = new BytesWriter(1);
        response.writeBoolean(storedIdx != u256.Zero);
        return response;
    }

    @view
    @method(
        { name: 'contentHash', type: ABIDataTypes.UINT256 },
        { name: 'offset', type: ABIDataTypes.UINT256 },
        { name: 'limit', type: ABIDataTypes.UINT256 },
    )
    @returns({ name: 'count', type: ABIDataTypes.UINT256 })
    public getReNFTs(calldata: Calldata): BytesWriter {
        const contentHash: u256 = calldata.readU256();
        const offset: u256 = calldata.readU256();
        const limit: u256 = calldata.readU256();

        const total: u256 = this.reNFTCounts.get(contentHash);
        const maxItems: u64 = 50;
        let itemLimit: u64 = limit.toU64();
        if (itemLimit > maxItems) itemLimit = maxItems;

        let actualCount: u64 = 0;
        const offsetU64: u64 = offset.toU64();
        const totalU64: u64 = total.toU64();

        if (offsetU64 < totalU64) {
            const available: u64 = totalU64 - offsetU64;
            actualCount = available < itemLimit ? available : itemLimit;
        }

        const response: BytesWriter = new BytesWriter(
            U256_BYTE_LENGTH + U256_BYTE_LENGTH * i32(actualCount),
        );
        response.writeU256(u256.fromU64(actualCount));

        const contentAddr: Address = this.u256ToAddress(contentHash);
        const contentNested = this.reNFTList.get(contentAddr);
        for (let i: u64 = 0; i < actualCount; i++) {
            const idx: u256 = u256.fromU64(offsetU64 + i);
            const idxAddr: Address = this.u256ToAddress(idx);
            response.writeU256(contentNested.get(idxAddr));
        }

        return response;
    }

    @view
    @method(
        { name: 'user', type: ABIDataTypes.ADDRESS },
        { name: 'offset', type: ABIDataTypes.UINT256 },
        { name: 'limit', type: ABIDataTypes.UINT256 },
    )
    @returns({ name: 'count', type: ABIDataTypes.UINT256 })
    public getUserReNFTs(calldata: Calldata): BytesWriter {
        const user: Address = calldata.readAddress();
        const offset: u256 = calldata.readU256();
        const limit: u256 = calldata.readU256();

        const total: u256 = this.userReNFTCounts.get(user);
        const maxItems: u64 = 50;
        let itemLimit: u64 = limit.toU64();
        if (itemLimit > maxItems) itemLimit = maxItems;

        let actualCount: u64 = 0;
        const offsetU64: u64 = offset.toU64();
        const totalU64: u64 = total.toU64();

        if (offsetU64 < totalU64) {
            const available: u64 = totalU64 - offsetU64;
            actualCount = available < itemLimit ? available : itemLimit;
        }

        const response: BytesWriter = new BytesWriter(
            U256_BYTE_LENGTH + U256_BYTE_LENGTH * i32(actualCount),
        );
        response.writeU256(u256.fromU64(actualCount));

        const userNested = this.userReNFTList.get(user);
        for (let i: u64 = 0; i < actualCount; i++) {
            const idx: u256 = u256.fromU64(offsetU64 + i);
            const idxAddr: Address = this.u256ToAddress(idx);
            response.writeU256(userNested.get(idxAddr));
        }

        return response;
    }

    @view
    @method({ name: 'contentHash', type: ABIDataTypes.UINT256 })
    @returns(
        { name: 'originalContract', type: ABIDataTypes.UINT256 },
        { name: 'originalTokenId', type: ABIDataTypes.UINT256 },
    )
    public getReNFTSource(calldata: Calldata): BytesWriter {
        const contentHash: u256 = calldata.readU256();
        const contentAddr: Address = this.u256ToAddress(contentHash);
        const response: BytesWriter = new BytesWriter(U256_BYTE_LENGTH * 2);
        response.writeU256(this.reNFTSourceContracts.get(contentAddr));
        response.writeU256(this.reNFTSourceTokenIds.get(contentHash));
        return response;
    }

    @view
    @method(
        { name: 'user', type: ABIDataTypes.ADDRESS },
        { name: 'hasAvatar', type: ABIDataTypes.BOOL },
        { name: 'hasPlaylist', type: ABIDataTypes.BOOL },
        { name: 'guestbookCount', type: ABIDataTypes.UINT256 },
        { name: 'blurbCount', type: ABIDataTypes.UINT256 },
    )
    @returns({ name: 'score', type: ABIDataTypes.UINT256 })
    public getLegendScore(calldata: Calldata): BytesWriter {
        const user: Address = calldata.readAddress();
        const hasAvatar: bool = calldata.readBoolean();
        const hasPlaylist: bool = calldata.readBoolean();
        const guestbookCount: u256 = calldata.readU256();
        const blurbCount: u256 = calldata.readU256();

        let score: u256 = u256.fromU64(10);

        if (hasAvatar) score = SafeMath.add(score, u256.fromU64(10));
        if (hasPlaylist) score = SafeMath.add(score, u256.fromU64(10));

        const fc: u256 = this.friendCounts.get(user);
        let friendPoints: u256 = SafeMath.mul(fc, u256.fromU64(5));
        const maxFriendPoints: u256 = u256.fromU64(100);
        if (friendPoints > maxFriendPoints) friendPoints = maxFriendPoints;
        score = SafeMath.add(score, friendPoints);

        let gbPoints: u256 = SafeMath.mul(guestbookCount, u256.fromU64(3));
        const maxGbPoints: u256 = u256.fromU64(60);
        if (gbPoints > maxGbPoints) gbPoints = maxGbPoints;
        score = SafeMath.add(score, gbPoints);

        let blurbPoints: u256 = SafeMath.mul(blurbCount, u256.fromU64(2));
        const maxBlurbPoints: u256 = u256.fromU64(40);
        if (blurbPoints > maxBlurbPoints) blurbPoints = maxBlurbPoints;
        score = SafeMath.add(score, blurbPoints);

        const response: BytesWriter = new BytesWriter(U256_BYTE_LENGTH);
        response.writeU256(score);
        return response;
    }

    @view
    @method(
        { name: 'user', type: ABIDataTypes.ADDRESS },
        { name: 'offset', type: ABIDataTypes.UINT256 },
        { name: 'limit', type: ABIDataTypes.UINT256 },
    )
    @returns({ name: 'count', type: ABIDataTypes.UINT256 })
    public getPendingRequesters(calldata: Calldata): BytesWriter {
        const user: Address = calldata.readAddress();
        const offset: u256 = calldata.readU256();
        const limit: u256 = calldata.readU256();

        const total: u256 = this.pendingInCounts.get(user);
        const maxItems: u64 = 50;
        let itemLimit: u64 = limit.toU64();
        if (itemLimit > maxItems) itemLimit = maxItems;

        let actualCount: u64 = 0;
        const offsetU64: u64 = offset.toU64();
        const totalU64: u64 = total.toU64();

        if (offsetU64 < totalU64) {
            const available: u64 = totalU64 - offsetU64;
            actualCount = available < itemLimit ? available : itemLimit;
        }

        const response: BytesWriter = new BytesWriter(
            U256_BYTE_LENGTH + ADDRESS_BYTE_LENGTH * i32(actualCount),
        );
        response.writeU256(u256.fromU64(actualCount));

        const userNested = this.pendingInList.get(user);
        for (let i: u64 = 0; i < actualCount; i++) {
            const idx: u256 = u256.fromU64(offsetU64 + i);
            const idxAddr: Address = this.u256ToAddress(idx);
            response.writeU256(userNested.get(idxAddr));
        }

        return response;
    }

    @view
    @method(
        { name: 'user', type: ABIDataTypes.ADDRESS },
        { name: 'offset', type: ABIDataTypes.UINT256 },
        { name: 'limit', type: ABIDataTypes.UINT256 },
    )
    @returns({ name: 'count', type: ABIDataTypes.UINT256 })
    public getFriendsList(calldata: Calldata): BytesWriter {
        const user: Address = calldata.readAddress();
        const offset: u256 = calldata.readU256();
        const limit: u256 = calldata.readU256();

        const total: u256 = this.friendCounts.get(user);
        const maxItems: u64 = 50;
        let itemLimit: u64 = limit.toU64();
        if (itemLimit > maxItems) itemLimit = maxItems;

        let actualCount: u64 = 0;
        const offsetU64: u64 = offset.toU64();
        const totalU64: u64 = total.toU64();

        if (offsetU64 < totalU64) {
            const available: u64 = totalU64 - offsetU64;
            actualCount = available < itemLimit ? available : itemLimit;
        }

        const response: BytesWriter = new BytesWriter(
            U256_BYTE_LENGTH + ADDRESS_BYTE_LENGTH * i32(actualCount),
        );
        response.writeU256(u256.fromU64(actualCount));

        const userNested = this.friendList.get(user);
        for (let i: u64 = 0; i < actualCount; i++) {
            const idx: u256 = u256.fromU64(offsetU64 + i);
            const idxAddr: Address = this.u256ToAddress(idx);
            response.writeU256(userNested.get(idxAddr));
        }

        return response;
    }

    // ── Internal Helpers ────────────────────────────────────────────────────

    private _acceptFriend(accepter: Address, requester: Address): BytesWriter {
        if (this.pendingRequests.get(requester).get(accepter) != u256.One) {
            throw new Revert('No pending request from this user');
        }

        const requesterNested = this.pendingRequests.get(requester);
        requesterNested.set(accepter, u256.Zero);
        this.pendingRequests.set(requester, requesterNested);

        const accepterFriends = this.friends.get(accepter);
        accepterFriends.set(requester, u256.One);
        this.friends.set(accepter, accepterFriends);

        const requesterFriends = this.friends.get(requester);
        requesterFriends.set(accepter, u256.One);
        this.friends.set(requester, requesterFriends);

        const accepterFc: u256 = this.friendCounts.get(accepter);
        this._friendListAppend(accepter, requester, accepterFc);
        this.friendCounts.set(accepter, SafeMath.add(accepterFc, u256.One));

        const requesterFc: u256 = this.friendCounts.get(requester);
        this._friendListAppend(requester, accepter, requesterFc);
        this.friendCounts.set(requester, SafeMath.add(requesterFc, u256.One));

        const pendingIn: u256 = this.pendingInCounts.get(accepter);
        this._pendingInListRemove(accepter, requester, pendingIn);
        if (pendingIn > u256.Zero) {
            this.pendingInCounts.set(accepter, SafeMath.sub(pendingIn, u256.One));
        }

        this.emitEvent(new FriendRequestAcceptedEvent(accepter, requester));

        const response: BytesWriter = new BytesWriter(1);
        response.writeBoolean(true);
        return response;
    }

    // ── Enumerable pending-in list helpers ───────────────────────────────────

    private _pendingInListAppend(target: Address, requester: Address, currentCount: u256): void {
        const countAddr: Address = this.u256ToAddress(currentCount);

        const listNested = this.pendingInList.get(target);
        listNested.set(countAddr, this.addressToU256(requester));
        this.pendingInList.set(target, listNested);

        const storedIdx: u256 = SafeMath.add(currentCount, u256.One);
        const indexNested = this.pendingInIndex.get(target);
        indexNested.set(requester, storedIdx);
        this.pendingInIndex.set(target, indexNested);
    }

    private _pendingInListRemove(target: Address, requester: Address, currentCount: u256): void {
        const indexNested = this.pendingInIndex.get(target);
        const storedIdx: u256 = indexNested.get(requester);
        if (storedIdx == u256.Zero) return;

        const idx: u256 = SafeMath.sub(storedIdx, u256.One);
        const lastIdx: u256 = SafeMath.sub(currentCount, u256.One);
        const idxAddr: Address = this.u256ToAddress(idx);
        const lastIdxAddr: Address = this.u256ToAddress(lastIdx);

        const listNested = this.pendingInList.get(target);

        if (idx != lastIdx) {
            const lastVal: u256 = listNested.get(lastIdxAddr);
            listNested.set(idxAddr, lastVal);
            const lastAddr: Address = this.u256ToAddress(lastVal);
            indexNested.set(lastAddr, storedIdx);
        }

        listNested.set(lastIdxAddr, u256.Zero);
        indexNested.set(requester, u256.Zero);

        this.pendingInList.set(target, listNested);
        this.pendingInIndex.set(target, indexNested);
    }

    // ── Enumerable friend list helpers ──────────────────────────────────────

    private _friendListAppend(user: Address, friend: Address, currentCount: u256): void {
        const countAddr: Address = this.u256ToAddress(currentCount);

        const listNested = this.friendList.get(user);
        listNested.set(countAddr, this.addressToU256(friend));
        this.friendList.set(user, listNested);

        const storedIdx: u256 = SafeMath.add(currentCount, u256.One);
        const indexNested = this.friendListIndex.get(user);
        indexNested.set(friend, storedIdx);
        this.friendListIndex.set(user, indexNested);
    }

    private _friendListRemove(user: Address, friend: Address, currentCount: u256): void {
        const indexNested = this.friendListIndex.get(user);
        const storedIdx: u256 = indexNested.get(friend);
        if (storedIdx == u256.Zero) return;

        const idx: u256 = SafeMath.sub(storedIdx, u256.One);
        const lastIdx: u256 = SafeMath.sub(currentCount, u256.One);
        const idxAddr: Address = this.u256ToAddress(idx);
        const lastIdxAddr: Address = this.u256ToAddress(lastIdx);

        const listNested = this.friendList.get(user);

        if (idx != lastIdx) {
            const lastVal: u256 = listNested.get(lastIdxAddr);
            listNested.set(idxAddr, lastVal);
            const lastFriendAddr: Address = this.u256ToAddress(lastVal);
            indexNested.set(lastFriendAddr, storedIdx);
        }

        listNested.set(lastIdxAddr, u256.Zero);
        indexNested.set(friend, u256.Zero);

        this.friendList.set(user, listNested);
        this.friendListIndex.set(user, indexNested);
    }

    // ── Utility ─────────────────────────────────────────────────────────────

    private addressToU256(addr: Address): u256 {
        if (addr.isZero()) {
            return u256.Zero;
        }
        return u256.fromUint8ArrayBE(addr);
    }

    private u256ToAddress(val: u256): Address {
        return changetype<Address>(val.toUint8Array(true));
    }

    private onlyOwner(): void {
        if (Blockchain.tx.sender !== this.owner.value) {
            throw new Revert('Only owner');
        }
    }
}
