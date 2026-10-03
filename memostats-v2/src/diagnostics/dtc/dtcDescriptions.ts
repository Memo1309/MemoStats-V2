// Description lookup (master spec §35). The only DTC text source on disk is the global MBito export
// (MemoStats V1 public/dtc-index.json, built from toate_codurile_dtc.json): code → candidate texts, with
// NO ECU or variant id. So every match here is GLOBAL — shown as generic, never as a variant-exact fact.
// The raw vehicle code is the truth; the description is secondary metadata.

export type DescriptionConfidence = 'GLOBAL_UNIQUE' | 'GLOBAL_AMBIGUOUS' | 'UNKNOWN';

export interface DtcDescription {
  texts: string[];
  confidence: DescriptionConfidence;
}

let index: Promise<Record<string, string[]>> | null = null;

function loadIndex(): Promise<Record<string, string[]>> {
  index ??= fetch('/dtc-index.json').then(r => {
    if (!r.ok) throw new Error(`DTC database HTTP ${r.status}`);
    return r.json() as Promise<Record<string, string[]>>;
  }).catch(error => {
    index = null; // retry on the next read instead of caching the failure
    throw error;
  });
  return index;
}

export function describe(codes: string[], table: Record<string, string[]>): Record<string, DtcDescription> {
  return Object.fromEntries(codes.map(code => {
    const texts = table[code] ?? [];
    const confidence: DescriptionConfidence = texts.length === 0 ? 'UNKNOWN' : texts.length === 1 ? 'GLOBAL_UNIQUE' : 'GLOBAL_AMBIGUOUS';
    return [code, { texts, confidence }];
  }));
}

/** Fetches the 12 MB index only when there is something to describe. */
export async function lookupDescriptions(codes: string[]): Promise<Record<string, DtcDescription>> {
  if (codes.length === 0) return {};
  return describe(codes, await loadIndex());
}
