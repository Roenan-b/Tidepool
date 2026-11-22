import { describe, expect, it } from 'vitest';
import { LIVE_MODE_CONFIRMATION } from '@tidepool/core';
import { authorize } from './auth/guard.js';
import { PROXY_ROUTES, prepareProxy } from './proxy.js';

const owner = { role: 'owner' as const, demo: false };
const operator = { role: 'operator' as const, demo: false };
const ADDRESS = '9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin';

describe('proxy route table', () => {
  it('maps to the documented engine endpoints', () => {
    expect(Object.fromEntries(Object.entries(PROXY_ROUTES).map(([k, v]) => [k, `${v.method} ${v.enginePath}`]))).toEqual({
      status: 'GET /status',
      positions: 'GET /positions',
      candidates: 'GET /candidates',
      events: 'GET /events',
      metrics: 'GET /metrics',
      signals: 'GET /signals',
      start: 'POST /control/start',
      pause: 'POST /control/pause',
      kill: 'POST /control/kill',
      mode: 'POST /control/mode',
      clearHalt: 'POST /control/clear-halt',
      withdrawAddress: 'POST /wallet/withdraw-address',
      withdraw: 'POST /wallet/withdraw',
    });
  });

  it('applies role rules: owner-only money routes, operator-only ops routes', () => {
    const v = (role: 'owner' | 'operator') => ({ userId: 'u', username: 'x', role, totpEnabled: true, demo: false });
    expect(authorize(v('operator'), PROXY_ROUTES.withdraw).ok).toBe(false);
    expect(authorize(v('operator'), PROXY_ROUTES.withdrawAddress).ok).toBe(false);
    expect(authorize(v('owner'), PROXY_ROUTES.withdraw).ok).toBe(true);
    expect(authorize(v('owner'), PROXY_ROUTES.clearHalt).ok).toBe(false);
    expect(authorize(v('operator'), PROXY_ROUTES.clearHalt).ok).toBe(true);
    for (const k of ['candidates', 'events', 'metrics', 'signals'] as const) {
      expect(authorize(v('owner'), PROXY_ROUTES[k]).ok).toBe(false);
      expect(authorize(v('operator'), PROXY_ROUTES[k]).ok).toBe(true);
    }
    for (const k of ['status', 'start', 'pause', 'kill', 'mode'] as const) {
      expect(authorize(v('owner'), PROXY_ROUTES[k]).ok).toBe(true);
      expect(authorize(v('operator'), PROXY_ROUTES[k]).ok).toBe(true);
    }
  });
});

describe('prepareProxy bodies', () => {
  it('validates start presets', () => {
    expect(prepareProxy('start', owner, { body: { preset: 'balanced' } })).toMatchObject({ ok: true, body: { preset: 'balanced' } });
    expect(prepareProxy('start', owner, { body: { preset: 'yolo' } })).toMatchObject({ ok: false, status: 400 });
    expect(prepareProxy('start', owner, { body: { preset: 'balanced', extra: 1 } })).toMatchObject({ ok: false, status: 400 });
  });

  it('requires SELL_ALL for the kill switch', () => {
    expect(prepareProxy('kill', owner, { body: { confirm: 'SELL_ALL' } }).ok).toBe(true);
    expect(prepareProxy('kill', owner, { body: { confirm: 'sell_all' } }).ok).toBe(false);
    expect(prepareProxy('kill', owner, { body: {} }).ok).toBe(false);
  });

  it('pause takes an empty body only', () => {
    expect(prepareProxy('pause', operator, { body: {} }).ok).toBe(true);
    expect(prepareProxy('pause', operator, { body: { x: 1 } }).ok).toBe(false);
  });

  it('live mode is owner-only and needs the exact confirmation', () => {
    expect(prepareProxy('mode', owner, { body: { mode: 'live', confirm: LIVE_MODE_CONFIRMATION } })).toMatchObject({
      ok: true,
      body: { mode: 'live', confirm: LIVE_MODE_CONFIRMATION },
    });
    expect(prepareProxy('mode', owner, { body: { mode: 'live', confirm: LIVE_MODE_CONFIRMATION.toLowerCase() } })).toMatchObject({ ok: false, error: 'confirmation_mismatch' });
    expect(prepareProxy('mode', owner, { body: { mode: 'live' } })).toMatchObject({ ok: false, status: 400 });
    expect(prepareProxy('mode', operator, { body: { mode: 'live', confirm: LIVE_MODE_CONFIRMATION } })).toMatchObject({ ok: false, status: 403 });
  });

  it('paper mode is allowed for both roles and drops any confirm text', () => {
    expect(prepareProxy('mode', operator, { body: { mode: 'paper', confirm: 'anything' } })).toMatchObject({ ok: true, body: { mode: 'paper' } });
  });

  it('validates clear-halt reasons', () => {
    expect(prepareProxy('clearHalt', operator, { body: { reason: 'checked RPC, recovered' } }).ok).toBe(true);
    expect(prepareProxy('clearHalt', operator, { body: { reason: 'no' } }).ok).toBe(false);
    expect(prepareProxy('clearHalt', operator, { body: { reason: 'x'.repeat(501) } }).ok).toBe(false);
  });

  it('validates withdrawal addresses and amounts', () => {
    expect(prepareProxy('withdrawAddress', owner, { body: { address: ADDRESS } }).ok).toBe(true);
    expect(prepareProxy('withdrawAddress', owner, { body: { address: '0OIl' + ADDRESS.slice(4) } }).ok).toBe(false);
    expect(prepareProxy('withdraw', owner, { body: { lamports: '1500000000' } }).ok).toBe(true);
    expect(prepareProxy('withdraw', owner, { body: { lamports: '0' } }).ok).toBe(false);
    expect(prepareProxy('withdraw', owner, { body: { lamports: '-5' } }).ok).toBe(false);
    expect(prepareProxy('withdraw', owner, { body: { lamports: '1.5' } }).ok).toBe(false);
    expect(prepareProxy('withdraw', owner, { body: { lamports: 1500000000 } }).ok).toBe(false);
    expect(prepareProxy('withdraw', owner, { body: { lamports: '1'.repeat(21) } }).ok).toBe(false);
    // 20 digits fit the pattern but exceed u64::MAX.
    expect(prepareProxy('withdraw', owner, { body: { lamports: '18446744073709551615' } }).ok).toBe(true);
    expect(prepareProxy('withdraw', owner, { body: { lamports: '18446744073709551616' } }).ok).toBe(false);
    expect(prepareProxy('withdraw', owner, { body: { lamports: '99999999999999999999' } }).ok).toBe(false);
    expect(prepareProxy('withdraw', owner, { body: { lamports: '100', address: ADDRESS } }).ok).toBe(false);
  });
});

describe('prepareProxy queries', () => {
  it('passes only known, valid query parameters', () => {
    const r = prepareProxy('events', operator, { search: new URLSearchParams('limit=50&beforeSeq=120') });
    expect(r.ok && r.query.toString()).toBe('limit=50&beforeSeq=120');
    expect(prepareProxy('events', operator, { search: new URLSearchParams('limit=5000') }).ok).toBe(false);
    expect(prepareProxy('events', operator, { search: new URLSearchParams('evil=1') }).ok).toBe(false);
    expect(prepareProxy('positions', owner, { search: new URLSearchParams('status=open') }).ok).toBe(true);
    expect(prepareProxy('positions', owner, { search: new URLSearchParams('status=../../x') }).ok).toBe(false);
    expect(prepareProxy('signals', operator, { search: new URLSearchParams('source=x&limit=10') }).ok).toBe(true);
    expect(prepareProxy('status', owner, { search: new URLSearchParams() })).toMatchObject({ ok: true, method: 'GET', enginePath: '/status' });
  });
});
