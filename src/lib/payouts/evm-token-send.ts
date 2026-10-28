/**
 * ERC-20 payouts. The EVM providers only move the native coin, so a USDC_POL
 * payout through them would have sent POL. Token payouts go through here.
 */
import { ethers } from 'ethers';
import { TOKEN_TRANSFER_GAS_LIMIT, ERC20_ABI } from '@/lib/wallets/evm-gas';
import { EVM_PAYOUT_TOKENS } from './payout-wallet';

export function isEvmPayoutToken(cryptocurrency: string): boolean {
  return cryptocurrency.toUpperCase() in EVM_PAYOUT_TOKENS;
}

/** Amount in the token's smallest unit, rounded down to what exists on chain. */
export function toTokenUnits(amount: number, decimals: number): bigint {
  const scale = 10 ** decimals;
  const floored = Math.floor(amount * scale + 1e-6) / scale;
  return ethers.parseUnits(floored.toFixed(decimals), decimals);
}

export interface TokenPayoutCheck {
  ok: boolean;
  error?: string;
  units: bigint;
  tokenBalance: string;
  nativeBalance: string;
}

/** Can `from` send `amount` of the token and pay the gas? Read-only. */
export async function checkTokenPayout(
  rpcUrl: string,
  cryptocurrency: string,
  from: string,
  amount: number
): Promise<TokenPayoutCheck> {
  const token = EVM_PAYOUT_TOKENS[cryptocurrency.toUpperCase()];
  const provider = new ethers.JsonRpcProvider(rpcUrl);
  const contract = new ethers.Contract(token.contract, ERC20_ABI, provider);
  const units = toTokenUnits(amount, token.decimals);
  const [rawBalance, native, fee] = await Promise.all([
    contract.balanceOf(from) as Promise<bigint>,
    provider.getBalance(from),
    provider.getFeeData(),
  ]);
  const gasCost = TOKEN_TRANSFER_GAS_LIMIT * (fee.maxFeePerGas ?? fee.gasPrice ?? 0n);
  const tokenBalance = ethers.formatUnits(rawBalance, token.decimals);
  const nativeBalance = ethers.formatEther(native);
  if (units <= 0n) {
    return { ok: false, error: `Amount rounds to 0 ${cryptocurrency}`, units, tokenBalance, nativeBalance };
  }
  if (rawBalance < units) {
    return {
      ok: false,
      error: `Insufficient balance. Payout wallet ${from} has ${tokenBalance} ${cryptocurrency}, need ${ethers.formatUnits(units, token.decimals)}`,
      units, tokenBalance, nativeBalance,
    };
  }
  if (native < gasCost) {
    return {
      ok: false,
      error: `Insufficient gas. Payout wallet ${from} has ${nativeBalance} ${token.native}, needs about ${ethers.formatEther(gasCost)} ${token.native} for the transfer`,
      units, tokenBalance, nativeBalance,
    };
  }
  return { ok: true, units, tokenBalance, nativeBalance };
}

/** Broadcast the transfer and wait for it to be mined. Returns the tx hash. */
export async function sendTokenPayout(
  rpcUrl: string,
  cryptocurrency: string,
  from: string,
  to: string,
  units: bigint,
  privateKey: string
): Promise<string> {
  const token = EVM_PAYOUT_TOKENS[cryptocurrency.toUpperCase()];
  const provider = new ethers.JsonRpcProvider(rpcUrl);
  const wallet = new ethers.Wallet(privateKey, provider);
  if (ethers.getAddress(from) !== wallet.address) {
    throw new Error('Sender address does not match the signing wallet');
  }
  const contract = new ethers.Contract(token.contract, ERC20_ABI, wallet);
  const tx = await contract.transfer(ethers.getAddress(to), units, { gasLimit: TOKEN_TRANSFER_GAS_LIMIT });
  const receipt = await tx.wait();
  if (receipt && receipt.status !== 1) throw new Error(`token transfer reverted: ${tx.hash}`);
  return tx.hash;
}
