import { u256 } from '@btc-vision/as-bignum/assembly';
import {
    Address,
    Blockchain,
    BytesWriter,
    Calldata,
    NetEvent,
    Revert,
    SafeMath,
    StoredString,
    StoredU256,
} from '@btc-vision/btc-runtime/runtime';
import { OP721 } from '@btc-vision/btc-runtime/runtime/contracts/OP721';
import { OP721InitParameters } from '@btc-vision/btc-runtime/runtime/contracts/interfaces/OP721InitParameters';
import { StoredMapU256 } from '@btc-vision/btc-runtime/runtime/storage/maps/StoredMapU256';
import { ADDRESS_BYTE_LENGTH, U256_BYTE_LENGTH } from '@btc-vision/btc-runtime/runtime/utils';
import { EMPTY_POINTER } from '@btc-vision/btc-runtime/runtime/math/bytes';

const TOKEN_TYPE_IDENTITY: u256 = u256.Zero;
const TOKEN_TYPE_BLURB: u256 = u256.One;
const TOKEN_TYPE_GUESTBOOK: u256 = u256.fromU64(2);

const MAX_BLURB_LENGTH: i32 = 280;
const MAX_GUESTBOOK_LENGTH: i32 = 500;
const MAX_PROFILE_STRING: i32 = 280;
const MAX_SUPPLY: u256 = u256.fromU64(100000);

const ORDINALS_CONTENT: string = 'https://ordinals.com/content/';
const MYTXO_LOGO_INSCRIPTION: string = 'aeda9ed5908464fd4e127ed4e29bb5722c14c4558ceb47b5aab49718a3d1fffci0';
const MYTXO_BANNER_INSCRIPTION: string = '5c340c68e3f01bdc26ce9290be07915c6da61661a67acbee7b7a82ac57669e47i0';
const B64_CHARS: string = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

function escapeJson(s: string): string {
    let out: string = '';
    for (let i: i32 = 0; i < s.length; i++) {
        const c: i32 = s.charCodeAt(i);
        if (c == 0x22) out += '\\"';
        else if (c == 0x5c) out += '\\\\';
        else if (c == 0x0a) out += '\\n';
        else if (c == 0x0d) out += '\\r';
        else if (c == 0x09) out += '\\t';
        else if (c >= 0x20) out += String.fromCharCode(c);
    }
    return out;
}

function toBase64(input: string): string {
    const buf: ArrayBuffer = String.UTF8.encode(input);
    const bytes: Uint8Array = Uint8Array.wrap(buf);
    const len: i32 = bytes.length;
    let result: string = '';
    for (let i: i32 = 0; i < len; i += 3) {
        const b0: u32 = <u32>bytes[i];
        const b1: u32 = i + 1 < len ? <u32>bytes[i + 1] : 0;
        const b2: u32 = i + 2 < len ? <u32>bytes[i + 2] : 0;
        result += B64_CHARS.charAt(<i32>((b0 >> 2) & 0x3f));
        result += B64_CHARS.charAt(<i32>(((b0 << 4) | (b1 >> 4)) & 0x3f));
        result += i + 1 < len ? B64_CHARS.charAt(<i32>(((b1 << 2) | (b2 >> 6)) & 0x3f)) : '=';
        result += i + 2 < len ? B64_CHARS.charAt(<i32>(b2 & 0x3f)) : '=';
    }
    return result;
}

// ── Events ──────────────────────────────────────────────────────────────────

class ProfileUpdatedEvent extends NetEvent {
    constructor(owner: Address) {
        const data: BytesWriter = new BytesWriter(ADDRESS_BYTE_LENGTH);
        data.writeAddress(owner);
        super('ProfileUpdated', data);
    }
}

class BlurbMintedEvent extends NetEvent {
    constructor(
        author: Address,
        tokenId: u256,
        content: string,
        publishedToFeed: bool,
        hasInscription: bool,
    ) {
        const contentBytes: i32 = String.UTF8.byteLength(content);
        const data: BytesWriter = new BytesWriter(
            ADDRESS_BYTE_LENGTH + U256_BYTE_LENGTH + 4 + contentBytes + 1 + 1,
        );
        data.writeAddress(author);
        data.writeU256(tokenId);
        data.writeStringWithLength(content);
        data.writeBoolean(publishedToFeed);
        data.writeBoolean(hasInscription);
        super('BlurbMinted', data);
    }
}

const MAX_EVENT_MSG_BYTES: i32 = 284;

class GuestbookSignedEvent extends NetEvent {
    constructor(
        signer: Address,
        tokenId: u256,
        message: string,
    ) {
        const truncated: string = message.length > MAX_EVENT_MSG_BYTES
            ? message.slice(0, MAX_EVENT_MSG_BYTES)
            : message;
        const msgBytes: i32 = String.UTF8.byteLength(truncated);
        const data: BytesWriter = new BytesWriter(
            ADDRESS_BYTE_LENGTH + U256_BYTE_LENGTH + 4 + msgBytes,
        );
        data.writeAddress(signer);
        data.writeU256(tokenId);
        data.writeStringWithLength(truncated);
        super('GuestbookSigned', data);
    }
}

// ── Storage Pointers (after OP721 base class pointers) ──────────────────────

const profileOwnerPointer: u16 = Blockchain.nextPointer;
const tokenTypesPointer: u16 = Blockchain.nextPointer;
const blurbCountPointer: u16 = Blockchain.nextPointer;
const guestbookCountPointer: u16 = Blockchain.nextPointer;
const profileInitializedPointer: u16 = Blockchain.nextPointer;

const usernameStringPointer: u16 = Blockchain.nextPointer;
const displayNameStringPointer: u16 = Blockchain.nextPointer;
const bioStringPointer: u16 = Blockchain.nextPointer;
const avatarInscIdStringPointer: u16 = Blockchain.nextPointer;
const cssInscIdStringPointer: u16 = Blockchain.nextPointer;
const playlistPointerStringPointer: u16 = Blockchain.nextPointer;

const tokenContentPointer: u16 = Blockchain.nextPointer;
const tokenInscriptionPointer: u16 = Blockchain.nextPointer;
const tokenSignersPointer: u16 = Blockchain.nextPointer;

/**
 * MyTXOProfile — Per-user OP721 profile contract.
 *
 * Token #0: Creator Card (soulbound identity NFT)
 *   - Stores username, displayName, bio, avatarInscId, cssInscId, playlistPointer
 *   - Non-transferable (identity token)
 *
 * Token #1+: Blurbs (short posts, transferable NFTs)
 * Token #N+: Guestbook entries (received signatures, soulbound)
 *
 * Deployed per-user. Registered with MyTXOFactory for username resolution.
 */
@final
export class MyTXOProfile extends OP721 {
    private readonly profileOwner: StoredU256;
    private readonly tokenTypes: StoredMapU256;
    private readonly blurbCount: StoredU256;
    private readonly guestbookCount: StoredU256;
    private readonly profileInitialized: StoredU256;

    private readonly _username: StoredString;
    private readonly _displayName: StoredString;
    private readonly _bio: StoredString;
    private readonly _avatarInscId: StoredString;
    private readonly _cssInscId: StoredString;
    private readonly _playlistPointer: StoredString;
    private readonly tokenSigners: StoredMapU256;

    public constructor() {
        super();
        this.profileOwner = new StoredU256(profileOwnerPointer, EMPTY_POINTER);
        this.tokenTypes = new StoredMapU256(tokenTypesPointer);
        this.blurbCount = new StoredU256(blurbCountPointer, EMPTY_POINTER);
        this.guestbookCount = new StoredU256(guestbookCountPointer, EMPTY_POINTER);
        this.profileInitialized = new StoredU256(profileInitializedPointer, EMPTY_POINTER);

        this._username = new StoredString(usernameStringPointer, 0);
        this._displayName = new StoredString(displayNameStringPointer, 0);
        this._bio = new StoredString(bioStringPointer, 0);
        this._avatarInscId = new StoredString(avatarInscIdStringPointer, 0);
        this._cssInscId = new StoredString(cssInscIdStringPointer, 0);
        this._playlistPointer = new StoredString(playlistPointerStringPointer, 0);
        this.tokenSigners = new StoredMapU256(tokenSignersPointer);
    }

    public override onDeployment(calldata: Calldata): void {
        const ownerAddr: Address = calldata.readAddress();
        const username: string = calldata.readStringWithLength();
        const displayName: string = calldata.readStringWithLength();
        const bio: string = calldata.readStringWithLength();
        const avatarInscId: string = calldata.readStringWithLength();
        const cssInscId: string = calldata.readStringWithLength();
        const playlistPtr: string = calldata.readStringWithLength();

        if (username.length == 0 || username.length > MAX_PROFILE_STRING) {
            throw new Revert('Invalid username length');
        }
        if (displayName.length > MAX_PROFILE_STRING) {
            throw new Revert('Display name exceeds max length');
        }
        if (bio.length > MAX_PROFILE_STRING) {
            throw new Revert('Bio exceeds max length');
        }
        if (avatarInscId.length > MAX_PROFILE_STRING) {
            throw new Revert('Avatar ID exceeds max length');
        }
        if (cssInscId.length > MAX_PROFILE_STRING) {
            throw new Revert('CSS ID exceeds max length');
        }
        if (playlistPtr.length > MAX_PROFILE_STRING) {
            throw new Revert('Playlist pointer exceeds max length');
        }

        this.profileOwner.set(this._u256FromAddress(ownerAddr));

        const collectionName: string = '@' + username;
        const baseURI: string = 'https://mytxo.space/api/nft/' + username + '/';
        const collectionIcon: string = avatarInscId.length > 0
            ? ORDINALS_CONTENT + avatarInscId
            : ORDINALS_CONTENT + MYTXO_LOGO_INSCRIPTION;
        const collectionBanner: string = ORDINALS_CONTENT + MYTXO_BANNER_INSCRIPTION;
        this.instantiate(new OP721InitParameters(
            collectionName,
            'MYTXO',
            baseURI,
            MAX_SUPPLY,
            collectionBanner,
            collectionIcon,
            'https://mytxo.space',
            username + "'s MyTXO Profile",
        ));

        this._username.value = username;
        this._displayName.value = displayName;
        this._bio.value = bio;
        this._avatarInscId.value = avatarInscId;
        this._cssInscId.value = cssInscId;
        this._playlistPointer.value = playlistPtr;

        this._mint(ownerAddr, u256.Zero);
        this.tokenTypes.set(u256.Zero, TOKEN_TYPE_IDENTITY);
        this.profileInitialized.set(u256.One);
    }

    public override onUpdate(_calldata: Calldata): void {
        super.onUpdate(_calldata);
    }

    // ── Soulbound: block transfer of identity & guestbook tokens ────────────

    protected _transfer(from: Address, to: Address, tokenId: u256): void {
        const tokenType: u256 = this.tokenTypes.get(tokenId);
        if (tokenType == TOKEN_TYPE_IDENTITY) {
            throw new Revert('Identity token is soulbound');
        }
        if (tokenType == TOKEN_TYPE_GUESTBOOK) {
            throw new Revert('Guestbook token is soulbound');
        }
        super._transfer(from, to, tokenId);
    }

    // ── Profile Management ──────────────────────────────────────────────────

    @method(
        { name: 'displayName', type: ABIDataTypes.STRING },
        { name: 'bio', type: ABIDataTypes.STRING },
        { name: 'avatarInscId', type: ABIDataTypes.STRING },
        { name: 'cssInscId', type: ABIDataTypes.STRING },
        { name: 'playlistPointer', type: ABIDataTypes.STRING },
    )
    @returns({ name: 'success', type: ABIDataTypes.BOOL })
    public updateProfile(calldata: Calldata): BytesWriter {
        this.requireProfileOwner();

        const displayName: string = calldata.readStringWithLength();
        const bio: string = calldata.readStringWithLength();
        const avatarInscId: string = calldata.readStringWithLength();
        const cssInscId: string = calldata.readStringWithLength();
        const playlistPtr: string = calldata.readStringWithLength();

        if (displayName.length > MAX_PROFILE_STRING) {
            throw new Revert('Display name exceeds max length');
        }
        if (bio.length > MAX_PROFILE_STRING) {
            throw new Revert('Bio exceeds max length');
        }
        if (avatarInscId.length > MAX_PROFILE_STRING) {
            throw new Revert('Avatar ID exceeds max length');
        }
        if (cssInscId.length > MAX_PROFILE_STRING) {
            throw new Revert('CSS ID exceeds max length');
        }
        if (playlistPtr.length > MAX_PROFILE_STRING) {
            throw new Revert('Playlist pointer exceeds max length');
        }

        this._displayName.value = displayName;
        this._bio.value = bio;
        this._avatarInscId.value = avatarInscId;
        this._cssInscId.value = cssInscId;
        this._playlistPointer.value = playlistPtr;

        const owner: Address = this.getProfileOwnerAddress();
        this.emitEvent(new ProfileUpdatedEvent(owner));

        const response: BytesWriter = new BytesWriter(1);
        response.writeBoolean(true);
        return response;
    }

    // ── Blurb Minting ───────────────────────────────────────────────────────

    @method(
        { name: 'content', type: ABIDataTypes.STRING },
        { name: 'publishToFeed', type: ABIDataTypes.BOOL },
        { name: 'inscriptionId', type: ABIDataTypes.STRING },
    )
    @returns({ name: 'tokenId', type: ABIDataTypes.UINT256 })
    @emit('BlurbMinted')
    public mintBlurb(calldata: Calldata): BytesWriter {
        this.requireProfileOwner();

        const content: string = calldata.readStringWithLength();
        const publishToFeed: bool = calldata.readBoolean();
        const inscriptionId: string = calldata.readStringWithLength();

        if (content.length == 0) {
            throw new Revert('Content cannot be empty');
        }
        if (content.length > MAX_BLURB_LENGTH) {
            throw new Revert('Blurb exceeds 280 characters');
        }
        if (String.UTF8.byteLength(content) > MAX_BLURB_LENGTH) {
            throw new Revert('Blurb exceeds 280 bytes');
        }

        const owner: Address = this.getProfileOwnerAddress();
        const tokenId: u256 = this._nextTokenId.value;
        this._mint(owner, tokenId);
        this._nextTokenId.value = SafeMath.add(tokenId, u256.One);
        this.tokenTypes.set(tokenId, TOKEN_TYPE_BLURB);
        this.blurbCount.set(SafeMath.add(this.blurbCount.value, u256.One));

        const hasInscription: bool = inscriptionId.length > 0;

        const contentStore = new StoredString(tokenContentPointer, tokenId.toU64());
        contentStore.value = content;
        if (hasInscription) {
            const inscStore = new StoredString(tokenInscriptionPointer, tokenId.toU64());
            inscStore.value = inscriptionId;
        }

        this.emitEvent(new BlurbMintedEvent(owner, tokenId, content, publishToFeed, hasInscription));

        const result: BytesWriter = new BytesWriter(U256_BYTE_LENGTH);
        result.writeU256(tokenId);
        return result;
    }

    // ── Guestbook ───────────────────────────────────────────────────────────

    @method({ name: 'message', type: ABIDataTypes.STRING })
    @returns({ name: 'tokenId', type: ABIDataTypes.UINT256 })
    @emit('GuestbookSigned')
    public signGuestbook(calldata: Calldata): BytesWriter {
        const signer: Address = Blockchain.tx.sender;
        const ownerU256: u256 = this.profileOwner.value;
        const signerU256: u256 = this._u256FromAddress(signer);

        if (u256.eq(signerU256, ownerU256)) {
            throw new Revert('Cannot sign own guestbook');
        }

        const message: string = calldata.readStringWithLength();
        if (message.length == 0) {
            throw new Revert('Message cannot be empty');
        }
        if (message.length > MAX_GUESTBOOK_LENGTH) {
            throw new Revert('Message exceeds 500 characters');
        }

        const owner: Address = this.getProfileOwnerAddress();
        const tokenId: u256 = this._nextTokenId.value;
        this._mint(owner, tokenId);
        this._nextTokenId.value = SafeMath.add(tokenId, u256.One);
        this.tokenTypes.set(tokenId, TOKEN_TYPE_GUESTBOOK);
        this.guestbookCount.set(SafeMath.add(this.guestbookCount.value, u256.One));

        const msgStore = new StoredString(tokenContentPointer, tokenId.toU64());
        msgStore.value = message;
        this.tokenSigners.set(tokenId, signerU256);

        this.emitEvent(new GuestbookSignedEvent(signer, tokenId, message));

        const result: BytesWriter = new BytesWriter(U256_BYTE_LENGTH);
        result.writeU256(tokenId);
        return result;
    }

    // ── View Methods ────────────────────────────────────────────────────────

    @view
    @method()
    @returns(
        { name: 'username', type: ABIDataTypes.STRING },
        { name: 'displayName', type: ABIDataTypes.STRING },
        { name: 'bio', type: ABIDataTypes.STRING },
        { name: 'avatarInscId', type: ABIDataTypes.STRING },
        { name: 'cssInscId', type: ABIDataTypes.STRING },
        { name: 'playlistPointer', type: ABIDataTypes.STRING },
        { name: 'blurbCount', type: ABIDataTypes.UINT256 },
        { name: 'guestbookCount', type: ABIDataTypes.UINT256 },
        { name: 'totalSupply', type: ABIDataTypes.UINT256 },
    )
    public getProfile(_calldata: Calldata): BytesWriter {
        const username: string = this._username.value;
        const displayName: string = this._displayName.value;
        const bio: string = this._bio.value;
        const avatarInscId: string = this._avatarInscId.value;
        const cssInscId: string = this._cssInscId.value;
        const playlistPtr: string = this._playlistPointer.value;

        const totalSize: i32 =
            (4 * 6) +
            String.UTF8.byteLength(username) +
            String.UTF8.byteLength(displayName) +
            String.UTF8.byteLength(bio) +
            String.UTF8.byteLength(avatarInscId) +
            String.UTF8.byteLength(cssInscId) +
            String.UTF8.byteLength(playlistPtr) +
            U256_BYTE_LENGTH * 3;

        const response: BytesWriter = new BytesWriter(totalSize);
        response.writeStringWithLength(username);
        response.writeStringWithLength(displayName);
        response.writeStringWithLength(bio);
        response.writeStringWithLength(avatarInscId);
        response.writeStringWithLength(cssInscId);
        response.writeStringWithLength(playlistPtr);
        response.writeU256(this.blurbCount.value);
        response.writeU256(this.guestbookCount.value);
        response.writeU256(this.totalSupply);
        return response;
    }

    @view
    @method({ name: 'tokenId', type: ABIDataTypes.UINT256 })
    @returns(
        { name: 'tokenType', type: ABIDataTypes.UINT256 },
        { name: 'owner', type: ABIDataTypes.ADDRESS },
    )
    public getTokenInfo(calldata: Calldata): BytesWriter {
        const tokenId: u256 = calldata.readU256();
        if (!this._exists(tokenId)) {
            throw new Revert('Token does not exist');
        }
        const tokenType: u256 = this.tokenTypes.get(tokenId);
        const owner: Address = this._ownerOf(tokenId);
        const response: BytesWriter = new BytesWriter(U256_BYTE_LENGTH + ADDRESS_BYTE_LENGTH);
        response.writeU256(tokenType);
        response.writeAddress(owner);
        return response;
    }

    @view
    @method({ name: 'tokenId', type: ABIDataTypes.UINT256 })
    @returns(
        { name: 'tokenType', type: ABIDataTypes.UINT256 },
        { name: 'content', type: ABIDataTypes.STRING },
        { name: 'inscriptionId', type: ABIDataTypes.STRING },
        { name: 'signerU256', type: ABIDataTypes.UINT256 },
    )
    public getTokenContent(calldata: Calldata): BytesWriter {
        const tokenId: u256 = calldata.readU256();
        if (!this._exists(tokenId)) {
            throw new Revert('Token does not exist');
        }

        const tokenType: u256 = this.tokenTypes.get(tokenId);
        const contentStore = new StoredString(tokenContentPointer, tokenId.toU64());
        const content: string = contentStore.value;
        const inscStore = new StoredString(tokenInscriptionPointer, tokenId.toU64());
        const inscriptionId: string = inscStore.value;
        const signerU256: u256 = this.tokenSigners.get(tokenId);

        const contentBytes: i32 = String.UTF8.byteLength(content);
        const inscBytes: i32 = String.UTF8.byteLength(inscriptionId);
        const totalSize: i32 = U256_BYTE_LENGTH + (4 + contentBytes) + (4 + inscBytes) + U256_BYTE_LENGTH;

        const response: BytesWriter = new BytesWriter(totalSize);
        response.writeU256(tokenType);
        response.writeStringWithLength(content);
        response.writeStringWithLength(inscriptionId);
        response.writeU256(signerU256);
        return response;
    }

    // ── On-Chain Metadata ─────────────────────────────────────────────────

    public override tokenURI(calldata: Calldata): BytesWriter {
        const tokenId: u256 = calldata.readU256();
        if (!this._exists(tokenId)) {
            throw new Revert('Token does not exist');
        }

        const username: string = this._username.value;
        const displayName: string = this._displayName.value;
        const bio: string = this._bio.value;
        const avatarInscId: string = this._avatarInscId.value;
        const tokenType: u256 = this.tokenTypes.get(tokenId);

        const avatarUrl: string = avatarInscId.length > 0
            ? ORDINALS_CONTENT + avatarInscId
            : '';

        let name: string;
        let desc: string;
        let image: string;
        let typeVal: string;

        if (u256.eq(tokenType, TOKEN_TYPE_IDENTITY)) {
            const label: string = displayName.length > 0 ? displayName : username;
            name = escapeJson(label) + ' - Creator Card';
            desc = bio.length > 0
                ? 'On-chain identity for @' + username + '. ' + escapeJson(bio)
                : 'On-chain identity for @' + username + ' on MyTXO.';
            image = avatarUrl;
            typeVal = 'Creator Card';
        } else if (u256.eq(tokenType, TOKEN_TYPE_BLURB)) {
            const cStore = new StoredString(tokenContentPointer, tokenId.toU64());
            const content: string = cStore.value;
            const iStore = new StoredString(tokenInscriptionPointer, tokenId.toU64());
            const inscId: string = iStore.value;

            name = '@' + username + ' - Blurb #' + tokenId.toString();
            const trunc: string = content.length > 200
                ? content.substring(0, 200) + '...'
                : content;
            desc = escapeJson(trunc);
            image = inscId.length > 0 ? ORDINALS_CONTENT + inscId : avatarUrl;
            typeVal = 'Blurb';
        } else {
            const mStore = new StoredString(tokenContentPointer, tokenId.toU64());
            const msg: string = mStore.value;

            name = 'Guestbook - @' + username + ' #' + tokenId.toString();
            const truncMsg: string = msg.length > 200
                ? msg.substring(0, 200) + '...'
                : msg;
            desc = truncMsg.length > 0
                ? escapeJson(truncMsg)
                : 'Guestbook entry for @' + username;
            image = avatarUrl;
            typeVal = 'Guestbook Entry';
        }

        let json: string = '{"name":"' + name + '","description":"' + desc + '"';
        if (image.length > 0) {
            json += ',"image":"' + image + '"';
        }
        json += ',"attributes":[{"trait_type":"Type","value":"' + typeVal + '"}';
        json += ',{"trait_type":"Username","value":"@' + username + '"}]}';

        const uri: string = 'data:application/json;base64,' + toBase64(json);
        const w: BytesWriter = new BytesWriter(String.UTF8.byteLength(uri) + 4);
        w.writeStringWithLength(uri);
        return w;
    }

    // ── Internal Helpers ────────────────────────────────────────────────────

    private requireProfileOwner(): void {
        const senderU256: u256 = this._u256FromAddress(Blockchain.tx.sender);
        if (!u256.eq(senderU256, this.profileOwner.value)) {
            throw new Revert('Only profile owner');
        }
    }

    private getProfileOwnerAddress(): Address {
        return this._addressFromU256(this.profileOwner.value);
    }
}
