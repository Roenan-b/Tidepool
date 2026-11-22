import { cookies } from 'next/headers';
import { OpsConsole } from '../../components/OpsConsole.js';
import { requirePage } from '../../lib/auth/server.js';
import { loadInitialStatus, publicViewer } from '../../lib/initial.js';
import { THEME_COOKIE, parseTheme } from '../../lib/theme.js';

export const dynamic = 'force-dynamic';

export default async function OpsPage() {
  const viewer = await requirePage('ops');
  const { status, error } = await loadInitialStatus(viewer);
  const theme = parseTheme((await cookies()).get(THEME_COOKIE)?.value);
  return <OpsConsole viewer={publicViewer(viewer)} theme={theme} initialStatus={status} initialError={error} />;
}
