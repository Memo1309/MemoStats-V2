import { describe, expect, it } from 'vitest';
import { nn } from '../testing/nn';
import rawDb from '../../public/data/w176/memostats-w176-ecu-db-2026-09-29.json';
import { fromHex, toHex } from '../core/bytes';
import { MbitoClient } from '../core/mbito/mbitoClient';
import { FakeTransport } from '../testing/fakeDongle';
import type { W176Db } from '../w176/types';
import { executeWorkflow, resolveWorkflow } from './multiFeature';

const db = rawDb as unknown as W176Db;

/** Fake holding a coding block per TX id; answers static (10 03 / 11 01), reads and writes. */
function multiEcuFake(lengthByTx: Record<number, number>, failWritesForTx?: number) {
  const transport = new FakeTransport();
  const blocks = new Map<number, Uint8Array>();
  for (const [tx, len] of Object.entries(lengthByTx)) blocks.set(Number(tx), new Uint8Array(len));
  transport.respond = tx => {
    const dv = new DataView(tx.buffer, tx.byteOffset, tx.byteLength);
    const txId = dv.getUint32(7, true);
    const service = tx[25];
    const uds = tx.subarray(25);
    if (service === 0x22) {
      const block = blocks.get(txId) ?? new Uint8Array(0);
      transport.emit(reply(tx, `62 ${toHex(uds.subarray(1, 3))} ${toHex(block)}`));
    } else if (service === 0x2e) {
      if (txId !== failWritesForTx) blocks.set(txId, new Uint8Array(tx.subarray(28)));
      transport.emit(reply(tx, `6E ${toHex(uds.subarray(1, 3))}`));
    } else {
      // static session/reset (10 03 -> 50 03, 11 01 -> 51 01)
      transport.emit(reply(tx, `${((service ?? 0) + 0x40).toString(16)} ${toHex(uds.subarray(1))}`));
    }
  };
  return { client: new MbitoClient(transport), blocks };
}

function reply(tx: Uint8Array, bodyHex: string): Uint8Array<ArrayBuffer> {
  const header = tx.slice(4, 25);
  const body = fromHex(bodyHex);
  header[2] = 0x00;
  new DataView(header.buffer).setUint16(19, body.length, true);
  const len = 21 + body.length;
  return fromHex(`C0 01 ${(len & 0xff).toString(16).padStart(2, '0')} ${(len >> 8).toString(16).padStart(2, '0')} ${toHex(header)} ${bodyHex}`);
}

describe('Blue Welcome Light multi-feature workflow (452)', () => {
  it('resolves in exact JSON order: static 10 03, koding 448, static 11 01 (FL) then the same for FR (449)', () => {
    const wf = resolveWorkflow(db, 452, '330');
    expect(wf?.optionMeaning).toBe('Standard');
    expect(wf?.writable).toBe(true);
    expect(wf?.steps.map(s => [s.order, s.kind, s.target.ecuName, s.kind === 'koding' ? s.feature.featureId : (s.step.type === 'static' ? s.step.static_function.payload_to_get : '')]))
      .toEqual([
        [0, 'static', 'HLI_FL176', '1003'],
        [1, 'koding', 'HLI_FL176', 448],
        [2, 'static', 'HLI_FL176', '1101'],
        [3, 'static', 'HLI_FR176', '1003'],
        [4, 'koding', 'HLI_FR176', 449],
        [5, 'static', 'HLI_FR176', '1101'],
      ]);
  });

  it('executes both ECUs in order and reports SUCCESS when both verify', async () => {
    const wf = nn(resolveWorkflow(db, 452, '330'));
    const lengths = Object.fromEntries(wf.steps.filter(s => s.kind === 'koding').map(s => [s.target.txId, (s as { feature: { section: { codingLength: number } } }).feature.section.codingLength]));
    const fake = multiEcuFake(lengths);
    const seen: number[] = [];
    const result = await executeWorkflow(fake.client, wf, r => seen.push(r.order));
    expect(seen).toEqual([0, 1, 2, 3, 4, 5]); // strict order, nothing reordered
    expect(result.status).toBe('SUCCESS');
    expect(result.verifiedEcus.sort()).toEqual(['HLI_FL176', 'HLI_FR176']);
  });

  it('reports PARTIAL SUCCESS (never hidden) when the second ECU fails read-back', async () => {
    const wf = nn(resolveWorkflow(db, 452, '332')); // a different duration option
    const kodingSteps = wf.steps.filter(s => s.kind === 'koding') as { target: { txId: number }; feature: { section: { codingLength: number } } }[];
    const lengths = Object.fromEntries(kodingSteps.map(s => [s.target.txId, s.feature.section.codingLength]));
    const secondTx = nn(kodingSteps[1]).target.txId;
    const fake = multiEcuFake(lengths, secondTx); // FR writes silently dropped -> read-back mismatch
    const result = await executeWorkflow(fake.client, wf, () => {});
    expect(result.status).toBe('PARTIAL');
    expect(result.verifiedEcus).toEqual(['HLI_FL176']);
    expect(result.unverifiedEcus).toEqual(['HLI_FR176']);
  });
});
