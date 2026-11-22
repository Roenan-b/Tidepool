/** Desktop-style window: title bar with decorative traffic-light controls, a title and optional tools. */
import type { ReactNode } from 'react';

export function WindowFrame(props: { title: ReactNode; tools?: ReactNode; children: ReactNode; size?: 'normal' | 'wide' | 'narrow'; bodyClassName?: string }) {
  const size = props.size && props.size !== 'normal' ? ` ${props.size}` : '';
  return (
    <section className={`window${size}`} aria-label="Application window">
      <header className="titlebar">
        <div className="traffic" aria-hidden="true" title="Window controls (decorative)">
          <span className="t-red">&times;</span>
          <span className="t-amber">&minus;</span>
          <span className="t-green">+</span>
        </div>
        <div className="titlebar-title">{props.title}</div>
        <div className="titlebar-tools">{props.tools}</div>
      </header>
      <div className={props.bodyClassName ?? 'window-body'}>{props.children}</div>
    </section>
  );
}

export function ModeBadge({ mode }: { mode: 'paper' | 'live' | null | undefined }) {
  if (!mode) return <span className="badge badge-plain muted" title="Trading mode unknown">Mode unknown</span>;
  return mode === 'live' ? (
    <span className="badge badge-live" title="Live mode: real money is traded">Live</span>
  ) : (
    <span className="badge badge-paper" title="Paper mode: simulated trades, no real money">Paper</span>
  );
}
