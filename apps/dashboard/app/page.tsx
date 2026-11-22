import { cookies } from 'next/headers';
import { LIVE_MODE_CONFIRMATION } from '@tidepool/core';
import { OwnerConsole } from '../components/OwnerConsole.js';
import { requirePage } from '../lib/auth/server.js';
import { loadInitialStatus, presetSummaries, publicViewer } from '../lib/initial.js';
import { THEME_COOKIE, parseTheme } from '../lib/theme.js';

export const dynamic = 'force-dynamic';

export default async function HomePage() {
  const viewer = await requirePage('home');
  const { status, error } = await loadInitialStatus(viewer);
  const theme = parseTheme((await cookies()).get(THEME_COOKIE)?.value);
  return (
    <OwnerConsole
      viewer={publicViewer(viewer)}
      theme={theme}
      initialStatus={status}
      initialError={error}
      presets={presetSummaries()}
      liveConfirmation={LIVE_MODE_CONFIRMATION}
    />
  );
}
