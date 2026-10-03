import { downloadText } from '../../capture/captureStore';
import { logStore } from '../../logs/logStore';
import { clearPerformanceHistory, perfStore } from '../../performance/performanceStore';
import { disconnectDongle, refreshVoltage, runPreflight } from '../../state/actions';
import { useAppState } from '../../state/appState';
import { settingsStore, updateSettings } from '../../state/settings';
import { ActionButton, SectionHeader, TechnicalRow } from '../components/primitives';
import { formatClock } from '../format';
import { useCanTransmit } from '../hooks';
import { DeveloperPanel } from './DeveloperPanel';

export function SettingsScreen() {
  const { connection, dongle, preflight } = useAppState();
  const settings = settingsStore.use();
  const { history } = perfStore.use();
  const connected = connection === 'connected';
  const canTx = useCanTransmit();

  const exportLog = () => {
    const text = JSON.stringify({ app: 'MemoStats V2', version: __APP_VERSION__, build: __BUILD_TIME__, exportedAt: new Date().toISOString(), log: logStore.getSnapshot() }, null, 2);
    downloadText(`memostats-v2-log-${new Date().toISOString().replace(/[:.]/g, '-')}.json`, text);
  };

  return (
    <div className="screen">
      <div className="screen-title">
        <div>
          <p className="eyebrow">Setări</p>
          <h2>MemoStats V2</h2>
        </div>
        <span className="eyebrow">{__APP_VERSION__}</span>
      </div>

      <section className="card">
        <SectionHeader title="Conexiune" />
        <div className="rows">
          <TechnicalRow label="Adaptor" mono value={dongle.name} />
          <TechnicalRow label="Firmware" mono value={dongle.firmware} />
          <TechnicalRow label="Tensiune" mono value={dongle.voltage && `${dongle.voltage.value.toFixed(2)} V · ${formatClock(dongle.voltage.at)}`} />
          <TechnicalRow label="Legătură OBD" value={preflight.result ? (preflight.result.speedOk || preflight.result.rpmOk ? 'Motorul răspunde' : 'Fără răspuns') : null} />
        </div>
        <div className="actions">
          <ActionButton variant="secondary" onClick={() => void refreshVoltage()} disabled={!canTx}>CITEȘTE TENSIUNEA</ActionButton>
          <ActionButton variant="secondary" onClick={() => void runPreflight()} disabled={!canTx || preflight.status === 'running'}>REPETĂ VERIFICAREA OBD</ActionButton>
          {connected && <ActionButton variant="quiet" onClick={disconnectDongle}>DECONECTEAZĂ</ActionButton>}
        </div>
      </section>

      <section className="card">
        <SectionHeader title="Date live" />
        <div className="field">
          <span className="eyebrow">Ciclu de citire</span>
          <div className="segmented">
            {([300, 500, 1000] as const).map(ms => (
              <button key={ms} type="button" aria-pressed={settings.pollPeriodMs === ms} onClick={() => updateSettings({ pollPeriodMs: ms })}>{ms} ms</button>
            ))}
          </div>
        </div>
        <label className="toggle">
          <span>Pornește automat după conectare</span>
          <input type="checkbox" checked={settings.autoStartLive} onChange={e => updateSettings({ autoStartLive: e.target.checked })} />
        </label>
      </section>

      <section className="card">
        <SectionHeader title="Performanță" />
        <p className="lede">{history.length} curse salvate în istoric.</p>
        <div className="actions">
          <ActionButton variant="quiet" onClick={clearPerformanceHistory} disabled={history.length === 0}>ȘTERGE ISTORICUL</ActionButton>
        </div>
      </section>

      <section className="card">
        <SectionHeader title="Diagnoză" />
        <label className="toggle">
          <span>Identifică varianta (F100) la scanare</span>
          <input type="checkbox" checked={settings.identifyAfterProbe} onChange={e => updateSettings({ identifyAfterProbe: e.target.checked })} />
        </label>
      </section>

      <section className="card">
        <SectionHeader title="Loguri & export" />
        <div className="actions actions--row">
          <ActionButton variant="secondary" onClick={exportLog}>EXPORT LOG</ActionButton>
          <ActionButton variant="quiet" onClick={() => logStore.clear()}>CLEAR</ActionButton>
        </div>
      </section>

      <DeveloperPanel />
    </div>
  );
}
