import { describe, expect, it } from 'vitest';
import rawDb from '../../public/data/w176/memostats-w176-ecu-db-2026-09-29.json';
import { nn } from '../testing/nn';
import type { VehicleModule } from '../vehicle/modules';
import { canPairKey, formatCanId, toCanId } from './canId';
import { buildDetectedModules, matchEcuDefinitions, scanCandidates } from './catalog';
import type { W176Db } from './types';

const db = rawDb as unknown as W176Db;
const mod = (name: string, txId: number, rxId: number): { module: VehicleModule } => ({ module: { name, txId, rxId, variantName: '', opCode: '', group: '', type: 'REGULAR_ECU' } });

describe('W176 DB counts (adapter, not the JSON)', () => {
  it('exposes 119 ECU definitions and exactly 70 unique scan candidate pairs', () => {
    expect(db.w176_catalog.ecu_definitions).toHaveLength(119);
    const candidates = scanCandidates(db);
    expect(candidates).toHaveLength(70);
    expect(new Set(candidates.map(c => canPairKey(c.txId, c.rxId))).size).toBe(70);
  });
});

describe('canonical CAN id normalization', () => {
  it('treats "0x60a", "0x60A", 0x60A and 1546 as equal', () => {
    expect(toCanId('0x60a')).toBe(1546);
    expect(toCanId('0x60A')).toBe(1546);
    expect(toCanId(0x60a)).toBe(1546);
    expect(toCanId(1546)).toBe(1546);
    expect(new Set(['0x60a', '0x60A', 0x60a, 1546].map(toCanId)).size).toBe(1);
    expect(formatCanId('0x60a')).toBe('0x60A');
    expect(canPairKey('0x60A', '0x481')).toBe(canPairKey(1546, 1153));
  });
});

describe('catalog matching by TX/RX against the 119 ecu_definitions', () => {
  it('detected pair 0x60A/0x481 matches at least one definition (IC172 among them)', () => {
    const matches = matchEcuDefinitions(db, 0x60a, 0x481);
    expect(matches.length).toBeGreaterThanOrEqual(1);
    expect(matches.map(m => m.name)).toContain('IC172');
  });

  it('a pair shared by several definitions returns them all (still one address)', () => {
    const shared = scanCandidates(db).find(c => matchEcuDefinitions(db, c.txId, c.rxId).length > 1);
    expect(shared).toBeTruthy();
    expect(matchEcuDefinitions(db, nn(shared).txId, nn(shared).rxId).length).toBeGreaterThan(1);
  });
});

describe('buildDetectedModules — renders detected addresses with or without the DB', () => {
  it('a detected pair produces exactly one visible entry (even when several families share it)', () => {
    const detected = buildDetectedModules([mod('IC172', 0x60a, 0x481)], db);
    expect(detected).toHaveLength(1);
    expect(detected[0]).toMatchObject({ txId: 0x60a, rxId: 0x481, present: true });
    expect(nn(detected[0]).possibleEcus.map(e => e.name)).toContain('IC172');
  });

  it('renders detected addresses BEFORE the DB is available (scan name + pair, no family resolution)', () => {
    const detected = buildDetectedModules([mod('HERMES', 0x60b, 0x58b)], null);
    expect(detected).toHaveLength(1);
    expect(detected[0]).toMatchObject({ txId: 0x60b, rxId: 0x58b, present: true, scanName: 'HERMES', identity: null, identityStatus: 'unresolved' });
    expect(nn(detected[0]).possibleEcus).toEqual([]);
  });

  it('normalizes mixed-form CAN ids from the scan so nothing is dropped', () => {
    const detected = buildDetectedModules([mod('IC172', toCanId('0x60A'), toCanId('0x481'))], db);
    expect(nn(detected[0]).possibleEcus.map(e => e.name)).toContain('IC172');
  });

  it('every known real-vehicle pair maps to at least one displayable catalog family', () => {
    const known: [number, number, string][] = [
      [0x60a, 0x481, 'IC172'], [0x612, 0x482, 'EZS166'], [0x622, 0x484, 'SCCM166'], [0x642, 0x488, 'TPM_172'],
      [0x6f3, 0x4de, 'CBCBOLERO'], [0x76a, 0x4ad, 'HLI_FL176'], [0x772, 0x4ae, 'HLI_FR176'], [0x78a, 0x4b1, 'PARK117'],
    ];
    for (const [tx, rx, name] of known) {
      const matches = matchEcuDefinitions(db, tx, rx);
      expect(matches.length, `${formatCanId(tx)}→${formatCanId(rx)}`).toBeGreaterThanOrEqual(1);
      expect(matches.map(m => m.name)).toContain(name);
    }
  });
});
