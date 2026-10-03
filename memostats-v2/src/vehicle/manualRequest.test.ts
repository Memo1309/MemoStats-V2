import { describe, expect, it } from 'vitest';
import { validateManualRequest } from './manualRequest';

const base = { txHex: '7E0', rxHex: '7E8', timeoutMs: 200, delayAfterMs: 200, expectedResponseLength: 3 };

describe('manual developer request', () => {
  it('accepts the V1 speed read', () => {
    expect(validateManualRequest({ ...base, bodyHex: '01 0D' })).toMatchObject({ txId: 0x7e0, rxId: 0x7e8, timeoutMs: 200, delayAfterMs: 200 });
  });

  it.each(['10 03', '11 01', '14 FF FF FF', '27 01', '2E F1 90 00', '31 01 02 03', '3E 00', '85 02', '34 00'])('blocks non-read service %s', bodyHex => {
    expect(() => validateManualRequest({ ...base, bodyHex })).toThrow(/blocat/);
  });

  it('rejects malformed ids and limits', () => {
    expect(() => validateManualRequest({ ...base, txHex: 'zz', bodyHex: '01 0D' })).toThrow();
    expect(() => validateManualRequest({ ...base, bodyHex: '' })).toThrow();
    expect(() => validateManualRequest({ ...base, bodyHex: '22 F1 00', timeoutMs: 99999 })).toThrow();
  });
});
