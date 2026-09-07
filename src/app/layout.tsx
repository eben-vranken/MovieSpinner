import type { Metadata } from 'next';
import Link from 'next/link';
import './globals.css';

export const metadata: Metadata = {
  title: 'MovieSpinner',
  description: 'One film a day, chosen to fill the gaps.',
};

const NAV = [
  { href: '/', label: 'Today' },
  { href: '/dashboard', label: 'Coverage' },
  { href: '/lineage', label: 'Lineage' },
];

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="min-h-screen">
        <header className="border-b border-edge">
          <nav className="mx-auto flex max-w-5xl items-baseline gap-6 px-6 py-4">
            <span className="text-sm font-semibold tracking-[0.2em] text-accent uppercase">
              MovieSpinner
            </span>
            <div className="flex gap-5 text-sm">
              {NAV.map((item) => (
                <Link key={item.href} href={item.href} className="text-muted hover:text-paper">
                  {item.label}
                </Link>
              ))}
            </div>
          </nav>
        </header>
        <main className="mx-auto max-w-5xl px-6 py-10">{children}</main>
      </body>
    </html>
  );
}
