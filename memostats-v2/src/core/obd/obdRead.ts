import type { MbitoClient } from '../mbito/mbitoClient';
import { type UdsExchangeResult, type UdsRequestSpec, execUds } from '../uds/udsChannel';
import { PIDS, decodeMode01, mode01Request } from './pids';

/** Engine OBD address. VERIFIED REAL VEHICLE (V1): all V1 live data came from 0x7E0 → 0x7E8. */
export const OBD_ENGINE = { txId: 0x7e0, rxId: 0x7e8 } as const;

/**
 * V1 timing. VERIFIED V1 CAPTURE: live frames carry `C8 00 C8 00` = timeout 200 / delay_after 200
 * (V1's builder wrote the same value into both u16 fields). V1's connect-time direct reads used 1000/1000.
 */
export const V1_LIVE_TIMING = { timeoutMs: 200, delayAfterMs: 200 } as const;
export const V1_PREFLIGHT_TIMING = { timeoutMs: 1000, delayAfterMs: 1000 } as const;

export interface Mode01Result {
  pid: number;
  value: number | null;
  exchange: UdsExchangeResult;
}

/** The exact EXEC_UDS spec V1 used for a Mode 01 read: `01 <pid>`, exp_len = data bytes + 2. */
export function mode01Spec(pid: number, timing: { timeoutMs: number; delayAfterMs: number }, expectedResponseLength = (PIDS[pid]?.bytes ?? 4) + 2): UdsRequestSpec {
  return { ...OBD_ENGINE, body: mode01Request(pid), timeoutMs: timing.timeoutMs, delayAfterMs: timing.delayAfterMs, expectedResponseLength };
}

export async function readMode01(
  client: MbitoClient,
  pid: number,
  timing: { timeoutMs: number; delayAfterMs: number },
  signal?: AbortSignal,
  expectedResponseLength?: number,
): Promise<Mode01Result> {
  const exchange = await execUds(client, mode01Spec(pid, timing, expectedResponseLength), signal);
  const body = exchange.semantic === 'POSITIVE_RESPONSE' ? exchange.final?.udsBody : undefined;
  return { pid, value: body ? decodeMode01(pid, body) : null, exchange };
}
