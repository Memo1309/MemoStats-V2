// Mileage Check (spec §18): metadata-driven odometer reads from the DB's measure_commands. Each command
// gives the request, the byte layout and the scale. We show the value, source ECU, raw response and a
// factual delta between sources — never a fraud judgement.
import { fromHex, toHex } from '../core/bytes';
import type { MbitoClient } from '../core/mbito/mbitoClient';
import { execUds } from '../core/uds/udsChannel';
import { parseCanId } from '../w176/catalog';
import type { W176Db, W176InventoryEcu, W176MeasureCommand } from '../w176/types';

export interface MileageReading {
  readonly reference: string; // 'ignition_mileage' | 'instrument_mileage' | 'engine_mileage'
  readonly ecuName: string;
  readonly measureName: string;
  readonly txId: number;
  readonly rxId: number;
  readonly request: string;
  readonly rawResponse: string | null;
  readonly km: number | null;
  readonly unit: string;
  readonly at: number;
  readonly error: string | null;
}

/** Reads one measure command from its ECU and applies the DB parsing options (read big/little, multiply). */
function decodeMeasure(cmd: W176MeasureCommand, udsBody: Uint8Array): { value: number; unit: string } | null {
  let value: number | null = null;
  let unit = 'km';
  for (const op of cmd.parsing_options) {
    const o = op as { op: string; start_bit?: number; length_bits?: number; byte_order?: string; value?: number; unit?: string };
    if (o.op === 'read') {
      const lenBytes = (o.length_bits ?? 0) / 8;
      if (!Number.isInteger(lenBytes) || lenBytes <= 0) return null;
      // udsBody = [service + DID echo][data...]; the data sits at the tail after the echo.
      let v = 0;
      for (let i = 0; i < lenBytes; i++) {
        const byte = udsBody[udsBody.length - lenBytes + i] ?? 0;
        v = o.byte_order === 'little' ? v + byte * 256 ** i : v * 256 + byte;
      }
      value = v;
    } else if (o.op === 'multiply' && typeof o.value === 'number') {
      value = (value ?? 0) * o.value;
      if (typeof o.unit === 'string') unit = o.unit;
    }
  }
  return value === null ? null : { value, unit };
}

function ecuFor(db: W176Db, cmd: W176MeasureCommand): W176InventoryEcu | undefined {
  return [...db.inventory.latest_ecus, ...db.inventory.supplemental_ecus].find(e => e.ecu_id === cmd.ecu_id);
}

/** Reads every mileage measure command in the DB, from whichever source ECUs answer. */
export async function readAllMileage(client: MbitoClient, db: W176Db, signal?: AbortSignal): Promise<MileageReading[]> {
  const commands = db.diagnostics.measure_commands.filter(c => c.measure_type_name?.toLowerCase() === 'mileage' || c.reference?.endsWith('_mileage'));
  const readings: MileageReading[] = [];
  for (const cmd of commands) {
    const ecu = ecuFor(db, cmd);
    const txId = ecu ? parseCanId(ecu.transmit_id) : 0;
    const rxId = ecu ? parseCanId(ecu.receive_id) : 0;
    const base = { reference: cmd.reference, ecuName: cmd.ecu_name, measureName: cmd.measure_name, txId, rxId, request: fmtReq(cmd.payload_to_get), at: Date.now() };
    if (!ecu) {
      readings.push({ ...base, rawResponse: null, km: null, unit: 'km', error: 'ECU necunoscut în inventar' });
      continue;
    }
    try {
      const result = await execUds(client, { txId, rxId, body: fromHex(cmd.payload_to_get), timeoutMs: 1500, delayAfterMs: 0, expectedResponseLength: cmd.len_rec }, signal);
      const uds = result.final?.udsBody;
      if (result.semantic !== 'POSITIVE_RESPONSE' || !uds) {
        readings.push({ ...base, rawResponse: uds ? toHex(uds) : null, km: null, unit: 'km', error: result.semantic === 'NEGATIVE_RESPONSE' ? `refuz NRC 0x${(result.nrc ?? 0).toString(16)}` : 'fără răspuns' });
        continue;
      }
      const decoded = decodeMeasure(cmd, uds);
      readings.push({ ...base, rawResponse: toHex(uds), km: decoded?.value ?? null, unit: decoded?.unit ?? 'km', error: decoded ? null : 'nu s-a putut decoda' });
    } catch (error) {
      readings.push({ ...base, rawResponse: null, km: null, unit: 'km', error: error instanceof Error ? error.message : String(error) });
    }
  }
  return readings;
}

/** Factual pairwise deltas between successful readings (km). No labelling. */
export function mileageDeltas(readings: readonly MileageReading[]): { a: string; b: string; deltaKm: number }[] {
  const ok = readings.filter(r => r.km !== null);
  const out: { a: string; b: string; deltaKm: number }[] = [];
  for (let i = 0; i < ok.length; i++) {
    for (let j = i + 1; j < ok.length; j++) {
      const a = ok[i];
      const b = ok[j];
      if (!a || !b) continue;
      out.push({ a: a.ecuName, b: b.ecuName, deltaKm: Math.round(((a.km ?? 0) - (b.km ?? 0)) * 10) / 10 });
    }
  }
  return out;
}

const fmtReq = (hex: string): string => (fromHex(hex), toHex(fromHex(hex)));
