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
    StoredMapU256,
    StoredU256,
} from '@btc-vision/btc-runtime/runtime';
import { ReentrancyGuard } from '@btc-vision/btc-runtime/runtime/contracts/ReentrancyGuard';
import { ADDRESS_BYTE_LENGTH, U256_BYTE_LENGTH } from '@btc-vision/btc-runtime/runtime/utils';
import { EMPTY_POINTER } from '@btc-vision/btc-runtime/runtime/math/bytes';

// ── Events ──────────────────────────────────────────────────────────────────

class ProfileRegisteredEvent extends NetEvent {
    constructor(owner: Address, contractAddress: u256, usernameKey: u256) {
        const data: BytesWriter = new BytesWriter(
            ADDRESS_BYTE_LENGTH + U256_BYTE_LENGTH * 2,
        );
        data.writeAddress(owner);
        data.writeU256(contractAddress);
        data.writeU256(usernameKey);
        super('ProfileRegistered', data);
    }
}

class ProfileUnregisteredEvent extends NetEvent {
    constructor(target: Address, admin: Address) {
        const data: BytesWriter = new BytesWriter(ADDRESS_BYTE_LENGTH * 2);
        data.writeAddress(target);
        data.writeAddress(admin);
        super('ProfileUnregistered', data);
    }
}

// ── Storage Pointers ────────────────────────────────────────────────────────

const ownerPointer: u16 = Blockchain.nextPointer;
const profileCountPointer: u16 = Blockchain.nextPointer;
const usernameToContractPointer: u16 = Blockchain.nextPointer;
const addressToContractPointer: u16 = Blockchain.nextPointer;
const contractToOwnerPointer: u16 = Blockchain.nextPointer;
const addressToUsernamePointer: u16 = Blockchain.nextPointer;

/**
 * MyScribeFactory — Global username registry and profile contract directory.
 *
 * Maps usernames to per-user profile contract addresses and wallet addresses
 * to their deployed profile contracts. Each user deploys their own OP721
 * MyScribeProfile contract, then calls register() here to claim their username.
 *
 * All lookups are O(1) via StoredMapU256 — scales to unlimited users.
 */
@final
export class MyScribeFactory extends ReentrancyGuard {
    private readonly owner: StoredAddress;
    private readonly profileCount: StoredU256;
    private readonly usernameToContract: StoredMapU256;
    private readonly addressToContract: StoredMapU256;
    private readonly contractToOwner: StoredMapU256;
    private readonly addressToUsername: StoredMapU256;

    public constructor() {
        super();
        this.owner = new StoredAddress(ownerPointer);
        this.profileCount = new StoredU256(profileCountPointer, EMPTY_POINTER);
        this.usernameToContract = new StoredMapU256(usernameToContractPointer);
        this.addressToContract = new StoredMapU256(addressToContractPointer);
        this.contractToOwner = new StoredMapU256(contractToOwnerPointer);
        this.addressToUsername = new StoredMapU256(addressToUsernamePointer);
    }

    public override onDeployment(calldata: Calldata): void {
        const ownerAddr: Address = calldata.readAddress();
        this.owner.value = ownerAddr;
        this.profileCount.set(u256.Zero);
    }

    public override onUpdate(_calldata: Calldata): void {
        super.onUpdate(_calldata);
    }

    // ── Write Methods ───────────────────────────────────────────────────────

    @method(
        { name: 'usernameKey', type: ABIDataTypes.UINT256 },
        { name: 'contractAddress', type: ABIDataTypes.UINT256 },
    )
    @returns({ name: 'success', type: ABIDataTypes.BOOL })
    public register(calldata: Calldata): BytesWriter {
        const sender: Address = Blockchain.tx.sender;
        const usernameKey: u256 = calldata.readU256();
        const contractAddr: u256 = calldata.readU256();

        if (usernameKey.isZero()) {
            throw new Revert('Invalid username key');
        }
        if (contractAddr.isZero()) {
            throw new Revert('Invalid contract address');
        }

        if (!this.usernameToContract.get(usernameKey).isZero()) {
            throw new Revert('Username taken');
        }

        if (!this.contractToOwner.get(contractAddr).isZero()) {
            throw new Revert('Contract already registered');
        }

        const senderU256: u256 = this.addressToU256(sender);
        if (!this.addressToContract.get(senderU256).isZero()) {
            throw new Revert('Address already registered');
        }

        this.usernameToContract.set(usernameKey, contractAddr);
        this.addressToContract.set(senderU256, contractAddr);
        this.contractToOwner.set(contractAddr, senderU256);
        this.addressToUsername.set(senderU256, usernameKey);
        this.profileCount.set(SafeMath.add(this.profileCount.value, u256.One));

        this.emitEvent(new ProfileRegisteredEvent(sender, contractAddr, usernameKey));

        const response: BytesWriter = new BytesWriter(1);
        response.writeBoolean(true);
        return response;
    }

    @method({ name: 'target', type: ABIDataTypes.ADDRESS })
    @returns({ name: 'success', type: ABIDataTypes.BOOL })
    public unregister(calldata: Calldata): BytesWriter {
        this.onlyOwner();
        const target: Address = calldata.readAddress();
        const targetU256: u256 = this.addressToU256(target);

        const contractAddr: u256 = this.addressToContract.get(targetU256);
        if (contractAddr.isZero()) {
            throw new Revert('Not registered');
        }

        const usernameKey: u256 = this.addressToUsername.get(targetU256);

        if (!usernameKey.isZero()) {
            this.usernameToContract.set(usernameKey, u256.Zero);
        }
        this.addressToContract.set(targetU256, u256.Zero);
        this.contractToOwner.set(contractAddr, u256.Zero);
        this.addressToUsername.set(targetU256, u256.Zero);

        this.profileCount.set(SafeMath.sub(this.profileCount.value, u256.One));

        this.emitEvent(new ProfileUnregisteredEvent(target, Blockchain.tx.sender));

        const response: BytesWriter = new BytesWriter(1);
        response.writeBoolean(true);
        return response;
    }

    // ── View Methods ────────────────────────────────────────────────────────

    @view
    @method({ name: 'usernameKey', type: ABIDataTypes.UINT256 })
    @returns({ name: 'contractAddress', type: ABIDataTypes.UINT256 })
    public resolveUsername(calldata: Calldata): BytesWriter {
        const key: u256 = calldata.readU256();
        const response: BytesWriter = new BytesWriter(U256_BYTE_LENGTH);
        response.writeU256(this.usernameToContract.get(key));
        return response;
    }

    @view
    @method({ name: 'walletAddress', type: ABIDataTypes.ADDRESS })
    @returns({ name: 'contractAddress', type: ABIDataTypes.UINT256 })
    public resolveAddress(calldata: Calldata): BytesWriter {
        const wallet: Address = calldata.readAddress();
        const response: BytesWriter = new BytesWriter(U256_BYTE_LENGTH);
        response.writeU256(this.addressToContract.get(this.addressToU256(wallet)));
        return response;
    }

    @view
    @method({ name: 'walletAddress', type: ABIDataTypes.ADDRESS })
    @returns({ name: 'usernameKey', type: ABIDataTypes.UINT256 })
    public getUsernameKey(calldata: Calldata): BytesWriter {
        const wallet: Address = calldata.readAddress();
        const response: BytesWriter = new BytesWriter(U256_BYTE_LENGTH);
        response.writeU256(this.addressToUsername.get(this.addressToU256(wallet)));
        return response;
    }

    @view
    @method({ name: 'walletAddress', type: ABIDataTypes.ADDRESS })
    @returns({ name: 'isRegistered', type: ABIDataTypes.BOOL })
    public isRegistered(calldata: Calldata): BytesWriter {
        const wallet: Address = calldata.readAddress();
        const response: BytesWriter = new BytesWriter(1);
        response.writeBoolean(
            !this.addressToContract.get(this.addressToU256(wallet)).isZero(),
        );
        return response;
    }

    @view
    @method()
    @returns({ name: 'count', type: ABIDataTypes.UINT256 })
    public getProfileCount(_calldata: Calldata): BytesWriter {
        const response: BytesWriter = new BytesWriter(U256_BYTE_LENGTH);
        response.writeU256(this.profileCount.value);
        return response;
    }

    // ── Internal Helpers ────────────────────────────────────────────────────

    private addressToU256(addr: Address): u256 {
        if (addr.isZero()) {
            return u256.Zero;
        }
        return u256.fromUint8ArrayBE(addr);
    }

    private onlyOwner(): void {
        if (Blockchain.tx.sender !== this.owner.value) {
            throw new Revert('Only owner');
        }
    }
}
