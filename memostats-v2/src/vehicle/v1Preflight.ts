import { toHex } from '../core/bytes';
import type { MbitoClient } from '../core/mbito/mbitoClient';
import { type Mode01Result, V1_PREFLIGHT_TIMING, readMode01 } from '../core/obd/obdRead';
import { decodeSupportedPids } from '../core/obd/pids';
import { log } from '../logs/logStore';
import { recordTransaction } from '../logs/transactions';

// MemoStats V1's connect-time sequence (App.tsx runInitialCanDiagnostics), which preceded every
// successful V1 live session. Reproduced step for step:
//   1. GET_CAN_BAUD            11 79 00 00
//   2. 01 0D  on 7E0→7E8       timeout 1000 / delay_after 1000 / exp_len 3
//   3. 01 0C                   timeout 1000 / delay_after 1000 / exp_len 4
//   4. only if 2 or 3 answered: supported-PID discovery 01 00, 01 20 … (exp_len 6, 1000 ms),
//      continuing while the block's last bit says the next block exists (V1 obdDiscovery.ts).

export interface PreflightResult {
  canBaud: { arg: number; payloadHex: string; rawHex: string } | null;
  canBaudError: string | null;
  speed: Mode01Result;
  rpm: Mode01Result;
  speedOk: boolean;
  rpmOk: boolean;
  /** empty when discovery did not run or found nothing — then V1 polls its core set anyway */
  supportedPids: number[];
}

const BLOCKS = [0x00, 0x20, 0x40, 0x60, 0x80, 0xa0, 0xc0, 0xe0];

export async function runV1Preflight(client: MbitoClient, signal?: AbortSignal): Promise<PreflightResult> {
  let canBaud: PreflightResult['canBaud'] = null;
  let canBaudError: string | null = null;
  try {
    const reply = await client.getCanBaud(signal);
    canBaud = { arg: reply.arg, payloadHex: toHex(reply.payload), rawHex: toHex(reply.raw) };
    recordTransaction({ kind: 'DONGLE', request: 'GET_CAN_BAUD', response: canBaud.rawHex, status: `arg 0x${reply.arg.toString(16).toUpperCase()}`, ok: true, latencyMs: null, detail: { ble_tx: '11 79 00 00', ble_rx: canBaud.rawHex } });
    log('MBITO', 'CAN preflight (GET_CAN_BAUD)', { raw: canBaud.rawHex, arg: reply.arg, payload: canBaud.payloadHex || null });
  } catch (error) {
    signal?.throwIfAborted();
    canBaudError = (error as Error).message;
    log('MBITO', 'CAN preflight failed — continuing like V1', { error: canBaudError }, 'warn');
  }

  const speed = await readMode01(client, 0x0d, V1_PREFLIGHT_TIMING, signal);
  const rpm = await readMode01(client, 0x0c, V1_PREFLIGHT_TIMING, signal);
  const speedOk = speed.value !== null;
  const rpmOk = rpm.value !== null;

  const supportedPids: number[] = [];
  if (speedOk || rpmOk) {
    for (const block of BLOCKS) {
      const { exchange } = await readMode01(client, block, V1_PREFLIGHT_TIMING, signal, 6);
      const pids = exchange.final && exchange.semantic === 'POSITIVE_RESPONSE' ? decodeSupportedPids(block, exchange.final.udsBody) : [];
      supportedPids.push(...pids);
      if (!pids.includes(block + 0x20)) break;
    }
  }
  log('OBD', `V1 preflight: speed ${speedOk ? 'OK' : 'no answer'}, rpm ${rpmOk ? 'OK' : 'no answer'}`, {
    speed: speed.value, rpm: rpm.value, supported_pids: supportedPids.map(p => p.toString(16).padStart(2, '0')).join(' ') || null,
  }, speedOk || rpmOk ? 'info' : 'warn');
  return { canBaud, canBaudError, speed, rpm, speedOk, rpmOk, supportedPids };
}
