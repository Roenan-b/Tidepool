import { cookies } from 'next/headers';
import { MenuBar } from '../../../components/MenuBar.js';
import { SecurityPanel } from '../../../components/SecurityPanel.js';
import { WindowFrame } from '../../../components/WindowFrame.js';
import { requirePage } from '../../../lib/auth/server.js';
import { publicViewer } from '../../../lib/initial.js';
import { THEME_COOKIE, parseTheme } from '../../../lib/theme.js';

export const dynamic = 'force-dynamic';

export default async function SecurityPage() {
  const viewer = await requirePage('security');
  const theme = parseTheme((await cookies()).get(THEME_COOKIE)?.value);
  return (
    <div className="desktop">
      <MenuBar viewer={publicViewer(viewer)} active="security" theme={theme} />
      <main id="main">
        <WindowFrame
          title={
            <>
              <strong>Security</strong> &middot; {viewer.username}
            </>
          }
          size="narrow"
        >
          <SecurityPanel enabled={viewer.totpEnabled} demo={viewer.demo} role={viewer.role} />
        </WindowFrame>
      </main>
    </div>
  );
}
