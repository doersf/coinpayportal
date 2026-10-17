# USDT on TRON (TRC-20)

`USDT_TRON` is a payment chain like `USDT_SOL`: each payment gets its own
deposit address from the system HD wallet, the monitor watches it, and once the
full quote has arrived the funds are swept to the merchant and the platform.

## How it works

| Step | Where | Detail |
|---|---|---|
| Address | `lib/wallets/system-wallet.ts` | `m/44'/195'/0'/0/i` from `SYSTEM_MNEMONIC_TRON` (falls back to `SYSTEM_MNEMONIC_ETH`; coin type 195 gives unrelated keys). Derivation family `TRON`. |
| Detection | `lib/tron/client.ts` `getUsdtTronBalance` | TRC-20 `balanceOf` on TronGrid's `/walletsolidity` endpoint, i.e. the **solidified** head. A solidified block is irreversible (about 19 blocks, roughly a minute), so a balance seen there is final and also serves as the confirmation count. A TronGrid failure throws; it is never read as a zero balance. |
| Settlement rule | `lib/payments/tolerance.ts` | Same as every chain: the full quoted amount, with the one-atomic-unit allowance for a 6-decimal token. |
| Sweep | `lib/tron/forward.ts`, called from `secure-forwarding.ts` | The deposit address holds USDT and no TRX. The **TRON gas relayer** (`m/44'/195'/1'/0/0`) sends it just enough TRX for the energy, then the deposit address sends the merchant leg and the platform leg. Leftover TRX goes back to the relayer. |
| Gas recovery | `computeGasReserve` | The quote's network fee arrives as USDT and is withheld to the platform leg, the same as for ERC-20 payments. |
| Relayer empty | `TronRelayerUnderfundedError` | Checked before anything is broadcast, so the payment goes back to `confirmed` with `forwarding_deferred`. An ops email names the relayer address, and the half-hourly float check warns below about 160 TRX. |

Transactions are built by the node and signed locally. Before signing, the
client checks that the txID is the SHA-256 of `raw_data_hex` and that those bytes
contain the owner, the recipient and the amount it asked for. A node that
swapped the payee would be refused.

## Cost

TRON charges for a token transfer in energy. With no TRX staked, the energy is
paid by burning TRX at the chain's energy price (100 sun as of 2026-10):

- about 64,285 energy (6.4 TRX) to a recipient that already holds USDT;
- about 130,285 energy (13 TRX) to one that never has;
- 1.1 TRX to activate each new deposit address.

A sweep has two transfers, so it costs about 14.7 TRX (about $5 at $0.34/TRX).
The quote passes that on to the buyer as the network fee
(`rates/fees.ts` `estimateTronUsdtFee`, which reads the live energy price and the
TRX price). On a small order that is a large share of the price. Staking TRX for
energy on the relayer would remove most of it.

## Switching it on

1. Set `PLATFORM_FEE_WALLET_TRON` (or `PLATFORM_FEE_WALLET_USDT_TRON`) to a TRON
   address the platform controls. Until it is set, `POST /api/payments/create`
   answers `400 CHAIN_NOT_ENABLED` for `USDT_TRON`.
2. Fund the TRON gas relayer with TRX. Its address is
   `deriveTronRelayerWallet().address`.
3. Optionally set `TRON_PRO_API_KEY`. Keyless TronGrid allows 3 requests a
   second, and the client paces itself to that.
4. Apply `supabase/migrations/20261017160000_usdt_tron_chain.sql`. It widens the
   three CHECK constraints.
5. Each merchant adds a `USDT_TRON` payout wallet (a `T…` address). The address
   is checked with full base58check, so a typo is refused.

## Testnet

`scripts/tron-nile-e2e.ts` runs detection and the sweep against Nile with the
production code paths. It funds a fresh relayer, pays a fresh deposit address
from the public BIP39 test mnemonic, waits for solidified detection, sweeps and
reconciles:

```
TRON_API_URL=https://nile.trongrid.io \
TRON_USDT_CONTRACT=TXYZopYRdj2D9XRtbG411XZZ3kM5VkAeBf \
npx tsx scripts/tron-nile-e2e.ts
```
