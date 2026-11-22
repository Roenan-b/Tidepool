'use client';
/**
 * Operations view: dense telemetry for the operator. Every section polls its own endpoint only while
 * it is selected and the tab is visible. Engine status polls continuously for the header and banners.
 */
import { useCallback, useEffect, useState } from 'react';
import type { AuditEventDto, CandidateDto, MetricsDto, PositionDto, StatusDto } from '@tidepool/core';
import {
  formatAge,
  formatDateTime,
  formatLamportsUsd,
  formatMs,
  formatPct,
  formatSol,
  formatTime,
  displayText,
  shortAddress,
  toLamports,
} from '../lib/format.js';
import { HALT_REASON_TEXT, STATE_TEXT, haltText, type SignalDto } from '../lib/labels.js';
import type { Theme } from '../lib/theme.js';
import { postJson, usePoll, useToast } from './client.js';
import { MenuBar, type MenuViewer } from './MenuBar.js';
import { Sheet } from './Sheet.js';
import { ModeBadge, WindowFrame } from './WindowFrame.js';

const SECTIONS = [
  { id: 'overview', label: 'Overview' },
  { id: 'signals', label: 'Signals' },
  { id: 'candidates', label: 'Candidates' },
  { id: 'positions', label: 'Positions' },
  { id: 'metrics', label: 'Metrics' },
  { id: 'log', label: 'Decision log' },
] as const;
type SectionId = (typeof SECTIONS)[number]['id'];

const POLL_MS = 3000;
const FRESH_WARN_S = 60;
const FRESH_STALE_S = 300;

function Status({ ok, okText, badText, unknownText = 'Unknown' }: { ok: boolean | null; okText: string; badText: string; unknownText?: string }) {
  const cls = ok === null ? 'unknown muted' : ok ? 'ok pos' : 'bad neg';
  return <span className={`status-word ${cls}`}>{ok === null ? unknownText : ok ? okText : badText}</span>;
}

function Pnl({ lamports, solUsd }: { lamports: string | null; solUsd: number | null }) {
  if (lamports === null) return <span className="muted">n/a</span>;
  const l = toLamports(lamports);
  const cls = l < 0n ? 'neg' : l > 0n ? 'pos' : '';
  const usd = formatLamportsUsd(l, solUsd, { signed: true });
  return (
    <span className={cls} title={usd ?? undefined}>
      {formatSol(l, 4, { signed: true, unit: false })}
      {usd ? <span className="subtle"> {usd}</span> : null}
    </span>
  );
}

function SectionError({ error }: { error: string | null }) {
  if (!error) return null;
  return (
    <div className="banner banner-warn" role="status">
      <span className="banner-icon" aria-hidden="true">!</span>
      <p>{error}</p>
    </div>
  );
}

function Updated({ at }: { at: number | null }) {
  return <span className="subtle">{at ? `Updated ${new Date(at).toLocaleTimeString()}` : 'Loading...'}</span>;
}

function Overview({ status, error, updatedAt, viewer, onCleared }: { status: StatusDto | null; error: string | null; updatedAt: number | null; viewer: MenuViewer; onCleared: () => void }) {
  const metrics = usePoll<MetricsDto>('/api/metrics', POLL_MS * 2);
  const [reason, setReason] = useState('');
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const { toast, show } = useToast();
  const canClear = !viewer.demo && viewer.role === 'operator' && status?.state === 'halted';
  const reasonOk = reason.trim().length >= 3 && reason.trim().length <= 500;

  const clear = async () => {
    setBusy(true);
    const r = await postJson('/api/control/clear-halt', { reason: reason.trim() });
    setBusy(false);
    setConfirmOpen(false);
    if (r.ok) {
      show('ok', 'Halt cleared. The engine may resume new entries.');
      setReason('');
      onCleared();
    } else show('error', r.message);
  };

  const m = metrics.data;
  return (
    <div className="stack">
      <div className="row-between">
        <h2>Overview</h2>
        <Updated at={updatedAt} />
      </div>
      <SectionError error={error} />
      {status ? (
        <>
          {status.state === 'halted' ? (
            <div className="banner banner-halt" role="alert">
              <span className="banner-icon" aria-hidden="true">!</span>
              <div>
                <h3>Halted: {status.haltReason ?? 'unknown reason'}</h3>
                <p>{haltText(status.haltReason)}</p>
              </div>
            </div>
          ) : null}
          <div className="grid-3">
            <div className="card metric-tile">
              <span className="card-title">Engine</span>
              <span className={`state-pill state-${status.state}`}><span className="dot" aria-hidden="true" />{STATE_TEXT[status.state]}</span>
              <span className="subtle">Preset {status.preset} &middot; live allowed: {status.liveTradingAllowed ? 'yes' : 'no'}</span>
            </div>
            <div className="card metric-tile">
              <span className="card-title">Mode</span>
              <ModeBadge mode={status.mode} />
              <span className="subtle">SOL/USD {status.solUsd ?? 'n/a'}</span>
            </div>
            <div className="card metric-tile">
              <span className="card-title">Equity</span>
              <span className="value">{formatSol(status.pool.equityLamports)}</span>
              <span className="subtle">{formatLamportsUsd(status.pool.equityLamports, status.solUsd) ?? 'USD n/a'}</span>
            </div>
            <div className="card metric-tile">
              <span className="card-title">Today net</span>
              <span className="value"><Pnl lamports={status.today.netPnlLamports} solUsd={status.solUsd} /></span>
              <span className="subtle">limit -{formatSol(status.today.lossLimitLamports)} &middot; {status.today.trades} trades, {status.today.wins} wins</span>
            </div>
            <div className="card metric-tile">
              <span className="card-title">Reconciliation</span>
              <Status ok={m?.reconciliation.ok ?? null} okText="Ledger matches chain" badText="Mismatch" />
              <span className="subtle">last run {formatTime(m?.reconciliation.lastRunAt ?? null)}</span>
            </div>
            <div className="card metric-tile">
              <span className="card-title">Audit chain</span>
              <Status ok={m?.auditChainValid ?? null} okText="Intact" badText="Broken" />
              <span className="subtle">RPC <Status ok={m ? m.rpc.healthy : null} okText="healthy" badText="failing" /></span>
            </div>
          </div>
          <section className="card" aria-labelledby="clear-title">
            <h3 id="clear-title" className="card-title">Clear halt</h3>
            {status.state !== 'halted' ? (
              <p className="muted">The engine is not halted.</p>
            ) : viewer.role !== 'operator' || viewer.demo ? (
              <p className="muted">{viewer.demo ? 'Disabled in demo mode.' : 'Only an operator can clear a halt.'}</p>
            ) : null}
            <form
              className="stack"
              onSubmit={(e) => {
                e.preventDefault();
                if (canClear && reasonOk) setConfirmOpen(true);
              }}
            >
              <div className="field">
                <label htmlFor="clear-reason">Reason (written to the audit log)</label>
                <textarea id="clear-reason" className="input" rows={2} value={reason} maxLength={500} onChange={(e) => setReason(e.target.value)} disabled={!canClear} />
                <p className="hint">3 to 500 characters. Describe what you checked and why trading is safe to resume.</p>
              </div>
              <div>
                <button type="submit" className="btn btn-primary" disabled={!canClear || !reasonOk || busy}>Clear halt...</button>
              </div>
            </form>
          </section>
        </>
      ) : null}
      <Sheet open={confirmOpen} onClose={() => setConfirmOpen(false)} title="Clear the halt?">
        <p>Halt reason: <strong>{status?.haltReason ?? 'unknown'}</strong>. {status?.haltReason ? HALT_REASON_TEXT[status.haltReason] : ''}</p>
        <p>Your reason: <em>{reason.trim()}</em></p>
        <div className="sheet-actions">
          <button type="button" className="btn" onClick={() => setConfirmOpen(false)}>Cancel</button>
          <button type="button" className="btn btn-danger" onClick={clear} disabled={busy}>Clear halt</button>
        </div>
      </Sheet>
      <div aria-live="polite" role="status">{toast ? <div className={`toast ${toast.kind === 'error' ? 'is-error' : 'is-ok'}`}>{toast.text}</div> : null}</div>
    </div>
  );
}

function Signals() {
  const p = usePoll<SignalDto[]>('/api/signals?limit=100', POLL_MS);
  return (
    <div className="stack">
      <div className="row-between"><h2>Signals</h2><Updated at={p.updatedAt} /></div>
      <p className="subtle">Social and trend signals only confirm or reject tokens already surfaced on chain; they never trigger a buy alone.</p>
      <SectionError error={p.error} />
      <div className="table-wrap">
        <table className="data">
          <caption className="sr-only">Latest collector signals, newest first</caption>
          <thead><tr><th>Time</th><th>Source</th><th>Kind</th><th>Token</th><th>Payload</th></tr></thead>
          <tbody>
            {(p.data ?? []).map((sig) => (
              <tr key={sig.id}>
                <td className="num">{formatTime(sig.observedAt)}</td>
                <td>{sig.source}</td>
                <td>{sig.kind}</td>
                <td className="mono" title={sig.mint ?? undefined}>{typeof sig.payload?.symbol === 'string' ? displayText(sig.payload.symbol, 24) : sig.mint ? shortAddress(sig.mint) : 'n/a'}</td>
                <td className="mono subtle">{displayText(JSON.stringify(sig.payload ?? {}), 140)}</td>
              </tr>
            ))}
            {p.data && p.data.length === 0 ? <tr><td colSpan={5} className="muted">No signals yet.</td></tr> : null}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function Candidates() {
  const p = usePoll<CandidateDto[]>('/api/candidates', POLL_MS);
  return (
    <div className="stack">
      <div className="row-between"><h2>Candidates</h2><Updated at={p.updatedAt} /></div>
      <SectionError error={p.error} />
      <div className="table-wrap">
        <table className="data">
          <caption className="sr-only">Ranked candidate tokens with scores, reasons and Risk Officer veto</caption>
          <thead>
            <tr><th>Token</th><th className="num">Score</th><th className="num">Liquidity</th><th className="num">Mentions/min</th><th className="num">Sentiment</th><th>Narrative</th><th>Reasons</th><th>Risk check</th><th>Expires</th></tr>
          </thead>
          <tbody>
            {(p.data ?? []).map((c) => (
              <tr key={c.mint}>
                <td><strong>{displayText(c.symbol, 24)}</strong><br /><span className="mono subtle" title={c.mint}>{shortAddress(c.mint)}</span></td>
                <td className="num">
                  <span className="score-bar" aria-hidden="true"><span style={{ width: `${Math.max(0, Math.min(100, c.score))}%` }} /></span>
                  {c.score.toFixed(1)}
                </td>
                <td className="num">${Math.round(c.liquidityUsd).toLocaleString()}</td>
                <td className="num">{c.mentionVelocity.toFixed(2)}</td>
                <td className={`num ${c.sentiment < 0 ? 'neg' : c.sentiment > 0 ? 'pos' : ''}`}>{c.sentiment.toFixed(2)}</td>
                <td>{c.narrativeLabel !== null ? displayText(c.narrativeLabel, 40) : <span className="muted">unscored</span>}</td>
                <td><ul className="reasons">{c.reasons.slice(0, 5).map((r, i) => <li key={i}>{displayText(r, 120)}</li>)}</ul></td>
                <td>{c.vetoReason ? <span className="status-word bad neg">Vetoed: {displayText(c.vetoReason, 120)}</span> : <span className="status-word ok pos">Eligible</span>}</td>
                <td className="num">{formatTime(c.expiresAt)}</td>
              </tr>
            ))}
            {p.data && p.data.length === 0 ? <tr><td colSpan={9} className="muted">No candidates right now.</td></tr> : null}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function Positions({ solUsd }: { solUsd: number | null }) {
  const p = usePoll<PositionDto[]>('/api/positions?status=all&limit=200', POLL_MS);
  const open = (p.data ?? []).filter((x) => x.status !== 'closed');
  const closed = (p.data ?? []).filter((x) => x.status === 'closed');
  return (
    <div className="stack">
      <div className="row-between"><h2>Positions</h2><Updated at={p.updatedAt} /></div>
      <SectionError error={p.error} />
      <h3 className="card-title">Open ({open.length})</h3>
      <div className="table-wrap">
        <table className="data">
          <caption className="sr-only">Open positions</caption>
          <thead><tr><th>Token</th><th>Status</th><th>Strategy</th><th className="num">Entry (SOL)</th><th className="num">Mark (SOL)</th><th className="num">Unrealized</th><th>Opened</th></tr></thead>
          <tbody>
            {open.map((x) => (
              <tr key={x.id}>
                <td><strong>{displayText(x.symbol, 24)}</strong> <span className="mono subtle" title={x.mint}>{shortAddress(x.mint)}</span></td>
                <td>{x.status}{x.mode === 'live' ? ' (live)' : ''}</td>
                <td>{x.strategy}</td>
                <td className="num">{formatSol(x.entryLamports, 4, { unit: false })}</td>
                <td className="num">{x.markLamports ? formatSol(x.markLamports, 4, { unit: false }) : 'n/a'}</td>
                <td className="num"><Pnl lamports={x.unrealizedPnlLamports} solUsd={solUsd} /></td>
                <td className="num">{formatTime(x.openedAt)}</td>
              </tr>
            ))}
            {open.length === 0 ? <tr><td colSpan={7} className="muted">No open positions.</td></tr> : null}
          </tbody>
        </table>
      </div>
      <h3 className="card-title">Closed ({closed.length})</h3>
      <div className="table-wrap">
        <table className="data">
          <caption className="sr-only">Closed positions</caption>
          <thead><tr><th>Token</th><th>Exit reason</th><th className="num">Entry (SOL)</th><th className="num">Realized</th><th>Opened</th><th>Closed</th></tr></thead>
          <tbody>
            {closed.map((x) => (
              <tr key={x.id}>
                <td><strong>{displayText(x.symbol, 24)}</strong> <span className="mono subtle" title={x.mint}>{shortAddress(x.mint)}</span></td>
                <td>{x.exitReason !== null ? displayText(x.exitReason, 80) : 'n/a'}</td>
                <td className="num">{formatSol(x.entryLamports, 4, { unit: false })}</td>
                <td className="num"><Pnl lamports={x.realizedPnlLamports} solUsd={solUsd} /></td>
                <td className="num">{formatDateTime(x.openedAt)}</td>
                <td className="num">{formatDateTime(x.closedAt)}</td>
              </tr>
            ))}
            {closed.length === 0 ? <tr><td colSpan={6} className="muted">No closed positions.</td></tr> : null}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function Metrics() {
  const p = usePoll<MetricsDto>('/api/metrics', POLL_MS);
  const m = p.data;
  return (
    <div className="stack">
      <div className="row-between"><h2>Metrics</h2><Updated at={p.updatedAt} /></div>
      <SectionError error={p.error} />
      {m ? (
        <>
          <div className="grid-3">
            <div className="card metric-tile"><span className="card-title">Signal to submit p50</span><span className="value">{formatMs(m.latencyMs.signalToSubmit.p50)}</span></div>
            <div className="card metric-tile"><span className="card-title">p95</span><span className="value">{formatMs(m.latencyMs.signalToSubmit.p95)}</span></div>
            <div className="card metric-tile"><span className="card-title">p99</span><span className="value">{formatMs(m.latencyMs.signalToSubmit.p99)}</span></div>
            <div className="card metric-tile"><span className="card-title">Landing rate (1h)</span><span className="value">{formatPct(m.landingRate)}</span></div>
            <div className="card metric-tile">
              <span className="card-title">RPC</span>
              <Status ok={m.rpc.healthy} okText="Healthy" badText="Failing" />
              <span className="subtle">error rate {formatPct(m.rpc.errorRate, 2)} &middot; last ok {formatTime(m.rpc.lastOkAt)}</span>
            </div>
            <div className="card metric-tile"><span className="card-title">Trades (24h)</span><span className="value">{m.tradesLast24h}</span></div>
          </div>
          <div className="grid-2">
            <section className="card">
              <h3 className="card-title">Data freshness</h3>
              <div className="table-wrap">
                <table className="data">
                  <caption className="sr-only">Seconds since each collector last produced data</caption>
                  <thead><tr><th>Source</th><th className="num">Age</th><th>State</th></tr></thead>
                  <tbody>
                    {Object.entries(m.dataFreshnessSeconds).map(([src, age]) => {
                      const state = age === null ? null : age < FRESH_WARN_S ? 'fresh' : age < FRESH_STALE_S ? 'lagging' : 'stale';
                      return (
                        <tr key={src}>
                          <td>{src}</td>
                          <td className="num">{formatAge(age)}</td>
                          <td>
                            {state === null ? <span className="status-word unknown muted">No data</span> : state === 'fresh' ? <span className="status-word ok pos">Fresh</span> : state === 'lagging' ? <span className="status-word bad warn">Lagging</span> : <span className="status-word bad neg">Stale</span>}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </section>
            <section className="card">
              <h3 className="card-title">Integrity</h3>
              <dl className="kv">
                <dt>Reconciliation</dt>
                <dd><Status ok={m.reconciliation.ok} okText="Match" badText="Mismatch" /></dd>
                <dt>Last run</dt>
                <dd>{formatTime(m.reconciliation.lastRunAt)}</dd>
                <dt>Difference</dt>
                <dd>{m.reconciliation.diffLamports !== null ? `${m.reconciliation.diffLamports} lamports` : 'n/a'}</dd>
                <dt>Audit hash chain</dt>
                <dd><Status ok={m.auditChainValid} okText="Intact" badText="Broken" /></dd>
              </dl>
            </section>
          </div>
        </>
      ) : null}
    </div>
  );
}

const LOG_PAGE = 50;

function DecisionLog() {
  // Stack of page cursors: undefined = newest page; otherwise the beforeSeq used for that page.
  const [cursors, setCursors] = useState<Array<number | undefined>>([undefined]);
  const cursor = cursors[cursors.length - 1];
  const url = `/api/events?limit=${LOG_PAGE}${cursor ? `&beforeSeq=${cursor}` : ''}`;
  // Only the newest page refreshes itself; older pages are immutable history.
  const p = usePoll<AuditEventDto[]>(url, cursor ? 3_600_000 : POLL_MS * 2);
  const [expanded, setExpanded] = useState<Set<number>>(new Set());
  const events = p.data ?? [];
  const oldest = events.length > 0 ? events[events.length - 1]!.seq : null;

  const toggle = useCallback((seq: number) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(seq)) next.delete(seq);
      else next.add(seq);
      return next;
    });
  }, []);

  return (
    <div className="stack">
      <div className="row-between">
        <h2>Decision log</h2>
        <div className="row">
          <Updated at={p.updatedAt} />
          <button type="button" className="btn btn-small" disabled={cursors.length <= 1} onClick={() => setCursors((c) => c.slice(0, -1))}>Newer</button>
          <button type="button" className="btn btn-small" disabled={oldest === null || oldest <= 1 || events.length < LOG_PAGE} onClick={() => oldest && setCursors((c) => [...c, oldest])}>Older</button>
        </div>
      </div>
      <SectionError error={p.error} />
      <div className="table-wrap">
        <table className="data">
          <caption className="sr-only">Append-only audit events, newest first</caption>
          <thead><tr><th className="num">Seq</th><th>Time</th><th>Actor</th><th>Type</th><th>Ref</th><th>Hash</th><th>Payload</th></tr></thead>
          <tbody>
            {events.map((e) => {
              const open = expanded.has(e.seq);
              return (
                <tr key={e.seq}>
                  <td className="num">{e.seq}</td>
                  <td className="num">{formatDateTime(e.at)}</td>
                  <td>{e.actor}</td>
                  <td className="mono">{e.type}</td>
                  <td className="mono subtle">{e.ref ? shortAddress(e.ref, 6) : ''}</td>
                  <td className="mono subtle" title={e.hash}>{e.hash.slice(0, 10)}</td>
                  <td>
                    <button type="button" className="log-toggle" aria-expanded={open} aria-controls={`payload-${e.seq}`} onClick={() => toggle(e.seq)}>
                      {open ? 'Hide' : 'Show'} payload
                    </button>
                    {open ? <pre id={`payload-${e.seq}`} className="json">{JSON.stringify(e.payload, null, 2)}</pre> : null}
                  </td>
                </tr>
              );
            })}
            {p.data && events.length === 0 ? <tr><td colSpan={7} className="muted">No events.</td></tr> : null}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function sectionFromHash(): SectionId {
  const h = typeof window === 'undefined' ? '' : window.location.hash.slice(1);
  return (SECTIONS.find((s) => s.id === h)?.id ?? 'overview') as SectionId;
}

export function OpsConsole(props: { viewer: MenuViewer; theme: Theme; initialStatus: StatusDto | null; initialError: string | null }) {
  const status = usePoll<StatusDto>('/api/status', POLL_MS, props.initialStatus);
  const [section, setSection] = useState<SectionId>('overview');

  useEffect(() => {
    setSection(sectionFromHash());
    const onHash = () => setSection(sectionFromHash());
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);

  const choose = (id: SectionId) => {
    setSection(id);
    window.history.replaceState(null, '', `#${id}`);
    document.getElementById('ops-main')?.focus();
  };

  const s = status.data;
  const forceDark = props.theme !== 'light';
  return (
    <div className={`desktop${forceDark ? ' scheme-dark' : ''}`}>
      <MenuBar viewer={props.viewer} active="ops" mode={s?.mode ?? null} showMode theme={props.theme} />
      <main id="main">
        <WindowFrame
          size="wide"
          bodyClassName="ops-shell"
          title={<><strong>Operations</strong> &middot; {s ? `${STATE_TEXT[s.state]}${s.haltReason ? ` (${s.haltReason})` : ''}` : 'status unknown'}</>}
          tools={<ModeBadge mode={s?.mode ?? null} />}
        >
          <nav className="sidebar" aria-label="Operations sections">
            <h2>Telemetry</h2>
            <ul>
              {SECTIONS.map((sec) => (
                <li key={sec.id}>
                  <button type="button" aria-current={section === sec.id ? 'true' : undefined} onClick={() => choose(sec.id)}>
                    {sec.label}
                    {sec.id === 'overview' && s?.state === 'halted' ? <span className="count" aria-label="halted">halted</span> : null}
                  </button>
                </li>
              ))}
            </ul>
          </nav>
          <div id="ops-main" className="ops-main" tabIndex={-1}>
            {props.viewer.demo ? <p className="subtle" style={{ marginBottom: 8 }}>Demo mode: sample data, actions disabled.</p> : null}
            {section === 'overview' ? (
              <Overview status={s} error={status.error ?? (s ? null : props.initialError)} updatedAt={status.updatedAt} viewer={props.viewer} onCleared={status.refresh} />
            ) : section === 'signals' ? (
              <Signals />
            ) : section === 'candidates' ? (
              <Candidates />
            ) : section === 'positions' ? (
              <Positions solUsd={s?.solUsd ?? null} />
            ) : section === 'metrics' ? (
              <Metrics />
            ) : (
              <DecisionLog />
            )}
          </div>
        </WindowFrame>
      </main>
    </div>
  );
}
