// Derives the per-feature capability status (spec §21). Read-only by default; a feature only becomes
// writable when the ECU/variant is detected, the metadata is valid, and no SecurityAccess/sequence is
// required (or a legitimate provider covers it — none exist today).
import type { CodingFeatureModel } from './codingModel';
import { securityProviderFor } from './security';

export type FeatureStatus =
  | 'READY_READ_WRITE'
  | 'READY_READ_ONLY'
  | 'SECURITY_REQUIRED'
  | 'SEQUENCE_REQUIRED'
  | 'UNSUPPORTED_VARIANT'
  | 'ECU_NOT_DETECTED'
  | 'METADATA_INVALID';

/** Short codes for the row badge on narrow screens; the full label goes inside the details. */
export const STATUS_BADGE: Record<FeatureStatus, string> = {
  READY_READ_WRITE: 'R/W',
  READY_READ_ONLY: 'R',
  SECURITY_REQUIRED: 'SEC',
  SEQUENCE_REQUIRED: 'SEQ',
  UNSUPPORTED_VARIANT: 'VAR',
  ECU_NOT_DETECTED: '—',
  METADATA_INVALID: 'META',
};

export const STATUS_LABEL: Record<FeatureStatus, string> = {
  READY_READ_WRITE: 'Citire + scriere',
  READY_READ_ONLY: 'Doar citire',
  SECURITY_REQUIRED: 'SecurityAccess necesar',
  SEQUENCE_REQUIRED: 'Secvență de activare necesară',
  UNSUPPORTED_VARIANT: 'Variantă incompatibilă',
  ECU_NOT_DETECTED: 'ECU nedetectat',
  METADATA_INVALID: 'Metadate invalide',
};

export interface FeatureContext {
  /** the ECU that owns this feature was confirmed present this session */
  readonly ecuDetected: boolean;
  /** the confirmed ECU's variant matches the one the feature metadata targets */
  readonly variantMatches: boolean;
  readonly variantId: number;
}

function metadataValid(feature: CodingFeatureModel): boolean {
  if (feature.section.codingLength <= 0) return false;
  if (feature.options.length === 0) return false;
  if (!/^[0-9a-fA-F]{4,}$/.test(feature.section.readHex) || !/^[0-9a-fA-F]{4,}$/.test(feature.section.writeHex)) return false;
  return feature.options.every(o => o.patches.length > 0 && o.patches.every(p => p.bitPosition >= 0 && p.bitLength > 0));
}

/** A feature needs an unresolved activation sequence (write must stay locked). */
function requiresSequence(feature: CodingFeatureModel): boolean {
  return feature.featureType === 'sequence';
}

export function featureStatus(feature: CodingFeatureModel, ctx: FeatureContext): FeatureStatus {
  if (!ctx.ecuDetected) return 'ECU_NOT_DETECTED';
  if (!metadataValid(feature)) return 'METADATA_INVALID';
  if (!ctx.variantMatches) return 'UNSUPPORTED_VARIANT';
  if (requiresSequence(feature)) return 'SEQUENCE_REQUIRED';
  if ((feature.section.accessLevel ?? 0) > 0) {
    return securityProviderFor(ctx.variantId, feature.section) ? 'READY_READ_WRITE' : 'SECURITY_REQUIRED';
  }
  return 'READY_READ_WRITE';
}

/** Writable only when every precondition holds; everything else is read/preview only. */
export function isWritable(status: FeatureStatus): boolean {
  return status === 'READY_READ_WRITE';
}
