'use client';
/** Browser-side helpers: polling with visibility pause and backoff, JSON POST, live clock. */
import { useCallback, useEffect, useRef, useState } from 'react';

export interface PollState<T> {
  data: T | null;
  error: string | null;
  loading: boolean;
  updatedAt: number | null;
}

const REQUEST_TIMEOUT_MS = 10_000;
const MAX_BACKOFF_MS = 30_000;

async function readError(res: Response): Promise<string> {
  try {
    const body = (await res.json()) as { message?: unknown };
    if (typeof body.message === 'string') return body.message;
  } catch {
    /* fall through */
  }
  return `Request failed (${res.status})`;
}

/**
 * Polls a same-origin JSON endpoint. Stops while the tab is hidden and fetches immediately when it
 * becomes visible again. Errors back off exponentially up to 30 seconds; the last good data stays shown.
 */
export function usePoll<T>(
  url: string | null,
  intervalMs: number,
  initial: T | null = null,
): PollState<T> & { refresh: () => void } {
  const [state, setState] = useState<PollState<T>>({
    data: initial,
    error: null,
    loading: initial === null,
    updatedAt: initial === null ? null : Date.now(),
  });
  const [nonce, setNonce] = useState(0);
  const refresh = useCallback(() => setNonce((n) => n + 1), []);

  useEffect(() => {
    if (!url) return undefined;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let inFlight = false;
    let failures = 0;
    let controller: AbortController | null = null;

    const schedule = () => {
      if (stopped || document.hidden) return;
      const delay = failures > 0 ? Math.min(intervalMs * 2 ** failures, MAX_BACKOFF_MS) : intervalMs;
      timer = setTimeout(() => void run(), delay);
    };

    const run = async () => {
      if (stopped || inFlight || document.hidden) return;
      inFlight = true;
      controller = new AbortController();
      const timeout = setTimeout(() => controller?.abort(), REQUEST_TIMEOUT_MS);
      try {
        const res = await fetch(url, { cache: 'no-store', credentials: 'same-origin', signal: controller.signal });
        if (res.status === 401) {
          // eslint-disable-next-line @next/next/no-location-assign-relative-destination -- a full reload after a session change clears client state
          window.location.assign('/login');
          return;
        }
        if (!res.ok) throw new Error(await readError(res));
        const data = (await res.json()) as T;
        failures = 0;
        if (!stopped) setState({ data, error: null, loading: false, updatedAt: Date.now() });
      } catch (err) {
        if (stopped) return;
        failures += 1;
        const message =
          err instanceof DOMException && err.name === 'AbortError'
            ? 'The dashboard server did not answer in time.'
            : err instanceof TypeError
              ? 'Cannot reach the dashboard server. Check your connection.'
              : err instanceof Error
                ? err.message
                : 'Request failed';
        setState((s) => ({ ...s, error: message, loading: false }));
      } finally {
        clearTimeout(timeout);
        inFlight = false;
      }
      schedule();
    };

    const onVisibility = () => {
      if (timer) clearTimeout(timer);
      if (!document.hidden) void run();
    };
    document.addEventListener('visibilitychange', onVisibility);
    void run();
    return () => {
      stopped = true;
      if (timer) clearTimeout(timer);
      controller?.abort();
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [url, intervalMs, nonce]);

  return { ...state, refresh };
}

export type PostResult<T> = { ok: true; data: T } | { ok: false; message: string; status: number };

export async function postJson<T = unknown>(url: string, body: unknown = {}): Promise<PostResult<T>> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS + 5_000);
  try {
    const res = await fetch(url, {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    if (!res.ok) return { ok: false, status: res.status, message: await readError(res) };
    const text = await res.text();
    return { ok: true, data: (text ? JSON.parse(text) : {}) as T };
  } catch (err) {
    const aborted = err instanceof DOMException && err.name === 'AbortError';
    return {
      ok: false,
      status: 0,
      message: aborted
        ? 'The request timed out. Check the status before trying again.'
        : 'Cannot reach the dashboard server.',
    };
  } finally {
    clearTimeout(timeout);
  }
}

/** Current time, updated every `everyMs`. Null until mounted so server and client markup match. */
export function useNow(everyMs = 1000): Date | null {
  const [now, setNow] = useState<Date | null>(null);
  useEffect(() => {
    setNow(new Date());
    const id = setInterval(() => setNow(new Date()), everyMs);
    return () => clearInterval(id);
  }, [everyMs]);
  return now;
}

/** Flash message shown in a polite live region, cleared after a few seconds. */
export function useToast(): {
  toast: { kind: 'ok' | 'error'; text: string } | null;
  show: (kind: 'ok' | 'error', text: string) => void;
} {
  const [toast, setToast] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const show = useCallback((kind: 'ok' | 'error', text: string) => {
    if (timer.current) clearTimeout(timer.current);
    setToast({ kind, text });
    timer.current = setTimeout(() => setToast(null), kind === 'error' ? 9000 : 5000);
  }, []);
  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );
  return { toast, show };
}

/** Reads a text field from a form, treating a missing or non-text value as empty. */
export function formText(form: FormData, name: string): string {
  const v = form.get(name);
  return typeof v === 'string' ? v : '';
}
