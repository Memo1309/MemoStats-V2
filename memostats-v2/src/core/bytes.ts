export type Bytes = Uint8Array<ArrayBuffer>;

export function toHex(bytes: Uint8Array): string {
  return Array.from(bytes, b => b.toString(16).padStart(2, '0').toUpperCase()).join(' ');
}

export function fromHex(hex: string): Bytes {
  const clean = hex.replace(/[^0-9a-f]/gi, '');
  if (clean.length % 2 !== 0) throw new Error(`Odd-length hex string: ${hex}`);
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  return out;
}

export function concatBytes(a: Uint8Array, b: Uint8Array): Bytes {
  const out = new Uint8Array(a.length + b.length);
  out.set(a);
  out.set(b, a.length);
  return out;
}

export function dataView(bytes: Uint8Array): DataView {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

/** CAN id as shown in the UI and logs, e.g. 0x7E0. */
export function hexId(id: number): string {
  return `0x${id.toString(16).toUpperCase().padStart(3, '0')}`;
}

export function hexByte(value: number): string {
  return `0x${value.toString(16).toUpperCase().padStart(2, '0')}`;
}
