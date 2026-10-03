import { type Bytes, hexByte, hexId, toHex } from '../core/bytes';
import type { MbitoClient } from '../core/mbito/mbitoClient';
import { MbitoCmd } from '../core/mbito/constants';
import { type ProbeOutcome, SCAN_PROBE_PAYLOAD_LENGTH, type ScanProbeReply, decodeScanProbe, probeEcu, probeOutcome } from '../core/mbito/scanProbe';
import { CancelledError, type DiagnosticScheduler, Priority } from '../core/scheduler/diagnosticScheduler';
import { execUds } from '../core/uds/udsChannel';
import { log } from '../logs/logStore';
import { createStore } from '../state/createStore';
import { opCodeFromF100 } from '../vehicle/identification/opCode';
import otherEndpoints from '../data/w176/other-endpoints.generated.json';
import { VEHICLE_MODULES, type VehicleModule } from '../vehicle/modules';
import { moduleKey, recordScan } from './inventoryHistory';
import { cacheScanResults, invalidateModuleCache } from './moduleCache';
import { recordScanIntoKnownInventory } from './knownInventory';
import { presenceFromModuleStatus, presenceReason } from './presence';
import { beginScanLog, finishScanLog, recordScanLog } from './scanLog';

// V1 / official Scan Vehicle workflow: 0x33 probe with `10 03` per module; every module that answered on CAN
// (any non-zero slot) gets the identification reads F100, F18C, F111, F121 (the official app's order).
// Read-only apart from the extended-session request itself, which both V1 and the official app sent.

/** RESPONDS = any non-zero CAN slot (see `session` for what the ECU did) · NO_ANSWER = B3 with a zero CAN slot
 * (no response this pass — not "absent") · HOST_TIMEOUT = no B3 (transport, not absence) · ERROR = BLE/client failure. */
export type ModuleStatus = 'RESPONDS' | 'NO_ANSWER' | 'HOST_TIMEOUT' | 'ERROR';

/** What a responding ECU did with `10 03`: ACCEPTED `50 03` · REJECTED `7F 10 nn` · OTHER any other frame. */
export type SessionReply = 'ACCEPTED' | 'REJECTED' | 'OTHER';

/** Identification DIDs read after F100. */
export type IdentificationDid = 'F18C' | 'F111' | 'F121';

/** A raw DID payload plus its ASCII decode when every byte is printable (else text = null; raw is authoritative). */
export interface DidValue {
  raw: string;
  text: string | null;
}

export interface ModuleResult {
  module: VehicleModule;
  status: ModuleStatus;
  /** diagnostic status of the probe reply; null when nothing answered */
  session: SessionReply | null;
  probeResponse: string | null;
  probeMs: number | null;
  f100: string | null;
  opCode: string | null;
  /** true = the F100 op code equals the variant MBito has on record */
  variantMatches: boolean | null;
  ids: Partial<Record<IdentificationDid, DidValue>>;
  error: string | null;
  /** pass that produced this result (2 = the retry) */
  pass?: 2;
  /** the B3 arrived after its probe's host deadline and was credited afterwards */
  lateB3?: true;
}

/** The 47 W176 catalog endpoints not in MBito's record for this car. */
const CATALOG_EXTRA_MODULES: readonly VehicleModule[] = otherEndpoints.map(e => ({
  name: e.names.join(' / '), txId: e.txId, rxId: e.rxId, variantName: e.groups.join(', '), opCode: '', group: e.groups.join(', '), type: e.types[0] ?? 'REGULAR_ECU',
}));
/**
 * Every W176 catalog endpoint (70, counted from data). Every scan probes all of them; MBito's 23-record
 * vehicle list only supplies metadata (name, variant, op code) — presence comes from the probe reply alone.
 */
export const SCAN_CANDIDATES: readonly VehicleModule[] = [...VEHICLE_MODULES, ...CATALOG_EXTRA_MODULES].sort((a, b) => a.txId - b.txId || a.rxId - b.rxId);
export const CATALOG_ENDPOINT_COUNT = SCAN_CANDIDATES.length;

export interface ScanState {
  status: 'idle' | 'running' | 'done' | 'cancelled';
  /** keys (moduleKey) seen for the first time in this scan */
  newKeys: string[];
  current: string | null;
  /** 1 = every candidate · 2 = one retry of the candidates that did not confirm in pass 1 */
  pass: 1 | 2;
  /** probes done / planned across both passes */
  done: number;
  total: number;
  /** one entry per candidate: the best outcome over both passes */
  results: ModuleResult[];
  finishedAt: number | null;
}

export const scanStore = createStore<ScanState>({ status: 'idle', newKeys: [], current: null, pass: 1, done: 0, total: CATALOG_ENDPOINT_COUNT, results: [], finishedAt: null });

/** Best evidence wins: confirmed > a completed probe with a zero slot > no B3 / error. */
const RANK: Record<ModuleStatus, number> = { RESPONDS: 2, NO_ANSWER: 1, HOST_TIMEOUT: 0, ERROR: 0 };

/** Official F100 read parameters (captured: timeout 200, delay_after 0, exp_len 7). */
const F100 = { body: Uint8Array.of(0x22, 0xf1, 0x00), timeoutMs: 200, delayAfterMs: 0, expectedResponseLength: 7 };
/** Official F18C/F111/F121 read parameters. VERIFIED V1 CAPTURE (official scan, SCCM166/TPM_172/PARK117):
 * `58 02 00 00 06 00 03 00` = timeout 600, delay_after 0, exp_len 6, cmd_len 3; replies came as 0xFE + `62 F1 xx …`. */
const ID_READ = { timeoutMs: 600, delayAfterMs: 0, expectedResponseLength: 6 };
const ID_DIDS: readonly IdentificationDid[] = ['F18C', 'F111', 'F121'];

/** Best string for a DID value: ASCII text when printable, else the raw hex, else null. */
export function didStr(v: DidValue | undefined): string | null {
  return v ? v.text ?? v.raw : null;
}

/** ASCII decode of a byte range when every byte is printable, else null (F18C serial, F111/F121 numbers). */
export function asciiIfPrintable(data: Uint8Array): string | null {
  return data.length > 0 && data.every(b => b >= 0x20 && b <= 0x7e) ? String.fromCharCode(...data) : null;
}

/** `62 F1 xx <data>` → the DID payload (after the 3-byte echo) as raw hex + optional ASCII text. */
export function didValue(body: Uint8Array): DidValue | null {
  const data = body.subarray(3);
  if (body[0] !== 0x62 || data.length === 0) return null;
  return { raw: toHex(data), text: asciiIfPrintable(data) };
}

/**
 * Probes all candidates one at a time (0x33 `10 03`), never stopping early, then retries once every
 * candidate that did not confirm (a zero slot is "no response this pass", not "absent"). Caches the result.
 * Every B3 that reaches the client during the scan is kept by the TX/RX ids inside it, so a reply that
 * lands after its probe's host deadline (or while another request waits) still counts for its ECU.
 */
export async function runEcuScan(client: MbitoClient, scheduler: DiagnosticScheduler, identify: boolean, signal: AbortSignal): Promise<void> {
  const list = SCAN_CANDIDATES;
  invalidateModuleCache('explicit rescan');
  scanStore.set(() => ({ status: 'running', newKeys: [], current: null, pass: 1, done: 0, total: list.length, results: [], finishedAt: null }));
  beginScanLog();
  log('SCAN', `ECU scan started (${list.length} candidates)`);
  let seq = 0;
  const seenB3 = new Map<string, { reply: ScanProbeReply; slot: Bytes }>();
  const stopWatching = client.onFrame(frame => {
    if (!frame.isResponse || frame.command !== MbitoCmd.SCAN_PROBE) return;
    try {
      const reply = decodeScanProbe(frame.payload);
      seenB3.set(moduleKey(reply.txId, reply.rxId), { reply, slot: frame.payload.slice(24, SCAN_PROBE_PAYLOAD_LENGTH) });
    } catch {
      // malformed B3: already logged raw by the client
    }
  });
  const replace = (result: ModuleResult) => scanStore.set(s => ({ ...s, results: s.results.map(r => (r.module === result.module ? result : r)) }));
  const probe = async (module: VehicleModule): Promise<ModuleResult> => {
    signal.throwIfAborted();
    scanStore.set(s => ({ ...s, current: module.name }));
    const trace = { seq: ++seq, pass: scanStore.get().pass };
    const result = await scheduler.run(`SCAN ${module.name}`, Priority.INTERACTIVE, s => scanModule(client, module, identify, s, trace), signal);
    scanStore.set(s => ({ ...s, done: s.done + 1 }));
    return result;
  };
  /** A host timeout whose B3 did arrive later is credited to its ECU (and identified if it answered). */
  const creditLateB3 = async () => {
    for (const r of scanStore.get().results) {
      const seen = r.status === 'HOST_TIMEOUT' ? seenB3.get(moduleKey(r.module.txId, r.module.rxId)) : undefined;
      if (!seen) continue;
      let credited: ModuleResult = { ...probeResult(r.module, probeOutcome(seen.reply), seen.reply, seen.slot, null), lateB3: true, ...(r.pass ? { pass: r.pass } : {}) };
      log('SCAN', `${r.module.name} (${hexId(r.module.txId)}): B3 arrived after the host deadline — credited`, { can_rx_frame: toHex(seen.slot), status: credited.status });
      recordScanLog({ seq: ++seq, pass: (r.pass ?? 1), kind: 'probe', txId: r.module.txId, rxId: r.module.rxId, requestHex: null, responseHex: toHex(seen.slot), parsed: toHex(seen.slot), outerStatus: 'B3 (întârziat)', udsPayload: null, presence: presenceFromModuleStatus(credited.status), reason: `B3 sosit după deadline-ul host — ${presenceReason(credited.status, credited.session, credited.probeResponse)}` });
      if (credited.status === 'RESPONDS' && identify) {
        const pending = credited;
        credited = await scheduler.run(`IDENT ${r.module.name}`, Priority.INTERACTIVE, s => identifyModule(client, pending, s, { seq, pass: r.pass ?? 1 }), signal);
      }
      replace(credited);
    }
  };
  try {
    for (const module of list) {
      const result = await probe(module);
      scanStore.set(s => ({ ...s, results: [...s.results, result] }));
    }
    await creditLateB3();
    const retry = scanStore.get().results.filter(r => r.status !== 'RESPONDS').map(r => r.module);
    scanStore.set(s => ({ ...s, pass: 2, total: s.total + retry.length }));
    log('SCAN', `ECU scan pass 2: retrying ${retry.length} unconfirmed candidates once`);
    for (const module of retry) {
      const result = await probe(module);
      const previous = scanStore.get().results.find(r => r.module === module);
      if (!previous || RANK[result.status] >= RANK[previous.status]) replace({ ...result, pass: 2 });
    }
    await creditLateB3();
    const results = scanStore.get().results;
    // A host timeout / error says nothing about the ECU, so it is not recorded as a miss in history.
    const completed = results.filter(r => r.status !== 'HOST_TIMEOUT' && r.status !== 'ERROR');
    const newKeys = recordScan(completed.map(r => ({ key: moduleKey(r.module.txId, r.module.rxId), name: r.module.name, responded: r.status === 'RESPONDS', status: r.status })));
    scanStore.set(s => ({ ...s, status: 'done', current: null, newKeys, finishedAt: Date.now() }));
    cacheScanResults(results, list.length);
    // Fold this scan into the persistent known vehicle inventory (separate from the current-scan cache).
    // Present modules refresh their identity; known-but-not-detected ones are kept, only marked as a miss.
    recordScanIntoKnownInventory(
      results.filter(r => r.status === 'RESPONDS').map(r => ({
        key: moduleKey(r.module.txId, r.module.rxId), txId: r.module.txId, rxId: r.module.rxId, scanName: r.module.name,
        opCode: r.opCode, hardware: didStr(r.ids.F111), software: didStr(r.ids.F121), serialRawHex: r.ids.F18C?.raw ?? null, serialText: r.ids.F18C?.text ?? null,
      })),
      new Set(list.map(m => moduleKey(m.txId, m.rxId))),
    );
    const count = (status: ModuleStatus) => results.filter(r => r.status === status).length;
    const found = count('RESPONDS');
    finishScanLog({
      candidates: list.length, present: found, absent: count('NO_ANSWER'), errors: count('HOST_TIMEOUT') + count('ERROR'),
      presentPairs: results.filter(r => r.status === 'RESPONDS').map(r => ({ txId: r.module.txId, rxId: r.module.rxId })),
    });
    log('SCAN', `SCAN COMPLETE: ${found}/${list.length} present`, {
      total_candidates: list.length, present_count: found,
      present_pairs: results.filter(r => r.status === 'RESPONDS').map(r => `${hexId(r.module.txId)}→${hexId(r.module.rxId)}`).join(' ') || null,
      confirmed_in_pass_2: results.filter(r => r.status === 'RESPONDS' && r.pass === 2).length, late_b3_credited: results.filter(r => r.lateB3).length,
      session_rejected: results.filter(r => r.session === 'REJECTED').length, zero_slot: count('NO_ANSWER'), host_timeout: count('HOST_TIMEOUT'), error: count('ERROR'), new: newKeys.join(' ') || null,
    }, found ? 'info' : 'warn');
  } catch (error) {
    scanStore.set(s => ({ ...s, status: 'cancelled', current: null, finishedAt: Date.now() }));
    if (!(error instanceof CancelledError) && !signal.aborted) throw error;
    log('SCAN', 'ECU scan cancelled', undefined, 'warn');
  } finally {
    stopWatching();
  }
}

const STATUS = { SESSION_ACCEPTED: 'RESPONDS', SESSION_REJECTED: 'RESPONDS', OTHER_RESPONSE: 'RESPONDS', NO_RESPONSE: 'NO_ANSWER', HOST_TIMEOUT: 'HOST_TIMEOUT' } as const;
const SESSION = { SESSION_ACCEPTED: 'ACCEPTED', SESSION_REJECTED: 'REJECTED', OTHER_RESPONSE: 'OTHER', NO_RESPONSE: null, HOST_TIMEOUT: null } as const;

function probeResult(module: VehicleModule, outcome: ProbeOutcome, reply: ScanProbeReply | null, slot: Uint8Array | null, probeMs: number | null): ModuleResult {
  const present = outcome !== 'NO_RESPONSE' && outcome !== 'HOST_TIMEOUT';
  // the ISO-TP payload when the length byte is sane, else the raw 8-byte slot — never dropped
  const probeResponse = present ? toHex(reply?.response ?? new Uint8Array()) || toHex(slot ?? new Uint8Array()) || null : null;
  return { module, status: STATUS[outcome], session: SESSION[outcome], probeResponse, probeMs, f100: null, opCode: null, variantMatches: null, ids: {}, error: null };
}

interface ScanTrace { seq: number; pass: 1 | 2 }

async function scanModule(client: MbitoClient, module: VehicleModule, identify: boolean, signal: AbortSignal, trace: ScanTrace): Promise<ModuleResult> {
  try {
    const probe = await probeEcu(client, module.txId, module.rxId, signal);
    const slot = probe.rxRaw?.subarray(4 + 24, 4 + SCAN_PROBE_PAYLOAD_LENGTH) ?? null;
    const result = probeResult(module, probe.outcome, probe.reply, slot, probe.latencyMs);
    // Scan Protocol Log entry for this candidate (raw BLE + presence decision + reason).
    recordScanLog({
      seq: trace.seq, pass: trace.pass, kind: 'probe', txId: module.txId, rxId: module.rxId,
      requestHex: toHex(probe.txRaw), responseHex: probe.rxRaw ? toHex(probe.rxRaw) : null,
      parsed: slot ? toHex(slot) : null, outerStatus: probe.rxRaw ? `B3 arg ${hexByte(probe.rxRaw[1] ?? 0)}` : 'niciun cadru B3',
      udsPayload: null, presence: presenceFromModuleStatus(result.status), reason: presenceReason(result.status, result.session, result.probeResponse),
    });
    return probe.present && identify ? await identifyModule(client, result, signal, trace) : result;
  } catch (error) {
    if (error instanceof CancelledError || signal.aborted) throw error;
    log('SCAN', `${module.name} (${hexId(module.txId)}) failed`, { error: (error as Error).message }, 'error');
    recordScanLog({ seq: trace.seq, pass: trace.pass, kind: 'probe', txId: module.txId, rxId: module.rxId, requestHex: null, responseHex: null, parsed: null, outerStatus: null, udsPayload: null, presence: 'error', reason: `eroare BLE: ${(error as Error).message}` });
    return { ...probeResult(module, 'HOST_TIMEOUT', null, null, null), status: 'ERROR', error: (error as Error).message };
  }
}

/** F100, F18C, F111, F121 on a present module. Presence is already decided; a failed read only leaves its field empty
 * and NEVER downgrades presence. Every identification request/response is recorded to the scan log. */
async function identifyModule(client: MbitoClient, confirmed: ModuleResult, signal: AbortSignal, trace: ScanTrace): Promise<ModuleResult> {
  const { module } = confirmed;
  const read = async (label: string, spec: typeof F100) => {
    try {
      const exchange = await execUds(client, { txId: module.txId, rxId: module.rxId, ...spec }, signal);
      recordScanLog({
        seq: trace.seq, pass: trace.pass, kind: 'identify', txId: module.txId, rxId: module.rxId,
        requestHex: toHex(exchange.txRaw), responseHex: exchange.frames.map(f => toHex(f.frame.raw)).join(' | ') || null,
        parsed: exchange.final ? toHex(exchange.final.udsBody) || null : null, outerStatus: exchange.final ? `${hexByte(exchange.final.header.responseType)} ${exchange.transport}` : exchange.transport,
        udsPayload: exchange.final ? toHex(exchange.final.udsBody) || null : null, presence: null, reason: `${label} → ${exchange.semantic}`,
      });
      return exchange.semantic === 'POSITIVE_RESPONSE' ? exchange.final?.udsBody ?? null : null;
    } catch (error) {
      if (error instanceof CancelledError || signal.aborted) throw error;
      log('SCAN', `${module.name} (${hexId(module.txId)}) ${label} failed`, { error: (error as Error).message }, 'warn');
      recordScanLog({ seq: trace.seq, pass: trace.pass, kind: 'identify', txId: module.txId, rxId: module.rxId, requestHex: null, responseHex: null, parsed: null, outerStatus: null, udsPayload: null, presence: null, reason: `${label} eroare: ${(error as Error).message}` });
      return null;
    }
  };
  const result: ModuleResult = { ...confirmed, ids: {} };
  const f100 = await read('F100', F100);
  result.f100 = f100 && f100.length ? toHex(f100) : null;
  result.opCode = f100 ? opCodeFromF100(f100) : null;
  result.variantMatches = result.opCode === null ? null : result.opCode === module.opCode;
  // F18C serial (ASCII or binary), F111 hardware, F121 software. A failed/negative/pending read leaves the
  // field empty and NEVER downgrades presence (presence was decided by the B3 probe).
  for (const did of ID_DIDS) {
    const body = await read(did, { body: Uint8Array.of(0x22, 0xf1, parseInt(did.slice(2), 16)), ...ID_READ });
    const value = body ? didValue(body) : null;
    if (value !== null) result.ids[did] = value;
  }
  return result;
}
