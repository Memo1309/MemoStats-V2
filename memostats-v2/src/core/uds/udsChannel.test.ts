import { afterEach, describe, expect, it, vi } from 'vitest';
import { fromHex, toHex } from '../bytes';
import { FakeTransport, dongleReply } from '../../testing/fakeDongle';
import { MbitoClient } from '../mbito/mbitoClient';
import { runMed40IdentificationTest } from '../../vehicle/identification/med40Test';
import { type UdsRequestSpec, execUds } from './udsChannel';

const CBC: UdsRequestSpec = { txId: 0x6f3, rxId: 0x4de, body: fromHex('22 F1 00'), timeoutMs: 600, delayAfterMs: 0, expectedResponseLength: 7 };

function setup() {
  const transport = new FakeTransport();
  return { transport, client: new MbitoClient(transport) };
}

afterEach(() => {
  vi.useRealTimers();
});

describe('execUds over a fake dongle', () => {
  it('MED40 test: sends the exact frame and identifies VC11_A from a positive reply', async () => {
    const { transport, client } = setup();
    transport.respond = tx => transport.emit(dongleReply(tx, 0x00, '62 F1 00 02 28 57 03'));
    const result = await runMed40IdentificationTest(client);

    const tx = transport.written[0] ?? new Uint8Array();
    expect(toHex(tx.subarray(0, 4))).toBe('40 79 18 00');
    expect(toHex(tx.subarray(6))).toBe('FF E0 07 00 00 E8 07 00 00 58 02 00 00 07 00 03 00 03 00 22 F1 00');
    expect(tx[5]).toBe(result.requestNr);
    expect(result).toMatchObject({ semantic: 'POSITIVE_RESPONSE', presence: 'PRESENT', transport: 'OK', opCode: '022857', opCodeMatchesCatalog: true, requestNrEchoed: true });
    expect(result.latencyMs).toBeGreaterThanOrEqual(0);
  });

  it('valid body + raw 0xFE stays a positive, present response', async () => {
    const { transport, client } = setup();
    transport.respond = tx => transport.emit(dongleReply(tx, 0xfe, '62 F1 00 02 E6 08 01'));
    const result = await execUds(client, CBC);
    expect(result).toMatchObject({ semantic: 'POSITIVE_RESPONSE', presence: 'PRESENT', transport: 'PARTIAL_TIMEOUT' });
  });

  it('negative response = present with NRC', async () => {
    const { transport, client } = setup();
    transport.respond = tx => transport.emit(dongleReply(tx, 0xff, '7F 22 31'));
    const result = await execUds(client, CBC);
    expect(result).toMatchObject({ semantic: 'NEGATIVE_RESPONSE', nrc: 0x31, presence: 'PRESENT', transport: 'NEGATIVE_RESPONSE' });
  });

  it('0xFD with no body = full timeout, presence not confirmed', async () => {
    const { transport, client } = setup();
    transport.respond = tx => transport.emit(dongleReply(tx, 0xfd, ''));
    const result = await execUds(client, CBC);
    expect(result).toMatchObject({ semantic: 'NO_RESPONSE', presence: 'NOT_CONFIRMED', transport: 'FULL_TIMEOUT' });
  });

  it('reassembles a reply split across BLE notifications', async () => {
    const { transport, client } = setup();
    transport.respond = tx => {
      const reply = dongleReply(tx, 0x00, '62 F1 00 02 28 57 03');
      transport.emit(reply.slice(0, 10));
      transport.emit(reply.slice(10));
    };
    expect((await execUds(client, CBC)).semantic).toBe('POSITIVE_RESPONSE');
  });

  it('ignores a reply for another ECU address', async () => {
    const { transport, client } = setup();
    transport.respond = tx => {
      transport.emit(dongleReply(tx, 0x00, '62 F1 00 00 05 08 03', { txId: 0x622 }));
      transport.emit(dongleReply(tx, 0x00, '62 F1 00 02 E6 08 01'));
    };
    const result = await execUds(client, CBC);
    expect(result.frames.map(f => f.decision)).toEqual([expect.stringMatching(/^ignore/), 'done']);
    expect(toHex(result.final?.udsBody ?? new Uint8Array())).toBe('62 F1 00 02 E6 08 01');
  });

  it('keeps waiting through NRC 0x78 and returns the final answer', async () => {
    const { transport, client } = setup();
    transport.respond = tx => {
      transport.emit(dongleReply(tx, 0xff, '7F 22 78'));
      setTimeout(() => transport.emit(dongleReply(tx, 0x00, '62 F1 00 02 E6 08 01')), 5);
    };
    const result = await execUds(client, CBC);
    expect(result.semantic).toBe('POSITIVE_RESPONSE');
    expect(result.frames).toHaveLength(2);
  });

  it('NRC 0x78 without a final answer is PENDING, never NO RESPONSE', async () => {
    vi.useFakeTimers();
    const { transport, client } = setup();
    transport.respond = tx => transport.emit(dongleReply(tx, 0xff, '7F 22 78'));
    const pending = execUds(client, CBC);
    await vi.advanceTimersByTimeAsync(10_000);
    const result = await pending;
    expect(result).toMatchObject({ semantic: 'RESPONSE_PENDING', presence: 'PRESENT', nrc: 0x78, transport: 'HOST_TIMEOUT' });
  });

  it('NRC 0x78 then a dongle 0xFD timeout stays RESPONSE_PENDING with the FULL_TIMEOUT transport', async () => {
    const { transport, client } = setup();
    transport.respond = tx => {
      transport.emit(dongleReply(tx, 0xff, '7F 22 78'));
      setTimeout(() => transport.emit(dongleReply(tx, 0xfd, '')), 5);
    };
    const result = await execUds(client, CBC);
    expect(result).toMatchObject({ semantic: 'RESPONSE_PENDING', presence: 'PRESENT', nrc: 0x78, transport: 'FULL_TIMEOUT' });
    expect(result.frames).toHaveLength(2);
  });

  it('7F 22 78 carried by a 0xFD frame ends at once as RESPONSE_PENDING + FULL_TIMEOUT (dongle stopped waiting)', async () => {
    const { transport, client } = setup();
    transport.respond = tx => transport.emit(dongleReply(tx, 0xfd, '7F 22 78'));
    const started = performance.now();
    const result = await execUds(client, CBC);
    expect(result).toMatchObject({ semantic: 'RESPONSE_PENDING', presence: 'PRESENT', nrc: 0x78, transport: 'FULL_TIMEOUT' });
    expect(result.frames).toHaveLength(1);
    expect(performance.now() - started).toBeLessThan(500);
  });

  it('CBCBOLERO F100 on record (0xFE + 62 F1 00 02 E6 08 01) is a positive answer', async () => {
    const { transport, client } = setup();
    transport.respond = tx => transport.emit(dongleReply(tx, 0xfe, '62 F1 00 02 E6 08 01'));
    expect(await execUds(client, CBC)).toMatchObject({ semantic: 'POSITIVE_RESPONSE', presence: 'PRESENT', transport: 'PARTIAL_TIMEOUT' });
  });

  it('official F18C reply (0xFE + complete 62 body, capture-20260917-222558) is a positive answer', async () => {
    const { transport, client } = setup();
    transport.respond = () => transport.emit(fromHex('C0 01 29 00 00 00 FE 8A 07 00 00 B1 04 00 00 58 02 00 00 06 00 03 00 14 00 62 F1 8C 33 30 34 30 30 37 33 31 37 31 35 37 30 34 34 33 32'));
    const result = await execUds(client, { txId: 0x78a, rxId: 0x4b1, body: fromHex('22 F1 8C'), timeoutMs: 600, delayAfterMs: 0, expectedResponseLength: 6, requestNr: 0 });
    expect(result).toMatchObject({ semantic: 'POSITIVE_RESPONSE', presence: 'PRESENT', transport: 'PARTIAL_TIMEOUT', requestNrEchoed: true });
  });

  it('no frame at all ends as NO_RX after the browser deadline', async () => {
    vi.useFakeTimers();
    const { client } = setup();
    const pending = execUds(client, CBC);
    await vi.advanceTimersByTimeAsync(CBC.timeoutMs + 2000);
    const result = await pending;
    expect(result).toMatchObject({ semantic: 'NO_RESPONSE', transport: 'NO_RX', presence: 'NOT_CONFIRMED', latencyMs: null, requestNrEchoed: null });
  });

  it('rejects a late reply carrying another request_nr and accepts the matching one', async () => {
    const { transport, client } = setup();
    transport.respond = tx => {
      transport.emit(dongleReply(tx, 0xfd, '', { requestNr: (tx[5] ?? 0) ^ 0x80 }));
      transport.emit(dongleReply(tx, 0x00, '62 F1 00 02 E6 08 01'));
    };
    const result = await execUds(client, CBC);
    expect(result.frames.map(f => f.decision)).toEqual([expect.stringMatching(/stale request_nr/), 'done']);
    expect(result).toMatchObject({ semantic: 'POSITIVE_RESPONSE', requestNrEchoed: true });
  });

  it('a BLE drop mid-request rejects instead of pretending a result', async () => {
    const { transport, client } = setup();
    transport.respond = () => transport.drop();
    await expect(execUds(client, CBC)).rejects.toThrow(/BLE/);
  });

  it('sends an exact request_nr when the spec pins one (official replay uses 0)', async () => {
    const { transport, client } = setup();
    // answer after the write acknowledgement, as a real dongle normally does
    transport.respond = tx => setTimeout(() => transport.emit(dongleReply(tx, 0x00, '62 F1 00 02 E6 08 01')), 1);
    const result = await execUds(client, { ...CBC, requestNr: 0 });
    expect(transport.written[0]?.[5]).toBe(0);
    expect(result).toMatchObject({ requestNr: 0, requestNrEchoed: true });
    expect(result.writtenAt).toBeGreaterThanOrEqual(result.sentAt);
  });

  it('refuses a second exchange while one is in flight', async () => {
    const { client } = setup();
    const first = execUds(client, CBC);
    await expect(execUds(client, CBC)).rejects.toThrow(/in flight/);
    first.catch(() => undefined);
  });
});
