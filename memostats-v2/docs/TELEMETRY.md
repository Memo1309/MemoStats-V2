# Live telemetry

Code: `src/telemetry/liveTelemetry.ts`, `src/core/obd/` · spec: MemoStats V1 `liveStream.ts` (docs/PROTOCOL.md §13).

## Path

Engine ECU 0x7E0 → 0x7E8, `01 <pid>`, timeout 200 ms / delay_after 200 ms, exp_len = data bytes + 2,
`request_nr` rolling and strictly correlated. One request in flight (DiagnosticScheduler, TELEMETRY priority).

## Polling (V1)

| Tier | PIDs | Frequency |
|---|---|---|
| FAST | 0D speed, 0C rpm, 11 throttle | every cycle |
| MEDIUM | 0B MAP (+ supported extras: 04, 0E, 10, 43, 49–4B, 5A, 61–64) | one per 2nd cycle, round-robin |
| SLOW | 05 coolant, 0F intake (+ all other supported extras) | one per 5th cycle, round-robin |
| — | adapter voltage (GET_VOLTAGE, no CAN) | every 15th cycle |

Cycle period 300 ms (SETĂRI: 300 / 500 / 1000). During an armed/running 0–100: FAST only.
Extras are polled only when the ECU's supported-PID bitmap (V1 preflight `01 00`, `01 20` …) lists them; if
discovery found nothing, V1's core six are polled anyway (V1 behaviour).

## Freshness

Every value stores `performance.now()`. Stale after `clamp(4 × avg speed interval, 2.5 s, 5 s)`. Stale values
are dimmed while streaming and hidden once live data stops. Unsupported PIDs show NESUPORTAT, missing ones
INDISPONIBIL — never 0.

## Boost

`MAP − BARO` (PID 0B − PID 33), both fresh, BARO 70–110 kPa; signed (vacuum negative), shown in bar.
No assumed 100 kPa. Without PID 33: "FĂRĂ BARO".

## V1 reference numbers

V1 speed stream: 45/46 samples, ~1085–1091 ms average interval (~0.92 Hz), max gap 1650 ms.
