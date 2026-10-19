import type { Metadata } from 'next';

export const metadata: Metadata = {
  title: 'Review and sign',
  robots: { index: false, follow: false },
  referrer: 'no-referrer',
};

export default function SignLayout({ children }: { children: React.ReactNode }) {
  return children;
}
