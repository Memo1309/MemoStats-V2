// SAE J1979 Mode 01 PIDs, ported from MemoStats V1 obdPidDefinitions.ts (the table that produced real
// W176 values: 9 km/h, 740 rpm, 92 °C, 28 °C, 11.8 %, 35 kPa). Standard formulas; V1-verified on the car
// for the six live PIDs.

export interface PidDef {
  pid: number;
  name: string;
  unit: string;
  /** data bytes after `41 <pid>`; the EXEC_UDS exp_len is this + 2 (V1: 01 0D → 3, 01 0C → 4) */
  bytes: number;
  decode(data: Uint8Array): number | null;
}

type Tier = 'FAST' | 'MEDIUM' | 'SLOW';

const a = (d: Uint8Array) => d[0];
const ab = (d: Uint8Array) => (d.length >= 2 ? (d[0] ?? 0) * 256 + (d[1] ?? 0) : undefined);
const one = (pid: number, name: string, unit: string, f: (v: number) => number): PidDef =>
  ({ pid, name, unit, bytes: 1, decode: d => { const v = a(d); return v === undefined ? null : f(v); } });
const two = (pid: number, name: string, unit: string, f: (v: number) => number): PidDef =>
  ({ pid, name, unit, bytes: 2, decode: d => { const v = ab(d); return v === undefined ? null : f(v); } });

const defs: PidDef[] = [
  one(0x04, 'Engine load', '%', v => (v * 100) / 255),
  one(0x05, 'Coolant temperature', '°C', v => v - 40),
  one(0x06, 'STFT Bank 1', '%', v => ((v - 128) * 100) / 128),
  one(0x07, 'LTFT Bank 1', '%', v => ((v - 128) * 100) / 128),
  one(0x0a, 'Fuel pressure', 'kPa', v => v * 3),
  one(0x0b, 'MAP', 'kPa', v => v),
  two(0x0c, 'Engine speed', 'rpm', v => v / 4),
  one(0x0d, 'Vehicle speed', 'km/h', v => v),
  one(0x0e, 'Timing advance', '°', v => v / 2 - 64),
  one(0x0f, 'Intake air temperature', '°C', v => v - 40),
  two(0x10, 'MAF', 'g/s', v => v / 100),
  one(0x11, 'Throttle position', '%', v => (v * 100) / 255),
  one(0x33, 'Barometric pressure', 'kPa', v => v),
  two(0x42, 'Control module voltage', 'V', v => v / 1000),
  one(0x46, 'Ambient air temperature', '°C', v => v - 40),
  one(0x49, 'Accelerator pedal D', '%', v => (v * 100) / 255),
  one(0x5c, 'Engine oil temperature', '°C', v => v - 40),
  // remaining V1 table (only polled when the ECU's supported-PID bitmap lists them)
  two(0x22, 'Fuel rail pressure (rel.)', 'kPa', v => v * 0.079),
  two(0x23, 'Fuel rail pressure (gauge)', 'kPa', v => v * 10),
  ...[0x24, 0x25, 0x26, 0x27, 0x28, 0x29, 0x2a, 0x2b].map((pid, i): PidDef => ({ ...two(pid, `O2 sensor ${i + 1} lambda`, 'λ', v => v / 32768), bytes: 4 })),
  ...[['Bank1 S1', 0x3c], ['Bank2 S1', 0x3d], ['Bank1 S2', 0x3e], ['Bank2 S2', 0x3f]].map(([n, pid]) => two(pid as number, `Catalyst temp ${n}`, '°C', v => v / 10 - 40)),
  two(0x43, 'Absolute load', '%', v => (v * 100) / 255),
  two(0x44, 'Commanded equivalence ratio', 'λ', v => v / 32768),
  one(0x4a, 'Accelerator pedal E', '%', v => (v * 100) / 255),
  one(0x4b, 'Accelerator pedal F', '%', v => (v * 100) / 255),
  two(0x59, 'Fuel rail absolute pressure', 'kPa', v => v * 10),
  one(0x5a, 'Relative pedal position', '%', v => (v * 100) / 255),
  two(0x5d, 'Fuel injection timing', '°', v => (v - 26880) / 128),
  two(0x5e, 'Engine fuel rate', 'L/h', v => v * 0.05),
  one(0x61, 'Driver demand torque', '%', v => v - 125),
  one(0x62, 'Actual engine torque', '%', v => v - 125),
  two(0x63, 'Engine reference torque', 'Nm', v => v),
  { ...one(0x64, 'Engine percent torque (idle)', '%', v => v - 125), bytes: 5 },
  one(0x6f, 'Turbo compressor inlet pressure', 'kPa', v => v),
];

export const PIDS: Readonly<Record<number, PidDef>> = Object.fromEntries(defs.map(d => [d.pid, d]));

/** V1 live set (App.tsx CORE_PIDS = FAST_PIDS + SLOW_PIDS) and V1 polling tiers. */
export const LIVE_PIDS = { SPEED: 0x0d, RPM: 0x0c, THROTTLE: 0x11, MAP: 0x0b, COOLANT: 0x05, INTAKE: 0x0f } as const;
/** V1 PID_TIER; anything unlisted is SLOW. */
export const PID_TIER: Readonly<Record<number, Tier>> = {
  0x0d: 'FAST', 0x0c: 'FAST', 0x11: 'FAST',
  0x0b: 'MEDIUM', 0x04: 'MEDIUM', 0x43: 'MEDIUM', 0x49: 'MEDIUM', 0x4a: 'MEDIUM', 0x4b: 'MEDIUM', 0x5a: 'MEDIUM',
  0x61: 'MEDIUM', 0x62: 'MEDIUM', 0x63: 'MEDIUM', 0x64: 'MEDIUM', 0x10: 'MEDIUM', 0x0e: 'MEDIUM',
};

export type PidCategory = 'MOTOR' | 'AER / TURBO' | 'COMBUSTIBIL' | 'TEMPERATURI' | 'ELECTRIC';
/** V1 PID_CATEGORY for the MAI MULTE DATE view (+ ELECTRIC for the module voltage). */
export const PID_CATEGORY: Readonly<Record<number, PidCategory>> = {
  0x04: 'MOTOR', 0x0e: 'MOTOR', 0x61: 'MOTOR', 0x62: 'MOTOR', 0x63: 'MOTOR', 0x64: 'MOTOR', 0x43: 'MOTOR', 0x49: 'MOTOR', 0x4a: 'MOTOR', 0x4b: 'MOTOR', 0x5a: 'MOTOR',
  0x10: 'AER / TURBO', 0x33: 'AER / TURBO', 0x6f: 'AER / TURBO',
  0x06: 'COMBUSTIBIL', 0x07: 'COMBUSTIBIL', 0x0a: 'COMBUSTIBIL', 0x22: 'COMBUSTIBIL', 0x23: 'COMBUSTIBIL', 0x24: 'COMBUSTIBIL', 0x25: 'COMBUSTIBIL',
  0x26: 'COMBUSTIBIL', 0x27: 'COMBUSTIBIL', 0x28: 'COMBUSTIBIL', 0x29: 'COMBUSTIBIL', 0x2a: 'COMBUSTIBIL', 0x2b: 'COMBUSTIBIL', 0x44: 'COMBUSTIBIL',
  0x59: 'COMBUSTIBIL', 0x5d: 'COMBUSTIBIL', 0x5e: 'COMBUSTIBIL',
  0x5c: 'TEMPERATURI', 0x3c: 'TEMPERATURI', 0x3d: 'TEMPERATURI', 0x3e: 'TEMPERATURI', 0x3f: 'TEMPERATURI', 0x46: 'TEMPERATURI',
  0x42: 'ELECTRIC',
};

/** Boost from absolute MAP and BARO (both kPa, both fresh). Signed: negative = vacuum. null if BARO implausible. */
export function boostKpa(mapKpa: number | null, baroKpa: number | null): number | null {
  if (mapKpa === null || baroKpa === null || baroKpa < 70 || baroKpa > 110) return null;
  return mapKpa - baroKpa;
}

export function mode01Request(pid: number): Uint8Array<ArrayBuffer> {
  return Uint8Array.of(0x01, pid);
}

/** Decodes `41 <pid> <data…>`; null when the reply is not for this PID or too short. */
export function decodeMode01(pid: number, body: Uint8Array): number | null {
  const def = PIDS[pid];
  if (!def || body.length < 2 + def.bytes || body[0] !== 0x41 || body[1] !== pid) return null;
  return def.decode(body.subarray(2));
}

/** Supported-PID bitmap `41 <block> A B C D` → PIDs block+1 … block+32 (MSB first). */
export function decodeSupportedPids(block: number, body: Uint8Array): number[] {
  if (body.length < 6 || body[0] !== 0x41 || body[1] !== block) return [];
  const out: number[] = [];
  for (let i = 0; i < 32; i++) {
    const byte = body[2 + (i >> 3)] ?? 0;
    if (byte & (0x80 >> (i & 7))) out.push(block + i + 1);
  }
  return out;
}
