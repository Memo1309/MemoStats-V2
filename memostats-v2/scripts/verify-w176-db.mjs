// Integrity check for the immutable W176 DB (spec §27). VERIFIES ONLY — never writes, formats or
// regenerates the file. Fails (non-zero exit) if the bytes or SHA-256 differ from the recorded values.
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const FILE = 'public/data/w176/memostats-w176-ecu-db-2026-09-29.json';
const EXPECTED_SHA256 = 'df85e634a8074bb1a78e9cbfbaf78d4649c34a3b4a8f5db106fff63f4ffc4f85';
const EXPECTED_BYTES = 2391184;

const path = fileURLToPath(new URL(`../${FILE}`, import.meta.url));
let buf;
try {
  buf = readFileSync(path);
} catch (error) {
  console.error(`[w176-db] NU pot citi ${FILE}: ${error.message}`);
  process.exit(1);
}
const sha = createHash('sha256').update(buf).digest('hex');
const ok = buf.length === EXPECTED_BYTES && sha === EXPECTED_SHA256;
console.log(`[w176-db] bytes=${buf.length} (expected ${EXPECTED_BYTES})`);
console.log(`[w176-db] sha256=${sha}`);
console.log(`[w176-db] expected=${EXPECTED_SHA256}`);
if (!ok) {
  console.error('[w176-db] INTEGRITY FAIL — fișierul immutable diferă de original. NU îl repara automat.');
  process.exit(2);
}
console.log('[w176-db] OK — fișierul immutable este neatins.');
