import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * A reservation ticket is the Risk Officer's signed permission for one transaction.
 * The signer refuses to sign any transaction that does not carry a valid, unexpired, unused ticket,
 * so the Trader cannot spend without a reservation even if it is compromised.
 */
export interface ReservationTicket {
  v: 1;
  reservationId: string;
  intent: 'buy' | 'sell' | 'withdraw';
  mint: string | null; // token mint for buy/sell, null for withdraw
  maxLamports: string; // decimal string: max SOL the transaction may move out of the wallet (excluding tip)
  maxTipLamports: string; // decimal string
  destination: string | null; // required for withdraw: must equal the allowlisted address
  issuedAt: number; // unix ms
  expiresAt: number; // unix ms
}

export interface SignedTicket {
  ticket: ReservationTicket;
  mac: string;
}

function canonical(t: ReservationTicket): string {
  // Fixed key order so both sides compute the same bytes.
  return JSON.stringify([
    t.v,
    t.reservationId,
    t.intent,
    t.mint,
    t.maxLamports,
    t.maxTipLamports,
    t.destination,
    t.issuedAt,
    t.expiresAt,
  ]);
}

export function signTicket(ticket: ReservationTicket, secret: string): SignedTicket {
  if (!secret || secret.length < 32) throw new Error('ticket secret must be at least 32 characters');
  const mac = createHmac('sha256', secret).update(canonical(ticket)).digest('hex');
  return { ticket, mac };
}

export type TicketCheck = { ok: true } | { ok: false; reason: string };

export function verifyTicket(signed: SignedTicket, secret: string, nowMs: number = Date.now()): TicketCheck {
  if (!secret || secret.length < 32) return { ok: false, reason: 'signer misconfigured: ticket secret too short' };
  const t = signed?.ticket;
  if (!t || t.v !== 1) return { ok: false, reason: 'unsupported ticket version' };
  if (typeof signed.mac !== 'string' || !/^[0-9a-f]{64}$/.test(signed.mac))
    return { ok: false, reason: 'malformed mac' };
  const expected = createHmac('sha256', secret).update(canonical(t)).digest();
  const given = Buffer.from(signed.mac, 'hex');
  if (given.length !== expected.length || !timingSafeEqual(given, expected))
    return { ok: false, reason: 'bad ticket signature' };
  if (!Number.isFinite(t.expiresAt) || nowMs > t.expiresAt) return { ok: false, reason: 'ticket expired' };
  if (!Number.isFinite(t.issuedAt) || t.issuedAt > nowMs + 5_000)
    return { ok: false, reason: 'ticket issued in the future' };
  if (!/^\d+$/.test(t.maxLamports) || !/^\d+$/.test(t.maxTipLamports))
    return { ok: false, reason: 'malformed amounts' };
  if (t.intent === 'withdraw' && !t.destination) return { ok: false, reason: 'withdraw ticket without destination' };
  return { ok: true };
}
