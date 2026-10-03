import { describe, expect, it } from 'vitest';
import { fromHex } from '../core/bytes';
import { decodeFrame } from '../core/mbito/frame';
import { decodeScanProbe, probeOutcome } from '../core/mbito/scanProbe';
import { decodeExecUdsResponse } from '../core/uds/execUds';
import { classifyUdsResponse, presenceOf } from '../core/uds/udsSemantics';
import { discoveryState } from './moduleCache';

// Presence must follow the diagnostic response, not a unique identity (spec items 7–10). A non-zero
// CAN slot = present; a negative UDS answer still proves the ECU exists; 0xFE with a valid body is
// positive; 0xFD full timeout is not present. Sticky presence across retries: see moduleCache.test.ts.
/** Build a decoded probe reply from the 8-byte CAN slot (ISO-TP length prefix at byte 24, then data). */
const b3 = (slot: number[]) => {
  const payload = new Uint8Array(32);
  payload.set([0x00, 0x01, 0x02, 0x00], 0);
  const dv = new DataView(payload.buffer);
  dv.setUint32(4, 0x622, true);
  dv.setUint32(20, 0x484, true);
  payload.set(slot.slice(0, 8), 24);
  return decodeScanProbe(payload);
};

describe('presence from the 0x33 probe response slot (byte 24 != 0)', () => {
  it('50 03 (session accepted) is PRESENT', () => {
    expect(probeOutcome(b3([0x06, 0x50, 0x03, 0x00, 0x14, 0x00, 0xc8, 0x00]))).toBe('SESSION_ACCEPTED');
    expect(discoveryState('RESPONDS')).toBe('CONFIRMED');
  });

  it('a negative UDS response (7F 10 xx) in the slot still proves the ECU exists — PRESENT', () => {
    expect(probeOutcome(b3([0x03, 0x7f, 0x10, 0x12, 0, 0, 0, 0]))).toBe('SESSION_REJECTED');
    expect(presenceOf(classifyUdsResponse(fromHex('22 F1 00'), fromHex('7F 22 31')).semantic)).toBe('PRESENT');
  });

  it('any other non-zero CAN frame in the slot is PRESENT (identity resolved separately)', () => {
    expect(probeOutcome(b3([0x02, 0x51, 0x01, 0, 0, 0, 0, 0]))).toBe('OTHER_RESPONSE');
  });

  it('an all-zero slot is NO_RESPONSE this pass, not permanent absence', () => {
    expect(probeOutcome(b3([0, 0, 0, 0, 0, 0, 0, 0]))).toBe('NO_RESPONSE');
    expect(discoveryState('NO_ANSWER')).toBe('NO_RESPONSE');
  });
});

describe('EXEC_UDS presence semantics', () => {
  it('0xFE PARTIAL_TIMEOUT carrying a valid 62… body is a POSITIVE, PRESENT response', () => {
    const decoded = decodeExecUdsResponse(decodeFrame(fromHex('C0 01 1C 00 00 00 FE 22 06 00 00 84 04 00 00 C8 00 00 00 07 00 03 00 07 00 62 F1 00 00 05 08 03')).payload);
    expect(decoded.transportStatus).toBe('PARTIAL_TIMEOUT');
    const { semantic } = classifyUdsResponse(fromHex('22 F1 00'), decoded.udsBody);
    expect(semantic).toBe('POSITIVE_RESPONSE');
    expect(presenceOf(semantic)).toBe('PRESENT');
  });

  it('0xFD FULL_TIMEOUT with no body is NOT present', () => {
    const decoded = decodeExecUdsResponse(decodeFrame(fromHex('C0 01 15 00 00 01 FD E0 07 00 00 E8 07 00 00 58 02 00 00 07 00 03 00 00 00')).payload);
    expect(decoded.transportStatus).toBe('FULL_TIMEOUT');
    expect(presenceOf(classifyUdsResponse(fromHex('22 F1 00'), decoded.udsBody).semantic)).toBe('NOT_CONFIRMED');
    expect(discoveryState('HOST_TIMEOUT')).toBe('COMM_ERROR');
  });
});
