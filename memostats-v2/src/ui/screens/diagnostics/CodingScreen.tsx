import { useEffect, useMemo, useState } from 'react';
import { toHex } from '../../../core/bytes';
import { listBackups, type CodingBackup } from '../../../coding/backupStore';
import { type CommitResult, type CodingTarget, buildProposal, decode } from '../../../coding/codingEngine';
import type { CodingFeatureModel } from '../../../coding/codingModel';
import { codingFeaturesForVariant } from '../../../coding/codingModel';
import { STATUS_BADGE, STATUS_LABEL, featureStatus, isWritable } from '../../../coding/featureStatus';
import { targetFromInventory } from '../../../coding/targets';
import { moduleCache } from '../../../diagnostics/moduleCache';
import { codingCommit, codingReadBlock, codingRestore } from '../../../state/actions';
import { inventoryEcus, parseCanId } from '../../../w176/catalog';
import type { W176Db, W176InventoryEcu } from '../../../w176/types';
import { useW176Db } from '../../../w176/useW176Db';
import { useCanTransmit } from '../../hooks';
import { ActionButton, HexBlock, SectionHeader, StatusBadge, TechnicalRow } from '../../components/primitives';
import { MultiFeaturePanel } from './MultiFeature';

// Coding: metadata-driven. Read/decode/preview/write with read-back verification for access-0 features;
// security- and sequence-gated features are shown read-only with their status. Nothing hardcoded per feature.
export function CodingScreen() {
  const cache = moduleCache.use();
  const { db, loading, error } = useW176Db();
  const [selected, setSelected] = useState<number | null>(null);
  const [backups, setBackups] = useState<CodingBackup[]>([]);
  const refreshBackups = () => { void listBackups().then(setBackups); };
  useEffect(refreshBackups, []);

  if (loading) return <p className="small text--muted">Se încarcă baza W176…</p>;
  if (error || !db) return <p className="notice notice--error">Baza W176 nu s-a putut încărca: {error ?? 'necunoscut'}</p>;

  const confirmedPairs = new Set(cache.valid ? cache.modules.map(m => `${m.module.txId}/${m.module.rxId}`) : []);
  const codeable = inventoryEcus(db).filter(e => confirmedPairs.has(`${parseCanId(e.transmit_id)}/${parseCanId(e.receive_id)}`));
  const ecu = codeable.find(e => e.ecu_id === selected) ?? codeable[0] ?? null;

  return (
    <div className="rows">
      <section className="card">
        <SectionHeader title="Coding" meta={<span className="tag">Access 0 · read-back</span>} />
        <p className="lede">Pornit în mod read-only. Scrierea se face doar după citire, backup și confirmare, iar succesul e marcat numai după recitire.</p>
        {codeable.length === 0
          ? <p className="small text--muted">Niciun ECU codabil confirmat. Rulează o scanare mai întâi.</p>
          : (
            <div className="chips">
              {codeable.map(e => (
                <button key={e.ecu_id} type="button" className={`chip${(ecu?.ecu_id === e.ecu_id) ? ' chip--on' : ''}`} onClick={() => setSelected(e.ecu_id)}>{e.display_name || e.name}</button>
              ))}
            </div>
          )}
      </section>

      {ecu && <EcuCoding db={db} ecu={ecu} backups={backups} onChanged={refreshBackups} />}
      <MultiFeaturePanel db={db} confirmedPairs={confirmedPairs} onChanged={refreshBackups} />
      {backups.length > 0 && <BackupList backups={backups} onChanged={refreshBackups} />}
    </div>
  );
}

function EcuCoding({ db, ecu, backups, onChanged }: { db: W176Db; ecu: W176InventoryEcu; backups: CodingBackup[]; onChanged: () => void }) {
  const target = targetFromInventory(ecu);
  const features = useMemo(() => codingFeaturesForVariant(db, ecu.variant_id), [db, ecu.variant_id]);
  const ctx = { ecuDetected: true, variantMatches: true, variantId: ecu.variant_id };
  const withStatus = features.map(f => ({ feature: f, status: featureStatus(f, ctx) }));
  const recommended = withStatus.filter(f => isWritable(f.status) && f.feature.readField && f.feature.options.length <= 3);
  const advanced = withStatus.filter(f => isWritable(f.status) && !(f.feature.readField && f.feature.options.length <= 3));
  const locked = withStatus.filter(f => !isWritable(f.status));

  return (
    <section className="card">
      <SectionHeader title={ecu.display_name || ecu.name} meta={<span className="eyebrow">{ecu.variant_name}</span>} />
      {recommended.length > 0 && <Group title="Recomandate">{recommended.map(f => <FeatureRow key={f.feature.featureId} target={target} feature={f.feature} status={f.status} backups={backups} onChanged={onChanged} />)}</Group>}
      {advanced.length > 0 && <Group title="Avansat">{advanced.map(f => <FeatureRow key={f.feature.featureId} target={target} feature={f.feature} status={f.status} advanced backups={backups} onChanged={onChanged} />)}</Group>}
      {locked.length > 0 && <Group title="Blocate">{locked.map(f => <LockedRow key={f.feature.featureId} feature={f.feature} badge={STATUS_BADGE[f.status]} label={STATUS_LABEL[f.status]} />)}</Group>}
    </section>
  );
}

const Group = ({ title, children }: { title: string; children: React.ReactNode }) => (
  <div className="rows" style={{ marginTop: 10 }}>
    <p className="eyebrow">{title}</p>
    <div className="list">{children}</div>
  </div>
);

function FeatureRow({ target, feature, status, advanced, backups, onChanged }: { target: CodingTarget; feature: CodingFeatureModel; status: ReturnType<typeof featureStatus>; advanced?: boolean; backups: CodingBackup[]; onChanged: () => void }) {
  const canTx = useCanTransmit();
  const [block, setBlock] = useState<Uint8Array | null>(null);
  const [optionId, setOptionId] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ tone: 'ok' | 'warn' | 'error' | 'muted'; text: string } | null>(null);
  const backup = backups.find(b => b.ecuId === target.ecuId && b.variantId === target.variantId && b.sectionId === feature.section.id);

  const current = block ? decode(block, feature) : null;
  const option = feature.options.find(o => o.optionId === optionId) ?? null;
  const proposal = block && option ? buildProposal(block, option) : null;

  const read = async () => {
    setBusy(true); setMsg(null);
    try {
      const b = await codingReadBlock(target, feature.section);
      setBlock(b);
      const d = decode(b, feature);
      setOptionId(d.currentOptionId);
    } catch (e) { setMsg({ tone: 'error', text: describe(e) }); }
    finally { setBusy(false); }
  };

  const write = async () => {
    if (!proposal || !option) return;
    const summary = [
      `ECU: ${target.ecuName} (${target.variantName})`, `Feature: ${feature.name}`,
      `Valoare curentă: ${current?.currentMeaning ?? '—'}`, `Valoare nouă: ${option.valueMeaning}`,
      `DID scriere: ${feature.section.writeHex}`, `Octeți modificați: ${proposal.changedBytes.join(', ') || 'niciunul'}`,
      'Backup-ul original va fi salvat înainte de scriere. Continui?',
    ].join('\n');
    if (!window.confirm(summary)) return;
    setBusy(true); setMsg(null);
    try {
      const result: CommitResult = await codingCommit(target, feature, proposal);
      setMsg({ tone: result.status === 'VERIFIED' ? 'ok' : 'error', text: result.message });
      if (result.verified) { setBlock(result.verified); setOptionId(decode(result.verified, feature).currentOptionId); }
      onChanged();
    } catch (e) { setMsg({ tone: 'error', text: describe(e) }); }
    finally { setBusy(false); }
  };

  const restore = async () => {
    if (!backup || !window.confirm(`Restaurezi valoarea originală salvată (${backup.optionMeaning}) pentru ${feature.name}?`)) return;
    setBusy(true); setMsg(null);
    try {
      const result = await codingRestore(backup);
      setMsg({ tone: result.status === 'VERIFIED' ? 'ok' : 'error', text: result.message });
      if (result.verified) setBlock(result.verified);
      onChanged();
    } catch (e) { setMsg({ tone: 'error', text: describe(e) }); }
    finally { setBusy(false); }
  };

  return (
    <details className="item">
      <summary>
        <div className="item__head">
          <div style={{ minWidth: 0 }}>
            <p className="item__title">{feature.name}</p>
            <p className="item__sub">{current?.currentMeaning ? `Curent: ${current.currentMeaning}` : feature.description || `DID ${feature.section.readHex}`}</p>
          </div>
          <StatusBadge tone={isWritable(status) ? 'ok' : 'warn'}>{STATUS_BADGE[status]}</StatusBadge>
        </div>
      </summary>
      <div className="rows">
        <TechnicalRow label="Secțiune / DID" mono value={`#${feature.section.id} · citire ${feature.section.readHex} · scriere ${feature.section.writeHex} · ${feature.section.codingLength} B`} />
        <TechnicalRow label="Stare" value={STATUS_LABEL[status]} tone={isWritable(status) ? 'ok' : 'warn'} />
        <div className="actions actions--row">
          <ActionButton variant="secondary" onClick={() => void read()} busy={busy} disabled={!canTx}>CITEȘTE</ActionButton>
          {backup && <ActionButton variant="quiet" onClick={() => void restore()} disabled={!canTx || busy}>RESTAUREAZĂ</ActionButton>}
        </div>
        {block && (
          <label className="field">
            <span className="eyebrow">Opțiune</span>
            <select value={optionId ?? ''} onChange={e => setOptionId(e.target.value === '' ? null : Number(e.target.value))}>
              <option value="">— alege —</option>
              {feature.options.map(o => <option key={o.optionId} value={o.optionId}>{o.valueMeaning}{o.optionId === current?.currentOptionId ? ' (curent)' : ''}</option>)}
            </select>
          </label>
        )}
        {proposal && proposal.changedBytes.length > 0 && (
          <>
            <TechnicalRow label="Se schimbă octeții" mono value={proposal.changedBytes.join(', ')} />
            {advanced && <><HexBlock label="Înainte" hex={toHex(proposal.before)} /><HexBlock label="După" hex={toHex(proposal.after)} /></>}
            <ActionButton onClick={() => void write()} busy={busy} disabled={!canTx}>SCRIE + VERIFICĂ</ActionButton>
          </>
        )}
        {block && current?.currentValue !== null && <TechnicalRow label="Valoare citită (biți)" mono value={String(current?.currentValue)} />}
        {msg && <p className={`small text--${msg.tone === 'muted' ? 'muted' : msg.tone}`}>{msg.text}</p>}
      </div>
    </details>
  );
}

function LockedRow({ feature, badge, label }: { feature: CodingFeatureModel; badge: string; label: string }) {
  return (
    <details className="item">
      <summary>
        <div className="item__head">
          <div style={{ minWidth: 0 }}>
            <p className="item__title">{feature.name}</p>
            <p className="item__sub">{feature.description || `DID ${feature.section.readHex}`}</p>
          </div>
          <StatusBadge tone="warn">{badge}</StatusBadge>
        </div>
      </summary>
      <div className="rows">
        <TechnicalRow label="Stare" value={label} tone="warn" />
        <TechnicalRow label="Secțiune / DID" mono value={`#${feature.section.id} · ${feature.section.readHex} · ${feature.section.codingLength} B`} />
        <TechnicalRow label="Access level" mono value={String(feature.section.accessLevel)} />
        {feature.section.dllName && <TechnicalRow label="DLL (metadata)" mono value={feature.section.dllName} />}
        <p className="small text--muted">Scrierea este dezactivată: fără algoritm SecurityAccess legitim sau secvență de activare completă. Se afișează doar metadatele.</p>
      </div>
    </details>
  );
}

function BackupList({ backups, onChanged }: { backups: CodingBackup[]; onChanged: () => void }) {
  const canTx = useCanTransmit();
  const [busy, setBusy] = useState<string | null>(null);
  const restore = async (b: CodingBackup) => {
    if (!window.confirm(`Restaurezi ${b.featureName} pe ${b.ecuName} la valoarea originală?`)) return;
    setBusy(b.id);
    try { await codingRestore(b); onChanged(); } finally { setBusy(null); }
  };
  return (
    <section className="card">
      <SectionHeader title="Backup-uri codare" meta={<span className="eyebrow">{backups.length}</span>} />
      <div className="list">
        {backups.map(b => (
          <details key={b.id} className="item">
            <summary>
              <div className="item__head">
                <div style={{ minWidth: 0 }}>
                  <p className="item__title">{b.featureName} · {b.optionMeaning}</p>
                  <p className="item__sub">{b.ecuName} · {new Date(b.timestamp).toLocaleString('ro-RO')}</p>
                </div>
                <StatusBadge tone={b.status === 'VERIFIED' ? 'ok' : b.status === 'RESTORED' ? 'active' : b.status === 'FAILED' ? 'error' : 'muted'}>{b.status}</StatusBadge>
              </div>
            </summary>
            <div className="rows">
              <TechnicalRow label="Original" mono value={b.originalBytes} />
              <TechnicalRow label="Propus" mono value={b.proposedBytes} />
              {b.verifiedBytes && <TechnicalRow label="Verificat" mono value={b.verifiedBytes} />}
              <ActionButton variant="quiet" onClick={() => void restore(b)} busy={busy === b.id} disabled={!canTx}>RESTAUREAZĂ ORIGINALUL</ActionButton>
            </div>
          </details>
        ))}
      </div>
    </section>
  );
}

const describe = (e: unknown): string => (e instanceof Error ? e.message : String(e));
