import { describe, expect, it } from 'vitest';
import { type Bytes, dataView, fromHex } from '../core/bytes';
import { MbitoClient } from '../core/mbito/mbitoClient';
import { DiagnosticScheduler } from '../core/scheduler/diagnosticScheduler';
import { FakeTransport } from '../testing/fakeDongle';
import { SCAN_CANDIDATES, runEcuScan } from './ecuScan';
import { moduleCache } from './moduleCache';
import { scanLogStore } from './scanLog';

/** B3 reply (arg 0x02): probe payload echoed, CAN slot in the last 8 bytes. */
function b3(tx: Bytes, frame: string): Bytes {
  const payload = tx.slice(4, 36);
  const can = fromHex(frame);
  payload[24] = can.length;
  payload.set(can, 25);
  return Uint8Array.of(0xb3, 0x02, payload.length, 0, ...payload);
}
const pick = <T>(v: T | null | undefined): T => { if (v === null || v === undefined) throw new Error("nil"); return v; };

describe('scan protocol log records presence decisions and a summary', () => {
  it('logs every candidate; a 50 03 pair and a negative-UDS (7F 10) pair are both PRESENT', async () => {
    const accepted = pick(SCAN_CANDIDATES[0]);
    const rejected = pick(SCAN_CANDIDATES[1]); // negative UDS -> still present
    const key = (m: { txId: number; rxId: number }) => `${m.txId}/${m.rxId}`;
    const transport = new FakeTransport();
    transport.respond = tx => {
      if (tx[0] !== 0x33) return;
      const view = dataView(tx);
      const pair = `${view.getUint32(8, true)}/${view.getUint32(24, true)}`;
      if (pair === key(accepted)) transport.emit(b3(tx, '50 03 00 14 00 C8'));
      else if (pair === key(rejected)) transport.emit(b3(tx, '7F 10 12'));
      else transport.emit(b3(tx, '')); // zero slot -> absent
    };

    await runEcuScan(new MbitoClient(transport), new DiagnosticScheduler(), false, new AbortController().signal);

    const st = scanLogStore.get();
    expect(st.running).toBe(false);
    expect(st.summary).toBeTruthy();
    // an entry exists for every candidate probe (pass 1) plus the retried absent ones
    expect(st.entries.filter(e => e.kind === 'probe').length).toBeGreaterThanOrEqual(SCAN_CANDIDATES.length);

    const s = pick(st.summary);
    expect(s.candidates).toBe(70);
    expect(s.present).toBe(2);
    expect(s.presentPairs.map(p => `${p.txId}/${p.rxId}`).sort()).toEqual([key(accepted), key(rejected)].sort());

    // the negative-UDS pair is logged as PRESENT with a reason that says the ECU exists
    const rej = pick(st.entries.filter(e => e.txId === rejected.txId && e.rxId === rejected.rxId).at(-1));
    expect(rej.presence).toBe('present');
    expect(rej.reason).toMatch(/negativ|prezent/i);

    // presence is reflected in the module cache (present pairs kept)
    expect(moduleCache.get().modules.map(m => key(m.module)).sort()).toEqual([key(accepted), key(rejected)].sort());
  }, 20_000);
});
