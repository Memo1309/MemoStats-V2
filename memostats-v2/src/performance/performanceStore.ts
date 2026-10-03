import { log } from '../logs/logStore';
import { createStore, loadJson, saveJson } from '../state/createStore';
import { liveStore, onSpeedSample, setPerformanceMode } from '../telemetry/liveTelemetry';
import { LIVE_LOST, type PerfSnapshot, ZeroToHundred } from './zeroToHundred';

export interface SavedRun {
  id: string;
  date: number;
  resultMs: number;
  maxSpeedKmh: number | null;
  maxRpm: number | null;
  maxThrottlePct: number | null;
  samples: number;
  hz: number | null;
  maxGapMs: number | null;
}

const HISTORY_KEY = 'memostats.v2.perf-history.v1';
const isHistory = (v: unknown): v is SavedRun[] =>
  Array.isArray(v) && v.every(r => typeof r === 'object' && r !== null && typeof (r as SavedRun).resultMs === 'number' && typeof (r as SavedRun).date === 'number');

const engine = new ZeroToHundred();
export const perfStore = createStore<{ snap: PerfSnapshot; history: SavedRun[] }>({
  snap: engine.snapshot(),
  history: loadJson(HISTORY_KEY, [], isHistory),
});

let watchdog: ReturnType<typeof setInterval> | undefined;

function publish(): void {
  const snap = engine.snapshot();
  const previous = perfStore.get().snap.state;
  let history = perfStore.get().history;
  if (snap.state === 'COMPLETE' && previous !== 'COMPLETE' && snap.resultMs !== null) {
    const run: SavedRun = { id: String(Date.now()), date: Date.now(), resultMs: snap.resultMs, maxSpeedKmh: snap.maxSpeedKmh, maxRpm: snap.maxRpm,
      maxThrottlePct: snap.maxThrottlePct, samples: snap.samples, hz: snap.hz, maxGapMs: snap.maxGapMs };
    history = [run, ...history].slice(0, 50);
    saveJson(HISTORY_KEY, history);
    log('PERF', `0–100 complete: ${(snap.resultMs / 1000).toFixed(2)} s`, { samples: snap.samples, hz: snap.hz, max_gap_ms: snap.maxGapMs });
  }
  if (snap.state === 'INVALID' && previous !== 'INVALID') log('PERF', snap.message, undefined, 'warn');
  const running = snap.state === 'ARMED' || snap.state === 'RUNNING';
  setPerformanceMode(running); // V1: FAST PIDs only while a test is armed or running
  if (running && !watchdog) watchdog = setInterval(() => { engine.checkStale(performance.now()); publish(); }, 500);
  if (!running && watchdog) { clearInterval(watchdog); watchdog = undefined; }
  perfStore.set(() => ({ snap, history }));
}

onSpeedSample(sample => { engine.ingest(sample); publish(); });
liveStore.subscribe(() => {
  if (!liveStore.get().active) { engine.invalidate(LIVE_LOST); publish(); }
});

export const armPerformance = (): void => { engine.arm(); publish(); };
export const resetPerformance = (): void => { engine.reset(); publish(); };
export const clearPerformanceHistory = (): void => { saveJson(HISTORY_KEY, []); perfStore.set(s => ({ ...s, history: [] })); };
