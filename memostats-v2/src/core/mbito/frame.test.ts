import { describe, expect, it } from 'vitest';
import { fromHex, toHex } from '../bytes';
import { MbitoCmd } from './constants';
import { FrameAssembler, decodeFrame, decodeText, decodeVoltage, encodeRequest } from './frame';

describe('MBito outer frame', () => {
  it('encodes GET_DEV_NAME exactly as the real dongle accepted it', () => {
    expect(toHex(encodeRequest(MbitoCmd.GET_DEV_NAME))).toBe('00 79 00 00');
  });

  it('encodes FW and voltage requests with the single-frame arg', () => {
    expect(toHex(encodeRequest(MbitoCmd.GET_FW_VERSION))).toBe('01 79 00 00');
    expect(toHex(encodeRequest(MbitoCmd.GET_VOLTAGE))).toBe('04 79 00 00');
  });

  it('writes the payload length little-endian', () => {
    const frame = encodeRequest(MbitoCmd.EXEC_UDS, new Uint8Array(0x118));
    expect(toHex(frame.subarray(0, 4))).toBe('40 79 18 01');
    expect(frame.length).toBe(4 + 0x118);
  });

  it('refuses payloads that would need FF/CF/LF chunking', () => {
    expect(() => encodeRequest(MbitoCmd.EXEC_UDS, new Uint8Array(494))).toThrow(RangeError);
    expect(() => encodeRequest(MbitoCmd.EXEC_UDS, new Uint8Array(493))).not.toThrow();
  });

  it('normalizes the response command and exposes arg/payload', () => {
    const frame = decodeFrame(fromHex('C0 01 03 00 AA BB CC'));
    expect(frame).toMatchObject({ rawCommand: 0xc0, command: 0x40, isResponse: true, arg: 0x01 });
    expect(toHex(frame.payload)).toBe('AA BB CC');
  });

  it('rejects a packet whose length field disagrees with its size', () => {
    expect(() => decodeFrame(fromHex('C0 01 05 00 AA'))).toThrow();
  });

  it('decodes the device name and firmware text', () => {
    const name = decodeFrame(fromHex(`80 01 0A 00 ${toHex(new TextEncoder().encode('V2407127C3'))}`));
    expect(decodeText(name.payload)).toBe('V2407127C3');
    expect(decodeText(new TextEncoder().encode('v1.31\0\0'))).toBe('v1.31');
  });

  it('decodes voltage as little-endian millivolts', () => {
    expect(decodeVoltage(fromHex('E8 3A'))).toBeCloseTo(15.08, 3); // 0x3AE8 = 15080 mV
    expect(() => decodeVoltage(fromHex('E8'))).toThrow();
  });
});

describe('FrameAssembler', () => {
  const packet = fromHex('84 01 02 00 E8 3A');

  it('passes a whole packet straight through', () => {
    const { frames, dropped } = new FrameAssembler().push(packet, 0);
    expect(frames).toHaveLength(1);
    expect(dropped).toHaveLength(0);
  });

  it('reassembles a packet split across notifications', () => {
    const assembler = new FrameAssembler();
    expect(assembler.push(packet.subarray(0, 3), 0).frames).toHaveLength(0);
    const { frames } = assembler.push(packet.subarray(3), 10);
    expect(frames).toHaveLength(1);
    expect(toHex(frames[0]?.payload ?? new Uint8Array())).toBe('E8 3A');
  });

  it('splits two packets delivered in one notification', () => {
    const both = fromHex('84 01 02 00 E8 3A 80 01 01 00 41');
    expect(new FrameAssembler().push(both, 0).frames.map(f => f.command)).toEqual([0x04, 0x00]);
  });

  it('drops bytes that cannot start a dongle response', () => {
    const { frames, dropped } = new FrameAssembler().push(fromHex('12 34 56 78 9A'), 0);
    expect(frames).toHaveLength(0);
    expect(dropped).toHaveLength(1);
  });

  it('abandons a stale partial instead of gluing it to a new packet', () => {
    const assembler = new FrameAssembler();
    assembler.push(packet.subarray(0, 3), 0);
    const { frames, dropped } = assembler.push(packet, 5000);
    expect(dropped).toHaveLength(1);
    expect(frames).toHaveLength(1);
  });
});
