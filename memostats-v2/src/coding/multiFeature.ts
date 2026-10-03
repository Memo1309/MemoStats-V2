// Multi-feature workflow executor (spec §13/§14). Runs the steps in the EXACT order the DB gives —
// never sorted or grouped by ECU. Two step types: `static` (a raw CarControlUnit function such as
// 10 03 / 11 01) and `koding` (the generic access-0 coding write with read-back). Every ECU is backed
// up before the first write; a later failure is reported as PARTIAL SUCCESS, never hidden, and restore
// is offered from the backups rather than a blind rollback. Only runs when every koding step is
// access-level-0 and its variant matches; anything security/sequence-gated blocks the whole workflow.
import { fromHex, toHex } from '../core/bytes';
import type { MbitoClient } from '../core/mbito/mbitoClient';
import { execUds } from '../core/uds/udsChannel';
import { parseCanId } from '../w176/catalog';
import type { W176Db, W176WorkflowStep } from '../w176/types';
import { type CodingFeatureModel, type CodingOptionModel, codingFeaturesForVariant } from './codingModel';
import { type CodingTarget, buildProposal, commitWrite, readCodingBlock } from './codingEngine';
import { featureStatus, isWritable } from './featureStatus';
import { inventoryEcuTarget } from './targets';

export interface ResolvedKodingStep {
  readonly order: number;
  readonly kind: 'koding';
  readonly step: W176WorkflowStep;
  readonly target: CodingTarget;
  readonly feature: CodingFeatureModel;
  readonly option: CodingOptionModel;
}
export interface ResolvedStaticStep {
  readonly order: number;
  readonly kind: 'static';
  readonly step: W176WorkflowStep;
  readonly target: CodingTarget;
}
export type ResolvedStep = ResolvedKodingStep | ResolvedStaticStep;

export interface ResolvedWorkflow {
  readonly featureId: number;
  readonly featureName: string;
  readonly optionMeaning: string;
  readonly steps: readonly ResolvedStep[];
  readonly ecus: readonly CodingTarget[];
  /** false when a koding step is not access-0 writable for its variant — the whole workflow is blocked */
  readonly writable: boolean;
  readonly blockedReason: string | null;
}

/** Resolves a workflow option (e.g. Blue Welcome Light 452 -> "Standard") into concrete, ordered steps. */
export function resolveWorkflow(db: W176Db, featureId: number, optionKey: string): ResolvedWorkflow | null {
  const workflow = db.coding.multi_feature_workflows[String(featureId)];
  const option = workflow?.options[optionKey];
  if (!workflow || !option) return null;
  const steps: ResolvedStep[] = [];
  const ecuMap = new Map<number, CodingTarget>();
  let writable = true;
  let blockedReason: string | null = null;

  for (const step of [...option.steps].sort((a, b) => a.order - b.order)) {
    const target = inventoryEcuTarget(db, step.ecu_id) ?? {
      ecuId: step.ecu_id, ecuName: step.ecu_name, variantId: 0, variantName: '', txId: parseCanId(step.transmit_id), rxId: parseCanId(step.receive_id), hardwareNumber: null, softwareNumber: null,
    };
    ecuMap.set(step.ecu_id, target);
    if (step.type === 'static') {
      steps.push({ order: step.order, kind: 'static', step, target });
      continue;
    }
    const feature = codingFeaturesForVariant(db, target.variantId).find(f => f.featureId === step.coding_feature_id);
    const option2 = feature?.options.find(o => o.valueMeaning === step.coding_value_meaning);
    if (!feature || !option2) {
      writable = false;
      blockedReason ??= `Pasul de codare pentru feature ${step.coding_feature_id} nu are metadate pentru varianta ${target.variantName || target.ecuId}`;
      continue;
    }
    const status = featureStatus(feature, { ecuDetected: true, variantMatches: true, variantId: target.variantId });
    if (!isWritable(status)) {
      writable = false;
      blockedReason ??= `Pasul de codare ${feature.name} necesită ${status}`;
    }
    steps.push({ order: step.order, kind: 'koding', step, target, feature, option: option2 });
  }
  return { featureId, featureName: workflow.feature_name, optionMeaning: option.value_meaning, steps, ecus: [...ecuMap.values()], writable, blockedReason };
}

export interface WorkflowStepResult {
  readonly order: number;
  readonly kind: 'static' | 'koding';
  readonly ecuName: string;
  readonly ok: boolean;
  readonly detail: string;
}

export interface WorkflowResult {
  readonly status: 'SUCCESS' | 'PARTIAL' | 'FAILED';
  readonly steps: readonly WorkflowStepResult[];
  /** ECUs whose coding was verified, and ECUs left in an unverified state */
  readonly verifiedEcus: string[];
  readonly unverifiedEcus: string[];
}

/** Executes a resolved, writable workflow in order. Callers must pause polling and ensure capture is off. */
export async function executeWorkflow(client: MbitoClient, workflow: ResolvedWorkflow, onStep: (r: WorkflowStepResult) => void, signal?: AbortSignal): Promise<WorkflowResult> {
  if (!workflow.writable) throw new Error(workflow.blockedReason ?? 'Workflow blocat');
  const results: WorkflowStepResult[] = [];
  const verified = new Set<string>();
  const touched = new Set<string>();
  let failed = false;

  // Back up every ECU's target section before the first write (spec §13).
  for (const step of workflow.steps) {
    if (step.kind !== 'koding') continue;
    try {
      await readCodingBlock(client, step.target, step.feature.section, signal);
    } catch (error) {
      const r: WorkflowStepResult = { order: -1, kind: 'koding', ecuName: step.target.ecuName, ok: false, detail: `preflight citire eșuată: ${msg(error)}` };
      results.push(r);
      onStep(r);
      return { status: 'FAILED', steps: results, verifiedEcus: [], unverifiedEcus: workflow.ecus.map(e => e.ecuName) };
    }
  }

  for (const step of workflow.steps) {
    signal?.throwIfAborted();
    if (failed) break; // stop at the first failure; report what already happened
    let r: WorkflowStepResult;
    try {
      if (step.kind === 'static') {
        r = await runStatic(client, step, signal);
      } else {
        touched.add(step.target.ecuName);
        const block = await readCodingBlock(client, step.target, step.feature.section, signal);
        const commit = await commitWrite(client, step.target, step.feature, buildProposal(block, step.option), signal);
        r = { order: step.order, kind: 'koding', ecuName: step.target.ecuName, ok: commit.status === 'VERIFIED', detail: commit.message };
        if (commit.status === 'VERIFIED') verified.add(step.target.ecuName);
      }
    } catch (error) {
      r = { order: step.order, kind: step.kind, ecuName: step.target.ecuName, ok: false, detail: msg(error) };
    }
    results.push(r);
    onStep(r);
    if (!r.ok) failed = true;
  }

  const unverified = [...touched].filter(e => !verified.has(e));
  const status: WorkflowResult['status'] = !failed ? 'SUCCESS' : verified.size > 0 ? 'PARTIAL' : 'FAILED';
  return { status, steps: results, verifiedEcus: [...verified], unverifiedEcus: unverified };
}

async function runStatic(client: MbitoClient, step: ResolvedStaticStep, signal?: AbortSignal): Promise<WorkflowStepResult> {
  if (step.step.type !== 'static') throw new Error('not a static step');
  const fn = step.step.static_function;
  const body = fromHex(fn.payload_to_get);
  const result = await execUds(client, { txId: step.target.txId, rxId: step.target.rxId, body, timeoutMs: fn.response_timout || 2000, delayAfterMs: 0, expectedResponseLength: fn.len_rec }, signal);
  // Some static steps (e.g. hard reset 11 01) legitimately return no usable frame; metadata says so.
  const ok = fn.ignore_response ? true : result.semantic === 'POSITIVE_RESPONSE' || result.presence === 'PRESENT';
  return { order: step.order, kind: 'static', ecuName: step.target.ecuName, ok, detail: `${toHex(body)} → ${result.semantic}${fn.is_hard_reset ? ' (reset)' : ''}` };
}

const msg = (e: unknown): string => (e instanceof Error ? e.message : String(e));
