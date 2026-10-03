import { type Bytes, dataView } from '../bytes';

// EXEC_UDS V2 inner frame (the payload of an outer MBito EXEC_UDS packet). docs/PROTOCOL.md §3.
// VERIFIED DECOMPILED REFERENCE: composeUDSCmdArg() (output.js ~L2040557) writes exactly these
// offsets; parseExecUDS() (~L1673818) rejects anything shorter than 21 bytes.
// VERIFIED REAL VEHICLE: official-app responses captured by old MemoStats decode field-for-field.

export const EXEC_UDS_HEADER_SIZE = 21;

const OFFSET = {
  requestType: 0,       // MBito: request_type
  requestNr: 1,         // MBito: request_nr
  responseType: 2,      // MBito: resp_status
  txId: 3,              // MBito: tx_id (u32 LE)
  rxId: 7,              // MBito: rx_id (u32 LE)
  timeoutMs: 11,        // MBito: timeout (u16 LE)
  delayAfterMs: 13,     // MBito: delay_after (u16 LE) — "response_timeout" in V2Utils
  expectedLength: 15,   // MBito: exp_len (u16 LE)
  requestLength: 17,    // MBito: cmd_len (u16 LE)
  actualLength: 19,     // MBito: payload_len (u16 LE)
} as const;

/** request_type for a normal diagnostic request. VERIFIED REAL VEHICLE: echoed as 00 in every capture. */
export const REQUEST_TYPE_DIAGNOSTIC = 0x00;
/** resp_status placeholder on outgoing frames. INFERRED — the old MemoStats value, which the real
 * dongle accepted (real 01 0D / 22 F1 00 replies). MBito's own V2Utils default is not decoded. */
export const RESPONSE_TYPE_PLACEHOLDER = 0xff;

/**
 * RAW wire values of resp_status on this path. VERIFIED DECOMPILED REFERENCE: UDSErrorCode enum
 * (output.js ~L1673925): OK=0, NEGATIVE_RESPONSE=255, PARTIAL_TIMEOUT=254, FULL_TIMEOUT=253.
 * VERIFIED REAL VEHICLE: 0x00 and 0xFE both observed carrying complete positive bodies.
 * Do not confuse with any normalized 0/1/2/3 enum elsewhere in MBito.
 */
export const RawResponseType = {
  OK: 0x00,
  NEGATIVE_RESPONSE: 0xff,
  PARTIAL_TIMEOUT: 0xfe,
  FULL_TIMEOUT: 0xfd,
} as const;

export type RawTransportStatus = keyof typeof RawResponseType | 'UNKNOWN';

export function rawTransportStatus(responseType: number): RawTransportStatus {
  for (const [name, value] of Object.entries(RawResponseType)) {
    if (value === responseType) return name as keyof typeof RawResponseType;
  }
  return 'UNKNOWN';
}

export interface ExecUdsRequest {
  requestNr: number;
  txId: number;
  rxId: number;
  /** dongle-side wait for the ECU, ms */
  timeoutMs: number;
  delayAfterMs: number;
  /** bytes after which the dongle may stop waiting (0 = unknown, dongle waits out timeoutMs) */
  expectedResponseLength: number;
  body: Uint8Array;
}

export function encodeExecUdsRequest(request: ExecUdsRequest): Bytes {
  const out = new Uint8Array(EXEC_UDS_HEADER_SIZE + request.body.length);
  const view = dataView(out);
  view.setUint8(OFFSET.requestType, REQUEST_TYPE_DIAGNOSTIC);
  view.setUint8(OFFSET.requestNr, request.requestNr & 0xff);
  view.setUint8(OFFSET.responseType, RESPONSE_TYPE_PLACEHOLDER);
  view.setUint32(OFFSET.txId, request.txId, true);
  view.setUint32(OFFSET.rxId, request.rxId, true);
  view.setUint16(OFFSET.timeoutMs, request.timeoutMs, true);
  view.setUint16(OFFSET.delayAfterMs, request.delayAfterMs, true);
  view.setUint16(OFFSET.expectedLength, request.expectedResponseLength, true);
  view.setUint16(OFFSET.requestLength, request.body.length, true);
  // Outgoing payload_len mirrors the request length. VERIFIED DECOMPILED REFERENCE: V2Utils sets
  // actual_res_len = command.length.
  view.setUint16(OFFSET.actualLength, request.body.length, true);
  out.set(request.body, EXEC_UDS_HEADER_SIZE);
  return out;
}

export interface ExecUdsHeader {
  requestType: number;
  requestNr: number;
  responseType: number;
  txId: number;
  rxId: number;
  timeoutMs: number;
  delayAfterMs: number;
  expectedLength: number;
  requestLength: number;
  actualLength: number;
}

export interface DecodedExecUdsResponse {
  header: ExecUdsHeader;
  transportStatus: RawTransportStatus;
  /** Complete UDS response starting with the SID (62…, 7F…). No request echo precedes it:
   * VERIFIED REAL VEHICLE capture `… 07 00 03 00 07 00 | 62 F1 00 00 05 08 03`. */
  udsBody: Bytes;
  /** Bytes after the 21-byte header, before trimming to actualLength. */
  rawBody: Bytes;
  warnings: string[];
}

export function decodeExecUdsHeader(payload: Uint8Array): ExecUdsHeader {
  if (payload.length < EXEC_UDS_HEADER_SIZE) {
    throw new Error(`EXEC_UDS payload ${payload.length} B shorter than ${EXEC_UDS_HEADER_SIZE}-byte header`);
  }
  const view = dataView(payload);
  return {
    requestType: view.getUint8(OFFSET.requestType),
    requestNr: view.getUint8(OFFSET.requestNr),
    responseType: view.getUint8(OFFSET.responseType),
    txId: view.getUint32(OFFSET.txId, true),
    rxId: view.getUint32(OFFSET.rxId, true),
    timeoutMs: view.getUint16(OFFSET.timeoutMs, true),
    delayAfterMs: view.getUint16(OFFSET.delayAfterMs, true),
    expectedLength: view.getUint16(OFFSET.expectedLength, true),
    requestLength: view.getUint16(OFFSET.requestLength, true),
    actualLength: view.getUint16(OFFSET.actualLength, true),
  };
}

export function decodeExecUdsResponse(payload: Uint8Array): DecodedExecUdsResponse {
  const header = decodeExecUdsHeader(payload);
  const rawBody = payload.slice(EXEC_UDS_HEADER_SIZE);
  const warnings: string[] = [];
  let udsBody = rawBody;
  if (header.actualLength < rawBody.length) {
    udsBody = rawBody.slice(0, header.actualLength);
    warnings.push(`${rawBody.length - header.actualLength} B after declared payload_len ${header.actualLength} ignored`);
  } else if (header.actualLength > rawBody.length) {
    warnings.push(`payload_len ${header.actualLength} declares more than the ${rawBody.length} B present (truncated)`);
  }
  return { header, transportStatus: rawTransportStatus(header.responseType), udsBody, rawBody, warnings };
}
