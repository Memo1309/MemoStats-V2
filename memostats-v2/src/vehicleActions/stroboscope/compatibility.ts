// Stroboscope — the only vehicle-control feature ever allowed, and NOT enabled (master spec §3).
// This module is read-only: it inspects the current scan and reports compatibility. There is
// deliberately no transmit function anywhere in the codebase. Enabling requires, first, proof of the
// exact HLI176 sequence and ALL-OFF cleanup, and a separate explicit approval.

export const STROBE_MODULES = ['HLI_FL176', 'HLI_FR176'] as const;

export interface StrobeCompatibility {
  leftResponds: boolean;
  rightResponds: boolean;
  /** always false until the protocol is proven and separately approved */
  confirmed: false;
}

export function strobeCompatibility(results: readonly { module: { name: string }; status: string }[]): StrobeCompatibility {
  const responds = (name: string) => results.some(r => r.module.name === name && r.status === 'RESPONDS');
  return { leftResponds: responds('HLI_FL176'), rightResponds: responds('HLI_FR176'), confirmed: false };
}
