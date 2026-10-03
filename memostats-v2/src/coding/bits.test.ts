import { describe, expect, it } from 'vitest';
import { applyPatches, changedByteIndexes, parseCodingValue, readBits, writeBits } from './bits';

const block = (len: number, fill = 0) => new Uint8Array(len).fill(fill);

describe('readBits / writeBits — MBito global MSB-first bit index', () => {
  it('bit 0 is the MSB of byte 0', () => {
    expect(readBits(Uint8Array.of(0x80), 0, 1)).toBe(1);
    expect(readBits(Uint8Array.of(0x40), 0, 1)).toBe(0);
    expect(toHex(writeBits(block(1), 0, 1, 1))).toBe('80');
  });

  it('bit 7 is the LSB of byte 0', () => {
    expect(readBits(Uint8Array.of(0x01), 7, 1)).toBe(1);
    expect(toHex(writeBits(block(1), 7, 1, 1))).toBe('01');
  });

  it('IC172 section 14 (6 bytes): bit 20, bit 40 len 2, bit 42 land where MBito expects', () => {
    // bit 20 -> byte 2, bit-in-byte 4 (mask 0x08)
    expect(toHex(writeBits(block(6), 20, 1, 1))).toBe('00 00 08 00 00 00');
    // bit 40 len 2 -> top 2 bits of byte 5
    expect(toHex(writeBits(block(6), 40, 2, 0b11))).toBe('00 00 00 00 00 C0');
    expect(readBits(Uint8Array.of(0, 0, 0, 0, 0, 0xc0), 40, 2)).toBe(3);
    // bit 42 -> byte 5, bit-in-byte 2 (mask 0x20)
    expect(toHex(writeBits(block(6), 42, 1, 1))).toBe('00 00 00 00 00 20');
  });

  it('HLI positions 1264 and 1288 map to byte 158 and 161 (whole byte, length 8)', () => {
    const b = block(194);
    const a = writeBits(writeBits(b, 1264, 8, 25), 1288, 8, 26);
    expect(a[158]).toBe(25);
    expect(a[161]).toBe(26);
    expect(readBits(a, 1264, 8)).toBe(25);
    expect(readBits(a, 1288, 8)).toBe(26);
    // every other byte untouched
    expect(changedByteIndexes(b, a)).toEqual([158, 161]);
  });

  it('MED40 bit 230 length 2 in a 50-byte block (byte 28, low 2 bits)', () => {
    const a = writeBits(block(50), 230, 2, 2);
    expect(a[28]).toBe(0b10);
    expect(readBits(a, 230, 2)).toBe(2);
    expect(changedByteIndexes(block(50), a)).toEqual([28]);
  });

  it('covers the spec bit positions 0,2,7,20,40,42,48,66,107,108,159 round-trip', () => {
    for (const pos of [0, 2, 7, 20, 40, 42, 48, 66, 107, 108, 159]) {
      const a = writeBits(block(64), pos, 1, 1);
      expect(readBits(a, pos, 1)).toBe(1);
      expect(changedByteIndexes(block(64), a)).toEqual([pos >> 3]);
    }
  });

  it('never mutates the input and never touches bits outside the field', () => {
    const original = Uint8Array.of(0xff, 0xff, 0xff);
    const out = writeBits(original, 8, 4, 0);
    expect(toHex(original)).toBe('FF FF FF');
    expect(toHex(out)).toBe('FF 0F FF');
  });

  it('rejects an out-of-range field or an oversized value', () => {
    expect(() => readBits(block(6), 46, 4)).toThrow(/depășește/);
    expect(() => writeBits(block(6), 40, 2, 4)).toThrow(/nu încape/);
    expect(() => writeBits(block(1), 0, 1, -1)).toThrow(/invalidă/);
  });
});

describe('custom overwrites — atomic multi-field application', () => {
  it('applies several overwrites to one clone without disturbing the rest', () => {
    // CBCBOLERO section 148 "Disabled": clear bits 8,9,10,11 (byte 1, top nibble)
    const before = Uint8Array.of(0xff, 0xff);
    const patches = [8, 9, 10, 11].map(bitPosition => ({ bitPosition, bitLength: 1, value: 0 }));
    const after = applyPatches(before, patches);
    expect(toHex(after)).toBe('FF 0F');
    expect(toHex(before)).toBe('FF FF');
  });

  it('parses overwrite values delivered as decimal strings', () => {
    expect(parseCodingValue('245')).toBe(245);
    expect(parseCodingValue(26)).toBe(26);
    expect(() => parseCodingValue('0x1F')).toThrow(/non-numerică/);
  });

  it('Blue Welcome 25 sec overwrites (1264=245, 1288=247) hit only bytes 158 and 161', () => {
    const before = block(194);
    const after = applyPatches(before, [
      { bitPosition: 1264, bitLength: 8, value: parseCodingValue('245') },
      { bitPosition: 1288, bitLength: 8, value: parseCodingValue('247') },
    ]);
    expect(after[158]).toBe(245);
    expect(after[161]).toBe(247);
    expect(changedByteIndexes(before, after)).toEqual([158, 161]);
  });
});

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes, b => b.toString(16).padStart(2, '0').toUpperCase()).join(' ');
}
