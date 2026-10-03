// Lazy, read-only access to the immutable W176 DB. The JSON is fetched at runtime from
// /data/w176/ (never imported into the bundle), deep-frozen so nothing can mutate the metadata,
// and cached for the session. Runtime/coding state is kept elsewhere and always works on clones.
import { log } from '../logs/logStore';
import { type W176Db, W176_DB_PATH } from './types';

/** Recursively freezes an object graph so the loaded metadata is truly read-only at runtime. */
function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const key of Object.keys(value as object)) deepFreeze((value as Record<string, unknown>)[key]);
  }
  return value;
}

let cache: Promise<W176Db> | null = null;

/** Loads (once) and returns the frozen immutable DB. Rejects with a readable message on failure. */
export function loadW176Db(): Promise<W176Db> {
  cache ??= fetch(W176_DB_PATH)
    .then(async response => {
      if (!response.ok) throw new Error(`Baza W176 nu s-a putut încărca (HTTP ${response.status})`);
      const db = (await response.json()) as W176Db;
      if (!db || typeof db !== 'object' || !db.coding || !db.w176_catalog) throw new Error('Baza W176 are o structură neașteptată');
      log('APP', 'DB LOADED (read-only)', {
        ecuDefinitions: db.w176_catalog.ecu_definitions.length, scanCandidates: db.w176_catalog.scan_candidates.length,
        variants: db.w176_catalog.variant_definition_count, inventory: db.inventory.latest_ecu_count, features: db.coding.feature_count, dtc: db.diagnostics.dtc_total,
      });
      return deepFreeze(db);
    })
    .catch(error => {
      cache = null; // allow a later retry
      throw error instanceof Error ? error : new Error(String(error));
    });
  return cache;
}

/** For tests only: inject a frozen fixture and reset between cases. */
export function __setW176DbForTest(db: W176Db | null): void {
  cache = db ? Promise.resolve(deepFreeze(db)) : null;
}
