// Single-probe transport debug for the 0x33 scan (developer only). Captures the exact request bytes and
// EVERY raw BLE notification during one probe, plus a 0x40 fallback, so we can tell whether no B3 arrives
// at all (dongle silent) or a B3 arrives and is dropped in the parser/correlation. Not Passive Capture.
import { createStore } from '../state/createStore';

export interface RawNotification {
  /** ms after the probe write */
  atMs: number;
  len: number;
  hex: string;
}

export type ProbeResultTag = 'PRESENT' | 'ZERO_SLOT' | 'NO_B3' | 'PARSE_ERROR';

export interface ProbeDebug {
  txId: number;
  rxId: number;
  requestHex: string;
  /** the exact 36-byte frame is well-formed (33 02 20 00 … 36 bytes) */
  requestOk: boolean;
  /** EVERY raw BLE RX notification captured during the probe window (before any decode/filter) */
  notifications: RawNotification[];
  b3Received: boolean;
  /** full decoded B3 outer frame, hex */
  decodedHex: string | null;
  /** the final 8-byte response slot, hex */
  responseSlotHex: string | null;
  outcome: string;
  present: boolean;
  latencyMs: number | null;
  result: ProbeResultTag;
}

export interface UdsDebug {
  txId: number;
  rxId: number;
  requestHex: string;
  framesHex: string | null;
  semantic: string;
  transport: string;
  present: boolean;
  udsBody: string | null;
  result: 'VALID_RESPONSE' | 'TIMEOUT';
}

export interface ScanDebugState {
  running: boolean;
  probe: ProbeDebug | null;
  uds: UdsDebug | null;
  note: string | null;
}

export const scanDebugStore = createStore<ScanDebugState>({ running: false, probe: null, uds: null, note: null });
