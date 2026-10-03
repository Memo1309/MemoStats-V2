import { describe, expect, it } from 'vitest';
import { nn } from '../testing/nn';
import { fromHex, toHex } from '../core/bytes';
import { MbitoClient } from '../core/mbito/mbitoClient';
import { FakeTransport } from '../testing/fakeDongle';
import type { CodingFeatureModel } from './codingModel';
import { CodingError, type CodingTarget, buildProposal, commitWrite, decode, enterExtendedSession, readCodingBlock } from './codingEngine';

const IC172: CodingTarget = { ecuId: 901, ecuName: 'IC172', variantId: 11497, variantName: 'IC_MFA_AeJ17', txId: 0x60a, rxId: 0x481, hardwareNumber: '2469011497', softwareNumber: null };

// Temperature units: section 14, read 220200 / write 2E0200, coding length 6, bit 0 length 1 (0 °C, 1 °F).
const TEMP: CodingFeatureModel = {
  featureId: 366, name: 'Temperature units', description: '', featureType: 'single',
  section: { id: 14, codingLength: 6, readHex: '220200', writeHex: '2E0200', accessLevel: 0, dllName: null, seedLength: null, keyLength: null },
  readField: { bitPosition: 0, bitLength: 1 },
  options: [
    { optionId: 44, valueMeaning: '°C', isCustom: false, patches: [{ bitPosition: 0, bitLength: 1, value: 0 }] },
    { optionId: 45, valueMeaning: '°F', isCustom: false, patches: [{ bitPosition: 0, bitLength: 1, value: 1 }] },
  ],
};
const SECURED: CodingFeatureModel = { ...TEMP, section: { ...TEMP.section, accessLevel: 11, dllName: 'MED40_MED40_12_17_00.dll' } };

/** A fake ECU holding a mutable 6-byte coding block; answers 22 02 00 reads and 2E 02 00 writes. */
function ecuHoldingBlock(initial: string, opts: { acceptWrite?: boolean; readbackHex?: string } = {}) {
  const transport = new FakeTransport();
  let block = fromHex(initial);
  transport.respond = tx => {
    const service = tx[25];
    const did = toHex(tx.subarray(26, 28)).replace(' ', '');
    if (service === 0x10) transport.emit(reply(tx, '50 03'));
    else if (service === 0x22) transport.emit(reply(tx, `62 ${did.slice(0, 2)} ${did.slice(2)} ${toHex(opts.readbackHex ? fromHex(opts.readbackHex) : block)}`));
    else if (service === 0x2e) {
      if (opts.acceptWrite !== false) block = new Uint8Array(tx.slice(28));
      transport.emit(reply(tx, `6E ${did.slice(0, 2)} ${did.slice(2)}`));
    }
  };
  return { client: new MbitoClient(transport), transport, get: () => toHex(block) };
}

/** Build a positive C0 reply carrying `bodyHex`, echoing the request header. */
function reply(tx: Uint8Array, bodyHex: string): Uint8Array<ArrayBuffer> {
  const header = tx.slice(4, 25);
  const body = fromHex(bodyHex);
  header[2] = 0x00; // OK
  new DataView(header.buffer).setUint16(19, body.length, true);
  const len = 21 + body.length;
  return fromHex(`C0 01 ${(len & 0xff).toString(16).padStart(2, '0')} ${(len >> 8).toString(16).padStart(2, '0')} ${toHex(header)} ${bodyHex}`);
}

describe('coding engine — read / decode / proposal', () => {
  it('reads the exact coding block and rejects a wrong length', async () => {
    const { client } = ecuHoldingBlock('00 00 00 00 00 00');
    expect(toHex(await readCodingBlock(client, IC172, TEMP.section))).toBe('00 00 00 00 00 00');
    const short = ecuHoldingBlock('00 00 00 00 00'); // 5 bytes, not 6
    await expect(readCodingBlock(short.client, IC172, TEMP.section)).rejects.toBeInstanceOf(CodingError);
  });

  it('decodes the current option and builds a proposal touching only the target bit', async () => {
    const { client } = ecuHoldingBlock('00 00 00 00 00 00');
    const block = await readCodingBlock(client, IC172, TEMP.section);
    expect(decode(block, TEMP)).toMatchObject({ currentValue: 0, currentMeaning: '°C' });
    const proposal = buildProposal(block, nn(TEMP.options[1])); // °F
    expect(toHex(proposal.after)).toBe('80 00 00 00 00 00');
    expect(proposal.changedBytes).toEqual([0]);
  });
});

describe('coding engine — session preflight', () => {
  it('accepts extended diagnostic session only after 50 03', async () => {
    const ecu = ecuHoldingBlock('00 00 00 00 00 00');
    await expect(enterExtendedSession(ecu.client, IC172)).resolves.toBeUndefined();
  });

  it('rejects a non-positive 10 03 response', async () => {
    const transport = new FakeTransport();
    transport.respond = tx => transport.emit(reply(tx, '7F 10 22'));
    const client = new MbitoClient(transport);
    await expect(enterExtendedSession(client, IC172)).rejects.toBeInstanceOf(CodingError);
  });
});

describe('coding engine — access-0 write with read-back verification', () => {
  it('writes, reads back, and marks SUCCESS only after the read-back matches', async () => {
    const ecu = ecuHoldingBlock('00 00 00 00 00 00');
    const block = await readCodingBlock(ecu.client, IC172, TEMP.section);
    const proposal = buildProposal(block, nn(TEMP.options[1]));
    const result = await commitWrite(ecu.client, IC172, TEMP, proposal);
    expect(result.status).toBe('VERIFIED');
    expect(ecu.get()).toBe('80 00 00 00 00 00');
    expect(result.backup).toMatchObject({ status: 'VERIFIED', originalBytes: '00 00 00 00 00 00', proposedBytes: '80 00 00 00 00 00', verifiedBytes: '80 00 00 00 00 00' });
  });

  it('FAILS (never SUCCESS) when the ECU accepts 2E but the read-back differs', async () => {
    const ecu = ecuHoldingBlock('00 00 00 00 00 00', { acceptWrite: false });
    const block = await readCodingBlock(ecu.client, IC172, TEMP.section);
    const result = await commitWrite(ecu.client, IC172, TEMP, buildProposal(block, nn(TEMP.options[1])));
    expect(result.status).toBe('FAILED');
    expect(result.message).toMatch(/recitire/);
  });

  it('refuses to write a SecurityAccess-gated feature (access level 11) — SECURITY_REQUIRED', async () => {
    const ecu = ecuHoldingBlock('00 00 00 00 00 00');
    const block = await readCodingBlock(ecu.client, IC172, SECURED.section);
    await expect(commitWrite(ecu.client, IC172, SECURED, buildProposal(block, nn(SECURED.options[1])))).rejects.toBeInstanceOf(CodingError);
  });

  it('refuses a no-op write (value already set)', async () => {
    const ecu = ecuHoldingBlock('80 00 00 00 00 00'); // already °F
    const block = await readCodingBlock(ecu.client, IC172, TEMP.section);
    await expect(commitWrite(ecu.client, IC172, TEMP, buildProposal(block, nn(TEMP.options[1])))).rejects.toThrow(/Nicio modificare/);
  });
});
