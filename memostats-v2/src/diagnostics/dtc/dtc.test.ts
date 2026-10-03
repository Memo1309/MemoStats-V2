import { describe, expect, it } from 'vitest';
import { fromHex, toHex } from '../../core/bytes';
import { MbitoClient } from '../../core/mbito/mbitoClient';
import { classifyUdsResponse } from '../../core/uds/udsSemantics';
import { FakeTransport, dongleReply } from '../../testing/fakeDongle';
import { VEHICLE_MODULES } from '../../vehicle/modules';
import { decodeStatus, parseDtcCount, parseDtcList } from './dtcCodec';
import { readModuleDtcs } from './dtcRead';

// VERIFIED REAL VEHICLE (user report + master spec §32/§59).
const MED40_LIST = '59 02 FF 05 2E 71 64 D4 57 00 64 06 DA 00 64';

describe('DTC list parsing', () => {
  it('fixture §59: exactly three MED40 DTCs, status 0x64', () => {
    const parsed = parseDtcList(fromHex(MED40_LIST), 'REGULAR_ECU');
    expect(parsed.kind).toBe('positive');
    expect(parsed.availabilityMask).toBe(0xff);
    expect(parsed.records.map(r => [r.code, r.statusByte])).toEqual([['P052E71', 0x64], ['U145700', 0x64], ['P06DA00', 0x64]]);
  });

  it('never slides: a trailing partial record is a warning, not a DTC', () => {
    const parsed = parseDtcList(fromHex(`${MED40_LIST} 12 34`), 'REGULAR_ECU');
    expect(parsed.records).toHaveLength(3);
    expect(parsed.warnings[0]).toMatch(/2 incomplete trailing bytes/);
  });

  it('CBCBOLERO 25 56 7B status 2B → P25567B', () => {
    expect(parseDtcList(fromHex('59 02 FF 25 56 7B 2B'), 'REGULAR_ECU').records[0]?.code).toBe('P25567B');
  });

  it('OLD_ECU_MANSPEC keeps the raw code', () => {
    expect(parseDtcList(fromHex('59 02 FF 90 01 23 08'), 'OLD_ECU_MANSPEC').records[0]?.code).toBe('900123');
  });

  it('an empty positive list clears the view (zero DTCs)', () => {
    expect(parseDtcList(fromHex('59 02 FF'), 'REGULAR_ECU')).toMatchObject({ kind: 'positive', records: [] });
  });

  it('negative and malformed responses never produce DTCs', () => {
    expect(parseDtcList(fromHex('7F 19 31'), 'REGULAR_ECU')).toMatchObject({ kind: 'negative', nrc: 0x31, records: [] });
    expect(parseDtcList(fromHex('62 F1 00 05 2E 71 64'), 'REGULAR_ECU')).toMatchObject({ kind: 'invalid', records: [] });
  });

  it('fixture §60: 7F 19 78 is pending, not "no response"', () => {
    expect(classifyUdsResponse(fromHex('19 02 0D'), fromHex('7F 19 78')).semantic).toBe('RESPONSE_PENDING');
  });

  it('decodes each status bit separately', () => {
    expect(decodeStatus(0x64)).toMatchObject({ pendingDTC: true, testFailedSinceLastClear: true, testNotCompletedThisOperationCycle: true, testFailed: false, confirmedDTC: false });
    expect(decodeStatus(0x08).testFailedSinceLastClear).toBe(false);
  });

  it('parses the real MED40 count reply 59 01 FF 01 00 03 → 3', () => {
    expect(parseDtcCount(fromHex('59 01 FF 01 00 03'))).toBe(3);
  });
});

describe('DTC read strategies', () => {
  const mod = (name: string) => {
    const found = VEHICLE_MODULES.find(m => m.name === name);
    if (!found) throw new Error(`missing ${name}`);
    return found;
  };
  const med40 = mod('MED40');
  const hvac = mod('HVAC246');

  function ecu(replies: Record<string, string>): FakeTransport {
    const transport = new FakeTransport();
    transport.respond = tx => transport.emit(dongleReply(tx, 0x00, replies[toHex(tx.subarray(25))] ?? ''));
    return transport;
  }

  it('REGULAR_ECU: count first, then the list', async () => {
    const transport = ecu({ '19 01 0D': '59 01 FF 01 00 03', '19 02 0D': MED40_LIST });
    const result = await readModuleDtcs(new MbitoClient(transport), med40);
    expect(transport.written.map(t => toHex(t.subarray(25)))).toEqual(['19 01 0D', '19 02 0D']);
    expect(result).toMatchObject({ status: 'OK', count: 3 });
    expect(result.records.map(r => r.code)).toEqual(['P052E71', 'U145700', 'P06DA00']);
  });

  it('REGULAR_ECU with count 0 never asks for the list', async () => {
    const transport = ecu({ '19 01 0D': '59 01 FF 01 00 00' });
    const result = await readModuleDtcs(new MbitoClient(transport), med40);
    expect(transport.written).toHaveLength(1);
    expect(result).toMatchObject({ status: 'OK', count: 0, records: [] });
  });

  it('OLD_ECU_MANSPEC goes straight to 19 02 0D', async () => {
    const transport = ecu({ '19 02 0D': '59 02 FF' });
    const result = await readModuleDtcs(new MbitoClient(transport), hvac);
    expect(transport.written.map(t => toHex(t.subarray(25)))).toEqual(['19 02 0D']);
    expect(result).toMatchObject({ family: 'OLD_ECU_MANSPEC', status: 'OK', records: [] });
  });

  it('a silent module is NO_ANSWER, not "no faults"', async () => {
    const transport = new FakeTransport();
    transport.respond = tx => transport.emit(dongleReply(tx, 0xfd, ''));
    const result = await readModuleDtcs(new MbitoClient(transport), med40);
    expect(result).toMatchObject({ status: 'NO_ANSWER', records: [] });
  });
});
