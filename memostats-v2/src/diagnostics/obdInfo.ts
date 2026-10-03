import { toHex } from '../core/bytes';
import type { MbitoClient } from '../core/mbito/mbitoClient';
import { OBD_ENGINE, V1_PREFLIGHT_TIMING } from '../core/obd/obdRead';
import { type Readiness, decodeReadiness, decodeVin } from '../core/obd/readiness';
import { execUds } from '../core/uds/udsChannel';
import { log } from '../logs/logStore';
import { createStore } from '../state/createStore';

export interface ObdInfoState {
  status: 'idle' | 'running' | 'done' | 'error';
  readiness: Readiness | null;
  readinessRaw: string | null;
  vin: string | null;
  vinRaw: string | null;
  error: string | null;
}

export const obdInfoStore = createStore<ObdInfoState>({ status: 'idle', readiness: null, readinessRaw: null, vin: null, vinRaw: null, error: null });

/** 01 01 (exp_len 6) and 09 02 (exp_len 20) on V1's engine path, V1 direct-read timing. */
export async function readObdInfo(client: MbitoClient, signal?: AbortSignal): Promise<Omit<ObdInfoState, 'status' | 'error'>> {
  const readiness = await execUds(client, { ...OBD_ENGINE, ...V1_PREFLIGHT_TIMING, body: Uint8Array.of(0x01, 0x01), expectedResponseLength: 6 }, signal);
  const vin = await execUds(client, { ...OBD_ENGINE, ...V1_PREFLIGHT_TIMING, body: Uint8Array.of(0x09, 0x02), expectedResponseLength: 20 }, signal);
  const rBody = readiness.semantic === 'POSITIVE_RESPONSE' ? readiness.final?.udsBody : undefined;
  const vBody = vin.semantic === 'POSITIVE_RESPONSE' ? vin.final?.udsBody : undefined;
  const result = {
    readiness: rBody ? decodeReadiness(rBody) : null,
    readinessRaw: readiness.final ? toHex(readiness.final.udsBody) || null : null,
    vin: vBody ? decodeVin(vBody) : null,
    vinRaw: vin.final ? toHex(vin.final.udsBody) || null : null,
  };
  log('OBD', 'Readiness / VIN read', { readiness: result.readinessRaw, vin_raw: result.vinRaw, vin_decoded: result.vin !== null });
  return result;
}
