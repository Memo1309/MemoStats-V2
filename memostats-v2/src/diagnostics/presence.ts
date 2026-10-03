// Two independent states for a scanned CAN address — never one "confirmed" boolean.
//  - presenceStatus: is a diagnostic ECU reachable at this TX/RX? (from the scan response alone)
//  - identityStatus: do we know WHICH ECU family/variant it is? (a separate, later stage)
// A responding address is PRESENT even when its identity is still unresolved. Identity never
// downgrades presence.
import type { ModuleStatus, SessionReply } from './ecuScan';

export type PresenceStatus = 'not_scanned' | 'present' | 'absent' | 'error';
export type IdentityStatus = 'unresolved' | 'probable' | 'identified';

/** Presence from the scan's per-pair status. RESPONDS (any non-zero diagnostic slot / negative UDS /
 * 0xFE-with-payload) = present; zero slot = absent (this pass); no B3 / BLE error = error. */
export function presenceFromModuleStatus(status: ModuleStatus): PresenceStatus {
  switch (status) {
    case 'RESPONDS': return 'present';
    case 'NO_ANSWER': return 'absent';
    case 'HOST_TIMEOUT':
    case 'ERROR': return 'error';
  }
}

/** Human reason for the presence decision, for the scan log and the card detail. */
export function presenceReason(status: ModuleStatus, session: SessionReply | null, probeResponse: string | null): string {
  switch (status) {
    case 'RESPONDS':
      if (session === 'ACCEPTED') return `răspuns diagnostic pozitiv (50 03) — ${probeResponse ?? ''}`.trim();
      if (session === 'REJECTED') return `răspuns UDS negativ (7F 10 …) — ECU prezent — ${probeResponse ?? ''}`.trim();
      return `slot de răspuns CAN non-zero — ${probeResponse ?? ''}`.trim();
    case 'NO_ANSWER': return 'slot de răspuns CAN zero (fără răspuns la această trecere)';
    case 'HOST_TIMEOUT': return 'niciun cadru B3 de la dongle (eroare de comunicație, nu neapărat absent)';
    case 'ERROR': return 'eroare BLE / cadru malformat';
  }
}

/**
 * Identity from the catalog match. The vehicle inventory record is an exact match (our car) → identified.
 * Exactly one catalog family on the pair → probable. Several families → unresolved. No match / no DB → unresolved.
 * A read op-code that pins a single variant may also promote to identified (opCodeMatched).
 */
export function identityStatusOf(input: { hasInventory: boolean; possibleCount: number; opCodeMatched?: boolean }): IdentityStatus {
  if (input.hasInventory || input.opCodeMatched) return 'identified';
  if (input.possibleCount === 1) return 'probable';
  return 'unresolved';
}

export const PRESENCE_LABEL: Record<PresenceStatus, string> = {
  not_scanned: 'Nescanat',
  present: 'PREZENT',
  absent: 'Fără răspuns',
  error: 'Eroare comunicație',
};

export const IDENTITY_LABEL: Record<IdentityStatus, string> = {
  unresolved: 'Identitate: nerezolvată',
  probable: 'Identitate: probabilă',
  identified: 'Identitate: identificată',
};
