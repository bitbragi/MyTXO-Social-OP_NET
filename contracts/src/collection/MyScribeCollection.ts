import { u256 } from '@btc-vision/as-bignum/assembly';
import {
    OP721,
    OP721InitParameters,
    Blockchain,
    Address,
    Calldata,
    BytesWriter,
    SafeMath,
    Revert,
    Selector,
    encodeSelector,
    StoredMapU256,
    StoredString,
} from '@btc-vision/btc-runtime/runtime';

/**
 * MyScribeCollection — OP721 NFT Collection with Ordinals inscription metadata.
 *
 * Each minted token stores an Ordinals inscription ID for content resolution.
 * The deployer sets collection name, symbol, and max supply on deployment.
 * Only the deployer can mint new tokens.
 */
@final
export class MyScribeCollection extends OP721 {
    private readonly mintSelector: Selector = encodeSelector('mint');
    private readonly tokenURISelector: Selector = encodeSelector('tokenURI');

    private readonly inscriptionIdPointer: u16 = Blockchain.nextPointer;
    private readonly inscriptionIdMap: StoredMapU256 = new StoredMapU256(this.inscriptionIdPointer);

    public constructor() {
        super();
    }

    public override onDeployment(calldata: Calldata): void {
        const name: string = calldata.readStringWithLength();
        const symbol: string = calldata.readStringWithLength();
        const maxSupply: u256 = calldata.readU256();
        const description: string = calldata.readStringWithLength();
        const icon: string = calldata.readStringWithLength();
        const banner: string = calldata.readStringWithLength();
        const website: string = calldata.readStringWithLength();

        this.instantiate(
            new OP721InitParameters(
                name, symbol, '', maxSupply,
                banner, icon, website, description,
            ),
        );
    }

    public override execute(method: Selector, calldata: Calldata): BytesWriter {
        switch (method) {
            case this.mintSelector:
                return this.mint(calldata);
            case this.tokenURISelector:
                return this.getTokenURI(calldata);
            default:
                return super.execute(method, calldata);
        }
    }

    @method(
        { name: 'tokenId', type: ABIDataTypes.UINT256 },
        { name: 'inscriptionId', type: ABIDataTypes.STRING },
    )
    @returns({ name: 'success', type: ABIDataTypes.BOOL })
    @emit('Transferred')
    private mint(calldata: Calldata): BytesWriter {
        this.onlyDeployer(Blockchain.tx.sender);

        const tokenId: u256 = calldata.readU256();
        const inscriptionId: string = calldata.readStringWithLength();

        const currentSupply: u256 = this.totalSupply;
        const max: u256 = this.maxSupply;
        if (u256.ge(currentSupply, max)) {
            throw new Revert('Max supply reached');
        }

        const to: Address = Blockchain.tx.sender;
        this._mint(to, tokenId);
        this._nextTokenId.value = SafeMath.add(tokenId, u256.One);

        this.storeInscriptionId(tokenId, inscriptionId);

        const writer: BytesWriter = new BytesWriter(1);
        writer.writeBoolean(true);
        return writer;
    }

    @method({ name: 'tokenId', type: ABIDataTypes.UINT256 })
    @returns({ name: 'uri', type: ABIDataTypes.STRING })
    private getTokenURI(calldata: Calldata): BytesWriter {
        const tokenId: u256 = calldata.readU256();

        const inscriptionId: string = this.loadInscriptionId(tokenId);

        const writer: BytesWriter = new BytesWriter(4 + inscriptionId.length * 2);
        writer.writeStringWithLength(inscriptionId);
        return writer;
    }

    /**
     * Stores an inscription ID keyed by token ID.
     * Uses a u256 hash of the inscription string as the stored value.
     */
    private storeInscriptionId(tokenId: u256, inscriptionId: string): void {
        const stored: StoredString = new StoredString(this.inscriptionIdPointer, tokenId.lo1);
        stored.value = inscriptionId;
    }

    private loadInscriptionId(tokenId: u256): string {
        const stored: StoredString = new StoredString(this.inscriptionIdPointer, tokenId.lo1);
        return stored.value;
    }
}
