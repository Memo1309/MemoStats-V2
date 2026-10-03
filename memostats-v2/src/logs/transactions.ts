import type { LogDetailValue } from './logStore';

/**
 * One completed request/response through the dongle, in human terms. Every layer that talks to the
 * car records here; the Capture page and exports read it. Raw bytes live in `detail`.
 */
export interface Transaction {
  id: number;
  /** epoch ms */
  at: number;
  kind: 'OBD' | 'UDS' | 'PROBE' | 'DONGLE';
  txId?: number;
  rxId?: number;
  requestNr?: number;
  request: string;
  response: string | null;
  /** short human status, e.g. OK / FĂRĂ RĂSPUNS / NEGATIV 0x31 */
  status: string;
  ok: boolean;
  /** the ECU produced any valid diagnostic answer (positive, negative or pending); undefined for dongle commands */
  answered?: boolean;
  latencyMs: number | null;
  detail: Record<string, LogDetailValue>;
}

// ponytail: bounded ring copied on append; fine at ~3 req/s, move to a chunked buffer if polling gets faster.
const MAX = 3000;
let items: readonly Transaction[] = [];
let nextId = 1;
const listeners = new Set<() => void>();

export const transactionStore = {
  getSnapshot: (): readonly Transaction[] => items,
  subscribe(listener: () => void): () => void {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },
  /** id the next transaction will get — a capture session starts here */
  nextId: (): number => nextId,
};

export function recordTransaction(t: Omit<Transaction, 'id' | 'at'>): void {
  const entry: Transaction = { ...t, id: nextId++, at: Date.now() };
  items = items.length >= MAX ? [...items.slice(1 - MAX), entry] : [...items, entry];
  for (const listener of listeners) listener();
}
