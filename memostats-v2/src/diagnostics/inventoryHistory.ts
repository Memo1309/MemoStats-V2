import { createStore, loadJson, saveJson } from '../state/createStore';

// Persistent module history (master spec §16). Kept strictly apart from the current scan:
// history can say "seen before", never "detected now". A module missed once is
// "not detected this scan", never "removed".

export interface ModuleHistory {
  name: string;
  firstSeenAt: number;
  lastSeenAt: number;
  seenCount: number;
  missCount: number;
  lastStatus: string;
}

export interface InventoryHistory {
  v: 1;
  completedScans: number;
  modules: Record<string, ModuleHistory>;
}

const KEY = 'memostats.v2.inventory.v1';
const EMPTY: InventoryHistory = { v: 1, completedScans: 0, modules: {} };
const isHistory = (x: unknown): x is InventoryHistory =>
  typeof x === 'object' && x !== null && (x as InventoryHistory).v === 1 && Number.isInteger((x as InventoryHistory).completedScans)
  && typeof (x as InventoryHistory).modules === 'object' && (x as InventoryHistory).modules !== null;

export const historyStore = createStore<InventoryHistory>(loadJson(KEY, EMPTY, isHistory));

export const moduleKey = (txId: number, rxId: number): string => `${txId.toString(16)}/${rxId.toString(16)}`;

/** Applies one completed scan; returns keys detected for the first time (only once a baseline exists). */
export function recordScan(results: { key: string; name: string; responded: boolean; status: string }[], now = Date.now()): string[] {
  const history = historyStore.get();
  const modules = { ...history.modules };
  const fresh: string[] = [];
  for (const r of results) {
    const prior = modules[r.key];
    if (r.responded) {
      if (!prior && history.completedScans > 0) fresh.push(r.key);
      modules[r.key] = { name: r.name, firstSeenAt: prior?.firstSeenAt ?? now, lastSeenAt: now, seenCount: (prior?.seenCount ?? 0) + 1, missCount: 0, lastStatus: r.status };
    } else if (prior) {
      modules[r.key] = { ...prior, missCount: prior.missCount + 1, lastStatus: r.status };
    }
  }
  const next: InventoryHistory = { v: 1, completedScans: history.completedScans + 1, modules };
  historyStore.set(() => next);
  saveJson(KEY, next);
  return fresh;
}

export function clearHistory(): void {
  historyStore.set(() => EMPTY);
  saveJson(KEY, EMPTY);
}
