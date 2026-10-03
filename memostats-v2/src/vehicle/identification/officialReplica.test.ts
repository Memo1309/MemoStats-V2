import { describe, expect, it } from 'vitest';
import { fromHex, toHex } from '../../core/bytes';
import { MbitoClient } from '../../core/mbito/mbitoClient';
import { FakeTransport } from '../../testing/fakeDongle';
import { SCCM166_F100_REPLICA, replicaFromCapture, runOfficialReplicaTest } from './officialReplica';

// The official SCCM166 F100 response captured on this car (capture-20260917-222558).
const CAPTURED = 'C0 01 1C 00 00 00 00 22 06 00 00 84 04 00 00 C8 00 00 00 07 00 03 00 07 00 62 F1 00 00 05 08 03';

describe('official SCCM166 F100 replica', () => {
  const replica = SCCM166_F100_REPLICA;

  it('copies every EXEC_UDS field from the captured frame', () => {
    expect(replica.spec).toMatchObject({ txId: 0x622, rxId: 0x484, requestNr: 0, timeoutMs: 200, delayAfterMs: 0, expectedResponseLength: 7 });
    expect(toHex(replica.spec.body)).toBe('22 F1 00');
    expect(toHex(replica.capturedRx)).toBe(CAPTURED);
    expect(replica.catalogOpCode).toBe('000508');
  });

  it('writes exactly this BLE packet', () => {
    expect(toHex(replica.txPreview)).toBe('40 79 18 00 00 00 FF 22 06 00 00 84 04 00 00 C8 00 00 00 07 00 03 00 03 00 22 F1 00');
  });

  it('differs from the captured header only where the dongle overwrites it (resp_status, payload_len)', () => {
    const sent = replica.txPreview.subarray(4, 25);
    const echoed = fromHex(CAPTURED).subarray(4, 25);
    const differing = [...sent.keys()].filter(i => sent[i] !== echoed[i]);
    expect(differing).toEqual([2, 19]);
  });

  it('reports a byte-identical answer and the catalog op code when the car answers like it did for the official app', async () => {
    const transport = new FakeTransport();
    transport.respond = () => transport.emit(fromHex(CAPTURED));
    const result = await runOfficialReplicaTest(new MbitoClient(transport));
    expect(toHex(transport.written[0] ?? new Uint8Array())).toBe(toHex(replica.txPreview));
    expect(result).toMatchObject({
      semantic: 'POSITIVE_RESPONSE', presence: 'PRESENT', transport: 'OK', requestNrEchoed: true,
      bodyMatchesCapture: true, opCode: '000508', opCodeMatchesCatalog: true,
    });
  });

  it('refuses to build a replica of anything but a ReadDataByIdentifier', () => {
    expect(() => replicaFromCapture('X', CAPTURED.replace('03 00 07 00 62', '02 00 07 00 62'), '10 03')).toThrow();
  });
});
