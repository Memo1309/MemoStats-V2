import { hexId } from '../core/bytes';
import { log } from '../logs/logStore';
import { transactionStore } from '../logs/transactions';
import { createStore } from '../state/createStore';
import type { VehicleModule } from '../vehicle/modules';
import type { ModuleResult, ModuleStatus, SessionReply } from './ecuScan';

// Discovery result of the current connected session. In memory only (no cross-session storage).
// Filled by a completed scan; cleared only by: MBito disconnect, vehicle change (VIN), explicit rescan.
// A confirmed module stays confirmed for the whole session — later timeouts are counted, never un-confirm it.

/** CONFIRMED = answered · NO_RESPONSE = probe completed, nothing answered this scan (not "absent") ·
 * COMM_ERROR = no B3 / BLE failure, nothing learned about the ECU. */
export type DiscoveryState = 'CONFIRMED' | 'NO_RESPONSE' | 'COMM_ERROR';

export function discoveryState(status: ModuleStatus): DiscoveryState {
  if (status === 'RESPONDS') return 'CONFIRMED';
  return status === 'HOST_TIMEOUT' || status === 'ERROR' ? 'COMM_ERROR' : 'NO_RESPONSE';
}

export interface CachedModule {
  module: VehicleModule;
  /** 0x33 `50 03`, or a positive 0x40 answer on the module's CAN pair (e.g. MED40 live data on 0x7E0→0x7E8) */
  confirmedBy: '0x33' | '0x40';
  /** what the ECU did with the 0x33 `10 03` (ACCEPTED / REJECTED / OTHER); null when confirmed via 0x40 */
  session: SessionReply | null;
  /** unanswered requests since the last answer — shown as detail, never un-confirms */
  consecutiveFailures: number;
  /** identification from the scan */
  probeResponse: string | null;
  f100: string | null;
  opCode: string | null;
  variantMatches: boolean | null;
  /** F18C / F111 / F121 as read after the probe */
  ids: ModuleResult['ids'];
  /** epoch ms of the last answered request (scan or later) */
  lastAnsweredAt: number;
}

export interface UnconfirmedModule {
  module: VehicleModule;
  state: Exclude<DiscoveryState, 'CONFIRMED'>;
  /** final probe status after both passes */
  status: ModuleStatus;
  probeResponse: string | null;
  error: string | null;
}

export interface ModuleCacheState {
  valid: boolean;
  scannedAt: number | null;
  /** candidates probed by the scan that built this cache */
  scanned: number;
  vin: string | null;
  /** confirmed modules only — the list DTC reads and Diagnoză use */
  modules: CachedModule[];
  /** every other candidate with its state, so a later 0x40 answer can still confirm it */
  unconfirmed: UnconfirmedModule[];
}

const EMPTY: ModuleCacheState = { valid: false, scannedAt: null, scanned: 0, vin: null, modules: [], unconfirmed: [] };
export const moduleCache = createStore<ModuleCacheState>(EMPTY);

export function cacheScanResults(results: readonly ModuleResult[], scanned: number, now = Date.now()): void {
  const modules: CachedModule[] = [];
  const unconfirmed: UnconfirmedModule[] = [];
  for (const r of results) {
    const state = discoveryState(r.status);
    if (state === 'CONFIRMED') {
      modules.push({ module: r.module, confirmedBy: '0x33', session: r.session, consecutiveFailures: 0, probeResponse: r.probeResponse, f100: r.f100, opCode: r.opCode, variantMatches: r.variantMatches, ids: r.ids, lastAnsweredAt: now });
    } else {
      unconfirmed.push({ module: r.module, state, status: r.status, probeResponse: r.probeResponse, error: r.error });
    }
  }
  moduleCache.set(s => ({ valid: true, scannedAt: now, scanned, vin: s.vin, modules, unconfirmed }));
  log('SCAN', `Module cache: ${modules.length} confirmed of ${scanned} scanned`, {
    no_response: unconfirmed.filter(u => u.state === 'NO_RESPONSE').length, comm_error: unconfirmed.filter(u => u.state === 'COMM_ERROR').length,
  });
  // DEBUG: the detected store, so the display pipeline can be traced end-to-end.
  log('SCAN', `DETECTED STORE: ${modules.length} present pairs`, { pairs: modules.map(m => `${hexId(m.module.txId)}→${hexId(m.module.rxId)}`).join(' ') || null });
}

export function invalidateModuleCache(reason: string): void {
  if (!moduleCache.get().valid && moduleCache.get().modules.length === 0) return;
  moduleCache.set(() => EMPTY);
  log('SCAN', `Module cache cleared: ${reason}`);
}

/** A different VIN on the same connection means a different vehicle → the cache no longer applies. */
export function noteVehicleVin(vin: string | null): void {
  if (!vin) return;
  const { vin: known } = moduleCache.get();
  if (known && known !== vin) invalidateModuleCache('vehicle changed (VIN)');
  moduleCache.set(s => ({ ...s, vin }));
}

export function findCachedModule(txId?: number, rxId?: number): CachedModule | undefined {
  return moduleCache.get().modules.find(m => m.module.txId === txId && m.module.rxId === rxId);
}

/** Name for a CAN pair from the session cache (covers retrofit finds), else undefined. */
export function cachedModuleName(txId?: number, rxId?: number): string | undefined {
  return findCachedModule(txId, rxId)?.module.name;
}

// Every diagnostic request updates the session: a confirmed module only counts failures; an unconfirmed
// candidate that gives a positive 0x40 answer becomes confirmed (0x33 silence never means "absent").
let lastSeenId = 0;
transactionStore.subscribe(() => {
  const fresh = transactionStore.getSnapshot().filter(t => t.id > lastSeenId);
  if (!fresh.length) return;
  lastSeenId = fresh.at(-1)?.id ?? lastSeenId;
  const state = moduleCache.get();
  if (!state.valid) return;
  let { modules, unconfirmed } = state;
  for (const t of fresh) {
    if (t.kind === 'DONGLE' || t.answered === undefined) continue;
    const same = (m: VehicleModule) => m.txId === t.txId && m.rxId === t.rxId;
    if (modules.some(m => same(m.module))) {
      modules = modules.map(m => (!same(m.module) ? m : t.answered
        ? { ...m, consecutiveFailures: 0, lastAnsweredAt: t.at }
        : { ...m, consecutiveFailures: m.consecutiveFailures + 1 }));
      continue;
    }
    const candidate = unconfirmed.find(u => same(u.module));
    if (!candidate || !t.ok || t.kind === 'PROBE') continue;
    unconfirmed = unconfirmed.filter(u => u !== candidate);
    modules = [...modules, {
      module: candidate.module, confirmedBy: '0x40', session: null, consecutiveFailures: 0, probeResponse: candidate.probeResponse,
      f100: null, opCode: null, variantMatches: null, ids: {}, lastAnsweredAt: t.at,
    }];
    log('SCAN', `${candidate.module.name} (${hexId(candidate.module.txId)}) confirmed via 0x40 (${t.request} → ${t.response ?? '—'})`);
  }
  if (modules !== state.modules || unconfirmed !== state.unconfirmed) moduleCache.set(s => ({ ...s, modules, unconfirmed }));
});
