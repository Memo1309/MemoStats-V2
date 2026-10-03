// ISO 14229-1 ReadDTCInformation decoding, ported from MemoStats V1 dtcCodec.ts.
// Parsing is finished before any description lookup, so malformed bytes can never become a fault.
// VERIFIED REAL VEHICLE fixture (MED40): 59 02 FF | 05 2E 71 64 | D4 57 00 64 | 06 DA 00 64 → exactly 3 DTCs.

const CATEGORY = ['P', 'C', 'B', 'U'] as const;
const hex2 = (b: number) => b.toString(16).toUpperCase().padStart(2, '0');

export type DtcFamily = 'REGULAR_ECU' | 'OLD_ECU_MANSPEC';

export interface DtcStatusFlags {
  testFailed: boolean;
  testFailedThisOperationCycle: boolean;
  pendingDTC: boolean;
  confirmedDTC: boolean;
  testNotCompletedSinceLastClear: boolean;
  testFailedSinceLastClear: boolean;
  testNotCompletedThisOperationCycle: boolean;
  warningIndicatorRequested: boolean;
}

export interface DtcRecord {
  /** 3 raw bytes as hex, e.g. 052E71 */
  rawCode: string;
  /** SAE form for REGULAR_ECU (P052E71); raw hex for OLD_ECU_MANSPEC */
  code: string;
  statusByte: number;
  flags: DtcStatusFlags;
}

export interface DtcListParse {
  kind: 'positive' | 'negative' | 'invalid';
  records: DtcRecord[];
  availabilityMask: number | null;
  nrc: number | null;
  warnings: string[];
}

export function decodeSaeDtc(b0: number, b1: number, b2: number): string {
  return `${CATEGORY[(b0 >> 6) & 0b11]}${(b0 >> 4) & 0b11}${(b0 & 0x0f).toString(16).toUpperCase()}${hex2(b1)}${hex2(b2)}`;
}

/** Each bit decoded separately (ISO 14229-1 DTC status). */
export function decodeStatus(status: number): DtcStatusFlags {
  return {
    testFailed: Boolean(status & 0x01),
    testFailedThisOperationCycle: Boolean(status & 0x02),
    pendingDTC: Boolean(status & 0x04),
    confirmedDTC: Boolean(status & 0x08),
    testNotCompletedSinceLastClear: Boolean(status & 0x10),
    testFailedSinceLastClear: Boolean(status & 0x20),
    testNotCompletedThisOperationCycle: Boolean(status & 0x40),
    warningIndicatorRequested: Boolean(status & 0x80),
  };
}

/** `59 02 <mask> (DTC3 status1)*` — records at offset 3, exact 4-byte stride, never a sliding window. */
export function parseDtcList(body: Uint8Array, family: DtcFamily): DtcListParse {
  const base = { records: [] as DtcRecord[], availabilityMask: null, nrc: null, warnings: [] as string[] };
  if (body.length >= 3 && body[0] === 0x7f && body[1] === 0x19) return { ...base, kind: 'negative', nrc: body[2] ?? null };
  if (body.length < 3 || body[0] !== 0x59 || body[1] !== 0x02) {
    return { ...base, kind: 'invalid', warnings: ['Expected positive DTC response header 59 02 <mask>'] };
  }
  const records: DtcRecord[] = [];
  for (let offset = 3; offset + 4 <= body.length; offset += 4) {
    const [b0 = 0, b1 = 0, b2 = 0, status = 0] = body.subarray(offset, offset + 4);
    const rawCode = `${hex2(b0)}${hex2(b1)}${hex2(b2)}`;
    records.push({ rawCode, code: family === 'REGULAR_ECU' ? decodeSaeDtc(b0, b1, b2) : rawCode, statusByte: status, flags: decodeStatus(status) });
  }
  const trailing = (body.length - 3) % 4;
  const warnings = trailing ? [`Ignored ${trailing} incomplete trailing byte${trailing === 1 ? '' : 's'} — no DTC invented`] : [];
  return { ...base, kind: 'positive', records, availabilityMask: body[2] ?? null, warnings };
}

/** `59 01 <mask> <format> <count hi> <count lo>` (ISO 14229-1 reportNumberOfDTCByStatusMask). */
export function parseDtcCount(body: Uint8Array): number | null {
  if (body.length < 6 || body[0] !== 0x59 || body[1] !== 0x01) return null;
  return ((body[4] ?? 0) << 8) | (body[5] ?? 0);
}

/** Short Romanian status for a DTC card. */
export function statusSummary(flags: DtcStatusFlags): string {
  const parts: string[] = [];
  if (flags.confirmedDTC) parts.push('confirmat');
  if (flags.pendingDTC) parts.push('în așteptare');
  if (flags.testFailed) parts.push('activ acum');
  if (flags.testFailedSinceLastClear && !flags.testFailed) parts.push('a apărut de la ultima ștergere');
  if (flags.warningIndicatorRequested) parts.push('martor aprins');
  return parts.join(' · ') || 'memorat';
}
