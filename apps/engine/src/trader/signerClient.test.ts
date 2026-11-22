import { describe, expect, it } from 'vitest';
import { HttpSignerClient, SignerError } from './signerClient.js';
import { makeTicket, MINT_A } from './testkit.js';

const TOKEN = 't'.repeat(64);
const ticket = makeTicket('buy', MINT_A, 1n, Date.now() + 60_000);
const SIG = '5'.repeat(88);

function fake(res: () => Response) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fn = (async (url: string, init: RequestInit) => { calls.push({ url, init }); return res(); }) as unknown as typeof fetch;
  return { fn, calls };
}

describe('HttpSignerClient', () => {
  it('validates configuration', () => {
    expect(() => new HttpSignerClient({ url: 'http://10.0.0.5:7071', token: TOKEN })).toThrow(/https or a loopback/);
    expect(() => new HttpSignerClient({ url: 'http://127.0.0.1:7071', token: 'short' })).toThrow(/32/);
    expect(() => new HttpSignerClient({ url: 'http://127.0.0.1:7071', token: TOKEN })).not.toThrow();
  });

  it('posts ticket and transaction with the bearer token and validates the response', async () => {
    const f = fake(() => new Response(JSON.stringify({ signedTransactionBase64: 'AQID', signature: SIG }), { status: 200 }));
    const c = new HttpSignerClient({ url: 'http://127.0.0.1:7071/', token: TOKEN, fetch: f.fn });
    expect(await c.sign({ ticket, transactionBase64: 'AQID' })).toEqual({ signedTransactionBase64: 'AQID', signature: SIG });
    expect(f.calls[0]!.url).toBe('http://127.0.0.1:7071/sign');
    expect((f.calls[0]!.init.headers as Record<string, string>).authorization).toBe(`Bearer ${TOKEN}`);
    expect(JSON.parse(String(f.calls[0]!.init.body))).toEqual({ ticket, transactionBase64: 'AQID' });
  });

  it('parses the signer accounting fields', async () => {
    const f = fake(() => new Response(JSON.stringify({ signedTransactionBase64: 'AQID', signature: SIG, spendLamports: '499495000', tipLamports: '500000', priorityFeeLamports: 1000, dailySpentLamports: '1000000000' }), { status: 200 }));
    const r = await new HttpSignerClient({ url: 'http://127.0.0.1:7071', token: TOKEN, fetch: f.fn }).sign({ ticket, transactionBase64: 'AQID' });
    expect(r).toEqual({ signedTransactionBase64: 'AQID', signature: SIG, spendLamports: 499_495_000n, tipLamports: 500_000n, priorityFeeLamports: 1_000n, dailySpentLamports: 1_000_000_000n });
  });

  it('maps a 403 policy denial with reasons and a 409 reused ticket', async () => {
    const d = fake(() => new Response(JSON.stringify({ error: 'policy denied', reasons: ['program not allowed', 'tip account not allowed'] }), { status: 403 }));
    const e1 = await new HttpSignerClient({ url: 'http://127.0.0.1:7071', token: TOKEN, fetch: d.fn }).sign({ ticket, transactionBase64: 'AQID' }).catch((e: unknown) => e as SignerError);
    expect(e1).toMatchObject({ kind: 'refused', status: 403, reasons: ['program not allowed', 'tip account not allowed'] });
    const u = fake(() => new Response(JSON.stringify({ error: 'ticket already used' }), { status: 409 }));
    await expect(new HttpSignerClient({ url: 'http://127.0.0.1:7071', token: TOKEN, fetch: u.fn }).sign({ ticket, transactionBase64: 'AQID' })).rejects.toMatchObject({ kind: 'ticket_reused', status: 409 });
  });

  it('maps refusals without echoing the token', async () => {
    const f = fake(() => new Response(JSON.stringify({ error: 'ticket expired' }), { status: 403 }));
    const err = await new HttpSignerClient({ url: 'http://127.0.0.1:7071', token: TOKEN, fetch: f.fn }).sign({ ticket, transactionBase64: 'AQID' }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SignerError);
    expect((err as SignerError).kind).toBe('refused');
    expect((err as Error).message).toContain('ticket expired');
    expect((err as Error).message).not.toContain(TOKEN);
  });

  it('rejects malformed success bodies', async () => {
    const f = fake(() => new Response(JSON.stringify({ signedTransactionBase64: 'AQID', signature: 'not-base58!' }), { status: 200 }));
    await expect(new HttpSignerClient({ url: 'http://127.0.0.1:7071', token: TOKEN, fetch: f.fn }).sign({ ticket, transactionBase64: 'AQID' })).rejects.toMatchObject({ kind: 'invalid_response' });
  });
});
