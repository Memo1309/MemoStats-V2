# MBito-derived data sources — audit (2026-09-29)

Every location searched for MBito knowledge, what it holds, and where V2 uses it. Reference material
stays read-only; V2 keeps verbatim copies under `src/data/w176/sources/` (SHA-256 identical).

## Used — primary data

| Path | Content | Used in V2 |
|---|---|---|
| `MemoStats/mbito-re/data/scan-candidates.json` (453 KB, sha256 `a3a2c92b…6b37`) | MBito GraphQL `GetCarsInfoGqlquery cars(id=43)`: **119** ECU records, **70** unique TX/RX endpoints, **3612** variants (id, name, op code), type, group, description. Logical/gateway/tester addresses all `null`. | copied → `src/data/w176/sources/mbito-car43-ecu-catalog.json` → catalogue |
| `MemoStats/mbito-re/data/vehicle-ecus.json` (13 KB, sha256 `d97cb180…bd60`) | MBito `GetUserVehiclesGqlQuery` for vehicle 80903: the **23** ECUs on this car with variant id/name, op code, TX/RX, hardware/software numbers. | copied → `src/data/w176/sources/mbito-vehicle80903-ecus.json` → catalogue, replica test |
| `MemoStats/mbito-re/data/live-measures.json` | Empty stub (`measures: []`). | nothing to use |
| `MemoStats/web/src/ecuInventory.selfcheck.ts` | **Only raw official-app frames on disk**: 31-packet excerpt of passive capture `capture-20260917-222558` (official Scan Vehicle): 11 EXEC_UDS responses (PARK117, SCCM166, TPM_172) + 20 scan probes (cmd 0x33). | transcribed → `src/data/w176/evidence.json` |
| `MemoStats/mbito-re/output.js` (Hermes v96 disassembly, UTF-16LE) | CMD/ARG enums, `parseExecUDS`, `composeUDSCmdArg`, V2Utils, `makeRequest`, `RequestType`, `EResponseType`, `PredefinedCommand`, `UDSErrorCode`. | docs/PROTOCOL.md, constants |
| `APK/MBito_1.0.68_extracted/lt.pixinn.mbito.apk` → `assets/index.android.bundle` (same source hash `9e69220a…619f`; also at `mbito-re/resources/assets/`) | Hermes array literals the disassembly prints without offsets. | decoded `executeUDS` prefix `[64,1,0,0]` and the `PredefinedCommand` request bytes |
| Old session transcripts `~/.claude/projects/c--Users-dota--Desktop-MemoStats/*.jsonl`, `…/C--Users-dota--Desktop-MemoStats-web/*.jsonl` (87 user messages) | User-reported real results: official scan 22/23 + F111 per ECU, MED40 F100 `62 F1 00 02 28 57 03`, DMFL166 F100, MED40 DTC count/list, CBCBOLERO DTC, old MemoStats `01 0D` → `41 0D 1B`, official `readMode01V2` parameters, OBD profiles. No further raw frames. | `evidence.json` (each row cites the message timestamp) |
| Old project memory `~/.claude/projects/c--Users-dota--Desktop-MemoStats/memory/*.md` | Engine-off caveat, latency history (timeout 1000 → ~1050 ms), F100↔op code discovery. | docs, evidence |

## Read, reference only

| Path | Content |
|---|---|
| `MemoStats/web/src/expectedEcuInventory.ts` | Same 23 ECUs as `vehicle-ecus.json` (hand-copied; consistent). |
| `MemoStats/web/src/w176Reference.generated.ts`, `web/scripts/build-w176-catalog.mjs` | Earlier generated copy of `scan-candidates.json` + manifest (70 endpoints, CRD malformed op codes). Superseded by the catalogue. |
| `MemoStats/web/src/ecuRoleReference.ts` | User-supplied F111 → role table (verified/probable). Not yet imported (roles are Phase 3 UI). |
| `MemoStats/web/src/scanProbe.ts`, `scanEngine.ts`, `scanResponse.ts`, `vehicle.ts`, `protocol.ts`, `bluetooth.ts` | Old implementation: probe layout (0x33), scan order, header codec. Probe layout reused to parse evidence probes. |
| `MemoStats/web/src/obdProfiles.ts`, `mode01ExpectedLengths.ts`, `obdPidDefinitions.ts`, `measureParsers.ts`, `dtc*.ts` | Phase 4/6/10 material. |
| `MemoStats/web/src/vehicleActions/stroboscope/*` | Stubs, no protocol. |
| `MemoStats/artifacts/w176-validation/simulated-scan.json` | **Simulated** — not evidence. |
| `MemoStats/STARTUP-SCAN-BUGFIX.md` | States no vehicle was connected; old MED40 frame `40 79 18 00 … 22 F1 00` generated, not transmitted. |
| `MemoStats/mbito-re/*.txt` (auth, graphql, measure, parser extracts) | Slices of `output.js`; GraphQL operation strings (auth/payment ignored per spec §45). |
| `MemoStats/mbito-re/tools/mbito-login-test.mjs`, `mbito-readonly.mjs` | Exporters that produced the JSON above (credentialed, not run). |
| `MemoStats/toate_codurile_dtc.json` (45 MB), `web/public/dtc-index.json` | DTC descriptions without ECU/variant ids — Phase 6. |
| `MemoStats/mbito-re/sources/` (JADX) | React Native shell only; BLE logic is in the JS bundle. |
| `Desktop/mbito dongle/mbito_full_backup_1.bin` (4 MB) | Dongle firmware dump: ESP32-C3, TWAI CAN driver, isotp-c ISO-TP stack, `uds request currently running`, debug strobe/coding handlers (never used). No timeout constants in strings. |
| `MemoStats/memostats/`, `backend/`, `frontend/`, `mobile/`, `mobile_old/`, `tests/` | Early prototypes (GET_* commands only). |

## Searched, nothing MBito-specific

claude-mem store (1 unrelated observation), `~/Downloads`, other Desktop folders (depth 4).

## Not on disk

The full passive capture sessions (19 responding pairs, 2026-09-17) lived in Bluefy IndexedDB and
were never exported to a file. The official app's **TX** bytes were never captured (passive capture
sees notifications only) — request fields are reconstructed from the header echo.
