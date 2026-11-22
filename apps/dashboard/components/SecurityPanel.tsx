'use client';
/** TOTP enrollment: generate a secret, show it as a QR code, and enable only after a valid code. */
import { useState, type FormEvent } from 'react';
import { postJson } from './client.js';

interface Enrollment {
  qrDataUrl: string;
  secret: string;
  otpauthUri: string;
}

export function SecurityPanel(props: { enabled: boolean; demo: boolean; role: 'owner' | 'operator' }) {
  const [enrollment, setEnrollment] = useState<Enrollment | null>(null);
  const [enabled, setEnabled] = useState(props.enabled);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const start = async () => {
    setBusy(true);
    setError(null);
    const r = await postJson<Enrollment>('/api/auth/totp/enroll');
    setBusy(false);
    if (r.ok) setEnrollment(r.data);
    else setError(r.message);
  };

  const confirm = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const code = String(new FormData(e.currentTarget).get('code') ?? '').replace(/\s/g, '');
    setBusy(true);
    setError(null);
    const r = await postJson('/api/auth/totp/enable', { code });
    setBusy(false);
    if (r.ok) {
      setEnabled(true);
      setEnrollment(null);
    } else setError(r.message);
  };

  if (props.demo) {
    return <p>Security settings are not available in demo mode.</p>;
  }

  if (enabled) {
    return (
      <div className="stack">
        <div className="banner banner-info" role="status">
          <span className="banner-icon" aria-hidden="true">&#10003;</span>
          <div>
            <h2>Two-factor sign-in is on</h2>
            <p>Every sign-in asks for a code from your authenticator app.</p>
          </div>
        </div>
        <a className="btn btn-primary" href={props.role === 'operator' ? '/ops' : '/'}>Continue to the dashboard</a>
        <p className="subtle">Lost your phone? An operator can reset two-factor sign-in with the create-user script on the server.</p>
      </div>
    );
  }

  return (
    <div className="stack">
      <div className="banner banner-warn" role="status">
        <span className="banner-icon" aria-hidden="true">!</span>
        <div>
          <h2>Set up two-factor sign-in</h2>
          <p>The dashboard stays locked until your account has an authenticator app connected.</p>
        </div>
      </div>
      {!enrollment ? (
        <button type="button" className="btn btn-primary" onClick={start} disabled={busy}>
          {busy ? 'Preparing...' : 'Set up authenticator app'}
        </button>
      ) : (
        <form className="stack" onSubmit={confirm}>
          <p>Scan this code with an authenticator app (any app that supports time-based codes).</p>
          <img className="qr" src={enrollment.qrDataUrl} alt="QR code containing your Tidepool authenticator setup key" width={220} height={220} />
          <div className="field">
            <span className="hint">Cannot scan? Enter this key by hand:</span>
            <code className="address" aria-label="Setup key">{enrollment.secret.match(/.{1,4}/g)?.join(' ')}</code>
          </div>
          <div className="field">
            <label htmlFor="enroll-code">Code from the app</label>
            <input id="enroll-code" name="code" className="input input-code" inputMode="numeric" autoComplete="one-time-code" pattern="[0-9 ]{6,7}" maxLength={7} required />
          </div>
          <button type="submit" className="btn btn-primary" disabled={busy}>
            {busy ? 'Checking...' : 'Turn on two-factor sign-in'}
          </button>
          <p className="subtle">This key is shown once. Starting over creates a new key.</p>
        </form>
      )}
      <div aria-live="assertive">{error ? <p className="error-text">{error}</p> : null}</div>
      <p className="subtle">Passkeys are not supported yet; time-based codes are the second factor.</p>
    </div>
  );
}
