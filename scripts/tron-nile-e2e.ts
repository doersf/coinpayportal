/**
 * USDT (TRC-20) end to end on the Nile testnet: deposit detection and the
 * sweep, with the same code the payment monitor and forwarder run.
 *
 *   TRON_API_URL=https://nile.trongrid.io \
 *   TRON_USDT_CONTRACT=TXYZopYRdj2D9XRtbG411XZZ3kM5VkAeBf \
 *   npx tsx scripts/tron-nile-e2e.ts
 *
 * The "buyer" is an index of the public BIP39 test mnemonic ("abandon ... about",
 * TRON_E2E_BUYER_INDEX, default 4), which holds Nile TRX and test USDT. Several
 * of its lower indexes have had their permissions reassigned to another key
 * (a common testnet honeypot), so they cannot send; index 4 still can. Everything CoinPay-side (deposit address,
 * gas relayer, merchant, platform) comes from a fresh random mnemonic made for
 * this run and never printed. Testnet only: refuses to run against mainnet.
 */
import { generateMnemonic } from '@scure/bip39';
import { wordlist } from '@scure/bip39/wordlists/english';
import { deriveTronWallet } from '../src/lib/tron/address';
import { getTrc20Balance, getTrxBalanceSun, sendTrc20, sendTrx, tronApiUrl, SUN_PER_TRX, fromTokenUnits } from '../src/lib/tron/client';
import { forwardTronUsdtSplit } from '../src/lib/tron/forward';
import { isSufficientPayment } from '../src/lib/payments/tolerance';

const PUBLIC_TEST_MNEMONIC = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main() {
  if (!/nile|shasta/.test(tronApiUrl())) throw new Error(`Refusing to run against ${tronApiUrl()}: testnet only`);
  const amount = 2.5;
  const buyer = deriveTronWallet(PUBLIC_TEST_MNEMONIC, Number(process.env.TRON_E2E_BUYER_INDEX ?? 4));
  const system = generateMnemonic(wordlist);
  const relayer = deriveTronWallet(system, 0, 1);
  const deposit = deriveTronWallet(system, 5);
  const merchant = deriveTronWallet(system, 900);
  const platform = deriveTronWallet(system, 901);
  console.log({ api: tronApiUrl(), buyer: buyer.address, relayer: relayer.address, deposit: deposit.address, merchant: merchant.address, platform: platform.address });

  console.log('fund relayer 40 TRX:', await sendTrx(buyer.privateKey, relayer.address, 40n * SUN_PER_TRX));
  const t0 = Date.now();
  console.log(`buyer pays ${amount} USDT:`, await sendTrc20(buyer.privateKey, deposit.address, BigInt(amount * 1e6), 50n * SUN_PER_TRX));

  // Detection: what monitor-balance does every cycle (solidified balanceOf + the settlement rule).
  for (;;) {
    const bal = fromTokenUnits(await getTrc20Balance(deposit.address));
    if (isSufficientPayment(bal, amount, 'USDT_TRON')) {
      console.log(`detected ${bal} USDT at the solidified head after ${Math.round((Date.now() - t0) / 1000)}s`);
      break;
    }
    if (Date.now() - t0 > 240_000) throw new Error('not detected within 4 minutes');
    await sleep(5_000);
  }

  const merchantAmount = 2.475;
  const platformAmount = 0.025;
  const t1 = Date.now();
  const res = await forwardTronUsdtSplit(deposit.privateKey, [
    { address: merchant.address, amount: merchantAmount },
    { address: platform.address, amount: platformAmount },
  ], relayer.privateKey);
  console.log(`swept in ${Math.round((Date.now() - t1) / 1000)}s`, res);

  await sleep(6_000);
  const m = fromTokenUnits(await getTrc20Balance(merchant.address, undefined, { solidified: false }));
  const p = fromTokenUnits(await getTrc20Balance(platform.address, undefined, { solidified: false }));
  const left = fromTokenUnits(await getTrc20Balance(deposit.address, undefined, { solidified: false }));
  const trxLeft = Number(await getTrxBalanceSun(deposit.address, { solidified: false })) / 1e6;
  const relayerLeft = Number(await getTrxBalanceSun(relayer.address, { solidified: false })) / 1e6;
  console.log({ merchantUsdt: m, platformUsdt: p, depositUsdtLeft: left, depositTrxLeft: trxLeft, relayerTrxLeft: relayerLeft });
  if (m !== merchantAmount || p !== platformAmount || left !== 0) throw new Error('balances do not reconcile');
  console.log('OK: detected, swept and reconciled on', tronApiUrl());
}

main().catch((e) => { console.error('FAILED', e?.message, e?.body ? JSON.stringify(e.body).slice(0, 400) : ''); process.exit(1); });
