// Adapter over the immutable DB: turns the raw JSON into the lookups the ECU Explorer and coding
// engine need. Nothing here mutates the DB; every returned array is a fresh projection.
import { type IdentityStatus, identityStatusOf } from '../diagnostics/presence';
import type { VehicleModule } from '../vehicle/modules';
import { canPairKey, toCanId } from './canId';
import type { W176Db, W176EcuDefinition, W176InventoryEcu, W176ScanCandidate } from './types';

/** Canonical CAN-id normalization (hex string or number -> number). Kept as parseCanId for existing callers. */
export const parseCanId = toCanId;

export const canKey = (txId: number, rxId: number): string => canPairKey(txId, rxId);

/** All inventory ECUs (latest first, then the supplemental MED40 record). */
export function inventoryEcus(db: W176Db): readonly W176InventoryEcu[] {
  return [...db.inventory.latest_ecus, ...db.inventory.supplemental_ecus];
}

/** The 70 official scan candidates as numeric CAN pairs plus their possible modules. */
export interface ScanCandidate {
  readonly txId: number;
  readonly rxId: number;
  readonly candidate: W176ScanCandidate;
}
export function scanCandidates(db: W176Db): readonly ScanCandidate[] {
  return db.w176_catalog.scan_candidates.map(candidate => ({
    txId: parseCanId(candidate.transmit_id),
    rxId: parseCanId(candidate.receive_id),
    candidate,
  }));
}

/** What we know about a CAN pair: the confirmed inventory ECU/variant if present, else the catalog's
 * possible modules (a pair can be shared by several families — TX/RX alone does not identify one). */
export interface ResolvedEcu {
  readonly txId: number;
  readonly rxId: number;
  /** the specific ECU + variant from the vehicle inventory, when this pair is one of ours */
  readonly inventory: W176InventoryEcu | null;
  /** every family that could sit on this pair, from the W176 catalog */
  readonly possibleModules: W176ScanCandidate['possible_modules'];
}

export function resolveEcu(db: W176Db, txId: number, rxId: number): ResolvedEcu {
  const inventory = inventoryEcus(db).find(e => parseCanId(e.transmit_id) === txId && parseCanId(e.receive_id) === rxId) ?? null;
  const candidate = db.w176_catalog.scan_candidates.find(c => parseCanId(c.transmit_id) === txId && parseCanId(c.receive_id) === rxId);
  return { txId, rxId, inventory, possibleModules: candidate?.possible_modules ?? [] };
}

/** Best display name for a pair: the inventory ECU, else the single/first catalog candidate, else the id. */
export function ecuLabel(resolved: ResolvedEcu): string {
  if (resolved.inventory) return resolved.inventory.display_name || resolved.inventory.name;
  if (resolved.possibleModules.length === 1) return resolved.possibleModules[0]?.display_name ?? '';
  if (resolved.possibleModules.length > 1) return resolved.possibleModules.map(m => m.name).join(' / ');
  return `0x${resolved.txId.toString(16).toUpperCase()}`;
}

/** DTC dictionary size for an ECU id (0 when the DB has no definitions for it). */
export function dtcDefinitionCount(db: W176Db, ecuId: number | undefined): number {
  if (ecuId === undefined) return 0;
  return db.diagnostics.dtc_counts_by_ecu[String(ecuId)] ?? 0;
}

/** A lightweight ECU-definition match for a CAN pair (a pair may map to several families). */
export interface EcuDefinitionMatch {
  readonly ecuId: number;
  readonly name: string;
  readonly displayName: string;
  readonly description: string;
  readonly group: string;
}

/** Every W176 catalog ECU definition (of 119) whose TX/RX equals this pair, normalized. */
export function matchEcuDefinitions(db: W176Db, txId: number, rxId: number): EcuDefinitionMatch[] {
  return ecuDefinitionsForPair(db, txId, rxId)
    .map(e => ({ ecuId: e.id, name: e.name, displayName: e.display_name || e.name, description: e.description, group: e.group }));
}

/** The full catalog ECU definitions (with their variants) whose TX/RX equals this pair. */
export function ecuDefinitionsForPair(db: W176Db, txId: number, rxId: number): W176EcuDefinition[] {
  return db.w176_catalog.ecu_definitions.filter((e: W176EcuDefinition) => toCanId(e.transmit_id) === txId && toCanId(e.receive_id) === rxId);
}

const normOp = (op: string | null | undefined): string => (op ?? '').toUpperCase().replace(/\s/g, '');

export interface ResolvedIdentity {
  status: IdentityStatus;
  ecuId: number | null;
  ecuName: string | null;
  displayName: string | null;
  description: string | null;
  group: string | null;
  variantId: number | null;
  variantName: string | null;
  /** the op-code that produced an exact match (uppercase 6-hex), when identified */
  opCode: string | null;
  possibleEcus: EcuDefinitionMatch[];
}

/**
 * Resolve identity for a PRESENT pair (spec §5), progressively: TX/RX → families, then narrow by op_code
 * to the exact family + variant. Identity never affects presence — an incomplete match stays probable /
 * unresolved while the address remains present.
 */
export function resolveIdentity(db: W176Db, txId: number, rxId: number, opCode?: string | null): ResolvedIdentity {
  const defs = ecuDefinitionsForPair(db, txId, rxId);
  const possibleEcus = matchEcuDefinitions(db, txId, rxId);

  if (opCode) {
    const wanted = normOp(opCode);
    const hits = defs.flatMap(def => (def.CarControlUnitVariants ?? []).filter(v => normOp(v.op_code) === wanted).map(variant => ({ def, variant })));
    const hit = hits[0];
    if (hits.length === 1 && hit) {
      const { def, variant } = hit;
      return { status: 'identified', ecuId: def.id, ecuName: def.name, displayName: def.display_name || def.name, description: def.description, group: def.group, variantId: variant.id, variantName: variant.name, opCode: wanted, possibleEcus };
    }
    if (hits.length > 1) {
      return { status: 'probable', ecuId: null, ecuName: null, displayName: null, description: null, group: null, variantId: null, variantName: null, opCode: wanted, possibleEcus };
    }
  }

  const only = defs.length === 1 ? defs[0] : undefined;
  return {
    status: identityStatusOf({ hasInventory: false, possibleCount: defs.length }),
    ecuId: only?.id ?? null, ecuName: only?.name ?? null, displayName: only?.display_name ?? only?.name ?? null,
    description: only?.description ?? null, group: only?.group ?? null, variantId: null, variantName: null,
    opCode: opCode ? normOp(opCode) : null, possibleEcus,
  };
}

/** The scan's identification data for a present module (read op-code + F18C/F111/F121 payloads). */
export interface DetectedInput {
  readonly module: VehicleModule;
  readonly opCode?: string | null;
  readonly ids?: Partial<Record<'F18C' | 'F111' | 'F121', { raw: string; text: string | null }>>;
}

/** A detected address entry: PRESENT plus (when the DB is loaded) the resolved identity + identity DIDs.
 * presence is always 'present' here (these are the responders); identity is a SEPARATE state. */
export interface DetectedModule {
  readonly txId: number;
  readonly rxId: number;
  readonly present: true;
  readonly identityStatus: IdentityStatus;
  /** resolved catalog identity (null fields until the DB is loaded / op-code narrows it) */
  readonly identity: ResolvedIdentity | null;
  /** best label available without the DB: the name the scan already carried, else the hex pair */
  readonly scanName: string;
  readonly opCode: string | null;
  readonly hardware: string | null;
  readonly software: string | null;
  readonly serialRawHex: string | null;
  readonly serialText: string | null;
  /** every catalog family that could sit on this pair (empty until the DB is loaded) */
  readonly possibleEcus: readonly EcuDefinitionMatch[];
}

/**
 * Builds the detected-module list from the scan store, enriched by the catalog WHEN it is loaded.
 * db may be null: the address cards must render from tx/rx + scan name alone, so a slow or failed DB
 * load never hides detected modules. Presence comes only from the scan (sticky), never from the DB.
 */
export function buildDetectedModules(modules: readonly DetectedInput[], db: W176Db | null): DetectedModule[] {
  return modules.map(({ module, opCode = null, ids }) => {
    const txId = toCanId(module.txId);
    const rxId = toCanId(module.rxId);
    const identity = db ? resolveIdentity(db, txId, rxId, opCode) : null;
    return {
      txId, rxId, present: true as const,
      identityStatus: identity?.status ?? 'unresolved',
      identity,
      scanName: module.name || `${formatPair(txId, rxId)}`,
      opCode,
      hardware: ids?.F111 ? ids.F111.text ?? ids.F111.raw : null,
      software: ids?.F121 ? ids.F121.text ?? ids.F121.raw : null,
      serialRawHex: ids?.F18C?.raw ?? null,
      serialText: ids?.F18C?.text ?? null,
      possibleEcus: identity?.possibleEcus ?? [],
    };
  });
}

const formatPair = (tx: number, rx: number): string => `0x${tx.toString(16).toUpperCase()}→0x${rx.toString(16).toUpperCase()}`;
