import { Blockchain } from '@btc-vision/btc-runtime/runtime';
import { revertOnError } from '@btc-vision/btc-runtime/runtime/abort/abort';
import { ScribeGovernance } from './ScribeGovernance';

Blockchain.contract = () => {
    return new ScribeGovernance();
};

export * from '@btc-vision/btc-runtime/runtime/exports';

export function abort(message: string, fileName: string, line: u32, column: u32): void {
    revertOnError(message, fileName, line, column);
}
