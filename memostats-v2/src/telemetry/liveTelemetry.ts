import type { MbitoClient } from '../core/mbito/mbitoClient';
import { V1_LIVE_TIMING, readMode01 } from '../core/obd/obdRead';
import { LIVE_PIDS, PIDS, PID_TIER } from '../core/obd/pids';
import { CancelledError, type DiagnosticScheduler, Priority } from '../core/scheduler/diagnosticScheduler';
import { log } from '../logs/logStore';
import { createStore } from '../state/createStore';

// Port of MemoStats V1 liveStream.ts, the loop that produced V1's real live data:
// FAST PIDs every cycle, one MEDIUM every 2nd cycle, one SLOW every 5th (round-robin), FAST only in
// performance mode, cycle period 300 ms by default, each read 01 <pid> at timeout 200 / delay_after 200.

export interface Sample {
  value: number;
  /** performance.now() */
  at: number;
}

export interface LiveState {
  active: boolean;
  performanceMode: boolean;
  values: Partial<Record<number, Sample>>;
  /** PIDs the ECU reported as unsupported (supported-PID bitmap) — never polled, never shown as 0 */
  unsupported: number[];
  adapterVoltage: Sample | null;
  consecutiveFailures: number;
  lastError: string | null;
  speed: { requests: number; samples: number; avgIntervalMs: number | null; maxGapMs: number; lastAt: number | null };
}

const initial: LiveState = {
  active: false, performanceMode: false, values: {}, unsupported: [], adapterVoltage: null,
  consecutiveFailures: 0, lastError: null, speed: { requests: 0, samples: 0, avgIntervalMs: null, maxGapMs: 0, lastAt: null },
};

export const liveStore = createStore<LiveState>(initial);

export interface SpeedSample { at: number; speedKmh: number; rpm: number | null; throttlePct: number | null }
const speedListeners = new Set<(s: SpeedSample) => void>();
export function onSpeedSample(listener: (s: SpeedSample) => void): () => void {
  speedListeners.add(listener);
  return () => speedListeners.delete(listener);
}

/** Stale after max(2.5 s, 4 × average speed interval) — V1 PERFORMANCE_STALE rule. */
export function staleAfterMs(state: LiveState): number {
  return Math.min(5000, Math.max(2500, (state.speed.avgIntervalMs ?? 0) * 4));
}

export function freshValue(state: LiveState, pid: number, now = performance.now()): number | null {
  const sample = state.values[pid];
  return state.active && sample && now - sample.at <= staleAfterMs(state) ? sample.value : null;
}

const CORE = Object.values(LIVE_PIDS);
const VOLTAGE_EVERY = 15; // cycles; the dongle reads its own supply, no CAN traffic
let generation = 0;
const intervals: number[] = [];

export interface LiveDeps { client: MbitoClient; scheduler: DiagnosticScheduler; pollPeriodMs: () => number }

export function startLive(deps: LiveDeps, supportedPids: number[]): void {
  if (liveStore.get().active) return;
  const run = ++generation;
  // Discovery found nothing → V1 polls its core set anyway; otherwise skip what the ECU says it lacks.
  const unsupported = supportedPids.length ? CORE.filter(pid => !supportedPids.includes(pid)) : [];
  // V1: plus every extra PID the ECU reports as supported that the table can decode (MAI MULTE DATE).
  const extras = supportedPids.filter(pid => PIDS[pid] && !CORE.includes(pid as (typeof CORE)[number]));
  const pids = [...CORE.filter(pid => !unsupported.includes(pid)), ...extras];
  intervals.length = 0;
  liveStore.set(() => ({ ...initial, active: true, unsupported }));
  log('LIVE', 'Live data started', { pids: pids.map(p => p.toString(16)).join(' '), unsupported: unsupported.map(p => p.toString(16)).join(' ') || null });
  void loop(deps, pids, run);
}

export function stopLive(reason: string): void {
  if (!liveStore.get().active) return;
  generation++;
  liveStore.set(s => ({ ...s, active: false }));
  log('LIVE', `Live data stopped: ${reason}`);
}

export function setPerformanceMode(on: boolean): void {
  if (liveStore.get().performanceMode !== on) liveStore.set(s => ({ ...s, performanceMode: on }));
}

async function loop(deps: LiveDeps, pids: number[], run: number): Promise<void> {
  const byTier = (tier: string) => pids.filter(pid => (PID_TIER[pid] ?? 'SLOW') === tier);
  const fast = byTier('FAST');
  const medium = byTier('MEDIUM');
  const slow = byTier('SLOW');
  let cycle = 0;
  const alive = () => generation === run;

  while (alive()) {
    const cycleStart = performance.now();
    const perf = liveStore.get().performanceMode;
    const active = [...fast];
    if (!perf) {
      if (medium.length && cycle % 2 === 0) active.push(medium[(cycle / 2) % medium.length] as number);
      if (slow.length && cycle % 5 === 0) active.push(slow[(cycle / 5) % slow.length] as number);
    }
    try {
      for (const pid of active) {
        if (!alive()) return;
        await readOne(deps, pid);
      }
      if (!perf && cycle % VOLTAGE_EVERY === 0 && alive()) {
        const volts = await deps.scheduler.run('LIVE GET_VOLTAGE', Priority.TELEMETRY, s => deps.client.getVoltage(s));
        liveStore.set(s => ({ ...s, adapterVoltage: { value: volts, at: performance.now() } }));
      }
    } catch (error) {
      if (error instanceof CancelledError) {
        if (alive()) stopLive(error.message);
        return;
      }
      liveStore.set(s => ({ ...s, lastError: (error as Error).message }));
    }
    cycle++;
    const wait = deps.pollPeriodMs() - (performance.now() - cycleStart);
    if (wait > 0) await new Promise(resolve => setTimeout(resolve, wait));
  }
}

async function readOne(deps: LiveDeps, pid: number): Promise<void> {
  const { value, exchange } = await deps.scheduler.run(`LIVE 01 ${pid.toString(16).toUpperCase().padStart(2, '0')}`, Priority.TELEMETRY,
    s => readMode01(deps.client, pid, V1_LIVE_TIMING, s));
  const now = performance.now();
  liveStore.set(s => {
    const speed = { ...s.speed, requests: s.speed.requests + (pid === LIVE_PIDS.SPEED ? 1 : 0) };
    if (value === null) {
      return { ...s, speed, consecutiveFailures: s.consecutiveFailures + 1, lastError: `01 ${pid.toString(16).toUpperCase().padStart(2, '0')}: ${exchange.transport} / ${exchange.semantic}` };
    }
    if (pid === LIVE_PIDS.SPEED) {
      if (speed.lastAt !== null) {
        intervals.push(now - speed.lastAt);
        if (intervals.length > 80) intervals.shift();
        speed.maxGapMs = Math.max(speed.maxGapMs, now - speed.lastAt);
        speed.avgIntervalMs = intervals.reduce((sum, v) => sum + v, 0) / intervals.length;
      }
      speed.lastAt = now;
      speed.samples += 1;
    }
    return { ...s, speed, values: { ...s.values, [pid]: { value, at: now } }, consecutiveFailures: 0, lastError: null };
  });
  if (pid === LIVE_PIDS.SPEED && value !== null) {
    const state = liveStore.get();
    const sample = { at: now, speedKmh: value, rpm: freshValue(state, LIVE_PIDS.RPM, now), throttlePct: freshValue(state, LIVE_PIDS.THROTTLE, now) };
    for (const listener of speedListeners) listener(sample);
  }
}
