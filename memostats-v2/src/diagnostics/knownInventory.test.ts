import { beforeEach, describe, expect, it } from 'vitest';
import rawDb from '../../public/data/w176/memostats-w176-ecu-db-2026-09-29.json';
import type { W176Db } from '../w176/types';
import type { CachedModule } from './moduleCache';
import { buildExplorerEntries } from './explorerView';
import { moduleKey } from './inventoryHistory';
import { type PresentIdentity, clearKnownInventory, knownInventoryStore, recordScanIntoKnownInventory } from './knownInventory';

const db = rawDb as unknown as W176Db;

// The 23 present pairs from the real scan (subset of fields needed to persist identity).
const PAIRS: [number, number, string, string][] = [
  [0x60a, 0x481, 'IC172', '00240B'], [0x60b, 0x58b, 'HERMES', '000435'], [0x612, 0x482, 'EZS166', '020403'],
  [0x622, 0x484, 'SCCM166', '000508'], [0x632, 0x486, 'ESP9MFA', '00070A'], [0x642, 0x488, 'TPM_172', '003007'],
  [0x64a, 0x489, 'ORC166', '00400B'], [0x652, 0x48a, 'HU5S1', '027302'], [0x65a, 0x48b, 'FCW246', '000306'],
  [0x68b, 0x4d1, 'KG212M', '000012'], [0x6a2, 0x494, 'SMPC212', '000210'], [0x6a3, 0x4d4, 'HVAC246', '007116'],
  [0x6b2, 0x496, 'EPS246', '000201'], [0x6f3, 0x4de, 'CBCBOLERO', '02E608'], [0x6fa, 0x49f, 'FSCM212', '001D03'],
  [0x703, 0x4e0, 'DMFL166', '00040C'], [0x70b, 0x4e1, 'DMFR166', '00040C'], [0x732, 0x4a6, 'EPKB166', '00000D'],
  [0x743, 0x4e8, 'CTRLC5S1', '00E000'], [0x76a, 0x4ad, 'HLI_FL176', '001101'], [0x772, 0x4ae, 'HLI_FR176', '001101'],
  [0x78a, 0x4b1, 'PARK117', '004501'], [0x7e0, 0x7e8, 'MED40', '022857'],
];
const present = (rows: typeof PAIRS): PresentIdentity[] =>
  rows.map(([tx, rx, name, op]) => ({ key: moduleKey(tx, rx), txId: tx, rxId: rx, scanName: name, opCode: op, hardware: '1769018902', software: null, serialRawHex: null, serialText: null }));
const cached = (rows: typeof PAIRS): CachedModule[] =>
  rows.map(([tx, rx, name, op]) => ({ module: { name, txId: tx, rxId: rx, variantName: '', opCode: '', group: '', type: 'REGULAR_ECU' }, confirmedBy: '0x33', session: 'ACCEPTED', consecutiveFailures: 0, probeResponse: '50 03 00 14 00 C8', f100: null, opCode: op, variantMatches: null, ids: {}, lastAnsweredAt: 1 }));
const allKeys = new Set(PAIRS.map(([tx, rx]) => moduleKey(tx, rx)));

describe('knownVehicleInventory persistence (separate from currentScanInventory)', () => {
  beforeEach(() => clearKnownInventory());

  it('scan A detects 23 → known inventory holds 23, all present, identity stored', () => {
    recordScanIntoKnownInventory(present(PAIRS), allKeys);
    const ecus = knownInventoryStore.get().ecus;
    expect(Object.keys(ecus)).toHaveLength(23);
    expect(Object.values(ecus).every(e => e.lastScanStatus === 'present' && e.seenCount === 1)).toBe(true);
    expect(ecus[moduleKey(0x7e0, 0x7e8)]?.opCode).toBe('022857'); // MED40 kept
  });

  it('scan B detects only 11 → known stays 23; the 12 kept as not_detected with identity, seen/miss updated', () => {
    recordScanIntoKnownInventory(present(PAIRS), allKeys); // scan A: 23
    const eleven = PAIRS.slice(0, 11);
    recordScanIntoKnownInventory(present(eleven), allKeys); // scan B: 11 (all 70 probed)

    const ecus = knownInventoryStore.get().ecus;
    expect(Object.keys(ecus)).toHaveLength(23); // NOT deleted
    const detected = Object.values(ecus).filter(e => e.lastScanStatus === 'present');
    const notDetected = Object.values(ecus).filter(e => e.lastScanStatus === 'not_detected');
    expect(detected).toHaveLength(11);
    expect(notDetected).toHaveLength(12);
    // present ones: seenCount 2, miss 0; not-detected ones: seenCount 1, miss 1, identity retained
    expect(ecus[moduleKey(0x60a, 0x481)]).toMatchObject({ seenCount: 2, missCount: 0, lastScanStatus: 'present' });
    expect(ecus[moduleKey(0x7e0, 0x7e8)]).toMatchObject({ seenCount: 1, missCount: 1, lastScanStatus: 'not_detected', opCode: '022857' });
  });

  it('a not-detected module is never removed and keeps its opCode/hardware for later resolution', () => {
    recordScanIntoKnownInventory(present(PAIRS), allKeys);
    recordScanIntoKnownInventory(present(PAIRS.slice(0, 11)), allKeys);
    const med = knownInventoryStore.get().ecus[moduleKey(0x7e0, 0x7e8)];
    expect(med?.opCode).toBe('022857');
    expect(med?.hardware).toBe('1769018902');
  });
});

describe('ECU Explorer merge (known + current scan)', () => {
  beforeEach(() => clearKnownInventory());

  it('detected-now vs not-detected states; MED40 identified; nothing dropped', () => {
    recordScanIntoKnownInventory(present(PAIRS), allKeys); // known = 23
    const current = cached(PAIRS.slice(0, 11)); // this scan only 11 replied
    const entries = buildExplorerEntries(knownInventoryStore.get().ecus, current, db);

    expect(entries).toHaveLength(23);
    expect(entries.filter(e => e.state === 'detected_now')).toHaveLength(11);
    expect(entries.filter(e => e.state === 'not_detected')).toHaveLength(12);
    // all 23 resolve to identified from the catalog (op-code carried by known or current)
    expect(entries.every(e => e.identity?.status === 'identified')).toBe(true);
    const med = entries.find(e => e.txId === 0x7e0);
    expect(med).toMatchObject({ state: 'not_detected', opCode: '022857' });
    expect(med?.identity).toMatchObject({ ecuName: 'MED40', variantId: 14694 });
  });

  it('with no scan yet the explorer has no entries', () => {
    expect(buildExplorerEntries({}, [], db)).toEqual([]);
  });
});
