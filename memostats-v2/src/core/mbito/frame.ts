import { type Bytes, concatBytes, dataView } from '../bytes';
import {
  MAX_SINGLE_FRAME_PAYLOAD,
  MBITO_HEADER_SIZE,
  MBITO_OUTER_ARG,
  MBITO_RESPONSE_FLAG,
  MbitoArg,
  type MbitoCmd,
} from './constants';

/** One complete MBito packet: [cmd u8][arg u8][len u16 LE][payload]. */
export interface MbitoFrame {
  rawCommand: number;
  /** rawCommand % 0x80 */
  command: number;
  isResponse: boolean;
  arg: number;
  payload: Bytes;
  raw: Bytes;
}

export function encodeRequest(command: MbitoCmd, payload: Uint8Array = new Uint8Array()): Bytes {
  if (payload.length > MAX_SINGLE_FRAME_PAYLOAD) {
    throw new RangeError(`MBito payload ${payload.length} B exceeds single-frame limit ${MAX_SINGLE_FRAME_PAYLOAD} B`);
  }
  const out = new Uint8Array(MBITO_HEADER_SIZE + payload.length);
  const view = dataView(out);
  view.setUint8(0, command);
  // Outer arg is command-specific: scan 0x33 → 0x02, everything else → 0x79 (single frame).
  view.setUint8(1, MBITO_OUTER_ARG[command] ?? MbitoArg.SINGLE_FRAME);
  view.setUint16(2, payload.length, true);
  out.set(payload, MBITO_HEADER_SIZE);
  return out;
}

/** Decodes exactly one complete packet. Throws on a length mismatch. */
export function decodeFrame(raw: Uint8Array): MbitoFrame {
  if (raw.length < MBITO_HEADER_SIZE) throw new Error('MBito packet shorter than 4-byte header');
  const view = dataView(raw);
  const length = view.getUint16(2, true);
  if (raw.length !== MBITO_HEADER_SIZE + length) {
    throw new Error(`MBito length field ${length} does not match packet size ${raw.length}`);
  }
  const rawCommand = view.getUint8(0);
  const copy = raw.slice();
  return {
    rawCommand,
    command: rawCommand % MBITO_RESPONSE_FLAG,
    isResponse: rawCommand >= MBITO_RESPONSE_FLAG,
    arg: view.getUint8(1),
    payload: copy.slice(MBITO_HEADER_SIZE),
    raw: copy,
  };
}

// A dongle packet is never this large on the EXEC_UDS (non-chunked) path; anything bigger is garbage.
const MAX_SANE_PAYLOAD = 4200;
// A partial packet older than this is abandoned rather than glued to an unrelated notification.
const STALE_PARTIAL_MS = 1000;

/** Can a dongle response start at `at`? (response bit set, sane length once the header is complete) */
function plausibleStart(buffer: Uint8Array, at: number): boolean {
  if ((buffer[at] ?? 0) < MBITO_RESPONSE_FLAG) return false;
  return buffer.length - at < MBITO_HEADER_SIZE || dataView(buffer).getUint16(at + 2, true) <= MAX_SANE_PAYLOAD;
}

/** True when the notification is exactly one or more complete response packets. */
function isWholePackets(chunk: Uint8Array): boolean {
  let at = 0;
  while (at + MBITO_HEADER_SIZE <= chunk.length && plausibleStart(chunk, at)) at += MBITO_HEADER_SIZE + dataView(chunk).getUint16(at + 2, true);
  return at > 0 && at === chunk.length;
}

/**
 * Reassembles MBito packets from BLE notifications. A notification may carry part of a packet
 * or several packets (MBito's own parser returns null for an incomplete packet and waits).
 * Nothing valid is sacrificed to a broken partial: a notification that is whole packets by itself
 * (the normal case — V1 parsed each notification on its own) is never glued to a leftover partial,
 * and a bad byte only costs the bytes before the next plausible packet start.
 */
export class FrameAssembler {
  private buffer: Bytes = new Uint8Array();
  private lastChunkAt = 0;

  push(chunk: Uint8Array, now: number): { frames: MbitoFrame[]; dropped: Bytes[] } {
    const frames: MbitoFrame[] = [];
    const dropped: Bytes[] = [];
    if (this.buffer.length > 0 && (now - this.lastChunkAt > STALE_PARTIAL_MS || isWholePackets(chunk))) {
      dropped.push(this.buffer);
      this.buffer = new Uint8Array();
    }
    this.lastChunkAt = now;
    this.buffer = concatBytes(this.buffer, chunk);

    while (this.buffer.length >= MBITO_HEADER_SIZE) {
      if (!plausibleStart(this.buffer, 0)) {
        let next = 1;
        while (next < this.buffer.length && !plausibleStart(this.buffer, next)) next++;
        dropped.push(this.buffer.slice(0, next));
        this.buffer = this.buffer.slice(next);
        continue;
      }
      const total = MBITO_HEADER_SIZE + dataView(this.buffer).getUint16(2, true);
      if (this.buffer.length < total) break;
      frames.push(decodeFrame(this.buffer.subarray(0, total)));
      this.buffer = this.buffer.slice(total);
    }
    return { frames, dropped };
  }

  reset(): void {
    this.buffer = new Uint8Array();
  }
}

/** GET_DEV_NAME / GET_FW_VERSION payload. VERIFIED DECOMPILED REFERENCE: TextDecoder('utf-8'). */
export function decodeText(payload: Uint8Array): string {
  return new TextDecoder('utf-8').decode(payload).replace(/\0+$/, '').trim();
}

/** GET_VOLTAGE payload → volts. VERIFIED DECOMPILED REFERENCE: parseVoltage() getUint16(0, LE) / 1000.
 * VERIFIED REAL VEHICLE: ~15.08 V observed. */
export function decodeVoltage(payload: Uint8Array): number {
  if (payload.length < 2) throw new Error(`Voltage payload too short (${payload.length} B)`);
  return dataView(payload).getUint16(0, true) / 1000;
}
