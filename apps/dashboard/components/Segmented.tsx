'use client';
/** Segmented control implemented as an ARIA radiogroup with roving focus and arrow-key selection. */
import { useRef, type KeyboardEvent } from 'react';

export interface SegmentOption<V extends string> {
  value: V;
  label: string;
}

export function Segmented<V extends string>(props: {
  label: string;
  options: ReadonlyArray<SegmentOption<V>>;
  value: V;
  onChange: (v: V) => void;
  disabled?: boolean;
  full?: boolean;
  describedBy?: string;
}) {
  const refs = useRef<Array<HTMLButtonElement | null>>([]);
  const index = Math.max(0, props.options.findIndex((o) => o.value === props.value));

  const onKey = (e: KeyboardEvent<HTMLButtonElement>, i: number) => {
    const n = props.options.length;
    let next = -1;
    if (e.key === 'ArrowRight' || e.key === 'ArrowDown') next = (i + 1) % n;
    else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') next = (i - 1 + n) % n;
    else if (e.key === 'Home') next = 0;
    else if (e.key === 'End') next = n - 1;
    if (next < 0) return;
    e.preventDefault();
    const opt = props.options[next];
    if (!opt) return;
    props.onChange(opt.value);
    refs.current[next]?.focus();
  };

  return (
    <div
      className={`segmented${props.full ? ' full' : ''}`}
      role="radiogroup"
      aria-label={props.label}
      aria-describedby={props.describedBy}
      aria-disabled={props.disabled || undefined}
    >
      {props.options.map((o, i) => (
        <button
          key={o.value}
          ref={(el) => {
            refs.current[i] = el;
          }}
          type="button"
          role="radio"
          aria-checked={o.value === props.value}
          tabIndex={i === index ? 0 : -1}
          disabled={props.disabled}
          onClick={() => props.onChange(o.value)}
          onKeyDown={(e) => onKey(e, i)}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}
