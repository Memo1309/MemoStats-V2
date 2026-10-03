import { beforeEach, describe, expect, it } from 'vitest';
import { recordTransaction } from '../logs/transactions';
import { VEHICLE_MODULES, type VehicleModule } from '../vehicle/modules';
import type { ModuleResult } from './ecuScan';
import { cacheScanResults, cachedModuleName, discoveryState, findCachedModule, invalidateModuleCache, moduleCache, noteVehicleVin } from './moduleCache';

const byName = (name: string): VehicleModule => {
  const module = VEHICLE_MODULES.find(m => m.name === name);
  if (!module) throw new Error(`no ${name}`);
  return module;
};
const sccm = byName('SCCM166');
const tpm = byName('TPM_172');
const med40 = byName('MED40'); // 0x7E0 → 0x7E8
const park = byName('PARK117');
const result = (module: VehicleModule, status: ModuleResult['status']): ModuleResult =>
  ({ module, status, session: status === 'RESPONDS' ? 'ACCEPTED' : null, probeResponse: status === 'RESPONDS' ? '50 03 00 14 00 C8' : null, probeMs: 100, f100: null, opCode: null, variantMatches: null, ids: {}, error: null });
const request = (module: VehicleModule, outcome: 'positive' | 'negative' | 'none', kind: 'UDS' | 'OBD' | 'PROBE' = 'UDS') =>
  recordTransaction({
    kind, txId: module.txId, rxId: module.rxId, request: kind === 'OBD' ? '01 0D' : '19 01 0D', response: outcome === 'none' ? null : outcome === 'positive' ? '41 0D 00' : '7F 19 11',
    status: outcome, ok: outcome === 'positive', answered: outcome !== 'none', latencyMs: null, detail: {},
  });

describe('session module cache', () => {
  beforeEach(() => {
    invalidateModuleCache('test');
    cacheScanResults([result(sccm, 'RESPONDS'), result(tpm, 'RESPONDS'), result(med40, 'NO_ANSWER'), result(park, 'HOST_TIMEOUT')], 4, 1);
  });

  it('keeps confirmed modules and records every other candidate with its state', () => {
    const state = moduleCache.get();
    expect(state).toMatchObject({ valid: true, scanned: 4 });
    expect(state.modules.map(m => [m.module.name, m.confirmedBy, m.session])).toEqual([['SCCM166', '0x33', 'ACCEPTED'], ['TPM_172', '0x33', 'ACCEPTED']]);
    expect(state.unconfirmed.map(u => [u.module.name, u.state])).toEqual([['MED40', 'NO_RESPONSE'], ['PARK117', 'COMM_ERROR']]);
    expect(findCachedModule(sccm.txId, sccm.rxId)?.probeResponse).toBe('50 03 00 14 00 C8');
    expect(cachedModuleName(med40.txId, med40.rxId)).toBeUndefined();
  });

  it('maps probe outcomes to the three UI states', () => {
    const statuses: ModuleResult['status'][] = ['RESPONDS', 'NO_ANSWER', 'HOST_TIMEOUT', 'ERROR'];
    expect(statuses.map(discoveryState)).toEqual(['CONFIRMED', 'NO_RESPONSE', 'COMM_ERROR', 'COMM_ERROR']);
  });

  it('later timeouts never un-confirm a module; they are only counted', () => {
    for (let i = 0; i < 10; i++) request(sccm, 'none');
    expect(findCachedModule(sccm.txId, sccm.rxId)).toMatchObject({ confirmedBy: '0x33', consecutiveFailures: 10 });
    request(sccm, 'negative');
    expect(findCachedModule(sccm.txId, sccm.rxId)?.consecutiveFailures).toBe(0);
    expect(moduleCache.get().modules).toHaveLength(2);
  });

  it('0x33 silence is not absence: a positive 0x40 answer (MED40 01 0D on 0x7E0→0x7E8) confirms the module', () => {
    request(med40, 'none', 'OBD');
    request(med40, 'negative');
    request(med40, 'positive', 'PROBE');
    expect(findCachedModule(med40.txId, med40.rxId)).toBeUndefined();
    request(med40, 'positive', 'OBD');
    expect(findCachedModule(med40.txId, med40.rxId)).toMatchObject({ confirmedBy: '0x40', session: null, probeResponse: null });
    expect(moduleCache.get().unconfirmed.map(u => u.module.name)).toEqual(['PARK117']);
  });

  it('is cleared by disconnect / explicit rescan (invalidate)', () => {
    invalidateModuleCache('MBito disconnect');
    expect(moduleCache.get()).toMatchObject({ valid: false, modules: [], unconfirmed: [] });
  });

  it('is cleared when the VIN changes (vehicle change), not when it is first learned', () => {
    noteVehicleVin('1HGBH41JXMN109186');
    expect(moduleCache.get().valid).toBe(true);
    noteVehicleVin('1HGBH41JXMN109186');
    expect(moduleCache.get().valid).toBe(true);
    noteVehicleVin('WVWZZZ1JZXW000001');
    expect(moduleCache.get().valid).toBe(false);
  });
});
