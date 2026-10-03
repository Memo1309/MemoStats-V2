import { describe, expect, it } from 'vitest';
import { fromHex, toHex } from '../core/bytes';
import { MbitoBleTransport, type RawLink, type RawLinkEvent } from '../core/ble/mbitoBleTransport';
import { MbitoCmd } from '../core/mbito/constants';
import { encodeRequest } from '../core/mbito/frame';
import { encodeScanProbe } from '../core/mbito/scanProbe';
import { type CaptureEvent, type CapturePacket, CSV_COLUMNS, EMPTY_FILTER, buildCsv, buildJson, buildTxt, filterEvents, parsePacket } from './capture';
import { SILENT_REASON, addMarker, captureStore, startCapture, stopCapture } from './captureStore';

// Real frames. Official MBito scan on this car, recorded by V1's passive capture (capture-20260917-222558):
const OFFICIAL_PARK117_F18C_FE = 'C0 01 29 00 00 00 FE 8A 07 00 00 B1 04 00 00 58 02 00 00 06 00 03 00 14 00 62 F1 8C 33 30 34 30 30 37 33 31 37 31 35 37 30 34 34 33 32';
const OFFICIAL_SCCM166_F100_OK = 'C0 01 1C 00 00 00 00 22 06 00 00 84 04 00 00 C8 00 00 00 07 00 03 00 07 00 62 F1 00 00 05 08 03';
const OFFICIAL_SCCM166_PROBE_PRESENT = 'B3 02 20 00 00 01 02 00 22 06 00 00 02 10 03 55 55 55 55 55 01 01 FA 00 84 04 00 00 06 50 03 00 14 00 C8 32';
const OFFICIAL_PROBE_ABSENT = 'B3 02 20 00 00 01 02 00 8F 07 00 00 02 10 03 55 55 55 55 55 01 01 FA 00 97 07 00 00 00 00 00 00 00 00 00 00';
// V1 live data on this car:
const V1_RPM_TX = '40 79 17 00 00 B9 FF E0 07 00 00 E8 07 00 00 C8 00 C8 00 04 00 02 00 02 00 01 0C';
const V1_SPEED_RX = 'C0 01 18 00 00 B8 00 E0 07 00 00 E8 07 00 00 C8 00 C8 00 03 00 02 00 03 00 41 0D 00';

let seq = 0;
function packet(hex: string, direction: 'RX' | 'TX' = 'RX', unexpectedTx = false): CapturePacket {
  const bytes = fromHex(hex);
  seq += 1;
  return { kind: 'PACKET', sessionId: 's', index: seq, iso: '2026-09-29T10:00:00.000Z', perfMs: seq, relMs: seq, direction, rawHex: toHex(bytes), length: bytes.length, unexpectedTx, ...parsePacket(bytes) };
}

describe('capture packet parser (real frames)', () => {
  it('0xFE with a complete 62 F1 8C body is a positive response with the ASCII serial', () => {
    expect(parsePacket(fromHex(OFFICIAL_PARK117_F18C_FE))).toMatchObject({
      command: 'EXEC_UDS', rawCommand: 0xc0, argument: 0x01, payloadLength: 0x29, canTx: 0x78a, canRx: 0x4b1, respStatus: 0xfe,
      response: 'POSITIVE', service: 0x62, nrc: null, parserStatus: 'OK', decoded: 'DID F18C = "30400731715704432" · 0xFE PARTIAL_TIMEOUT',
    });
  });

  it('F100 0x00 OK, binary data stays hex (no invented ASCII)', () => {
    expect(parsePacket(fromHex(OFFICIAL_SCCM166_F100_OK))).toMatchObject({ canTx: 0x622, canRx: 0x484, respStatus: 0x00, response: 'POSITIVE', diagHex: '62 F1 00 00 05 08 03', decoded: 'DID F100 · 0x00 OK' });
  });

  it('B3 arg 02 with 06 50 03 = ECU present; zero frame = absent', () => {
    expect(parsePacket(fromHex(OFFICIAL_SCCM166_PROBE_PRESENT))).toMatchObject({
      command: 'SCAN_PROBE', argument: 0x02, canTx: 0x622, canRx: 0x484, response: 'POSITIVE', service: 0x50, diagHex: '50 03 00 14 00 C8', decoded: 'ECU PREZENT (50 03)', parserStatus: 'OK',
    });
    expect(parsePacket(fromHex(OFFICIAL_PROBE_ABSENT))).toMatchObject({ canTx: 0x78f, canRx: 0x797, response: null, diagHex: null, decoded: 'ECU absent (cadru CAN zero)' });
  });

  it('decodes V1 OBD traffic: TX request and RX speed value', () => {
    expect(parsePacket(fromHex(V1_RPM_TX))).toMatchObject({ command: 'EXEC_UDS', canTx: 0x7e0, canRx: 0x7e8, requestNr: 0xb9, respStatus: null, service: 0x01, diagHex: '01 0C', response: null });
    expect(parsePacket(fromHex(V1_SPEED_RX))).toMatchObject({ requestNr: 0xb8, response: 'POSITIVE', service: 0x41, decoded: 'Vehicle speed = 0 km/h · 0x00 OK' });
  });

  it('0x33 TX: probed ids and the 10 03 request', () => {
    expect(parsePacket(encodeRequest(MbitoCmd.SCAN_PROBE, encodeScanProbe(0x622, 0x484)))).toMatchObject({ canTx: 0x622, canRx: 0x484, service: 0x10, diagHex: '10 03', response: null });
  });

  it('negative response keeps service and NRC; pending is labelled', () => {
    const negative = parsePacket(fromHex('C0 01 18 00 00 01 FF 22 06 00 00 84 04 00 00 58 02 00 00 06 00 03 00 03 00 7F 22 31'));
    expect(negative).toMatchObject({ response: 'NEGATIVE', service: 0x22, nrc: 0x31 });
    expect(parsePacket(fromHex('C0 01 18 00 00 01 FF 22 06 00 00 84 04 00 00 58 02 00 00 06 00 03 00 03 00 7F 22 78')).decoded).toContain('ResponsePending');
  });

  it('never throws: malformed / merged notifications are UNKNOWN with the raw kept by the caller', () => {
    expect(parsePacket(fromHex('C0 01'))).toMatchObject({ parserStatus: 'UNKNOWN', command: null });
    const truncated = parsePacket(fromHex('C0 01 1C 00 00 00'));
    expect(truncated).toMatchObject({ parserStatus: 'UNKNOWN', command: 'EXEC_UDS', payloadLength: 0x1c, payloadHex: '00 00' });
    expect(truncated.warnings[0]).toMatch(/length/);
    expect(parsePacket(fromHex(`${OFFICIAL_PROBE_ABSENT} ${OFFICIAL_PROBE_ABSENT}`)).parserStatus).toBe('UNKNOWN');
    expect(parsePacket(fromHex('84 01 02 00 8F 30'))).toMatchObject({ command: 'GET_VOLTAGE', decoded: '12.431 V', parserStatus: 'OK' });
  });
});

describe('capture filters and exports', () => {
  const marker: CaptureEvent = { kind: 'MARKER', sessionId: 's', index: 100, iso: '2026-09-29T10:00:01.000Z', perfMs: 100, relMs: 100, text: 'scan pornit în MBito' };
  const events: CaptureEvent[] = [
    packet(OFFICIAL_SCCM166_PROBE_PRESENT), packet(OFFICIAL_PROBE_ABSENT), packet(OFFICIAL_PARK117_F18C_FE), marker,
    packet('C0 01 18 00 00 01 FF 22 06 00 00 84 04 00 00 58 02 00 00 06 00 03 00 03 00 7F 22 31'), packet(V1_RPM_TX, 'TX', true), packet('C0 01'),
  ];
  const kinds = (list: CaptureEvent[]) => list.map(e => e.index);
  const [present, absent, f18c, , negative, tx, broken] = events;

  it('filters by direction, marker, command, EXEC_UDS, response, CAN id, service and raw hex/text', () => {
    expect(kinds(filterEvents(events, { ...EMPTY_FILTER, kinds: ['TX'] }))).toEqual([tx?.index]);
    expect(kinds(filterEvents(events, { ...EMPTY_FILTER, kinds: ['MARKER'] }))).toEqual([100]);
    expect(kinds(filterEvents(events, { ...EMPTY_FILTER, command: 'SCAN_PROBE' }))).toEqual([present?.index, absent?.index]);
    // a 2-byte fragment has no command to match; it stays visible in the unfiltered list
    expect(kinds(filterEvents(events, { ...EMPTY_FILTER, execUdsOnly: true }))).toEqual([f18c?.index, negative?.index, tx?.index]);
    expect(kinds(filterEvents(events, EMPTY_FILTER))).toContain(broken?.index);
    expect(kinds(filterEvents(events, { ...EMPTY_FILTER, response: 'NEGATIVE' }))).toEqual([negative?.index]);
    expect(kinds(filterEvents(events, { ...EMPTY_FILTER, response: 'POSITIVE', canId: '0x622' }))).toEqual([present?.index]);
    expect(kinds(filterEvents(events, { ...EMPTY_FILTER, service: '62' }))).toEqual([f18c?.index]);
    expect(kinds(filterEvents(events, { ...EMPTY_FILTER, text: '0650 03' }))).toEqual([present?.index]);
    expect(kinds(filterEvents(events, { ...EMPTY_FILTER, text: 'a5 00' }))).toEqual([]);
    expect(kinds(filterEvents(events, { ...EMPTY_FILTER, text: 'unexpected' }))).toEqual([tx?.index]);
    expect(kinds(filterEvents(events, { ...EMPTY_FILTER, text: 'pornit' }))).toEqual([100]);
  });

  const meta = {
    id: 'capture-test', startedAt: '2026-09-29T10:00:00.000Z', endedAt: '2026-09-29T10:01:00.000Z', app: 'MemoStats V2 test', device: 'V2407127C3', firmware: 'v1.31',
    service: 'svc', characteristic: 'chr', packetCount: 6, byteCount: 0, markerCount: 1, unexpectedTxCount: 1, lastRxAt: null,
  };

  it('JSON is lossless: every event with its complete raw bytes', () => {
    const parsed = JSON.parse(buildJson(meta, events)) as { session: typeof meta; events: CaptureEvent[] };
    expect(parsed.session).toEqual(meta);
    expect(parsed.events).toEqual(events);
    expect(parsed.events.flatMap(e => (e.kind === 'PACKET' ? [e.rawHex] : []))).toContain('C0 01');
  });

  it('CSV has the required columns first and one row per event; TXT flags the unexpected TX', () => {
    const [header, ...rows] = buildCsv(events).split('\n');
    expect(header?.split(',').slice(0, 15)).toEqual(['index', 'timestamp', 'relative_ms', 'event_type', 'direction', 'raw_hex', 'command', 'argument', 'payload_hex', 'sender_id', 'receiver_id', 'diagnostic_hex', 'decoded', 'marker', 'parser_status']);
    expect(header?.split(',')).toHaveLength(CSV_COLUMNS.length);
    expect(rows).toHaveLength(events.length);
    expect(rows.find(r => r.includes('MARKER'))).toContain('scan pornit în MBito');
    expect(rows.find(r => r.startsWith(`${tx?.index},`))).toContain('UNEXPECTED_MEMOSTATS_TX');
    const txt = buildTxt(meta, events);
    expect(txt).toContain('UNEXPECTED MEMOSTATS TX');
    expect(txt).toContain(`RAW: ${OFFICIAL_SCCM166_PROBE_PRESENT}`);
  });
});

class FakeLink implements RawLink {
  readonly listeners = new Set<(event: RawLinkEvent) => void>();
  blocked: string | null = null;
  onRaw(listener: (event: RawLinkEvent) => void) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  blockWrites(reason: string | null) {
    this.blocked = reason;
  }
  emit(direction: 'RX' | 'TX', hex: string, blocked = false) {
    for (const listener of this.listeners) listener({ direction, bytes: fromHex(hex), perfMs: performance.now(), blocked });
  }
}

describe('passive capture session', () => {
  it('silences MemoStats while listening, records every notification and marker, flags TX, restores on stop', () => {
    const link = new FakeLink();
    startCapture(link, { app: 'test', device: 'V2407127C3', firmware: 'v1.31' });
    expect(link.blocked).toBe(SILENT_REASON);
    link.emit('RX', OFFICIAL_SCCM166_PROBE_PRESENT);
    addMarker('');
    link.emit('TX', V1_RPM_TX, true);
    link.emit('RX', 'C0 01 1C 00 00 00');
    const { status, session, events } = captureStore.get();
    expect(status).toBe('CAPTURING');
    expect(events.map(e => (e.kind === 'MARKER' ? e.text : `${e.index} ${e.direction}${e.unexpectedTx ? ' UNEXPECTED' : ''}`))).toEqual(['1 RX', 'Marker 1', '3 TX UNEXPECTED', '4 RX']);
    expect(session).toMatchObject({ packetCount: 3, markerCount: 1, unexpectedTxCount: 1, byteCount: 36 + 27 + 6 });
    expect(events.at(-1)).toMatchObject({ rawHex: 'C0 01 1C 00 00 00', parserStatus: 'UNKNOWN' });

    stopCapture();
    expect(link.blocked).toBeNull();
    expect(link.listeners.size).toBe(0);
    expect(captureStore.get()).toMatchObject({ status: 'READY', session: { endedAt: expect.any(String) } });
  });

  it('the BLE transport refuses writes while blocked and reports the attempt as a blocked TX', async () => {
    const transport = new MbitoBleTransport();
    const seen: RawLinkEvent[] = [];
    transport.onRaw(e => seen.push(e));
    transport.blockWrites(SILENT_REASON);
    await expect(transport.write(fromHex(V1_RPM_TX))).rejects.toThrow(SILENT_REASON);
    expect(seen).toMatchObject([{ direction: 'TX', blocked: true }]);
    transport.blockWrites(null);
    await expect(transport.write(fromHex(V1_RPM_TX))).rejects.toThrow('MBito nu este conectat');
  });
});
