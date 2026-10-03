// Test double for the MBito dongle, shared by protocol tests. Not imported by the app.
import { type Bytes, fromHex, toHex } from '../core/bytes';
import type { ByteTransport } from '../core/ble/mbitoBleTransport';

export class FakeTransport implements ByteTransport {
  written: Bytes[] = [];
  /** called after each write, like the dongle reacting to a request */
  respond?: (tx: Bytes) => void;
  private readonly data = new Set<(chunk: Bytes) => void>();
  private readonly disconnect = new Set<(userInitiated: boolean) => void>();

  async write(bytes: Bytes): Promise<void> {
    this.written.push(bytes);
    queueMicrotask(() => this.respond?.(bytes));
  }
  onData(listener: (chunk: Bytes) => void) {
    this.data.add(listener);
    return () => this.data.delete(listener);
  }
  onDisconnect(listener: (userInitiated: boolean) => void) {
    this.disconnect.add(listener);
    return () => this.disconnect.delete(listener);
  }
  emit(bytes: Bytes): void {
    for (const listener of this.data) listener(bytes);
  }
  drop(): void {
    for (const listener of this.disconnect) listener(false);
  }
}

/** What the dongle sends back: header echo with resp_status and payload_len filled in, then the UDS body. */
export function dongleReply(tx: Bytes, responseType: number, body: string, override?: { txId?: number; requestNr?: number }): Bytes {
  const header = tx.slice(4, 25);
  const view = new DataView(header.buffer);
  const bodyBytes = fromHex(body);
  header[2] = responseType;
  if (override?.requestNr !== undefined) header[1] = override.requestNr;
  if (override?.txId !== undefined) view.setUint32(3, override.txId, true);
  view.setUint16(19, bodyBytes.length, true);
  const payloadLength = 21 + bodyBytes.length;
  return fromHex(`C0 01 ${toHex(Uint8Array.of(payloadLength & 0xff, payloadLength >> 8))} ${toHex(header)} ${body}`);
}
