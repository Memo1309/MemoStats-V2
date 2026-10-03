// Merges the knownVehicleInventory with the currentScanInventory into the rows the ECU Explorer shows.
// Detected-now modules use their FRESH scan identity; known-but-not-detected modules keep their persisted
// identity and are marked "not detected in the current scan" — never removed, never called missing/absent.
import { type ResolvedIdentity, resolveIdentity } from '../w176/catalog';
import type { W176Db } from '../w176/types';
import { didStr } from './ecuScan';
import { moduleKey } from './inventoryHistory';
import type { KnownEcu } from './knownInventory';
import type { CachedModule } from './moduleCache';

export type ExplorerState = 'detected_now' | 'not_detected';

export interface ExplorerEntry {
  txId: number;
  rxId: number;
  state: ExplorerState;
  scanName: string;
  opCode: string | null;
  hardware: string | null;
  software: string | null;
  serialRawHex: string | null;
  serialText: string | null;
  lastSeenAt: number | null;
  seenCount: number;
  missCount: number;
  /** resolved catalog identity (null until the DB is loaded) */
  identity: ResolvedIdentity | null;
}

function fromCurrent(cm: CachedModule, now: number): Omit<ExplorerEntry, 'identity' | 'state'> {
  return {
    txId: cm.module.txId, rxId: cm.module.rxId, scanName: cm.module.name, opCode: cm.opCode,
    hardware: didStr(cm.ids.F111), software: didStr(cm.ids.F121), serialRawHex: cm.ids.F18C?.raw ?? null, serialText: cm.ids.F18C?.text ?? null,
    lastSeenAt: now, seenCount: 1, missCount: 0,
  };
}

function fromKnown(k: KnownEcu): Omit<ExplorerEntry, 'identity' | 'state'> {
  return {
    txId: k.txId, rxId: k.rxId, scanName: k.scanName, opCode: k.opCode,
    hardware: k.hardware, software: k.software, serialRawHex: k.serialRawHex, serialText: k.serialText,
    lastSeenAt: k.lastSeenAt, seenCount: k.seenCount, missCount: k.missCount,
  };
}

/**
 * Explorer rows = knownVehicleInventory ∪ currentScanInventory (by CAN pair). A pair that replied this scan
 * is DETECTED NOW with fresh identity; a known pair that did not reply is NOT DETECTED IN CURRENT SCAN with
 * its persisted identity and seen/miss history. Only vehicle modules are shown — never the other candidates.
 */
export function buildExplorerEntries(known: Readonly<Record<string, KnownEcu>>, current: readonly CachedModule[], db: W176Db | null, now = Date.now()): ExplorerEntry[] {
  const currentByKey = new Map(current.map(cm => [moduleKey(cm.module.txId, cm.module.rxId), cm]));
  const keys = new Set<string>([...Object.keys(known), ...currentByKey.keys()]);
  const rows: ExplorerEntry[] = [];
  for (const key of keys) {
    const cm = currentByKey.get(key);
    const k = known[key];
    const base = cm ? fromCurrent(cm, now) : k ? fromKnown(k) : null;
    if (!base) continue;
    // Detected now if it replied this scan; otherwise it is a known module that did not reply.
    const state: ExplorerState = cm ? 'detected_now' : 'not_detected';
    // Keep the persisted seen/miss history even when detected now (fresh read has counts of 1/0).
    const history = k && cm ? { lastSeenAt: now, seenCount: k.seenCount + 0, missCount: k.missCount } : {};
    rows.push({
      ...base, ...history, state,
      identity: db ? resolveIdentity(db, base.txId, base.rxId, base.opCode) : null,
    });
  }
  return rows.sort((a, b) => a.txId - b.txId || a.rxId - b.rxId);
}
