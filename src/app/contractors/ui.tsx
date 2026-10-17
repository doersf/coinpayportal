'use client';

/** Shared bits for the contractor pages (business side and portal). */

export const input = 'w-full px-3 py-2 bg-gray-700 border border-gray-600 rounded-lg text-white text-sm';
export const card = 'bg-gray-800/50 rounded-2xl border border-gray-700 p-6';
export const button = 'px-4 py-2 rounded-lg text-sm font-medium text-white bg-purple-600 hover:bg-purple-500 disabled:opacity-50';
export const ghost = 'px-3 py-1.5 rounded-lg text-sm text-gray-200 border border-gray-600 hover:bg-gray-700 disabled:opacity-50';

export const usd = (n: number | string | null | undefined) =>
  new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(Number(n ?? 0));

export const day = (iso: string | null | undefined) =>
  iso ? new Date(iso.length === 10 ? `${iso}T12:00:00Z` : iso).toLocaleDateString('en-US', { dateStyle: 'medium' }) : '';

const tones: Record<string, string> = {
  green: 'bg-green-500/20 text-green-300 border-green-500/30',
  blue: 'bg-blue-500/20 text-blue-300 border-blue-500/30',
  amber: 'bg-amber-500/20 text-amber-300 border-amber-500/30',
  red: 'bg-red-500/20 text-red-300 border-red-500/30',
  gray: 'bg-gray-500/20 text-gray-300 border-gray-500/30',
};

const statusTone: Record<string, keyof typeof tones> = {
  active: 'green', paid: 'green', approved: 'green', verified: 'green',
  invited: 'blue', sent: 'blue', submitted: 'blue', draft: 'gray', pending: 'gray',
  processing: 'amber', partially_paid: 'amber', missing: 'amber', indeterminate: 'amber',
  rejected: 'red', failed: 'red', ended: 'gray', offboarded: 'gray',
};

export function Badge({ status, label }: { status: string; label?: string }) {
  return (
    <span className={`px-2 py-0.5 text-xs rounded-full border whitespace-nowrap ${tones[statusTone[status] ?? 'gray']}`}>
      {label ?? status.replace(/_/g, ' ')}
    </span>
  );
}

export function ErrorBox({ message }: { message: string }) {
  if (!message) return null;
  return <div className="bg-red-500/10 border border-red-500/30 text-red-400 px-4 py-3 rounded-lg text-sm">{message}</div>;
}

export function Spinner() {
  return (
    <div className="min-h-screen bg-gray-900 flex items-center justify-center">
      <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-purple-400"></div>
    </div>
  );
}

export const kindLabel: Record<string, string> = {
  hours: 'Hours',
  milestone: 'Milestone',
  expense: 'Expense',
  bonus: 'Bonus',
  fixed: 'Fixed fee',
};

export function contractTerms(c: { kind: string; rate: number | string | null; frequency: string | null }) {
  if (c.kind === 'fixed') return `${usd(c.rate)} ${c.frequency}`;
  if (c.kind === 'hourly') return `${usd(c.rate)}/hour`;
  return 'Paid per milestone';
}
