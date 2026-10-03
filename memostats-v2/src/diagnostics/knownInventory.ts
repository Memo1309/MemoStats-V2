// knownVehicleInventory — the persistent historical inventory of ECUs that have identified themselves on
// this vehicle. This is SEPARATE from currentScanInventory (moduleCache = who replied THIS scan) and the
// two are never equated. A module that does not respond in a later scan is NOT deleted and is never called
// "missing/absent"; it is kept with its identity and marked "not detected in the current scan".
import { createStore, loadJson, saveJson } from '../state/createStore';

export type KnownScanStatus = 'present' | 'not_detected';

export interface KnownEcu {
  key: string; // moduleKey(tx, rx)
  txId: number;
  rxId: number;
  scanName: string;
  opCode: string | null;
  hardware: string | null;
  software: string | null;
  serialRawHex: string | null;
  serialText: string | null;
  firstSeenAt: number;
  lastSeenAt: number;
  seenCount: number;
  missCount: number;
  lastScanStatus: KnownScanStatus;
}

export interface KnownInventoryState {
  v: 1;
  ecus: Record<string, KnownEcu>;
}

/** One present module's identity as read during a scan (no DB needed — variant is resolved at display). */
export interface PresentIdentity {
  key: string;
  txId: number;
  rxId: number;
  scanName: string;
  opCode: string | null;
  hardware: string | null;
  software: string | null;
  serialRawHex: string | null;
  serialText: string | null;
}

const KEY = 'memostats.v2.known-inventory.v1';
const EMPTY: KnownInventoryState = { v: 1, ecus: {} };
const isState = (x: unknown): x is KnownInventoryState =>
  typeof x === 'object' && x !== null && (x as KnownInventoryState).v === 1 && typeof (x as KnownInventoryState).ecus === 'object' && (x as KnownInventoryState).ecus !== null;

export const knownInventoryStore = createStore<KnownInventoryState>(loadJson(KEY, EMPTY, isState));

/** Keep a newly-read value, else the previously-persisted one (never overwrite known identity with null). */
const keep = (fresh: string | null, prev: string | null | undefined): string | null => (fresh ?? prev ?? null);

/**
 * Fold one completed scan into the known inventory. `present` are the modules that replied (with identity);
 * `probedKeys` are the pairs actually probed this scan. Present modules are upserted (identity refreshed,
 * seenCount++, status "present"); known modules that were probed but did not reply get missCount++ and
 * status "not_detected" — they are never removed. Modules not probed this scan are left untouched.
 */
export function recordScanIntoKnownInventory(present: readonly PresentIdentity[], probedKeys: ReadonlySet<string>, now = Date.now()): void {
  const state = knownInventoryStore.get();
  const ecus = { ...state.ecus };
  const presentKeys = new Set(present.map(p => p.key));

  for (const p of present) {
    const prev = ecus[p.key];
    ecus[p.key] = {
      key: p.key, txId: p.txId, rxId: p.rxId, scanName: p.scanName || prev?.scanName || '',
      opCode: keep(p.opCode, prev?.opCode), hardware: keep(p.hardware, prev?.hardware),
      software: keep(p.software, prev?.software), serialRawHex: keep(p.serialRawHex, prev?.serialRawHex), serialText: keep(p.serialText, prev?.serialText),
      firstSeenAt: prev?.firstSeenAt ?? now, lastSeenAt: now, seenCount: (prev?.seenCount ?? 0) + 1, missCount: prev?.missCount ?? 0,
      lastScanStatus: 'present',
    };
  }
  // Known modules that were probed this scan but did not reply: keep them, only note the miss.
  for (const [key, ecu] of Object.entries(ecus)) {
    if (!presentKeys.has(key) && probedKeys.has(key)) {
      ecus[key] = { ...ecu, missCount: ecu.missCount + 1, lastScanStatus: 'not_detected' };
    }
  }
  const next: KnownInventoryState = { v: 1, ecus };
  knownInventoryStore.set(() => next);
  saveJson(KEY, next);
}

/** Explicit reset (new vehicle / user action). Never called automatically on a single failed probe. */
export function clearKnownInventory(): void {
  knownInventoryStore.set(() => EMPTY);
  saveJson(KEY, EMPTY);
}
