import './globals.css';
import type { Metadata, Viewport } from 'next';
import type { ReactNode } from 'react';

export const metadata: Metadata = {
  title: 'AccessForm',
  description:
    'AccessForm turns a hospital financial-assistance application into a conversation, for people who cannot read the paperwork.',
};

/**
 * `maximumScale`/`userScalable` are deliberately left at their permissive
 * defaults so the page can be zoomed to 200% and beyond (ACCESSIBILITY.md).
 */
export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  themeColor: '#F7F5F0',
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body suppressHydrationWarning>
        <a className="af-skip" href="#main">
          Skip to main content
        </a>
        {children}
      </body>
    </html>
  );
}
