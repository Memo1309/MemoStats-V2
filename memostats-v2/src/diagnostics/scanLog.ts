// Independent Scan Protocol / Developer Log. Records the real BLE/UDS transactions of a scan so the
// scan can be debugged WITHOUT Passive Capture (which is mutually exclusive with scanning — capture
// blocks TX, scan transmits; that stays unchanged). Viewable after the scan finishes.
import { createStore } from '../state/createStore';
import type { PresenceStatus } from './presence';

export interface ScanLogEntry {
  seq: number;
  at: number; // epoch ms
  pass: 1 | 2;
  txId: number;
  rxId: number;
  /** raw outer BLE request (0x33 frame), hex */
  requestHex: string | null;
  /** raw outer BLE response (B3 / C0 frame), hex; null = no frame */
  responseHex: string | null;
  /** parsed CAN response slot / UDS body, hex */
  parsed: string | null;
  /** outer status (B3 arg, or EXEC_UDS resp_status) */
  outerStatus: string | null;
  /** UDS payload when applicable, hex */
  udsPayload: string | null;
  kind: 'probe' | 'identify';
  presence: PresenceStatus | null; // null for identify sub-requests
  reason: string;
}

export interface ScanSummary {
  candidates: number;
  present: number;
  absent: number;
  errors: number;
  presentPairs: { txId: number; rxId: number }[];
}

export interface ScanLogState {
  running: boolean;
  entries: ScanLogEntry[];
  summary: ScanSummary | null;
  startedAt: number | null;
}

const EMPTY: ScanLogState = { running: false, entries: [], summary: null, startedAt: null };
export const scanLogStore = createStore<ScanLogState>(EMPTY);

export function beginScanLog(): void {
  scanLogStore.set(() => ({ running: true, entries: [], summary: null, startedAt: Date.now() }));
}

export function recordScanLog(entry: Omit<ScanLogEntry, 'at'>): void {
  const full: ScanLogEntry = { ...entry, at: Date.now() };
  scanLogStore.set(s => ({ ...s, entries: [...s.entries, full] }));
}

export function finishScanLog(summary: ScanSummary): void {
  scanLogStore.set(s => ({ ...s, running: false, summary }));
}

/** Plain-text dump for COPY / export (Bluefy-friendly), independent of Passive Capture. */
export function scanLogText(state: ScanLogState): string {
  const hex = (n: number) => `0x${n.toString(16).toUpperCase()}`;
  const lines: string[] = ['MEMOSTATS V2 · SCAN PROTOCOL LOG', state.startedAt ? `Start: ${new Date(state.startedAt).toISOString()}` : '', ''];
  for (const e of state.entries) {
    lines.push(`[${String(e.seq).padStart(3, '0')}] pass ${e.pass} ${hex(e.txId)}→${hex(e.rxId)} ${e.kind.toUpperCase()}`);
    if (e.requestHex) lines.push(`  TX: ${e.requestHex}`);
    lines.push(`  RX: ${e.responseHex ?? '(niciun cadru)'}`);
    if (e.parsed) lines.push(`  CAN/parsed: ${e.parsed}`);
    if (e.outerStatus) lines.push(`  outer: ${e.outerStatus}`);
    if (e.udsPayload) lines.push(`  UDS: ${e.udsPayload}`);
    if (e.presence) lines.push(`  PRESENCE: ${e.presence}`);
    lines.push(`  reason: ${e.reason}`, '');
  }
  const s = state.summary;
  if (s) {
    lines.push(`SCAN SUMMARY`, `candidates: ${s.candidates}`, `present: ${s.present}`, `absent: ${s.absent}`, `errors: ${s.errors}`, '', 'PRESENT PAIRS:');
    for (const p of s.presentPairs) lines.push(`  ${hex(p.txId)} -> ${hex(p.rxId)}`);
  }
  return lines.join('\n');
}
