import { describe, expect, it } from 'vitest';
import rawDb from '../../public/data/w176/memostats-w176-ecu-db-2026-09-29.json';
import type { VehicleModule } from '../vehicle/modules';
import type { W176Db } from '../w176/types';
import { moduleIdentity } from './identity';
import { identityStatusOf, presenceFromModuleStatus, presenceReason } from './presence';

const db = rawDb as unknown as W176Db;
const mod = (over: Partial<VehicleModule>): VehicleModule => ({ name: 'X', txId: 0x60a, rxId: 0x481, variantName: '', opCode: '', group: '', type: 'REGULAR_ECU', ...over });

describe('presence is independent of identity', () => {
  it('any responding status is PRESENT; zero slot is absent; no B3 / error is error', () => {
    expect(presenceFromModuleStatus('RESPONDS')).toBe('present');
    expect(presenceFromModuleStatus('NO_ANSWER')).toBe('absent');
    expect(presenceFromModuleStatus('HOST_TIMEOUT')).toBe('error');
    expect(presenceFromModuleStatus('ERROR')).toBe('error');
  });

  it('a negative-UDS session reply is still PRESENT, with a reason that says so', () => {
    expect(presenceFromModuleStatus('RESPONDS')).toBe('present'); // 7F 10 -> RESPONDS
    expect(presenceReason('RESPONDS', 'REJECTED', '7F 10 12')).toMatch(/negativ|prezent/i);
  });
});

describe('identity is a separate state and never changes presence', () => {
  it('a vehicle inventory record (variant + op code) is IDENTIFIED', () => {
    expect(identityStatusOf({ hasInventory: true, possibleCount: 3 })).toBe('identified');
    const id = moduleIdentity(db, mod({ name: 'IC172', variantName: 'IC_MFA_AeJ17', opCode: '00240B' }));
    expect(id.status).toBe('identified');
    expect(id.name).toBe('IC172');
  });

  it('a pair with one catalog family and no inventory record is PROBABLE', () => {
    // 0x743/0x4E8 CTRLC5S1 is a scan candidate; find one that maps to exactly one definition and is not inventory
    const single = db.w176_catalog.scan_candidates.find(c => {
      const t = parseInt(c.transmit_id, 16), r = parseInt(c.receive_id, 16);
      const defs = db.w176_catalog.ecu_definitions.filter(e => parseInt(e.transmit_id, 16) === t && parseInt(e.receive_id, 16) === r);
      const inInventory = db.inventory.latest_ecus.some(e => parseInt(e.transmit_id, 16) === t);
      return defs.length === 1 && !inInventory;
    });
    if (single) {
      const t = parseInt(single.transmit_id, 16), r = parseInt(single.receive_id, 16);
      const id = moduleIdentity(db, mod({ name: single.possible_modules[0]?.name ?? '', txId: t, rxId: r }));
      expect(id.status).toBe('probable');
    }
    expect(identityStatusOf({ hasInventory: false, possibleCount: 1 })).toBe('probable');
  });

  it('a pair shared by several families with no inventory record is UNRESOLVED but still displayable', () => {
    expect(identityStatusOf({ hasInventory: false, possibleCount: 3 })).toBe('unresolved');
    const id = moduleIdentity(db, mod({ name: 'IC172 / IC_204 / IC197', txId: 0x60a, rxId: 0x481 }));
    // 0x60A/0x481 maps to 3 catalog families and there is no inventory record for this bare module
    expect(id.status).toBe('unresolved');
    expect(id.possibleNames.length).toBeGreaterThan(1);
  });

  it('identity resolution works even when the DB is not loaded (null) — presence stays independent', () => {
    const id = moduleIdentity(null, mod({ name: 'HERMES', txId: 0x60b, rxId: 0x58b }));
    expect(id.status).toBe('unresolved'); // no catalog available yet
    expect(presenceFromModuleStatus('RESPONDS')).toBe('present'); // still present
  });
});
