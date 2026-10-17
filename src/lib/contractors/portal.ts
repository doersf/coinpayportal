import type { SupabaseClient } from '@supabase/supabase-js';
import { z } from 'zod';
import { loadInvoiceSettings } from '@/lib/invoices/settings';
import {
  CONTRACTOR_TOKEN_PATTERN,
  hoursAmount,
  MILESTONE_COLUMNS,
  payoutProfileSchema,
  sealTaxId,
  taxFormSchema,
  zodError,
} from './service';
import { notifyBusinessOfSubmission, notifyContractSigned, notifyWalletChanged } from './notify';

/**
 * The contractor's portal: everything one contractor needs from one business,
 * behind an unguessable link (the link is the credential, like the client
 * portal). No CoinPay account is needed to get paid.
 */

const PORTAL_CONTRACTOR =
  'id, business_id, name, email, country, job_title, status, payout_currency, payout_wallet, tax_form, tax_status, ' +
  'tax_legal_name, tax_id_last4, tax_signed_at';

type PortalContractor = {
  id: string;
  business_id: string;
  name: string;
  email: string;
  status: string;
  payout_currency: string | null;
  payout_wallet: string | null;
};

export async function findContractorByToken(supabase: SupabaseClient, token: string) {
  if (!CONTRACTOR_TOKEN_PATTERN.test(token)) return null;
  const { data } = await supabase
    .from('contractors')
    .select(PORTAL_CONTRACTOR)
    .eq('portal_token', token)
    .neq('status', 'offboarded')
    .maybeSingle();
  return (data as unknown as PortalContractor & Record<string, unknown>) ?? null;
}

export async function loadContractorPortal(supabase: SupabaseClient, token: string) {
  const contractor = await findContractorByToken(supabase, token);
  if (!contractor) return null;
  const [business, contracts, work, payments, settings] = await Promise.all([
    supabase.from('businesses').select('name').eq('id', contractor.business_id).maybeSingle(),
    supabase
      .from('contractor_contracts')
      .select(
        `id, title, scope, kind, rate, currency, frequency, start_date, end_date, next_pay_date, notice_days, status, ` +
          `business_signed_name, business_signed_at, contractor_signed_name, contractor_signed_at, end_reason, contractor_milestones (${MILESTONE_COLUMNS})`
      )
      .eq('contractor_id', contractor.id)
      .neq('status', 'draft')
      .order('created_at', { ascending: false }),
    supabase
      .from('contractor_work_items')
      .select('id, contract_id, kind, milestone_id, description, work_date, minutes, amount, receipt_url, submitted_by, status, review_note, created_at')
      .eq('contractor_id', contractor.id)
      .order('created_at', { ascending: false })
      .limit(300),
    supabase
      .from('pay_run_items')
      .select('id, amount, payout_currency, payout_wallet, status, tx_hash, invoice_number, paid_at, pay_runs (number, pay_date)')
      .eq('contractor_id', contractor.id)
      .eq('status', 'paid')
      .order('paid_at', { ascending: false })
      .limit(200),
    loadInvoiceSettings(supabase, contractor.business_id),
  ]);
  return {
    contractor,
    business: { name: (business.data?.name as string) ?? 'Your client' },
    brand: { color: settings.brand_color, logo_url: settings.logo_url },
    contracts: contracts.data ?? [],
    work_items: work.data ?? [],
    payments: payments.data ?? [],
  };
}

/** One paid item rendered as the invoice the contractor issued for it. */
export async function loadPortalInvoice(supabase: SupabaseClient, token: string, itemId: string) {
  const contractor = await findContractorByToken(supabase, token);
  if (!contractor || !z.string().uuid().safeParse(itemId).success) return null;
  const { data: item } = await supabase
    .from('pay_run_items')
    .select('id, amount, payout_currency, payout_wallet, status, tx_hash, invoice_number, paid_at, created_at, pay_runs (number, pay_date)')
    .eq('id', itemId)
    .eq('contractor_id', contractor.id)
    .maybeSingle();
  if (!item) return null;
  const [{ data: lines }, { data: business }, { data: full }] = await Promise.all([
    supabase
      .from('contractor_work_items')
      .select('kind, description, work_date, minutes, amount')
      .eq('pay_run_item_id', itemId)
      .order('work_date'),
    supabase.from('businesses').select('name').eq('id', contractor.business_id).maybeSingle(),
    supabase.from('contractors').select('tax_legal_name, tax_business_name, tax_address').eq('id', contractor.id).single(),
  ]);
  return { contractor: { ...contractor, ...(full ?? {}) }, business: { name: business?.name ?? '' }, item, lines: lines ?? [] };
}

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const money = z.number().finite().positive().max(1_000_000).refine((n) => n === Math.round(n * 100) / 100, 'Use at most two decimals');

const actionSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('payout') }).passthrough(),
  z.object({ action: z.literal('tax_form') }).passthrough(),
  z.object({ action: z.literal('sign'), contract_id: z.string().uuid(), signature: z.string().trim().min(2).max(200) }).strict(),
  z
    .object({
      action: z.literal('hours'),
      contract_id: z.string().uuid(),
      work_date: isoDate,
      minutes: z.number().int().min(1).max(24 * 60),
      description: z.string().trim().min(1).max(1000),
    })
    .strict(),
  z.object({ action: z.literal('milestone'), milestone_id: z.string().uuid(), note: z.string().trim().max(1000).optional() }).strict(),
  z
    .object({
      action: z.literal('expense'),
      contract_id: z.string().uuid(),
      amount: money,
      description: z.string().trim().min(1).max(1000),
      work_date: isoDate.optional(),
      receipt_url: z.string().url().startsWith('https://').max(1000).optional(),
    })
    .strict(),
  z.object({ action: z.literal('withdraw'), work_item_id: z.string().uuid() }).strict(),
]);

type Result = { ok: true; data?: unknown } | { ok: false; status: number; error: string };
const bad = (error: string, status = 400): Result => ({ ok: false, status, error });

async function liveContract(supabase: SupabaseClient, contractor: PortalContractor, contractId: string) {
  const { data } = await supabase
    .from('contractor_contracts')
    .select('id, kind, rate, status, start_date, end_date, title')
    .eq('id', contractId)
    .eq('contractor_id', contractor.id)
    .maybeSingle();
  return data;
}

export async function runPortalAction(supabase: SupabaseClient, token: string, body: unknown): Promise<Result> {
  const contractor = await findContractorByToken(supabase, token);
  if (!contractor) return bad('This portal link is no longer valid', 404);
  const parsed = actionSchema.safeParse(body);
  if (!parsed.success) return bad(zodError(parsed.error));
  const a = parsed.data;
  const now = new Date().toISOString();
  const today = now.slice(0, 10);

  switch (a.action) {
    case 'payout': {
      const { action: _a, ...rest } = a as Record<string, unknown>;
      const p = payoutProfileSchema.safeParse(rest);
      if (!p.success) return bad(zodError(p.error));
      const changed = p.data.payout_wallet !== contractor.payout_wallet || p.data.payout_currency !== contractor.payout_currency;
      if (!changed) return { ok: true };
      await supabase
        .from('contractors')
        .update({
          ...p.data,
          // The very first wallet is not a "change"; replacing one is.
          payout_wallet_changed_at: contractor.payout_wallet ? now : null,
          status: 'active',
          updated_at: now,
        })
        .eq('id', contractor.id);
      if (contractor.payout_wallet) await notifyWalletChanged(supabase, contractor, p.data.payout_currency, p.data.payout_wallet);
      return { ok: true };
    }

    case 'tax_form': {
      const { action: _a, ...rest } = a as Record<string, unknown>;
      const f = taxFormSchema.safeParse(rest);
      if (!f.success) return bad(zodError(f.error));
      const sealed = f.data.tax_id ? sealTaxId(f.data.tax_id) : { tax_id_encrypted: null, tax_id_last4: null };
      await supabase
        .from('contractors')
        .update({
          tax_form: f.data.tax_form,
          tax_status: 'submitted',
          tax_legal_name: f.data.legal_name,
          tax_business_name: f.data.business_name ?? null,
          tax_classification: f.data.classification ?? (f.data.tax_form === 'W8BENE' ? 'foreign_entity' : 'individual'),
          tax_address: f.data.address,
          tax_country: f.data.country,
          ...sealed,
          tax_signed_name: f.data.signature,
          tax_signed_at: now,
          updated_at: now,
        })
        .eq('id', contractor.id);
      return { ok: true };
    }

    case 'sign': {
      const { data } = await supabase
        .from('contractor_contracts')
        .update({ status: 'active', contractor_signed_name: a.signature, contractor_signed_at: now, updated_at: now })
        .eq('id', a.contract_id)
        .eq('contractor_id', contractor.id)
        .eq('status', 'sent')
        .select('title')
        .maybeSingle();
      if (!data) return bad('This contract is not waiting for your signature', 409);
      await supabase.from('contractors').update({ status: 'active' }).eq('id', contractor.id).eq('status', 'invited');
      await notifyContractSigned(supabase, contractor.business_id, contractor.name, data.title);
      return { ok: true };
    }

    case 'hours': {
      const c = await liveContract(supabase, contractor, a.contract_id);
      if (!c || c.status !== 'active') return bad('You can log hours only on a signed, active contract');
      if (c.kind !== 'hourly') return bad('This contract is not hourly');
      if (a.work_date > today || a.work_date < c.start_date || (c.end_date && a.work_date > c.end_date)) {
        return bad('That date is outside the contract');
      }
      const amount = hoursAmount(c.rate, a.minutes);
      const { error } = await supabase.from('contractor_work_items').insert({
        business_id: contractor.business_id,
        contractor_id: contractor.id,
        contract_id: c.id,
        kind: 'hours',
        description: a.description,
        work_date: a.work_date,
        minutes: a.minutes,
        amount,
        submitted_by: 'contractor',
      });
      if (error) return bad('Could not save those hours', 500);
      await notifyBusinessOfSubmission(supabase, contractor.business_id, contractor.name, `${(a.minutes / 60).toFixed(2)} hours ($${amount.toFixed(2)})`);
      return { ok: true };
    }

    case 'milestone': {
      const { data: m } = await supabase
        .from('contractor_milestones')
        .select('id, title, amount, status, contract_id, contractor_contracts!inner (contractor_id, status)')
        .eq('id', a.milestone_id)
        .maybeSingle();
      const parent = m?.contractor_contracts as unknown as { contractor_id: string; status: string } | undefined;
      if (!m || parent?.contractor_id !== contractor.id) return bad('Milestone not found', 404);
      if (parent.status !== 'active') return bad('Sign the contract before submitting milestones');
      if (m.status !== 'pending') return bad('This milestone was already submitted', 409);
      const { error } = await supabase.from('contractor_work_items').insert({
        business_id: contractor.business_id,
        contractor_id: contractor.id,
        contract_id: m.contract_id,
        kind: 'milestone',
        milestone_id: m.id,
        description: a.note ? `${m.title}: ${a.note}` : m.title,
        work_date: today,
        amount: m.amount,
        submitted_by: 'contractor',
      });
      if (error) return bad(error.code === '23505' ? 'This milestone was already submitted' : 'Could not submit', error.code === '23505' ? 409 : 500);
      await supabase.from('contractor_milestones').update({ status: 'submitted' }).eq('id', m.id);
      await notifyBusinessOfSubmission(supabase, contractor.business_id, contractor.name, `milestone "${m.title}"`);
      return { ok: true };
    }

    case 'expense': {
      const c = await liveContract(supabase, contractor, a.contract_id);
      if (!c || c.status !== 'active') return bad('You can claim expenses only on a signed, active contract');
      const { error } = await supabase.from('contractor_work_items').insert({
        business_id: contractor.business_id,
        contractor_id: contractor.id,
        contract_id: c.id,
        kind: 'expense',
        description: a.description,
        work_date: a.work_date && a.work_date <= today ? a.work_date : today,
        amount: a.amount,
        receipt_url: a.receipt_url ?? null,
        submitted_by: 'contractor',
      });
      if (error) return bad('Could not save the expense', 500);
      await notifyBusinessOfSubmission(supabase, contractor.business_id, contractor.name, `an expense of $${a.amount.toFixed(2)}`);
      return { ok: true };
    }

    case 'withdraw': {
      const { data } = await supabase
        .from('contractor_work_items')
        .delete()
        .eq('id', a.work_item_id)
        .eq('contractor_id', contractor.id)
        .eq('submitted_by', 'contractor')
        .eq('status', 'submitted')
        .select('milestone_id');
      if (!data?.length) return bad('Only a submission still waiting for review can be withdrawn', 409);
      if (data[0].milestone_id) await supabase.from('contractor_milestones').update({ status: 'pending' }).eq('id', data[0].milestone_id);
      return { ok: true };
    }
  }
}
