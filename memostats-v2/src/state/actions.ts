// The only surface the UI calls. UI never sees BLE, MBito frames or EXEC_UDS packets.
import { SILENT_REASON, isCapturing, startCapture, stopCapture } from '../capture/captureStore';
import { hexId, toHex } from '../core/bytes';
import { MbitoBleTransport } from '../core/ble/mbitoBleTransport';
import { MbitoCmd } from '../core/mbito/constants';
import { encodeRequest } from '../core/mbito/frame';
import { MbitoClient } from '../core/mbito/mbitoClient';
import { SCAN_PROBE_PAYLOAD_LENGTH, encodeScanProbe, probeEcu } from '../core/mbito/scanProbe';
import { DiagnosticScheduler, Priority } from '../core/scheduler/diagnosticScheduler';
import { execUds } from '../core/uds/udsChannel';
import { runDtcScan } from '../diagnostics/dtc/dtcScan';
import { runEcuScan } from '../diagnostics/ecuScan';
import { invalidateModuleCache, moduleCache, noteVehicleVin } from '../diagnostics/moduleCache';
import { obdInfoStore, readObdInfo } from '../diagnostics/obdInfo';
import { log } from '../logs/logStore';
import { recordTransaction } from '../logs/transactions';
import { liveStore, startLive, stopLive } from '../telemetry/liveTelemetry';
import { runMed40IdentificationTest } from '../vehicle/identification/med40Test';
import { runOfficialReplicaTest as runReplica } from '../vehicle/identification/officialReplica';
import { type ManualRequestInput, runManualRequest as runManual } from '../vehicle/manualRequest';
import { runV1Preflight } from '../vehicle/v1Preflight';
import { type CommitResult, type CodingTarget, type WriteProposal, commitWrite, readCodingBlock, restoreFromBackup } from '../coding/codingEngine';
import type { CodingBackup } from '../coding/backupStore';
import type { CodingFeatureModel, CodingSectionRef } from '../coding/codingModel';
import { type ResolvedWorkflow, type WorkflowResult, type WorkflowStepResult, executeWorkflow } from '../coding/multiFeature';
import { type MileageReading, readAllMileage } from '../diagnostics/mileage';
import { type ProbeDebug, type RawNotification, type UdsDebug, scanDebugStore } from '../diagnostics/scanDebug';
import { type AppState, type TestState, getState, setState } from './appState';
import { settingsStore } from './settings';

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => { clearTimeout(timer); reject(signal.reason); }, { once: true });
  });
}

const transport = new MbitoBleTransport();
const client = new MbitoClient(transport);
// Passive capture is exclusive: the scheduler refuses every job while it listens (and the link refuses writes).
const scheduler = new DiagnosticScheduler(() => (isCapturing() ? SILENT_REASON : null));
const liveDeps = { client, scheduler, pollPeriodMs: () => settingsStore.get().pollPeriodMs };
let scanAbort: AbortController | undefined;

transport.onDisconnect(userInitiated => {
  invalidateModuleCache('MBito disconnect');
  stopLive(userInitiated ? 'deconectare' : 'conexiune BLE pierdută');
  scanAbort?.abort();
  scheduler.cancelAll(userInitiated ? 'Deconectare' : 'Conexiune BLE pierdută');
  setState(s => ({
    ...s,
    connection: userInitiated ? 'disconnected' : 'lost',
    dongle: { ...s.dongle, reading: false },
    preflight: failIfRunning(s.preflight),
    med40: failIfRunning(s.med40),
    replica: failIfRunning(s.replica),
    manual: failIfRunning(s.manual),
  }));
});

export const isBluetoothSupported = (): boolean => MbitoBleTransport.isSupported();

/** Every vehicle operation is rejected while passive capture listens; the refusal is logged, never silent. */
function refusedByCapture(action: string): boolean {
  if (!isCapturing()) return false;
  log('APP', `${action} refuzat: ${SILENT_REASON}`, undefined, 'warn');
  return true;
}

/** BLE → GET_DEV_NAME → GET_FW_VERSION → GET_VOLTAGE → V1 preflight → live data (V1 order). */
export async function connectDongle(): Promise<void> {
  const { connection } = getState();
  if (connection === 'connecting' || connection === 'connected') return;
  setState(s => ({ ...s, connection: 'connecting', connectionError: undefined }));
  try {
    const bleDeviceName = connection === 'lost' ? await transport.reconnect() : await transport.connect();
    setState(s => ({ ...s, connection: 'connected', bleDeviceName }));
  } catch (error) {
    // NotFoundError = the user closed the device chooser; not worth an error banner.
    const cancelled = error instanceof DOMException && error.name === 'NotFoundError';
    log('BLE', cancelled ? 'Device chooser dismissed' : `Connect failed: ${message(error)}`, undefined, cancelled ? 'info' : 'error');
    setState(s => ({ ...s, connection: connection === 'lost' ? 'lost' : 'disconnected', connectionError: cancelled ? undefined : message(error) }));
    return;
  }
  if (refusedByCapture('Citire dongle + preflight după conectare')) return;
  await readDongleInfo();
  await runPreflight();
}

export function disconnectDongle(): void {
  stopLive('deconectare');
  scanAbort?.abort();
  scheduler.cancelAll('Deconectare');
  transport.disconnect();
}

async function readDongleInfo(): Promise<void> {
  setState(s => ({ ...s, dongle: { ...s.dongle, errors: [], reading: true } }));
  const errors: string[] = [];
  const read = <T>(label: string, task: (signal: AbortSignal) => Promise<T>): Promise<T | undefined> =>
    scheduler.run(label, Priority.INTERACTIVE, task).then(value => {
      recordTransaction({ kind: 'DONGLE', request: label, response: String(value), status: 'OK', ok: true, latencyMs: null, detail: {} });
      return value;
    }, (error: unknown) => {
      errors.push(`${label}: ${message(error)}`);
      log('MBITO', `${label} failed`, { error: message(error) }, 'error');
      return undefined;
    });

  const name = await read('GET_DEV_NAME', signal => client.getDeviceName(signal));
  const firmware = await read('GET_FW_VERSION', signal => client.getFirmwareVersion(signal));
  const voltage = await read('GET_VOLTAGE', signal => client.getVoltage(signal));
  log('MBITO', 'Dongle info', { name: name ?? null, firmware: firmware ?? null, voltage: voltage ?? null });
  setState(s => ({
    ...s,
    dongle: {
      name: name ?? s.dongle.name,
      firmware: firmware ?? s.dongle.firmware,
      voltage: voltage === undefined ? s.dongle.voltage : { value: voltage, at: Date.now() },
      errors,
      reading: false,
    },
  }));
}

/** V1 connect-time sequence; starts live data when OBD answered and the setting allows it. */
export async function runPreflight(): Promise<void> {
  if (getState().connection !== 'connected' || getState().preflight.status === 'running' || refusedByCapture('Preflight')) return;
  setState(s => ({ ...s, preflight: { status: 'running' } }));
  try {
    const result = await scheduler.run('V1 PREFLIGHT', Priority.INTERACTIVE, signal => runV1Preflight(client, signal));
    setState(s => ({ ...s, preflight: { status: 'done', result, finishedAt: Date.now() } }));
    if ((result.speedOk || result.rpmOk) && settingsStore.get().autoStartLive) startLive(liveDeps, result.supportedPids);
  } catch (error) {
    setState(s => ({ ...s, preflight: { status: 'error', error: message(error), finishedAt: Date.now() } }));
  }
}

export function startLiveData(): void {
  if (getState().connection !== 'connected' || diagnosticsBusy || refusedByCapture('Date live')) return;
  startLive(liveDeps, getState().preflight.result?.supportedPids ?? []);
}

export function stopLiveData(): void {
  stopLive('oprit de utilizator');
}

export async function refreshVoltage(): Promise<void> {
  if (getState().connection !== 'connected' || refusedByCapture('Citire tensiune')) return;
  try {
    const value = await scheduler.run('GET_VOLTAGE', Priority.INTERACTIVE, signal => client.getVoltage(signal));
    setState(s => ({ ...s, dongle: { ...s.dongle, voltage: { value, at: Date.now() } } }));
  } catch (error) {
    log('MBITO', 'GET_VOLTAGE failed', { error: message(error) }, 'error');
  }
}

let diagnosticsBusy = false;

/** Live data pauses during diagnostics (V1 did the same) and resumes afterwards. */
async function withLivePaused(label: string, task: (signal: AbortSignal) => Promise<void>): Promise<void> {
  if (getState().connection !== 'connected' || diagnosticsBusy || refusedByCapture(label)) return;
  diagnosticsBusy = true;
  const resumeLive = liveStore.get().active;
  stopLive(label);
  scanAbort = new AbortController();
  try {
    await task(scanAbort.signal);
  } catch (error) {
    log('SCAN', `${label} failed: ${message(error)}`, undefined, 'error');
  } finally {
    diagnosticsBusy = false;
    if (resumeLive && getState().connection === 'connected') startLiveData();
  }
}

/** Explicit (re)scan of all W176 candidates; rebuilds the session cache from scratch. */
export const startEcuScan = (): Promise<void> =>
  withLivePaused('scanare ECU', signal => runEcuScan(client, scheduler, settingsStore.get().identifyAfterProbe, signal));

/** SCANEAZĂ ERORI: module scan first when there is none, then DTCs from modules that answered. */
export const scanDtcs = (): Promise<void> =>
  withLivePaused('scanare erori', async signal => {
    // Reuse the session's cached modules; scan only when there is no valid cache yet.
    if (!moduleCache.get().valid) await runEcuScan(client, scheduler, settingsStore.get().identifyAfterProbe, signal);
    if (!moduleCache.get().valid) return;
    await runDtcScan(client, scheduler, moduleCache.get().modules.map(m => m.module), signal);
  });

/** Readiness (01 01) and VIN (09 02) on the engine OBD path. */
export const readVehicleObdInfo = (): Promise<void> =>
  withLivePaused('readiness', async signal => {
    obdInfoStore.set(s => ({ ...s, status: 'running', error: null }));
    try {
      const info = await scheduler.run('OBD INFO', Priority.INTERACTIVE, s => readObdInfo(client, s), signal);
      obdInfoStore.set(() => ({ status: 'done', error: null, ...info }));
      noteVehicleVin(info.vin);
    } catch (error) {
      obdInfoStore.set(s => ({ ...s, status: 'error', error: message(error) }));
    }
  });

export function cancelEcuScan(): void {
  scanAbort?.abort();
}

// ---------- coding (metadata-driven; access-0 writes only, security/sequence stays locked) ----------

/** Exclusive vehicle lock for a coding operation: refuse while capturing, pause live, hold the whole
 * read/write/verify so no live or performance poll interleaves. Returns the task's value (rethrows). */
async function withVehicleLock<T>(label: string, task: (signal: AbortSignal) => Promise<T>): Promise<T> {
  if (getState().connection !== 'connected') throw new Error('MBito nu este conectat');
  if (isCapturing()) throw new Error(SILENT_REASON);
  if (diagnosticsBusy) throw new Error('O altă operație de diagnoză este în curs');
  diagnosticsBusy = true;
  const resumeLive = liveStore.get().active;
  stopLive(label);
  const controller = new AbortController();
  scanAbort = controller;
  try {
    return await task(controller.signal);
  } finally {
    diagnosticsBusy = false;
    if (resumeLive && getState().connection === 'connected') startLiveData();
  }
}

export const codingReadBlock = (target: CodingTarget, section: CodingSectionRef): Promise<Uint8Array> =>
  withVehicleLock('citire codare', signal => readCodingBlock(client, target, section, signal));

export const codingCommit = (target: CodingTarget, feature: CodingFeatureModel, proposal: WriteProposal): Promise<CommitResult> =>
  withVehicleLock('scriere codare', signal => commitWrite(client, target, feature, proposal, signal));

export const runMileageCheck = (db: Parameters<typeof readAllMileage>[1]): Promise<MileageReading[]> =>
  withVehicleLock('kilometraj', signal => readAllMileage(client, db, signal));

export const runCodingWorkflow = (workflow: ResolvedWorkflow, onStep: (r: WorkflowStepResult) => void): Promise<WorkflowResult> =>
  withVehicleLock('workflow codare', signal => executeWorkflow(client, workflow, onStep, signal));

export const codingRestore = (backup: CodingBackup): Promise<CommitResult> =>
  withVehicleLock('restaurare codare', signal => restoreFromBackup(client, backup, signal));

// ---------- raw 0x33 / 0x40 transport debug (developer; one probe at a time) ----------

/** Runs ONE 0x33 probe, capturing the exact request and EVERY raw BLE notification during it. */
export const runProbeDebug = (txId: number, rxId: number): Promise<ProbeDebug> =>
  withVehicleLock(`test 0x33 ${hexId(txId)}`, async signal => {
    scanDebugStore.set(s => ({ ...s, running: true, note: null }));
    const notifications: RawNotification[] = [];
    const t0 = performance.now();
    const untap = transport.onRaw(e => { if (e.direction === 'RX') notifications.push({ atMs: Math.round(e.perfMs - t0), len: e.bytes.length, hex: toHex(e.bytes) }); });
    try {
      const requestHex = toHex(encodeRequest(MbitoCmd.SCAN_PROBE, encodeScanProbe(txId, rxId)));
      log('SCAN', `SCAN WRITE ${hexId(txId)}→${hexId(rxId)}`, { tx: hexId(txId), rx: hexId(rxId), byteLength: 36, hex: requestHex });
      const probe = await scheduler.run(`TEST 0x33 ${hexId(txId)}`, Priority.INTERACTIVE, s => probeEcu(client, txId, rxId, s), signal);
      await sleep(700, signal); // give a late B3 time to land in the raw capture even after the host timeout
      const slot = probe.rxRaw ? toHex(probe.rxRaw.subarray(4 + 24, 4 + SCAN_PROBE_PAYLOAD_LENGTH)) : null;
      const result: ProbeDebug['result'] = !probe.rxRaw ? 'NO_B3' : probe.present ? 'PRESENT' : probe.outcome === 'NO_RESPONSE' ? 'ZERO_SLOT' : 'PARSE_ERROR';
      const dbg: ProbeDebug = {
        txId, rxId, requestHex, requestOk: requestHex.startsWith('33 02 20 00') && requestHex.split(' ').length === 36,
        notifications, b3Received: probe.rxRaw !== null, decodedHex: probe.rxRaw ? toHex(probe.rxRaw) : null, responseSlotHex: slot,
        outcome: probe.outcome, present: probe.present, latencyMs: probe.latencyMs, result,
      };
      log('SCAN', `TEST 0x33 RESULT ${hexId(txId)}→${hexId(rxId)}: ${result}`, { notifications: notifications.length, b3: dbg.b3Received, slot });
      scanDebugStore.set(s => ({ ...s, probe: dbg, running: false }));
      return dbg;
    } catch (error) {
      scanDebugStore.set(s => ({ ...s, running: false }));
      throw error;
    } finally {
      untap();
    }
  });

/** Runs ONE read-only 22 F1 00 through the working 0x40 transport, as a CAN/ECU sanity fallback. */
export const runIdentifyDebug = (txId: number, rxId: number): Promise<UdsDebug> =>
  withVehicleLock(`test 0x40 ${hexId(txId)}`, async signal => {
    scanDebugStore.set(s => ({ ...s, running: true }));
    try {
      const spec = { txId, rxId, body: Uint8Array.of(0x22, 0xf1, 0x00), timeoutMs: 700, delayAfterMs: 0, expectedResponseLength: 7 };
      const r = await scheduler.run(`TEST 0x40 ${hexId(txId)}`, Priority.INTERACTIVE, s => execUds(client, spec, s), signal);
      const valid = r.semantic === 'POSITIVE_RESPONSE' || r.semantic === 'NEGATIVE_RESPONSE' || r.presence === 'PRESENT';
      const dbg: UdsDebug = {
        txId, rxId, requestHex: '22 F1 00', framesHex: r.frames.map(f => toHex(f.frame.raw)).join(' | ') || null,
        semantic: r.semantic, transport: r.transport, present: r.presence === 'PRESENT', udsBody: r.final ? toHex(r.final.udsBody) || null : null,
        result: valid ? 'VALID_RESPONSE' : 'TIMEOUT',
      };
      // If 0x33 said NO_B3 for the same pair but 0x40 answered, the CAN/ECU path works — only 0x33 is broken.
      const probe = scanDebugStore.get().probe;
      let note: string | null = null;
      if (valid && probe && probe.txId === txId && probe.rxId === rxId && probe.result === 'NO_B3') {
        note = `SCAN_0X33_TRANSPORT_FAILURE — ${hexId(txId)}→${hexId(rxId)}: 0x40 a răspuns (${r.semantic}) dar 0x33 nu a primit niciun cadru B3. CAN/ECU funcționează; doar calea 0x33 e defectă.`;
        log('SCAN', note, { uds: dbg.udsBody, transport: dbg.transport }, 'error');
      }
      scanDebugStore.set(s => ({ ...s, uds: dbg, note, running: false }));
      return dbg;
    } catch (error) {
      scanDebugStore.set(s => ({ ...s, running: false }));
      throw error;
    }
  });

// ---------- passive capture ----------

/** START CAPTURE: silence every MemoStats source first, then listen; the link refuses all writes. */
export function startPassiveCapture(): void {
  // Stop every source first (live polling, scan, queued work); from here the scheduler and the link refuse TX.
  stopLive('captură pasivă');
  scanAbort?.abort();
  scheduler.cancelAll('Captură pasivă');
  const { dongle } = getState();
  startCapture(transport, { app: `MemoStats V2 ${__APP_VERSION__}`, device: dongle.name ?? null, firmware: dongle.firmware ?? null });
}

export const stopPassiveCapture = stopCapture;

// ---------- developer tests ----------

function failIfRunning<T>(test: TestState<T>): TestState<T> {
  return test.status === 'running' ? { ...test, status: 'error', error: 'Conexiunea BLE s-a închis în timpul testului' } : test;
}

type TestKey = 'med40' | 'replica' | 'manual';

async function runTest<K extends TestKey>(key: K, label: string, task: (signal: AbortSignal) => Promise<NonNullable<AppState[K]['result']>>): Promise<void> {
  const state = getState();
  if (state.connection !== 'connected' || state[key].status === 'running' || refusedByCapture(label)) return;
  setState(s => ({ ...s, [key]: { status: 'running' } }));
  try {
    const result = await scheduler.run(label, Priority.INTERACTIVE, task);
    setState(s => ({ ...s, [key]: { status: 'done', result, finishedAt: Date.now() } }));
  } catch (error) {
    log('UDS', `${label} failed`, { error: message(error) }, 'error');
    setState(s => ({ ...s, [key]: { status: 'error', error: message(error), finishedAt: Date.now() } }));
  }
}

export const runMed40Test = (): Promise<void> =>
  runTest('med40', 'MED40 22 F1 00', signal => runMed40IdentificationTest(client, signal));

/** Replays the official MBito SCCM166 F100 request captured on this car, field for field. */
export const runOfficialReplicaTest = (): Promise<void> =>
  runTest('replica', 'SCCM166 22 F1 00 (official replica)', signal => runReplica(client, signal));

/** Read-only manual request; the vehicle layer rejects every non-read service. */
export const runManualRequest = (input: ManualRequestInput): Promise<void> =>
  runTest('manual', 'MANUAL', signal => runManual(client, input, signal));

/** Protocol state for the developer panel. */
export const schedulerState = (): { busy: boolean; queued: number } => ({ busy: scheduler.busy, queued: scheduler.queued });

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
