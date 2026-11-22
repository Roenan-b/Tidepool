import type { Metadata, Viewport } from 'next';
import { cookies } from 'next/headers';
import type { ReactNode } from 'react';
import { THEME_COOKIE, parseTheme } from '../lib/theme.js';
import './globals.css';

export const metadata: Metadata = {
  title: 'Tidepool',
  description: 'Tidepool trading pool controls',
  robots: { index: false, follow: false },
  referrer: 'no-referrer',
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  themeColor: [
    { media: '(prefers-color-scheme: light)', color: '#ededef' },
    { media: '(prefers-color-scheme: dark)', color: '#2a2a2e' },
  ],
};

export default async function RootLayout({ children }: { children: ReactNode }) {
  // Read on the server so the first paint already uses the chosen appearance (no flash).
  const theme = parseTheme((await cookies()).get(THEME_COOKIE)?.value);
  return (
    <html lang="en" data-theme={theme === 'system' ? undefined : theme}>
      <body>{children}</body>
    </html>
  );
}
