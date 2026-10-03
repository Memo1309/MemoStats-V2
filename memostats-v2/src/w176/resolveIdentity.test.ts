import { describe, expect, it } from 'vitest';
import rawDb from '../../public/data/w176/memostats-w176-ecu-db-2026-09-29.json';
import { fromHex } from '../core/bytes';
import { decodeFrame } from '../core/mbito/frame';
import { decodeExecUdsResponse } from '../core/uds/execUds';
import { classifyUdsResponse, presenceOf } from '../core/uds/udsSemantics';
import { asciiIfPrintable, didValue } from '../diagnostics/ecuScan';
import { opCodeFromF100 } from '../vehicle/identification/opCode';
import { resolveIdentity } from './catalog';
import type { W176Db } from './types';

const db = rawDb as unknown as W176Db;

// The real-car scan (2026-09-30): 11 present pairs, each with the op-code read from F100. The resolver must
// obtain the expected ECU + variant from the immutable catalog by TX/RX + op_code (not from a hardcoded list).
const REAL: [number, number, string, string, number][] = [
  [0x60a, 0x481, '00240B', 'IC172', 11497],
  [0x60b, 0x58b, '000435', 'HERMES', 9718],
  [0x612, 0x482, '020403', 'EZS166', 18168],
  [0x622, 0x484, '000508', 'SCCM166', 16184],
  [0x632, 0x486, '00070A', 'ESP9MFA', 9385],
  [0x642, 0x488, '003007', 'TPM_172', 17348],
  [0x64a, 0x489, '00400B', 'ORC166', 15476],
  [0x652, 0x48a, '027302', 'HU5S1', 18199],
  [0x65a, 0x48b, '000306', 'FCW246', 18169],
  [0x68b, 0x4d1, '000012', 'KG212M', 11749],
  [0x6a2, 0x494, '000210', 'SMPC212', 16857],
  [0x6a3, 0x4d4, '007116', 'HVAC246', 10955],
  [0x6b2, 0x496, '000201', 'EPS246', 9287],
  [0x6f3, 0x4de, '02E608', 'CBCBOLERO', 7537],
  [0x6fa, 0x49f, '001D03', 'FSCM212', 9566],
  [0x703, 0x4e0, '00040C', 'DMFL166', 8558],
  [0x70b, 0x4e1, '00040C', 'DMFR166', 8623],
  [0x732, 0x4a6, '00000D', 'EPKB166', 9106],
  [0x743, 0x4e8, '00E000', 'CTRLC5S1', 8361],
  [0x76a, 0x4ad, '001101', 'HLI_FL176', 9738],
  [0x772, 0x4ae, '001101', 'HLI_FR176', 9766],
  [0x78a, 0x4b1, '004501', 'PARK117', 15539],
  [0x7e0, 0x7e8, '022857', 'MED40', 14694],
]

describe('identity resolver — all 23 real-car op-codes → catalog ECU + variant', () => {
  it('resolves all 23 present pairs to identified', () => {
    expect(REAL).toHaveLength(23);
    for (const [tx, rx, op, name, vid] of REAL) {
      const r = resolveIdentity(db, tx, rx, op);
      expect(r.status, name).toBe('identified');
      expect(r.ecuName, name).toBe(name);
      expect(r.variantId, name).toBe(vid);
    }
  });
  it.each(REAL)('%s/%s op %s → identified', (tx, rx, op, name, variantId) => {
    const r = resolveIdentity(db, tx, rx, op);
    expect(r.status).toBe('identified');
    expect(r.ecuName).toBe(name);
    expect(r.variantId).toBe(variantId);
    expect(r.opCode).toBe(op);
  });

  it('the same op-code 00040C on two different TX resolves to DMFL166 vs DMFR166 (TX/RX disambiguates)', () => {
    expect(resolveIdentity(db, 0x703, 0x4e0, '00040C').ecuName).toBe('DMFL166');
    expect(resolveIdentity(db, 0x70b, 0x4e1, '00040C').ecuName).toBe('DMFR166');
  });

  it('a present pair with NO op-code (identify failed) stays PRESENT with probable/unresolved identity', () => {
    // 0x60A/0x481 is shared by 3 families → unresolved without an op-code
    const noOp = resolveIdentity(db, 0x60a, 0x481, null);
    expect(noOp.status).toBe('unresolved');
    expect(noOp.possibleEcus.map(e => e.name)).toContain('IC172');
    // a pair with a single catalog family → probable
    const single = resolveIdentity(db, 0x703, 0x4e0, null);
    expect(single.status).toBe('probable');
    expect(single.ecuName).toBe('DMFL166');
  });

  it('op-code F100 parsing takes the 3 bytes after F1 00 and ignores the trailing byte', () => {
    expect(opCodeFromF100(fromHex('62 F1 00 00 24 0B 03'))).toBe('00240B');
    expect(opCodeFromF100(fromHex('62 F1 00 02 E6 08 03'))).toBe('02E608');
    expect(opCodeFromF100(fromHex('62 F1 00 00 00 0D 03'))).toBe('00000D');
    expect(opCodeFromF100(fromHex('62 F1 00 02 28 57 03'))).toBe('022857'); // MED40
    for (const op of ['000508', '00070A', '003007', '00400B', '027302', '000306', '000210', '007116', '001D03', '00E000', '004501']) {
      const b = fromHex(`62 F1 00 ${op.slice(0,2)} ${op.slice(2,4)} ${op.slice(4,6)} 03`);
      expect(opCodeFromF100(b)).toBe(op);
    }
  });

  it('F18C keeps raw hex always, ASCII text only when printable; F111 hardware decodes to ASCII', () => {
    // HERMES serial M090H3767965 (ASCII)
    const serial = didValue(fromHex('62 F1 8C 4D 30 39 30 48 33 37 36 37 39 36 35'));
    expect(serial).toMatchObject({ raw: '4D 30 39 30 48 33 37 36 37 39 36 35', text: 'M090H3767965' });
    // binary F18C keeps text null
    expect(didValue(fromHex('62 F1 8C 00 01 FF'))?.text).toBeNull();
    // F111 hardware ASCII
    expect(didValue(fromHex('62 F1 11 31 37 36 39 30 31 38 39 30 32'))?.text).toBe('1769018902');
    expect(asciiIfPrintable(fromHex('31 37 36 39'))).toBe('1769');
  });
});

describe('identification transport statuses never downgrade presence', () => {
  const uds = (hex: string) => decodeExecUdsResponse(decodeFrame(fromHex(hex)).payload);

  it('FE + a positive 62 payload is a valid POSITIVE, PRESENT response', () => {
    const r = uds('C0 01 22 00 00 00 FE 60 0A 00 00 81 04 00 00 58 02 00 00 06 00 03 00 0D 00 62 F1 11 31 37 36 39 30 31 38 39 30 32');
    expect(r.transportStatus).toBe('PARTIAL_TIMEOUT');
    const { semantic } = classifyUdsResponse(fromHex('22 F1 11'), r.udsBody);
    expect(semantic).toBe('POSITIVE_RESPONSE');
    expect(presenceOf(semantic)).toBe('PRESENT');
  });

  it('FD + 7F 22 78 is RESPONSE_PENDING (still present), not discarded', () => {
    const r = uds('C0 01 18 00 00 01 FD 60 0B 00 00 8B 05 00 00 58 02 00 00 06 00 03 00 03 00 7F 22 78');
    expect(r.transportStatus).toBe('FULL_TIMEOUT');
    const { semantic } = classifyUdsResponse(fromHex('22 F1 21'), r.udsBody);
    expect(semantic).toBe('RESPONSE_PENDING');
    expect(presenceOf(semantic)).toBe('PRESENT');
  });

  it('FF + 7F 22 31 is NEGATIVE_RESPONSE (still present)', () => {
    const r = uds('C0 01 18 00 00 01 FF 12 06 00 00 82 04 00 00 58 02 00 00 06 00 03 00 03 00 7F 22 31');
    const { semantic, nrc } = classifyUdsResponse(fromHex('22 F1 21'), r.udsBody);
    expect(semantic).toBe('NEGATIVE_RESPONSE');
    expect(nrc).toBe(0x31);
    expect(presenceOf(semantic)).toBe('PRESENT');
  });
});
