import type { UdsSemantic } from '../core/uds/udsSemantics';
import type { Tone } from './components/primitives';

/** What the user sees for a UDS outcome. Raw transport status (e.g. 0xFE) stays in technical rows. */
export const SEMANTIC_LABEL: Record<UdsSemantic, { text: string; tone: Tone }> = {
  POSITIVE_RESPONSE: { text: 'RĂSPUNDE', tone: 'ok' },
  NEGATIVE_RESPONSE: { text: 'RĂSPUNDE · NEGATIV', tone: 'warn' },
  RESPONSE_PENDING: { text: 'RĂSPUNDE · ÎN AȘTEPTARE', tone: 'warn' },
  UNEXPECTED_RESPONSE: { text: 'RĂSPUNS NEAȘTEPTAT', tone: 'warn' },
  NO_RESPONSE: { text: 'FĂRĂ RĂSPUNS', tone: 'error' },
};

export function formatClock(epochMs: number): string {
  return new Date(epochMs).toLocaleTimeString('ro-RO', { hour12: false });
}

export function formatMs(ms: number | null): string {
  return ms === null ? '—' : `${Math.round(ms)} ms`;
}

/** Number with fixed decimals, or null when there is nothing to show. */
export function fmt(value: number | null | undefined, digits = 0): string | null {
  return value === null || value === undefined || !Number.isFinite(value) ? null : value.toFixed(digits);
}

export function formatDateTime(epochMs: number): string {
  return new Date(epochMs).toLocaleString('ro-RO', { hour12: false, day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
}
