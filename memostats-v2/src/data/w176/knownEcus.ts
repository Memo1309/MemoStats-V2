// Phase 2 needs only the engine ECU. The full W176 catalog (119 records / 70 endpoints) is imported
// in Phase 3 from the exported GraphQL data, with schema validation.

/**
 * MED40 engine ECU of the test car (A200 M270).
 * TX/RX: VERIFIED REAL VEHICLE — old MemoStats got real `01 0D` and `22 F1 00` replies on 7E0/7E8.
 * variant/opCode: GRAPHQL REFERENCE (user's MBito vehicle record), confirmed by the real F100 reply
 * `62 F1 00 02 28 57 03` whose op-code bytes are 02 28 57.
 */
export const MED40 = {
  name: 'MED40',
  label: 'Motor electronics',
  txId: 0x7e0,
  rxId: 0x7e8,
  variantId: 14694,
  variantName: 'VC11_A',
  opCode: '022857',
} as const;
