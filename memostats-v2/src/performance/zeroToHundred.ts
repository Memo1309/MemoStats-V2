// 0–100 km/h timing, following MemoStats V1 performanceEngine rules:
// - arm only from standstill (≤ 2 km/h, fresh sample); start = interpolated crossing of 2 km/h
// - finish = interpolated crossing of 100 km/h (never the nearest sample)
// - invalidate when a sample gap exceeds clamp(4 × average interval, 2.5 s, 5 s), or live data stops
// - a single zero or a stale sample never finishes a run; stopping for 2 s before 100 invalidates it

export type PerfState = 'READY' | 'ARMED' | 'RUNNING' | 'COMPLETE' | 'INVALID';

export interface PerfSample { at: number; speedKmh: number; rpm: number | null; throttlePct: number | null }

export interface PerfSnapshot {
  state: PerfState;
  message: string;
  currentSpeedKmh: number | null;
  elapsedMs: number | null;
  resultMs: number | null;
  maxSpeedKmh: number | null;
  maxRpm: number | null;
  maxThrottlePct: number | null;
  samples: number;
  hz: number | null;
  maxGapMs: number | null;
}

export const TARGET_KMH = 100;
export const STOP_KMH = 2;
const STOP_HOLD_MS = 2000;
const STALE_MIN_MS = 2500;
const STALE_MAX_MS = 5000;
export const LIVE_LOST = 'TEST ÎNTRERUPT: DATELE LIVE NU MAI SUNT DISPONIBILE.';

function crossing(a: PerfSample, b: PerfSample, kmh: number): number | null {
  if (!(a.speedKmh < kmh && b.speedKmh >= kmh)) return null;
  return a.at + ((kmh - a.speedKmh) / (b.speedKmh - a.speedKmh)) * (b.at - a.at);
}

export class ZeroToHundred {
  private state: PerfState = 'READY';
  private message = 'Pornește datele live, apoi ARMEAZĂ.';
  private last: PerfSample | null = null;
  private run: PerfSample[] = [];
  private standstillSeen = false;
  private startAt: number | null = null;
  private resultMs: number | null = null;
  private stopSince: number | null = null;
  private gaps: number[] = [];

  arm(): void {
    if (this.state === 'ARMED' || this.state === 'RUNNING') return;
    this.clear();
    this.state = 'ARMED';
    this.standstillSeen = this.last !== null && this.last.speedKmh <= STOP_KMH;
    this.message = this.standstillSeen ? 'GATA — accelerează.' : 'OPREȘTE VEHICULUL pentru a începe.';
  }

  reset(): void {
    this.clear();
    this.state = 'READY';
    this.message = 'Pregătit.';
  }

  invalidate(message: string): void {
    if (this.state !== 'ARMED' && this.state !== 'RUNNING') return;
    this.state = 'INVALID';
    this.message = message;
  }

  /** Called periodically: no fresh speed sample for too long invalidates an armed or running test. */
  checkStale(now: number): void {
    if (this.last && now - this.last.at > this.staleMs()) this.invalidate(LIVE_LOST);
  }

  ingest(sample: PerfSample): void {
    if (!Number.isFinite(sample.speedKmh) || sample.speedKmh < 0 || sample.speedKmh > 400 || (this.last && sample.at <= this.last.at)) {
      this.invalidate('Test invalid: eșantion de viteză nevalid.');
      return;
    }
    const previous = this.last;
    if (previous && (this.state === 'ARMED' || this.state === 'RUNNING')) {
      const gap = sample.at - previous.at;
      if (gap > this.staleMs()) {
        this.last = sample;
        this.invalidate(LIVE_LOST);
        return;
      }
      this.gaps.push(gap);
      if (this.gaps.length > 8) this.gaps.shift();
    }
    this.last = sample;

    if (this.state === 'ARMED') {
      if (sample.speedKmh <= STOP_KMH) {
        this.standstillSeen = true;
        this.message = 'GATA — accelerează.';
      } else if (this.standstillSeen && previous && previous.speedKmh <= STOP_KMH) {
        this.startAt = crossing(previous, sample, STOP_KMH) ?? sample.at;
        this.state = 'RUNNING';
        this.message = 'În desfășurare…';
        this.run = [previous, sample];
      }
      return;
    }

    if (this.state === 'RUNNING' && previous && this.startAt !== null) {
      this.run.push(sample);
      const finish = crossing(previous, sample, TARGET_KMH);
      if (finish !== null) {
        this.resultMs = finish - this.startAt;
        this.state = 'COMPLETE';
        this.message = 'Finalizat.';
        return;
      }
      if (sample.speedKmh <= STOP_KMH) {
        this.stopSince ??= sample.at;
        if (sample.at - this.stopSince >= STOP_HOLD_MS) this.invalidate('Test anulat: vehiculul s-a oprit înainte de 100 km/h.');
      } else {
        this.stopSince = null;
      }
    }
  }

  snapshot(now = performance.now()): PerfSnapshot {
    const run = this.run;
    const span = run.length > 1 ? (run.at(-1) as PerfSample).at - (run[0] as PerfSample).at : 0;
    const gaps = run.slice(1).map((s, i) => s.at - (run[i] as PerfSample).at);
    const max = (pick: (s: PerfSample) => number | null) => {
      const values = run.map(pick).filter((v): v is number => v !== null);
      return values.length ? Math.max(...values) : null;
    };
    return {
      state: this.state,
      message: this.message,
      currentSpeedKmh: this.last?.speedKmh ?? null,
      elapsedMs: this.state === 'RUNNING' && this.startAt !== null ? now - this.startAt : this.resultMs,
      resultMs: this.resultMs,
      maxSpeedKmh: max(s => s.speedKmh),
      maxRpm: max(s => s.rpm),
      maxThrottlePct: max(s => s.throttlePct),
      samples: run.length,
      hz: span > 0 ? ((run.length - 1) * 1000) / span : null,
      maxGapMs: gaps.length ? Math.max(...gaps) : null,
    };
  }

  private staleMs(): number {
    const avg = this.gaps.length ? this.gaps.reduce((a, b) => a + b, 0) / this.gaps.length : 0;
    return Math.min(STALE_MAX_MS, Math.max(STALE_MIN_MS, avg * 4));
  }

  private clear(): void {
    this.run = [];
    this.startAt = null;
    this.resultMs = null;
    this.stopSince = null;
    this.gaps = [];
  }
}
