import { describe, expect, it } from 'vitest';
import { fromHex, toHex } from '../bytes';
import { decodeFrame } from '../mbito/frame';
import { MED40_IDENTIFICATION_REQUEST } from '../../vehicle/identification/med40Test';
import { opCodeFromF100 } from '../../vehicle/identification/opCode';
import { SEMANTIC_LABEL } from '../../ui/format';
import { decodeExecUdsResponse, encodeExecUdsRequest, rawTransportStatus } from './execUds';
import { classifyUdsResponse, presenceOf } from './udsSemantics';

// Official MBito app traffic captured passively from the user's W176 by old MemoStats
// (ecuInventory.selfcheck.ts). VERIFIED REAL VEHICLE.
const REAL_SCCM166_F100 = 'C0 01 1C 00 00 00 00 22 06 00 00 84 04 00 00 C8 00 00 00 07 00 03 00 07 00 62 F1 00 00 05 08 03';
const REAL_TPM172_F100 = 'C0 01 1C 00 00 00 00 42 06 00 00 88 04 00 00 C8 00 00 00 07 00 03 00 07 00 62 F1 00 00 30 07 03';
const REAL_PARK117_F18C =
  'C0 01 29 00 00 00 FE 8A 07 00 00 B1 04 00 00 58 02 00 00 06 00 03 00 14 00 62 F1 8C 33 30 34 30 30 37 33 31 37 31 35 37 30 34 34 33 32';

function execUdsPayload(outerHex: string) {
  return decodeExecUdsResponse(decodeFrame(fromHex(outerHex)).payload);
}

/** Header as the dongle echoes it, around a given body. */
function syntheticResponse(txId: number, rxId: number, responseType: number, body: string, requestLength = 3) {
  const inner = encodeExecUdsRequest({ requestNr: 0, txId, rxId, timeoutMs: 600, delayAfterMs: 0, expectedResponseLength: 7, body: new Uint8Array(requestLength) });
  const header = inner.slice(0, 21);
  const bodyBytes = fromHex(body);
  header[2] = responseType;
  new DataView(header.buffer).setUint16(19, bodyBytes.length, true);
  const payload = new Uint8Array(21 + bodyBytes.length);
  payload.set(header);
  payload.set(bodyBytes, 21);
  return payload;
}

describe('EXEC_UDS V2 encoder', () => {
  it('builds the exact MED40 F100 identification frame', () => {
    const inner = encodeExecUdsRequest({ ...MED40_IDENTIFICATION_REQUEST, requestNr: 1 });
    expect(toHex(inner)).toBe('00 01 FF E0 07 00 00 E8 07 00 00 58 02 00 00 07 00 03 00 03 00 22 F1 00');
  });

  it('matches the header layout the official app echoes back', () => {
    // SCCM166 capture: tx 0x622, rx 0x484, timeout 200, delay 0, exp_len 7, cmd_len 3
    const inner = encodeExecUdsRequest({ requestNr: 0, txId: 0x622, rxId: 0x484, timeoutMs: 200, delayAfterMs: 0, expectedResponseLength: 7, body: fromHex('22 F1 00') });
    const echoed = decodeFrame(fromHex(REAL_SCCM166_F100)).payload;
    // identical except resp_status (FF placeholder vs 00 OK) and payload_len (request vs response length)
    expect(toHex(inner.subarray(3, 19))).toBe(toHex(echoed.subarray(3, 19)));
  });
});

describe('EXEC_UDS V2 decoder on real captures', () => {
  it('decodes a real 0x00 OK response with no request echo before the UDS body', () => {
    const response = execUdsPayload(REAL_SCCM166_F100);
    expect(response.header).toMatchObject({ requestType: 0, requestNr: 0, responseType: 0x00, txId: 0x622, rxId: 0x484, timeoutMs: 200, delayAfterMs: 0, expectedLength: 7, requestLength: 3, actualLength: 7 });
    expect(response.transportStatus).toBe('OK');
    expect(toHex(response.udsBody)).toBe('62 F1 00 00 05 08 03');
    expect(opCodeFromF100(response.udsBody)).toBe('000508'); // SCCM166 catalog opCode
    expect(response.warnings).toEqual([]);
  });

  it('identifies TPM_172 from its real F100 reply', () => {
    expect(opCodeFromF100(execUdsPayload(REAL_TPM172_F100).udsBody)).toBe('003007');
  });

  it('treats a real 0xFE PARTIAL_TIMEOUT with a complete body as a positive, present ECU', () => {
    const response = execUdsPayload(REAL_PARK117_F18C);
    expect(response.transportStatus).toBe('PARTIAL_TIMEOUT');
    const { semantic } = classifyUdsResponse(fromHex('22 F1 8C'), response.udsBody);
    expect(semantic).toBe('POSITIVE_RESPONSE');
    expect(presenceOf(semantic)).toBe('PRESENT');
  });

  it('decodes the real FD frame from the first V2 vehicle test (MED40, 2026-09-28)', () => {
    const response = execUdsPayload('C0 01 15 00 00 01 FD E0 07 00 00 E8 07 00 00 58 02 00 00 07 00 03 00 00 00');
    expect(response.header).toMatchObject({ requestNr: 1, txId: 0x7e0, rxId: 0x7e8, timeoutMs: 600, delayAfterMs: 0, expectedLength: 7, requestLength: 3, actualLength: 0 });
    expect(response.transportStatus).toBe('FULL_TIMEOUT');
    expect(response.udsBody).toHaveLength(0);
    expect(classifyUdsResponse(fromHex('22 F1 00'), response.udsBody).semantic).toBe('NO_RESPONSE');
  });

  it('rejects a payload shorter than the 21-byte header', () => {
    expect(() => decodeExecUdsResponse(new Uint8Array(20))).toThrow();
  });

  it('trims bytes beyond payload_len and flags a truncated body', () => {
    const extra = syntheticResponse(0x7e0, 0x7e8, 0x00, '62 F1 00 02 28 57 03');
    const padded = new Uint8Array(extra.length + 2);
    padded.set(extra);
    const trimmed = decodeExecUdsResponse(padded);
    expect(toHex(trimmed.udsBody)).toBe('62 F1 00 02 28 57 03');
    expect(trimmed.warnings).toHaveLength(1);

    new DataView(extra.buffer).setUint16(19, 9, true);
    expect(decodeExecUdsResponse(extra).warnings[0]).toMatch(/truncated/);
  });

  it('keeps raw transport codes distinct from any normalized enum', () => {
    expect([0x00, 0xff, 0xfe, 0xfd, 0x01, 0x02, 0x03].map(rawTransportStatus)).toEqual([
      'OK', 'NEGATIVE_RESPONSE', 'PARTIAL_TIMEOUT', 'FULL_TIMEOUT', 'UNKNOWN', 'UNKNOWN', 'UNKNOWN',
    ]);
  });
});

describe('fixture: CBCBOLERO identification (spec §58)', () => {
  const response = decodeExecUdsResponse(syntheticResponse(0x6f3, 0x4de, 0xfe, '62 F1 00 02 E6 08 01'));
  const { semantic } = classifyUdsResponse(fromHex('22 F1 00'), response.udsBody);

  it('is present, positive, op code 02E608, shown as RĂSPUNDE with PARTIAL_TIMEOUT kept as detail', () => {
    expect(response.header.txId).toBe(0x6f3);
    expect(response.header.rxId).toBe(0x4de);
    expect(response.transportStatus).toBe('PARTIAL_TIMEOUT');
    expect(semantic).toBe('POSITIVE_RESPONSE');
    expect(presenceOf(semantic)).toBe('PRESENT');
    expect(opCodeFromF100(response.udsBody)).toBe('02E608');
    expect(SEMANTIC_LABEL[semantic].text).toBe('RĂSPUNDE');
  });
});

describe('UDS semantics', () => {
  it('fixture §60: 7F 19 78 is ResponsePending, the ECU is present', () => {
    const result = classifyUdsResponse(fromHex('19 02 0D'), fromHex('7F 19 78'));
    expect(result).toEqual({ semantic: 'RESPONSE_PENDING', nrc: 0x78 });
    expect(presenceOf(result.semantic)).toBe('PRESENT');
  });

  it('a negative response still proves the ECU exists', () => {
    const result = classifyUdsResponse(fromHex('22 F1 8C'), fromHex('7F 22 31'));
    expect(result).toEqual({ semantic: 'NEGATIVE_RESPONSE', nrc: 0x31 });
    expect(presenceOf(result.semantic)).toBe('PRESENT');
  });

  it('an empty body is no response and proves nothing', () => {
    expect(classifyUdsResponse(fromHex('22 F1 00'), new Uint8Array())).toEqual({ semantic: 'NO_RESPONSE' });
    expect(presenceOf('NO_RESPONSE')).toBe('NOT_CONFIRMED');
  });

  it('requires the DID echo for ReadDataByIdentifier', () => {
    expect(classifyUdsResponse(fromHex('22 F1 00'), fromHex('62 F1 8C 00')).semantic).toBe('UNEXPECTED_RESPONSE');
    expect(classifyUdsResponse(fromHex('22 F1 00'), fromHex('62 F1 00 02 28 57 03')).semantic).toBe('POSITIVE_RESPONSE');
  });

  it('checks the PID echo for OBD mode 01 and the SID for negatives', () => {
    expect(classifyUdsResponse(fromHex('01 0C'), fromHex('41 0C 1A F8')).semantic).toBe('POSITIVE_RESPONSE');
    expect(classifyUdsResponse(fromHex('01 0C'), fromHex('41 0D 00')).semantic).toBe('UNEXPECTED_RESPONSE');
    expect(classifyUdsResponse(fromHex('22 F1 00'), fromHex('7F 19 31')).semantic).toBe('UNEXPECTED_RESPONSE');
  });
});

describe('F100 op code', () => {
  it('extracts the three op-code bytes from real replies', () => {
    expect(opCodeFromF100(fromHex('62 F1 00 02 28 57 03'))).toBe('022857'); // MED40
    expect(opCodeFromF100(fromHex('62 F1 00 00 04 0C 03'))).toBe('00040C'); // DMFL166
  });

  it('returns null for anything that is not a positive F100 reply', () => {
    expect(opCodeFromF100(fromHex('62 F1 8C 30 30 30'))).toBeNull();
    expect(opCodeFromF100(fromHex('7F 22 31'))).toBeNull();
    expect(opCodeFromF100(fromHex('62 F1 00 02'))).toBeNull();
  });
});
