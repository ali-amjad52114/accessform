import './globals.css';
import type { ReactNode } from 'react';
export const metadata = { title: 'AccessForm', description: 'Hospital paperwork as a conversation' };
export default function RootLayout({children}:{children:ReactNode}) { return <html lang="en"><body>{children}</body></html>; }
