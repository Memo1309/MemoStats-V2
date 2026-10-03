# Vehicle test checklist

A protocol layer is **WORKING** only after it passes here on the real car. Until then it is
**IMPLEMENTED — AWAITING VEHICLE VALIDATION**.

## Results so far

### Test 1 — 2026-09-28 23:38, build 2026-09-28T20:06:51Z, Bluefy 3.9.3 / iOS 18.7

| Layer | Result |
|---|---|
| BLE connect, notifications | **WORKING** — VERIFIED REAL VEHICLE |
| GET_DEV_NAME `00 79 00 00` → `80 01 0A 00 "V2407127C3"` | **WORKING** |
| GET_FW_VERSION `01 79 00 00` → `81 01 05 00 "v1.31"` | **WORKING** |
| GET_VOLTAGE `04 79 00 00` → `84 01 02 00 8F 30` = 12.431 V | **WORKING** (12.43 V ⇒ engine was not running) |
| EXEC_UDS framing `40 79 18 00 …` | **ACCEPTED** — dongle echoed the whole 21-byte header |
| `request_nr` echo | **CONFIRMED** (01 → 01) |
| MED40 `22 F1 00` on 0x7E0/0x7E8 | **FAILED at CAN level** — `resp_status 0xFD` FULL_TIMEOUT, no body, 1071 ms (KNOWN-UNKNOWN T11, T12) |

Raw RX of the failure: `C0 01 15 00 00 01 FD E0 07 00 00 E8 07 00 00 58 02 00 00 07 00 03 00 00 00`

## Milestone 2 — V1's live OBD path in V2 (v0.2.0) — NEXT TEST

V2 (0.2.0+) runs V1's exact connect sequence (docs/PROTOCOL.md §13): GET_CAN_BAUD → `01 0D` / `01 0C` on
7E0→7E8 → supported PIDs → live polling at timeout 200 / delay_after 200.

### Before you start

- [ ] Ignition **ON**, engine **running** (adapter voltage ≈ 14–15 V). Official MBito app closed.
- [ ] Refresh the page in Bluefy; SETĂRI shows `0.3.0`.
- [ ] CAPTURĂ → **START CAPTURE** (records every request for the export).

### Steps

| # | Action | Expected |
|---|---|---|
| 1 | DATE LIVE → **CONECTEAZĂ MBITO** | V2407127C3 · v1.31 · voltage; then "Motorul răspunde pe OBD." |
| 2 | wait | Live data starts by itself: VITEZĂ LIVE with a **LIVE** badge, RPM / COOLANT / INTAKE TEMP / THROTTLE / MAP / ADAPTER VOLTAGE filled |
| 3 | drive a few metres | speed changes |
| 4 | SETĂRI → DEVELOPER → Live speed diagnostics | samples/requests, Hz, max gap |
| 5 | Parked: DIAGNOZĂ → **SCANEAZĂ ERORI** | module scan, then fault codes from modules that answered; live data resumes afterwards |
| 5b | DIAGNOZĂ → **CITEȘTE READINESS** | MIL state, monitors, VIN (if the ECU supports 09 02) |
| 6 | CAPTURĂ → **STOP CAPTURE** → **EXPORT** | send the JSON |

If step 1 says "Motorul nu răspunde pe OBD": press **REÎNCEARCĂ** once with the engine running, then export
anyway — the preflight frames (GET_CAN_BAUD reply, `01 0D`/`01 0C` raw) are in the export and in
SETĂRI → DEVELOPER → Protocol state.

## Milestone 1b — one official transaction, replayed exactly (next test)

The request is SCCM166 `22 F1 00`, rebuilt field for field from the official MBito frame captured on
this car (`src/vehicle/identification/officialReplica.ts`). Expected TX:
`40 79 18 00 00 00 FF 22 06 00 00 84 04 00 00 C8 00 00 00 07 00 03 00 03 00 22 F1 00`

### Before you start

- [ ] Ignition **ON** — instrument cluster lit. Engine **running** is better (voltage then reads ≈ 14 V).
- [ ] Official MBito app fully closed.
- [ ] Refresh the page in Bluefy; LOGURI shows the new build time (0.1.1).

### Steps

| # | Action | Expected | Record |
|---|---|---|---|
| 1 | CONECTEAZĂ MBITO | `CONECTAT`, V2407127C3, v1.31 | voltage: |
| 2 | TEST SCCM166 (green button) | `RĂSPUNDE`, Identic cu captura **DA**, op code `000508 · = catalog` | |
| 3 | | Transport `0x00 OK`, request_nr ecou `DA (0)` | |
| 4 | | Timing rows: Total, Scriere BLE confirmată, Scriere → RX | |
| 5 | TEST SCCM166 ×3 more | Same each time; note the timing rows | |
| 6 | TEST MED40 | Record badge, transport, timing | |
| 7 | LOGURI → EXPORT | send the JSON | |

### Reading the outcome

| SCCM166 | MED40 | Meaning |
|---|---|---|
| RĂSPUNDE | RĂSPUNDE | CAN path works; test 1 failed because the car was off |
| RĂSPUNDE | FĂRĂ RĂSPUNS (0xFD) | CAN path works; MED40 needs something else (session `10 03`? — decide before sending anything new) |
| RĂSPUNDE · NEGATIV `7F 22 …` | — | ECU present, but wants the official `10 03` first; reported, not auto-fixed |
| FĂRĂ RĂSPUNS (0xFD) with ignition ON | FĂRĂ RĂSPUNS | Our request differs from the official one in a way the header echo cannot show → next step is the official outer arg `0x01` (T1) |

## Milestone 1 — dongle + one MED40 request (v0.1.0)

### Before you start

- [ ] Ignition **ON**, engine **running** (old tests with the engine off gave misleading negative results).
- [ ] Official MBito app fully closed — it holds the BLE connection.
- [ ] Bluefy has Bluetooth permission; open the URL by typing/pasting it in Bluefy's address bar.
- [ ] LOGURI shows `MemoStats V2 0.1.0 · <build time>` — write the build time down.

### Steps and expected results

| # | Action | Expected | Record |
|---|---|---|---|
| 1 | CONECTEAZĂ MBITO, pick the dongle | Badge `CONECTAT` | |
| 2 | Read the dongle card | Dispozitiv `V2407127C3` | |
| 3 | | Firmware `v1.31` (write the exact string) | |
| 4 | | Tensiune plausible (≈12–15 V running) | |
| 5 | CITEȘTE TENSIUNEA ×3 | Value and time update | |
| 6 | TEST MED40 | Badge `RĂSPUNDE` | |
| 7 | | Op code `022857 · VC11_A` | |
| 8 | | Transport raw (`0x00 OK` or `0xFE PARTIAL_TIMEOUT` — both fine) | |
| 9 | | `request_nr ecou`: DA / NU (open question T2) | |
| 10 | | Latency (ms) | |
| 11 | | TX RAW starts `40 79 18 00` | |
| 12 | | RX RAW starts `C0 01` | |
| 13 | TEST MED40 ×5 | Same result each time; note latency min/max | |
| 14 | DECONECTEAZĂ | `DECONECTAT`, no errors | |
| 15 | Connect again, then unplug the dongle | `PIERDUT`, voltage marked `STALE` | |
| 16 | Plug it back in, RECONECTEAZĂ MBITO | Reconnects, info re-read | |
| 17 | LOGURI → EXPORT | JSON file saved — send it back | |

### Pass

Steps 1–14 as expected, five consecutive MED40 tests identical except latency.

### If it fails

| Symptom | Look at | Likely meaning |
|---|---|---|
| Chooser shows nothing | Bluefy permission, official app still connected | BLE, not protocol |
| Info rows empty, errors shown | LOGURI → MBITO | Dongle command framing |
| MED40 `FĂRĂ RĂSPUNS`, transport `NO_RX`, no `RX EXEC_UDS` in logs | LOGURI → MBITO | Framing question T1 — try the `executeUDS` form |
| MED40 `FĂRĂ RĂSPUNS`, transport `FULL_TIMEOUT` | RX RAW | Dongle ran it, ECU silent — check ignition/engine |
| `RĂSPUNS NEAȘTEPTAT` | CORP UDS | Reply to a different request — send the export |
| Frames marked `ignore` in RX RAW | note text | Address mismatch — send the export |
