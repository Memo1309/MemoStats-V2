import { describe, expect, it } from 'vitest';
import { type Bytes, dataView, fromHex } from '../core/bytes';
import { MbitoBleTransport, type RawLink, type RawLinkEvent } from '../core/ble/mbitoBleTransport';
import { FrameAssembler } from '../core/mbito/frame';
import { MbitoClient } from '../core/mbito/mbitoClient';
import { probeEcu } from '../core/mbito/scanProbe';
import { CancelledError, DiagnosticScheduler, Priority } from '../core/scheduler/diagnosticScheduler';
import { SILENT_REASON, isCapturing, startCapture, stopCapture } from '../capture/captureStore';
import { FakeTransport, dongleReply } from '../testing/fakeDongle';
import { SCAN_CANDIDATES, runEcuScan, scanStore } from './ecuScan';
import { moduleKey } from './inventoryHistory';

// Pairs the official MBito app got `06 50 03 …` from on this car (passive capture, 29.09.2026).
const KNOWN_POSITIVE: readonly (readonly [number, number])[] = [
  [0x60a, 0x481], [0x60b, 0x58b], [0x612, 0x482], [0x6f3, 0x4de], [0x703, 0x4e0], [0x732, 0x4a6], [0x6b2, 0x496], [0x70b, 0x4e1], [0x68b, 0x4d1],
];

/** B3 as the dongle sends it (arg 0x02): the probe payload echoed, CAN frame in the last 8 bytes. */
function b3(tx: Bytes, frame = ''): Bytes {
  const payload = tx.slice(4, 36);
  const can = fromHex(frame);
  payload[24] = can.length;
  payload.set(can, 25);
  return Uint8Array.of(0xb3, 0x02, payload.length, 0, ...payload);
}
const pairOf = (tx: Bytes) => moduleKey(dataView(tx).getUint32(8, true), dataView(tx).getUint32(24, true));

/** Delivery modes that must never cost a positive B3. */
type Mode = 'split' | 'garbage-before' | 'stale-partial-before' | 'foreign-c0-before' | 'other-pair-b3-before' | 'late' | 'plain';
const MODES: Mode[] = ['split', 'garbage-before', 'stale-partial-before', 'foreign-c0-before', 'other-pair-b3-before', 'late', 'plain', 'split', 'plain'];

describe('0x33 scan keeps every positive B3 (known-positive pairs from the official capture)', () => {
  it('all 9 pairs are scan candidates', () => {
    const keys = SCAN_CANDIDATES.map(c => moduleKey(c.txId, c.rxId));
    for (const [tx, rx] of KNOWN_POSITIVE) expect(keys).toContain(moduleKey(tx, rx));
  });

  it('confirms all 9 whatever the notification shape or timing; no probe advances before its B3 or the host timeout', async () => {
    const modeOf = new Map(KNOWN_POSITIVE.map(([tx, rx], i) => [moduleKey(tx, rx), MODES[i] ?? 'plain']));
    const writes: { pair: string; at: number }[] = [];
    const transport = new FakeTransport();
    let previousTx: Bytes | null = null;
    transport.respond = tx => {
      if (tx[0] !== 0x33) return;
      const pair = pairOf(tx);
      writes.push({ pair, at: performance.now() });
      const mode = modeOf.get(pair);
      const other = previousTx;
      previousTx = tx;
      // zero-slot candidates answer after ~20 ms like a real dongle, so a late B3 lands during pass 1
      if (!mode) return void setTimeout(() => transport.emit(b3(tx)), 20);
      const positive = b3(tx, '50 03 00 14 00 C8');
      switch (mode) {
        case 'split':
          transport.emit(positive.slice(0, 11));
          setTimeout(() => transport.emit(positive.slice(11)), 2);
          return;
        case 'garbage-before':
          return transport.emit(Uint8Array.of(0x00, 0x11, 0x22, ...positive));
        case 'stale-partial-before':
          transport.emit(fromHex('C0 01 1C 00 00 00')); // truncated C0 declaring 28 B that never completes
          return transport.emit(positive);
        case 'foreign-c0-before':
          transport.emit(fromHex('C0 01 22 00 00 00 FE 42 06 00 00 88 04 00 00 58 02 00 00 06 00 03 00 0D 00 62 F1 11 32 34 36 39 30 31 36 30 30 36'));
          return transport.emit(positive);
        case 'other-pair-b3-before':
          if (other) transport.emit(b3(other));
          return transport.emit(positive);
        case 'late':
          setTimeout(() => transport.emit(positive), 1100); // after this probe's 1000 ms host wait
          return;
        case 'plain':
          return transport.emit(positive);
      }
    };

    await runEcuScan(new MbitoClient(transport), new DiagnosticScheduler(), false, new AbortController().signal);

    const results = scanStore.get().results;
    for (const [tx, rx] of KNOWN_POSITIVE) {
      const result = results.find(r => r.module.txId === tx && r.module.rxId === rx);
      expect(result, moduleKey(tx, rx)).toMatchObject({ status: 'RESPONDS', session: 'ACCEPTED', probeResponse: '50 03 00 14 00 C8' });
    }
    const late = KNOWN_POSITIVE.find((_, i) => MODES[i] === 'late');
    const lateKey = late ? moduleKey(late[0], late[1]) : '';
    expect(results.find(r => moduleKey(r.module.txId, r.module.rxId) === lateKey)).toMatchObject({ lateB3: true });

    // Sequential: every probe waits for its B3 or the host deadline; the late one holds the next probe ~1000 ms.
    const pass1 = writes.slice(0, SCAN_CANDIDATES.length);
    expect(pass1.map(w => w.pair)).toEqual(SCAN_CANDIDATES.map(c => moduleKey(c.txId, c.rxId)));
    const lateIndex = pass1.findIndex(w => w.pair === lateKey);
    expect((pass1[lateIndex + 1]?.at ?? 0) - (pass1[lateIndex]?.at ?? 0)).toBeGreaterThanOrEqual(990);
    // Pass 2 retries only what did not confirm: none of the 9 known positives.
    const retried = new Set(writes.slice(SCAN_CANDIDATES.length).map(w => w.pair));
    for (const [tx, rx] of KNOWN_POSITIVE) expect(retried.has(moduleKey(tx, rx))).toBe(false);
  }, 20_000);

  it('the waiter exists before the BLE write: a B3 delivered during the write itself is matched', async () => {
    class EagerTransport extends FakeTransport {
      override async write(bytes: Bytes): Promise<void> {
        this.written.push(bytes);
        this.emit(b3(bytes, '50 03 00 14 00 C8')); // before write() even returns
        await new Promise(resolve => setTimeout(resolve, 50)); // GATT ack arrives late
      }
    }
    const result = await probeEcu(new MbitoClient(new EagerTransport()), 0x60a, 0x481);
    expect(result).toMatchObject({ outcome: 'SESSION_ACCEPTED', present: true });
  });

  it('one B3 reaches every observer and the waiting probe, even if an observer throws', async () => {
    const transport = new FakeTransport();
    const client = new MbitoClient(transport);
    const observed: number[] = [];
    client.onFrame(() => { throw new Error('broken observer'); });
    client.onFrame(frame => observed.push(frame.rawCommand));
    transport.respond = tx => transport.emit(b3(tx, '50 03 00 14 00 C8'));
    expect((await probeEcu(client, 0x6f3, 0x4de)).present).toBe(true);
    expect(observed).toEqual([0xb3]);
  });

  it('BLE transport: raw tap and every data listener get the same notification, a throwing listener starves nobody', () => {
    const transport = new MbitoBleTransport();
    const raw: RawLinkEvent[] = [];
    const data: Bytes[] = [];
    transport.onRaw(e => raw.push(e));
    transport.onData(() => { throw new Error('broken listener'); });
    transport.onData(chunk => data.push(chunk));
    const notification = fromHex('B3 02 20 00 00 01 02 00 0A 06 00 00 02 10 03 55 55 55 55 55 01 01 FA 00 81 04 00 00 06 50 03 00 14 00 C8 00');
    const handleValue = (transport as unknown as { handleValue(event: Event): void }).handleValue;
    handleValue({ target: { value: new DataView(notification.buffer) } } as unknown as Event);
    expect(raw).toHaveLength(1);
    expect(data).toHaveLength(1);
    expect(data[0]).toEqual(notification);
  });
});

describe('FrameAssembler never sacrifices a whole packet', () => {
  const positive = fromHex('B3 02 20 00 00 01 02 00 0B 06 00 00 02 10 03 55 55 55 55 55 01 01 FA 00 8B 05 00 00 06 50 03 00 14 00 C8 00');

  it('a leftover partial is dropped, not glued to the next notification that is a whole packet', () => {
    const assembler = new FrameAssembler();
    expect(assembler.push(fromHex('C0 01 1C 00 00 00'), 0).frames).toHaveLength(0);
    const { frames, dropped } = assembler.push(positive, 10);
    expect(frames.map(f => f.raw)).toEqual([positive]);
    expect(dropped).toEqual([fromHex('C0 01 1C 00 00 00')]);
  });

  it('garbage in front of a packet costs only the garbage', () => {
    const { frames, dropped } = new FrameAssembler().push(Uint8Array.of(0x00, 0x11, 0x22, ...positive), 0);
    expect(frames.map(f => f.raw)).toEqual([positive]);
    expect(dropped).toEqual([Uint8Array.of(0x00, 0x11, 0x22)]);
  });

  it('a packet split over two notifications is still reassembled', () => {
    const assembler = new FrameAssembler();
    expect(assembler.push(positive.subarray(0, 11), 0).frames).toHaveLength(0);
    expect(assembler.push(positive.subarray(11), 5).frames.map(f => f.raw)).toEqual([positive]);
  });
});

class FakeLink implements RawLink {
  onRaw() {
    return () => undefined;
  }
  blockWrites() {
    return undefined;
  }
}

describe('passive capture is exclusive', () => {
  it('the app scheduler refuses every vehicle job while capturing and runs them again after STOP', async () => {
    const scheduler = new DiagnosticScheduler(() => (isCapturing() ? SILENT_REASON : null));
    let ran = 0;
    const job = () => scheduler.run('SCAN test', Priority.INTERACTIVE, async () => { ran++; });
    startCapture(new FakeLink(), { app: 'test', device: null, firmware: null });
    await expect(job()).rejects.toBeInstanceOf(CancelledError);
    await expect(scheduler.run('LIVE 01 0D', Priority.TELEMETRY, async () => { ran++; })).rejects.toThrow(SILENT_REASON);
    expect(ran).toBe(0);
    stopCapture();
    await job();
    expect(ran).toBe(1);
  });
});

describe('EXEC_UDS frames stay out of 0x33 correlation', () => {
  it('a C0 arriving while a probe waits is ignored by the probe (and still broadcast)', async () => {
    const transport = new FakeTransport();
    const client = new MbitoClient(transport);
    const seen: number[] = [];
    client.onFrame(f => seen.push(f.rawCommand));
    transport.respond = tx => {
      transport.emit(dongleReply(fromHex('40 79 18 00 00 01 FF 22 06 00 00 84 04 00 00 58 02 00 00 06 00 03 00 03 00 22 F1 11'), 0xfe, '62 F1 11 30'));
      transport.emit(b3(tx, '50 03 00 14 00 C8'));
    };
    expect((await probeEcu(client, 0x703, 0x4e0)).outcome).toBe('SESSION_ACCEPTED');
    expect(seen).toEqual([0xc0, 0xb3]);
  });
});
