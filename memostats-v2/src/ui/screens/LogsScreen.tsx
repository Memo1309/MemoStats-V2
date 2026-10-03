import { useState, useSyncExternalStore } from 'react';
import { type LogCategory, type LogEntry, formatLogEntry, formatLogTime, logStore } from '../../logs/logStore';
import { getState } from '../../state/appState';
import { ActionButton, SectionHeader } from '../components/primitives';

// Rendering thousands of rows on a phone is pointless; everything stays in COPY/EXPORT.
const RENDER_LIMIT = 300;

export function LogsScreen() {
  const entries = useSyncExternalStore(logStore.subscribe, logStore.getSnapshot);
  const [filter, setFilter] = useState<LogCategory | 'TOATE'>('TOATE');
  const [notice, setNotice] = useState<string>();

  const categories = [...new Set(entries.map(entry => entry.category))].sort();
  const visible = (filter === 'TOATE' ? entries : entries.filter(entry => entry.category === filter));
  const shown = visible.slice(-RENDER_LIMIT).reverse();

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(visible.map(formatLogEntry).join('\n'));
      setNotice(`${visible.length} intrări copiate`);
    } catch {
      setNotice('Clipboard indisponibil în acest browser — folosește EXPORT');
    }
  };

  const exportJson = () => {
    const { dongle } = getState();
    const bundle = {
      app: 'MemoStats V2',
      version: __APP_VERSION__,
      build: __BUILD_TIME__,
      exportedAt: new Date().toISOString(),
      dongle: { name: dongle.name ?? null, firmware: dongle.firmware ?? null, voltage: dongle.voltage ?? null },
      entries: visible,
    };
    const url = URL.createObjectURL(new Blob([JSON.stringify(bundle, null, 2)], { type: 'application/json' }));
    const link = document.createElement('a');
    link.href = url;
    link.download = `memostats-v2-log-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };

  return (
    <section className="card card--logs">
      <SectionHeader
        title="LOGURI"
        meta={<span className="mono text--muted small">MemoStats V2 {__APP_VERSION__} · {__BUILD_TIME__}</span>}
      />

      <div className="chips" role="group" aria-label="Filtru categorie">
        {(['TOATE', ...categories] as const).map(category => (
          <button
            key={category}
            type="button"
            className={`chip${filter === category ? ' chip--on' : ''}`}
            aria-pressed={filter === category}
            onClick={() => setFilter(category)}
          >
            {category}
          </button>
        ))}
      </div>

      <div className="actions actions--row">
        <ActionButton variant="secondary" onClick={() => void copy()} disabled={visible.length === 0}>COPY</ActionButton>
        <ActionButton variant="secondary" onClick={exportJson} disabled={visible.length === 0}>EXPORT</ActionButton>
        <ActionButton variant="quiet" onClick={() => { logStore.clear(); setNotice(undefined); }} disabled={entries.length === 0}>CLEAR</ActionButton>
      </div>
      {notice && <p className="notice">{notice}</p>}

      <p className="text--muted small">
        {visible.length} intrări{visible.length > RENDER_LIMIT ? ` · afișate ultimele ${RENDER_LIMIT}` : ''}
      </p>
      <ol className="log-list">
        {shown.map(entry => <LogRow key={entry.id} entry={entry} />)}
      </ol>
      {entries.length === 0 && <p className="text--muted">Niciun eveniment încă. Conectează dongle-ul.</p>}
    </section>
  );
}

function LogRow({ entry }: { entry: LogEntry }) {
  const head = (
    <>
      <span className={`log__dot log__dot--${entry.level}`} aria-label={entry.level} />
      <span className="log__time mono">{formatLogTime(entry.at)}</span>
      <span className="log__cat mono">{entry.category}</span>
      <span className="log__msg">{entry.message}</span>
    </>
  );
  if (!entry.detail) return <li className="log"><div className="log__head">{head}</div></li>;
  return (
    <li className="log">
      <details>
        <summary className="log__head">{head}</summary>
        <dl className="log__detail mono">
          {Object.entries(entry.detail).map(([key, value]) => (
            <div key={key}>
              <dt>{key}</dt>
              <dd>{String(value)}</dd>
            </div>
          ))}
        </dl>
      </details>
    </li>
  );
}
