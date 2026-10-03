# Known unknowns

Everything here is either INFERRED (implemented, needs a vehicle test) or UNRESOLVED (not implemented until
evidence exists). Nothing in this list may be presented as fact in the UI.

## Transport (Phase 1–2)

| # | Question | Status | What V2 does now | How to resolve |
|---|---|---|---|---|
| T1 | EXEC_UDS outer framing | **RESOLVED for acceptance** — VERIFIED REAL VEHICLE 2026-09-28: `40 79 18 00 …` was parsed by the dongle (full header echo, `C0 01` response). Official app sends `40 01 <len>` (arg = number of commands in the V2 script, decompiled `makeRequest`); never captured. | keeps `0x79` + payload length | Only revisit if a replica of an official transaction gets FD while the official app gets a reply at the same moment |
| T2 | Does the dongle echo `request_nr`? | **CONFIRMED** — V2 1→1 and 0→0; V1 B8, BE | **strict**: a frame with another `request_nr` is rejected as stale (0.2.0) | — |
| T3 | Outgoing `resp_status` placeholder | **RESOLVED** — VERIFIED DECOMPILED REFERENCE: `EResponseType.placeholder = 255` is V2Utils' default | `0xFF` | — |
| T4 | Header-only `0xFF` frames before the real reply | INFERRED (old MemoStats), never observed | treated as interim | watch RX RAW |
| T5 | After `7F xx 78`, does the dongle forward the final reply? | UNRESOLVED | waits up to P2* (5 s) | first slow DTC read (Phase 6) |
| T6 | Meaning of `0xFE` / `0xFD` | `0xFD` OBSERVED 2026-09-28 with **no body** (nothing received from CAN). `0xFE` observed with complete bodies when reply length ≠ `exp_len` (INFERRED meaning). | transport detail only; semantics from the body | more captures |
| T7 | Stale late replies after a browser timeout | Mitigated | link held for the abandoned request's timeout | — |
| T8 | BLE notification fragmentation on iOS | Handled, not seen (all real frames arrived whole) | `FrameAssembler` | — |
| T9 | Bluefy write API | Works (`write: true` reported by Bluefy 3.9.3) | fallback chain | — |
| T10 | Minimum gap between requests | Unknown | one in flight | Phase 3 scan |
| T11 | **Why did FD arrive ~1071 ms after TX when `timeout` = 600 ms?** | OPEN — not assumed to be a bug. Same session: GET_FW_VERSION round trip 79 ms, GET_VOLTAGE 90 ms, so ≈ 980 ms was spent inside the dongle. Old MemoStats (timeout 1000, exp_len 0) measured ~1050 ms. Hypotheses: (a) the dongle's no-answer path has a fixed ~1 s floor independent of `timeout`; (b) it retries once; (c) `timeout` units differ from ms (unlikely: official values 200/600/1000 are ms-shaped). | V2 now logs `ms_ble_write`, `ms_write_to_rx`, `ms_total` separately | Compare: replica (timeout 200) latency with a reply vs. FD latency for the same timeout |
| T13 | **Why do V2's EXEC_UDS requests get 0xFD while V1's worked?** | OPEN, leading hypothesis from V1's source: V1 always sent `GET_CAN_BAUD` (`11 79 00 00`) and Mode 01 reads before anything else; V2 0.1.x sent neither and started with `22 F1 00`. Car state (V2 test 1 at 12.43 V) is the other candidate. | 0.2.0 runs V1's exact sequence on connect | First 0.2.0 connect: does `01 0D` answer? |
| T12 | **Why did MED40 not answer `22 F1 00` on 2026-09-28?** | OPEN. Dongle voltage 12.43 V ⇒ engine not running; ignition state not recorded. MED40 answered `22 F1 00` for the official scan and `01 0D` for old MemoStats (engine running). The official app sends `10 03` (extended session) before its identification reads; V2 does not. | unchanged | Next test with ignition ON (cluster lit), engine running: SCCM166 replica first, then MED40 |

## Later phases

| Topic | Status |
|---|---|
| CAN baud enum mapping (`GET_CAN_BAUD` / `SET_CAN_BAUD`) | UNRESOLVED — `parseCANBaud` uses a lookup table not decoded. SET never used |
| `EXEC_UDS_EXT` (0x51) semantics | Not used |
| Per-DID expected response lengths for Mercedes DIDs | Official capture: F100 exp_len 7 (exact), F18C/F111/F121 exp_len 6 with timeout 600 (replies are longer → 0xFE). Others UNRESOLVED |
| OLD_ECU_MANSPEC DTC behaviour (HVAC246, FSCM212) | Implemented as V1 did (`19 02 0D`, raw codes); never tested on the car |
| DTC read timing | V1 builder values (1000 / 1000, list exp_len 0); count exp_len 3 from the official command table. Untested in V2 |
| DTC descriptions per ECU variant | UNRESOLVED — only the global export is on disk; `car_control_unit_dtc_map` needed |
| Mileage comparison (MED40 `22 01 0C`, EZS166 `22 00 04`, IC172 `22 00 01`) | NOT IMPLEMENTED — byte widths for EZS/IC are not documented anywhere on disk; V1 also showed "DATE INDISPONIBILE" |
| VIN via `09 02` | Implemented; multi-frame ISO-TP is done inside the dongle (firmware has isotp) but never observed |
| Readiness `01 01` | Standard SAE decoding, spark-ignition monitors only |
| Mercedes measurement definitions | GRAPHQL REFERENCE only, import in Phase 10 |
| Coding payload semantics | UNRESOLVED, reference only, never executed |
| Stroboscope HLI_FL176/HLI_FR176 sequence and ALL OFF | UNRESOLVED — not implemented, not transmittable |
