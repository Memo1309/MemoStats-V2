import { describe, expect, it } from 'vitest';
import rawDb from '../../public/data/w176/memostats-w176-ecu-db-2026-09-29.json';
import { fromHex, toHex } from '../core/bytes';
import { MbitoClient } from '../core/mbito/mbitoClient';
import { FakeTransport } from '../testing/fakeDongle';
import type { W176Db } from '../w176/types';
import { mileageDeltas, readAllMileage } from './mileage';

const db = rawDb as unknown as W176Db;

function reply(tx: Uint8Array, bodyHex: string, respStatus = 0x00): Uint8Array<ArrayBuffer> {
  const header = tx.slice(4, 25);
  const body = fromHex(bodyHex);
  header[2] = respStatus;
  new DataView(header.buffer).setUint16(19, body.length, true);
  const len = 21 + body.length;
  return fromHex(`C0 01 ${(len & 0xff).toString(16).padStart(2, '0')} ${(len >> 8).toString(16).padStart(2, '0')} ${toHex(header)} ${bodyHex}`);
}

describe('mileage check — metadata-driven, factual only', () => {
  it('decodes EZS166 (×0.1), IC172 (×1) and MED40 (×2) from their DB measure commands', async () => {
    const transport = new FakeTransport();
    // 3 data bytes big-endian per source; DID echo precedes the data in the response body.
    const raw: Record<string, string> = {
      '220004': '62 00 04 00 27 10', // 0x2710 = 10000 * 0.1 = 1000.0 km  (EZS166)
      '220001': '62 00 01 00 27 25', // 0x2725 = 10021 * 1  = 10021 km    (IC172)
      '22010C': '62 01 0C 00 13 8A', // 0x138A = 5002 * 2   = 10004 km    (MED40)
    };
    transport.respond = tx => {
      const req = toHex(tx.subarray(25, 28)).replace(/ /g, '');
      const body = raw[req];
      if (body) transport.emit(reply(tx, body));
    };
    const readings = await readAllMileage(new MbitoClient(transport), db);
    const by = (ref: string) => readings.find(r => r.reference === ref);
    expect(by('ignition_mileage')).toMatchObject({ ecuName: 'EZS166', km: 1000, unit: 'km', error: null });
    expect(by('instrument_mileage')).toMatchObject({ km: 10021, error: null });
    expect(by('engine_mileage')).toMatchObject({ km: 10004, error: null });
    // factual deltas, no labelling
    const deltas = mileageDeltas(readings);
    expect(deltas.some(d => Math.abs(d.deltaKm) === Math.abs(10021 - 10004))).toBe(true);
  });

  it('surfaces a non-response as an error, never a fabricated value', async () => {
    const transport = new FakeTransport();
    transport.respond = tx => transport.emit(reply(tx, '', 0xfd)); // dongle full-timeout: ECU did not answer
    const readings = await readAllMileage(new MbitoClient(transport), db);
    expect(readings.length).toBeGreaterThan(0);
    for (const r of readings) {
      expect(r.km).toBeNull();
      expect(r.error).toBeTruthy();
    }
  });
});
