import { toHex } from '../../core/bytes';
import type { MbitoClient } from '../../core/mbito/mbitoClient';
import { type UdsExchangeResult, execUds } from '../../core/uds/udsChannel';
import { log } from '../../logs/logStore';
import type { VehicleModule } from '../../vehicle/modules';
import { type DtcFamily, type DtcRecord, parseDtcCount, parseDtcList } from './dtcCodec';

// Read-only DTC strategies (master spec §33). No clear, no reset — there is no code path for either.
//   REGULAR_ECU:     19 01 0D (count; official app, exp_len 3) → 19 02 0D only when count > 0
//   OLD_ECU_MANSPEC: 19 02 0D directly (V1 behaviour for HVAC246 / FSCM212)
// Timing follows the V1 builder (timeout 1000, delay_after = timeout); list exp_len 0 as in V1.
// NRC 0x78 ResponsePending is handled by execUds (keeps waiting up to P2*).

const TIMING = { timeoutMs: 1000, delayAfterMs: 1000 };
const COUNT = Uint8Array.of(0x19, 0x01, 0x0d);
const LIST = Uint8Array.of(0x19, 0x02, 0x0d);

export type DtcReadStatus = 'OK' | 'NO_ANSWER' | 'NEGATIVE' | 'PENDING' | 'INVALID';

export interface ModuleDtcResult {
  module: VehicleModule;
  family: DtcFamily;
  status: DtcReadStatus;
  count: number | null;
  records: DtcRecord[];
  nrc: number | null;
  warnings: string[];
  rawResponse: string | null;
}

export function dtcFamily(type: string): DtcFamily {
  return type === 'OLD_ECU_MANSPEC' ? 'OLD_ECU_MANSPEC' : 'REGULAR_ECU';
}

function outcome(exchange: UdsExchangeResult): DtcReadStatus | null {
  if (exchange.semantic === 'NO_RESPONSE' || exchange.semantic === 'UNEXPECTED_RESPONSE') return 'NO_ANSWER';
  if (exchange.semantic === 'RESPONSE_PENDING') return 'PENDING';
  if (exchange.semantic === 'NEGATIVE_RESPONSE') return 'NEGATIVE';
  return null;
}

export async function readModuleDtcs(client: MbitoClient, module: VehicleModule, signal?: AbortSignal): Promise<ModuleDtcResult> {
  const family = dtcFamily(module.type);
  const base: ModuleDtcResult = { module, family, status: 'OK', count: null, records: [], nrc: null, warnings: [], rawResponse: null };
  const target = { txId: module.txId, rxId: module.rxId, ...TIMING };

  if (family === 'REGULAR_ECU') {
    const countExchange = await execUds(client, { ...target, body: COUNT, expectedResponseLength: 3 }, signal);
    const failed = outcome(countExchange);
    const countBody = countExchange.final?.udsBody;
    if (failed) return { ...base, status: failed, nrc: countExchange.nrc ?? null, rawResponse: countBody ? toHex(countBody) : null };
    const count = countBody ? parseDtcCount(countBody) : null;
    if (count === null) return { ...base, status: 'INVALID', rawResponse: countBody ? toHex(countBody) : null, warnings: ['Unexpected count response'] };
    if (count === 0) return { ...base, count, rawResponse: toHex(countBody ?? new Uint8Array()) };
    base.count = count;
  }

  const listExchange = await execUds(client, { ...target, body: LIST, expectedResponseLength: 0 }, signal);
  const failed = outcome(listExchange);
  const body = listExchange.final?.udsBody;
  if (failed) return { ...base, status: failed, nrc: listExchange.nrc ?? null, rawResponse: body ? toHex(body) : null };
  const parsed = parseDtcList(body ?? new Uint8Array(), family);
  const warnings = [...parsed.warnings, ...listExchange.warnings];
  if (base.count !== null && parsed.records.length !== base.count) warnings.push(`count said ${base.count}, list has ${parsed.records.length}`);
  log('DTC', `${module.name}: ${parsed.records.length} DTC`, { raw: body ? toHex(body) : null, codes: parsed.records.map(r => r.code).join(' ') || null, warnings: warnings.join(' | ') || null });
  return { ...base, status: parsed.kind === 'positive' ? 'OK' : 'INVALID', records: parsed.records, warnings, rawResponse: body ? toHex(body) : null };
}
