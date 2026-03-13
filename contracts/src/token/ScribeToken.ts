import { u256 } from '@btc-vision/as-bignum/assembly';
import {
    Address,
    AddressMap,
    Blockchain,
    BytesWriter,
    Calldata,
    NetEvent,
    OP20,
    OP20InitParameters,
    Revert,
    SafeMath,
    StoredBoolean,
    StoredU256,
} from '@btc-vision/btc-runtime/runtime';
import { AddressMemoryMap } from '@btc-vision/btc-runtime/runtime/memory/AddressMemoryMap';
import { ADDRESS_BYTE_LENGTH, U256_BYTE_LENGTH } from '@btc-vision/btc-runtime/runtime/utils';
import { EMPTY_POINTER } from '@btc-vision/btc-runtime/runtime/math/bytes';

class TransferEvent extends NetEvent {
    constructor(from: Address, to: Address, amount: u256) {
        const data: BytesWriter = new BytesWriter(
            ADDRESS_BYTE_LENGTH * 2 + U256_BYTE_LENGTH,
        );
        data.writeAddress(from);
        data.writeAddress(to);
        data.writeU256(amount);
        super('Transfer', data);
    }
}

class TaxTransferEvent extends NetEvent {
    constructor(from: Address, to: Address, amount: u256, tax: u256) {
        const data: BytesWriter = new BytesWriter(
            ADDRESS_BYTE_LENGTH * 2 + U256_BYTE_LENGTH * 2,
        );
        data.writeAddress(from);
        data.writeAddress(to);
        data.writeU256(amount);
        data.writeU256(tax);
        super('TaxTransfer', data);
    }
}

class ExclusionChangedEvent extends NetEvent {
    constructor(account: Address, excluded: boolean) {
        const data: BytesWriter = new BytesWriter(ADDRESS_BYTE_LENGTH + 1);
        data.writeAddress(account);
        data.writeBoolean(excluded);
        super('ExclusionChanged', data);
    }
}

// ── Storage pointers (OP20 uses 0–6; ours start at 7) ──────────────────
const rTotalPointer: u16 = Blockchain.nextPointer;
const taxEnabledPointer: u16 = Blockchain.nextPointer;
const isExcludedPointer: u16 = Blockchain.nextPointer;
const tOwnedPointer: u16 = Blockchain.nextPointer;
const excludedRTotalPointer: u16 = Blockchain.nextPointer;
const excludedTTotalPointer: u16 = Blockchain.nextPointer;
const totalFeesPointer: u16 = Blockchain.nextPointer;
const reentrantPointer: u16 = Blockchain.nextPointer;

// ── Constants ───────────────────────────────────────────────────────────
const MAX_U256: u256 = u256.Max;
const TAX_NUMERATOR: u64 = 6;
const TAX_DENOMINATOR: u64 = 100;
const T_TOTAL: u256 = u256.fromString('21000000000000000000000000000'); // 21B * 10^18

/**
 * ScribeToken v2 — OP20 reflection token with 6 % transfer tax.
 *
 * Tax mechanism (SafeMoon / RFI style):
 *   On every non-excluded transfer the sender pays 6 % tax.  The tax is
 *   "reflected" by reducing rTotal, which mathematically increases every
 *   non-excluded holder's effective balance.  No actual transfer call is
 *   made; the redistribution is implicit in the rate calculation.
 *
 * Tax-excluded addresses (owner, presale, faucet, rewards) are exempt
 * from paying tax AND do not receive reflections.  Their balance is
 * tracked in a separate tOwned map and stays fixed.
 *
 * Running totals excludedRTotal / excludedTTotal eliminate the need to
 * iterate excluded addresses when computing the rate.
 */
@final
export class ScribeToken extends OP20 {
    private readonly _rTotal: StoredU256;
    private readonly _taxEnabled: StoredBoolean;
    private readonly _isExcluded: AddressMemoryMap;
    private readonly _tOwned: AddressMemoryMap;
    private readonly _excludedRTotal: StoredU256;
    private readonly _excludedTTotal: StoredU256;
    private readonly _totalFees: StoredU256;
    private readonly _reentrant: StoredBoolean;

    public constructor() {
        super();

        this._rTotal = new StoredU256(rTotalPointer, EMPTY_POINTER);
        this._taxEnabled = new StoredBoolean(taxEnabledPointer, false);
        this._isExcluded = new AddressMemoryMap(isExcludedPointer);
        this._tOwned = new AddressMemoryMap(tOwnedPointer);
        this._excludedRTotal = new StoredU256(excludedRTotalPointer, EMPTY_POINTER);
        this._excludedTTotal = new StoredU256(excludedTTotalPointer, EMPTY_POINTER);
        this._totalFees = new StoredU256(totalFeesPointer, EMPTY_POINTER);
        this._reentrant = new StoredBoolean(reentrantPointer, false);
    }

    // ── Deployment ──────────────────────────────────────────────────────

    public override onDeployment(_calldata: Calldata): void {
        const decimals: u8 = 18;
        const name: string = 'MyScribe';
        const symbol: string = 'SCRIBE';

        this.instantiate(new OP20InitParameters(T_TOTAL, decimals, name, symbol));

        // rTotal = (MAX_U256 / tTotal) * tTotal — ensures clean division
        const quotient: u256 = SafeMath.div(MAX_U256, T_TOTAL);
        const rTotal: u256 = SafeMath.mul(quotient, T_TOTAL);
        this._rTotal.value = rTotal;

        const deployer: Address = Blockchain.tx.sender;
        this.balanceOfMap.set(deployer, rTotal); // rOwned

        // Deployer is excluded so treasury doesn't absorb reflections
        this._isExcluded.set(deployer, u256.One);
        this._tOwned.set(deployer, T_TOTAL);
        this._excludedRTotal.value = rTotal;
        this._excludedTTotal.value = T_TOTAL;

        this._taxEnabled.value = true;
        this._totalFees.value = u256.Zero;

        this.createMintedEvent(deployer, T_TOTAL);
    }

    public override onUpdate(_calldata: Calldata): void {
        super.onUpdate(_calldata);
    }

    // ── Balance (overridden to compute from reflection space) ───────────

    public override balanceOf(calldata: Calldata): BytesWriter {
        const owner: Address = calldata.readAddress();
        const bal: u256 = this._effectiveBalance(owner);

        const writer: BytesWriter = new BytesWriter(U256_BYTE_LENGTH);
        writer.writeU256(bal);
        return writer;
    }

    // ── Transfer (overridden with 6 % tax) ──────────────────────────────

    public override transfer(calldata: Calldata): BytesWriter {
        const to: Address = calldata.readAddress();
        const amount: u256 = calldata.readU256();
        const sender: Address = Blockchain.tx.sender;

        this._reflectTransfer(sender, to, amount);

        const writer: BytesWriter = new BytesWriter(1);
        writer.writeBoolean(true);
        return writer;
    }

    public override transferFrom(calldata: Calldata): BytesWriter {
        const from: Address = calldata.readAddress();
        const to: Address = calldata.readAddress();
        const amount: u256 = calldata.readU256();

        this._spendAllowance(from, Blockchain.tx.sender, amount);
        this._reflectTransfer(from, to, amount);

        const writer: BytesWriter = new BytesWriter(1);
        writer.writeBoolean(true);
        return writer;
    }

    // ── Admin methods ───────────────────────────────────────────────────

    @method({ name: 'account', type: ABIDataTypes.ADDRESS },
            { name: 'excluded', type: ABIDataTypes.BOOL })
    @emit('ExclusionChanged')
    @returns()
    public setTaxExcluded(calldata: Calldata): BytesWriter {
        this.onlyDeployer(Blockchain.tx.sender);

        const account: Address = calldata.readAddress();
        const excluded: boolean = calldata.readBoolean();
        const currentlyExcluded: bool = !this._isExcluded.get(account).isZero();

        if (excluded && !currentlyExcluded) {
            this._excludeAccount(account);
        } else if (!excluded && currentlyExcluded) {
            this._includeAccount(account);
        }

        this.emitEvent(new ExclusionChangedEvent(account, excluded));
        return new BytesWriter(0);
    }

    @method({ name: 'enabled', type: ABIDataTypes.BOOL })
    @returns()
    public setTaxEnabled(calldata: Calldata): BytesWriter {
        this.onlyDeployer(Blockchain.tx.sender);
        this._taxEnabled.value = calldata.readBoolean();
        return new BytesWriter(0);
    }

    @method(
        { name: 'address', type: ABIDataTypes.ADDRESS },
        { name: 'amount', type: ABIDataTypes.UINT256 },
    )
    @emit('Minted')
    @returns()
    public mint(calldata: Calldata): BytesWriter {
        this.onlyDeployer(Blockchain.tx.sender);
        this._mint(calldata.readAddress(), calldata.readU256());
        return new BytesWriter(0);
    }

    @method({
        name: 'addressAndAmount',
        type: ABIDataTypes.ADDRESS_UINT256_TUPLE,
    })
    @emit('Minted')
    @returns()
    public airdrop(calldata: Calldata): BytesWriter {
        this.onlyDeployer(Blockchain.tx.sender);

        const addressAndAmount: AddressMap<u256> = calldata.readAddressMapU256();
        const addresses: Address[] = addressAndAmount.keys();
        let totalAirdropped: u256 = u256.Zero;

        for (let i: i32 = 0; i < addresses.length; i++) {
            const address = addresses[i];
            if (!address) {
                throw new Revert('Invalid address in airdrop list');
            }
            const amount = addressAndAmount.get(address);
            this._mint(address, amount);
            totalAirdropped = SafeMath.add(totalAirdropped, amount);
        }

        return new BytesWriter(0);
    }

    // ── View helpers ────────────────────────────────────────────────────

    @view
    @method({ name: 'account', type: ABIDataTypes.ADDRESS })
    @returns(
        { name: 'isExcluded', type: ABIDataTypes.BOOL },
        { name: 'taxEnabled', type: ABIDataTypes.BOOL },
        { name: 'totalFees', type: ABIDataTypes.UINT256 },
    )
    public getReflectionInfo(calldata: Calldata): BytesWriter {
        const account: Address = calldata.readAddress();
        const excluded: bool = !this._isExcluded.get(account).isZero();

        const writer: BytesWriter = new BytesWriter(2 + U256_BYTE_LENGTH);
        writer.writeBoolean(excluded);
        writer.writeBoolean(this._taxEnabled.value);
        writer.writeU256(this._totalFees.value);
        return writer;
    }

    // ── Internal: reflection transfer engine ────────────────────────────

    private _reflectTransfer(from: Address, to: Address, tAmount: u256): void {
        if (from.equals(Address.zero())) {
            throw new Revert('Transfer from zero address');
        }
        if (to.equals(Address.zero())) {
            throw new Revert('Transfer to zero address');
        }
        if (tAmount.isZero()) {
            throw new Revert('Transfer amount is zero');
        }

        this._guardEnter();

        const senderExcluded: bool = !this._isExcluded.get(from).isZero();
        const recipientExcluded: bool = !this._isExcluded.get(to).isZero();
        const takeTax: bool = this._taxEnabled.value && !senderExcluded && !recipientExcluded;

        let tTax: u256 = u256.Zero;
        let tNet: u256 = tAmount;
        if (takeTax) {
            tTax = SafeMath.div(
                SafeMath.mul(tAmount, u256.fromU64(TAX_NUMERATOR)),
                u256.fromU64(TAX_DENOMINATOR),
            );
            tNet = SafeMath.sub(tAmount, tTax);
        }

        const currentRate: u256 = this._getRate();
        const rAmount: u256 = SafeMath.mul(tAmount, currentRate);
        const rTax: u256 = SafeMath.mul(tTax, currentRate);
        const rNet: u256 = SafeMath.sub(rAmount, rTax);

        // Effects: update sender
        const senderROld: u256 = this.balanceOfMap.get(from);
        if (senderROld < rAmount) {
            throw new Revert('Insufficient balance');
        }
        this.balanceOfMap.set(from, SafeMath.sub(senderROld, rAmount));

        if (senderExcluded) {
            const senderTOld: u256 = this._tOwned.get(from);
            if (senderTOld < tAmount) {
                throw new Revert('Insufficient balance');
            }
            this._tOwned.set(from, SafeMath.sub(senderTOld, tAmount));
            this._excludedRTotal.value = SafeMath.sub(this._excludedRTotal.value, rAmount);
            this._excludedTTotal.value = SafeMath.sub(this._excludedTTotal.value, tAmount);
        }

        // Effects: update receiver
        this.balanceOfMap.set(to, SafeMath.add(this.balanceOfMap.get(to), rNet));

        if (recipientExcluded) {
            this._tOwned.set(to, SafeMath.add(this._tOwned.get(to), tNet));
            this._excludedRTotal.value = SafeMath.add(this._excludedRTotal.value, rNet);
            this._excludedTTotal.value = SafeMath.add(this._excludedTTotal.value, tNet);
        }

        // Effects: reflect tax (shrink rTotal = redistribution)
        if (!rTax.isZero()) {
            this._rTotal.value = SafeMath.sub(this._rTotal.value, rTax);
            this._totalFees.value = SafeMath.add(this._totalFees.value, tTax);
        }

        this.emitEvent(new TransferEvent(from, to, tNet));

        if (!tTax.isZero()) {
            this.emitEvent(new TaxTransferEvent(from, to, tAmount, tTax));
        }

        this._guardExit();
    }

    // ── Internal: reflection math ───────────────────────────────────────

    private _effectiveBalance(account: Address): u256 {
        if (!this._isExcluded.get(account).isZero()) {
            return this._tOwned.get(account);
        }
        return this._tokenFromReflection(this.balanceOfMap.get(account));
    }

    private _tokenFromReflection(rAmount: u256): u256 {
        if (rAmount.isZero()) return u256.Zero;
        const rate: u256 = this._getRate();
        return SafeMath.div(rAmount, rate);
    }

    private _getRate(): u256 {
        const rTotal: u256 = this._rTotal.value;
        const exclR: u256 = this._excludedRTotal.value;
        const exclT: u256 = this._excludedTTotal.value;

        const rSupply: u256 = SafeMath.sub(rTotal, exclR);
        const tSupply: u256 = SafeMath.sub(T_TOTAL, exclT);

        if (rSupply.isZero() || tSupply.isZero()) {
            return SafeMath.div(rTotal, T_TOTAL);
        }

        return SafeMath.div(rSupply, tSupply);
    }

    // ── Internal: exclusion management ──────────────────────────────────

    private _excludeAccount(account: Address): void {
        const rOwned: u256 = this.balanceOfMap.get(account);
        const tOwned: u256 = this._tokenFromReflection(rOwned);

        this._isExcluded.set(account, u256.One);
        this._tOwned.set(account, tOwned);
        this._excludedRTotal.value = SafeMath.add(this._excludedRTotal.value, rOwned);
        this._excludedTTotal.value = SafeMath.add(this._excludedTTotal.value, tOwned);
    }

    private _includeAccount(account: Address): void {
        const rOwned: u256 = this.balanceOfMap.get(account);
        const tOld: u256 = this._tOwned.get(account);

        this._isExcluded.set(account, u256.Zero);
        this._tOwned.set(account, u256.Zero);
        this._excludedRTotal.value = SafeMath.sub(this._excludedRTotal.value, rOwned);
        this._excludedTTotal.value = SafeMath.sub(this._excludedTTotal.value, tOld);
    }

    // ── Reentrancy guard (StoredBoolean to avoid name collision with OP20 base) ─

    private _guardEnter(): void {
        if (this._reentrant.value) {
            throw new Revert('Reentrant call');
        }
        this._reentrant.value = true;
    }

    private _guardExit(): void {
        this._reentrant.value = false;
    }
}
