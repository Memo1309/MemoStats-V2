// Builds CodingTarget records (the ECU a coding operation runs against) from the immutable inventory.
import { inventoryEcus, parseCanId } from '../w176/catalog';
import type { W176Db, W176InventoryEcu } from '../w176/types';
import type { CodingTarget } from './codingEngine';

export function targetFromInventory(ecu: W176InventoryEcu): CodingTarget {
  return {
    ecuId: ecu.ecu_id, ecuName: ecu.display_name || ecu.name, variantId: ecu.variant_id, variantName: ecu.variant_name,
    txId: parseCanId(ecu.transmit_id), rxId: parseCanId(ecu.receive_id),
    hardwareNumber: ecu.hardware_number ?? null, softwareNumber: ecu.software_number ?? null,
  };
}

/** CodingTarget for an inventory ECU id, or null when the ECU is not in our inventory. */
export function inventoryEcuTarget(db: W176Db, ecuId: number): CodingTarget | null {
  const ecu = inventoryEcus(db).find(e => e.ecu_id === ecuId);
  return ecu ? targetFromInventory(ecu) : null;
}

/** CodingTarget for a confirmed CAN pair, when that pair is one of our inventory ECUs. */
export function inventoryTargetByCan(db: W176Db, txId: number, rxId: number): CodingTarget | null {
  const ecu = inventoryEcus(db).find(e => parseCanId(e.transmit_id) === txId && parseCanId(e.receive_id) === rxId);
  return ecu ? targetFromInventory(ecu) : null;
}
