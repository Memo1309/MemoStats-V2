// Every constant here names its evidence. Full trail: docs/PROTOCOL.md.
// "output.js" = MemoStats/mbito-re/output.js, the Hermes v96 disassembly of MBito 1.0.68
// (UTF-16LE; source hash 9e69220a1f90f039a6db58c8d3fbfa7e41bc619f, matches the APK bundle).

/** VERIFIED REAL VEHICLE (old MemoStats on Bluefy) + VERIFIED DECOMPILED REFERENCE. */
export const MBITO_SERVICE_UUID = '000000ff-0000-1000-8000-00805f9b34fb';
export const MBITO_CHARACTERISTIC_UUID = '0000ff01-0000-1000-8000-00805f9b34fb';

/**
 * Outer command codes V2 is allowed to send. Deliberately a subset of the MBito CMD enum:
 * write/flash/reset/SET_CAN_BAUD commands are not representable here on purpose.
 * VERIFIED DECOMPILED REFERENCE: output.js CMD enum (~L1664716–1664900),
 *   GET_DEV_NAME=0 (LoadConstZero), GET_FW_VERSION=1, GET_VOLTAGE=4, EXEC_UDS=`LoadConstUInt8 64`.
 * VERIFIED REAL VEHICLE: GET_DEV_NAME/GET_FW_VERSION/GET_VOLTAGE answered by V2407127C3;
 *   EXEC_UDS responses captured as raw 0xC0 (= 0x40 | 0x80).
 */
export const MbitoCmd = {
  GET_DEV_NAME: 0x00,
  GET_FW_VERSION: 0x01,
  GET_VOLTAGE: 0x04,
  /** Read-only. VERIFIED V1 SOURCE: MemoStats V1 sent `11 79 00 00` on every connect, before its first
   * EXEC_UDS (App.tsx runInitialCanDiagnostics, "[CAN PREFLIGHT]"). The reply arg is a baud enum. */
  GET_CAN_BAUD: 0x11,
  /** ECU presence / session probe (NEW_FULL_SCRIPT) carrying a raw CAN frame (`02 10 03 …`).
   * VERIFIED REAL OFFICIAL CAPTURE: the app sends `33 02 20 00 …` (outer arg 0x02) and the dongle replies
   * `B3 02 20 00 …`. V1's `33 79 …` used the wrong arg (0x79) and got no B3 — the scan-failure root cause. */
  SCAN_PROBE: 0x33,
  EXEC_UDS: 0x40,
} as const;
export type MbitoCmd = (typeof MbitoCmd)[keyof typeof MbitoCmd];

export const MBITO_CMD_NAMES: Record<number, string> = {
  [MbitoCmd.GET_DEV_NAME]: 'GET_DEV_NAME',
  [MbitoCmd.GET_FW_VERSION]: 'GET_FW_VERSION',
  [MbitoCmd.GET_VOLTAGE]: 'GET_VOLTAGE',
  [MbitoCmd.GET_CAN_BAUD]: 'GET_CAN_BAUD',
  [MbitoCmd.SCAN_PROBE]: 'SCAN_PROBE',
  [MbitoCmd.EXEC_UDS]: 'EXEC_UDS',
};

/**
 * Outer ARG byte. VERIFIED DECOMPILED REFERENCE: output.js ARG enum (~L1664641–1664712):
 *   FAIL=0, SUCCESS=1, SF=121 (0x79, single frame). buildChunkedPackets() sends every packet
 *   whose payload fits MAX_CHUNK_PAYLOAD with ARG.SF.
 * VERIFIED REAL VEHICLE: responses carry arg 0x01 (SUCCESS), e.g. captured `C0 01 1C 00 …`.
 */
export const MbitoArg = {
  FAIL: 0x00,
  SUCCESS: 0x01,
  SINGLE_FRAME: 0x79,
  /** Scan-script frame arg. VERIFIED REAL OFFICIAL CAPTURE: the MBito app sends the 0x33 probe as
   * `33 02 20 00 …` and the dongle replies `B3 02 20 00 …`. The scan is a script command (NEW_FULL_SCRIPT),
   * not a single-frame request, so it uses 0x02 — not 0x79. This was the "no B3" root cause. */
  SCAN_SCRIPT: 0x02,
} as const;

/**
 * Outer ARG is command-specific — it is NOT globally 0x79.
 *   0x33 SCAN_PROBE → 0x02  (VERIFIED REAL OFFICIAL CAPTURE: 33 02 … → B3 02 …)
 *   everything else → 0x79  (VERIFIED: device info 00/01/04/11 79 …; EXEC_UDS 0x40 79 … read real V1 live data,
 *                            so its request arg is 0x79 — the C0 01 in replies is the SUCCESS response arg).
 * Add an entry here to give a command a different request arg; do not change the default.
 */
export const MBITO_OUTER_ARG: Partial<Record<number, number>> = {
  [MbitoCmd.SCAN_PROBE]: MbitoArg.SCAN_SCRIPT,
};

/** Raw command byte of a dongle→app packet has this bit set; normalized cmd = raw % 0x80.
 * VERIFIED DECOMPILED REFERENCE: parsePacketHeader() `isResponse = raw >= 128; cmd = raw % 128`. */
export const MBITO_RESPONSE_FLAG = 0x80;

export const MBITO_HEADER_SIZE = 4;

/** VERIFIED DECOMPILED REFERENCE: `LoadConstInt r3, 493` → MAX_CHUNK_PAYLOAD. Larger payloads need
 * FF/CF/LF chunking, which MBito only supports for cmd >= EXEC_UDS_EXT (0x51) — not implemented. */
export const MAX_SINGLE_FRAME_PAYLOAD = 493;
