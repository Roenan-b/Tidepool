/**
 * Client for the signer process (apps/signer). The signer holds the only copy of the hot-wallet key and signs
 * a transaction only when it carries a valid, unused Risk Officer ticket and passes its own policy.
 */
import { z } from 'zod';
import type { SignedTicket } from '@tidepool/core/ticket';

export interface SignRequest {
  ticket: SignedTicket;
  transactionBase64: string;
}
export interface SignResponse {
  signedTransactionBase64: string;
  signature: string;
  /** Policy accounting reported by the signer (decimal lamports), when present. */
  spendLamports?: bigint;
  tipLamports?: bigint;
  priorityFeeLamports?: bigint;
  dailySpentLamports?: bigint;
}

export interface SignerClient {
  sign(req: SignRequest): Promise<SignResponse>;
}

export type SignerErrorKind = 'refused' | 'ticket_reused' | 'timeout' | 'network' | 'invalid_response';
export class SignerError extends Error {
  constructor(
    readonly kind: SignerErrorKind,
    message: string,
    readonly status?: number,
    readonly reasons: string[] = [],
  ) {
    super(message);
    this.name = 'SignerError';
  }
}

const Lamports = z
  .union([z.string().regex(/^\d{1,20}$/), z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)])
  .transform((v) => BigInt(v));
const SignResponseSchema = z.object({
  signedTransactionBase64: z
    .string()
    .min(1)
    .max(4_000)
    .regex(/^[A-Za-z0-9+/]*={0,2}$/),
  signature: z.string().regex(/^[1-9A-HJ-NP-Za-km-z]{64,90}$/),
  spendLamports: Lamports.optional(),
  tipLamports: Lamports.optional(),
  priorityFeeLamports: Lamports.optional(),
  dailySpentLamports: Lamports.optional(),
});

export interface HttpSignerClientOptions {
  /** SIGNER_URL. Plain http is accepted only for loopback addresses. */
  url: string;
  /** SIGNER_API_TOKEN. Never logged or included in errors. */
  token: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
}

export class HttpSignerClient implements SignerClient {
  private readonly endpoint: string;
  private readonly fetchFn: typeof fetch;
  private readonly timeoutMs: number;

  constructor(private readonly opts: HttpSignerClientOptions) {
    let u: URL;
    try {
      u = new URL(opts.url);
    } catch {
      throw new Error('SIGNER_URL is not a valid URL');
    }
    const loopback = u.hostname === '127.0.0.1' || u.hostname === 'localhost' || u.hostname === '[::1]';
    if (u.protocol !== 'https:' && !(u.protocol === 'http:' && loopback))
      throw new Error('SIGNER_URL must be https or a loopback http address');
    if (!opts.token || opts.token.length < 32) throw new Error('SIGNER_API_TOKEN must be at least 32 characters');
    this.endpoint = `${opts.url.replace(/\/+$/, '')}/sign`;
    this.fetchFn = opts.fetch ?? fetch;
    this.timeoutMs = opts.timeoutMs ?? 5_000;
  }

  async sign(req: SignRequest): Promise<SignResponse> {
    let res: Response;
    try {
      res = await this.fetchFn(this.endpoint, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${this.opts.token}`,
          'content-type': 'application/json',
          accept: 'application/json',
        },
        body: JSON.stringify({ ticket: req.ticket, transactionBase64: req.transactionBase64 }),
        signal: AbortSignal.timeout(this.timeoutMs),
        redirect: 'error',
      });
    } catch (err) {
      const name = err instanceof Error ? err.name : '';
      if (name === 'TimeoutError' || name === 'AbortError')
        throw new SignerError('timeout', `signer timed out after ${this.timeoutMs} ms`);
      throw new SignerError('network', 'signer unreachable');
    }
    const text = await res.text().catch(() => '');
    if (text.length > 64_000) throw new SignerError('invalid_response', 'signer response too large', res.status);
    let body: unknown = null;
    try {
      body = text ? JSON.parse(text) : null;
    } catch {
      /* handled below */
    }
    if (!res.ok) {
      const b = body && typeof body === 'object' ? (body as { error?: unknown; reasons?: unknown }) : {};
      // eslint-disable-next-line @typescript-eslint/no-base-to-string -- error field from an untrusted response body
      const reason = b.error !== undefined ? String(b.error).slice(0, 200) : '';
      const reasons = Array.isArray(b.reasons) ? b.reasons.slice(0, 10).map((r) => String(r).slice(0, 200)) : [];
      const detail = [reason, ...reasons].filter(Boolean).join('; ');
      // 409: the ticket was already used. 403: policy denial (reasons lists each failed rule).
      const kind: SignerErrorKind = res.status === 409 ? 'ticket_reused' : 'refused';
      throw new SignerError(
        kind,
        `signer refused (HTTP ${res.status})${detail ? `: ${detail}` : ''}`,
        res.status,
        reasons,
      );
    }
    const parsed = SignResponseSchema.safeParse(body);
    if (!parsed.success) throw new SignerError('invalid_response', 'signer response failed validation', res.status);
    const d = parsed.data;
    const out: SignResponse = { signedTransactionBase64: d.signedTransactionBase64, signature: d.signature };
    if (d.spendLamports !== undefined) out.spendLamports = d.spendLamports;
    if (d.tipLamports !== undefined) out.tipLamports = d.tipLamports;
    if (d.priorityFeeLamports !== undefined) out.priorityFeeLamports = d.priorityFeeLamports;
    if (d.dailySpentLamports !== undefined) out.dailySpentLamports = d.dailySpentLamports;
    return out;
  }
}
