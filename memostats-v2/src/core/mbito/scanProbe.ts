import { type Bytes, dataView, hexId, toHex } from '../bytes';
import { MbitoCmd } from './constants';
import { ExchangeTimeoutError, type MbitoClient } from './mbitoClient';
import { recordTransaction } from '../../logs/transactions';
import { log } from '../../logs/logStore';

// MBito 0x33 probe: the dongle sends one raw CAN frame on tx_id and returns what arrives on rx_id.
// Layout (32-byte payload), VERIFIED V1 CAPTURE — V1 TX for 0x6A2/0x494:
//   33 02 20 00 | 00 01 02 00 | A2 06 00 00 | 02 10 03 55 55 55 55 55 | 01 01 FA 00 | 94 04 00 00 | 00 × 8
//                 hdr           tx u32 LE     CAN frame (ISO-TP SF,       ?  ? timeout  rx u32 LE    reply area
//                                             pad 0x55)                        250 ms
// Reply (`B3 02 20 00`) echoes it; its last 8 bytes are the CAN frame received on rx_id:
//   any non-zero slot = ECU confirmed (`06 50 03 …` session accepted, `03 7F 10 xx` rejected, other frame)
//   · all zero = probe completed, no response THIS pass (not "absent").
// No B3 at all is a host/transport timeout — never read as ECU absence.
// VERIFIED REAL VEHICLE: official-app B3 replies captured on this car (V1 capture-20260917-222558).

export const SCAN_PROBE_PAYLOAD_LENGTH = 32;
const PROBE_HEADER = [0x00, 0x01, 0x02, 0x00];
/** ISO-TP single frame "DiagnosticSessionControl extendedSession", padded with 0x55 like V1/MBito. */
const SESSION_FRAME = [0x02, 0x10, 0x03, 0x55, 0x55, 0x55, 0x55, 0x55];
const PROBE_FLAGS = [0x01, 0x01];
/** CAN reply wait inside the dongle (FA 00). */
export const SCAN_PROBE_TIMEOUT_MS = 250;

export function encodeScanProbe(txId: number, rxId: number): Bytes {
  const out = new Uint8Array(SCAN_PROBE_PAYLOAD_LENGTH);
  const view = dataView(out);
  out.set(PROBE_HEADER, 0);
  view.setUint32(4, txId, true);
  out.set(SESSION_FRAME, 8);
  out.set(PROBE_FLAGS, 16);
  view.setUint16(18, SCAN_PROBE_TIMEOUT_MS, true);
  view.setUint32(20, rxId, true);
  return out;
}

export interface ScanProbeReply {
  txId: number;
  rxId: number;
  /** CAN frame received on rx_id, without its ISO-TP length byte; empty = nothing received */
  response: Bytes;
  /** 50 03 = the ECU accepted the extended session */
  positive: boolean;
  /** 7F 10 nn = the ECU answered but rejected the session (still present) */
  negative: boolean;
  /** last 8 bytes all zero = the dongle completed the probe and nothing answered on CAN this time */
  absent: boolean;
}

export function decodeScanProbe(payload: Uint8Array): ScanProbeReply {
  if (payload.length < 25) throw new Error(`0x33 reply ${payload.length} B shorter than 25`);
  const view = dataView(payload);
  const length = Math.min(view.getUint8(24), payload.length - 25);
  const response = payload.slice(25, 25 + length);
  return {
    txId: view.getUint32(4, true),
    rxId: view.getUint32(20, true),
    response,
    positive: response[0] === 0x50 && response[1] === 0x03,
    negative: response[0] === 0x7f && response[1] === 0x10,
    absent: payload.subarray(24, SCAN_PROBE_PAYLOAD_LENGTH).every(b => b === 0),
  };
}

// ---------- exchange ----------

/** Host wait for the B3 reply. The next probe goes out only after the B3 or this deadline. */
export const SCAN_PROBE_HOST_WAIT_MS = 1000;

/** Any non-zero CAN slot confirms the ECU; the frame says what it did with the session:
 * SESSION_ACCEPTED = 50 03 · SESSION_REJECTED = 7F 10 nn · OTHER_RESPONSE = any other frame.
 * NO_RESPONSE = zero slot (this pass only) · HOST_TIMEOUT = no B3 (transport, nothing learned). */
export type ProbeOutcome = 'SESSION_ACCEPTED' | 'SESSION_REJECTED' | 'OTHER_RESPONSE' | 'NO_RESPONSE' | 'HOST_TIMEOUT';

export interface ScanProbeResult {
  reply: ScanProbeReply | null;
  outcome: ProbeOutcome;
  present: boolean;
  latencyMs: number | null;
  txRaw: Bytes;
  rxRaw: Bytes | null;
}

export function probeOutcome(reply: ScanProbeReply): Exclude<ProbeOutcome, 'HOST_TIMEOUT'> {
  if (reply.absent) return 'NO_RESPONSE';
  return reply.positive ? 'SESSION_ACCEPTED' : reply.negative ? 'SESSION_REJECTED' : 'OTHER_RESPONSE';
}

/** Sends one 0x33 probe exactly as V1 did and waits for the matching B3 reply. */
export async function probeEcu(client: MbitoClient, txId: number, rxId: number, signal?: AbortSignal): Promise<ScanProbeResult> {
  const target = `${hexId(txId)}→${hexId(rxId)}`;
  try {
    const result = await client.exchange<{ reply: ScanProbeReply; rxRaw: Bytes; at: number }>({
      command: MbitoCmd.SCAN_PROBE,
      payload: encodeScanProbe(txId, rxId),
      // A late B3 for this probe is filtered out of the next one by its tx/rx ids, so no extra link hold.
      timeoutMs: SCAN_PROBE_HOST_WAIT_MS,
      signal,
      onFrame: frame => {
        let reply: ScanProbeReply;
        try {
          reply = decodeScanProbe(frame.payload);
        } catch (error) {
          return { kind: 'ignore', reason: (error as Error).message };
        }
        if (reply.txId !== txId || reply.rxId !== rxId) return { kind: 'ignore', reason: `probe reply for ${hexId(reply.txId)}/${hexId(reply.rxId)}` };
        return { kind: 'done', value: { reply, rxRaw: frame.raw, at: performance.now() } };
      },
    });
    const { reply, rxRaw, at } = result.value;
    const outcome = probeOutcome(reply);
    const present = outcome !== 'NO_RESPONSE';
    const latencyMs = at - result.sentAt;
    const canFrame = toHex(rxRaw.subarray(4 + 24, 4 + SCAN_PROBE_PAYLOAD_LENGTH)) || null;
    recordTransaction({
      kind: 'PROBE', txId, rxId, request: '10 03 (0x33)', response: toHex(reply.response) || null,
      status: { SESSION_ACCEPTED: 'OK 50 03', SESSION_REJECTED: `SESIUNE REFUZATĂ ${toHex(reply.response)}`, OTHER_RESPONSE: `RĂSPUNS CAN ${canFrame ?? ''}`, NO_RESPONSE: 'FĂRĂ RĂSPUNS (slot CAN zero)' }[outcome],
      ok: outcome === 'SESSION_ACCEPTED', answered: present, latencyMs,
      detail: { ble_tx: toHex(result.tx), ble_rx: toHex(rxRaw), can_rx_frame: canFrame, arg: rxRaw[1] ?? null, outcome },
    });
    log('SCAN', `Probe ${target} ${outcome}`, { ble_tx: toHex(result.tx), ble_rx: toHex(rxRaw), can_rx_frame: canFrame, ms: Math.round(latencyMs) }, 'info');
    return { reply, outcome, present, latencyMs, txRaw: result.tx, rxRaw };
  } catch (error) {
    if (!(error instanceof ExchangeTimeoutError)) throw error;
    recordTransaction({ kind: 'PROBE', txId, rxId, request: '10 03 (0x33)', response: null, status: 'FĂRĂ CADRU B3 (timeout host)', ok: false, answered: false, latencyMs: null, detail: { ble_tx: toHex(error.tx), outcome: 'HOST_TIMEOUT' } });
    log('SCAN', `Probe ${target}: no B3 within ${SCAN_PROBE_HOST_WAIT_MS} ms (host timeout, not ECU absence)`, { ble_tx: toHex(error.tx) }, 'warn');
    return { reply: null, outcome: 'HOST_TIMEOUT', present: false, latencyMs: null, txRaw: error.tx, rxRaw: null };
  }
}
