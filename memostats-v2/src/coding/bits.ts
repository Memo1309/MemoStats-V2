// Generic bit engine for MBito coding blocks. bit_position is a GLOBAL bit index into the coding
// byte array, MSB-first: bit 0 = the most-significant bit (0x80) of byte 0. So byteOffset = pos >> 3
// and the bit inside that byte is (7 - pos % 8). Verified against MBito metadata:
//   bit 1264, length 8 -> byte 158 (1264/8);  bit 1288, length 8 -> byte 161 (1288/8);
//   IC172 section 14: bit 40 length 2 and bit 42 length 1 both land in byte 5 of a 6-byte block.
// Values are read/written big-endian across the field. Small fields only (<= 32 bits in the DB),
// but arithmetic (not <<) is used so up to 53-bit fields stay exact.

function requireRange(totalBytes: number, bitPosition: number, bitLength: number): void {
  if (!Number.isInteger(bitPosition) || bitPosition < 0) throw new RangeError(`bit_position invalid: ${bitPosition}`);
  if (!Number.isInteger(bitLength) || bitLength < 1 || bitLength > 53) throw new RangeError(`bit_length invalid: ${bitLength}`);
  const end = bitPosition + bitLength;
  if (end > totalBytes * 8) throw new RangeError(`câmp de biți ${bitPosition}..${end} depășește blocul de ${totalBytes} octeți`);
}

/** Reads `bitLength` bits at global `bitPosition` (MSB-first) as an unsigned integer. */
export function readBits(bytes: Uint8Array, bitPosition: number, bitLength: number): number {
  requireRange(bytes.length, bitPosition, bitLength);
  let result = 0;
  for (let i = 0; i < bitLength; i++) {
    const globalBit = bitPosition + i;
    const byte = bytes[globalBit >> 3] ?? 0;
    const bit = (byte >> (7 - (globalBit & 7))) & 1;
    result = result * 2 + bit;
  }
  return result;
}

/** Returns a COPY of `bytes` with `bitLength` bits at `bitPosition` set to `value` (big-endian, MSB-first).
 * The input is never mutated; only the targeted bits change. */
export function writeBits(bytes: Uint8Array, bitPosition: number, bitLength: number, value: number): Uint8Array<ArrayBuffer> {
  requireRange(bytes.length, bitPosition, bitLength);
  if (!Number.isInteger(value) || value < 0) throw new RangeError(`valoare de codare invalidă: ${value}`);
  const max = bitLength >= 53 ? Number.MAX_SAFE_INTEGER : 2 ** bitLength - 1;
  if (value > max) throw new RangeError(`valoarea ${value} nu încape în ${bitLength} biți (max ${max})`);
  const out = new Uint8Array(bytes);
  for (let i = 0; i < bitLength; i++) {
    const globalBit = bitPosition + i;
    const index = globalBit >> 3;
    const mask = 1 << (7 - (globalBit & 7));
    const bit = Math.floor(value / 2 ** (bitLength - 1 - i)) % 2;
    out[index] = bit ? (out[index] ?? 0) | mask : (out[index] ?? 0) & ~mask;
  }
  return out;
}

/** One atomic patch: a bit field and the value to place there. */
export interface BitPatch {
  readonly bitPosition: number;
  readonly bitLength: number;
  readonly value: number;
}

/** Applies every patch to a single clone, in order, changing only the targeted bits. */
export function applyPatches(bytes: Uint8Array, patches: readonly BitPatch[]): Uint8Array<ArrayBuffer> {
  let out = new Uint8Array(bytes);
  for (const p of patches) out = writeBits(out, p.bitPosition, p.bitLength, p.value);
  return out;
}

/** Parses a coding value that may arrive as a number or a decimal string (custom_options.overwrites). */
export function parseCodingValue(value: number | string): number {
  if (typeof value === 'number') return value;
  const trimmed = value.trim();
  if (!/^-?\d+$/.test(trimmed)) throw new Error(`valoare de codare non-numerică: "${value}"`);
  return Number.parseInt(trimmed, 10);
}

/** Human-readable list of the bytes that a set of patches would change (for the before/after diff). */
export function changedByteIndexes(before: Uint8Array, after: Uint8Array): number[] {
  const changed: number[] = [];
  for (let i = 0; i < Math.max(before.length, after.length); i++) if (before[i] !== after[i]) changed.push(i);
  return changed;
}
