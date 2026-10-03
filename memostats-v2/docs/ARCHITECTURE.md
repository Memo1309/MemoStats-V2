# Architecture

## Layers

```
ui/            5 screens (DATE LIVE · PERFORMANȚĂ · DIAGNOZĂ · CAPTURĂ · SETĂRI) + DeveloperPanel inside SETĂRI
state/         appState, settings, createStore, actions (the only API the UI calls)
telemetry/     liveTelemetry — V1 live polling loop, freshness, speed feed
performance/   zeroToHundred (pure engine) + performanceStore (history, watchdog)
diagnostics/   ecuScan — V1 0x33 probe over 70 candidates + F100/F18C/F111/F121 · moduleCache (session)
capture/       passive BLE capture: capture (parser, filters, JSON/TXT/CSV) · captureStore (recorder) · captureDb (IndexedDB)
vehicle/       v1Preflight (V1 connect sequence), modules (23 ECUs), manualRequest (read-only whitelist),
               identification (F100 op code, SCCM166 replica, MED40 test)
data/w176/     raw MBito exports (verbatim) · evidence.json · generated ECU catalogue
core/obd       PID table (V1), readMode01 (V1 exact spec)
core/scheduler DiagnosticScheduler — one operation in flight, priority queue, cancel
core/uds       execUds codec · udsSemantics · udsChannel (strict request_nr + TX/RX correlation)
core/mbito     constants · frame · mbitoClient (exchange, GET_CAN_BAUD) · scanProbe (0x33)
core/ble       MbitoBleTransport — GATT only; raw RX/TX tap + write block for passive capture
w176/          immutable DB loader (fetch + deepFreeze) · types · catalog adapter · useW176Db
coding/        bits · codingModel · featureStatus · security (empty provider) · codingEngine · backupStore · multiFeature · targets
logs/          logStore (structured log) · transactions (every request/response, human + raw)
```

Dependencies point downward only. `ui/` never imports from `core/` except pure formatters of values it was
handed (hex, ids). Nothing in `ui/` can build a frame.

## One UDS request, end to end

1. UI → `runMed40Test()` (`state/actions.ts`).
2. Action queues the job on `DiagnosticScheduler` (priority `INTERACTIVE`).
3. Job → `runMed40IdentificationTest()` → `execUds(client, spec)`.
4. `execUds` allocates `request_nr`, encodes the 21-byte header + body, calls `client.exchange()` for `EXEC_UDS`.
5. `MbitoClient` wraps it in the outer frame (`40 79 len`), writes via the transport, and routes reassembled
   response frames of the same command to the exchange's `onFrame`.
6. `onFrame` ignores other ECU addresses, waits through header-only frames and `7F xx 78`, and decides on the
   first final answer. Browser deadline = dongle timeout + 1.5 s (extended by P2* after `78`).
7. Result carries `transport` (raw wire status) and `semantic` (ISO meaning) separately, plus `presence`,
   latency, raw TX/RX and warnings. The state store gets it; the UI renders it.

## Invariants

- One diagnostic operation in flight (scheduler) — the client throws if bypassed.
- A reply for another address never completes a request.
- `0xFE` / `0xFF` are transport facts; presence comes from the UDS body only.
- A disconnect cancels the scheduler, fails the pending exchange, and marks values stale. Nothing pretends to be live.
- After an abandoned request, the link is held for that request's timeout so its late reply cannot be taken for the next one.
- Write-capable MBito commands are not representable in `MbitoCmd`.

## State

`state/appState.ts` is a tiny external store read with `useSyncExternalStore`. Protocol state (pending
exchange, reassembly buffer, queue) lives in the core objects, never in React components.

## Testing

`vitest` unit tests next to the code (`*.test.ts`). Fixtures are real captured frames wherever they exist;
synthetic ones say so. `FakeTransport` in `udsChannel.test.ts` stands in for the dongle.

## Where later phases go

| Phase | Lands in |
|---|---|
| 3 fast scan | `data/w176/` (validated catalog), `vehicle/discovery`, `vehicle/inventory` |
| 4 live telemetry | `core/obd`, `telemetry/obd`, scheduler `TELEMETRY` priority |
| 6 DTC | `diagnostics/dtc` with `DtcStrategy` |
| 8 performance | `performance/`, scheduler `PERFORMANCE` priority |
| 12 stroboscope | `vehicleActions/stroboscope` — research only |
