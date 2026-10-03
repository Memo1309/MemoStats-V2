import { hexByte, hexId } from '../../core/bytes';
import { NRC_NAMES } from '../../core/uds/udsSemantics';
import { type DtcRecord, statusSummary } from '../../diagnostics/dtc/dtcCodec';
import type { ModuleDtcResult } from '../../diagnostics/dtc/dtcRead';
import { dtcStore, modulesWithFaults } from '../../diagnostics/dtc/dtcScan';
import { CATALOG_ENDPOINT_COUNT, type ModuleResult, type ScanState, scanStore } from '../../diagnostics/ecuScan';
import { type CachedModule, type DiscoveryState, type ModuleCacheState, type UnconfirmedModule, discoveryState, moduleCache } from '../../diagnostics/moduleCache';
import { historyStore, moduleKey } from '../../diagnostics/inventoryHistory';
import { moduleIdentity } from '../../diagnostics/identity';
import { IDENTITY_LABEL } from '../../diagnostics/presence';
import { type ScanLogState, scanLogStore, scanLogText } from '../../diagnostics/scanLog';
import { useW176Db } from '../../w176/useW176Db';
import { formatCanId } from '../../w176/canId';
import { copyText, downloadText } from '../../capture/captureStore';
import { obdInfoStore } from '../../diagnostics/obdInfo';
import { cancelEcuScan, readVehicleObdInfo, scanDtcs, startEcuScan } from '../../state/actions';
import { strobeCompatibility } from '../../vehicleActions/stroboscope/compatibility';
import { LAST_KNOWN_SCAN, type VehicleModule } from '../../vehicle/modules';
import { ActionButton, ExpandablePanel, MetricCard, SectionHeader, StatusBadge, TechnicalRow } from '../components/primitives';
import { formatClock, formatDateTime, formatMs } from '../format';
import { useCanTransmit } from '../hooks';
import { useState } from 'react';
import { EcuExplorer } from './diagnostics/EcuExplorer';
import { CodingScreen } from './diagnostics/CodingScreen';
import { MileageScreen } from './diagnostics/MileageScreen';

const DIAG_TABS = [
  { id: 'scan', label: 'SCANARE' },
  { id: 'explorer', label: 'ECU EXPLORER' },
  { id: 'coding', label: 'CODING' },
  { id: 'mileage', label: 'KILOMETRAJ' },
] as const;

export function DiagnosticsScreen() {
  const [view, setView] = useState<(typeof DIAG_TABS)[number]['id']>('scan');
  return (
    <div className="screen">
      <div className="segmented" role="tablist" aria-label="Secțiuni diagnoză">
        {DIAG_TABS.map(t => (
          <button key={t.id} type="button" role="tab" aria-pressed={view === t.id} onClick={() => setView(t.id)}>{t.label}</button>
        ))}
      </div>
      {view === 'scan' && <ScanView />}
      {view === 'explorer' && <EcuExplorer />}
      {view === 'coding' && <CodingScreen />}
      {view === 'mileage' && <MileageScreen />}
    </div>
  );
}

function ScanView() {
  const scan = scanStore.use();
  const cache = moduleCache.use();
  const dtc = dtcStore.use();
  const canTx = useCanTransmit();
  const busy = scan.status === 'running' || dtc.status === 'running';
  const found = scan.results.filter(r => r.status === 'RESPONDS').length;
  // confirmed / scanned — both counted from protocol responses, never assumed
  const detected = scan.status === 'running'
    ? `${found}/${scan.pass === 1 ? scan.done : CATALOG_ENDPOINT_COUNT}`
    : cache.valid ? `${cache.modules.length}/${cache.scanned}` : null;
  const faults = modulesWithFaults(dtc);
  const codeCount = faults.reduce((n, r) => n + r.records.length, 0);
  const dtcDone = dtc.status === 'done';

  return (
    <div className="screen">
      <div className="screen-title">
        <div>
          <p className="eyebrow">Diagnoză</p>
          <h2>Starea vehiculului</h2>
        </div>
        <span className="tag">Read only</span>
      </div>

      {cache.valid && scan.newKeys.length > 0 && <p className="notice"><span className="text--ok">●</span> {scan.newKeys.length} {scan.newKeys.length === 1 ? 'modul nou detectat' : 'module noi detectate'}</p>}

      <div className="stats stats--3">
        <MetricCard label="PREZENTE / SCANATE" value={detected} naText="NESCANAT" />
        <MetricCard label="MODULE CU ERORI" value={dtcDone ? String(faults.length) : null} naText="NESCANAT" />
        <MetricCard label="CODURI DTC" value={dtcDone ? String(codeCount) : null} naText="NESCANAT" />
      </div>

      <section className="card">
        <p className="lede">
          Doar citire: sesiune <span className="mono">10 03</span>, identificare <span className="mono">22 F1 00 / 8C / 11 / 21</span>, erori{' '}
          <span className="mono">19 01 / 19 02</span>. Nicio ștergere de erori, nicio scriere. Datele live se opresc pe durată.
        </p>
        {busy && (scan.status === 'running'
          ? <Progress label={`Module · trecerea ${scan.pass}`} done={scan.done} total={scan.total} current={scan.current} />
          : <Progress label="Erori" done={dtc.done} total={dtc.total} current={dtc.current} />)}
        <div className="actions">
          {busy
            ? <ActionButton variant="secondary" onClick={cancelEcuScan}>ANULEAZĂ</ActionButton>
            : (
              <>
                <ActionButton onClick={() => void scanDtcs()} disabled={!canTx}>SCANEAZĂ ERORI</ActionButton>
                <ActionButton variant="secondary" onClick={() => void startEcuScan()} disabled={!canTx}>
                  {cache.valid ? 'RESCANEAZĂ ECU' : 'SCANARE ECU'} · {CATALOG_ENDPOINT_COUNT}
                </ActionButton>
              </>
            )}
        </div>
        {cache.valid && cache.scannedAt && (
          <p className="small text--muted">
            {cache.modules.length} prezente din {cache.scanned} scanate · {cache.scanned - cache.modules.length} fără răspuns (scanare {formatClock(cache.scannedAt)}). Rămân prezente până la deconectare sau RESCANEAZĂ ECU. Restul sunt candidați care nu au răspuns, nu module lipsă.
          </p>
        )}
        <p className="small text--muted">
          Scanarea verifică pe rând toate cele {CATALOG_ENDPOINT_COUNT} perechi W176 cunoscute, apoi reîncearcă o dată pe cele fără răspuns.
          Referință: scanarea MBito din {LAST_KNOWN_SCAN.date} a raportat {LAST_KNOWN_SCAN.detected} module.
        </p>
      </section>

      {(dtcDone || dtc.results.length > 0) && <FaultsSection />}
      <ModuleList />
      <ScanLogPanel />
      <ReadinessCard />
      <StrobeCard />
    </div>
  );
}

function Progress({ label, done, total, current }: { label: string; done: number; total: number; current: string | null }) {
  return (
    <>
      <div className="progress" aria-hidden="true"><span style={{ width: `${total ? (done / total) * 100 : 0}%` }} /></div>
      <p className="small text--muted mono">{label} · {current ?? '…'} · {done}/{total}</p>
    </>
  );
}

// ---------- faults ----------

function FaultsSection() {
  const dtc = dtcStore.use();
  const faults = modulesWithFaults(dtc);
  const unread = dtc.results.filter(r => r.status !== 'OK');
  return (
    <section className="card">
      <SectionHeader title="Erori" meta={dtc.status === 'running' ? <StatusBadge tone="warn">CITIRE…</StatusBadge> : undefined} />
      {dtc.status === 'done' && faults.length === 0 && <p className="lede">Nicio eroare raportată de modulele care au răspuns.</p>}
      {dtc.descriptionError && <p className="notice notice--warn">Descrierile nu s-au putut încărca ({dtc.descriptionError}). Codurile de mai jos sunt cele raportate de mașină.</p>}
      <div className="list">
        {faults.flatMap(result => result.records.map(record => <DtcCard key={`${result.module.name}-${record.rawCode}`} result={result} record={record} />))}
      </div>
      {unread.length > 0 && (
        <p className="small text--muted">
          Fără citire erori: {unread.map(r => `${r.module.name} (${readLabel(r)})`).join(', ')}. Acestea nu sunt defecte ale mașinii.
        </p>
      )}
    </section>
  );
}

function readLabel(r: ModuleDtcResult): string {
  if (r.status === 'NEGATIVE') return `refuz ${hexByte(r.nrc ?? 0)}`;
  if (r.status === 'PENDING') return 'răspuns întârziat';
  if (r.status === 'INVALID') return 'răspuns neclar';
  return 'fără răspuns';
}

function DtcCard({ result, record }: { result: ModuleDtcResult; record: DtcRecord }) {
  const { descriptions } = dtcStore.use();
  const description = descriptions[record.code];
  const text = description?.texts[0];
  const flagNames = Object.entries(record.flags).filter(([, on]) => on).map(([name]) => name);
  return (
    <details className="item">
      <summary>
        <div className="item__head">
          <div style={{ minWidth: 0 }}>
            <p className="item__title mono">{record.code}</p>
            <p className="item__sub">{result.module.name} · {statusSummary(record.flags)}</p>
          </div>
          <StatusBadge tone={record.flags.confirmedDTC || record.flags.testFailed ? 'error' : 'warn'}>{record.flags.confirmedDTC ? 'CONFIRMAT' : 'MEMORAT'}</StatusBadge>
        </div>
        <p className="lede" style={{ marginTop: 8 }}>{text ?? (descriptions[record.code] ? 'Descriere necunoscută' : 'Descriere în curs de încărcare…')}</p>
        {description && description.confidence !== 'UNKNOWN' && (
          <p className="small text--muted">Descriere generică din baza MBito — neconfirmată pentru această variantă ECU.</p>
        )}
      </summary>
      <div className="rows">
        <TechnicalRow label="Octeți DTC" mono value={record.rawCode.replace(/(..)(..)(..)/, '$1 $2 $3')} />
        <TechnicalRow label="Octet stare" mono value={hexByte(record.statusByte)} />
        <TechnicalRow label="Biți stare" mono value={flagNames.join(', ') || 'niciunul'} />
        <TechnicalRow label="Familie ECU" mono value={result.family} />
        <TechnicalRow label="Răspuns brut" mono value={result.rawResponse} />
        <TechnicalRow label="Sursă descriere" mono value={description?.confidence ?? null} />
      </div>
      {description && description.texts.length > 1 && (
        <ExpandablePanel title={`Alte ${description.texts.length - 1} descrieri candidate`}>
          {description.texts.slice(1).map(t => <p key={t} className="small">{t}</p>)}
        </ExpandablePanel>
      )}
    </details>
  );
}

// ---------- modules ----------

type ModuleView = {
  probeResponse: string | null;
  f100: string | null;
  opCode: string | null;
  variantMatches: boolean | null;
  probeMs?: number | null;
  failures?: number;
  ids: ModuleResult['ids'];
  confirmedBy: CachedModule['confirmedBy'];
  session: CachedModule['session'];
  pass?: 2;
};

/** Confirmed modules: responders so far while scanning, the session cache afterwards. */
function confirmedModules(scan: ScanState, cache: ModuleCacheState): { module: VehicleModule; view: ModuleView }[] {
  if (scan.status === 'running') {
    return scan.results.filter(r => r.status === 'RESPONDS').map(r => ({ module: r.module, view: { ...r, confirmedBy: '0x33' as const } }));
  }
  if (!cache.valid) return [];
  return cache.modules.map(c => ({ module: c.module, view: { ...c, failures: c.consecutiveFailures } }));
}

function unconfirmedModules(scan: ScanState, cache: ModuleCacheState): UnconfirmedModule[] {
  if (scan.status === 'running') {
    return scan.results.flatMap(r => {
      const state = discoveryState(r.status);
      return state === 'CONFIRMED' ? [] : [{ module: r.module, state, status: r.status, probeResponse: r.probeResponse, error: r.error }];
    });
  }
  return cache.valid ? cache.unconfirmed : [];
}

const STATE_BADGE: Record<DiscoveryState, { tone: 'ok' | 'muted' | 'error'; text: string }> = {
  CONFIRMED: { tone: 'ok', text: 'PREZENT' },
  NO_RESPONSE: { tone: 'muted', text: 'FĂRĂ RĂSPUNS' },
  COMM_ERROR: { tone: 'error', text: 'EROARE COMUNICAȚIE' },
};

function StateBadge({ state }: { state: DiscoveryState }) {
  return <StatusBadge tone={STATE_BADGE[state].tone}>{STATE_BADGE[state].text}</StatusBadge>;
}

function unconfirmedDetail(u: UnconfirmedModule): string {
  if (u.status === 'HOST_TIMEOUT') return 'fără cadru B3 de la dongle';
  if (u.status === 'ERROR') return u.error ?? 'eroare BLE';
  return 'slot CAN zero';
}

/** Diagnostic status of the 0x33 reply, kept next to the raw frame. */
function sessionText(frame: string, session: CachedModule['session']): string {
  if (session === 'ACCEPTED') return 'sesiune acceptată';
  if (session === 'REJECTED') {
    const nrc = parseInt(frame.split(' ')[2] ?? '', 16);
    return `sesiune refuzată${Number.isNaN(nrc) ? '' : ` · NRC ${hexByte(nrc)}${NRC_NAMES[nrc] ? ` ${NRC_NAMES[nrc]}` : ''}`}`;
  }
  return 'alt răspuns';
}

function ModuleList() {
  const scan = scanStore.use();
  const cache = moduleCache.use();
  const dtc = dtcStore.use();
  const history = historyStore.use();
  const { db } = useW176Db();
  const confirmed = confirmedModules(scan, cache);
  const unconfirmed = unconfirmedModules(scan, cache);
  const confirmedKeys = new Set(confirmed.map(d => moduleKey(d.module.txId, d.module.rxId)));
  // History can only say "seen before" — such modules are named once, never listed as confirmed.
  const missing = cache.valid ? Object.entries(history.modules).filter(([key]) => !confirmedKeys.has(key)).map(([, h]) => h.name) : [];
  const commErrors = unconfirmed.filter(u => u.state === 'COMM_ERROR').length;

  return (
    <section className="card">
      <SectionHeader title="Module prezente" meta={<span className="eyebrow">{confirmed.length}</span>} />
      {confirmed.length === 0 && (
        <p className="small text--muted">
          {scan.status === 'running' ? 'Niciun modul prezent încă…' : cache.valid ? 'Scanare finalizată: 0 module au răspuns.' : 'Nicio scanare în această sesiune. Apasă SCANARE ECU.'}
        </p>
      )}
      <div className="list">
        {confirmed.map(({ module, view: result }) => {
          const key = moduleKey(module.txId, module.rxId);
          const seen = history.modules[key];
          const dtcCount = dtc.results.find(r => r.module.txId === module.txId && r.module.rxId === module.rxId && r.status === 'OK')?.records.length ?? 0;
          return (
            <details key={key} className="item">
              <summary>
                <div className="item__head">
                  <div style={{ minWidth: 0 }}>
                    <p className="item__title">
                      {module.name}
                      {cache.valid && scan.newKeys.includes(key) && <span className="tag" style={{ marginLeft: 8 }}>NOU</span>}
                    </p>
                    <p className="item__sub">{module.variantName}</p>
                  </div>
                  <div style={{ display: 'flex', gap: 6, flexShrink: 0 }}>
                    {dtcCount > 0 && <StatusBadge tone="error">{dtcCount} DTC</StatusBadge>}
                    <StateBadge state="CONFIRMED" />
                    {(() => { const id = moduleIdentity(db, module, result.opCode); return <StatusBadge tone={id.status === 'identified' ? 'ok' : id.status === 'probable' ? 'warn' : 'muted'}>{id.status === 'identified' ? 'IDENTIFICAT' : id.status === 'probable' ? 'PROBABIL' : 'NEREZOLVAT'}</StatusBadge>; })()}
                  </div>
                </div>
              </summary>
              <div className="rows">
                <TechnicalRow label="TX → RX" mono value={`${hexId(module.txId)} → ${hexId(module.rxId)}`} />
                <TechnicalRow label="Prezență" value="Prezent (răspuns diagnostic pe TX/RX) — rămâne prezent chiar dacă identitatea e nerezolvată" tone="ok" />
                <TechnicalRow label="Identificare" value={IDENTITY_LABEL[moduleIdentity(db, module, result.opCode).status]} tone={moduleIdentity(db, module, result.opCode).status === 'identified' ? 'ok' : undefined} />
                <TechnicalRow label="Confirmat prin" mono value={result.confirmedBy === '0x40' ? '0x40 · răspuns pozitiv' : `0x33 · răspuns CAN${result.pass === 2 ? ' (reîncercare)' : ''}`} />
                <TechnicalRow label="Grup" value={module.group} />
                <TechnicalRow label="Tip" mono value={module.type} />
                {module.opCode && <TechnicalRow label="Op code (catalog)" mono value={module.opCode} />}
                <TechnicalRow label="Sesiune 10 03" mono value={result.probeResponse && `${result.probeResponse} · ${sessionText(result.probeResponse, result.session)}`} tone={result.session === 'ACCEPTED' ? undefined : 'warn'} />
                {result.f100 && <TechnicalRow label="F100" mono value={result.f100} />}
                {result.opCode && (
                  <TechnicalRow label="Op code citit" mono value={`${result.opCode}${result.variantMatches ? ' · = catalog' : ' · diferit'}`} tone={result.variantMatches ? 'ok' : 'warn'} />
                )}
                {Object.entries(result.ids).map(([did, value]) => <TechnicalRow key={did} label={did} mono value={value.text ?? value.raw} />)}
                {result.probeMs !== undefined && <TechnicalRow label="Timp răspuns" mono value={formatMs(result.probeMs)} />}
                {result.failures !== undefined && result.failures > 0 && (
                  <TechnicalRow label="Cereri fără răspuns" mono value={`${result.failures} consecutive · rămâne confirmat`} tone="warn" />
                )}
                {seen && <TechnicalRow label="Istoric" mono value={`văzut de ${seen.seenCount}× · ultima ${formatDateTime(seen.lastSeenAt)}${seen.missCount ? ` · ratat ${seen.missCount}×` : ''}`} />}
              </div>
            </details>
          );
        })}
      </div>
      {unconfirmed.length > 0 && (
        <ExpandablePanel title={`Fără răspuns / eroare · ${unconfirmed.length - commErrors} fără răspuns · ${commErrors} eroare comunicație`}>
          <p className="small text--muted">
            FĂRĂ RĂSPUNS = sonda 0x33 s-a încheiat cu slotul CAN gol la această scanare, inclusiv la reîncercare. Nu înseamnă că modulul lipsește:
            unele module răspund doar prin 0x40 (ex. MED40 0x7E0→0x7E8) și devin CONFIRMAT la primul răspuns pozitiv.
            EROARE COMUNICAȚIE = dongle-ul nu a trimis cadrul B3.
          </p>
          <div className="list">
            {unconfirmed.map(u => (
              <div key={moduleKey(u.module.txId, u.module.rxId)} className="item">
                <div className="item__head">
                  <div style={{ minWidth: 0 }}>
                    <p className="item__title">{u.module.name}</p>
                    <p className="item__sub">{hexId(u.module.txId)} → {hexId(u.module.rxId)} · {unconfirmedDetail(u)}</p>
                  </div>
                  <StateBadge state={u.state} />
                </div>
              </div>
            ))}
          </div>
        </ExpandablePanel>
      )}
      {missing.length > 0 && <p className="small text--muted">Văzute anterior, fără răspuns la scanarea curentă: {missing.join(', ')}.</p>}
    </section>
  );
}

// ---------- readiness / VIN ----------

function ReadinessCard() {
  const info = obdInfoStore.use();
  const canTx = useCanTransmit();
  const r = info.readiness;
  const supported = r?.monitors.filter(m => m.supported) ?? [];
  return (
    <section className="card">
      <SectionHeader title="Readiness & VIN" meta={<span className="tag">OBD · read only</span>} />
      {r && (
        <div className="rows">
          <TechnicalRow label="Martor motor (MIL)" value={r.milOn ? 'APRINS' : 'stins'} tone={r.milOn ? 'error' : 'ok'} />
          <TechnicalRow label="Erori emisii (OBD)" mono value={r.emissionDtcCount} />
          {supported.map(m => <TechnicalRow key={m.name} label={m.name} value={m.complete ? 'complet' : 'incomplet'} tone={m.complete ? 'ok' : 'warn'} />)}
        </div>
      )}
      {info.status === 'done' && !r && <p className="notice">Motorul nu a răspuns la readiness ({info.readinessRaw ?? 'fără date'}).</p>}
      {info.status === 'done' && <TechnicalRow label="VIN" mono value={info.vin ?? (info.vinRaw ? `nedecodat: ${info.vinRaw}` : 'indisponibil')} />}
      {info.status === 'error' && <p className="notice notice--error">{info.error}</p>}
      <div className="actions">
        <ActionButton variant="secondary" onClick={() => void readVehicleObdInfo()} busy={info.status === 'running'} disabled={!canTx}>CITEȘTE READINESS</ActionButton>
      </div>
    </section>
  );
}

// ---------- vehicle functions ----------

function StrobeCard() {
  const cache = moduleCache.use();
  const compat = strobeCompatibility(cache.modules.map(m => ({ module: m.module, status: 'RESPONDS' })));
  const state = (ok: boolean) => (!cache.valid ? 'nescanat' : ok ? 'răspunde' : 'nedetectat');
  return (
    <section className="card">
      <SectionHeader title="Funcții vehicul" />
      <div className="item">
        <div className="item__head">
          <div>
            <p className="item__title">STROBOSCOP</p>
            <p className="item__sub">HLI_FL176 {state(compat.leftResponds)} · HLI_FR176 {state(compat.rightResponds)}</p>
          </div>
          <span className="stage">Verificare</span>
        </div>
        <p className="small text--warn" style={{ marginTop: 8 }}>COMPATIBILITATE ÎN CURS DE VERIFICARE</p>
        <p className="small text--muted">Funcția este dezactivată. Nicio comandă nu este trimisă către vehicul.</p>
      </div>
    </section>
  );
}


// ---------- scan protocol log (developer; independent of Passive Capture) ----------

function ScanLogPanel() {
  const state = scanLogStore.use();
  if (state.entries.length === 0 && !state.summary) return null;
  const s = state.summary;
  const copy = () => void copyText(scanLogText(state)).catch(() => undefined);
  const save = () => downloadText(`memostats-v2-scan-log-${new Date().toISOString().replace(/[:.]/g, '-')}.txt`, scanLogText(state), 'text/plain');
  return (
    <section className="card">
      <SectionHeader title="Jurnal scanare (dezvoltator)" meta={<span className="eyebrow">{state.entries.length}</span>} />
      <p className="small text--muted">Tranzacțiile reale BLE/UDS ale scanării. Independent de Captura Pasivă (captura blochează TX, scanarea transmite — rămân exclusive).</p>
      {s && (
        <div className="stats stats--compact">
          <MetricCard label="CANDIDAȚI" value={String(s.candidates)} />
          <MetricCard label="PREZENTE" value={String(s.present)} />
          <MetricCard label="FĂRĂ RĂSPUNS" value={String(s.absent)} />
          <MetricCard label="ERORI" value={String(s.errors)} />
        </div>
      )}
      <div className="actions actions--row">
        <ActionButton variant="secondary" onClick={copy} disabled={state.entries.length === 0}>COPY LOG</ActionButton>
        <ActionButton variant="secondary" onClick={save} disabled={state.entries.length === 0}>EXPORT TXT</ActionButton>
      </div>
      <ScanLogList state={state} />
    </section>
  );
}

function ScanLogList({ state }: { state: ScanLogState }) {
  const shown = state.entries.slice(-200).reverse();
  return (
    <ExpandablePanel title={`Tranzacții (${state.entries.length})`}>
      <div className="list">
        {shown.map(e => (
          <details key={`${e.seq}-${e.kind}-${e.txId}-${e.rxId}`} className="item">
            <summary>
              <div className="item__head">
                <div style={{ minWidth: 0 }}>
                  <p className="item__title">#{e.seq} {formatCanId(e.txId)} → {formatCanId(e.rxId)}</p>
                  <p className="item__sub">trecere {e.pass} · {e.kind} · {e.reason}</p>
                </div>
                {e.presence && <StatusBadge tone={e.presence === 'present' ? 'ok' : e.presence === 'absent' ? 'muted' : 'error'}>{e.presence === 'present' ? 'PREZENT' : e.presence === 'absent' ? 'FĂRĂ RĂSPUNS' : 'EROARE'}</StatusBadge>}
              </div>
            </summary>
            <div className="rows">
              {e.requestHex && <TechnicalRow label="TX brut" mono value={e.requestHex} />}
              <TechnicalRow label="RX brut" mono value={e.responseHex ?? '(niciun cadru)'} />
              {e.parsed && <TechnicalRow label="CAN / parsat" mono value={e.parsed} />}
              {e.outerStatus && <TechnicalRow label="Stare exterioară" mono value={e.outerStatus} />}
              {e.udsPayload && <TechnicalRow label="UDS" mono value={e.udsPayload} />}
              <TechnicalRow label="Motiv" value={e.reason} />
            </div>
          </details>
        ))}
      </div>
    </ExpandablePanel>
  );
}
