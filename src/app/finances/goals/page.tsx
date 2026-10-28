import type { Metadata } from 'next';
import GoalsContent from './GoalsContent';

export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: 'Goals · CoinPay',
  robots: { index: false, follow: false },
};

/** /finances/goals — savings and payoff goals with daily to quarterly progress reports. */
export default function FinanceGoalsPage() {
  return <GoalsContent />;
}
