import { describe, expect, it } from 'vitest';
import * as web from './e2e';
// The CLI/SDK implementation must stay byte-compatible with the browser's.
import * as sdk from '../../../packages/sdk/src/documents.js';

const BUSINESS = '6f1c2d3e-0000-4000-8000-000000000001';
const DOC = '6f1c2d3e-0000-4000-8000-000000000002';

describe('browser and CLI encryption interoperate', () => {
  it('opens each other’s sealed documents and vaults', async () => {
    const dk = web.newKey();
    const fromWeb = await web.seal(dk, new TextEncoder().encode('from the browser'), web.AAD.original(DOC));
    expect(new TextDecoder().decode(await sdk.open(dk, fromWeb, sdk.AAD.original(DOC)))).toBe('from the browser');
    const fromCli = await sdk.seal(dk, new TextEncoder().encode('from the cli'), sdk.AAD.signed(DOC));
    expect(new TextDecoder().decode(await web.open(dk, fromCli, web.AAD.signed(DOC)))).toBe('from the cli');

    const vaultKey = web.newKey();
    const webVault = await web.wrapVault(BUSINESS, vaultKey, 'shared passphrase');
    expect(await sdk.unlockVaultRecord(BUSINESS, webVault, 'shared passphrase')).toEqual(vaultKey);
    const cliVault = await sdk.wrapVault(BUSINESS, vaultKey, 'shared passphrase');
    expect(await web.unlockVault(BUSINESS, cliVault, 'shared passphrase')).toEqual(vaultKey);

    expect(web.keyFromFragment(new URL(sdk.linkWithKey('https://x/sign/t', dk)).hash)).toEqual(dk);
  }, 30_000);
});
