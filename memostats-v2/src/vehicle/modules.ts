import { hexId } from '../core/bytes';
// Named import: Vite tree-shakes the rest of the record (VIN etc.) out of the bundle.
import { ecus } from '../data/w176/sources/mbito-vehicle80903-ecus.json';

export interface VehicleModule {
  name: string;
  txId: number;
  rxId: number;
  variantName: string;
  opCode: string;
  group: string;
  /** MBito ECU type: REGULAR_ECU / OLD_ECU / OLD_ECU_MANSPEC — selects the DTC strategy */
  type: string;
}

/** The 23 ECUs MBito has on record for this car (GetUserVehiclesGqlQuery), in CAN-id order. */
export const VEHICLE_MODULES: readonly VehicleModule[] = ecus
  .map(e => ({ name: e.ecuName, txId: e.transmitIdNumeric, rxId: e.receiveIdNumeric, variantName: e.variantName, opCode: e.opCode, group: e.group, type: e.type }))
  .sort((a, b) => a.txId - b.txId);

/** Human name for a CAN pair, falling back to the ids. */
export function moduleName(txId?: number, rxId?: number): string {
  if (txId === undefined) return 'MBito';
  return VEHICLE_MODULES.find(m => m.txId === txId && m.rxId === rxId)?.name ?? `${hexId(txId)}→${hexId(rxId ?? 0)}`;
}

/** Last full result known before V2 (official MBito scan, 2026-09-17; see evidence.json). */
export const LAST_KNOWN_SCAN = { detected: 22, expected: 23, date: '17.09.2026', missing: 'CBCBOLERO' } as const;
