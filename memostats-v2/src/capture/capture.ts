// Passive BLE capture (V1 behaviour): every FF01 notification / write attempt becomes one lossless
// event. RAW bytes are authoritative; the parsed fields reuse the app's own decoders and are only an
// aid — an unknown or malformed packet is kept with its raw bytes and a parser warning.
import { dataView, hexByte, hexId, toHex } from '../core/bytes';
import { MBITO_CMD_NAMES, MBITO_HEADER_SIZE, MBITO_RESPONSE_FLAG, MbitoCmd } from '../core/mbito/constants';
import { decodeFrame, decodeText, decodeVoltage } from '../core/mbito/frame';
import { SCAN_PROBE_PAYLOAD_LENGTH, decodeScanProbe } from '../core/mbito/scanProbe';
import { PIDS, decodeMode01 } from '../core/obd/pids';
import { decodeExecUdsResponse, rawTransportStatus } from '../core/uds/execUds';
import { NRC_NAMES } from '../core/uds/udsSemantics';

export type ParserStatus = 'OK' | 'PARTIAL' | 'UNKNOWN';

export interface PacketFields {
  rawCommand: number | null;
  /** MBito command name when recognized, else hex */
  command: string | null;
  argument: number | null;
  payloadLength: number | null;
  payloadHex: string | null;
  canTx: number | null;
  canRx: number | null;
  /** EXEC_UDS resp_status as sent by the dongle (0x00, 0xFE, 0xFD, 0xFF) */
  respStatus: number | null;
  requestNr: number | null;
  /** diagnostic bytes: UDS/OBD body (EXEC_UDS) or the CAN frame (0x33) */
  diagHex: string | null;
  service: number | null;
  nrc: number | null;
  response: 'POSITIVE' | 'NEGATIVE' | null;
  decoded: string | null;
  parserStatus: ParserStatus;
  warnings: string[];
}

interface EventBase {
  sessionId: string;
  index: number;
  iso: string;
  /** performance.now() */
  perfMs: number;
  /** ms since START CAPTURE */
  relMs: number;
}

export interface CapturePacket extends EventBase, PacketFields {
  kind: 'PACKET';
  direction: 'RX' | 'TX';
  rawHex: string;
  length: number;
  /** MemoStats tried to write while listening (blocked, never sent) */
  unexpectedTx: boolean;
}

export interface CaptureMarker extends EventBase {
  kind: 'MARKER';
  text: string;
}

export type CaptureEvent = CapturePacket | CaptureMarker;

export interface CaptureSessionMeta {
  id: string;
  startedAt: string;
  endedAt: string | null;
  app: string;
  device: string | null;
  firmware: string | null;
  service: string;
  characteristic: string;
  packetCount: number;
  byteCount: number;
  markerCount: number;
  unexpectedTxCount: number;
  lastRxAt: string | null;
}

// ---------- parsing ----------

const empty = (): PacketFields => ({
  rawCommand: null, command: null, argument: null, payloadLength: null, payloadHex: null, canTx: null, canRx: null,
  respStatus: null, requestNr: null, diagHex: null, service: null, nrc: null, response: null, decoded: null,
  parserStatus: 'OK', warnings: [],
});

function nrcText(nrc: number): string {
  return `NRC ${hexByte(nrc)}${NRC_NAMES[nrc] ? ` ${NRC_NAMES[nrc]}` : ''}`;
}

/** Diagnostic body → service / NRC / positive-negative / decoded value. */
function applyDiagnostic(out: PacketFields, body: Uint8Array, isResponse: boolean): void {
  if (body.length === 0) return;
  out.diagHex = toHex(body);
  const [first = 0, second = 0, third] = body;
  if (!isResponse) {
    out.service = first;
    return;
  }
  if (first === 0x7f) {
    out.response = 'NEGATIVE';
    out.service = second;
    out.nrc = third ?? null;
    out.decoded = third === undefined ? 'răspuns negativ trunchiat' : nrcText(third);
    return;
  }
  out.service = first;
  if (first < 0x40) return;
  out.response = 'POSITIVE';
  if (first === 0x41) {
    const def = PIDS[second];
    const value = decodeMode01(second, body);
    if (def && value !== null) out.decoded = `${def.name} = ${Number(value.toFixed(2))} ${def.unit}`;
  } else if (first === 0x62 && body.length >= 3) {
    const data = body.subarray(3);
    const did = toHex(body.subarray(1, 3)).replace(' ', '');
    const ascii = data.length > 0 && data.every(b => b >= 0x20 && b <= 0x7e) ? String.fromCharCode(...data) : null;
    out.decoded = `DID ${did}${ascii ? ` = "${ascii}"` : ''}`;
  } else if (first === 0x50) {
    out.decoded = `sesiune ${hexByte(second)} acceptată`;
  }
}

/** Parses one raw notification / write. Never throws: failures become parser warnings. */
export function parsePacket(raw: Uint8Array): PacketFields {
  const out = empty();
  if (raw.length < MBITO_HEADER_SIZE) {
    return { ...out, parserStatus: 'UNKNOWN', warnings: [`${raw.length} B, shorter than the 4-byte MBito header`] };
  }
  const command = (raw[0] ?? 0) % MBITO_RESPONSE_FLAG;
  const isResponse = (raw[0] ?? 0) >= MBITO_RESPONSE_FLAG;
  out.rawCommand = raw[0] ?? null;
  out.argument = raw[1] ?? null;
  out.payloadLength = dataView(raw).getUint16(2, true);
  out.command = MBITO_CMD_NAMES[command] ?? hexByte(command);
  let payload: Uint8Array;
  try {
    payload = decodeFrame(raw).payload;
  } catch (error) {
    out.payloadHex = toHex(raw.subarray(MBITO_HEADER_SIZE)) || null;
    return { ...out, parserStatus: 'UNKNOWN', warnings: [(error as Error).message] };
  }
  out.payloadHex = toHex(payload) || null;
  try {
    if (command === MbitoCmd.EXEC_UDS) {
      const response = decodeExecUdsResponse(payload);
      out.canTx = response.header.txId;
      out.canRx = response.header.rxId;
      out.requestNr = response.header.requestNr;
      out.warnings.push(...response.warnings);
      if (isResponse) {
        out.respStatus = response.header.responseType;
        applyDiagnostic(out, response.udsBody, true);
        const transport = `${hexByte(response.header.responseType)} ${rawTransportStatus(response.header.responseType)}`;
        out.decoded = out.decoded ? `${out.decoded} · ${transport}` : transport;
      } else {
        applyDiagnostic(out, response.rawBody, false);
      }
    } else if (command === MbitoCmd.SCAN_PROBE) {
      if (payload.length !== SCAN_PROBE_PAYLOAD_LENGTH) out.warnings.push(`0x33 payload ${payload.length} B, expected ${SCAN_PROBE_PAYLOAD_LENGTH}`);
      const probe = decodeScanProbe(payload);
      out.canTx = probe.txId;
      out.canRx = probe.rxId;
      if (isResponse) {
        applyDiagnostic(out, probe.response, true);
        out.decoded = probe.positive ? 'ECU PREZENT (50 03)' : probe.absent ? 'ECU absent (cadru CAN zero)' : out.decoded ?? `cadru CAN ${toHex(payload.subarray(24))}`;
      } else {
        const length = Math.min(payload[8] ?? 0, 7);
        applyDiagnostic(out, payload.subarray(9, 9 + length), false);
        out.decoded = `probe ${hexId(probe.txId)}→${hexId(probe.rxId)}`;
      }
    } else if (isResponse && (command === MbitoCmd.GET_DEV_NAME || command === MbitoCmd.GET_FW_VERSION)) {
      out.decoded = decodeText(payload);
    } else if (isResponse && command === MbitoCmd.GET_VOLTAGE) {
      out.decoded = `${decodeVoltage(payload).toFixed(3)} V`;
    } else if (isResponse && command === MbitoCmd.GET_CAN_BAUD) {
      out.decoded = `baud enum arg ${hexByte(raw[1] ?? 0)}`;
    } else if (!MBITO_CMD_NAMES[command]) {
      out.warnings.push(`unknown MBito command ${hexByte(command)}`);
    }
  } catch (error) {
    out.warnings.push((error as Error).message);
    return { ...out, parserStatus: 'PARTIAL' };
  }
  return { ...out, parserStatus: out.warnings.length ? 'PARTIAL' : 'OK' };
}

// ---------- filters ----------

export interface CaptureFilter {
  /** empty = every kind */
  kinds: ('RX' | 'TX' | 'MARKER')[];
  /** exact command name, '' = any */
  command: string;
  execUdsOnly: boolean;
  response: 'ANY' | 'POSITIVE' | 'NEGATIVE';
  canId: string;
  service: string;
  /** raw hex (byte aligned, spaces optional) or text */
  text: string;
}

export const EMPTY_FILTER: CaptureFilter = { kinds: [], command: '', execUdsOnly: false, response: 'ANY', canId: '', service: '', text: '' };

const hexNumber = (value: string): number | null => {
  const clean = value.trim().replace(/^0x/i, '');
  return /^[0-9a-f]+$/i.test(clean) ? parseInt(clean, 16) : null;
};

/** Byte-aligned hex search: "5003" matches "50 03", never "A5 00 3F". */
function rawContains(rawHex: string, query: string): boolean {
  const q = query.replace(/[\s:]/g, '').toLowerCase();
  if (!q || q.length % 2 !== 0 || !/^[0-9a-f]+$/.test(q)) return false;
  const compact = rawHex.replace(/ /g, '').toLowerCase();
  for (let i = compact.indexOf(q); i !== -1; i = compact.indexOf(q, i + 1)) if (i % 2 === 0) return true;
  return false;
}

export function filterEvents(events: readonly CaptureEvent[], f: CaptureFilter): CaptureEvent[] {
  const canId = hexNumber(f.canId);
  const service = hexNumber(f.service);
  const text = f.text.trim().toLowerCase();
  const packetOnly = f.command !== '' || f.execUdsOnly || f.response !== 'ANY' || canId !== null || service !== null;
  return events.filter(e => {
    if (e.kind === 'MARKER') {
      if ((f.kinds.length && !f.kinds.includes('MARKER')) || packetOnly) return false;
      return !text || e.text.toLowerCase().includes(text);
    }
    if (f.kinds.length && !f.kinds.includes(e.direction)) return false;
    if (f.command && e.command !== f.command) return false;
    if (f.execUdsOnly && e.command !== 'EXEC_UDS') return false;
    if (f.response !== 'ANY' && e.response !== f.response) return false;
    if (canId !== null && e.canTx !== canId && e.canRx !== canId) return false;
    if (service !== null && e.service !== service) return false;
    if (text) {
      const haystack = [e.command, e.decoded, e.diagHex, e.warnings.join(' '), e.unexpectedTx ? 'unexpected memostats tx' : ''].join(' ').toLowerCase();
      if (!haystack.includes(text) && !rawContains(e.rawHex, text)) return false;
    }
    return true;
  });
}

// ---------- exports ----------

const clock = (iso: string): string => iso.slice(11, 23);
const idText = (id: number | null): string => (id === null ? '' : hexId(id));

export function buildJson(meta: CaptureSessionMeta, events: readonly CaptureEvent[]): string {
  return JSON.stringify({ format: 'memostats-v2-ble-capture', formatVersion: 1, exportedAt: new Date().toISOString(), session: meta, events }, null, 2);
}

export function buildTxt(meta: CaptureSessionMeta, events: readonly CaptureEvent[]): string {
  const lines = [
    `MEMOSTATS V2 · CAPTURĂ BLE PASIVĂ ${meta.id}`,
    `App: ${meta.app} | Dongle: ${meta.device ?? '?'} | FW: ${meta.firmware ?? '?'}`,
    `Service: ${meta.service} | Characteristic: ${meta.characteristic}`,
    `Start: ${meta.startedAt} | Stop: ${meta.endedAt ?? '(în curs / întreruptă)'}`,
    `Pachete: ${meta.packetCount} | Octeți: ${meta.byteCount} | Markere: ${meta.markerCount} | TX neașteptat: ${meta.unexpectedTxCount}`,
    '',
  ];
  for (const e of events) {
    const head = `[${String(e.index).padStart(6, '0')}] ${clock(e.iso)} +${e.relMs.toFixed(3)}ms`;
    if (e.kind === 'MARKER') {
      lines.push(`${head} MARKER`, `  ${e.text}`, '');
      continue;
    }
    lines.push(`${head} ${e.direction} ${e.length}B${e.unexpectedTx ? ' !!! UNEXPECTED MEMOSTATS TX (blocat, netrimis) !!!' : ''}`);
    lines.push(`  RAW: ${e.rawHex}`);
    if (e.command) lines.push(`  CMD: ${e.command} (raw ${hexByte(e.rawCommand ?? 0)}) ARG: ${hexByte(e.argument ?? 0)} LEN: ${e.payloadLength ?? '?'}`);
    if (e.canTx !== null) lines.push(`  CAN: ${idText(e.canTx)} → ${idText(e.canRx)}${e.requestNr !== null ? ` · request_nr ${e.requestNr}` : ''}`);
    if (e.diagHex) lines.push(`  DIAG: ${e.diagHex}${e.response ? ` (${e.response === 'POSITIVE' ? 'pozitiv' : 'negativ'})` : ''}`);
    if (e.decoded) lines.push(`  DECODAT: ${e.decoded}`);
    if (e.parserStatus !== 'OK') lines.push(`  PARSER: ${e.parserStatus} — ${e.warnings.join('; ')}`);
    lines.push('');
  }
  return lines.join('\n');
}

export const CSV_COLUMNS = [
  'index', 'timestamp', 'relative_ms', 'event_type', 'direction', 'raw_hex', 'command', 'argument', 'payload_hex',
  'sender_id', 'receiver_id', 'diagnostic_hex', 'decoded', 'marker', 'parser_status',
  'byte_length', 'raw_command', 'payload_length', 'resp_status', 'request_nr', 'service', 'nrc', 'response', 'unexpected_tx', 'parser_warnings',
] as const;

const csvField = (value: string | number | null): string => {
  const text = value === null ? '' : String(value);
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
};

export function buildCsv(events: readonly CaptureEvent[]): string {
  const rows = events.map(e => {
    if (e.kind === 'MARKER') return [e.index, e.iso, e.relMs.toFixed(3), 'MARKER', '', '', '', '', '', '', '', '', '', e.text, '', '', '', '', '', '', '', '', '', '', ''];
    return [
      e.index, e.iso, e.relMs.toFixed(3), e.unexpectedTx ? 'UNEXPECTED_MEMOSTATS_TX' : 'PACKET', e.direction, e.rawHex,
      e.command, e.argument === null ? '' : hexByte(e.argument), e.payloadHex, idText(e.canTx), idText(e.canRx), e.diagHex, e.decoded, '', e.parserStatus,
      e.length, e.rawCommand === null ? '' : hexByte(e.rawCommand), e.payloadLength, e.respStatus === null ? '' : hexByte(e.respStatus), e.requestNr,
      e.service === null ? '' : hexByte(e.service), e.nrc === null ? '' : hexByte(e.nrc), e.response, e.unexpectedTx ? 'yes' : '', e.warnings.join('; '),
    ];
  });
  return [CSV_COLUMNS.join(','), ...rows.map(r => r.map(csvField).join(','))].join('\n');
}
