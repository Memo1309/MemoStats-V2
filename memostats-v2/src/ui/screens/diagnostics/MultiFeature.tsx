import { useMemo, useState } from 'react';
import { type ResolvedWorkflow, type WorkflowResult, type WorkflowStepResult, resolveWorkflow } from '../../../coding/multiFeature';
import { connectDongle, runCodingWorkflow } from '../../../state/actions';
import { parseCanId } from '../../../w176/catalog';
import type { W176Db } from '../../../w176/types';
import { useAppState } from '../../../state/appState';
import { useCanTransmit } from '../../hooks';
import { ActionButton, SectionHeader, StatusBadge, TechnicalRow } from '../../components/primitives';

// Multi-ECU workflows (spec §13/§14), e.g. Blue Welcome Light Extender. Steps run in the exact DB order;
// a partial result is reported explicitly. Only runs when every koding step is access-0 writable.
export function MultiFeaturePanel({ db, confirmedPairs, onChanged }: { db: W176Db; confirmedPairs: Set<string>; onChanged: () => void }) {
  const workflows = useMemo(() => {
    return Object.entries(db.coding.multi_feature_workflows)
      .map(([id, w]) => ({ id: Number(id), name: w.feature_name, optionKeys: Object.keys(w.options), workflow: w }))
      .filter(({ workflow }) => Object.values(workflow.options)[0]?.steps.every(s => confirmedPairs.has(`${parseCanId(s.transmit_id)}/${parseCanId(s.receive_id)}`)));
  }, [db, confirmedPairs]);

  if (workflows.length === 0) return null;
  return (
    <section className="card">
      <SectionHeader title="Funcții multi-ECU" meta={<span className="eyebrow">{workflows.length}</span>} />
      <div className="list">
        {workflows.map(w => <WorkflowRow key={w.id} db={db} featureId={w.id} name={w.name} optionKeys={w.optionKeys} onChanged={onChanged} />)}
      </div>
    </section>
  );
}

function WorkflowRow({ db, featureId, name, optionKeys, onChanged }: { db: W176Db; featureId: number; name: string; optionKeys: string[]; onChanged: () => void }) {
  const { connection } = useAppState();
  const canTx = useCanTransmit();
  const [optionKey, setOptionKey] = useState<string>(optionKeys[0] ?? '');
  const [busy, setBusy] = useState(false);
  const [steps, setSteps] = useState<WorkflowStepResult[]>([]);
  const [result, setResult] = useState<WorkflowResult | null>(null);
  const resolved: ResolvedWorkflow | null = useMemo(() => resolveWorkflow(db, featureId, optionKey), [db, featureId, optionKey]);

  const run = async () => {
    if (!resolved) return;
    const summary = [`Funcție: ${name}`, `Opțiune: ${resolved.optionMeaning}`, `ECU-uri: ${resolved.ecus.map(e => e.ecuName).join(', ')}`, `Pași: ${resolved.steps.length} (în ordinea din bază)`, 'Fiecare ECU va fi salvat înainte de scriere. Continui?'].join('\n');
    if (!window.confirm(summary)) return;
    setBusy(true); setSteps([]); setResult(null);
    try {
      const r = await runCodingWorkflow(resolved, s => setSteps(prev => [...prev, s]));
      setResult(r);
      onChanged();
    } catch (e) {
      setResult({ status: 'FAILED', steps: [], verifiedEcus: [], unverifiedEcus: [] });
      setSteps(prev => [...prev, { order: -1, kind: 'static', ecuName: '', ok: false, detail: e instanceof Error ? e.message : String(e) }]);
    } finally { setBusy(false); }
  };

  return (
    <details className="item">
      <summary>
        <div className="item__head">
          <div style={{ minWidth: 0 }}>
            <p className="item__title">{name}</p>
            <p className="item__sub">{resolved ? `${resolved.ecus.map(e => e.ecuName).join(' + ')} · ${resolved.steps.length} pași` : 'workflow indisponibil'}</p>
          </div>
          <StatusBadge tone={!resolved?.writable ? 'warn' : canTx ? 'ok' : connection === 'connected' ? 'warn' : 'muted'}>
            {!resolved?.writable ? 'Blocat' : canTx ? 'Disponibil' : connection === 'connected' ? 'Captură activă' : 'Necesită conexiune'}
          </StatusBadge>
        </div>
      </summary>
      <div className="rows">
        <label className="field">
          <span className="eyebrow">Opțiune</span>
          <select value={optionKey} onChange={e => setOptionKey(e.target.value)}>
            {optionKeys.map(k => <option key={k} value={k}>{db.coding.multi_feature_workflows[String(featureId)]?.options[k]?.value_meaning ?? k}</option>)}
          </select>
        </label>
        {resolved && !resolved.writable && <p className="small text--warn">{resolved.blockedReason ?? 'Un pas necesită SecurityAccess sau o secvență neimplementată.'}</p>}
        {resolved?.writable && connection !== 'connected' && (
          <>
            <p className="small text--warn">MBito nu este conectat. Reconectează adaptorul pentru a executa workflow-ul.</p>
            <ActionButton onClick={() => void connectDongle()} busy={connection === 'connecting'}>
              {connection === 'lost' ? 'RECONECTEAZĂ MBITO' : 'CONECTEAZĂ MBITO'}
            </ActionButton>
          </>
        )}
        {resolved?.writable && connection === 'connected' && !canTx && (
          <p className="small text--warn">Captura pasivă este activă. Oprește captura înainte de coding.</p>
        )}
        {resolved?.writable && connection === 'connected' && (
          <ActionButton onClick={() => void run()} busy={busy} disabled={!canTx}>EXECUTĂ ({resolved.steps.length} pași)</ActionButton>
        )}
        {steps.length > 0 && (
          <div className="rows">
            {steps.map((s, i) => <TechnicalRow key={i} label={`#${s.order} ${s.ecuName} ${s.kind}`} value={s.detail} tone={s.ok ? 'ok' : 'error'} />)}
          </div>
        )}
        {result && (
          <p className={`notice ${result.status === 'SUCCESS' ? '' : result.status === 'PARTIAL' ? 'notice--warn' : 'notice--error'}`}>
            {result.status === 'SUCCESS' ? 'Toți pașii verificați.' : result.status === 'PARTIAL' ? `Activare parțială — verificate: ${result.verifiedEcus.join(', ')}; neverificate: ${result.unverifiedEcus.join(', ')}.` : 'Workflow eșuat.'}
          </p>
        )}
      </div>
    </details>
  );
}
