// One canonical CAN-id representation used everywhere: a number (0x60A === 1546). Strings come from the
// DB as hex ("0x60a"/"0x60A"); numbers come from the scan sources. Display formats back to "0x60A".
// This removes the "0x60a" vs "0x60A" vs 0x60A vs 1546 mismatch that can drop detected pairs.

/** Normalize a CAN id (hex string with/without 0x, or a number) to its numeric value. Throws on garbage. */
export function toCanId(value: string | number): number {
  if (typeof value === 'number') {
    if (!Number.isInteger(value) || value < 0) throw new Error(`CAN id invalid: ${value}`);
    return value;
  }
  const n = Number.parseInt(value.trim().replace(/^0x/i, ''), 16);
  if (Number.isNaN(n) || n < 0) throw new Error(`CAN id invalid: "${value}"`);
  return n;
}

/** Canonical display form, e.g. 1546 -> "0x60A". */
export function formatCanId(value: string | number): string {
  return `0x${toCanId(value).toString(16).toUpperCase()}`;
}

/** Stable key for a TX/RX pair, normalized so any input form collides correctly. */
export function canPairKey(tx: string | number, rx: string | number): string {
  return `${toCanId(tx)}/${toCanId(rx)}`;
}
