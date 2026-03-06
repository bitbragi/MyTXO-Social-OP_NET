import { u256 } from '@btc-vision/as-bignum/assembly';
import {
    Address,
    AddressMap,
    Blockchain,
    BytesWriter,
    Calldata,
    OP20,
    OP20InitParameters,
    Revert,
    SafeMath,
} from '@btc-vision/btc-runtime/runtime';

@final
export class MytxoToken extends OP20 {
    public constructor() {
        super();
    }

    public override onDeployment(_calldata: Calldata): void {
        // 21 billion tokens with 18 decimals
        const maxSupply: u256 = u256.fromString('21000000000000000000000000000');
        const decimals: u8 = 18;
        const name: string = 'MyTXO';
        const symbol: string = 'MYTXO';

        this.instantiate(new OP20InitParameters(maxSupply, decimals, name, symbol));

        // Mint entire supply to deployer (treasury). Presale contract will
        // receive an allowance or direct transfer before each round.
        this._mint(Blockchain.tx.sender, maxSupply);
    }

    public override onUpdate(_calldata: Calldata): void {
        super.onUpdate(_calldata);
    }

    @method(
        {
            name: 'address',
            type: ABIDataTypes.ADDRESS,
        },
        {
            name: 'amount',
            type: ABIDataTypes.UINT256,
        },
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
            const currentBalance: u256 = this.balanceOfMap.get(address);

            if (currentBalance) {
                this.balanceOfMap.set(address, SafeMath.add(currentBalance, amount));
            } else {
                this.balanceOfMap.set(address, amount);
            }

            totalAirdropped = SafeMath.add(totalAirdropped, amount);

            this.createMintedEvent(address, amount);
        }

        const newTotalSupply = SafeMath.add(this._totalSupply.value, totalAirdropped);
        if (newTotalSupply > this._maxSupply.value) {
            throw new Revert('Exceeds max supply');
        }

        this._totalSupply.set(newTotalSupply);

        return new BytesWriter(0);
    }
}
