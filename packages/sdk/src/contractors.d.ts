import type { CoinPayClient } from './client.js';

export interface Contractor {
  id: string;
  business_id: string;
  name: string;
  email: string;
  country: string | null;
  job_title: string | null;
  status: 'invited' | 'active' | 'offboarded';
  payout_currency: string | null;
  payout_wallet: string | null;
  payout_wallet_changed_at: string | null;
  tax_form: 'W9' | 'W8BEN' | 'W8BENE' | null;
  tax_status: 'missing' | 'submitted' | 'verified';
  tax_legal_name: string | null;
  tax_id_last4: string | null;
  pending_approvals?: number;
}

export interface ContractorMilestone {
  id: string;
  contract_id: string;
  title: string;
  amount: string;
  due_date: string | null;
  position: number;
  status: 'pending' | 'submitted' | 'approved' | 'paid';
}

export interface ContractorContract {
  id: string;
  contractor_id: string;
  title: string;
  scope: string | null;
  kind: 'fixed' | 'hourly' | 'milestone';
  rate: string | null;
  frequency: 'weekly' | 'biweekly' | 'semimonthly' | 'monthly' | null;
  start_date: string;
  end_date: string | null;
  next_pay_date: string | null;
  status: 'draft' | 'sent' | 'active' | 'ended';
  contractor_milestones?: ContractorMilestone[];
}

export interface ContractorWorkItem {
  id: string;
  contractor_id: string;
  contract_id: string;
  kind: 'hours' | 'milestone' | 'expense' | 'bonus' | 'fixed';
  description: string;
  work_date: string;
  minutes: number | null;
  amount: string;
  status: 'submitted' | 'approved' | 'rejected' | 'paid';
  review_note: string | null;
}

export interface PayRun {
  id: string;
  business_id: string;
  number: number;
  pay_date: string;
  status: 'draft' | 'processing' | 'paid' | 'partially_paid';
  total: string;
  auto_drafted: boolean;
  paid_at: string | null;
  contractors?: number;
  paid?: number;
}

export interface PayRunItem {
  id: string;
  contractor_id: string;
  amount: string;
  status: 'pending' | 'processing' | 'paid' | 'failed' | 'indeterminate';
  method: 'wallet' | 'manual' | null;
  tx_hash: string | null;
  error: string | null;
  invoice_number: string;
  warnings?: string[];
  can_send_from_wallet?: boolean;
}

export interface PayOutcome {
  item_id: string;
  contractor: string;
  status: string;
  tx_hash?: string | null;
  error?: string;
}

export function listContractors(client: CoinPayClient, options?: { businessId?: string; includeOffboarded?: boolean }): Promise<Contractor[]>;
export function getContractor(client: CoinPayClient, contractorId: string): Promise<{ contractor: Contractor; contracts: ContractorContract[]; work_items: ContractorWorkItem[]; payments: PayRunItem[] }>;
export function addContractor(client: CoinPayClient, input: { businessId?: string; name: string; email: string; country?: string; jobTitle?: string; sendInvite?: boolean }): Promise<{ contractor: Contractor; portal_url: string }>;
export function createContractorPortalLink(client: CoinPayClient, contractorId: string, options?: { sendEmail?: boolean }): Promise<string>;
export function offboardContractor(client: CoinPayClient, contractorId: string): Promise<{ success: boolean }>;
export function createContract(
  client: CoinPayClient,
  contractorId: string,
  input: {
    title: string;
    kind: 'fixed' | 'hourly' | 'milestone';
    scope?: string;
    rate?: number;
    frequency?: 'weekly' | 'biweekly' | 'semimonthly' | 'monthly';
    startDate?: string;
    endDate?: string;
    firstPayDate?: string;
    milestones?: { title: string; amount: number; due_date?: string }[];
  }
): Promise<ContractorContract>;
export function sendContract(client: CoinPayClient, contractId: string, input: { signature: string }): Promise<ContractorContract>;
export function endContract(client: CoinPayClient, contractId: string, input?: { reason?: string; endDate?: string }): Promise<ContractorContract>;
export function listWorkItems(client: CoinPayClient, options?: { businessId?: string; status?: string; contractorId?: string }): Promise<ContractorWorkItem[]>;
export function reviewWorkItem(client: CoinPayClient, workItemId: string, input: { action: 'approve' | 'reject'; note?: string }): Promise<ContractorWorkItem>;
export function addContractorPayment(client: CoinPayClient, input: { businessId?: string; contractId: string; kind: 'bonus' | 'expense'; amount: number; description: string }): Promise<ContractorWorkItem>;
export function listPayRuns(client: CoinPayClient, options?: { businessId?: string }): Promise<PayRun[]>;
export function getPayRun(client: CoinPayClient, payRunId: string): Promise<{ pay_run: PayRun; items: PayRunItem[]; sendable_coins: string[] }>;
export function createPayRun(client: CoinPayClient, options?: { businessId?: string; payDate?: string }): Promise<PayRun>;
export function deletePayRun(client: CoinPayClient, payRunId: string): Promise<{ success: boolean }>;
export function payPayRun(client: CoinPayClient, payRunId: string, options?: { itemIds?: string[] }): Promise<{ success: boolean; pay_run: PayRun; outcomes: PayOutcome[] }>;
export function recordPayRunPayments(client: CoinPayClient, payRunId: string, payments: { itemId: string; txHash: string }[]): Promise<{ success: boolean; pay_run: PayRun; outcomes: PayOutcome[] }>;
export function get1099Summary(client: CoinPayClient, options?: { businessId?: string; year?: number }): Promise<{ year: number; threshold: number; contractors: { contractor_id: string; name: string; tax_form: string | null; total_paid: number; needs_1099_nec: boolean; missing_w9: boolean }[] }>;
