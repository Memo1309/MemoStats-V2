import { describe, expect, it } from 'vitest';
import { nn } from '../testing/nn';
import rawDb from '../../public/data/w176/memostats-w176-ecu-db-2026-09-29.json';
import type { W176Db } from '../w176/types';
import { dtcDictionaryStats, lookupDtc } from './dtcDictionary';

const db = rawDb as unknown as W176Db;

describe('DTC dictionary (definitions, not active faults)', () => {
  it('reports the combined definition total and per-ECU counts', () => {
    const stats = dtcDictionaryStats(db);
    expect(stats.total).toBe(2892);
    expect(stats.byEcu['963']).toBeGreaterThan(0); // MED40 has definitions
  });

  it('looks up a real MED40 code exactly and by 5-char SAE prefix', () => {
    const defs = nn(db.diagnostics.dtc_definitions_by_ecu['963']);
    const sample = nn(defs[0]);
    expect(lookupDtc(db, 963, sample.fault_code)?.description).toBe(sample.fault_description || sample.fault_description_en);
    // an active read may give only the 5-char SAE code; prefix match still finds a definition
    expect(lookupDtc(db, 963, sample.fault_code.slice(0, 5))).toBeTruthy();
  });

  it('returns null for an unknown code or ECU — never invents a description', () => {
    expect(lookupDtc(db, 963, 'Z999999')).toBeNull();
    expect(lookupDtc(db, 999999, 'U011D00')).toBeNull();
    expect(lookupDtc(db, undefined, 'U011D00')).toBeNull();
  });
});
