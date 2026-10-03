import { type Bytes, fromHex, hexId, toHex } from '../../core/bytes';
import { MbitoCmd } from '../../core/mbito/constants';
import { decodeFrame, encodeRequest } from '../../core/mbito/frame';
import type { MbitoClient } from '../../core/mbito/mbitoClient';
import { type DecodedExecUdsResponse, REQUEST_TYPE_DIAGNOSTIC, decodeExecUdsResponse, encodeExecUdsRequest } from '../../core/uds/execUds';
import { type UdsExchangeResult, type UdsRequestSpec, execUds } from '../../core/uds/udsChannel';
import evidence from '../../data/w176/evidence.json';
// Named import: Vite tree-shakes the rest of the record (VIN etc.) out of the bundle.
import { ecus as vehicleEcus } from '../../data/w176/sources/mbito-vehicle80903-ecus.json';
import { opCodeFromF100 } from './opCode';

/**
 * A request rebuilt from an official MBito response captured on this car. The dongle echoes the
 * request header, so every EXEC_UDS field below is copied from the captured frame, not typed in:
 * request_type, request_nr, tx_id, rx_id, timeout, delay_after, exp_len, cmd_len.
 * Two fields are overwritten by the dongle in a response and cannot be read back from a capture;
 * they come from the decompiled MBito builder instead (VERIFIED DECOMPILED REFERENCE, V2Utils):
 * resp_status = EResponseType.placeholder (0xFF) and payload_len = command length.
 * The UDS body is the only other input: 22 F1 00, implied by cmd_len 3 and the reply 62 F1 00.
 */
export interface OfficialReplica {
  ecu: string;
  spec: Required<UdsRequestSpec>;
  /** exact BLE packet the test will write */
  txPreview: Bytes;
  capturedRx: Bytes;
  captured: DecodedExecUdsResponse;
  catalogOpCode: string | null;
  captureSession: string;
}

export function replicaFromCapture(ecu: string, rxHex: string, udsRequestHex: string): OfficialReplica {
  const capturedRx = fromHex(rxHex);
  const captured = decodeExecUdsResponse(decodeFrame(capturedRx).payload);
  const { header } = captured;
  const body = fromHex(udsRequestHex);
  if (header.requestType !== REQUEST_TYPE_DIAGNOSTIC) throw new Error(`${ecu}: captured request_type ${header.requestType} is not a diagnostic read`);
  if (header.requestLength !== body.length) throw new Error(`${ecu}: captured cmd_len ${header.requestLength} ≠ request ${udsRequestHex}`);
  if (body[0] !== 0x22) throw new Error(`${ecu}: replica must be a ReadDataByIdentifier`);
  const record = vehicleEcus.find(e => e.transmitIdNumeric === header.txId && e.receiveIdNumeric === header.rxId);
  const spec = {
    txId: header.txId,
    rxId: header.rxId,
    body,
    timeoutMs: header.timeoutMs,
    delayAfterMs: header.delayAfterMs,
    expectedResponseLength: header.expectedLength,
    requestNr: header.requestNr,
  };
  return {
    ecu,
    spec,
    txPreview: encodeRequest(MbitoCmd.EXEC_UDS, encodeExecUdsRequest(spec)),
    capturedRx,
    captured,
    catalogOpCode: record?.opCode ?? null,
    captureSession: evidence.officialCaptureSession.id,
  };
}

function capturedFrame(txId: number, udsRequest: string): string {
  const match = evidence.officialCaptureSession.execUdsFrames.find(f =>
    f.udsRequest === udsRequest && decodeExecUdsResponse(decodeFrame(fromHex(f.rxHex)).payload).header.txId === txId);
  if (!match) throw new Error(`No official capture for ${hexId(txId)} ${udsRequest}`);
  return match.rxHex;
}

/**
 * Next vehicle test. Chosen because it is the cleanest official transaction captured on this car:
 * resp_status 0x00 OK with exactly exp_len bytes (no 0xFE ambiguity), a pure ReadDataByIdentifier,
 * MBito's defaultTimeout (200 ms), and SCCM166 was also detected by the official 22-ECU scan.
 */
export const SCCM166_F100_REPLICA = replicaFromCapture('SCCM166', capturedFrame(0x622, '22 F1 00'), '22 F1 00');

export interface ReplicaTestResult extends UdsExchangeResult {
  replica: OfficialReplica;
  /** true when today's UDS body is byte-identical to the captured official one */
  bodyMatchesCapture: boolean | null;
  opCode: string | null;
  opCodeMatchesCatalog: boolean | null;
}

export async function runOfficialReplicaTest(client: MbitoClient, signal?: AbortSignal, replica = SCCM166_F100_REPLICA): Promise<ReplicaTestResult> {
  const result = await execUds(client, replica.spec, signal);
  const body = result.final?.udsBody;
  const opCode = result.semantic === 'POSITIVE_RESPONSE' && body ? opCodeFromF100(body) : null;
  return {
    ...result,
    replica,
    bodyMatchesCapture: body && body.length ? toHex(body) === toHex(replica.captured.udsBody) : null,
    opCode,
    opCodeMatchesCatalog: opCode === null || replica.catalogOpCode === null ? null : opCode === replica.catalogOpCode,
  };
}
