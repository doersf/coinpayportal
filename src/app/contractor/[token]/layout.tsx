import type { Metadata } from 'next';

export const metadata: Metadata = {
  title: 'Contractor portal',
  robots: { index: false, follow: false },
  referrer: 'no-referrer',
};

export default function ContractorPortalLayout({ children }: { children: React.ReactNode }) {
  return children;
}
