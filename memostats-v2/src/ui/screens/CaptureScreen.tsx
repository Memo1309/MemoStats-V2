import { useEffect, useState } from 'react';
import { type CaptureEvent, type CaptureFilter, EMPTY_FILTER, buildCsv, buildJson, buildTxt, filterEvents } from '../../capture/capture';
import { addMarker, captureStore, clearSession, copyText, downloadText, openSaved, refreshSaved } from '../../capture/captureStore';
import { hexByte, hexId } from '../../core/bytes';
import { startPassiveCapture, stopPassiveCapture } from '../../state/actions';
import { useAppState } from '../../state/appState';
import { ActionButton, ExpandablePanel, HexBlock, MetricCard, SectionHeader, StatusBadge, type Tone, TechnicalRow } from '../components/primitives';
import { useNow } from '../hooks';
import { formatClock, formatDateTime } from '../format';

const RENDER_LIMIT = 300;

export function CaptureScreen() {
  const cap = captureStore.use();
  const { connection } = useAppState();
  const capturing = cap.status === 'CAPTURING';
  const nowEpoch = performance.timeOrigin + useNow(capturing ? 1000 : 60_000); // ticks the running duration
  const [filter, setFilter] = useState<CaptureFilter>(EMPTY_FILTER);
  const [marker, setMarker] = useState('');
  const [notice, setNotice] = useState<string | null>(null);
  useEffect(() => { void refreshSaved(); }, []);

  const session = cap.session;
  const shown = filterEvents(cap.events, filter);
  const visible = shown.slice(-RENDER_LIMIT).reverse();
  const duration = session ? ((session.endedAt ? Date.parse(session.endedAt) : nowEpoch) - Date.parse(session.startedAt)) / 1000 : null;

  const exportAs = (ext: 'json' | 'txt' | 'csv') => {
    if (!session) return;
    const [text, mime] = ext === 'json' ? [buildJson(session, cap.events), 'application/json'] : ext === 'txt' ? [buildTxt(session, cap.events), 'text/plain'] : [buildCsv(cap.events), 'text/csv'];
    downloadText(`memostats-v2-${session.id}.${ext}`, text, mime);
  };
  const copyLog = () => {
    if (!session) return;
    copyText(buildTxt(session, cap.events)).then(
      () => setNotice(`Log copiat (${cap.events.length} evenimente).`),
      (error: unknown) => setNotice(`Copierea a eșuat: ${error instanceof Error ? error.message : String(error)}. Folosește EXPORT TXT.`),
    );
  };
  const confirmClear = () => {
    if (session && window.confirm(`Ștergi sesiunea ${session.id} (${session.packetCount} pachete)? Nu poate fi recuperată.`)) clearSession();
  };
  const submitMarker = () => {
    addMarker(marker);
    setMarker('');
  };

  return (
    <div className="screen">
      <div className="screen-title">
        <div>
          <p className="eyebrow">Captură</p>
          <h2>Captură BLE pasivă</h2>
        </div>
        {capturing ? <span className="badge badge--active badge--live">CAPTURING</span> : <StatusBadge tone="muted">READY</StatusBadge>}
      </div>

      <section className="card">
        <p className="lede">
          Înregistrează fiecare notificare BLE de pe FF01, inclusiv răspunsurile la acțiunile făcute în aplicația oficială MBito.
          Cât timp captura rulează, MemoStats nu transmite nimic: fără date live, scanări sau citiri.
        </p>
        <div className="stats stats--compact">
          <MetricCard label="PACHETE" value={session ? String(session.packetCount) : null} naText="—" />
          <MetricCard label="OCTEȚI" value={session ? String(session.byteCount) : null} naText="—" />
          <MetricCard label="DURATĂ" value={duration === null ? null : formatDuration(duration)} naText="—" />
          <MetricCard label="ULTIMUL RX" value={session?.lastRxAt ? formatClock(Date.parse(session.lastRxAt)) : null} naText="—" />
        </div>
        {capturing
          ? <ActionButton variant="secondary" onClick={stopPassiveCapture}>STOP CAPTURE</ActionButton>
          : <ActionButton onClick={startPassiveCapture}>START CAPTURE</ActionButton>}
        {!capturing && connection !== 'connected' && <p className="small text--muted">MBito nu este conectat: captura pornește, dar primește date doar după conectare.</p>}
        <div className="actions actions--row">
          <div className="field" style={{ flex: 2 }}>
            <input value={marker} onChange={e => setMarker(e.target.value)} onKeyDown={e => e.key === 'Enter' && submitMarker()} placeholder="Notă marker" disabled={!capturing} aria-label="Text marker" />
          </div>
          <ActionButton variant="secondary" onClick={submitMarker} disabled={!capturing}>ADD MARKER</ActionButton>
        </div>
        <div className="grid-2">
          <ActionButton variant="secondary" onClick={copyLog} disabled={!session}>COPY LOG</ActionButton>
          <ActionButton variant="secondary" onClick={() => exportAs('json')} disabled={!session}>EXPORT JSON</ActionButton>
          <ActionButton variant="secondary" onClick={() => exportAs('txt')} disabled={!session}>EXPORT TXT</ActionButton>
          <ActionButton variant="secondary" onClick={() => exportAs('csv')} disabled={!session}>EXPORT CSV</ActionButton>
        </div>
        <ActionButton variant="quiet" onClick={confirmClear} disabled={!session}>CLEAR SESSION</ActionButton>
        {session && session.unexpectedTxCount > 0 && (
          <p className="notice notice--error">{session.unexpectedTxCount} × UNEXPECTED MEMOSTATS TX — blocat, nimic nu a ajuns la dongle. Detalii în listă.</p>
        )}
        {cap.storageError && <p className="notice notice--warn">Salvare locală indisponibilă ({cap.storageError}). Captura continuă în memorie; exportă înainte de reîncărcare.</p>}
        {notice && <p className="small text--muted">{notice}</p>}
        {session && <p className="small text--muted mono">{session.id}{session.endedAt ? '' : capturing ? ' · în curs' : ' · întreruptă'}</p>}
      </section>

      <Filters filter={filter} onChange={setFilter} events={cap.events} />

      <section className="card">
        <SectionHeader title="Evenimente" meta={<span className="eyebrow">{shown.length}/{cap.events.length}</span>} />
        {shown.length > RENDER_LIMIT && <p className="small text--muted">Afișate ultimele {RENDER_LIMIT}; exportul conține tot.</p>}
        {cap.events.length === 0 && <p className="small text--muted">{capturing ? 'Aștept notificări…' : 'Nicio sesiune deschisă.'}</p>}
        <div className="list">{visible.map(e => <EventItem key={e.index} e={e} />)}</div>
      </section>

      <SavedCaptures disabled={capturing} openId={session?.id ?? null} />
    </div>
  );
}

function formatDuration(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

// ---------- filters ----------

function Filters({ filter, onChange, events }: { filter: CaptureFilter; onChange: (f: CaptureFilter) => void; events: readonly CaptureEvent[] }) {
  const set = (patch: Partial<CaptureFilter>) => onChange({ ...filter, ...patch });
  const toggleKind = (kind: CaptureFilter['kinds'][number]) =>
    set({ kinds: filter.kinds.includes(kind) ? filter.kinds.filter(k => k !== kind) : [...filter.kinds, kind] });
  const commands = [...new Set(events.flatMap(e => (e.kind === 'PACKET' && e.command ? [e.command] : [])))].sort();
  const chip = (on: boolean, label: string, onClick: () => void) => (
    <button key={label} type="button" className={`chip${on ? ' chip--on' : ''}`} aria-pressed={on} onClick={onClick}>{label}</button>
  );
  return (
    <ExpandablePanel title="Filtre">
      <div className="chips">
        {chip(filter.kinds.includes('RX'), 'RX', () => toggleKind('RX'))}
        {chip(filter.kinds.includes('TX'), 'TX', () => toggleKind('TX'))}
        {chip(filter.kinds.includes('MARKER'), 'MARKERE', () => toggleKind('MARKER'))}
        {chip(filter.execUdsOnly, 'EXEC_UDS', () => set({ execUdsOnly: !filter.execUdsOnly }))}
        {chip(filter.response === 'POSITIVE', 'POZITIV', () => set({ response: filter.response === 'POSITIVE' ? 'ANY' : 'POSITIVE' }))}
        {chip(filter.response === 'NEGATIVE', 'NEGATIV', () => set({ response: filter.response === 'NEGATIVE' ? 'ANY' : 'NEGATIVE' }))}
      </div>
      <div className="grid-2">
        <label className="field">
          <span className="eyebrow">Comandă</span>
          <select value={filter.command} onChange={e => set({ command: e.target.value })}>
            <option value="">toate</option>
            {commands.map(c => <option key={c} value={c}>{c}</option>)}
          </select>
        </label>
        <label className="field">
          <span className="eyebrow">CAN ID</span>
          <input value={filter.canId} onChange={e => set({ canId: e.target.value })} placeholder="622" inputMode="text" autoCapitalize="characters" />
        </label>
        <label className="field">
          <span className="eyebrow">Serviciu</span>
          <input value={filter.service} onChange={e => set({ service: e.target.value })} placeholder="62" autoCapitalize="characters" />
        </label>
        <label className="field">
          <span className="eyebrow">Căutare hex / text</span>
          <input value={filter.text} onChange={e => set({ text: e.target.value })} placeholder="50 03" />
        </label>
      </div>
      <ActionButton variant="quiet" onClick={() => onChange(EMPTY_FILTER)}>RESETEAZĂ FILTRELE</ActionButton>
    </ExpandablePanel>
  );
}

// ---------- events ----------

function eventBadge(e: Extract<CaptureEvent, { kind: 'PACKET' }>): { tone: Tone; text: string } {
  if (e.unexpectedTx) return { tone: 'error', text: 'TX NEAȘTEPTAT' };
  if (e.parserStatus === 'UNKNOWN') return { tone: 'warn', text: 'NEPARSAT' };
  if (e.response === 'POSITIVE') return { tone: 'ok', text: 'POZITIV' };
  if (e.response === 'NEGATIVE') return { tone: 'error', text: `NEGATIV${e.nrc === null ? '' : ` ${hexByte(e.nrc)}`}` };
  return { tone: 'muted', text: e.direction };
}

function EventItem({ e }: { e: CaptureEvent }) {
  const at = `#${e.index} · +${(e.relMs / 1000).toFixed(3)} s`;
  if (e.kind === 'MARKER') {
    return (
      <div className="item" style={{ borderColor: 'rgba(231, 182, 93, 0.45)' }}>
        <p className="item__title">◆ {e.text}</p>
        <p className="item__sub">{at} · MARKER</p>
      </div>
    );
  }
  const badge = eventBadge(e);
  return (
    <details className="item">
      <summary>
        <div className="item__head">
          <div style={{ minWidth: 0 }}>
            <p className="item__title">
              {e.direction} · {e.command ?? '?'}{e.canTx !== null && ` · ${hexId(e.canTx)}→${hexId(e.canRx ?? 0)}`}
            </p>
            <p className="item__sub">{at} · {e.length} B{e.decoded ? ` · ${e.decoded}` : ''}</p>
          </div>
          <StatusBadge tone={badge.tone}>{badge.text}</StatusBadge>
        </div>
      </summary>
      <div className="rows">
        <HexBlock label={`RAW · ${e.length} B`} hex={e.rawHex} />
        <TechnicalRow label="Timp" mono value={`${e.iso} · perf ${e.perfMs.toFixed(3)} ms`} />
        {e.rawCommand !== null && <TechnicalRow label="Cmd / arg / len" mono value={`${hexByte(e.rawCommand)} · ${hexByte(e.argument ?? 0)} · ${e.payloadLength ?? '?'}`} />}
        {e.payloadHex && <TechnicalRow label="Payload" mono value={e.payloadHex} />}
        {e.canTx !== null && <TechnicalRow label="CAN TX → RX" mono value={`${hexId(e.canTx)} → ${hexId(e.canRx ?? 0)}`} />}
        {e.respStatus !== null && <TechnicalRow label="resp_status" mono value={hexByte(e.respStatus)} />}
        {e.requestNr !== null && <TechnicalRow label="request_nr" mono value={e.requestNr} />}
        {e.diagHex && <TechnicalRow label="Diagnostic" mono value={e.diagHex} />}
        {e.service !== null && <TechnicalRow label="Serviciu" mono value={hexByte(e.service)} />}
        {e.nrc !== null && <TechnicalRow label="NRC" mono value={hexByte(e.nrc)} tone="error" />}
        {e.decoded && <TechnicalRow label="Decodat" value={e.decoded} />}
        <TechnicalRow label="Parser" mono value={`${e.parserStatus}${e.warnings.length ? ` · ${e.warnings.join('; ')}` : ''}`} tone={e.parserStatus === 'OK' ? undefined : 'warn'} />
        {e.unexpectedTx && <TechnicalRow label="Atenție" value="UNEXPECTED MEMOSTATS TX — blocat, netrimis" tone="error" />}
      </div>
    </details>
  );
}

// ---------- saved sessions ----------

function SavedCaptures({ disabled, openId }: { disabled: boolean; openId: string | null }) {
  const { saved } = captureStore.use();
  const [query, setQuery] = useState('');
  const q = query.trim().toLowerCase();
  const matches = saved.filter(s => !q || [s.id, s.device, s.firmware, formatDateTime(Date.parse(s.startedAt))].join(' ').toLowerCase().includes(q));
  return (
    <section className="card">
      <SectionHeader title="Capturi salvate" meta={<span className="eyebrow">{saved.length}</span>} />
      {saved.length > 0 && (
        <div className="field">
          <input value={query} onChange={e => setQuery(e.target.value)} placeholder="Caută după dată, ID, dongle" aria-label="Caută capturi" />
        </div>
      )}
      {saved.length === 0 && <p className="small text--muted">Nicio captură salvată pe acest dispozitiv.</p>}
      <div className="list">
        {matches.map(s => (
          <div key={s.id} className="item">
            <div className="item__head">
              <div style={{ minWidth: 0 }}>
                <p className="item__title mono">{s.id}</p>
                <p className="item__sub">
                  {formatDateTime(Date.parse(s.startedAt))} · {s.packetCount} pachete · {s.byteCount} B · {s.markerCount} markere
                  {!s.endedAt && ' · întreruptă'}{s.unexpectedTxCount > 0 && ` · ${s.unexpectedTxCount} TX neașteptat`}
                </p>
              </div>
              {s.id === openId
                ? <StatusBadge tone="active">DESCHISĂ</StatusBadge>
                : <ActionButton variant="secondary" onClick={() => void openSaved(s.id)} disabled={disabled}>DESCHIDE</ActionButton>}
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}
