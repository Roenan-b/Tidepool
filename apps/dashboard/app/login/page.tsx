import { cookies } from 'next/headers';
import Link from 'next/link';
import { redirect } from 'next/navigation';
import { LoginForm } from '../../components/LoginForm.js';
import { MenuBar } from '../../components/MenuBar.js';
import { WindowFrame } from '../../components/WindowFrame.js';
import { getViewer } from '../../lib/auth/server.js';
import { getConfig } from '../../lib/config.js';
import { THEME_COOKIE, parseTheme } from '../../lib/theme.js';

export const dynamic = 'force-dynamic';

export default async function LoginPage() {
  const theme = parseTheme((await cookies()).get(THEME_COOKIE)?.value);
  const demo = getConfig().demoMode;
  const viewer = await getViewer();
  if (viewer && !viewer.demo) redirect(viewer.totpEnabled ? '/' : '/settings/security');
  return (
    <div className="desktop">
      <MenuBar viewer={null} active="login" theme={theme} />
      <main id="main">
        <WindowFrame title={<strong>Sign in to Tidepool</strong>} size="narrow">
          {demo ? (
            <div className="stack">
              <div className="banner banner-warn" role="status">
                <span className="banner-icon" aria-hidden="true">
                  !
                </span>
                <div>
                  <h2>Demo mode</h2>
                  <p>Sign-in is bypassed and every action is disabled. The data shown is sample data.</p>
                </div>
              </div>
              {viewer ? (
                <Link className="btn btn-primary btn-block" href="/">
                  Open the demo
                </Link>
              ) : (
                <p className="error-text">
                  Demo mode only answers requests sent to this machine (127.0.0.1 or localhost).
                </p>
              )}
            </div>
          ) : (
            <LoginForm />
          )}
        </WindowFrame>
      </main>
    </div>
  );
}
