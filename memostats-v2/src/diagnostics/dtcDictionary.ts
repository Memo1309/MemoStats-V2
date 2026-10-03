// DTC dictionary from the immutable DB (spec §19). These are DEFINITIONS, not active faults. When an
// active fault is read from an ECU, look it up here by ECU id + fault code to enrich it with a
// description. Never invents a description: an unknown code stays unknown.
import type { W176Db, W176DtcDefinition } from '../w176/types';

export interface DtcDictionaryEntry {
  readonly faultCode: string;
  readonly description: string;
}

/** Total definition count and per-ECU counts, for the "known definitions" vs "active faults" distinction. */
export function dtcDictionaryStats(db: W176Db): { total: number; byEcu: Readonly<Record<string, number>> } {
  return { total: db.diagnostics.dtc_total, byEcu: db.diagnostics.dtc_counts_by_ecu };
}

function describe(def: W176DtcDefinition): string {
  return def.fault_description || def.fault_description_en || '';
}

/**
 * Looks up a fault code in an ECU's definitions. DB codes are 7 chars (SAE 5-char + 2-char detail),
 * active reads may give the 5-char SAE code; match exactly first, then by the 5-char prefix.
 */
export function lookupDtc(db: W176Db, ecuId: number | undefined, code: string): DtcDictionaryEntry | null {
  if (ecuId === undefined) return null;
  const defs = db.diagnostics.dtc_definitions_by_ecu[String(ecuId)];
  if (!defs) return null;
  const wanted = code.toUpperCase().replace(/\s/g, '');
  const exact = defs.find(d => d.fault_code.toUpperCase() === wanted);
  if (exact) return { faultCode: exact.fault_code, description: describe(exact) };
  const prefix = wanted.slice(0, 5);
  const byPrefix = defs.find(d => d.fault_code.toUpperCase().startsWith(prefix));
  return byPrefix ? { faultCode: byPrefix.fault_code, description: describe(byPrefix) } : null;
}
