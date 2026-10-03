import { describe, expect, it } from 'vitest';
import { LIVE_LOST, ZeroToHundred } from './zeroToHundred';

/** speeds sampled every `step` ms starting at t=0 */
function feed(engine: ZeroToHundred, speeds: number[], step = 500, from = 0): number {
  speeds.forEach((speedKmh, i) => engine.ingest({ at: from + i * step, speedKmh, rpm: 2000 + speedKmh * 10, throttlePct: 80 }));
  return from + speeds.length * step;
}

describe('0–100 km/h', () => {
  it('times from the interpolated 2 km/h crossing to the interpolated 100 km/h crossing', () => {
    const engine = new ZeroToHundred();
    engine.ingest({ at: 0, speedKmh: 0, rpm: 800, throttlePct: 0 });
    engine.arm();
    // 0 at t=500, then +10 km/h per 500 ms: 2 km/h at t=600, 100 km/h at t=5500
    feed(engine, [0, 10, 20, 30, 40, 50, 60, 70, 80, 90, 100, 110], 500, 500);
    const snap = engine.snapshot();
    expect(snap.state).toBe('COMPLETE');
    expect(snap.resultMs).toBeCloseTo(5500 - 600, 6);
    expect(snap.maxSpeedKmh).toBe(100);
  });

  it('only arms from standstill: a moving car waits', () => {
    const engine = new ZeroToHundred();
    engine.ingest({ at: 0, speedKmh: 30, rpm: null, throttlePct: null });
    engine.arm();
    expect(engine.snapshot().message).toMatch(/OPREȘTE/);
    feed(engine, [40, 60, 80, 100, 110], 500, 500);
    expect(engine.snapshot().state).toBe('ARMED');
  });

  it('a single zero does not end a run', () => {
    const engine = new ZeroToHundred();
    engine.ingest({ at: 0, speedKmh: 0, rpm: null, throttlePct: null });
    engine.arm();
    feed(engine, [0, 20, 0, 40, 60, 80, 100], 500, 500);
    expect(engine.snapshot().state).toBe('COMPLETE');
  });

  it('stopping for 2 s before 100 invalidates the run', () => {
    const engine = new ZeroToHundred();
    engine.ingest({ at: 0, speedKmh: 0, rpm: null, throttlePct: null });
    engine.arm();
    feed(engine, [0, 20, 30, 0, 0, 0, 0, 0, 0], 500, 500);
    expect(engine.snapshot().state).toBe('INVALID');
  });

  it('a gap longer than the stale threshold invalidates with the live-lost message', () => {
    const engine = new ZeroToHundred();
    engine.ingest({ at: 0, speedKmh: 0, rpm: null, throttlePct: null });
    engine.arm();
    const t = feed(engine, [0, 20, 40], 500, 500);
    engine.ingest({ at: t + 6000, speedKmh: 60, rpm: null, throttlePct: null });
    expect(engine.snapshot()).toMatchObject({ state: 'INVALID', message: LIVE_LOST });
  });

  it('checkStale invalidates when samples simply stop arriving', () => {
    const engine = new ZeroToHundred();
    engine.ingest({ at: 0, speedKmh: 0, rpm: null, throttlePct: null });
    engine.arm();
    engine.checkStale(1000);
    expect(engine.snapshot().state).toBe('ARMED');
    engine.checkStale(4000);
    expect(engine.snapshot().state).toBe('INVALID');
  });

  it('reports samples, frequency and the largest gap of the run', () => {
    const engine = new ZeroToHundred();
    engine.ingest({ at: 0, speedKmh: 0, rpm: null, throttlePct: null });
    engine.arm();
    engine.ingest({ at: 1000, speedKmh: 0, rpm: 800, throttlePct: 5 });
    engine.ingest({ at: 2000, speedKmh: 30, rpm: 3000, throttlePct: 90 });
    engine.ingest({ at: 3200, speedKmh: 70, rpm: 4500, throttlePct: 100 });
    engine.ingest({ at: 4000, speedKmh: 105, rpm: 5200, throttlePct: 100 });
    const snap = engine.snapshot();
    expect(snap).toMatchObject({ state: 'COMPLETE', samples: 4, maxGapMs: 1200, maxRpm: 5200, maxThrottlePct: 100 });
    expect(snap.hz).toBeCloseTo(1, 6);
  });
});
