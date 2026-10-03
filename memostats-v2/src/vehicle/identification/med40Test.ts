import type { MbitoClient } from '../../core/mbito/mbitoClient';
import { type UdsExchangeResult, type UdsRequestSpec, execUds } from '../../core/uds/udsChannel';
import { MED40 } from '../../data/w176/knownEcus';
import { opCodeFromF100 } from './opCode';

/**
 * First hardware milestone: one read-only ReadDataByIdentifier F100 to the engine ECU.
 * Parameters mirror the official app's identification requests, read back from the header echo in
 * real captured responses (VERIFIED REAL VEHICLE): delay_after 0, exp_len 7 for F100, and the 600 ms
 * timeout it uses for the other identification DIDs (it used 200 ms for F100 — 600 gives margin).
 */
export const MED40_IDENTIFICATION_REQUEST: UdsRequestSpec = {
  txId: MED40.txId,
  rxId: MED40.rxId,
  body: Uint8Array.of(0x22, 0xf1, 0x00),
  timeoutMs: 600,
  delayAfterMs: 0,
  expectedResponseLength: 7,
};

export interface Med40TestResult extends UdsExchangeResult {
  opCode: string | null;
  /** null when no op code could be read */
  opCodeMatchesCatalog: boolean | null;
}

export async function runMed40IdentificationTest(client: MbitoClient, signal?: AbortSignal): Promise<Med40TestResult> {
  const result = await execUds(client, MED40_IDENTIFICATION_REQUEST, signal);
  const opCode = result.semantic === 'POSITIVE_RESPONSE' && result.final ? opCodeFromF100(result.final.udsBody) : null;
  return { ...result, opCode, opCodeMatchesCatalog: opCode === null ? null : opCode === MED40.opCode };
}
