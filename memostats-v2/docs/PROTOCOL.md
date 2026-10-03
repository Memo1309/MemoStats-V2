# MBito protocol — what V2 relies on, and why

Evidence labels used everywhere in code and docs:

| Label | Meaning |
|---|---|
| **VERIFIED REAL VEHICLE** | Observed on the user's W176 + dongle `V2407127C3` |
| **VERIFIED DECOMPILED REFERENCE** | Read directly from MBito 1.0.68 bytecode |
| **GRAPHQL REFERENCE** | From the exported MBito catalog data |
| **INFERRED — NEEDS VEHICLE TEST** | Reasoned, not observed |
| **UNRESOLVED** | No direct evidence; not implemented |

## 1. Sources (read-only, never modified)

| Source | Location | Notes |
|---|---|---|
| Hermes disassembly | `MemoStats/mbito-re/output.js` | UTF-16LE. Read a UTF-8 copy: `iconv -f UTF-16LE -t UTF-8 output.js > /tmp/out.js`. Bytecode v96, source hash `9e69220a1f90f039a6db58c8d3fbfa7e41bc619f`. Line numbers below refer to the UTF-8 copy. |
| Hermes bundle | `APK/MBito_1.0.68_extracted/lt.pixinn.mbito.apk` → `assets/index.android.bundle` | Same source hash as `output.js`. Used to decode array literals that the disassembly prints without offsets. |
| Real captures | `MemoStats/web/src/ecuInventory.selfcheck.ts` | Official MBito app traffic recorded passively on the user's car (Sept 2026). |
| Old project notes | old MemoStats Claude memory `project_mbito_obd.md` | Real `01 0D` and `22 F1 00` replies obtained by old MemoStats on 7E0/7E8. |

## 2. BLE GATT

| Item | Value | Evidence |
|---|---|---|
| Service | `000000ff-0000-1000-8000-00805f9b34fb` | VERIFIED REAL VEHICLE, VERIFIED DECOMPILED REFERENCE |
| Characteristic (write + notify) | `0000ff01-0000-1000-8000-00805f9b34fb` | same |
| Connect | `requestDevice({filters:[{services:[svc]}], optionalServices:[svc]})` → `gatt.connect()` → `startNotifications()` | Proven on Bluefy by old MemoStats |
| Write | `writeValueWithResponse` → `writeValueWithoutResponse` → `writeValue` fallback | Proven on Bluefy |

A notification may hold part of a packet or several packets. MBito's own `parsePacketHeader()` returns `null`
for an incomplete packet and waits; V2's `FrameAssembler` does the same.

## 3. Outer MBito frame

```
[cmd u8][arg u8][length u16 LE][payload …length]
```

* **Request** `cmd` = command code, `arg` = `0x79` (`SF`, single frame), `length` = payload length.
* **Response** raw `cmd` has bit 7 set; `isResponse = raw >= 0x80`, `cmd = raw % 0x80`; `arg` = `0x01` (`SUCCESS`) or `0x00` (`FAIL`).

Evidence: `parsePacketHeader` (~L1668293), `buildPacket` (~L1668158), `buildChunkedPackets` (~L1668202).
`GET_DEV_NAME` request `00 79 00 00` → `V2407127C3`: VERIFIED REAL VEHICLE.
EXEC_UDS response `C0 01 1C 00 …`: VERIFIED REAL VEHICLE.

### ARG enum — VERIFIED DECOMPILED REFERENCE (~L1664641)

| Name | Value | | Name | Value |
|---|---|---|---|---|
| FAIL | 0x00 | | CF1…CF10 | 0x81…0x8A |
| SUCCESS | 0x01 | | LF | 0xFA |
| SF | 0x79 | | NACK / ACK / NOT_IMPL | 0xFD / 0xFE / 0xFF |
| FF | 0x80 | | | |

`MAX_CHUNK_PAYLOAD = 493` (`LoadConstInt r3, 493`). Payloads above it are split FF, CF1…CF10 (cycling), LF —
but only for commands where `supportsChunking(cmd) = cmd >= EXEC_UDS_EXT (0x51)`. V2 never needs this and
refuses payloads > 493 B.

### CMD enum — VERIFIED DECOMPILED REFERENCE (~L1664716–1664900)

| Code | Name | V2 |
|---|---|---|
| 0x00 | GET_DEV_NAME | **sends** |
| 0x01 | GET_FW_VERSION | **sends** |
| 0x02 | GOTO_BOOTLOADER_W | forbidden |
| 0x04 | GET_VOLTAGE | **sends** |
| 0x05 | GOTO_BOOTLOADER_B | forbidden |
| 0x06 | RESET_DEVICE | forbidden |
| 0x10 | SET_CAN_BAUD | forbidden (never automatic; enum mapping UNRESOLVED) |
| 0x11 | GET_CAN_BAUD | not yet (diagnostic use later) |
| 0x12–0x16 | IP config / LED | not used |
| 0x20–0x39 | continuous / script commands | not used |
| **0x40** | **EXEC_UDS** | **sends** |
| 0x50 | DBG_DTC | not used |
| 0x51 | EXEC_UDS_EXT | not used (chunked variant) |
| 0x52–0x5x | DoIP | not used (W176 is CAN) |
| 0x64–0x66 | SD_*_FLASHING | forbidden |

Only the four **sends** codes exist in `src/core/mbito/constants.ts`. Write/flash/reset codes are not representable.

## 4. EXEC_UDS outer opcode = **0x40** — direct evidence

1. **Enum definition** (`output.js` ~L1664814):
   ```
   LoadConstUInt8    r6, 64
   PutById           r3, r6, 49, "EXEC_UDS"
   ...
   LoadConstUInt8    r6, 81
   PutById           r3, r6, 51, "EXEC_UDS_EXT"
   ```
2. **Response parser registry** (~L1673367): `CMD.EXEC_UDS → parseExecUDS` and `CMD.EXEC_UDS_EXT → parseExecUDS`.
3. **Sender** `executeUDS` (~L2040460): builds the packet from a 4-element array literal (array buffer offset 169303).
   Decoding that literal from the APK bundle (serialized-literal tag `0x74` = 4 × int32):
   `74 40000000 01000000 00000000 00000000` → **`[64, 1, 0, 0]`** → cmd `0x40`.
4. **Real vehicle**: official-app responses captured on the W176 start with raw `0xC0` = `0x40 | 0x80`;
   old MemoStats sent `0x40` frames and received real `01 0D` / `22 F1 00` replies.

**Framing difference to know about (see KNOWN-UNKNOWN):** MBito's `executeUDS` writes `arg = 0x01` and puts the
*total* packet length (4 + payload) in bytes 2–3, while its generic `buildPacket` path and old MemoStats use
`arg = 0x79` with the *payload* length. V2 uses the latter, the form the real dongle already answered for old
MemoStats. **Real-vehicle result 2026-09-28:** the dongle parsed V2's `40 79 18 00 …` frame and echoed the full
header (§10), so V2 keeps this framing. The official V2 read path is described in §9.

## 5. EXEC_UDS V2 inner frame (21-byte header + UDS body)

Encoder: `composeUDSCmdArg` (~L2040557). Decoder: `parseExecUDS` (~L1673818, rejects < 21 B).

| Off | Size | MBito field | Spec name | V2 outgoing value | Evidence |
|---|---|---|---|---|---|
| 0 | u8 | request_type | request_type | `0x00` | captured echo `00` |
| 1 | u8 | request_nr | request_nr | 1…255 rolling; replica tests send the captured value (0) | echoed — VERIFIED REAL VEHICLE 2026-09-28 |
| 2 | u8 | resp_status | response_type | `0xFF` placeholder | V2Utils default `EResponseType.placeholder` = 255 — VERIFIED DECOMPILED REFERENCE |
| 3 | u32 LE | tx_id | sender_id | ECU request id | captured echo |
| 7 | u32 LE | rx_id | receiver_id | ECU response id | captured echo |
| 11 | u16 LE | timeout | timeout | ms | captured echo (200 / 600) |
| 13 | u16 LE | delay_after | response_timeout | `0` | captured echo `00 00` |
| 15 | u16 LE | exp_len | expected_response_length | per request (F100: 7) | captured echo |
| 17 | u16 LE | cmd_len | request_length | UDS request length | captured echo |
| 19 | u16 LE | payload_len | actual_response_length | = request length on requests | V2Utils `actual_res_len = command.length` |
| 21 | … | payload | UDS body | request bytes | |

### Response

The dongle echoes the request header, fills `resp_status` and sets `payload_len` to the response length.
**The body at offset 21 is the complete UDS response — no request echo precedes it.** Real capture (SCCM166):

```
C0 01 1C 00 | 00 00 00 | 22 06 00 00 | 84 04 00 00 | C8 00 | 00 00 | 07 00 | 03 00 | 07 00 | 62 F1 00 00 05 08 03
cmd arg len   type nr st   tx 0x622      rx 0x484      200ms   delay   exp 7   cmd 3   len 7   UDS response
```

(MBito's `parseExecUDS` splits the body at `cmd_len` into `cmdPart` = `62 F1 00` and `dataPart` = the data;
that is just SID+DID vs data, not an echo.)

### Raw `resp_status` — VERIFIED DECOMPILED REFERENCE (`UDSErrorCode`, ~L1673925)

| Wire | Name | Seen on the car |
|---|---|---|
| 0x00 | OK | yes — F100, 7 B body with `exp_len 7` |
| 0xFF | NEGATIVE_RESPONSE | — |
| 0xFE | PARTIAL_TIMEOUT | yes — **with a complete positive body** (F18C, 20 B body with `exp_len 6`) |
| 0xFD | FULL_TIMEOUT | — |

MBito has a separate normalized 0/1/2/3 enum elsewhere; V2 never mixes it with these wire values.
V2 keeps `transport` (raw) and `semantic` (ISO 14229 meaning of the body) as separate fields; the UI shows the
semantic result (`RĂSPUNDE`) and the raw status only as technical detail.

## 6. UDS semantics (ISO 14229-1)

| Body | Semantic | ECU presence |
|---|---|---|
| `SID+0x40` + identifier echo | POSITIVE_RESPONSE | PRESENT |
| `7F SID nn` (nn ≠ 78) | NEGATIVE_RESPONSE | PRESENT |
| `7F SID 78` | RESPONSE_PENDING — keep waiting up to P2*server (5000 ms) | PRESENT |
| empty | NO_RESPONSE | NOT_CONFIRMED |
| anything else | UNEXPECTED_RESPONSE | NOT_CONFIRMED |

## 7. Dongle info — VERIFIED DECOMPILED REFERENCE + VERIFIED REAL VEHICLE

| Command | Decode |
|---|---|
| GET_DEV_NAME | UTF-8 text (`parseDeviceName`: `TextDecoder('utf-8')`) → `V2407127C3` |
| GET_FW_VERSION | UTF-8 text (`parseFirmwareVersion`) → observed `v1.31` |
| GET_VOLTAGE | `getUint16(0, LE) / 1000` volts (`parseVoltage`) → observed ~15.08 V |

## 8. Official identification request parameters (read from real response headers)

| DID | timeout | delay_after | exp_len | cmd_len |
|---|---|---|---|---|
| F100 | 200 ms | 0 | 7 | 3 |
| F18C / F111 / F121 | 600 ms | 0 | 6 | 3 |

V2's MED40 test sends `22 F1 00` with timeout 600 ms, delay 0, exp_len 7:
```
40 79 18 00  00 <nr> FF  E0 07 00 00  E8 07 00 00  58 02  00 00  07 00  03 00  03 00  22 F1 00
```

## 9. The official app's V2 read path (decoded 2026-09-29)

`UDS.ReadV2.command({...})` → `request.addCommand()` → `request.toRequest(RequestType.V2Scripts.SingleScript)`
→ `makeRequest` → `pixinnBleManager.read`. VERIFIED DECOMPILED REFERENCE:

| Fact | Evidence |
|---|---|
| `RequestType.V2Scripts.SingleScript = 64` → outer cmd `0x40` (EXEC_UDS) | `output.js` ~L1636183 `LoadConstUInt8 r5, 64` |
| `makeRequest` header: byte 0 = request type (64), byte 1 = **number of commands** in the script (1 for a single read), bytes 2–3 = byte length of the commands | ~L1637589–1637760 |
| Each command's `request_nr` byte is overwritten with its index → `00` for a single read (matches every capture) | ~L1637770 |
| V2Utils defaults: `timeout` = `defaultTimeout` = **200 ms**, `response_timeout`/`delay_after` = 0, `response_type` = `EResponseType.placeholder` = **0xFF** | ~L1636160, ~L1636470 |
| `EResponseType` (normalized, *not* the wire code): placeholder 255, ok 0, negative_frame 1, partial_timeout 2, full_timeout 3 | ~L1636206 |

So the official single read is `40 01 <len> <21-byte header> <UDS>`; V2 sends `40 79 <len> …`, which the
dongle demonstrably parses (§10). Official TX bytes were never captured.

## 10. Real-vehicle transport results (2026-09-28)

```
TX 40 79 18 00  00 01 FF  E0 07 00 00  E8 07 00 00  58 02  00 00  07 00  03 00  03 00  22 F1 00
RX C0 01 15 00  00 01 FD  E0 07 00 00  E8 07 00 00  58 02  00 00  07 00  03 00  00 00
```

The dongle echoed `request_type`, `request_nr` (01), both CAN ids, timeout, delay, `exp_len`, `cmd_len`,
set `resp_status` = `0xFD` (FULL_TIMEOUT) and `payload_len` = 0: it ran the request and heard nothing on CAN.
TX→RX 1071 ms for a 600 ms timeout (KNOWN-UNKNOWN T11).

## 11. Official predefined commands (request bytes decoded from the bundle)

`PredefinedCommand` (~L1632048). Bytes are array literals decoded from `index.android.bundle`; the object
value buffers (per-command timeouts/ids) did not decode reliably and are not used.

| Class | Name → request |
|---|---|
| Read (allowed) | `checkECUVariant 22 F1 00`, `getSerialNumber 22 F1 8C`, `getHardwareNumber 22 F1 11`, `getSoftwareNumber 22 F1 21`, `getDTCcount 19 01 0D`, `getOriginalVinCode 22 F1 90`, `getCurrentVinCode 22 F1 A0`, `getVinCode164 22 00 05`, `getVoltage 01 42` |
| Read, old ECUs (KWP-style, INFERRED mapping to OLD_ECU types) | `checkECUVariant2 1A 87`, `checkECUVariant3 1A 86`, `getOldHardwareNumber 1A 86`, `getOldSoftwareNumber 1A 9D`, `getVinCodeOldECU 1A 90`, `getVinCode164Old 21 05` |
| Session (not a read — not used by V2) | `checkECU 10 03` (official scan probe), `checkECU2 10 92`, `testerRemove 10 01`, `startDevicePing 3E 00`, `startOldECUPing 3E 01` |
| **Forbidden** | `hardReset 11 01`, `softReset 11 03`, `getECUSeed 27 0B`, `writeECUKey 27 0C` |

The official Scan Vehicle probes each endpoint with `10 03` inside a cmd-0x33 script (raw CAN frame
`02 10 03 55 55 55 55 55`, 250 ms) and only then reads F100/F18C/F111/F121. Captured replies from SCCM166 and
TPM_172: `50 03 00 14 00 C8` → P2 20 ms, P2* 2000 ms.

## 12. Dongle firmware (dump `mbito dongle/mbito_full_backup_1.bin`)

ESP32-C3; CAN via ESP-IDF TWAI (`components/can_lib`); ISO-TP via an isotp-c style stack
(`components/isotp/isotp.c`: "Single-frame length too small.", "Flow control frame too short."); UDS
guard strings "UDS request invalid length", "uds request currently running". Also contains debug handlers
for strobe/coding/VIN — V2 never sends the commands that reach them. No timeout constants visible in strings.

## 13. MemoStats V1 behaviour — the specification since 0.2.0

V1 read real live data from this car (9 km/h, 740 rpm, 92 °C, 28 °C, 11.8 %, 35 kPa, 15.08 V). Its source
(`MemoStats/web/src/App.tsx`, `liveStream.ts`, `obdPidDefinitions.ts`, `scanProbe.ts`) and its logged frames are
the reference. V2 reproduces them byte for byte (tests in `src/core/obd/v1Protocol.test.ts`).

**Connect sequence** (V1 `connectMbito` → `runInitialCanDiagnostics`), reproduced in `src/vehicle/v1Preflight.ts`:

| # | V1 step | Bytes |
|---|---|---|
| 1 | GET_DEV_NAME, GET_FW_VERSION, GET_VOLTAGE | `00 79 00 00`, `01 79 00 00`, `04 79 00 00` |
| 2 | **GET_CAN_BAUD** (read-only; reply arg = baud enum, any arg accepted) | `11 79 00 00` |
| 3 | `01 0D` on 7E0→7E8, timeout 1000 / delay_after 1000 / exp_len 3 | `40 79 17 00 00 nn FF E0 07 00 00 E8 07 00 00 E8 03 E8 03 03 00 02 00 02 00 01 0D` |
| 4 | `01 0C`, same timing, exp_len 4 | |
| 5 | only if 3 or 4 answered: supported PIDs `01 00`, `01 20` … exp_len 6, while the next-block bit is set | |

V2 0.1.x skipped step 2 and never sent Mode 01 — it went straight to `22 F1 00`.

**Live polling** (V1 `liveStream.ts`) → `src/telemetry/liveTelemetry.ts`: `01 <pid>` on 7E0→7E8, **timeout 200 /
delay_after 200** (two separate u16: `C8 00 C8 00`), exp_len = data bytes + 2, `request_nr` rolling. FAST (0D, 0C, 11)
every cycle, one MEDIUM (0B) every 2nd, one SLOW (05, 0F) every 5th, cycle 300 ms; FAST only during a
performance run. Real V1 frames:

```
TX 40 79 17 00 | 00 B9 FF | E0 07 00 00 | E8 07 00 00 | C8 00 | C8 00 | 04 00 | 02 00 | 02 00 | 01 0C
RX C0 01 18 00 | 00 B8 00 | E0 07 00 00 | E8 07 00 00 | C8 00 | C8 00 | 03 00 | 02 00 | 03 00 | 41 0D 00
```

**ECU scan** (V1 / official) → `src/diagnostics/ecuScan.ts`: per module a 0x33 probe
`33 79 20 00 | 00 01 02 00 | tx u32 | 02 10 03 55 55 55 55 55 | 01 01 FA 00 | rx u32 | 00×8` (FA 00 = 250 ms
dongle CAN timeout). Reply `B3 02 20 00` + the same 32 bytes; the last 8 are the CAN frame from rx_id:
any non-zero slot = confirmed (`06 50 03 …` session accepted, `7F 10 xx` refused, other frame — status kept) ·
all zero = probe completed, no response this pass (not absent) · no B3 within 1000 ms (host
wait) = host/transport timeout, never read as absence · any other frame (e.g. `7F 10 xx`) = logged, not counted (the official app checks
only `50 03`). The next probe goes out only after the B3 or the host timeout. Candidates not confirmed in pass 1 are retried once;
a module can also be confirmed later by any positive 0x40 answer on its CAN pair (0x33 silence ≠ absence). A present module then gets the
official identification reads: `22 F1 00` (timeout 200, delay 0, exp_len 7), then `22 F1 8C`, `22 F1 11`,
`22 F1 21` (timeout 600, delay 0, exp_len 6 — official capture; replies arrive as 0xFE with a complete `62 …` body,
which is a positive answer).

**Correlation:** `request_nr` is echoed (V1 B8/BE, V2 1→1, 0→0), so V2 now rejects any EXEC_UDS frame whose
`request_nr` differs from the request in flight (logged as `stale request_nr`), in addition to the TX/RX check.
