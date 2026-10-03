import { describe, expect, it } from 'vitest';
import { type Bytes, dataView, fromHex, toHex } from '../core/bytes';
import { MbitoClient } from '../core/mbito/mbitoClient';
import { decodeFrame } from '../core/mbito/frame';
import { decodeScanProbe, encodeScanProbe } from '../core/mbito/scanProbe';
import { DiagnosticScheduler } from '../core/scheduler/diagnosticScheduler';
import { FakeTransport, dongleReply } from '../testing/fakeDongle';
import { VEHICLE_MODULES, type VehicleModule } from '../vehicle/modules';
import { SCAN_CANDIDATES, runEcuScan, scanStore } from './ecuScan';
import { moduleKey } from './inventoryHistory';
import { moduleCache } from './moduleCache';

const key = (m: { txId: number; rxId: number }) => moduleKey(m.txId, m.rxId);
const pick = (m: VehicleModule | undefined): VehicleModule => {
  if (!m) throw new Error('missing test module');
  return m;
};
const candidate = (txId: number, rxId: number) => pick(SCAN_CANDIDATES.find(c => c.txId === txId && c.rxId === rxId));

// New official-MBito passive capture (29.09.2026), as reported: CBCBOLERO 0x6F3→0x4DE answered `06 50 03 …` and
// F100/F18C/F111/F121 positively; SCCM166 0x622→0x484 and TPM_172 0x642→0x488 came back with a zero slot.
// The raw export was not available on this machine, so the frames are rebuilt on the verified layouts:
//  - a zero-slot B3 is the probe payload echoed unchanged (byte-identical on the 17.09 capture) → exact;
//  - CBC B3: bytes after `06 50 03` are a PLACEHOLDER (17.09 shape `00 14 00 C8 xx`);
//  - CBC F100 `62 F1 00 02 E6 08 01` over 0xFE is the value on record; F18C/F111/F121 data are PLACEHOLDERS.
// TODO: replace with the verbatim lines from the capture export.
const NEW_CAPTURE_B3: Record<string, string> = {
  [moduleKey(0x6f3, 0x4de)]: 'B3 02 20 00 00 01 02 00 F3 06 00 00 02 10 03 55 55 55 55 55 01 01 FA 00 DE 04 00 00 06 50 03 00 14 00 C8 00',
  [moduleKey(0x622, 0x484)]: 'B3 02 20 00 00 01 02 00 22 06 00 00 02 10 03 55 55 55 55 55 01 01 FA 00 84 04 00 00 00 00 00 00 00 00 00 00',
  [moduleKey(0x642, 0x488)]: 'B3 02 20 00 00 01 02 00 42 06 00 00 02 10 03 55 55 55 55 55 01 01 FA 00 88 04 00 00 00 00 00 00 00 00 00 00',
};
const NEW_CAPTURE_CBC_IDS: Record<number, string> = {
  0x00: '62 F1 00 02 E6 08 01',
  0x8c: '62 F1 8C 43 42 43 2D 46 31 38 43', // "CBC-F18C" placeholder
  0x11: '62 F1 11 43 42 43 2D 46 31 31 31', // "CBC-F111" placeholder
  0x21: '62 F1 21 43 42 43 2D 46 31 32 31', // "CBC-F121" placeholder
};

/** B3 as the dongle sends it (arg 0x02): the probe payload echoed, CAN frame in the last 8 bytes. */
function probeReply(tx: Bytes, frame: string): Bytes {
  const payload = tx.slice(4, 36);
  const can = fromHex(frame);
  payload[24] = can.length;
  payload.set(can, 25);
  return Uint8Array.of(0xb3, 0x02, payload.length, 0, ...payload);
}

describe('new official capture: B3 slots', () => {
  it('zero-slot B3 for SCCM166 / TPM_172 = the V2 probe echoed, nothing received; CBC slot = 50 03', () => {
    for (const [tx, rx] of [[0x622, 0x484], [0x642, 0x488]] as const) {
      const payload = decodeFrame(fromHex(NEW_CAPTURE_B3[moduleKey(tx, rx)] ?? '')).payload;
      expect(toHex(payload)).toBe(toHex(encodeScanProbe(tx, rx)));
      expect(decodeScanProbe(payload)).toMatchObject({ txId: tx, rxId: rx, absent: true, positive: false });
    }
    expect(decodeScanProbe(decodeFrame(fromHex(NEW_CAPTURE_B3[moduleKey(0x6f3, 0x4de)] ?? '')).payload)).toMatchObject({ txId: 0x6f3, rxId: 0x4de, positive: true, absent: false });
  });
});

describe('ECU scan over all W176 candidates', () => {
  it('has 70 distinct candidates: the 23 vehicle-record modules + 47 catalog endpoints', () => {
    expect(SCAN_CANDIDATES).toHaveLength(70);
    expect(new Set(SCAN_CANDIDATES.map(key)).size).toBe(70);
    for (const m of VEHICLE_MODULES) expect(SCAN_CANDIDATES.map(key)).toContain(key(m));
  });

  it('any non-zero slot confirms, zero slot = FĂRĂ RĂSPUNS, no B3 = EROARE COMUNICAȚIE; one retry pass; identification', async () => {
    const cbc = candidate(0x6f3, 0x4de);
    const sccm = candidate(0x622, 0x484);
    const tpm = candidate(0x642, 0x488);
    const others = SCAN_CANDIDATES.filter(c => ![cbc, sccm, tpm].includes(c));
    const rejected = pick(others[0]); // 7F 10 22: answered, session refused
    const flaky = pick(others[1]); // zero slot in pass 1, 50 03 in the retry
    const lateB3 = pick(others[2]); // no B3 in pass 1, zero slot in the retry
    const noB3 = pick(others[3]); // no B3 in either pass
    const probesOf = new Map<string, number>();

    const transport = new FakeTransport();
    transport.respond = tx => {
      const view = dataView(tx);
      if (tx[0] === 0x33) {
        const probed = moduleKey(view.getUint32(8, true), view.getUint32(24, true));
        const n = (probesOf.get(probed) ?? 0) + 1;
        probesOf.set(probed, n);
        if (probed === key(noB3) || (probed === key(lateB3) && n === 1)) return;
        const captured = NEW_CAPTURE_B3[probed];
        const frame = probed === key(rejected) ? '7F 10 22' : probed === key(flaky) && n === 2 ? '50 03 00 14 00 C8' : '';
        transport.emit(captured ? fromHex(captured) : probeReply(tx, frame));
      } else if (tx[0] === 0x40) {
        const did = tx[27] ?? -1;
        const cbcBody = view.getUint32(7, true) === cbc.txId ? NEW_CAPTURE_CBC_IDS[did] : undefined;
        transport.emit(dongleReply(tx, 0xfe, cbcBody ?? `62 F1 ${toHex(Uint8Array.of(did))} 41 42`));
      }
    };

    await runEcuScan(new MbitoClient(transport), new DiagnosticScheduler(), true, new AbortController().signal);

    const probes = transport.written.filter(w => w[0] === 0x33).map(w => dataView(w).getUint32(8, true));
    const retried = SCAN_CANDIDATES.filter(c => c !== cbc && c !== rejected);
    expect(probes).toEqual([...SCAN_CANDIDATES, ...retried].map(c => c.txId));
    expect(scanStore.get()).toMatchObject({ status: 'done', pass: 2, done: 70 + 68, total: 70 + 68 });

    const result = (m: VehicleModule) => scanStore.get().results.find(r => r.module === m);
    expect(scanStore.get().results).toHaveLength(70);
    expect(result(cbc)).toMatchObject({ status: 'RESPONDS', session: 'ACCEPTED', probeResponse: '50 03 00 14 00 C8' });
    expect(result(rejected)).toMatchObject({ status: 'RESPONDS', session: 'REJECTED', probeResponse: '7F 10 22' });
    expect(result(flaky)).toMatchObject({ status: 'RESPONDS', session: 'ACCEPTED', pass: 2 });
    for (const m of [sccm, tpm, lateB3]) expect(result(m)).toMatchObject({ status: 'NO_ANSWER', session: null, probeResponse: null });
    expect(result(noB3)?.status).toBe('HOST_TIMEOUT');

    // Identification ran for every confirmed module (including the refused session), with the official parameters.
    const reads = transport.written.filter(w => w[0] === 0x40).map(w => `${dataView(w).getUint32(7, true).toString(16)} ${toHex(w.subarray(25))} t${dataView(w).getUint16(15, true)}`);
    const expectedReads = (m: VehicleModule) => ['22 F1 00 t200', '22 F1 8C t600', '22 F1 11 t600', '22 F1 21 t600'].map(r => `${m.txId.toString(16)} ${r}`);
    expect(reads.sort()).toEqual([cbc, rejected, flaky].flatMap(expectedReads).sort());

    const cache = moduleCache.get();
    expect(cache).toMatchObject({ valid: true, scanned: 70 });
    expect(cache.modules.map(m => key(m.module)).sort()).toEqual([cbc, rejected, flaky].map(key).sort());
    expect(cache.modules.find(m => m.module === cbc)).toMatchObject({
      confirmedBy: '0x33', session: 'ACCEPTED', f100: '62 F1 00 02 E6 08 01', opCode: '02E608', variantMatches: true,
      ids: { F18C: { text: 'CBC-F18C' }, F111: { text: 'CBC-F111' }, F121: { text: 'CBC-F121' } },
    });
    expect(cache.modules.find(m => m.module === rejected)?.session).toBe('REJECTED');
    expect(cache.unconfirmed).toHaveLength(67);
    for (const m of [sccm, tpm, lateB3]) expect(cache.unconfirmed.find(u => u.module === m)?.state).toBe('NO_RESPONSE');
    expect(cache.unconfirmed.find(u => u.module === noB3)?.state).toBe('COMM_ERROR');
  }, 15_000);
});
