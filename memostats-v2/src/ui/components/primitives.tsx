import type { ButtonHTMLAttributes, ReactNode } from 'react';

export type Tone = 'ok' | 'warn' | 'error' | 'muted' | 'active';

export function StatusBadge({ tone, children }: { tone: Tone; children: ReactNode }) {
  return <span className={`badge badge--${tone}`}>{children}</span>;
}

type ActionButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: 'primary' | 'secondary' | 'quiet';
  busy?: boolean;
};

export function ActionButton({ variant = 'primary', busy = false, disabled, children, className, ...rest }: ActionButtonProps) {
  return (
    <button
      type="button"
      className={`btn btn--${variant}${className ? ` ${className}` : ''}`}
      disabled={disabled || busy}
      aria-busy={busy || undefined}
      {...rest}
    >
      {busy && <span className="btn__spinner" aria-hidden="true" />}
      {children}
    </button>
  );
}

export function SectionHeader({ title, meta }: { title: string; meta?: ReactNode }) {
  return (
    <div className="section-header">
      <h2>{title}</h2>
      {meta !== undefined && <div className="section-header__meta">{meta}</div>}
    </div>
  );
}

export function TechnicalRow({ label, value, mono = false, tone }: { label: string; value: ReactNode; mono?: boolean; tone?: Tone }) {
  const empty = value === undefined || value === null || value === '';
  return (
    <div className="row">
      <span className="row__label">{label}</span>
      <span className={`row__value${mono ? ' mono' : ''}${tone ? ` text--${tone}` : ''}${empty ? ' text--muted' : ''}`}>
        {empty ? '—' : value}
      </span>
    </div>
  );
}

/** Raw bytes block: monospace, wraps, never scrolls the page sideways. */
export function HexBlock({ label, hex, note }: { label: string; hex: string; note?: string }) {
  return (
    <div className="hex">
      <div className="hex__label">
        <span>{label}</span>
        {note && <span className="hex__note">{note}</span>}
      </div>
      <code className="hex__bytes">{hex || '—'}</code>
    </div>
  );
}

export function ExpandablePanel({ title, children, defaultOpen = false }: { title: string; children: ReactNode; defaultOpen?: boolean }) {
  return (
    <details className="expandable" open={defaultOpen}>
      <summary>{title}</summary>
      <div className="expandable__body">{children}</div>
    </details>
  );
}

/** A live value card. `value` null → clean unavailable state, never a fabricated 0. */
export function MetricCard({ label, value, unit, stale = false, naText = 'INDISPONIBIL' }: {
  label: string; value: string | null; unit?: string; stale?: boolean; naText?: string;
}) {
  return (
    <div className={`metric${stale ? ' metric--stale' : ''}`}>
      <span className="eyebrow">{label}</span>
      {value === null
        ? <span className="metric__value metric__value--na">{naText}</span>
        : <span className="metric__value">{value}{unit && <small>{unit}</small>}</span>}
    </div>
  );
}
