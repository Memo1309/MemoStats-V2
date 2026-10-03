# DTC diagnostics (read-only)

Code: `src/diagnostics/dtc/` · tests: `dtc.test.ts` · UI: DIAGNOZĂ → SCANEAZĂ ERORI.

## Flow

1. If there is no module scan in this session, run it first (0x33 probe `10 03` + `22 F1 00`, V1 workflow).
2. Read DTCs only from modules that **answered in this scan**. Nothing from history is ever shown as a current fault.
3. Strategy per MBito ECU type:

| Type | Requests | Evidence |
|---|---|---|
| REGULAR_ECU | `19 01 0D` (count, exp_len 3) → `19 02 0D` only if count > 0 | official app traffic on this car (user report); PredefinedCommand `getDTCcount` = `19 01 0D`, exp 3 |
| OLD_ECU_MANSPEC (HVAC246, FSCM212) | `19 02 0D` directly | V1 `dtcRead.ts` |

Timing: V1 builder — timeout 1000 ms, delay_after 1000 ms; list exp_len 0 (V1). `7F 19 78` keeps the
request alive up to P2* (5 s) — never "no response".

## Parsing (`dtcCodec.ts`, port of V1)

`59 02 <availability mask>` then records at **offset 3**, **exactly 4 bytes** each (3 DTC + 1 status).
No sliding window; trailing bytes that don't make a full record produce a warning, never a DTC.
REGULAR_ECU codes are SAE-formatted (`05 2E 71` → `P052E71`); OLD_ECU_MANSPEC codes stay raw hex.

Real fixture (MED40): `59 02 FF 05 2E 71 64 D4 57 00 64 06 DA 00 64` → `P052E71`, `U145700`, `P06DA00`, status `0x64`.

Status bits decoded individually: 0x01 testFailed · 0x02 testFailedThisOperationCycle · 0x04 pendingDTC ·
0x08 confirmedDTC · 0x10 testNotCompletedSinceLastClear · 0x20 testFailedSinceLastClear ·
0x40 testNotCompletedThisOperationCycle · 0x80 warningIndicatorRequested.

## Descriptions

Only source on disk: the global MBito export (`public/dtc-index.json`, copied from V1, built from
`toate_codurile_dtc.json`). It has **no ECU or variant id**, so every description is marked
"descriere generică — neconfirmată pentru această variantă ECU", all candidates are kept, and the raw code
stays the truth. Variant-exact lookup needs the `car_control_unit_dtc_map` export (not on disk). Loaded lazily
(12 MB) only when a DTC exists.

## Counting

"MODULE CU ERORI" = modules with ≥ 1 correctly parsed DTC. Modules that didn't answer, refused, or returned
something unparseable are listed as "fără citire erori" and never counted as faults.

## Never

No `14` ClearDiagnosticInformation, no reset, no CLEAR button — there is no code path for it.
