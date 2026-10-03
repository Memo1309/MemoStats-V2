// SAE J1979 Mode 01 PID 01 (monitor status since DTCs cleared) and Mode 09 PID 02 (VIN). Read-only.

export interface Monitor {
  name: string;
  /** false = not supported by this ECU */
  supported: boolean;
  /** true = test completed */
  complete: boolean;
}

export interface Readiness {
  milOn: boolean;
  emissionDtcCount: number;
  ignition: 'spark' | 'compression';
  monitors: Monitor[];
}

const COMMON = ['Rateuri (misfire)', 'Sistem de alimentare', 'Componente'];
const SPARK = ['Catalizator', 'Catalizator încălzit', 'Sistem EVAP', 'Aer secundar', 'Climatizare (A/C)', 'Sondă lambda', 'Încălzire sondă lambda', 'EGR / VVT'];

/** `41 01 A B C D` */
export function decodeReadiness(body: Uint8Array): Readiness | null {
  if (body.length < 6 || body[0] !== 0x41 || body[1] !== 0x01) return null;
  const [, , a = 0, b = 0, c = 0, d = 0] = body;
  const monitors: Monitor[] = COMMON.map((name, i) => ({ name, supported: Boolean(b & (1 << i)), complete: !(b & (1 << (i + 4))) }));
  const compression = Boolean(b & 0x08);
  // Byte C/D bit meanings differ for diesel; V2 targets the M270 petrol engine, so only spark is decoded.
  if (!compression) SPARK.forEach((name, i) => monitors.push({ name, supported: Boolean(c & (1 << i)), complete: !(d & (1 << i)) }));
  return { milOn: Boolean(a & 0x80), emissionDtcCount: a & 0x7f, ignition: compression ? 'compression' : 'spark', monitors };
}

/** `49 02 01 <17 ASCII>` — ISO-TP multi-frame reassembly happens inside the dongle. */
export function decodeVin(body: Uint8Array): string | null {
  if (body.length < 20 || body[0] !== 0x49 || body[1] !== 0x02) return null;
  const vin = String.fromCharCode(...body.subarray(3, 20));
  return /^[A-HJ-NPR-Z0-9]{17}$/.test(vin) ? vin : null;
}
