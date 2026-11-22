/** Small helpers for route handlers: JSON responses, bounded body parsing, request metadata. */
import { NextResponse, type NextRequest } from 'next/server';
import { getConfig } from './config.js';
import { checkSameOrigin } from './auth/origin.js';
import { readBoundedText } from './bounded.js';

export const MAX_BODY_BYTES = 8 * 1024;

export function json(data: unknown, status = 200): NextResponse {
  return NextResponse.json(data, {
    status,
    headers: { 'Cache-Control': 'no-store', 'Content-Type': 'application/json; charset=utf-8' },
  });
}

export function errorJson(status: number, error: string, message: string): NextResponse {
  return json({ error, message }, status);
}

export type BodyResult = { ok: true; value: unknown } | { ok: false; message: string };

/** Parses a JSON body of at most MAX_BODY_BYTES. An empty body parses as {}. */
export function parseJsonText(text: string): BodyResult {
  if (Buffer.byteLength(text, 'utf8') > MAX_BODY_BYTES) return { ok: false, message: 'Request body is too large' };
  if (text.trim() === '') return { ok: true, value: {} };
  try {
    return { ok: true, value: JSON.parse(text) as unknown };
  } catch {
    return { ok: false, message: 'Request body is not valid JSON' };
  }
}

export async function readJsonBody(req: { headers: Headers; body: ReadableStream<Uint8Array> | null }): Promise<BodyResult> {
  const declared = Number(req.headers.get('content-length') ?? '0');
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) return { ok: false, message: 'Request body is too large' };
  const type = req.headers.get('content-type') ?? '';
  if (!type.toLowerCase().startsWith('application/json')) return { ok: false, message: 'Expected application/json' };
  // Content-Length can be absent (chunked) or wrong, so the limit is also enforced while reading.
  const read = await readBoundedText(req.body, MAX_BODY_BYTES);
  if (!read.ok) return { ok: false, message: read.reason === 'too_large' ? 'Request body is too large' : 'Request body could not be read' };
  return parseJsonText(read.text);
}

/** CSRF check for every mutating handler. Returns an error response or null when allowed. */
export function rejectCrossOrigin(req: NextRequest): NextResponse | null {
  const result = checkSameOrigin(
    { origin: req.headers.get('origin'), secFetchSite: req.headers.get('sec-fetch-site') },
    getConfig().dashboardOrigin,
  );
  return result.ok ? null : errorJson(403, 'bad_origin', 'This request did not come from the dashboard.');
}

export function requestMeta(req: NextRequest): { ip: string | null; userAgent: string | null } {
  // The dashboard binds to loopback behind a trusted reverse proxy or VPN; X-Forwarded-For is informational only.
  const fwd = req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? null;
  return { ip: fwd, userAgent: req.headers.get('user-agent') };
}
