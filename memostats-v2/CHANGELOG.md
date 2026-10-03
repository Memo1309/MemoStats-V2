# Changelog

## 0.6.0 — 2026-09-30 — ECU identification + known vs current inventory (real 23-ECU scan)

- Identification parser: F100 op-code = the 3 bytes after `62 F1 00` (trailing byte ignored), normalized
  uppercase; F111/F121 decoded as ASCII hardware/software (raw hex kept when not printable); F18C kept as
  serialRawHex with serialText only when printable. Identification failures (FE+62 positive, FD+7F..78
  pending, FF+7F..31 negative) never downgrade presence.
- Metadata-driven resolver: TX/RX → catalog families, narrowed by op-code to the exact family + variant.
  All 23 real-car ECUs (incl. MED40 0x7E0→0x7E8 op 022857 → variant 14694 VC11_A) resolve from the immutable
  JSON; ambiguous pairs stay PRESENT + probable/unresolved.
- Two separate inventories: currentScanInventory (who replied this scan) and a PERSISTENT knownVehicleInventory
  (identified ECUs with firstSeen/lastSeen/seenCount/missCount). A module that does not reply is kept with its
  identity and marked "not detected in the current scan" — never removed/missing/absent.
- ECU Explorer shows the vehicle's ECUs (known ∪ current), each DETECTAT ACUM or NEDETECTAT ÎN SCANAREA
  CURENTĂ, with variant/op-code/hardware/software/serial/last-seen + coding & DTC counts. The 47 non-vehicle
  candidates are not shown here (they stay in the Scan Protocol Log). Summary wording: present, not missing.
- Second pass unchanged: only non-responders retried, no ECU identified twice, presence sticky.
- MED40 is detectable via 0x33 (no OBD fallback required for this vehicle). Scan transport untouched.

## 0.5.4 — 2026-09-30 — fix: 0x33 scan uses outer ARG 0x02 (root cause of "no B3")

- ROOT CAUSE (proven by a real official-MBito capture): the 0x33 scan probe was sent with outer arg 0x79
  (single-frame). The scan is a script command and the official app sends `33 02 20 00 …`, replying
  `B3 02 20 00 …`. With 0x79 the dongle produced no B3 at all — the "no B3 frame" the vehicle showed.
- Outer arg is now command-specific (MBITO_OUTER_ARG): 0x33 → 0x02; everything else → 0x79. Device-info
  commands are unchanged, and EXEC_UDS 0x40 keeps 0x79 (V1's known-good live-data capture is `40 79 …`; the
  `C0 01` in replies is the SUCCESS response arg, not the request arg). One-line to flip a command's arg later.
- The 32-byte payload structure is unchanged. Presence unchanged: non-zero response slot = present
  (incl. negative 7F 10), all-zero slot = no response, no B3 = communication error.
- Tests: exact IC172 request `33 02 20 00 … 81 04 00 00 00×8` (36 B) byte-for-byte, and the real official B3
  responses (IC172/HERMES/EZS166/CBCBOLERO present, 0x74F absent) decode correctly.

## 0.5.3 — 2026-09-30 — raw 0x33 transport debug tools

- Locked the exact 0x33 frame with a unit test: IC172 0x60A→0x481 builds the exact 36-byte vector
  `33 79 20 00 … 81 04 00 00 00×8` byte-for-byte (the builder was already correct — verified, not changed).
- New developer tools (SETĂRI → DEVELOPER → "Test transport 0x33"): run ONE probe on IC172 / HERMES / EZS166
  via 0x33, and one read-only 22 F1 00 via the working 0x40 path. Shows the request hex, EVERY raw BLE
  notification captured during the probe (before any decode/filter), the decoded B3 frame, B3 yes/no, the
  8-byte response slot and the result (PRESENT / ZERO_SLOT / NO_B3 / PARSE_ERROR). When 0x33 reports NO_B3
  but 0x40 answers, it logs SCAN_0X33_TRANSPORT_FAILURE (CAN/ECU works; only the 0x33 path is broken).
- Lowest-layer logging while a probe runs: SCAN WRITE (full 36-byte hex) and the raw BLE notifications,
  so we can tell whether no notification arrives at all vs a notification arriving and being dropped.
- Confirmed the response waiter is registered BEFORE the BLE write and that a 0xB3 notification maps to the
  pending 0x33 request (dispatcher matches on command 0xB3 % 0x80 = 0x33). Not Passive Capture (stays exclusive).

## 0.5.2 — 2026-09-30 — separate presence from identity + independent Scan Protocol Log

- Detected addresses no longer read "unconfirmed". Presence and identity are now two independent states:
  presenceStatus (present / absent / error / not_scanned) and identityStatus (identified / probable /
  unresolved). Any valid diagnostic response — 50 03, a negative 7F 10, a non-zero 0x33 slot, or 0xFE with
  a UDS body — makes the address PRESENT, even when the exact family/variant is still unresolved. Identity
  failure never downgrades presence; presence stays sticky for the scan session.
- UI: "Module confirmate"/"CONFIRMAT" → "Module prezente"/"PREZENT" plus a separate identity badge
  (IDENTIFICAT / PROBABIL / NEREZOLVAT) in both the Scanare list and the ECU Explorer. The non-responding
  panel is now "Fără răspuns / eroare".
- New independent Scan Protocol Log (developer): records each candidate's raw BLE TX/RX, parsed CAN slot,
  outer status, UDS payload, presence decision and reason, plus every identification request/response and a
  final summary (candidates/present/absent/errors + present pairs). Viewable after the scan, with COPY/EXPORT.
  It does NOT use Passive Capture — capture and scan remain mutually exclusive.
- Identity resolved by normalized TX/RX against the full W176 catalog (119 ecu_definitions): inventory record
  = identified, single family = probable, several families = unresolved (address still shown, possibleEcus listed).

## 0.5.1 — 2026-09-30 — fix: ECU Explorer now renders detected TX/RX pairs

- Root cause: the ECU Explorer gated its whole render on the 2 MB W176 DB fetch, so detected modules
  (already in the scan store, needing no DB) were hidden while the DB loaded or if it failed.
- ECU Explorer now renders every detected TX/RX pair immediately from the scan store, then enriches each
  card from the catalog once the DB is ready. Presence stays sticky and comes only from the scan.
- Detected addresses are matched by TX/RX against the full W176 catalog (119 ecu_definitions), not the
  11-ECU inventory; an ambiguous pair shows all possible families and still renders one address card.
- Canonical CAN-id normalization (`src/w176/canId.ts`): "0x60a" = "0x60A" = 0x60A = 1546, used everywhere.
- Distinct empty states: "no scan yet" vs "scan completed: 0 responded".
- Developer trace logs: DB LOADED, SCAN COMPLETE (present pairs), DETECTED STORE, CATALOG MATCH, UI MODULE COUNT.

## 0.5.0 — 2026-09-30 — W176 metadata engines: ECU Explorer, generic coding, mileage, DTC dictionary

- Immutable W176 DB (public/data/w176/…-2026-09-29.json) is loaded lazily by fetch, deep-frozen and never
  modified. `npm run verify:db` checks its SHA-256 (df85e63…) before every build; a mismatch fails the build.
- DIAGNOZĂ gains sub-tabs (no new bottom-nav): Scanare (unchanged) · ECU Explorer · Coding · Kilometraj.
- Generic, metadata-driven coding: bit engine (global MSB-first, custom_options.overwrites applied atomically),
  per-variant feature model, decode, and an access-level-0 writer with the full safety workflow (read → validate
  length → backup → patch only target bits → before/after diff → confirm → write → read-back → SUCCESS only on a
  matching read-back). Backups persist (IndexedDB, memory fallback) with Restore Original.
- Multi-feature workflows (Blue Welcome Light 452, anti-theft, start-stop) run in exact DB order with per-ECU
  verify and explicit PARTIAL SUCCESS; blocked unless every koding step is access-0.
- Mileage Check (EZS166/IC172/MED40) and a DTC dictionary lookup (definitions ≠ active faults), both DB-driven.
- SecurityAccess is an empty provider registry: every access>0 / sequence feature (MED40 start-stop, AMG MENU,
  TPMS) shows metadata + status only, write disabled. No key generation, no seed/key transmit, no backend call.
- Passive-capture exclusivity now enforced in the scheduler (every job refused while capturing), not only in UI.

## 0.4.3 — 2026-09-30 — no lost B3 in the active scan · capture exclusivity in logic

- Frame reassembly no longer sacrifices valid packets: a notification that is whole packets on its own is
  never glued to a leftover partial (the partial is logged as dropped), and a bad byte costs only the bytes
  before the next plausible packet start (it used to discard the whole buffer, B3 included).
- Every decoded frame is broadcast to observers before correlation; transport listeners are isolated, so a
  failing listener can never starve the request waiter. The waiter is registered before the BLE write (test).
- The scan keeps every B3 by the TX/RX ids inside it: a B3 that lands after its probe's 1000 ms host deadline
  is credited to its ECU (and identified) instead of being discarded as unsolicited.
- Passive capture is exclusive: the scheduler refuses every job while capturing, every action logs its
  refusal, TX buttons are disabled (scan, DTC, readiness, live, voltage, preflight, developer tests).
- Regression tests: the 9 pairs the official app got `50 03` from, delivered split, after garbage, after a
  stale partial, after a foreign C0 / another pair's B3, and late.

## 0.4.2 — 2026-09-29 — any CAN reply to 0x33 confirms the ECU

- B3 with any non-zero CAN slot = CONFIRMAT; the diagnostic status is kept: `50 03` session accepted,
  `7F 10 xx` session refused (NRC shown), other frame. Only an all-zero slot = FĂRĂ RĂSPUNS (this pass);
  no B3 / BLE failure = EROARE COMUNICAȚIE. Identification F100/F18C/F111/F121 runs for every confirmed module.
- EXEC_UDS: `7F xx 78` carried by a 0xFD / 0xFE frame ends at once as RESPONSE_PENDING + FULL / PARTIAL_TIMEOUT
  (the dongle has stopped waiting); `7F xx 78` over 0x00 / 0xFF still keeps the request alive (P2*).
- Fixtures for the 29.09 official capture (CBCBOLERO 50 03 + identification, SCCM166 / TPM_172 zero slot),
  rebuilt on the verified layouts until the raw export is added.

## 0.4.1 — 2026-09-29 — ECU presence/session logic

- Two passes: all 70 candidates, then one retry of every candidate not confirmed in pass 1; the best result
  per module is kept (confirmed > completed probe > no B3).
- States: CONFIRMAT (B3 `06 50 03`, or a positive 0x40 answer on the module's CAN pair — e.g. MED40 live data
  on 0x7E0→0x7E8) · FĂRĂ RĂSPUNS (zero CAN slot this scan — not "absent") · EROARE COMUNICAȚIE (no B3).
- A confirmed module stays confirmed until disconnect / rescan / VIN change; later timeouts are only counted
  (the INDISPONIBIL downgrade is gone). Unconfirmed candidates are listed in a collapsed panel with their state.
- EXEC_UDS: `7F xx 78` followed by a dongle timeout frame (e.g. 0xFD) or by no frame stays RESPONSE_PENDING,
  with FULL_TIMEOUT / HOST_TIMEOUT as transport. 0xFE + `62 …` stays positive (official F18C frame in tests).

## 0.4.0 — 2026-09-29 — V1 passive BLE capture + 0x33 discovery per V1 ground truth

- CAPTURĂ is V1's passive BLE capture again: every FF01 notification is recorded raw at
  `characteristicvaluechanged` level — including replies to actions done in the official MBito app — with index,
  ISO time, performance.now() offset, direction, raw hex/length, command/arg/length/payload, CAN ids,
  diagnostic bytes/service/NRC, decoded OBD/DID value and parser status. Unknown/malformed packets are kept.
- While capturing MemoStats is silent: live data, scans and queued work are stopped, every action is guarded,
  and the BLE link refuses all writes; any attempt is logged as `UNEXPECTED MEMOSTATS TX` (blocked, not sent).
- START/STOP CAPTURE, ADD MARKER (timeline only), CLEAR SESSION, COPY LOG (TXT), EXPORT JSON (lossless) / TXT / CSV;
  READY/CAPTURING, packets, bytes, duration, last RX. Sessions persist in IndexedDB; saved captures can be
  searched and reopened. Filters: RX/TX/markers, command, EXEC_UDS, positive/negative, CAN id, service, hex/text.
- 0x33 discovery per V1 captures: B3 `06 50 03` = present, zero frame = absent, no B3 within 1000 ms = host
  timeout (shown as "neverificat", never as absent, not counted as a miss in history), other frames logged.
  Dongle timeout stays FA 00 (250 ms). Present modules get F100 + F18C/F111/F121 (official parameters).
- EXEC_UDS unchanged (0xFE + `62 …` positive, `7F xx 78` keeps waiting — already covered by tests).
- Fixtures: official scan B3/C0 frames and V1 live frames from this car.

## 0.3.1 — 2026-09-29 — ECU discovery over all 70 candidates + session module cache

- SCANARE / RESCANEAZĂ ECU probes **all 70** W176 candidates (23 vehicle-record + 47 catalog endpoints),
  sequentially with the V1 0x33 `10 03` probe, always to the end. The separate 23-module scan and
  "CAUTĂ MODULE NOI" are gone. Presence = protocol reply only (`50 03` or `7F 10 xx`).
- Only responders are kept in an in-memory session cache (name, variant, TX/RX, probe reply, F100).
  Diagnoză lists only detected modules; count is dynamic (`detectate / scanate`, e.g. 23/70).
- A failed F100 identification no longer drops a module that answered the probe.
- SCANEAZĂ ERORI reads only cached modules; tabs reuse the cache. Cleared on disconnect, VIN change,
  explicit rescan. Modules with 3 consecutive unanswered requests are marked INDISPONIBIL, not removed.

## 0.3.0 — 2026-09-29 — V1 parity: fault codes, module history, readiness, more data

- DIAGNOZĂ → **SCANEAZĂ ERORI**: read-only DTCs from modules that answered the current scan. REGULAR_ECU
  `19 01 0D` → `19 02 0D`; OLD_ECU_MANSPEC `19 02 0D`. V1 parser (offset 3, 4-byte stride, no sliding
  window, per-bit status). Generic MBito descriptions, clearly marked as not variant-confirmed (docs/DTC.md).
- Module history (first/last seen, seen/miss counts): NOU after a baseline exists, "nedetectat la scanarea
  curentă" instead of "removed"; current scan never mixed with history.
- **CAUTĂ MODULE NOI · 70**: explicit full W176 catalog probe (count from data); only responders are shown.
- Readiness (`01 01`: MIL, emission DTC count, monitors) and VIN (`09 02`).
- DATE LIVE → **MAI MULTE DATE** (V1): every extra PID the ECU reports as supported, by category, plus
  boost = MAP − BARO from fresh values only.
- FUNCȚII VEHICUL → STROBOSCOP card: compatibility shown, disabled, no transmit code exists.
- Docs: DTC.md, TELEMETRY.md, PERFORMANCE.md. 118 unit tests.

## 0.2.0 — 2026-09-29 — V1 behaviour as the specification + V1-style app

Protocol (V1 source and V1 frames are now the reference; docs/PROTOCOL.md §13):
- Connect runs V1's exact sequence: dongle info → **GET_CAN_BAUD** (`11 79 00 00`) → `01 0D` / `01 0C` on
  7E0→7E8 (1000/1000 ms) → supported-PID discovery. V2 0.1.x never sent GET_CAN_BAUD or any Mode 01.
- Live telemetry ported from V1: `01 <pid>` at timeout 200 / delay_after 200, exp_len = bytes + 2, V1 tiers
  (FAST every cycle, MEDIUM/SLOW round-robin), 300 ms cycle, FAST-only during a performance run.
- 0x33 ECU probe (`10 03` → `50 03`) byte-identical to V1's TX; ECU scan = probe then F100.
- Strict `request_nr` correlation (echo confirmed on the car); stale frames are rejected and logged.
- V2 reproduces V1's RPM TX and both V1 probe/speed frames byte for byte (unit tests).

App:
- V1 navigation and visual identity: DATE LIVE · PERFORMANȚĂ · DIAGNOZĂ · CAPTURĂ · SETĂRI.
- DATE LIVE: speed hero, RPM / coolant / intake / throttle / MAP / adapter voltage; freshness, no fake values.
- PERFORMANȚĂ: 0–100 km/h (READY/ARMED/RUNNING/COMPLETE/INVALID), interpolated timing, stale invalidation,
  7 stats, history with BEST.
- DIAGNOZĂ: ECU scan over the 23 modules, per-module details.
- CAPTURĂ: human-readable transaction capture with RAW expander, JSON export (capture + full log).
- SETĂRI: connection, live cycle, performance, diagnostics, logs; DEVELOPER / ADVANCED holds GATT details,
  protocol state, live diagnostics, manual read-only UDS/OBD test, SCCM166 replica, MED40 test, raw log.
- Screen error boundary: a render error can no longer blank the app.

## 0.1.1 — 2026-09-29 — Vehicle test 1 findings, MBito data audit, official replica test

- Real-car test 1 recorded: BLE, GET_DEV_NAME/FW/VOLTAGE, EXEC_UDS framing and `request_nr` echo **work**;
  MED40 `22 F1 00` got `0xFD` FULL_TIMEOUT (no CAN reply; engine was off, 12.43 V).
- Full audit of MBito-derived data (docs/DATA-SOURCES.md). Raw exports preserved verbatim in
  `src/data/w176/sources/`; every real observation recorded with its source in `src/data/w176/evidence.json`.
- Consolidated W176 ECU catalogue (70 endpoints, aliases, current-vehicle variants, evidence levels,
  known requests with exact official parameters) → `src/data/w176/ecu-catalogue.generated.json`,
  docs/W176-ECUS.md (`npm run catalogue`).
- New test: **TEST SCCM166** replays the official MBito `22 F1 00` captured on this car, every EXEC_UDS
  field copied from the captured frame (request_nr 0, timeout 200, exp_len 7).
- Decoded from the bundle: official V2 read path (`40 01 …`), `EResponseType.placeholder = 0xFF`,
  `defaultTimeout = 200`, `PredefinedCommand` request bytes.
- Logs: parsed EXEC_UDS header for every TX/RX frame; timing split (BLE write ack / write→RX / total).
- Unchanged: BLE/GATT transport and outer framing.


## 0.1.0 — 2026-09-28 — Phase 1 + 2 foundation

New project, built from scratch. The old MemoStats was used as protocol reference only.

- BLE transport for the MBito GATT service (Bluefy-proven connect sequence and write fallbacks,
  serialized writes, notification reassembly, reconnect, disconnect handling).
- MBito outer frame encoder/decoder; GET_DEV_NAME, GET_FW_VERSION, GET_VOLTAGE.
- EXEC_UDS outer opcode traced to the decompiled source: `0x40` (docs/PROTOCOL.md §4).
- EXEC_UDS V2 21-byte header encoder/decoder; raw transport status kept separate from UDS semantics.
- UDS semantics: positive / negative / ResponsePending (waits up to P2*) / no response / unexpected.
- DiagnosticScheduler: one operation in flight, priority queue, cancellation.
- MED40 `22 F1 00` identification test showing TX/RX raw, header, body, op code, latency.
- Structured logs with category filters, COPY / EXPORT / CLEAR, build version.
- 45 unit tests built on real captured frames where available.

Status: IMPLEMENTED — AWAITING VEHICLE VALIDATION.
