import { fromHex } from '../core/bytes';
import type { MbitoClient } from '../core/mbito/mbitoClient';
import { type UdsExchangeResult, type UdsRequestSpec, execUds } from '../core/uds/udsChannel';

/**
 * Developer manual request — READ services only. Enforced here, below the UI:
 * OBD modes 01/02/03/07/09/0A and UDS 0x19 ReadDTCInformation / 0x22 ReadDataByIdentifier.
 * No session control, no writes, no routines, no security access, no clearing, no resets.
 */
export const READ_ONLY_SIDS: ReadonlySet<number> = new Set([0x01, 0x02, 0x03, 0x07, 0x09, 0x0a, 0x19, 0x22]);

export interface ManualRequestInput {
  txHex: string;
  rxHex: string;
  bodyHex: string;
  timeoutMs: number;
  delayAfterMs: number;
  expectedResponseLength: number;
}

export function validateManualRequest(input: ManualRequestInput): UdsRequestSpec {
  const txId = parseInt(input.txHex, 16);
  const rxId = parseInt(input.rxHex, 16);
  if (!Number.isInteger(txId) || !Number.isInteger(rxId) || txId < 0 || rxId < 0 || txId > 0x1fffffff || rxId > 0x1fffffff) {
    throw new Error('TX/RX: CAN id hex invalid');
  }
  const body = fromHex(input.bodyHex);
  const sid = body[0];
  if (sid === undefined || body.length > 16) throw new Error('Cererea trebuie să aibă 1–16 octeți');
  if (!READ_ONLY_SIDS.has(sid)) throw new Error(`Serviciul 0x${sid.toString(16).toUpperCase()} nu este de citire — blocat`);
  const within = (v: number, max: number) => Number.isInteger(v) && v >= 0 && v <= max;
  if (!within(input.timeoutMs, 5000) || !within(input.delayAfterMs, 5000) || !within(input.expectedResponseLength, 4095)) {
    throw new Error('timeout / delay_after ≤ 5000 ms, exp_len ≤ 4095');
  }
  return { txId, rxId, body, timeoutMs: input.timeoutMs, delayAfterMs: input.delayAfterMs, expectedResponseLength: input.expectedResponseLength };
}

export function runManualRequest(client: MbitoClient, input: ManualRequestInput, signal?: AbortSignal): Promise<UdsExchangeResult> {
  return execUds(client, validateManualRequest(input), signal);
}
