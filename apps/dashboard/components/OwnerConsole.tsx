'use client';
/**
 * Jake's home view: one big Start/Pause control, preset choice, pool and today cards, deposit and
 * withdraw sheets, live-mode switch and the "Stop and sell everything" kill switch.
 */
import { useEffect, useMemo, useState, type SubmitEvent } from 'react';
import type { PresetName, StatusDto } from '@tidepool/core';
import {
  formatDateTime,
  formatLamportsUsd,
  formatSol,
  formatUsdCents,
  formatUsdWhole,
  lamportsToUsdCents,
  parseSolInput,
  shortAddress,
  toLamports,
} from '../lib/format.js';
import { STATE_TEXT, haltText, type PresetSummary } from '../lib/labels.js';
import type { Theme } from '../lib/theme.js';
import { postJson, usePoll, useToast } from './client.js';
import { MenuBar, type MenuViewer } from './MenuBar.js';
import { Segmented } from './Segmented.js';
import { Sheet } from './Sheet.js';
import { ModeBadge, WindowFrame } from './WindowFrame.js';

/** Mirrors Base58Address in packages/core/src/api.ts; the server re-validates with the core schema. */
const BASE58_ADDRESS = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const KILL_WORD = 'SELL_ALL';

type SheetName = 'kill' | 'deposit' | 'withdraw' | 'address' | 'live' | 'paper' | null;

function Amount({ lamports, solUsd, signed }: { lamports: string; solUsd: number | null; signed?: boolean }) {
  const usd = formatLamportsUsd(lamports, solUsd, { signed });
  return (
    <>
      {usd ?? formatSol(lamports, 4, { signed })}
      {usd ? <small>{formatSol(lamports, 4, { signed })}</small> : null}
    </>
  );
}

function PoolCard({ s }: { s: StatusDto }) {
  const usd = formatLamportsUsd(s.pool.equityLamports, s.solUsd);
  return (
    <section className="card" aria-labelledby="pool-title">
      <div className="card-head">
        <h2 id="pool-title" className="card-title">
          Pool
        </h2>
        <span className="subtle">
          {s.solUsd !== null ? `SOL ${formatUsdCents(BigInt(Math.round(s.solUsd * 100)))}` : 'USD price unavailable'}
        </span>
      </div>
      <div className="big-number" aria-label="Pool value">
        {usd ?? formatSol(s.pool.equityLamports)}
      </div>
      {usd ? <div className="muted num">{formatSol(s.pool.equityLamports)}</div> : null}
      <dl className="kv">
        <dt>Cash available</dt>
        <dd>
          <Amount lamports={s.pool.cashLamports} solUsd={s.solUsd} />
        </dd>
        <dt>In open positions</dt>
        <dd>
          <Amount lamports={s.pool.inPositionsLamports} solUsd={s.solUsd} />
        </dd>
        <dt>Held for pending trades</dt>
        <dd>
          <Amount lamports={s.pool.reservedLamports} solUsd={s.solUsd} />
        </dd>
        <dt>Fee reserve (never traded)</dt>
        <dd>
          <Amount lamports={s.pool.feeReserveLamports} solUsd={s.solUsd} />
        </dd>
      </dl>
    </section>
  );
}

function TodayCard({ s }: { s: StatusDto }) {
  const net = toLamports(s.today.netPnlLamports);
  const limit = toLamports(s.today.lossLimitLamports);
  const netCents = lamportsToUsdCents(net, s.solUsd);
  const limitCents = lamportsToUsdCents(limit, s.solUsd);
  const haveUsd = netCents !== null && limitCents !== null;
  const stretchCents = haveUsd ? BigInt(Math.round(s.today.stretchTargetUsd * 100)) : null;

  // Display geometry only (not ledger math): numbers are fine here.
  const limitN = Number(haveUsd ? limitCents : limit);
  const netN = Number(haveUsd ? netCents : net);
  const stretchN = stretchCents !== null ? Number(stretchCents) : 0;
  const span = limitN + stretchN || 1;
  const zeroPct = (limitN / span) * 100;
  const lossPct = netN < 0 && limitN > 0 ? Math.min(1, -netN / limitN) * zeroPct : 0;
  const gainPct = netN > 0 && stretchN > 0 ? Math.min(1, netN / stretchN) * (100 - zeroPct) : 0;
  const usedPct = limitN > 0 && netN < 0 ? Math.round((-netN / limitN) * 100) : 0;

  const netText = haveUsd ? formatUsdCents(netCents, { signed: true }) : formatSol(net, 4, { signed: true });
  const limitText = haveUsd ? `-${formatUsdCents(limitCents)}` : `-${formatSol(limit)}`;
  const summary = net < 0n ? `${netText} of ${limitText} limit` : `${netText} today, loss limit ${limitText}`;

  return (
    <section className="card" aria-labelledby="today-title">
      <div className="card-head">
        <h2 id="today-title" className="card-title">
          Today
        </h2>
        <span className="subtle">{s.today.date} UTC, after all fees</span>
      </div>
      <div className={`big-number ${net < 0n ? 'neg' : net > 0n ? 'pos' : ''}`}>{netText}</div>
      <p className="muted">{summary}</p>
      <div
        className="meter"
        role="meter"
        aria-label="Today's result against the daily loss limit"
        aria-valuemin={-limitN}
        aria-valuemax={stretchN || 0}
        aria-valuenow={Math.max(-limitN, netN)}
        aria-valuetext={`${summary}${net < 0n ? `, ${usedPct}% of the limit used` : ''}`}
      >
        <span className="meter-label top" style={{ left: 0 }}>
          {limitText} limit
        </span>
        {lossPct > 0 ? (
          <span className="meter-fill meter-loss" style={{ left: `${zeroPct - lossPct}%`, width: `${lossPct}%` }} />
        ) : null}
        {gainPct > 0 ? (
          <span className="meter-fill meter-gain" style={{ left: `${zeroPct}%`, width: `${gainPct}%` }} />
        ) : null}
        <span className="meter-zero" style={{ left: `calc(${zeroPct}% - 1px)` }} aria-hidden="true" />
        <span className="meter-label bottom" style={{ left: `${zeroPct}%`, transform: 'translateX(-50%)' }}>
          $0
        </span>
        {stretchCents !== null ? (
          <>
            <span className="meter-ref" style={{ right: 0 }} aria-hidden="true" />
            <span className="meter-label top" style={{ right: 0 }}>
              {formatUsdWhole(s.today.stretchTargetUsd)} reference
            </span>
          </>
        ) : null}
      </div>
      <dl className="kv">
        <dt>Trades today</dt>
        <dd>{s.today.trades}</dd>
        <dt>Winning trades</dt>
        <dd>{s.today.trades > 0 ? `${s.today.wins} (${Math.round((s.today.wins / s.today.trades) * 100)}%)` : '0'}</dd>
      </dl>
      <p className="subtle" style={{ marginTop: 10 }}>
        The dashed line is a reference only. The bot never takes extra risk to reach it; it stops for the day at the
        loss limit.
      </p>
    </section>
  );
}

export function OwnerConsole(props: {
  viewer: MenuViewer;
  theme: Theme;
  initialStatus: StatusDto | null;
  initialError: string | null;
  presets: PresetSummary[];
  liveConfirmation: string;
}) {
  const { viewer } = props;
  const poll = usePoll<StatusDto>('/api/status', 4000, props.initialStatus);
  const s = poll.data;
  const engineError = poll.error ?? (s ? null : props.initialError);
  const { toast, show } = useToast();
  const [busy, setBusy] = useState(false);
  const [sheet, setSheet] = useState<SheetName>(null);
  const [preset, setPreset] = useState<PresetName>(props.initialStatus?.preset ?? 'balanced');
  const [typed, setTyped] = useState('');

  const running = s?.state === 'running';
  const halted = s?.state === 'halted';
  const isOwner = viewer.role === 'owner';
  const canAct = !viewer.demo && s !== null;

  // Follow the engine's preset while running so the control shows what is actually in effect.
  useEffect(() => {
    if (s && s.state === 'running') setPreset(s.preset);
  }, [s]);

  const selectedPreset = useMemo(() => props.presets.find((p) => p.name === preset), [props.presets, preset]);

  const act = async (url: string, body: unknown, okText: string) => {
    setBusy(true);
    const r = await postJson(url, body);
    setBusy(false);
    if (r.ok) {
      show('ok', okText);
      setSheet(null);
      poll.refresh();
      return true;
    }
    show('error', r.message);
    return false;
  };

  const openSheet = (name: SheetName) => {
    setTyped('');
    setSheet(name);
  };

  const powerLabel = halted ? 'Halted' : running ? 'Pause' : 'Start';
  const powerHint = halted
    ? 'Trading is halted'
    : running
      ? 'Stop new trades; open trades exit normally'
      : `Start with the ${selectedPreset?.label ?? preset} preset`;

  return (
    <div className="desktop">
      <MenuBar viewer={viewer} active="home" mode={s?.mode ?? null} showMode theme={props.theme} />
      <main id="main">
        <WindowFrame
          title={
            <>
              <strong>Tidepool</strong> &middot; Pool controls
            </>
          }
          tools={<ModeBadge mode={s?.mode ?? null} />}
        >
          <div className="stack">
            {viewer.demo ? (
              <div className="banner banner-warn" role="status">
                <span className="banner-icon" aria-hidden="true">
                  !
                </span>
                <div>
                  <h2>Demo mode</h2>
                  <p>You are looking at sample data. Buttons are disabled and nothing reaches an engine or a wallet.</p>
                </div>
              </div>
            ) : null}

            {halted ? (
              <div className="banner banner-halt" role="alert">
                <span className="banner-icon" aria-hidden="true">
                  !
                </span>
                <div>
                  <h2>Trading is halted</h2>
                  <p>{haltText(s?.haltReason ?? null)}</p>
                  <p className="subtle">
                    Open positions still exit by their normal rules.
                    {viewer.role === 'operator' ? (
                      <>
                        {' '}
                        Review and clear it in the <a href="/ops">operations view</a>.
                      </>
                    ) : (
                      ' Roe needs to review it before trading resumes.'
                    )}
                  </p>
                </div>
              </div>
            ) : null}

            {engineError ? (
              <div className="banner banner-warn" role="status">
                <span className="banner-icon" aria-hidden="true">
                  !
                </span>
                <div>
                  <h2>Cannot reach the trading engine</h2>
                  <p>{engineError}</p>
                  {poll.updatedAt ? (
                    <p className="subtle">Numbers below are from {new Date(poll.updatedAt).toLocaleTimeString()}.</p>
                  ) : null}
                </div>
              </div>
            ) : null}

            <section className="card hero" aria-labelledby="control-title">
              <button
                type="button"
                className={`power${running ? ' is-running' : ''}`}
                disabled={!canAct || busy || halted}
                onClick={() =>
                  void (running
                    ? act('/api/control/pause', {}, 'Paused. Open trades will exit by their normal rules.')
                    : act(
                        '/api/control/start',
                        { preset },
                        `Started with the ${selectedPreset?.label ?? preset} preset.`,
                      ))
                }
                aria-describedby="power-hint"
              >
                <span>{powerLabel}</span>
                <small aria-hidden="true">{running ? 'all agents' : halted ? 'see above' : 'all agents'}</small>
              </button>
              <div className="stack" style={{ gap: 10 }}>
                <div className="row">
                  <h2 id="control-title" className={`state-pill state-${s?.state ?? 'stopped'}`}>
                    <span className="dot" aria-hidden="true" />
                    {s ? STATE_TEXT[s.state] : 'Status unknown'}
                  </h2>
                  {s ? <ModeBadge mode={s.mode} /> : null}
                </div>
                <p id="power-hint" className="muted">
                  {powerHint}. Start runs the Scout, Trader and Risk Officer together.
                </p>
                <Segmented
                  label="Risk preset"
                  options={props.presets.map((p) => ({ value: p.name, label: p.label }))}
                  value={preset}
                  onChange={setPreset}
                  disabled={running || !canAct}
                  describedBy="preset-desc"
                />
                <div id="preset-desc">
                  <p>{selectedPreset?.description}</p>
                  {selectedPreset ? (
                    <p className="subtle">
                      Up to {selectedPreset.maxPositionPct}% of the pool per trade, at most{' '}
                      {selectedPreset.maxOpenPositions} open trades, daily loss limit {selectedPreset.dailyLossLimitPct}
                      % of the pool.
                      {running ? ' Pause to change the preset.' : ''}
                    </p>
                  ) : null}
                </div>
              </div>
            </section>

            {s ? (
              <div className="grid-2">
                <PoolCard s={s} />
                <TodayCard s={s} />
              </div>
            ) : (
              <div className="card">
                <p className="muted">{poll.loading ? 'Loading pool status...' : 'Pool status is unavailable.'}</p>
              </div>
            )}

            {s ? (
              <div className="grid-2">
                <section className="card" aria-labelledby="wallet-title">
                  <h2 id="wallet-title" className="card-title">
                    Money in and out
                  </h2>
                  <div className="row">
                    <button type="button" className="btn btn-primary" onClick={() => openSheet('deposit')}>
                      Deposit
                    </button>
                    <button
                      type="button"
                      className="btn"
                      onClick={() => openSheet('withdraw')}
                      disabled={!isOwner || viewer.demo}
                      aria-describedby="withdraw-note"
                    >
                      Withdraw
                    </button>
                  </div>
                  <p id="withdraw-note" className="subtle" style={{ marginTop: 8 }}>
                    {isOwner ? 'Withdrawals only go to your registered wallet.' : 'Only the owner can withdraw.'}
                  </p>
                  <dl className="kv">
                    <dt>Withdrawal wallet</dt>
                    <dd title={s.wallet.withdrawAddress ?? undefined}>
                      {s.wallet.withdrawAddress ? shortAddress(s.wallet.withdrawAddress, 6) : 'Not set'}
                    </dd>
                    {s.wallet.pendingWithdrawAddress ? (
                      <>
                        <dt>Pending change</dt>
                        <dd title={s.wallet.pendingWithdrawAddress}>
                          {shortAddress(s.wallet.pendingWithdrawAddress, 6)}
                          <small>takes effect {formatDateTime(s.wallet.pendingWithdrawEffectiveAt)}</small>
                        </dd>
                      </>
                    ) : null}
                  </dl>
                </section>

                <section className="card" aria-labelledby="mode-title">
                  <h2 id="mode-title" className="card-title">
                    Trading mode
                  </h2>
                  <div className="switch-row">
                    <div>
                      <p id="live-label">
                        <strong>Live trading</strong>{' '}
                        <span className="muted">
                          ({s.mode === 'live' ? 'on: real money' : 'off: paper trades only'})
                        </span>
                      </p>
                    </div>
                    <button
                      type="button"
                      className="switch"
                      role="switch"
                      aria-checked={s.mode === 'live'}
                      aria-labelledby="live-label"
                      aria-describedby="live-note"
                      disabled={!canAct || running || (s.mode === 'paper' && (!s.liveTradingAllowed || !isOwner))}
                      onClick={() => openSheet(s.mode === 'live' ? 'paper' : 'live')}
                    />
                  </div>
                  <p id="live-note" className="subtle" style={{ marginTop: 8 }}>
                    {s.mode === 'paper' && !s.liveTradingAllowed
                      ? 'Live trading is turned off on the server (LIVE_TRADING_ENABLED is not true). It stays in paper mode until Roe enables it after the paper-trading review.'
                      : s.mode === 'paper' && !isOwner
                        ? 'Only the owner can switch to live trading.'
                        : running
                          ? 'Pause trading before switching modes.'
                          : s.mode === 'live'
                            ? 'Switching back to paper stops spending real money on new trades.'
                            : 'Switching to live asks you to confirm in writing.'}
                  </p>
                </section>
              </div>
            ) : null}

            <section className="card" aria-labelledby="kill-title">
              <div className="row-between">
                <div>
                  <h2 id="kill-title" className="card-title" style={{ marginBottom: 4 }}>
                    Emergency
                  </h2>
                  <p className="muted">Stops all agents and sells every open position at market.</p>
                </div>
                <button type="button" className="btn btn-danger" onClick={() => openSheet('kill')} disabled={!canAct}>
                  Stop and sell everything
                </button>
              </div>
            </section>
          </div>
        </WindowFrame>
      </main>

      <Sheet open={sheet === 'kill'} onClose={() => setSheet(null)} title="Stop and sell everything?">
        <p>
          This halts the Scout, Trader and Risk Officer and sells every open position at market price right away.
          Selling in a hurry can cost more in slippage. Trading stays halted until Roe clears it.
        </p>
        <form
          className="stack"
          onSubmit={(e: SubmitEvent<HTMLFormElement>) => {
            e.preventDefault();
            if (typed === KILL_WORD)
              void act('/api/control/kill', { confirm: KILL_WORD }, 'Kill switch sent. Positions are being sold.');
          }}
        >
          <div className="field">
            <label htmlFor="kill-confirm">Type {KILL_WORD} to confirm</label>
            <input
              id="kill-confirm"
              className="input mono"
              value={typed}
              onChange={(e) => setTyped(e.target.value)}
              autoComplete="off"
              autoCapitalize="characters"
              spellCheck={false}
            />
          </div>
          <div className="sheet-actions">
            <button type="button" className="btn" onClick={() => setSheet(null)}>
              Cancel
            </button>
            <button type="submit" className="btn btn-danger" disabled={typed !== KILL_WORD || busy}>
              Stop and sell everything
            </button>
          </div>
        </form>
      </Sheet>

      <DepositSheet
        open={sheet === 'deposit'}
        onClose={() => setSheet(null)}
        mode={s?.mode ?? 'paper'}
        demo={viewer.demo}
      />

      {s ? (
        <WithdrawSheet
          open={sheet === 'withdraw'}
          onClose={() => setSheet(null)}
          status={s}
          busy={busy}
          onWithdraw={(lamports) =>
            act('/api/wallet/withdraw', { lamports: lamports.toString() }, 'Withdrawal requested.')
          }
          onChangeAddress={() => openSheet('address')}
        />
      ) : null}

      <Sheet open={sheet === 'address'} onClose={() => setSheet(null)} title="Change withdrawal wallet">
        <AddressForm
          busy={busy}
          onCancel={() => setSheet(null)}
          onSubmit={(address) =>
            act(
              '/api/wallet/withdraw-address',
              { address },
              'Address change requested. It takes effect after 24 hours.',
            )
          }
        />
      </Sheet>

      <Sheet open={sheet === 'live'} onClose={() => setSheet(null)} title="Switch to live trading?">
        <p>
          <strong>Live mode trades real money from the pool wallet.</strong> Losses are real and can reach the daily
          loss limit every day. Paper results do not guarantee live results.
        </p>
        <form
          className="stack"
          onSubmit={(e: SubmitEvent<HTMLFormElement>) => {
            e.preventDefault();
            if (typed === props.liveConfirmation)
              void act('/api/control/mode', { mode: 'live', confirm: typed }, 'Live mode is on.');
          }}
        >
          <div className="field">
            <label htmlFor="live-confirm">
              Type this sentence exactly: <span className="mono">{props.liveConfirmation}</span>
            </label>
            <input
              id="live-confirm"
              className="input"
              value={typed}
              onChange={(e) => setTyped(e.target.value)}
              autoComplete="off"
              spellCheck={false}
            />
            <p className="hint" aria-live="polite">
              {typed.length > 0 && typed !== props.liveConfirmation ? 'Not matching yet.' : ' '}
            </p>
          </div>
          <div className="sheet-actions">
            <button type="button" className="btn" onClick={() => setSheet(null)}>
              Stay in paper mode
            </button>
            <button type="submit" className="btn btn-danger" disabled={typed !== props.liveConfirmation || busy}>
              Switch to live
            </button>
          </div>
        </form>
      </Sheet>

      <Sheet open={sheet === 'paper'} onClose={() => setSheet(null)} title="Switch back to paper trading?">
        <p>New trades will be simulated. Open live positions keep their exit rules until they close.</p>
        <div className="sheet-actions">
          <button type="button" className="btn" onClick={() => setSheet(null)}>
            Cancel
          </button>
          <button
            type="button"
            className="btn btn-primary"
            disabled={busy}
            onClick={() => void act('/api/control/mode', { mode: 'paper' }, 'Paper mode is on.')}
          >
            Switch to paper
          </button>
        </div>
      </Sheet>

      <div aria-live="polite" role="status">
        {toast ? <div className={`toast ${toast.kind === 'error' ? 'is-error' : 'is-ok'}`}>{toast.text}</div> : null}
      </div>
    </div>
  );
}

function DepositSheet(props: { open: boolean; onClose: () => void; mode: 'paper' | 'live'; demo: boolean }) {
  const [data, setData] = useState<{ address: string; qrDataUrl: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!props.open) return undefined;
    let cancelled = false;
    setError(null);
    setCopied(false);
    fetch('/api/wallet/deposit', { cache: 'no-store', credentials: 'same-origin' })
      .then(async (res) => {
        const body = (await res.json()) as { address?: string; qrDataUrl?: string; message?: string };
        if (cancelled) return;
        if (!res.ok || !body.address || !body.qrDataUrl?.startsWith('data:image/png;base64,')) {
          setError(body.message ?? 'The deposit address is unavailable.');
          return;
        }
        setData({ address: body.address, qrDataUrl: body.qrDataUrl });
      })
      .catch(() => {
        if (!cancelled) setError('Cannot reach the dashboard server.');
      });
    return () => {
      cancelled = true;
    };
  }, [props.open]);

  const copy = async () => {
    if (!data) return;
    try {
      await navigator.clipboard.writeText(data.address);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  };

  return (
    <Sheet open={props.open} onClose={props.onClose} title="Deposit SOL">
      {props.demo ? <p className="error-text">Demo address. Do not send funds.</p> : null}
      {error ? <p className="error-text">{error}</p> : null}
      {data ? (
        <>
          {/* eslint-disable-next-line @next/next/no-img-element -- inline data: URL QR code, nothing for next/image to optimize */}
          <img className="qr" src={data.qrDataUrl} alt="QR code of the pool deposit address" width={220} height={220} />
          <div className="address" aria-label="Deposit address">
            {data.address}
          </div>
          <p className="hint">Send only SOL on the Solana network to this address. Anything else may be lost.</p>
          {props.mode === 'paper' ? (
            <p className="hint">
              The bot is in paper mode: deposits sit in the pool wallet and are not traded until live mode is on.
            </p>
          ) : null}
        </>
      ) : !error ? (
        <p className="muted">Loading address...</p>
      ) : null}
      <div className="sheet-actions">
        <span aria-live="polite" className="subtle">
          {copied ? 'Copied' : ''}
        </span>
        <button type="button" className="btn" onClick={() => void copy()} disabled={!data}>
          Copy address
        </button>
        <button type="button" className="btn btn-primary" onClick={props.onClose}>
          Done
        </button>
      </div>
    </Sheet>
  );
}

function WithdrawSheet(props: {
  open: boolean;
  onClose: () => void;
  status: StatusDto;
  busy: boolean;
  onWithdraw: (lamports: bigint) => Promise<boolean>;
  onChangeAddress: () => void;
}) {
  const [amount, setAmount] = useState('');
  const [step, setStep] = useState<'enter' | 'confirm'>('enter');
  const { wallet, pool, solUsd } = props.status;
  const cash = toLamports(pool.cashLamports);
  const lamports = parseSolInput(amount);
  const tooMuch = lamports !== null && lamports > cash;
  const valid = lamports !== null && !tooMuch;

  useEffect(() => {
    if (props.open) {
      setAmount('');
      setStep('enter');
    }
  }, [props.open]);

  return (
    <Sheet open={props.open} onClose={props.onClose} title="Withdraw to your wallet">
      {!wallet.withdrawAddress ? (
        <p>No withdrawal wallet is registered yet. Register one first; it becomes usable 24 hours after you set it.</p>
      ) : (
        <>
          <div className="field">
            <span className="hint">Destination (the only address withdrawals can go to)</span>
            <div className="address">{wallet.withdrawAddress}</div>
          </div>
          {step === 'enter' ? (
            <form
              className="stack"
              onSubmit={(e) => {
                e.preventDefault();
                if (valid) setStep('confirm');
              }}
            >
              <div className="field">
                <label htmlFor="withdraw-amount">Amount in SOL</label>
                <input
                  id="withdraw-amount"
                  className="input mono"
                  inputMode="decimal"
                  value={amount}
                  onChange={(e) => setAmount(e.target.value)}
                  autoComplete="off"
                  aria-describedby="withdraw-help"
                />
                <p id="withdraw-help" className="hint">
                  Available: {formatSol(cash)}
                  {solUsd !== null ? ` (${String(formatLamportsUsd(cash, solUsd))})` : ''}. Money in open positions must
                  be sold first.
                </p>
                {amount && lamports === null ? (
                  <p className="error-text">Enter a positive amount with at most 9 decimals.</p>
                ) : null}
                {tooMuch ? <p className="error-text">That is more than the cash available.</p> : null}
              </div>
              <div className="sheet-actions">
                <button type="button" className="btn" onClick={props.onClose}>
                  Cancel
                </button>
                <button type="submit" className="btn btn-primary" disabled={!valid}>
                  Review
                </button>
              </div>
            </form>
          ) : (
            <div className="stack">
              <p>
                Send <strong className="num">{lamports !== null ? formatSol(lamports, 9) : ''}</strong>
                {lamports !== null && solUsd !== null
                  ? ` (about ${String(formatLamportsUsd(lamports, solUsd))})`
                  : ''}{' '}
                to <span className="mono">{shortAddress(wallet.withdrawAddress, 6)}</span>? Network fees come out of the
                pool.
              </p>
              <div className="sheet-actions">
                <button type="button" className="btn" onClick={() => setStep('enter')}>
                  Back
                </button>
                <button
                  type="button"
                  className="btn btn-primary"
                  disabled={props.busy || lamports === null}
                  onClick={() => lamports !== null && void props.onWithdraw(lamports)}
                >
                  Withdraw
                </button>
              </div>
            </div>
          )}
        </>
      )}
      {wallet.pendingWithdrawAddress ? (
        <div className="banner banner-info">
          <span className="banner-icon" aria-hidden="true">
            i
          </span>
          <div>
            <h3>Address change pending</h3>
            <p className="mono" style={{ overflowWrap: 'anywhere' }}>
              {wallet.pendingWithdrawAddress}
            </p>
            <p className="subtle">
              Takes effect {formatDateTime(wallet.pendingWithdrawEffectiveAt)}. Until then withdrawals go to the current
              address.
            </p>
          </div>
        </div>
      ) : null}
      <div className="sheet-actions">
        <button type="button" className="btn btn-ghost" onClick={props.onChangeAddress}>
          {wallet.withdrawAddress ? 'Change withdrawal wallet' : 'Register withdrawal wallet'}
        </button>
      </div>
    </Sheet>
  );
}

function AddressForm(props: { busy: boolean; onCancel: () => void; onSubmit: (address: string) => Promise<boolean> }) {
  const [address, setAddress] = useState('');
  const trimmed = address.trim();
  const valid = BASE58_ADDRESS.test(trimmed);
  return (
    <form
      className="stack"
      onSubmit={(e) => {
        e.preventDefault();
        if (valid) void props.onSubmit(trimmed);
      }}
    >
      <p>
        For safety, a new withdrawal wallet only becomes active <strong>24 hours</strong> after you set it, and you get
        an alert. If you did not request a change, contact Roe right away.
      </p>
      <div className="field">
        <label htmlFor="new-address">Your Solana wallet address</label>
        <input
          id="new-address"
          className="input mono"
          value={address}
          onChange={(e) => setAddress(e.target.value)}
          autoComplete="off"
          spellCheck={false}
        />
        {trimmed && !valid ? <p className="error-text">That does not look like a Solana address.</p> : null}
      </div>
      <div className="sheet-actions">
        <button type="button" className="btn" onClick={props.onCancel}>
          Cancel
        </button>
        <button type="submit" className="btn btn-primary" disabled={!valid || props.busy}>
          Start 24-hour change
        </button>
      </div>
    </form>
  );
}
