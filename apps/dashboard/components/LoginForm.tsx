'use client';
/** Two-step sign-in: username and password, then the 6-digit authenticator code. */
import { useRef, useState, type FormEvent } from 'react';
import { formText, postJson } from './client.js';

export function LoginForm() {
  const [step, setStep] = useState<'password' | 'totp'>('password');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const codeRef = useRef<HTMLInputElement>(null);

  const submitPassword = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    setBusy(true);
    setError(null);
    const r = await postJson<{ next: 'totp' | 'enroll' }>('/api/auth/login', {
      username: formText(form, 'username'),
      password: formText(form, 'password'),
    });
    setBusy(false);
    if (!r.ok) {
      setError(r.message);
      return;
    }
    if (r.data.next === 'enroll') {
      window.location.assign('/settings/security');
      return;
    }
    setStep('totp');
    setTimeout(() => codeRef.current?.focus(), 0);
  };

  const submitCode = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    setBusy(true);
    setError(null);
    const r = await postJson('/api/auth/totp', { code: formText(form, 'code').replace(/\s/g, '') });
    setBusy(false);
    if (!r.ok) {
      setError(r.message);
      if (r.status === 401 && r.message.includes('password again')) setStep('password');
      return;
    }
    window.location.assign('/');
  };

  return (
    <div className="stack">
      {step === 'password' ? (
        <form
          className="stack"
          onSubmit={(e) => void submitPassword(e)}
          aria-describedby={error ? 'login-error' : undefined}
        >
          <div className="field">
            <label htmlFor="username">Username</label>
            <input
              id="username"
              name="username"
              className="input"
              autoComplete="username"
              autoCapitalize="none"
              spellCheck={false}
              required
              maxLength={64}
            />
          </div>
          <div className="field">
            <label htmlFor="password">Password</label>
            <input
              id="password"
              name="password"
              type="password"
              className="input"
              autoComplete="current-password"
              required
              maxLength={1024}
            />
          </div>
          <button type="submit" className="btn btn-primary btn-block" disabled={busy}>
            {busy ? 'Checking...' : 'Continue'}
          </button>
        </form>
      ) : (
        <form
          className="stack"
          onSubmit={(e) => void submitCode(e)}
          aria-describedby={error ? 'login-error' : 'code-hint'}
        >
          <div className="field">
            <label htmlFor="code">Authenticator code</label>
            <input
              ref={codeRef}
              id="code"
              name="code"
              className="input input-code"
              inputMode="numeric"
              autoComplete="one-time-code"
              pattern="[0-9 ]{6,7}"
              maxLength={7}
              required
            />
            <p id="code-hint" className="hint">
              Open your authenticator app and enter the 6-digit code for Tidepool.
            </p>
          </div>
          <button type="submit" className="btn btn-primary btn-block" disabled={busy}>
            {busy ? 'Verifying...' : 'Sign in'}
          </button>
          <button type="button" className="btn btn-ghost" onClick={() => setStep('password')}>
            Use a different account
          </button>
        </form>
      )}
      <div aria-live="assertive">
        {error ? (
          <p id="login-error" className="error-text">
            {error}
          </p>
        ) : null}
      </div>
      <p className="subtle">Five wrong attempts lock the account for 15 minutes.</p>
    </div>
  );
}
