import type { MbitoClient } from '../../core/mbito/mbitoClient';
import { CancelledError, type DiagnosticScheduler, Priority } from '../../core/scheduler/diagnosticScheduler';
import { log } from '../../logs/logStore';
import { createStore } from '../../state/createStore';
import type { VehicleModule } from '../../vehicle/modules';
import { type DtcDescription, lookupDescriptions } from './dtcDescriptions';
import { type ModuleDtcResult, readModuleDtcs } from './dtcRead';

export interface DtcScanState {
  status: 'idle' | 'running' | 'done' | 'cancelled';
  current: string | null;
  done: number;
  total: number;
  /** current run only — a new run starts empty, nothing persisted is ever shown as current */
  results: ModuleDtcResult[];
  descriptions: Record<string, DtcDescription>;
  descriptionError: string | null;
  finishedAt: number | null;
}

export const dtcStore = createStore<DtcScanState>({ status: 'idle', current: null, done: 0, total: 0, results: [], descriptions: {}, descriptionError: null, finishedAt: null });

/** Modules with at least one correctly parsed DTC — transport problems never count as faults. */
export function modulesWithFaults(state: DtcScanState): ModuleDtcResult[] {
  return state.results.filter(r => r.status === 'OK' && r.records.length > 0);
}

export async function runDtcScan(client: MbitoClient, scheduler: DiagnosticScheduler, modules: readonly VehicleModule[], signal: AbortSignal): Promise<void> {
  dtcStore.set(() => ({ status: 'running', current: null, done: 0, total: modules.length, results: [], descriptions: {}, descriptionError: null, finishedAt: null }));
  log('DTC', `DTC read started on ${modules.length} responding modules`);
  try {
    for (const module of modules) {
      signal.throwIfAborted();
      dtcStore.set(s => ({ ...s, current: module.name }));
      const result = await scheduler.run(`DTC ${module.name}`, Priority.INTERACTIVE, s => readModuleDtcs(client, module, s), signal);
      dtcStore.set(s => ({ ...s, done: s.done + 1, results: [...s.results, result] }));
    }
  } catch (error) {
    dtcStore.set(s => ({ ...s, status: 'cancelled', current: null, finishedAt: Date.now() }));
    if (!(error instanceof CancelledError) && !signal.aborted) throw error;
    return;
  }
  dtcStore.set(s => ({ ...s, status: 'done', current: null, finishedAt: Date.now() }));
  const codes = [...new Set(dtcStore.get().results.flatMap(r => r.records.map(d => d.code)))];
  log('DTC', `DTC read done: ${codes.length} codes`, { codes: codes.join(' ') || null });
  try {
    const descriptions = await lookupDescriptions(codes);
    dtcStore.set(s => ({ ...s, descriptions }));
  } catch (error) {
    dtcStore.set(s => ({ ...s, descriptionError: (error as Error).message }));
  }
}
