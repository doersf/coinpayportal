/**
 * Who gets what when an escrow settles.
 *
 * A release pays up to three legs from the escrow address: the beneficiary,
 * CoinPay's commission, and the owning business's marketplace fee. A refund
 * pays only the depositor, in full: neither fee is charged on money that goes
 * back. Kept pure so the arithmetic is tested apart from the RPC calls.
 */

export interface SettlementEscrow {
  amount: number;
  deposited_amount?: number | null;
  fee_amount?: number | null;
  marketplace_fee_amount?: number | null;
  marketplace_fee_address?: string | null;
  depositor_address: string;
  beneficiary_address: string;
}

export type SettlementLegKind = 'beneficiary' | 'platform_fee' | 'marketplace_fee' | 'refund';

export interface SettlementLeg {
  kind: SettlementLegKind;
  address: string;
  amount: number;
}

export interface SettlementPlan {
  /** The leg the escrow exists to pay. Always first in `legs`. */
  primary: SettlementLeg;
  /** Every leg, primary first. Fee legs appear only when they are payable. */
  legs: SettlementLeg[];
}

export function planSettlement(
  escrow: SettlementEscrow,
  action: 'release' | 'refund',
  commissionWallet: string | null | undefined,
): SettlementPlan {
  const held = Number(escrow.deposited_amount || escrow.amount);

  if (action === 'refund') {
    const primary: SettlementLeg = { kind: 'refund', address: escrow.depositor_address, amount: held };
    return { primary, legs: [primary] };
  }

  const platformFee = Number(escrow.fee_amount || 0);
  const marketplaceFee = escrow.marketplace_fee_address ? Number(escrow.marketplace_fee_amount || 0) : 0;

  // The beneficiary is short both fees whether or not each one can be paid
  // out right now: an unpaid fee is logged as owed, never handed to the seller.
  const primary: SettlementLeg = {
    kind: 'beneficiary',
    address: escrow.beneficiary_address,
    amount: held - platformFee - marketplaceFee,
  };

  if (!(primary.amount > 0)) {
    throw new Error(
      `Escrow fees (${platformFee} + ${marketplaceFee}) leave nothing for the beneficiary out of ${held}`,
    );
  }

  const legs: SettlementLeg[] = [primary];
  if (platformFee > 0 && commissionWallet) {
    legs.push({ kind: 'platform_fee', address: commissionWallet, amount: platformFee });
  }
  if (marketplaceFee > 0 && escrow.marketplace_fee_address) {
    legs.push({ kind: 'marketplace_fee', address: escrow.marketplace_fee_address, amount: marketplaceFee });
  }

  return { primary, legs };
}
