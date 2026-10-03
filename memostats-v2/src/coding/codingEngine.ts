// Generic coding engine: read a coding block, decode it, and (for access-level-0 sections only) write
// a single feature option with the mandatory safety workflow of spec §8/§22:
//   read -> validate positive + exact length -> backup original -> clone -> patch ONLY target bits ->
//   show before/after (UI) -> user confirm (UI) -> write full block -> read back -> verify -> SUCCESS
//   only if the read-back matches. Never builds a block from scratch, never zero-fills, never writes
//   when the ECU/variant/length does not match. Backups persist for Restore Original.
import { type Bytes, fromHex, toHex } from '../core/bytes';
import type { MbitoClient } from '../core/mbito/mbitoClient';
import { execUds, type UdsExchangeResult } from '../core/uds/udsChannel';
import { applyPatches, changedByteIndexes, readBits } from './bits';
import { type CodingBackup, saveBackup } from './backupStore';
import { type CodingFeatureModel, type CodingOptionModel, type CodingSectionRef, type DecodedFeature, decodeFeature } from './codingModel';
import { featureStatus, isWritable } from './featureStatus';

/** The confirmed ECU a coding operation targets (from the inventory record). */
export interface CodingTarget {
  readonly ecuId: number;
  readonly ecuName: string;
  readonly variantId: number;
  readonly variantName: string;
  readonly txId: number;
  readonly rxId: number;
  readonly hardwareNumber: string | null;
  readonly softwareNumber: string | null;
}

const CODING_TIMEOUT_MS = 2000;
const CODING_WRITE_TIMEOUT_MS = 5000;
const UNCERTAIN_WRITE_SETTLE_MS = 500;

export class CodingError extends Error {}

/** Enter UDS extended diagnostic session (10 03) before a standalone coding write/restore.
 * Workflows that already contain their own 10 03 step keep using that metadata-driven sequence. */
export async function enterExtendedSession(client: MbitoClient, target: CodingTarget, signal?: AbortSignal): Promise<void> {
  const result = await execUds(client, {
    txId: target.txId,
    rxId: target.rxId,
    body: Uint8Array.of(0x10, 0x03),
    timeoutMs: CODING_TIMEOUT_MS,
    delayAfterMs: 0,
    expectedResponseLength: 2,
  }, signal);
  const uds = result.final?.udsBody;
  if (result.semantic === 'NEGATIVE_RESPONSE') {
    throw new CodingError(`ECU a refuzat sesiunea extinsă 10 03 (NRC 0x${(result.nrc ?? 0).toString(16).padStart(2, '0')})`);
  }
  if (result.semantic !== 'POSITIVE_RESPONSE' || !uds || uds[0] !== 0x50 || uds[1] !== 0x03) {
    throw new CodingError('ECU nu a confirmat sesiunea extinsă 10 03');
  }
}

/** Sends `22 <DID>` and returns the exact coding block, or throws a readable error. */
export async function readCodingBlock(client: MbitoClient, target: CodingTarget, section: CodingSectionRef, signal?: AbortSignal): Promise<Bytes> {
  const body = fromHex(section.readHex);
  const result = await execUds(client, { txId: target.txId, rxId: target.rxId, body, timeoutMs: CODING_TIMEOUT_MS, delayAfterMs: 0, expectedResponseLength: section.codingLength + body.length }, signal);
  if (result.semantic === 'NO_RESPONSE') throw new CodingError('ECU-ul nu a răspuns la citirea codării');
  if (result.semantic === 'NEGATIVE_RESPONSE') throw new CodingError(`ECU a refuzat citirea (NRC 0x${(result.nrc ?? 0).toString(16).padStart(2, '0')})`);
  const uds = result.final?.udsBody;
  if (!uds || result.semantic !== 'POSITIVE_RESPONSE') throw new CodingError('Răspuns de citire invalid');
  // positive read = 0x62 + DID echo + block
  const didLen = body.length - 1;
  if (uds[0] !== 0x62 || toHex(uds.subarray(1, 1 + didLen)) !== toHex(body.subarray(1))) throw new CodingError('Răspunsul nu corespunde DID-ului cerut');
  const block = uds.subarray(1 + didLen);
  if (block.length !== section.codingLength) {
    throw new CodingError(`Lungime bloc de codare neașteptată: așteptat ${section.codingLength}, primit ${block.length}`);
  }
  return new Uint8Array(block);
}

/** A proposed write: the clone with only the option's bits changed, plus the diff, computed with no TX. */
export interface WriteProposal {
  readonly before: Uint8Array;
  readonly after: Uint8Array;
  readonly changedBytes: number[];
  readonly option: CodingOptionModel;
}

export function buildProposal(block: Uint8Array, option: CodingOptionModel): WriteProposal {
  const after = applyPatches(block, option.patches);
  return { before: block, after, changedBytes: changedByteIndexes(block, after), option };
}

export function decode(block: Uint8Array, feature: CodingFeatureModel): DecodedFeature {
  return decodeFeature(block, feature, readBits);
}

export interface CommitResult {
  readonly status: 'VERIFIED' | 'FAILED';
  readonly verified: Uint8Array | null;
  readonly backup: CodingBackup;
  readonly message: string;
}

/**
 * Writes the proposed block, reads it back and verifies, saving a backup throughout.
 * Refuses unless the feature status is READY_READ_WRITE for this target (access 0, variant match, valid
 * metadata). The caller must have shown the before/after diff and obtained explicit user confirmation,
 * and must have paused live/performance polling and ensured capture is inactive.
 */
export async function commitWrite(
  client: MbitoClient,
  target: CodingTarget,
  feature: CodingFeatureModel,
  proposal: WriteProposal,
  signal?: AbortSignal,
): Promise<CommitResult> {
  const status = featureStatus(feature, { ecuDetected: true, variantMatches: true, variantId: target.variantId });
  if (!isWritable(status)) throw new CodingError(`Scrierea nu este permisă pentru acest feature (${status})`);
  if (proposal.after.length !== feature.section.codingLength) throw new CodingError('Lungimea blocului propus diferă de metadate');
  if (proposal.changedBytes.length === 0) throw new CodingError('Nicio modificare de scris (valoarea este deja setată)');

  const now = Date.now();
  const base: CodingBackup = {
    id: `${target.ecuId}-${target.variantId}-${feature.section.id}-${now}`,
    timestamp: now, ecuId: target.ecuId, ecuName: target.ecuName, variantId: target.variantId, variantName: target.variantName,
    txId: target.txId, rxId: target.rxId, hardwareNumber: target.hardwareNumber, softwareNumber: target.softwareNumber,
    sectionId: feature.section.id, readHex: feature.section.readHex, writeHex: feature.section.writeHex, codingLength: feature.section.codingLength,
    originalBytes: toHex(proposal.before), proposedBytes: toHex(proposal.after),
    featureId: feature.featureId, featureName: feature.name, optionId: proposal.option.optionId, optionMeaning: proposal.option.valueMeaning,
    verifiedBytes: null, status: 'PENDING',
  };
  await saveBackup(base);

  const write = await execUds(client, {
    txId: target.txId, rxId: target.rxId, body: concat(fromHex(feature.section.writeHex), proposal.after),
    timeoutMs: CODING_WRITE_TIMEOUT_MS, delayAfterMs: 0, expectedResponseLength: fromHex(feature.section.writeHex).length,
  }, signal);
  const writeDetail = describeExchange(write);

  // An explicit negative UDS response proves the ECU rejected the write. Do not pretend a read-back
  // can turn that rejection into a successful 2E transaction.
  if (write.semantic === 'NEGATIVE_RESPONSE') {
    const backup = { ...base, status: 'FAILED' as const };
    await saveBackup(backup);
    return {
      status: 'FAILED',
      verified: null,
      backup,
      message: `Scrierea a fost refuzată (${writeDetail}) — nicio modificare confirmată`,
    };
  }

  // §22: SUCCESS only after a valid read-back, never merely because 2E answered.
  // Conversely, a missing/partial/odd 2E reply does NOT prove the write was not applied: the ECU may
  // still be finishing an ISO-TP multi-frame write when the dongle reports a timeout. Give only
  // inconclusive writes a short settle window, then read back once. Never retransmit 2E automatically.
  if (write.semantic !== 'POSITIVE_RESPONSE') {
    await wait(UNCERTAIN_WRITE_SETTLE_MS, signal);
  }
  let readBack: Bytes;
  try {
    readBack = await readCodingBlock(client, target, feature.section, signal);
  } catch (error) {
    const backup = { ...base, status: 'FAILED' as const };
    await saveBackup(backup);
    return {
      status: 'FAILED',
      verified: null,
      backup,
      message: `Scriere neconfirmată (${writeDetail}); recitirea a eșuat: ${errorMessage(error)}`,
    };
  }

  const matches = toHex(readBack) === toHex(proposal.after);
  const backup = { ...base, verifiedBytes: toHex(readBack), status: matches ? ('VERIFIED' as const) : ('FAILED' as const) };
  await saveBackup(backup);
  if (matches) {
    return {
      status: 'VERIFIED',
      verified: readBack,
      backup,
      message: write.semantic === 'POSITIVE_RESPONSE'
        ? 'Scriere confirmată prin recitire'
        : `Scriere confirmată prin recitire; răspunsul 2E a fost neconcludent (${writeDetail})`,
    };
  }
  return {
    status: 'FAILED',
    verified: readBack,
    backup,
    message: write.semantic === 'POSITIVE_RESPONSE'
      ? 'Verificarea prin recitire a eșuat — valoarea citită diferă de cea scrisă'
      : `Scriere neconfirmată (${writeDetail}); recitirea diferă de blocul propus`,
  };
}

/**
 * Restore Original from a backup (spec §8): re-reads the block, confirms the ECU responds and the length
 * matches the backup, writes the saved original, reads back and verifies. Never a blind rollback.
 */
export async function restoreFromBackup(client: MbitoClient, backup: CodingBackup, signal?: AbortSignal): Promise<CommitResult> {
  const target: CodingTarget = {
    ecuId: backup.ecuId, ecuName: backup.ecuName, variantId: backup.variantId, variantName: backup.variantName,
    txId: backup.txId, rxId: backup.rxId, hardwareNumber: backup.hardwareNumber, softwareNumber: backup.softwareNumber,
  };
  const section: CodingSectionRef = { id: backup.sectionId, codingLength: backup.codingLength, readHex: backup.readHex, writeHex: backup.writeHex, accessLevel: 0, dllName: null, seedLength: null, keyLength: null };
  const current = await readCodingBlock(client, target, section, signal); // confirms ECU responds + length
  const original = fromHex(backup.originalBytes);
  if (original.length !== section.codingLength) throw new CodingError('Backup-ul nu corespunde lungimii blocului');
  if (toHex(current) === backup.originalBytes) {
    const restored = { ...backup, status: 'RESTORED' as const, verifiedBytes: toHex(current) };
    await saveBackup(restored);
    return { status: 'VERIFIED', verified: current, backup: restored, message: 'Blocul este deja la valoarea originală' };
  }
  const write = await execUds(client, { txId: target.txId, rxId: target.rxId, body: concat(fromHex(section.writeHex), original), timeoutMs: CODING_WRITE_TIMEOUT_MS, delayAfterMs: 0, expectedResponseLength: fromHex(section.writeHex).length }, signal);
  if (write.semantic === 'NEGATIVE_RESPONSE') {
    throw new CodingError(`Restaurarea a fost refuzată (${describeExchange(write)})`);
  }
  if (write.semantic !== 'POSITIVE_RESPONSE') {
    await wait(UNCERTAIN_WRITE_SETTLE_MS, signal);
  }
  const readBack = await readCodingBlock(client, target, section, signal);
  const matches = toHex(readBack) === backup.originalBytes;
  const restored = { ...backup, status: matches ? ('RESTORED' as const) : ('FAILED' as const), verifiedBytes: toHex(readBack) };
  await saveBackup(restored);
  return matches
    ? { status: 'VERIFIED', verified: readBack, backup: restored, message: 'Valoarea originală a fost restaurată și verificată' }
    : { status: 'FAILED', verified: readBack, backup: restored, message: 'Restaurarea nu s-a verificat la recitire' };
}

function describeExchange(result: UdsExchangeResult): string {
  const parts = [result.semantic, `transport ${result.transport}`];
  if (result.nrc !== undefined) parts.push(`NRC 0x${result.nrc.toString(16).padStart(2, '0').toUpperCase()}`);
  if (result.final) {
    parts.push(`resp_status 0x${result.final.header.responseType.toString(16).padStart(2, '0').toUpperCase()}`);
    if (result.final.udsBody.length) parts.push(`UDS ${toHex(result.final.udsBody)}`);
  }
  return parts.join(' · ');
}

const errorMessage = (error: unknown): string => error instanceof Error ? error.message : String(error);

function wait(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.reject(signal.reason);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => {
      clearTimeout(timer);
      reject(signal.reason);
    }, { once: true });
  });
}

function concat(a: Uint8Array, b: Uint8Array): Bytes {
  const out = new Uint8Array(a.length + b.length);
  out.set(a);
  out.set(b, a.length);
  return out;
}
