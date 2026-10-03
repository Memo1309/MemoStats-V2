import { describe, expect, it } from 'vitest';
import { fromHex } from '../bytes';
import { decodeReadiness, decodeVin } from './readiness';

describe('OBD readiness (01 01)', () => {
  it('decodes MIL, emission DTC count and spark monitors', () => {
    const r = decodeReadiness(fromHex('41 01 83 07 E5 01'));
    expect(r).toMatchObject({ milOn: true, emissionDtcCount: 3, ignition: 'spark' });
    const byName = Object.fromEntries((r?.monitors ?? []).map(m => [m.name, m]));
    expect(byName['Catalizator']).toEqual({ name: 'Catalizator', supported: true, complete: false });
    expect(byName['Sistem EVAP']).toMatchObject({ supported: true, complete: true });
    expect(byName['Aer secundar']?.supported).toBe(false);
    expect(byName['Rateuri (misfire)']).toMatchObject({ supported: true, complete: true });
  });

  it('rejects anything but a 41 01 reply', () => {
    expect(decodeReadiness(fromHex('41 0D 00'))).toBeNull();
    expect(decodeReadiness(fromHex('7F 01 12'))).toBeNull();
  });
});

describe('VIN (09 02)', () => {
  it('decodes 49 02 01 + 17 characters', () => {
    const vin = '1HGBH41JXMN109186';
    const body = fromHex(`49 02 01 ${[...vin].map(c => c.charCodeAt(0).toString(16)).join(' ')}`);
    expect(decodeVin(body)).toBe(vin);
  });

  it('rejects short or non-VIN payloads', () => {
    expect(decodeVin(fromHex('49 02 01 41 42'))).toBeNull();
  });
});
