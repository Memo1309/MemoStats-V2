import { type Bytes, hexByte, hexId, toHex } from '../bytes';
import { MbitoArg, MbitoCmd } from '../mbito/constants';
import { ExchangeTimeoutError, type MbitoClient, type ReceivedFrame } from '../mbito/mbitoClient';
import { log, type LogDetailValue } from '../../logs/logStore';
import { recordTransaction } from '../../logs/transactions';
import {
  type DecodedExecUdsResponse,
  type ExecUdsHeader,
  type RawTransportStatus,
  RawResponseType,
  decodeExecUdsHeader,
  decodeExecUdsResponse,
  encodeExecUdsRequest,
} from './execUds';
import {
  type EcuPresence,
  type UdsSemantic,
  P2_STAR_SERVER_MAX_MS,
  classifyUdsResponse,
  presenceOf,
} from './udsSemantics';

export interface UdsRequestSpec {
  txId: number;
  /** MBito inner request_type / FrameDirection: 0=Read (default), 1=Write. */
  requestType?: number;
  rxId: number;
  body: Uint8Array;
  timeoutMs: number;
  expectedResponseLength: number;
  delayAfterMs: number;
  /** Exact request_nr to send (e.g. replaying an official capture). Omitted → 1…255 rolling. */
  requestNr?: number;
}

/** Raw dongle status, or what happened when no usable EXEC_UDS frame arrived.
 * HOST_TIMEOUT = frames arrived (e.g. NRC 0x78) but the final one never did before the browser deadline. */
export type TransportOutcome = RawTransportStatus | 'NO_RX' | 'DONGLE_REJECTED' | 'HOST_TIMEOUT';

export interface UdsExchangeResult {
  spec: UdsRequestSpec;
  requestNr: number;
  /** complete outer MBito packet as written to BLE */
  txRaw: Bytes;
  /** performance.now() just before the BLE write; frame receivedAt values share this clock */
  sentAt: number;
  /** performance.now() when the BLE write was acknowledged; null if the reply arrived first */
  writtenAt: number | null;
  frames: ReceivedFrame[];
  /** the frame the result was decided on */
  final?: DecodedExecUdsResponse;
  transport: TransportOutcome;
  semantic: UdsSemantic;
  nrc?: number;
  presence: EcuPresence;
  /** send → deciding frame, ms; null when nothing usable arrived */
  latencyMs: number | null;
  /** VERIFIED REAL VEHICLE 2026-09-28: the dongle echoes request_nr (sent 01 → got 01). null = no frame */
  requestNrEchoed: boolean | null;
  warnings: string[];
}

// Browser-side margin over the dongle's own timeout, so the dongle's FULL_TIMEOUT normally arrives
// first. ponytail: flat margin; tune from measured Bluefy round trips.
const BROWSER_MARGIN_MS = 1500;

let lastRequestNr = 0;
function nextRequestNr(): number {
  lastRequestNr = (lastRequestNr % 255) + 1; // 1..255; the official app sends the command index (0)
  return lastRequestNr;
}

type Decided = { kind: 'uds'; response: DecodedExecUdsResponse; receivedAt: number } | { kind: 'rejected'; arg: number; receivedAt: number };

function headerDetail(prefix: string, header: ExecUdsHeader): Record<string, LogDetailValue> {
  return {
    [`${prefix}request_type`]: header.requestType,
    [`${prefix}request_nr`]: header.requestNr,
    [`${prefix}resp_status`]: hexByte(header.responseType),
    [`${prefix}tx_id`]: hexId(header.txId),
    [`${prefix}rx_id`]: hexId(header.rxId),
    [`${prefix}timeout_ms`]: header.timeoutMs,
    [`${prefix}delay_after_ms`]: header.delayAfterMs,
    [`${prefix}exp_len`]: header.expectedLength,
    [`${prefix}cmd_len`]: header.requestLength,
    [`${prefix}payload_len`]: header.actualLength,
  };
}

/** Sends one UDS request through EXEC_UDS and classifies transport and semantics separately. */
export async function execUds(client: MbitoClient, spec: UdsRequestSpec, signal?: AbortSignal): Promise<UdsExchangeResult> {
  const requestNr = spec.requestNr ?? nextRequestNr();
  const inner = encodeExecUdsRequest({ ...spec, requestNr });
  const warnings: string[] = [];
  let lastUds: DecodedExecUdsResponse | undefined;
  let pendingSeen: DecodedExecUdsResponse | undefined;

  log('UDS', `Request ${hexId(spec.txId)}→${hexId(spec.rxId)} ${toHex(spec.body)}`, {
    uds_request: toHex(spec.body),
    inner: toHex(inner),
    ...headerDetail('tx.', decodeExecUdsHeader(inner)),
  });

  const base = { spec, requestNr, warnings };
  try {
    const result = await client.exchange<Decided>({
      command: MbitoCmd.EXEC_UDS,
      payload: inner,
      timeoutMs: spec.timeoutMs + BROWSER_MARGIN_MS,
      linkBusyForMs: spec.timeoutMs + BROWSER_MARGIN_MS,
      signal,
      onFrame: frame => {
        const receivedAt = performance.now();
        if (frame.arg !== MbitoArg.SUCCESS) return { kind: 'done', value: { kind: 'rejected', arg: frame.arg, receivedAt } };
        let response: DecodedExecUdsResponse;
        try {
          response = decodeExecUdsResponse(frame.payload);
        } catch (error) {
          return { kind: 'ignore', reason: (error as Error).message };
        }
        const { header } = response;
        log('UDS', 'RX EXEC_UDS frame', {
          outer: `cmd ${hexByte(frame.rawCommand)} arg ${hexByte(frame.arg)} len ${frame.payload.length}`,
          ...headerDetail('rx.', header),
          transport: response.transportStatus,
          uds_response: toHex(response.udsBody) || null,
        });
        if (header.txId !== spec.txId || header.rxId !== spec.rxId) {
          return { kind: 'ignore', reason: `address ${hexId(header.txId)}/${hexId(header.rxId)} is not this request's` };
        }
        // VERIFIED REAL VEHICLE: the dongle echoes request_nr (1→1, 0→0), so a mismatch is a late
        // reply to an earlier request and must never complete this one.
        if (header.requestNr !== requestNr) {
          return { kind: 'ignore', reason: `stale request_nr ${header.requestNr} (waiting for ${requestNr})` };
        }
        lastUds = response;
        if (response.udsBody.length === 0 && header.responseType === RawResponseType.NEGATIVE_RESPONSE) {
          // INFERRED (old MemoStats): 0xFF with no body = header-only placeholder; the real reply follows.
          return { kind: 'wait', reason: 'header-only 0xFF placeholder' };
        }
        const { semantic } = classifyUdsResponse(spec.body, response.udsBody);
        if (semantic === 'RESPONSE_PENDING') {
          pendingSeen = response;
          // 0xFD / 0xFE = the dongle already ended its wait: nothing more will come for this request.
          if (header.responseType === RawResponseType.FULL_TIMEOUT || header.responseType === RawResponseType.PARTIAL_TIMEOUT) {
            return { kind: 'done', value: { kind: 'uds', response, receivedAt } };
          }
          return { kind: 'wait', reason: 'NRC 0x78 ResponsePending', extendDeadlineMs: P2_STAR_SERVER_MAX_MS + BROWSER_MARGIN_MS };
        }
        return { kind: 'done', value: { kind: 'uds', response, receivedAt } };
      },
    });

    const decided = result.value;
    const sent = { txRaw: result.tx, sentAt: result.sentAt, writtenAt: result.writtenAt, frames: result.frames };
    const latencyMs = decided.receivedAt - result.sentAt;
    if (decided.kind === 'rejected') {
      warnings.push(`Dongle answered EXEC_UDS with arg ${hexByte(decided.arg)} (not SUCCESS)`);
      return finish({ ...base, ...sent, transport: 'DONGLE_REJECTED', semantic: 'NO_RESPONSE', latencyMs });
    }
    const { response } = decided;
    warnings.push(...response.warnings);
    const { semantic, nrc } = classifyUdsResponse(spec.body, response.udsBody);
    if (pendingSeen && semantic === 'NO_RESPONSE') {
      // 7F xx 78, then the dongle gave up (e.g. 0xFD, no body): the ECU is still pending, the transport timed out.
      warnings.push(`ECU sent NRC 0x78, then the dongle ended with ${response.transportStatus} and no final response`);
      return finish({ ...base, ...sent, final: response, transport: response.transportStatus, semantic: 'RESPONSE_PENDING', nrc: 0x78, latencyMs });
    }
    return finish({ ...base, ...sent, final: response, transport: response.transportStatus, semantic, nrc, latencyMs });
  } catch (error) {
    if (!(error instanceof ExchangeTimeoutError)) throw error;
    const sent = { txRaw: error.tx, sentAt: error.sentAt, writtenAt: error.writtenAt, frames: error.frames };
    if (pendingSeen) {
      warnings.push(`ECU sent NRC 0x78 but no final response within ${P2_STAR_SERVER_MAX_MS} ms (P2*)`);
      return finish({ ...base, ...sent, final: pendingSeen, transport: 'HOST_TIMEOUT', semantic: 'RESPONSE_PENDING', nrc: 0x78, latencyMs: null });
    }
    if (lastUds) {
      warnings.push('Only a header-only placeholder arrived before the browser deadline');
      return finish({ ...base, ...sent, final: lastUds, transport: lastUds.transportStatus, semantic: 'NO_RESPONSE', latencyMs: null });
    }
    return finish({ ...base, ...sent, transport: 'NO_RX', semantic: 'NO_RESPONSE', latencyMs: null });
  }
}

function statusText(r: UdsExchangeResult): string {
  switch (r.semantic) {
    case 'POSITIVE_RESPONSE': return 'OK';
    case 'NEGATIVE_RESPONSE': return `NEGATIV ${hexByte(r.nrc ?? 0)}`;
    case 'RESPONSE_PENDING': return `ÎN AȘTEPTARE (0x78)${r.transport === 'OK' || r.transport === 'NEGATIVE_RESPONSE' ? '' : ` · ${r.transport}`}`;
    case 'UNEXPECTED_RESPONSE': return 'RĂSPUNS NEAȘTEPTAT';
    case 'NO_RESPONSE':
      return r.transport === 'FULL_TIMEOUT' ? 'FĂRĂ RĂSPUNS (FD)' : r.transport === 'NO_RX' ? 'FĂRĂ CADRU DE LA DONGLE' : 'FĂRĂ RĂSPUNS';
  }
}

function finish(partial: Omit<UdsExchangeResult, 'presence' | 'requestNrEchoed'>): UdsExchangeResult {
  const echoedNr = partial.final?.header.requestNr;
  const result: UdsExchangeResult = {
    ...partial,
    presence: presenceOf(partial.semantic),
    requestNrEchoed: echoedNr === undefined ? null : echoedNr === partial.requestNr,
  };
  if (result.requestNrEchoed === false) {
    result.warnings.push(`request_nr not echoed (sent ${partial.requestNr}, got ${echoedNr})`);
  }
  const lastFrame = result.frames.at(-1);
  recordTransaction({
    kind: partial.spec.body[0] === 0x01 ? 'OBD' : 'UDS',
    txId: partial.spec.txId,
    rxId: partial.spec.rxId,
    requestNr: partial.requestNr,
    request: toHex(partial.spec.body),
    response: partial.final ? toHex(partial.final.udsBody) || null : null,
    status: statusText(result),
    ok: result.semantic === 'POSITIVE_RESPONSE',
    answered: result.presence === 'PRESENT',
    latencyMs: result.latencyMs,
    detail: {
      ble_tx: toHex(partial.txRaw),
      ble_rx: result.frames.map(f => toHex(f.frame.raw)).join(' | ') || null,
      transport: partial.final && partial.transport === partial.final.transportStatus ? `${hexByte(partial.final.header.responseType)} ${partial.transport}` : partial.transport,
      semantic: result.semantic,
      timeout_ms: partial.spec.timeoutMs,
      delay_after_ms: partial.spec.delayAfterMs,
      exp_len: partial.spec.expectedResponseLength,
      pending_frames: result.frames.filter(f => f.decision.includes('0x78')).length,
      warnings: result.warnings.join(' | ') || null,
    },
  });
  const round = (ms: number | null | undefined) => (ms === null || ms === undefined ? null : Math.round(ms));
  log('UDS', `Result ${result.semantic} / transport ${result.transport}`, {
    can_tx: hexId(partial.spec.txId),
    can_rx: hexId(partial.spec.rxId),
    uds_request: toHex(partial.spec.body),
    ble_tx: toHex(partial.txRaw),
    ble_rx: result.frames.map(f => toHex(f.frame.raw)).join(' | ') || null,
    request_nr: partial.requestNr,
    request_nr_echoed: result.requestNrEchoed,
    resp_status: partial.final ? `${hexByte(partial.final.header.responseType)} ${partial.final.transportStatus}` : null,
    uds_response: partial.final ? toHex(partial.final.udsBody) || null : null,
    presence: result.presence,
    // timing split: BLE write acknowledgement vs dongle/CAN wait vs total
    ms_ble_write: round(partial.writtenAt === null ? null : partial.writtenAt - partial.sentAt),
    ms_write_to_rx: round(partial.writtenAt === null || !lastFrame ? null : lastFrame.receivedAt - partial.writtenAt),
    ms_total: round(result.latencyMs),
    dongle_timeout_ms: partial.spec.timeoutMs,
    warnings: result.warnings.join(' | ') || null,
  }, result.semantic === 'POSITIVE_RESPONSE' ? 'info' : 'warn');
  return result;
}
