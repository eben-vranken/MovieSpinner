import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'MovieSpinner',
  description: 'Five films a day, weighted at the gaps, and everything that decided them.',
};

/**
 * There is one page, so there is no navigation.
 *
 * The header used to carry three links. Removing them is the point of the
 * rewrite rather than a side effect of it: the choice at the top and the
 * evidence underneath it were never really separate things, and putting them on
 * separate routes meant you always saw one without the other.
 */
export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="min-h-screen">
        <header className="border-b border-edge">
          <div className="mx-auto flex max-w-[1600px] items-baseline gap-4 px-6 py-4">
            <span className="text-sm font-semibold tracking-[0.2em] text-accent uppercase">
              MovieSpinner
            </span>
            <span className="text-xs text-muted">
              five films a day, weighted at your blind spots
            </span>
          </div>
        </header>
        <main className="mx-auto max-w-[1600px] px-6 py-8">{children}</main>
      </body>
    </html>
  );
}
