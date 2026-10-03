// ECU identity resolution for a present module (a separate stage from presence). The vehicle inventory
// record is an exact match (identified). Otherwise the catalog is matched by normalized TX/RX: one family
// = probable, several = unresolved. Identity NEVER affects presence.
import { matchEcuDefinitions } from '../w176/catalog';
import type { W176Db } from '../w176/types';
import type { VehicleModule } from '../vehicle/modules';
import { type IdentityStatus, identityStatusOf } from './presence';

export interface ModuleIdentity {
  status: IdentityStatus;
  /** best known name to show (exact when identified, single family when probable, else null) */
  name: string | null;
  variantName: string | null;
  possibleNames: string[];
}

export function moduleIdentity(db: W176Db | null, module: VehicleModule, opCodeRead?: string | null): ModuleIdentity {
  const hasRecord = Boolean(module.variantName && module.opCode); // this pair is one of our vehicle inventory ECUs
  const matches = db ? matchEcuDefinitions(db, module.txId, module.rxId) : [];
  const opCodeMatched = Boolean(opCodeRead && module.opCode && opCodeRead === module.opCode);
  const status = identityStatusOf({ hasInventory: hasRecord, possibleCount: matches.length, opCodeMatched });
  const name = hasRecord || opCodeMatched ? module.name : matches.length === 1 ? matches[0]?.name ?? null : null;
  return { status, name, variantName: module.variantName || null, possibleNames: matches.map(m => m.name) };
}
