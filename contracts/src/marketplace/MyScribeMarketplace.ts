import { u256 } from '@btc-vision/as-bignum/assembly';
import {
    Address,
    AddressMemoryMap,
    Blockchain,
    BytesWriter,
    Calldata,
    encodeSelector,
    OP_NET,
    Revert,
    SafeMath,
    Selector,
    StoredAddress,
    StoredMapU256,
    StoredU256,
    EMPTY_POINTER,
} from '@btc-vision/btc-runtime/runtime';

import { CallResult } from '@btc-vision/btc-runtime/runtime/env/BlockchainEnvironment';

import {
    ListingCreatedEvent,
    ListingCancelledEvent,
    ListingSoldEvent,
    BidPlacedEvent,
    BidCancelledEvent,
    BidAcceptedEvent,
    CollectionRegisteredEvent,
} from './events';

/**
 * MyScribe Marketplace — OP721 NFT Marketplace on OPNet.
 *
 * Forked from OpSea NFTMarketplace with the following improvements:
 * - @method/@returns/@emit decorators for ABI generation
 * - User-facing registerCollection (any user can register, deployer can curate)
 * - Checks-effects-interactions pattern enforced
 *
 * Storage Layout:
 * - Listings: nextListingId, collection, tokenId, seller, price, active
 * - Bids: nextBidId, collection, tokenId, bidder, amount, active
 * - Collections: royaltyBps, royaltyRecipient, registered
 * - Platform: feeBps, feeRecipient, totalVolume, totalListings
 */
@final
export class MyScribeMarketplace extends OP_NET {
    private readonly safeTransferFromSelector: Selector = encodeSelector('safeTransferFrom');
    private readonly isApprovedForAllSelector: Selector = encodeSelector('isApprovedForAll');
    private readonly ownerOfSelector: Selector = encodeSelector('ownerOf');

    private readonly listNFTSelector: Selector = encodeSelector('listNFT');
    private readonly cancelListingSelector: Selector = encodeSelector('cancelListing');
    private readonly buyNFTSelector: Selector = encodeSelector('buyNFT');
    private readonly placeBidSelector: Selector = encodeSelector('placeBid');
    private readonly cancelBidSelector: Selector = encodeSelector('cancelBid');
    private readonly acceptBidSelector: Selector = encodeSelector('acceptBid');
    private readonly registerCollectionSelector: Selector = encodeSelector('registerCollection');
    private readonly setPlatformFeeSelector: Selector = encodeSelector('setPlatformFee');
    private readonly setPlatformFeeRecipientSelector: Selector = encodeSelector('setPlatformFeeRecipient');
    private readonly updateRoyaltySelector: Selector = encodeSelector('updateRoyalty');
    private readonly getListingSelector: Selector = encodeSelector('getListing');
    private readonly getBidSelector: Selector = encodeSelector('getBid');
    private readonly getCollectionInfoSelector: Selector = encodeSelector('getCollectionInfo');
    private readonly getPlatformInfoSelector: Selector = encodeSelector('getPlatformInfo');

    private readonly nextListingIdPointer: u16 = Blockchain.nextPointer;
    private readonly listingCollectionPointer: u16 = Blockchain.nextPointer;
    private readonly listingTokenIdPointer: u16 = Blockchain.nextPointer;
    private readonly listingSellerPointer: u16 = Blockchain.nextPointer;
    private readonly listingPricePointer: u16 = Blockchain.nextPointer;
    private readonly listingActivePointer: u16 = Blockchain.nextPointer;

    private readonly nextBidIdPointer: u16 = Blockchain.nextPointer;
    private readonly bidCollectionPointer: u16 = Blockchain.nextPointer;
    private readonly bidTokenIdPointer: u16 = Blockchain.nextPointer;
    private readonly bidBidderPointer: u16 = Blockchain.nextPointer;
    private readonly bidAmountPointer: u16 = Blockchain.nextPointer;
    private readonly bidActivePointer: u16 = Blockchain.nextPointer;

    private readonly collectionRoyaltyBpsPointer: u16 = Blockchain.nextPointer;
    private readonly collectionRoyaltyRecipientPointer: u16 = Blockchain.nextPointer;
    private readonly collectionRegisteredPointer: u16 = Blockchain.nextPointer;

    private readonly platformFeeBpsPointer: u16 = Blockchain.nextPointer;
    private readonly platformFeeRecipientPointer: u16 = Blockchain.nextPointer;
    private readonly totalVolumePointer: u16 = Blockchain.nextPointer;
    private readonly totalListingsPointer: u16 = Blockchain.nextPointer;

    private readonly nextListingId: StoredU256 = new StoredU256(this.nextListingIdPointer, EMPTY_POINTER);
    private readonly listingCollectionMap: StoredMapU256 = new StoredMapU256(this.listingCollectionPointer);
    private readonly listingTokenIdMap: StoredMapU256 = new StoredMapU256(this.listingTokenIdPointer);
    private readonly listingSellerMap: StoredMapU256 = new StoredMapU256(this.listingSellerPointer);
    private readonly listingPriceMap: StoredMapU256 = new StoredMapU256(this.listingPricePointer);
    private readonly listingActiveMap: StoredMapU256 = new StoredMapU256(this.listingActivePointer);

    private readonly nextBidId: StoredU256 = new StoredU256(this.nextBidIdPointer, EMPTY_POINTER);
    private readonly bidCollectionMap: StoredMapU256 = new StoredMapU256(this.bidCollectionPointer);
    private readonly bidTokenIdMap: StoredMapU256 = new StoredMapU256(this.bidTokenIdPointer);
    private readonly bidBidderMap: StoredMapU256 = new StoredMapU256(this.bidBidderPointer);
    private readonly bidAmountMap: StoredMapU256 = new StoredMapU256(this.bidAmountPointer);
    private readonly bidActiveMap: StoredMapU256 = new StoredMapU256(this.bidActivePointer);

    private readonly collectionRoyaltyBpsMap: AddressMemoryMap = new AddressMemoryMap(this.collectionRoyaltyBpsPointer);
    private readonly collectionRoyaltyRecipientMap: StoredMapU256 = new StoredMapU256(this.collectionRoyaltyRecipientPointer);
    private readonly collectionRegisteredMap: AddressMemoryMap = new AddressMemoryMap(this.collectionRegisteredPointer);

    private readonly platformFeeBps: StoredU256 = new StoredU256(this.platformFeeBpsPointer, EMPTY_POINTER);
    private readonly platformFeeRecipient: StoredAddress = new StoredAddress(this.platformFeeRecipientPointer);
    private readonly totalVolume: StoredU256 = new StoredU256(this.totalVolumePointer, EMPTY_POINTER);
    private readonly totalListings: StoredU256 = new StoredU256(this.totalListingsPointer, EMPTY_POINTER);

    private readonly BPS_DENOMINATOR: u256 = u256.fromU32(10000);
    private readonly MAX_ROYALTY_BPS: u256 = u256.fromU32(1000);
    private readonly MAX_PLATFORM_FEE_BPS: u256 = u256.fromU32(500);
    private readonly ACTIVE: u256 = u256.One;
    private readonly INACTIVE: u256 = u256.Zero;

    public constructor() {
        super();
    }

    public override onDeployment(calldata: Calldata): void {
        super.onDeployment(calldata);

        const feeRecipient: Address = calldata.readAddress();
        const feeBps: u256 = calldata.readU256();

        if (feeRecipient.isZero()) {
            throw new Revert('Invalid fee recipient');
        }

        if (u256.gt(feeBps, this.MAX_PLATFORM_FEE_BPS)) {
            throw new Revert('Fee exceeds maximum');
        }

        this.platformFeeRecipient.value = feeRecipient;
        this.platformFeeBps.value = feeBps;
        this.nextListingId.value = u256.One;
        this.nextBidId.value = u256.One;
    }

    public override execute(method: Selector, calldata: Calldata): BytesWriter {
        switch (method) {
            case this.listNFTSelector:
                return this.listNFT(calldata);
            case this.cancelListingSelector:
                return this.cancelListing(calldata);
            case this.buyNFTSelector:
                return this.buyNFT(calldata);
            case this.placeBidSelector:
                return this.placeBid(calldata);
            case this.cancelBidSelector:
                return this.cancelBid(calldata);
            case this.acceptBidSelector:
                return this.acceptBid(calldata);
            case this.registerCollectionSelector:
                return this.registerCollection(calldata);
            case this.setPlatformFeeSelector:
                return this.setPlatformFee(calldata);
            case this.setPlatformFeeRecipientSelector:
                return this.setPlatformFeeRecipient(calldata);
            case this.updateRoyaltySelector:
                return this.updateRoyalty(calldata);
            case this.getListingSelector:
                return this.getListing(calldata);
            case this.getBidSelector:
                return this.getBid(calldata);
            case this.getCollectionInfoSelector:
                return this.getCollectionInfo(calldata);
            case this.getPlatformInfoSelector:
                return this.getPlatformInfo(calldata);
            default:
                return super.execute(method, calldata);
        }
    }

    private addressToU256(addr: Address): u256 {
        return u256.fromUint8ArrayBE(addr);
    }

    private u256ToAddress(val: u256): Address {
        return Address.fromUint8Array(val.toUint8Array(true));
    }

    @method(
        { name: 'collection', type: ABIDataTypes.ADDRESS },
        { name: 'tokenId', type: ABIDataTypes.UINT256 },
        { name: 'price', type: ABIDataTypes.UINT256 },
    )
    @returns({ name: 'listingId', type: ABIDataTypes.UINT256 })
    @emit('ListingCreated')
    private listNFT(calldata: Calldata): BytesWriter {
        const collectionAddr: Address = calldata.readAddress();
        const tokenId: u256 = calldata.readU256();
        const price: u256 = calldata.readU256();
        const sender: Address = Blockchain.tx.sender;

        if (collectionAddr.isZero()) {
            throw new Revert('Invalid collection address');
        }

        if (u256.eq(price, u256.Zero)) {
            throw new Revert('Price must be greater than zero');
        }

        this.verifyOwnership(collectionAddr, tokenId, sender);
        this.verifyApproval(collectionAddr, sender);

        const listingId: u256 = this.nextListingId.value;

        this.nextListingId.value = SafeMath.add(listingId, u256.One);
        this.listingCollectionMap.set(listingId, this.addressToU256(collectionAddr));
        this.listingTokenIdMap.set(listingId, tokenId);
        this.listingSellerMap.set(listingId, this.addressToU256(sender));
        this.listingPriceMap.set(listingId, price);
        this.listingActiveMap.set(listingId, this.ACTIVE);
        this.totalListings.value = SafeMath.add(this.totalListings.value, u256.One);

        this.emitEvent(new ListingCreatedEvent(listingId, collectionAddr, tokenId, sender, price));

        const writer: BytesWriter = new BytesWriter(32);
        writer.writeU256(listingId);
        return writer;
    }

    @method({ name: 'listingId', type: ABIDataTypes.UINT256 })
    @returns({ name: 'success', type: ABIDataTypes.BOOL })
    @emit('ListingCancelled')
    private cancelListing(calldata: Calldata): BytesWriter {
        const listingId: u256 = calldata.readU256();
        const sender: Address = Blockchain.tx.sender;

        this.requireActiveListing(listingId);

        const sellerU256: u256 = this.listingSellerMap.get(listingId);
        const seller: Address = this.u256ToAddress(sellerU256);

        if (!sender.equals(seller)) {
            throw new Revert('Only seller can cancel');
        }

        this.listingActiveMap.set(listingId, this.INACTIVE);

        this.emitEvent(new ListingCancelledEvent(listingId));

        const writer: BytesWriter = new BytesWriter(1);
        writer.writeBoolean(true);
        return writer;
    }

    @method({ name: 'listingId', type: ABIDataTypes.UINT256 })
    @returns({ name: 'success', type: ABIDataTypes.BOOL })
    @emit('ListingSold')
    private buyNFT(calldata: Calldata): BytesWriter {
        const listingId: u256 = calldata.readU256();
        const buyer: Address = Blockchain.tx.sender;

        this.requireActiveListing(listingId);

        const collectionAddr: Address = this.u256ToAddress(this.listingCollectionMap.get(listingId));
        const tokenId: u256 = this.listingTokenIdMap.get(listingId);
        const seller: Address = this.u256ToAddress(this.listingSellerMap.get(listingId));
        const price: u256 = this.listingPriceMap.get(listingId);

        if (buyer.equals(seller)) {
            throw new Revert('Buyer cannot be seller');
        }

        this.listingActiveMap.set(listingId, this.INACTIVE);
        this.totalVolume.value = SafeMath.add(this.totalVolume.value, price);

        this.executeNFTTransfer(collectionAddr, seller, buyer, tokenId);

        this.emitEvent(new ListingSoldEvent(listingId, buyer, price));

        const writer: BytesWriter = new BytesWriter(1);
        writer.writeBoolean(true);
        return writer;
    }

    @method(
        { name: 'collection', type: ABIDataTypes.ADDRESS },
        { name: 'tokenId', type: ABIDataTypes.UINT256 },
        { name: 'amount', type: ABIDataTypes.UINT256 },
    )
    @returns({ name: 'bidId', type: ABIDataTypes.UINT256 })
    @emit('BidPlaced')
    private placeBid(calldata: Calldata): BytesWriter {
        const collectionAddr: Address = calldata.readAddress();
        const tokenId: u256 = calldata.readU256();
        const bidAmountSatoshis: u256 = calldata.readU256();
        const sender: Address = Blockchain.tx.sender;

        if (collectionAddr.isZero()) {
            throw new Revert('Invalid collection address');
        }

        if (u256.eq(bidAmountSatoshis, u256.Zero)) {
            throw new Revert('Bid amount must be greater than zero');
        }

        const bidId: u256 = this.nextBidId.value;

        this.nextBidId.value = SafeMath.add(bidId, u256.One);
        this.bidCollectionMap.set(bidId, this.addressToU256(collectionAddr));
        this.bidTokenIdMap.set(bidId, tokenId);
        this.bidBidderMap.set(bidId, this.addressToU256(sender));
        this.bidAmountMap.set(bidId, bidAmountSatoshis);
        this.bidActiveMap.set(bidId, this.ACTIVE);

        this.emitEvent(new BidPlacedEvent(bidId, collectionAddr, tokenId, sender, bidAmountSatoshis));

        const writer: BytesWriter = new BytesWriter(32);
        writer.writeU256(bidId);
        return writer;
    }

    @method({ name: 'bidId', type: ABIDataTypes.UINT256 })
    @returns({ name: 'success', type: ABIDataTypes.BOOL })
    @emit('BidCancelled')
    private cancelBid(calldata: Calldata): BytesWriter {
        const bidId: u256 = calldata.readU256();
        const sender: Address = Blockchain.tx.sender;

        this.requireActiveBid(bidId);

        const bidderU256: u256 = this.bidBidderMap.get(bidId);
        const bidder: Address = this.u256ToAddress(bidderU256);

        if (!sender.equals(bidder)) {
            throw new Revert('Only bidder can cancel');
        }

        this.bidActiveMap.set(bidId, this.INACTIVE);

        this.emitEvent(new BidCancelledEvent(bidId));

        const writer: BytesWriter = new BytesWriter(1);
        writer.writeBoolean(true);
        return writer;
    }

    @method({ name: 'bidId', type: ABIDataTypes.UINT256 })
    @returns({ name: 'success', type: ABIDataTypes.BOOL })
    @emit('BidAccepted')
    private acceptBid(calldata: Calldata): BytesWriter {
        const bidId: u256 = calldata.readU256();
        const sender: Address = Blockchain.tx.sender;

        this.requireActiveBid(bidId);

        const collectionAddr: Address = this.u256ToAddress(this.bidCollectionMap.get(bidId));
        const tokenId: u256 = this.bidTokenIdMap.get(bidId);
        const bidder: Address = this.u256ToAddress(this.bidBidderMap.get(bidId));
        const amount: u256 = this.bidAmountMap.get(bidId);

        this.verifyOwnership(collectionAddr, tokenId, sender);

        this.bidActiveMap.set(bidId, this.INACTIVE);
        this.totalVolume.value = SafeMath.add(this.totalVolume.value, amount);

        this.executeNFTTransfer(collectionAddr, sender, bidder, tokenId);

        this.emitEvent(new BidAcceptedEvent(bidId, sender));

        const writer: BytesWriter = new BytesWriter(1);
        writer.writeBoolean(true);
        return writer;
    }

    @method(
        { name: 'collection', type: ABIDataTypes.ADDRESS },
        { name: 'royaltyBps', type: ABIDataTypes.UINT256 },
        { name: 'royaltyRecipient', type: ABIDataTypes.ADDRESS },
    )
    @returns({ name: 'success', type: ABIDataTypes.BOOL })
    @emit('CollectionRegistered')
    private registerCollection(calldata: Calldata): BytesWriter {
        const collectionAddr: Address = calldata.readAddress();
        const royaltyBps: u256 = calldata.readU256();
        const royaltyRecipient: Address = calldata.readAddress();

        if (collectionAddr.isZero()) {
            throw new Revert('Invalid collection address');
        }

        if (u256.gt(royaltyBps, this.MAX_ROYALTY_BPS)) {
            throw new Revert('Royalty exceeds maximum 10%');
        }

        if (royaltyRecipient.isZero()) {
            throw new Revert('Invalid royalty recipient');
        }

        this.collectionRegisteredMap.set(collectionAddr, u256.One);
        this.collectionRoyaltyBpsMap.set(collectionAddr, royaltyBps);

        const collectionKey: u256 = this.addressToU256(collectionAddr);
        this.collectionRoyaltyRecipientMap.set(collectionKey, this.addressToU256(royaltyRecipient));

        this.emitEvent(new CollectionRegisteredEvent(collectionAddr, royaltyBps));

        const writer: BytesWriter = new BytesWriter(1);
        writer.writeBoolean(true);
        return writer;
    }

    @method({ name: 'newFeeBps', type: ABIDataTypes.UINT256 })
    @returns({ name: 'success', type: ABIDataTypes.BOOL })
    private setPlatformFee(calldata: Calldata): BytesWriter {
        this.onlyDeployer(Blockchain.tx.sender);

        const newFeeBps: u256 = calldata.readU256();

        if (u256.gt(newFeeBps, this.MAX_PLATFORM_FEE_BPS)) {
            throw new Revert('Fee exceeds maximum 5%');
        }

        this.platformFeeBps.value = newFeeBps;

        const writer: BytesWriter = new BytesWriter(1);
        writer.writeBoolean(true);
        return writer;
    }

    @method({ name: 'newRecipient', type: ABIDataTypes.ADDRESS })
    @returns({ name: 'success', type: ABIDataTypes.BOOL })
    private setPlatformFeeRecipient(calldata: Calldata): BytesWriter {
        this.onlyDeployer(Blockchain.tx.sender);

        const newRecipient: Address = calldata.readAddress();

        if (newRecipient.isZero()) {
            throw new Revert('Invalid recipient address');
        }

        this.platformFeeRecipient.value = newRecipient;

        const writer: BytesWriter = new BytesWriter(1);
        writer.writeBoolean(true);
        return writer;
    }

    @method(
        { name: 'collection', type: ABIDataTypes.ADDRESS },
        { name: 'newBps', type: ABIDataTypes.UINT256 },
        { name: 'newRecipient', type: ABIDataTypes.ADDRESS },
    )
    @returns({ name: 'success', type: ABIDataTypes.BOOL })
    private updateRoyalty(calldata: Calldata): BytesWriter {
        this.onlyDeployer(Blockchain.tx.sender);

        const collectionAddr: Address = calldata.readAddress();
        const newBps: u256 = calldata.readU256();
        const newRecipient: Address = calldata.readAddress();

        const isRegistered: u256 = this.collectionRegisteredMap.get(collectionAddr);
        if (u256.eq(isRegistered, u256.Zero)) {
            throw new Revert('Collection not registered');
        }

        if (u256.gt(newBps, this.MAX_ROYALTY_BPS)) {
            throw new Revert('Royalty exceeds maximum 10%');
        }

        if (newRecipient.isZero()) {
            throw new Revert('Invalid royalty recipient');
        }

        this.collectionRoyaltyBpsMap.set(collectionAddr, newBps);

        const collectionKey: u256 = this.addressToU256(collectionAddr);
        this.collectionRoyaltyRecipientMap.set(collectionKey, this.addressToU256(newRecipient));

        const writer: BytesWriter = new BytesWriter(1);
        writer.writeBoolean(true);
        return writer;
    }

    @method({ name: 'listingId', type: ABIDataTypes.UINT256 })
    @returns(
        { name: 'collection', type: ABIDataTypes.UINT256 },
        { name: 'tokenId', type: ABIDataTypes.UINT256 },
        { name: 'seller', type: ABIDataTypes.UINT256 },
        { name: 'price', type: ABIDataTypes.UINT256 },
        { name: 'active', type: ABIDataTypes.UINT256 },
    )
    private getListing(calldata: Calldata): BytesWriter {
        const listingId: u256 = calldata.readU256();

        const writer: BytesWriter = new BytesWriter(160);
        writer.writeU256(this.listingCollectionMap.get(listingId));
        writer.writeU256(this.listingTokenIdMap.get(listingId));
        writer.writeU256(this.listingSellerMap.get(listingId));
        writer.writeU256(this.listingPriceMap.get(listingId));
        writer.writeU256(this.listingActiveMap.get(listingId));
        return writer;
    }

    @method({ name: 'bidId', type: ABIDataTypes.UINT256 })
    @returns(
        { name: 'collection', type: ABIDataTypes.UINT256 },
        { name: 'tokenId', type: ABIDataTypes.UINT256 },
        { name: 'bidder', type: ABIDataTypes.UINT256 },
        { name: 'amount', type: ABIDataTypes.UINT256 },
        { name: 'active', type: ABIDataTypes.UINT256 },
    )
    private getBid(calldata: Calldata): BytesWriter {
        const bidId: u256 = calldata.readU256();

        const writer: BytesWriter = new BytesWriter(160);
        writer.writeU256(this.bidCollectionMap.get(bidId));
        writer.writeU256(this.bidTokenIdMap.get(bidId));
        writer.writeU256(this.bidBidderMap.get(bidId));
        writer.writeU256(this.bidAmountMap.get(bidId));
        writer.writeU256(this.bidActiveMap.get(bidId));
        return writer;
    }

    @method({ name: 'collection', type: ABIDataTypes.ADDRESS })
    @returns(
        { name: 'registered', type: ABIDataTypes.UINT256 },
        { name: 'royaltyBps', type: ABIDataTypes.UINT256 },
        { name: 'royaltyRecipient', type: ABIDataTypes.UINT256 },
    )
    private getCollectionInfo(calldata: Calldata): BytesWriter {
        const collectionAddr: Address = calldata.readAddress();

        const isRegistered: u256 = this.collectionRegisteredMap.get(collectionAddr);
        const royaltyBps: u256 = this.collectionRoyaltyBpsMap.get(collectionAddr);
        const collectionKey: u256 = this.addressToU256(collectionAddr);
        const recipientU256: u256 = this.collectionRoyaltyRecipientMap.get(collectionKey);

        const writer: BytesWriter = new BytesWriter(96);
        writer.writeU256(isRegistered);
        writer.writeU256(royaltyBps);
        writer.writeU256(recipientU256);
        return writer;
    }

    @method()
    @returns(
        { name: 'platformFeeBps', type: ABIDataTypes.UINT256 },
        { name: 'platformFeeRecipient', type: ABIDataTypes.ADDRESS },
        { name: 'totalVolume', type: ABIDataTypes.UINT256 },
        { name: 'totalListings', type: ABIDataTypes.UINT256 },
    )
    private getPlatformInfo(_calldata: Calldata): BytesWriter {
        const writer: BytesWriter = new BytesWriter(128);
        writer.writeU256(this.platformFeeBps.value);
        writer.writeAddress(this.platformFeeRecipient.value);
        writer.writeU256(this.totalVolume.value);
        writer.writeU256(this.totalListings.value);
        return writer;
    }

    private verifyOwnership(collection: Address, tokenId: u256, expectedOwner: Address): void {
        const ownerOfCalldata: BytesWriter = new BytesWriter(36);
        ownerOfCalldata.writeSelector(this.ownerOfSelector);
        ownerOfCalldata.writeU256(tokenId);

        const result: CallResult = Blockchain.call(collection, ownerOfCalldata);

        if (!result.success) {
            throw new Revert('ownerOf call failed');
        }

        const ownerAddress: Address = result.data.readAddress();

        if (!ownerAddress.equals(expectedOwner)) {
            throw new Revert('Caller is not the token owner');
        }
    }

    private verifyApproval(collection: Address, owner: Address): void {
        const approvalCalldata: BytesWriter = new BytesWriter(68);
        approvalCalldata.writeSelector(this.isApprovedForAllSelector);
        approvalCalldata.writeAddress(owner);
        approvalCalldata.writeAddress(this.address);

        const result: CallResult = Blockchain.call(collection, approvalCalldata);

        if (!result.success) {
            throw new Revert('isApprovedForAll call failed');
        }

        const approved: boolean = result.data.readBoolean();

        if (!approved) {
            throw new Revert('Marketplace not approved for transfers');
        }
    }

    private executeNFTTransfer(
        collection: Address,
        from: Address,
        to: Address,
        tokenId: u256,
    ): void {
        const transferCalldata: BytesWriter = new BytesWriter(100);
        transferCalldata.writeSelector(this.safeTransferFromSelector);
        transferCalldata.writeAddress(from);
        transferCalldata.writeAddress(to);
        transferCalldata.writeU256(tokenId);

        const result: CallResult = Blockchain.call(collection, transferCalldata);

        if (!result.success) {
            throw new Revert('NFT transfer failed');
        }
    }

    private requireActiveListing(listingId: u256): void {
        const currentNextId: u256 = this.nextListingId.value;
        if (u256.ge(listingId, currentNextId) || u256.eq(listingId, u256.Zero)) {
            throw new Revert('Listing does not exist');
        }

        const active: u256 = this.listingActiveMap.get(listingId);
        if (u256.eq(active, this.INACTIVE)) {
            throw new Revert('Listing is not active');
        }
    }

    private requireActiveBid(bidId: u256): void {
        const currentNextId: u256 = this.nextBidId.value;
        if (u256.ge(bidId, currentNextId) || u256.eq(bidId, u256.Zero)) {
            throw new Revert('Bid does not exist');
        }

        const active: u256 = this.bidActiveMap.get(bidId);
        if (u256.eq(active, this.INACTIVE)) {
            throw new Revert('Bid is not active');
        }
    }
}
