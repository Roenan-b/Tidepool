'use client';
/** Top menu-bar strip: brand, navigation, mode badge, appearance toggle, clock and sign out. */
import Link from 'next/link';
import { useState } from 'react';
import { postJson, useNow } from './client.js';
import { ModeBadge } from './WindowFrame.js';

import type { Theme } from '../lib/theme.js';

const NEXT_THEME: Record<Theme, Theme> = { system: 'light', light: 'dark', dark: 'system' };
const THEME_LABEL: Record<Theme, string> = { system: 'Auto', light: 'Light', dark: 'Dark' };

export interface MenuViewer {
  username: string;
  role: 'owner' | 'operator';
  demo: boolean;
  totpEnabled: boolean;
}

export function MenuBar(props: {
  viewer: MenuViewer | null;
  active: 'home' | 'ops' | 'security' | 'login';
  mode?: 'paper' | 'live' | null;
  showMode?: boolean;
  theme: Theme;
}) {
  const now = useNow(1000);
  const [theme, setTheme] = useState<Theme>(props.theme);
  const v = props.viewer;

  const cycleTheme = () => {
    const next = NEXT_THEME[theme];
    setTheme(next);
    const secure = window.location.protocol === 'https:' ? '; secure' : '';
    document.cookie = `tp_theme=${next}; path=/; max-age=31536000; samesite=strict${secure}`;
    if (next === 'system') delete document.documentElement.dataset.theme;
    else document.documentElement.dataset.theme = next;
    // The operations view defaults to dark; reload it so the server applies the new choice.
    if (props.active === 'ops') window.location.reload();
  };

  const signOut = async () => {
    await postJson('/api/auth/logout');
    // eslint-disable-next-line @next/next/no-location-assign-relative-destination -- a full reload after a session change clears client state
    window.location.assign('/login');
  };

  const canOps = v !== null && (v.demo || (v.role === 'operator' && v.totpEnabled));
  const canHome = v !== null && (v.demo || v.totpEnabled);

  return (
    <nav className="menubar" aria-label="Main">
      <a className="skip-link" href="#main">
        Skip to content
      </a>
      <span className="menubar-brand">
        <span className="brand-mark" aria-hidden="true" />
        <span className="hide-xs">Tidepool</span>
      </span>
      {canHome ? (
        <Link href="/" aria-current={props.active === 'home' ? 'page' : undefined}>
          Home
        </Link>
      ) : null}
      {canOps ? (
        <Link href="/ops" aria-current={props.active === 'ops' ? 'page' : undefined}>
          Operations
        </Link>
      ) : null}
      {v && !v.demo ? (
        <Link
          className="hide-narrow"
          href="/settings/security"
          aria-current={props.active === 'security' ? 'page' : undefined}
        >
          Security
        </Link>
      ) : null}
      <span className="menubar-spacer" />
      {v?.demo ? (
        <span className="badge badge-demo" title="Sample data; actions are disabled">
          Demo
        </span>
      ) : null}
      {props.showMode ? <ModeBadge mode={props.mode ?? null} /> : null}
      <button
        type="button"
        className="menu-item"
        onClick={cycleTheme}
        aria-label={`Appearance: ${THEME_LABEL[theme]}. Change appearance`}
      >
        <span aria-hidden="true">{theme === 'dark' ? '☾' : theme === 'light' ? '☀' : '◐'}</span>
        <span className="hide-narrow"> {THEME_LABEL[theme]}</span>
      </button>
      <span className="menubar-clock hide-xs" aria-label="Current time">
        {now ? now.toLocaleString(undefined, { weekday: 'short', hour: '2-digit', minute: '2-digit' }) : ' '}
      </span>
      {v && !v.demo ? (
        <button
          type="button"
          className="menu-item"
          onClick={() => void signOut()}
          aria-label={`Sign out ${v.username}`}
        >
          Sign out
        </button>
      ) : null}
    </nav>
  );
}
