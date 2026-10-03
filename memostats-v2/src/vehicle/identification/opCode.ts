import { toHex } from '../../core/bytes';

/**
 * Operation code from a DID F100 positive response: `62 F1 00 <op code, 3 B> <trailing…>`.
 * VERIFIED REAL VEHICLE: MED40 `62 F1 00 02 28 57 03` → 022857, CBCBOLERO `62 F1 00 02 E6 08 01` → 02E608,
 * DMFL166 `62 F1 00 00 04 0C 03` → 00040C, all equal to the catalog op_code.
 * The trailing byte is deliberately left uninterpreted.
 */
export function opCodeFromF100(body: Uint8Array): string | null {
  if (body.length < 6 || body[0] !== 0x62 || body[1] !== 0xf1 || body[2] !== 0x00) return null;
  return toHex(body.subarray(3, 6)).replaceAll(' ', '');
}
