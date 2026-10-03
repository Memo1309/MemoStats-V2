// SecurityAccess capability framework. This is deliberately an EMPTY registry: MemoStats binds a
// local key algorithm to a section ONLY when it legitimately holds that algorithm AND its parameters.
// We hold none, so every access-level > 0 section resolves to "unsupported" and its write stays locked.
//
// Not implemented on purpose (and not to be added without legitimate algorithm + parameters in metadata):
//   - key generation (Daimler standard / RefG / Ed25519),
//   - the 27 xx seed/key exchange as transmit code,
//   - any call to an external key-gen backend.
// The interface exists so a legitimately-held algorithm could be registered later, per ECU/variant/section.
import type { CodingSectionRef } from './codingModel';

export interface SecurityAlgorithmProvider {
  readonly id: string;
  /** True only if this provider legitimately covers the given ECU variant + section. */
  covers(variantId: number, section: CodingSectionRef): boolean;
}

// No providers are registered. Nothing may be pushed here without a legitimately held algorithm.
const PROVIDERS: readonly SecurityAlgorithmProvider[] = [];

/** Whether we can legitimately satisfy the SecurityAccess a section requires. Always false today. */
export function securityProviderFor(variantId: number, section: CodingSectionRef): SecurityAlgorithmProvider | null {
  if ((section.accessLevel ?? 0) === 0) return null; // no SecurityAccess needed
  return PROVIDERS.find(p => p.covers(variantId, section)) ?? null;
}
