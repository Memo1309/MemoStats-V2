# Performance — 0–100 km/h

Code: `src/performance/zeroToHundred.ts` (pure, tested) + `performanceStore.ts` · rules from V1 `performanceEngine.ts`.

| State | Meaning |
|---|---|
| READY | idle |
| ARMED | waiting for a fresh standstill sample (≤ 2 km/h), then launch |
| RUNNING | started at the interpolated 2 km/h crossing |
| COMPLETE | finished at the interpolated 100 km/h crossing (never the nearest sample) |
| INVALID | live data stopped / sample gap > clamp(4 × avg gap, 2.5 s, 5 s) / stopped ≥ 2 s before 100 / invalid sample |

A single zero or one stale sample never ends a run. Live data switches to FAST PIDs while ARMED/RUNNING.
Stats: result, max speed, max rpm, max throttle, samples, frequency, largest gap. Completed runs are saved
locally (`memostats.v2.perf-history.v1`, last 50) with a BEST mark.

Accuracy is bounded by the sample rate (V1 streamed speed at ~0.9–1.2 Hz); the frequency and largest-gap
stats are shown next to every result for that reason.

Not ported from V1: 80–120, 100–200, 0–max, distance runs (60 ft … ½ mile).
