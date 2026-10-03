// Consolidated W176 ECU catalogue: the raw MBito exports (sources/) merged with every real
// observation (evidence.json). Pure and deterministic; ecuCatalogue.test.ts regenerates
// ecu-catalogue.generated.json and docs/W176-ECUS.md from it (npm run catalogue).
import { dataView, fromHex, hexId, toHex } from '../../core/bytes';
import { decodeFrame } from '../../core/mbito/frame';
import { decodeExecUdsResponse } from '../../core/uds/execUds';

export type EvidenceLevel =
  | 'CONFIRMED_FROM_OFFICIAL_CAPTURE'
  | 'CONFIRMED_ON_REAL_CAR'
  | 'DERIVED_FROM_MBITO_DATABASE'
  | 'INFERRED'
  | 'UNKNOWN';

export interface KnownRequest {
  uds: string;
  purpose: string;
  timeoutMs: number | null;
  expectedResponseLength: number | null;
  delayAfterMs: number | null;
  response: string | null;
  responseAscii: string | null;
  rawTransport: string | null;
  who: string;
  level: EvidenceLevel;
  source: string;
}

export interface CatalogueRecord {
  ecuId: number;
  name: string;
  description: string;
  group: string;
  type: string;
  variantCount: number;
}

export interface CatalogueEndpoint {
  key: string;
  txId: number;
  rxId: number;
  addressing: string;
  names: string[];
  records: CatalogueRecord[];
  types: string[];
  catalogLevel: EvidenceLevel;
  currentVehicle: null | {
    name: string;
    ecuId: number;
    variantId: number;
    variantName: string;
    opCode: string;
    hardwareNumber: string;
    softwareNumber: string;
  };
  onThisCar: { level: EvidenceLevel; detail: string };
  inOfficialCapture: boolean;
  officialScanProbe: null | { response: string; positive: boolean };
  sessions: { request: string; response: string; note: string; level: EvidenceLevel; source: string }[];
  knownRequests: KnownRequest[];
  warnings: string[];
}

export interface EcuCatalogue {
  vehicle: string;
  sources: { catalog: string; vehicleEcus: string; evidence: string };
  summary: {
    catalogRecords: number;
    uniqueEndpoints: number;
    variants: number;
    currentVehicleEcus: number;
    confirmedOnRealCar: number;
    inOfficialCapture: number;
    officialProbeNoResponse: number;
  };
  nameCollisions: { name: string; endpoints: string[] }[];
  issues: string[];
  endpoints: CatalogueEndpoint[];
}

// ---------- source validation (spec §65: never silently accept malformed records) ----------

interface CatalogCandidate {
  ecuId: number; name: string; description: string; group: string; type: string;
  transmitIdNumeric: number; receiveIdNumeric: number; transmitId: string; receiveId: string;
  variants: { id: number; name: string; opCode: string }[];
}
interface VehicleEcu {
  ecuId: number; ecuName: string; variantId: number; variantName: string; opCode: string;
  transmitIdNumeric: number; receiveIdNumeric: number; hardwareNumber: string; softwareNumber: string;
}

const OP_CODE = /^[0-9A-F]{6}$/i;
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null;
const isInt = (v: unknown): v is number => Number.isInteger(v);
const isStr = (v: unknown): v is string => typeof v === 'string';

function validateCatalog(raw: unknown, issues: string[]): CatalogCandidate[] {
  if (!isObj(raw) || !Array.isArray(raw.candidates)) throw new Error('catalog source: missing candidates[]');
  const out: CatalogCandidate[] = [];
  raw.candidates.forEach((c: unknown, i: number) => {
    const where = `catalog.candidates[${i}]`;
    if (!isObj(c) || !isInt(c.ecuId) || !isStr(c.name) || !isInt(c.transmitIdNumeric) || !isInt(c.receiveIdNumeric)
      || !isStr(c.transmitId) || !isStr(c.receiveId) || !Array.isArray(c.variants)) {
      issues.push(`${where}: malformed record excluded`);
      return;
    }
    if (parseInt(c.transmitId, 16) !== c.transmitIdNumeric || parseInt(c.receiveId, 16) !== c.receiveIdNumeric) {
      issues.push(`${where} ${c.name}: hex/numeric CAN id mismatch — excluded`);
      return;
    }
    const variants = c.variants.filter((v: unknown): v is { id: number; name: string; opCode: string } =>
      isObj(v) && isInt(v.id) && isStr(v.name) && isStr(v.opCode));
    if (variants.length !== c.variants.length) issues.push(`${where} ${c.name}: ${c.variants.length - variants.length} malformed variants excluded`);
    for (const v of variants) {
      if (!OP_CODE.test(v.opCode)) issues.push(`${c.name} variant ${v.id}: op code "${v.opCode}" is not 6 hex digits (kept raw, unusable for exact matching)`);
    }
    out.push({
      ecuId: c.ecuId, name: c.name, description: isStr(c.description) ? c.description : '', group: isStr(c.group) ? c.group : '',
      type: isStr(c.type) ? c.type : 'UNKNOWN', transmitIdNumeric: c.transmitIdNumeric, receiveIdNumeric: c.receiveIdNumeric,
      transmitId: c.transmitId, receiveId: c.receiveId, variants,
    });
  });
  const ids = new Set<number>();
  for (const v of out.flatMap(c => c.variants)) {
    if (ids.has(v.id)) issues.push(`duplicate variant id ${v.id}`);
    ids.add(v.id);
  }
  return out;
}

function validateVehicle(raw: unknown, issues: string[]): VehicleEcu[] {
  if (!isObj(raw) || !Array.isArray(raw.ecus)) throw new Error('vehicle source: missing ecus[]');
  return raw.ecus.flatMap((e: unknown, i: number) => {
    if (!isObj(e) || !isInt(e.ecuId) || !isStr(e.ecuName) || !isInt(e.variantId) || !isStr(e.opCode)
      || !isInt(e.transmitIdNumeric) || !isInt(e.receiveIdNumeric)) {
      issues.push(`vehicle.ecus[${i}]: malformed record excluded`);
      return [];
    }
    return [{
      ecuId: e.ecuId, ecuName: e.ecuName, variantId: e.variantId, variantName: isStr(e.variantName) ? e.variantName : '',
      opCode: e.opCode, transmitIdNumeric: e.transmitIdNumeric, receiveIdNumeric: e.receiveIdNumeric,
      hardwareNumber: isStr(e.hardwareNumber) ? e.hardwareNumber : '', softwareNumber: isStr(e.softwareNumber) ? e.softwareNumber : '',
    }];
  });
}

// ---------- evidence ----------

export interface Evidence {
  officialCaptureSession: { id: string; source: string; execUdsFrames: { rxHex: string; udsRequest: string }[]; scanProbeFrames: string[] };
  officialScanResult: { date: string; notDetected: string[]; source: string; f111Reported: Record<string, string> };
  realCarObservations: { ecu: string; txId: string; rxId: string; request: string; response: string | null; rawTransport: string | null; who: string; date: string | null; source: string }[];
}

const DID_PURPOSE: Record<string, string> = {
  '22 F1 00': 'F100 variant / op code', '22 F1 8C': 'F18C serial', '22 F1 11': 'F111 (reported as hardware no.)',
  '22 F1 21': 'F121 (reported as software no.)', '19 01 0D': 'DTC count, mask 0D', '19 02 0D': 'DTC list, mask 0D', '01 0D': 'OBD vehicle speed',
};

function printable(bytes: Uint8Array): string | null {
  const text = String.fromCharCode(...bytes);
  return /^[\x20-\x7e]+$/.test(text) ? text : null;
}

const key = (tx: number, rx: number) => `${hexId(tx)}/${hexId(rx)}`;

export function buildEcuCatalogue(catalogRaw: unknown, vehicleRaw: unknown, evidence: Evidence): EcuCatalogue {
  const issues: string[] = [];
  const catalog = validateCatalog(catalogRaw, issues);
  const vehicle = validateVehicle(vehicleRaw, issues);

  const byKey = new Map<string, CatalogCandidate[]>();
  for (const c of catalog) {
    const k = key(c.transmitIdNumeric, c.receiveIdNumeric);
    byKey.set(k, [...(byKey.get(k) ?? []), c]);
  }

  // official capture: EXEC_UDS frames → known requests with the exact MBito parameters
  const captured = new Map<string, KnownRequest[]>();
  for (const { rxHex, udsRequest } of evidence.officialCaptureSession.execUdsFrames) {
    const response = decodeExecUdsResponse(decodeFrame(fromHex(rxHex)).payload);
    const { header } = response;
    const k = key(header.txId, header.rxId);
    const body = response.udsBody;
    captured.set(k, [...(captured.get(k) ?? []), {
      uds: udsRequest, purpose: DID_PURPOSE[udsRequest] ?? 'read',
      timeoutMs: header.timeoutMs, expectedResponseLength: header.expectedLength, delayAfterMs: header.delayAfterMs,
      response: toHex(body), responseAscii: printable(body.subarray(3)), rawTransport: `0x${header.responseType.toString(16).toUpperCase().padStart(2, '0')} ${response.transportStatus}`,
      who: 'official MBito app (Scan Vehicle)', level: 'CONFIRMED_FROM_OFFICIAL_CAPTURE',
      source: `${evidence.officialCaptureSession.id} — ${evidence.officialCaptureSession.source}`,
    }]);
  }

  // official scan probes (cmd 0x33, embedded CAN frame 02 10 03 …): payload tx u32@4, rx u32@20, len@24, response@25
  // Layout reconstructed from these captures by old MemoStats (scanProbe.ts) — INFERRED.
  const probes = new Map<string, { response: string; positive: boolean }>();
  for (const hex of evidence.officialCaptureSession.scanProbeFrames) {
    const payload = decodeFrame(fromHex(hex)).payload;
    const view = dataView(payload);
    const length = view.getUint8(24);
    const embedded = payload.subarray(25, 25 + length);
    probes.set(key(view.getUint32(4, true), view.getUint32(20, true)), {
      response: length ? toHex(embedded) : 'no answer (zero-filled)',
      positive: embedded[0] === 0x50 && embedded[1] === 0x03,
    });
  }

  const notDetected = new Set(evidence.officialScanResult.notDetected);
  const endpoints: CatalogueEndpoint[] = [...byKey.entries()].map(([k, records]) => {
    const first = records[0] as CatalogCandidate;
    const tx = first.transmitIdNumeric;
    const rx = first.receiveIdNumeric;
    const warnings: string[] = [];
    const current = vehicle.find(v => v.transmitIdNumeric === tx && v.receiveIdNumeric === rx) ?? null;
    if (current) {
      const record = records.find(r => r.ecuId === current.ecuId);
      if (!record) warnings.push(`vehicle ECU ${current.ecuName} (ecuId ${current.ecuId}) not among catalog records at this endpoint`);
      else if (!record.variants.some(v => v.id === current.variantId && v.opCode === current.opCode)) {
        warnings.push(`vehicle variant ${current.variantId}/${current.opCode} not found in catalog variants of ${record.name}`);
      }
    }

    const knownRequests: KnownRequest[] = [...(captured.get(k) ?? [])];
    for (const o of evidence.realCarObservations) {
      if (parseInt(o.txId, 16) !== tx || parseInt(o.rxId, 16) !== rx) continue;
      knownRequests.push({
        uds: o.request, purpose: DID_PURPOSE[o.request] ?? 'read', timeoutMs: null, expectedResponseLength: null, delayAfterMs: null,
        response: o.response, responseAscii: null, rawTransport: o.rawTransport, who: o.who, level: 'CONFIRMED_ON_REAL_CAR',
        source: `${o.source}${o.date ? ` (${o.date})` : ''}`,
      });
    }
    const f111 = current ? evidence.officialScanResult.f111Reported[current.ecuName] : undefined;
    if (f111 && !knownRequests.some(r => r.uds === '22 F1 11')) {
      knownRequests.push({
        uds: '22 F1 11', purpose: DID_PURPOSE['22 F1 11'] ?? 'read', timeoutMs: null, expectedResponseLength: null, delayAfterMs: null,
        response: null, responseAscii: f111, rawTransport: null, who: 'official MBito scan', level: 'CONFIRMED_ON_REAL_CAR',
        source: evidence.officialScanResult.source,
      });
    }

    const probe = probes.get(k) ?? null;
    const sessions = probe?.positive ? [{
      request: '10 03', response: probe.response,
      note: 'DiagnosticSessionControl extended (official scan probe). 50 03 00 14 00 C8 → P2 20 ms, P2* 2000 ms (ISO 14229-2 encoding)',
      level: 'CONFIRMED_FROM_OFFICIAL_CAPTURE' as const, source: evidence.officialCaptureSession.id,
    }] : [];

    const inOfficialCapture = captured.has(k) || probe !== null;
    let onThisCar: CatalogueEndpoint['onThisCar'];
    if (current && !notDetected.has(current.ecuName)) {
      onThisCar = { level: 'CONFIRMED_ON_REAL_CAR', detail: `Detected by the official MBito scan ${evidence.officialScanResult.date} (user-reported)${captured.has(k) ? '; raw frames in official capture' : ''}` };
    } else if (current && knownRequests.some(r => r.level === 'CONFIRMED_ON_REAL_CAR' && r.response)) {
      onThisCar = { level: 'CONFIRMED_ON_REAL_CAR', detail: `Not detected by the ${evidence.officialScanResult.date} official scan, but real replies were reported (see known requests)` };
    } else if (current) {
      onThisCar = { level: 'DERIVED_FROM_MBITO_DATABASE', detail: 'In MBito\'s vehicle record only' };
    } else if (probe && !probe.positive) {
      onThisCar = { level: 'UNKNOWN', detail: 'Catalog only; the official scan probe got no answer (capture excerpt)' };
    } else {
      onThisCar = { level: 'UNKNOWN', detail: 'Catalog only; never observed on this car' };
    }

    const names = [...new Set(records.map(r => r.name))];
    return {
      key: k, txId: tx, rxId: rx,
      addressing: `CAN ${tx > 0x7ff || rx > 0x7ff ? '29' : '11'}-bit physical, ISO-TP in dongle (no logical/gateway address in catalog)`,
      names, types: [...new Set(records.map(r => r.type))],
      records: records.map(r => ({ ecuId: r.ecuId, name: r.name, description: r.description, group: r.group, type: r.type, variantCount: r.variants.length })),
      catalogLevel: 'DERIVED_FROM_MBITO_DATABASE',
      currentVehicle: current && {
        name: current.ecuName, ecuId: current.ecuId, variantId: current.variantId, variantName: current.variantName,
        opCode: current.opCode, hardwareNumber: current.hardwareNumber, softwareNumber: current.softwareNumber,
      },
      onThisCar, inOfficialCapture, officialScanProbe: probe, sessions, knownRequests, warnings,
    };
  });

  for (const v of vehicle) {
    if (!byKey.has(key(v.transmitIdNumeric, v.receiveIdNumeric))) issues.push(`vehicle ECU ${v.ecuName} has no catalog endpoint`);
  }
  for (const p of probes.keys()) if (!byKey.has(p)) issues.push(`official probe endpoint ${p} is not in the catalog`);

  const rank = (e: CatalogueEndpoint) => (e.currentVehicle ? 0 : 1);
  endpoints.sort((a, b) => rank(a) - rank(b) || a.txId - b.txId || a.rxId - b.rxId);

  const nameHome = new Map<string, string[]>();
  for (const e of endpoints) for (const n of e.names) nameHome.set(n, [...(nameHome.get(n) ?? []), e.key]);

  return {
    vehicle: 'Mercedes-Benz A-Class W176 — MBito car 43, user vehicle 80903',
    sources: {
      catalog: 'src/data/w176/sources/mbito-car43-ecu-catalog.json (= MemoStats/mbito-re/data/scan-candidates.json, GetCarsInfoGqlquery cars(id=43))',
      vehicleEcus: 'src/data/w176/sources/mbito-vehicle80903-ecus.json (= MemoStats/mbito-re/data/vehicle-ecus.json, GetUserVehiclesGqlQuery)',
      evidence: 'src/data/w176/evidence.json',
    },
    summary: {
      catalogRecords: catalog.length,
      uniqueEndpoints: endpoints.length,
      variants: catalog.reduce((n, c) => n + c.variants.length, 0),
      currentVehicleEcus: endpoints.filter(e => e.currentVehicle).length,
      confirmedOnRealCar: endpoints.filter(e => e.onThisCar.level === 'CONFIRMED_ON_REAL_CAR').length,
      inOfficialCapture: endpoints.filter(e => e.inOfficialCapture).length,
      officialProbeNoResponse: endpoints.filter(e => e.officialScanProbe && !e.officialScanProbe.positive).length,
    },
    nameCollisions: [...nameHome.entries()].filter(([, eps]) => eps.length > 1).map(([name, eps]) => ({ name, endpoints: eps })),
    issues,
    endpoints,
  };
}

// ---------- docs/W176-ECUS.md ----------

const cell = (s: string) => s.replaceAll('|', '\\|');

export function renderCatalogueMarkdown(c: EcuCatalogue): string {
  const s = c.summary;
  const lines = [
    '# W176 ECU catalogue',
    '',
    '> Generated by `npm run catalogue` from `src/data/w176/` — do not edit by hand.',
    '',
    `Vehicle: ${c.vehicle}`,
    '',
    '## Sources',
    '',
    `- Catalog: ${c.sources.catalog}`,
    `- Vehicle ECUs: ${c.sources.vehicleEcus}`,
    `- Evidence: ${c.sources.evidence}`,
    '',
    '## Summary',
    '',
    `| Catalog records | Unique TX/RX endpoints | Variants | On this car (MBito record) | Confirmed on real car | In official capture | Official probe, no answer |`,
    '|---|---|---|---|---|---|---|',
    `| ${s.catalogRecords} | ${s.uniqueEndpoints} | ${s.variants} | ${s.currentVehicleEcus} | ${s.confirmedOnRealCar} | ${s.inOfficialCapture} | ${s.officialProbeNoResponse} |`,
    '',
    'Evidence levels: `CONFIRMED_FROM_OFFICIAL_CAPTURE` (raw official-app frame from this car) · `CONFIRMED_ON_REAL_CAR` (observed on this car, raw frame or user report) · `DERIVED_FROM_MBITO_DATABASE` · `INFERRED` · `UNKNOWN`.',
    '',
    '## ECUs on this car (MBito vehicle record)',
    '',
    '| # | ECU | Aliases at endpoint | TX → RX | Type | Variant (id) / op code | On this car | Official capture |',
    '|---|---|---|---|---|---|---|---|',
  ];
  const current = c.endpoints.filter(e => e.currentVehicle);
  current.forEach((e, i) => {
    const v = e.currentVehicle;
    if (!v) return;
    const aliases = e.names.filter(n => n !== v.name).join(', ') || '—';
    const cap = e.inOfficialCapture ? (e.knownRequests.filter(r => r.level === 'CONFIRMED_FROM_OFFICIAL_CAPTURE').map(r => r.uds.slice(3)).join(', ') || 'probe') : '—';
    lines.push(`| ${i + 1} | **${v.name}** | ${cell(aliases)} | \`${hexId(e.txId)} → ${hexId(e.rxId)}\` | ${e.types.join(', ')} | ${cell(v.variantName)} (${v.variantId}) / \`${v.opCode}\` | ${e.onThisCar.level} | ${cap} |`);
  });

  lines.push('', '## Known requests per ECU (evidence only)', '');
  for (const e of current) {
    if (!e.knownRequests.length && !e.sessions.length) continue;
    lines.push(`### ${e.currentVehicle?.name} \`${hexId(e.txId)} → ${hexId(e.rxId)}\``, '', `On this car: ${e.onThisCar.level} — ${e.onThisCar.detail}`, '');
    lines.push('| Request | Purpose | timeout | exp_len | delay | Response | Raw status | Level | By |', '|---|---|---|---|---|---|---|---|---|');
    for (const x of e.sessions) lines.push(`| \`${x.request}\` | session | — | — | — | \`${x.response}\` | — | ${x.level} | official scan probe |`);
    for (const r of e.knownRequests) {
      const resp = r.response ? `\`${r.response}\`${r.responseAscii ? ` "${r.responseAscii}"` : ''}` : r.responseAscii ? `"${r.responseAscii}"` : '—';
      lines.push(`| \`${r.uds}\` | ${r.purpose} | ${r.timeoutMs ?? '—'} | ${r.expectedResponseLength ?? '—'} | ${r.delayAfterMs ?? '—'} | ${cell(resp)} | ${r.rawTransport ?? '—'} | ${r.level} | ${cell(r.who)} |`);
    }
    lines.push('');
  }

  lines.push('## Other W176 catalog endpoints (not in this car\'s MBito record)', '');
  lines.push('| TX → RX | Names at endpoint (aliases) | Types | Groups | Official scan probe | On this car |', '|---|---|---|---|---|---|');
  for (const e of c.endpoints.filter(x => !x.currentVehicle)) {
    lines.push(`| \`${hexId(e.txId)} → ${hexId(e.rxId)}\` | ${cell(e.names.join(', '))} | ${e.types.join(', ')} | ${cell([...new Set(e.records.map(r => r.group))].join(', '))} | ${e.officialScanProbe ? cell(e.officialScanProbe.response) : '—'} | ${e.onThisCar.level} |`);
  }

  lines.push('', '## Names used at more than one endpoint', '');
  lines.push(...(c.nameCollisions.length ? c.nameCollisions.map(n => `- ${n.name}: ${n.endpoints.join(', ')}`) : ['None.']));
  lines.push('', '## Source data issues', '');
  lines.push(...(c.issues.length ? c.issues.map(i => `- ${i}`) : ['None.']));
  lines.push('');
  return lines.join('\n');
}
