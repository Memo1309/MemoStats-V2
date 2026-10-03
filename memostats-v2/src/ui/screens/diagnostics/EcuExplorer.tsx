import { useEffect } from 'react';
import { codingFeaturesForVariant } from '../../../coding/codingModel';
import { type ExplorerEntry, buildExplorerEntries } from '../../../diagnostics/explorerView';
import { knownInventoryStore } from '../../../diagnostics/knownInventory';
import { moduleCache } from '../../../diagnostics/moduleCache';
import { IDENTITY_LABEL } from '../../../diagnostics/presence';
import { log } from '../../../logs/logStore';
import { dtcDefinitionCount } from '../../../w176/catalog';
import { formatCanId } from '../../../w176/canId';
import { useW176Db } from '../../../w176/useW176Db';
import type { W176Db } from '../../../w176/types';
import { ExpandablePanel, SectionHeader, StatusBadge, TechnicalRow } from '../../components/primitives';
import { formatDateTime } from '../../format';

// ECU Explorer: shows the vehicle's ECUs — the persistent knownVehicleInventory merged with who replied in
// THIS scan (currentScanInventory). Modules that did not reply this scan are kept and marked "not detected in
// the current scan", never removed/missing/absent. The 47 non-vehicle candidates are never shown here (they
// live only in the Scan Protocol Log). Presence is from the scan; identity is resolved from the catalog.
export function EcuExplorer() {
  const cache = moduleCache.use();
  const known = knownInventoryStore.use();
  const { db, loading, error } = useW176Db();
  const entries = buildExplorerEntries(known.ecus, cache.valid ? cache.modules : [], db);
  const detectedNow = entries.filter(e => e.state === 'detected_now').length;
  const identified = entries.filter(e => e.identity?.status === 'identified').length;
  const hasScan = cache.valid || Object.keys(known.ecus).length > 0;

  useEffect(() => {
    if (!hasScan) return;
    log('SCAN', `ECU EXPLORER: ${entries.length} known · ${detectedNow} detected now · ${identified} identified`, { pairs: entries.map(e => `${formatCanId(e.txId)}→${formatCanId(e.rxId)}`).join(' ') || null });
  }, [entries, detectedNow, identified, hasScan]);

  return (
    <section className="card">
      <SectionHeader title="ECU Explorer" meta={<span className="eyebrow">{detectedNow}/{entries.length} · {identified} id.</span>} />
      {!hasScan && <p className="small text--muted">Nicio scanare încă în această sesiune. Rulează o scanare în fila Scanare.</p>}
      {cache.valid && entries.length === 0 && <p className="notice notice--warn">Scanare finalizată: 0 module au răspuns.</p>}
      {loading && entries.length > 0 && <p className="small text--muted">Metadatele W176 se încarcă… adresele sunt afișate imediat.</p>}
      {error && entries.length > 0 && <p className="notice notice--warn">Metadatele W176 nu s-au putut încărca ({error}). Se afișează adresele; identificarea completă lipsește.</p>}

      <div className="list">
        {entries.map(e => <EcuCard key={`${e.txId}/${e.rxId}`} e={e} db={db} />)}
      </div>
      {entries.length > 0 && (
        <p className="small text--muted">
          Inventar cunoscut al vehiculului + ce a răspuns la scanarea curentă. Modulele nedetectate acum sunt păstrate cu identitatea lor — nu înseamnă lipsă. Doar modulele vehiculului sunt afișate aici.
        </p>
      )}
    </section>
  );
}

const STATE_BADGE: Record<ExplorerEntry['state'], { tone: 'ok' | 'muted'; text: string }> = {
  detected_now: { tone: 'ok', text: 'DETECTAT ACUM' },
  not_detected: { tone: 'muted', text: 'NEDETECTAT ÎN SCANAREA CURENTĂ' },
};

function EcuCard({ e, db }: { e: ExplorerEntry; db: W176Db | null }) {
  const id = e.identity;
  const title = id?.displayName || id?.ecuName || e.scanName;
  const identified = id?.status === 'identified';
  const ambiguous = (id?.status ?? 'unresolved') !== 'identified' && (id?.possibleEcus.length ?? 0) > 1;
  const codingCount = db && id?.variantId ? codingFeaturesForVariant(db, id.variantId).length : 0;
  const measures = db && id?.ecuId ? db.diagnostics.measure_commands.filter(m => m.ecu_id === id.ecuId) : [];
  const dtcDefs = db ? dtcDefinitionCount(db, id?.ecuId ?? undefined) : 0;
  const stateBadge = STATE_BADGE[e.state];

  return (
    <details className="item">
      <summary>
        <div className="item__head">
          <div style={{ minWidth: 0 }}>
            <p className="item__title">{title}</p>
            <p className="item__sub">{id?.description ?? ''}{id?.group ? ` · ${id.group}` : ''}{ambiguous ? ` · ${id?.possibleEcus.length} familii posibile` : ''}</p>
          </div>
          <div style={{ display: 'flex', gap: 6, flexShrink: 0 }}>
            <StatusBadge tone={stateBadge.tone}>{e.state === 'detected_now' ? 'PREZENT' : 'CUNOSCUT'}</StatusBadge>
            <StatusBadge tone={identified ? 'ok' : id?.status === 'probable' ? 'warn' : 'muted'}>{identified ? 'IDENTIFICAT' : id?.status === 'probable' ? 'PROBABIL' : 'NEREZOLVAT'}</StatusBadge>
          </div>
        </div>
      </summary>
      <div className="rows">
        <TechnicalRow label="Stare scanare" value={stateBadge.text} tone={e.state === 'detected_now' ? 'ok' : 'warn'} />
        <TechnicalRow label="Identificare" value={IDENTITY_LABEL[id?.status ?? 'unresolved']} tone={identified ? 'ok' : id?.status === 'probable' ? 'warn' : undefined} />
        <TechnicalRow label="TX" mono value={formatCanId(e.txId)} />
        <TechnicalRow label="RX" mono value={formatCanId(e.rxId)} />
        {id?.variantName && <TechnicalRow label="Variantă" mono value={id.variantName} />}
        {id?.variantId != null && <TechnicalRow label="Variant ID" mono value={String(id.variantId)} />}
        {(id?.opCode || e.opCode) && <TechnicalRow label="Op-code" mono value={id?.opCode ?? e.opCode} />}
        {e.hardware && <TechnicalRow label="Hardware (F111)" mono value={e.hardware} />}
        {e.software && <TechnicalRow label="Software (F121)" mono value={e.software} />}
        {e.serialText && <TechnicalRow label="Serie (F18C)" mono value={e.serialText} />}
        {e.serialRawHex && <TechnicalRow label="Serie brută (F18C)" mono value={e.serialRawHex} />}
        {e.lastSeenAt && <TechnicalRow label="Văzut ultima dată" mono value={`${formatDateTime(e.lastSeenAt)} · de ${e.seenCount}×${e.missCount ? ` · ratat ${e.missCount}×` : ''}`} />}
        {db && id?.ecuId != null && <>
          <TechnicalRow label="Coding features" mono value={String(codingCount)} />
          <TechnicalRow label="Comenzi de măsură" mono value={String(measures.length)} />
          <TechnicalRow label="Definiții DTC (dicționar)" mono value={String(dtcDefs)} />
        </>}
        {!db && <p className="small text--muted">Detectat prin scanare. Identificarea completă din baza W176 se încarcă…</p>}
        {ambiguous && id && (
          <ExpandablePanel title={`Familii posibile pe această pereche (${id.possibleEcus.length})`} defaultOpen>
            {id.possibleEcus.map(m => <TechnicalRow key={m.ecuId} label={m.name} value={`${m.description} · ${m.group}`} />)}
          </ExpandablePanel>
        )}
      </div>
    </details>
  );
}
