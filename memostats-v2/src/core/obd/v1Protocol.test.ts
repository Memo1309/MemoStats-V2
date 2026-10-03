import { describe, expect, it } from 'vitest';
import { type Bytes, fromHex, toHex } from '../bytes';
import { MbitoCmd } from '../mbito/constants';
import { decodeFrame, encodeRequest } from '../mbito/frame';
import { MbitoClient } from '../mbito/mbitoClient';
import { decodeScanProbe, encodeScanProbe, probeEcu } from '../mbito/scanProbe';
import { decodeExecUdsResponse, encodeExecUdsRequest } from '../uds/execUds';
import { FakeTransport, dongleReply } from '../../testing/fakeDongle';
import { runV1Preflight } from '../../vehicle/v1Preflight';
import { V1_LIVE_TIMING, mode01Spec } from './obdRead';
import { decodeMode01, decodeSupportedPids } from './pids';

// Frames below are MemoStats V1 traffic with the real W176 (user-supplied V1 logs, 2026-09-29).
const V1_RPM_TX = '40 79 17 00 00 B9 FF E0 07 00 00 E8 07 00 00 C8 00 C8 00 04 00 02 00 02 00 01 0C';
const V1_SPEED_RX = [
  'C0 01 18 00 00 B8 00 E0 07 00 00 E8 07 00 00 C8 00 C8 00 03 00 02 00 03 00 41 0D 00',
  'C0 01 18 00 00 BE 00 E0 07 00 00 E8 07 00 00 C8 00 C8 00 03 00 02 00 03 00 41 0D 00',
];
const V1_PROBE_TX: [number, number, string][] = [
  [0x6a2, 0x494, '33 02 20 00 00 01 02 00 A2 06 00 00 02 10 03 55 55 55 55 55 01 01 FA 00 94 04 00 00 00 00 00 00 00 00 00 00'],
  [0x68b, 0x4d1, '33 02 20 00 00 01 02 00 8B 06 00 00 02 10 03 55 55 55 55 55 01 01 FA 00 D1 04 00 00 00 00 00 00 00 00 00 00'],
  [0x64a, 0x489, '33 02 20 00 00 01 02 00 4A 06 00 00 02 10 03 55 55 55 55 55 01 01 FA 00 89 04 00 00 00 00 00 00 00 00 00 00'],
];

describe('V2 reproduces V1 bytes', () => {
  it('builds the V1 RPM request byte for byte (timeout and delay_after are separate u16 fields)', () => {
    const spec = { ...mode01Spec(0x0c, V1_LIVE_TIMING), requestNr: 0xb9 };
    expect(toHex(encodeRequest(MbitoCmd.EXEC_UDS, encodeExecUdsRequest(spec)))).toBe(V1_RPM_TX);
  });

  it('builds the V1 speed request with exp_len 3', () => {
    expect(mode01Spec(0x0d, V1_LIVE_TIMING)).toMatchObject({ txId: 0x7e0, rxId: 0x7e8, timeoutMs: 200, delayAfterMs: 200, expectedResponseLength: 3 });
  });

  it('decodes both V1 speed replies (request_nr B8, BE) to 0 km/h', () => {
    for (const hex of V1_SPEED_RX) {
      const response = decodeExecUdsResponse(decodeFrame(fromHex(hex)).payload);
      expect(response.header).toMatchObject({ requestType: 0, responseType: 0x00, txId: 0x7e0, rxId: 0x7e8, timeoutMs: 200, delayAfterMs: 200, expectedLength: 3, requestLength: 2, actualLength: 3 });
      expect(decodeMode01(0x0d, response.udsBody)).toBe(0);
    }
  });

  it('builds the three V1 0x33 probe frames byte for byte', () => {
    for (const [tx, rx, hex] of V1_PROBE_TX) expect(toHex(encodeRequest(MbitoCmd.SCAN_PROBE, encodeScanProbe(tx, rx)))).toBe(hex);
  });

  it('builds the exact IC172 0x33 frame (0x60A→0x481), 36 bytes, byte for byte', () => {
    const frame = encodeRequest(MbitoCmd.SCAN_PROBE, encodeScanProbe(0x60a, 0x481));
    expect(frame).toHaveLength(36);
    expect(toHex(frame)).toBe('33 02 20 00 00 01 02 00 0A 06 00 00 02 10 03 55 55 55 55 55 01 01 FA 00 81 04 00 00 00 00 00 00 00 00 00 00');
  });
});

describe('OBD decoding with V1 on-screen values', () => {
  it.each([
    [0x0d, '41 0D 09', 9],
    [0x0c, '41 0C 0B 90', 740],
    [0x05, '41 05 84', 92],
    [0x0f, '41 0F 44', 28],
    [0x0b, '41 0B 23', 35],
  ])('PID %i: %s → %f', (pid, body, value) => {
    expect(decodeMode01(pid, fromHex(body))).toBe(value);
  });

  it('throttle 0x1E → 11.8 %', () => {
    expect(decodeMode01(0x11, fromHex('41 11 1E'))).toBeCloseTo(11.76, 2);
  });

  it('rejects a reply for another PID or too short', () => {
    expect(decodeMode01(0x0d, fromHex('41 0C 0B 90'))).toBeNull();
    expect(decodeMode01(0x0c, fromHex('41 0C 0B'))).toBeNull();
  });

  it('decodes a supported-PID bitmap MSB first', () => {
    const pids = decodeSupportedPids(0x00, fromHex('41 00 BE 3F A8 13'));
    expect(pids).toEqual(expect.arrayContaining([0x01, 0x05, 0x0b, 0x0c, 0x0d, 0x0f, 0x11, 0x20]));
    expect(pids).not.toContain(0x02);
    expect(decodeSupportedPids(0x00, fromHex('41 20 BE 3F A8 13'))).toEqual([]);
  });
});

describe('0x33 probe replies captured on this car', () => {
  it('SCCM166 accepted the extended session (50 03)', () => {
    const reply = decodeScanProbe(decodeFrame(fromHex('B3 02 20 00 00 01 02 00 22 06 00 00 02 10 03 55 55 55 55 55 01 01 FA 00 84 04 00 00 06 50 03 00 14 00 C8 32')).payload);
    expect(reply).toMatchObject({ txId: 0x622, rxId: 0x484, positive: true });
    expect(toHex(reply.response)).toBe('50 03 00 14 00 C8');
  });

  it('a zero-filled reply means nothing answered', () => {
    const reply = decodeScanProbe(decodeFrame(fromHex('B3 02 20 00 00 01 02 00 8F 07 00 00 02 10 03 55 55 55 55 55 01 01 FA 00 97 07 00 00 00 00 00 00 00 00 00 00')).payload);
    expect(reply).toMatchObject({ positive: false, negative: false, absent: true });
    expect(reply.response).toHaveLength(0);
  });

  it('decodes the REAL official B3 responses (2026-09-30 capture): present pairs → 50 03, absent → zero slot', () => {
    // Present: B3 02 20 00 … slot 06 50 03 00 14 00 C8 xx  (trailing byte is a counter, ignored)
    const present: [number, number, string][] = [
      [0x60a, 0x481, 'B3 02 20 00 00 01 02 00 0A 06 00 00 02 10 03 55 55 55 55 55 01 01 FA 00 81 04 00 00 06 50 03 00 14 00 C8 01'],
      [0x60b, 0x58b, 'B3 02 20 00 00 01 02 00 0B 06 00 00 02 10 03 55 55 55 55 55 01 01 FA 00 8B 05 00 00 06 50 03 00 14 00 C8 AA'],
      [0x612, 0x482, 'B3 02 20 00 00 01 02 00 12 06 00 00 02 10 03 55 55 55 55 55 01 01 FA 00 82 04 00 00 06 50 03 00 14 00 C8 33'],
      [0x6f3, 0x4de, 'B3 02 20 00 00 01 02 00 F3 06 00 00 02 10 03 55 55 55 55 55 01 01 FA 00 DE 04 00 00 06 50 03 00 14 00 C8 30'],
    ];
    for (const [tx, rx, hex] of present) {
      const reply = decodeScanProbe(decodeFrame(fromHex(hex)).payload);
      expect(reply, hex).toMatchObject({ txId: tx, rxId: rx, positive: true, absent: false });
      expect(toHex(reply.response)).toBe('50 03 00 14 00 C8');
    }
    // Absent (0x74F → 0x757): final 8-byte slot is all zero
    const absent = decodeScanProbe(decodeFrame(fromHex('B3 02 20 00 00 01 02 00 4F 07 00 00 02 10 03 55 55 55 55 55 01 01 FA 00 57 07 00 00 00 00 00 00 00 00 00 00')).payload);
    expect(absent).toMatchObject({ txId: 0x74f, rxId: 0x757, positive: false, absent: true });
    expect(absent.response).toHaveLength(0);
  });

  it('V2 TX payload is byte-identical to the official probe the dongle echoed back', () => {
    const echoed = decodeFrame(fromHex('B3 02 20 00 00 01 02 00 8F 07 00 00 02 10 03 55 55 55 55 55 01 01 FA 00 97 07 00 00 00 00 00 00 00 00 00 00')).payload;
    expect(toHex(encodeScanProbe(0x78f, 0x797))).toBe(toHex(echoed));
  });

  it('outcomes: any non-zero slot confirms (50 03 accepted, 7F 10 rejected, other), zero slot = no response this pass, no B3 = host timeout', async () => {
    const reply = (frame: number[]) => (tx: Bytes) => {
      const echo = tx.slice(4);
      echo.set(frame, 24);
      return fromHex(`B3 02 20 00 ${toHex(echo)}`);
    };
    const run = async (respond?: (tx: Bytes) => Bytes) => {
      const transport = new FakeTransport();
      if (respond) transport.respond = tx => transport.emit(respond(tx));
      return probeEcu(new MbitoClient(transport), 0x622, 0x484);
    };
    expect(await run(reply([0x06, 0x50, 0x03, 0x00, 0x14, 0x00, 0xc8, 0x32]))).toMatchObject({ outcome: 'SESSION_ACCEPTED', present: true });
    expect(await run(reply([0, 0, 0, 0, 0, 0, 0, 0]))).toMatchObject({ outcome: 'NO_RESPONSE', present: false });
    expect(await run(reply([0x03, 0x7f, 0x10, 0x12]))).toMatchObject({ outcome: 'SESSION_REJECTED', present: true });
    expect(await run(reply([0x02, 0x51, 0x01]))).toMatchObject({ outcome: 'OTHER_RESPONSE', present: true });
    const started = performance.now();
    expect(await run()).toMatchObject({ outcome: 'HOST_TIMEOUT', present: false, reply: null });
    expect(performance.now() - started).toBeGreaterThanOrEqual(990);
  });

  it('probeEcu sends the V1 frame and reports presence', async () => {
    const transport = new FakeTransport();
    transport.respond = tx => {
      const echo = tx.slice(4);
      echo.set([0x06, 0x50, 0x03, 0x00, 0x14, 0x00, 0xc8], 24);
      transport.emit(fromHex(`B3 02 20 00 ${toHex(echo)}`));
    };
    const result = await probeEcu(new MbitoClient(transport), 0x703, 0x4e0);
    expect(result.present).toBe(true);
    expect(toHex(transport.written[0] ?? new Uint8Array()).startsWith('33 02 20 00 00 01 02 00 03 07 00 00 02 10 03')).toBe(true);
  });
});

describe('V1 connect-time preflight', () => {
  function carThatAnswers(): FakeTransport {
    const transport = new FakeTransport();
    const replies: Record<string, string> = {
      '01 0D': '41 0D 00', '01 0C': '41 0C 0B 90', '01 00': '41 00 BE 3F A8 13', '01 20': '41 20 80 00 00 00',
    };
    transport.respond = (tx: Bytes) => {
      if (tx[0] === 0x11) return transport.emit(fromHex('91 05 00 00'));
      const body = toHex(tx.subarray(25));
      transport.emit(dongleReply(tx, 0x00, replies[body] ?? ''));
    };
    return transport;
  }

  it('runs GET_CAN_BAUD, 01 0D, 01 0C, then PID discovery — in V1 order with V1 timing', async () => {
    const transport = carThatAnswers();
    const result = await runV1Preflight(new MbitoClient(transport));
    const sent = transport.written.map(b => toHex(b));
    expect(sent[0]).toBe('11 79 00 00');
    expect(sent.slice(1).map(s => s.slice(-5))).toEqual(['01 0D', '01 0C', '01 00', '01 20']);
    expect(sent[1]).toContain('E8 03 E8 03 03 00 02 00 02 00'); // 1000 / 1000 / exp 3
    expect(result).toMatchObject({ speedOk: true, rpmOk: true, canBaud: { arg: 0x05 } });
    expect(result.rpm.value).toBe(740);
    expect(result.supportedPids).toEqual(expect.arrayContaining([0x0d, 0x0c, 0x21]));
  });

  it('skips discovery when neither speed nor rpm answers (V1 rule)', async () => {
    const transport = new FakeTransport();
    transport.respond = tx => (tx[0] === 0x11 ? transport.emit(fromHex('91 05 00 00')) : transport.emit(dongleReply(tx, 0xfd, '')));
    const result = await runV1Preflight(new MbitoClient(transport));
    expect(transport.written).toHaveLength(3);
    expect(result).toMatchObject({ speedOk: false, rpmOk: false, supportedPids: [] });
  });
});

describe('boost', () => {
  it('is MAP − BARO, signed, and refuses an implausible BARO', async () => {
    const { boostKpa } = await import('./pids');
    expect(boostKpa(35, 98)).toBe(-63);
    expect(boostKpa(180, 98)).toBe(82);
    expect(boostKpa(180, 0)).toBeNull();
    expect(boostKpa(180, null)).toBeNull();
  });
});
