import './globals.css';
import type { Metadata, Viewport } from 'next';
import type { ReactNode } from 'react';

export const metadata: Metadata = {
  title: 'AccessForm',
  description:
    'AccessForm finds the official program for your situation, turns its form into a conversation, fills the real document, and texts you what is still missing.',
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
