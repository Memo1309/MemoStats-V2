import { describe, expect, it } from 'vitest';
import catalogSource from './sources/mbito-car43-ecu-catalog.json';
import vehicleSource from './sources/mbito-vehicle80903-ecus.json';
import evidence from './evidence.json';
import { type EcuCatalogue, buildEcuCatalogue, renderCatalogueMarkdown } from './ecuCatalogue';

const catalogue: EcuCatalogue = buildEcuCatalogue(catalogSource, vehicleSource, evidence);
const byName = (name: string) => catalogue.endpoints.find(e => e.currentVehicle?.name === name);

describe('W176 ECU catalogue', () => {
  it('keeps every raw record and deduplicates to physical endpoints', () => {
    expect(catalogue.summary).toMatchObject({ catalogRecords: 119, uniqueEndpoints: 70, variants: 3612, currentVehicleEcus: 23 });
  });

  it('matches all 23 vehicle ECUs to a catalog endpoint, record and variant', () => {
    const current = catalogue.endpoints.filter(e => e.currentVehicle);
    expect(current).toHaveLength(23);
    expect(current.flatMap(e => e.warnings)).toEqual([]);
    expect(catalogue.issues.filter(i => i.startsWith('vehicle ECU'))).toEqual([]);
  });

  it('keeps aliases sharing one endpoint together (probed once, not five times)', () => {
    const engine = byName('MED40');
    expect(engine?.key).toBe('0x7E0/0x7E8');
    expect(engine?.names).toEqual(expect.arrayContaining(['MED40', 'MED40AMG', 'CRD', 'CRD3', 'CRR1']));
  });

  it('marks 22 ECUs detected by the official scan and CBCBOLERO confirmed only by other real replies', () => {
    expect(catalogue.summary.confirmedOnRealCar).toBe(23);
    expect(byName('CBCBOLERO')?.onThisCar.detail).toMatch(/^Not detected/);
    expect(byName('HERMES')?.onThisCar.detail).toMatch(/^Detected by the official MBito scan/);
  });

  it('carries the exact official request parameters from the raw capture', () => {
    const f100 = byName('SCCM166')?.knownRequests.find(r => r.uds === '22 F1 00' && r.level === 'CONFIRMED_FROM_OFFICIAL_CAPTURE');
    expect(f100).toMatchObject({ timeoutMs: 200, expectedResponseLength: 7, delayAfterMs: 0, response: '62 F1 00 00 05 08 03', rawTransport: '0x00 OK' });
    expect(byName('PARK117')?.knownRequests.find(r => r.uds === '22 F1 8C')).toMatchObject({ timeoutMs: 600, expectedResponseLength: 6, responseAscii: '30400731715704432' });
    expect(byName('SCCM166')?.sessions[0]?.response).toBe('50 03 00 14 00 C8');
    expect(catalogue.endpoints.filter(e => e.inOfficialCapture && e.currentVehicle).map(e => e.currentVehicle?.name).sort())
      .toEqual(['PARK117', 'SCCM166', 'TPM_172']);
  });

  it('places every official scan probe on a catalog endpoint', () => {
    expect(catalogue.issues.filter(i => i.startsWith('official probe'))).toEqual([]);
    expect(catalogue.summary.officialProbeNoResponse).toBe(18);
  });

  it('records the failed V2 MED40 test as evidence, not as absence', () => {
    const v2 = byName('MED40')?.knownRequests.find(r => r.rawTransport === '0xFD');
    expect(v2?.response).toBeNull();
    expect(byName('MED40')?.onThisCar.level).toBe('CONFIRMED_ON_REAL_CAR');
  });

  it('reports malformed source op codes instead of fixing them', () => {
    expect(catalogue.issues.some(i => i.includes('CRD variant 18899') && i.includes('4.80E+01'))).toBe(true);
  });

  it('generated files are in sync (npm run catalogue rewrites them)', async () => {
    await expect(JSON.stringify(catalogue, null, 2) + '\n').toMatchFileSnapshot('./ecu-catalogue.generated.json');
    await expect(renderCatalogueMarkdown(catalogue)).toMatchFileSnapshot('../../../docs/W176-ECUS.md');
    // compact list the app bundles for the retrofit scan (CAUTĂ MODULE NOI)
    const others = catalogue.endpoints.filter(e => !e.currentVehicle).map(e => ({ txId: e.txId, rxId: e.rxId, names: e.names, types: e.types, groups: [...new Set(e.records.map(r => r.group))] }));
    await expect(JSON.stringify(others, null, 1) + '\n').toMatchFileSnapshot('./other-endpoints.generated.json');
  });
});
