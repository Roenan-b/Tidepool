/**
 * CSRF defence for mutating requests: the Origin header must equal DASHBOARD_ORIGIN exactly.
 * Combined with SameSite=Strict cookies this blocks cross-site form posts and fetches.
 * A missing Origin is rejected (fail closed); modern browsers send it on every POST.
 */
export function checkSameOrigin(
  headers: { origin: string | null; secFetchSite: string | null },
  allowedOrigin: string,
): { ok: true } | { ok: false; reason: string } {
  if (headers.secFetchSite && headers.secFetchSite !== 'same-origin') {
    return { ok: false, reason: 'cross-site request' };
  }
  if (!headers.origin) return { ok: false, reason: 'missing Origin header' };
  let given: string;
  try {
    given = new URL(headers.origin).origin;
  } catch {
    return { ok: false, reason: 'malformed Origin header' };
  }
  if (headers.origin === 'null' || given !== allowedOrigin) return { ok: false, reason: 'origin mismatch' };
  return { ok: true };
}
