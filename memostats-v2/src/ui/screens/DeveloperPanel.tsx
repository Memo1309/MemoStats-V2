import { type ChangeEvent, useState } from 'react';
import { MBITO_CHARACTERISTIC_UUID, MBITO_SERVICE_UUID } from '../../core/mbito/constants';
import { runManualRequest, schedulerState } from '../../state/actions';
import { useAppState } from '../../state/appState';
import { liveStore } from '../../telemetry/liveTelemetry';
import { READ_ONLY_SIDS } from '../../vehicle/manualRequest';
import { ActionButton, ExpandablePanel, TechnicalRow } from '../components/primitives';
import { fmt, formatMs } from '../format';
import { useCanTransmit, useNow } from '../hooks';
import { LogsScreen } from './LogsScreen';
import { Med40TestPanel } from './Med40TestPanel';
import { ScanTransportTest } from './ScanTransportTest';
import { OfficialReplicaPanel } from './OfficialReplicaPanel';
import { UdsResultView } from './UdsResultView';

/** Everything protocol-level lives here, out of the normal flow. */
export function DeveloperPanel() {
  return (
    <details className="expandable dev">
      <summary>DEVELOPER / ADVANCED</summary>
      <div className="expandable__body">
        <GattDetails />
        <ProtocolState />
        <LiveDiagnostics />
        <ExpandablePanel title="Test transport 0x33 (IC172 / HERMES / EZS166)" defaultOpen><ScanTransportTest /></ExpandablePanel>
        <ManualTest />
        <ExpandablePanel title="Test captură oficială SCCM166"><OfficialReplicaPanel /></ExpandablePanel>
        <ExpandablePanel title="Test MED40 (22 F1 00)"><Med40TestPanel /></ExpandablePanel>
        <ExpandablePanel title="Raw log"><LogsScreen /></ExpandablePanel>
      </div>
    </details>
  );
}

function GattDetails() {
  const { bleDeviceName, connection } = useAppState();
  return (
    <ExpandablePanel title="Advanced GATT details">
      <div className="rows">
        <TechnicalRow label="Service" mono value={MBITO_SERVICE_UUID} />
        <TechnicalRow label="Characteristic" mono value={MBITO_CHARACTERISTIC_UUID} />
        <TechnicalRow label="Dispozitiv BLE" mono value={bleDeviceName} />
        <TechnicalRow label="Stare" mono value={connection} />
        <TechnicalRow label="Build" mono value={`${__APP_VERSION__} · ${__BUILD_TIME__}`} />
      </div>
    </ExpandablePanel>
  );
}

function ProtocolState() {
  const { preflight } = useAppState();
  useNow(1000);
  const sched = schedulerState();
  const result = preflight.result;
  return (
    <ExpandablePanel title="Protocol state · V1 preflight">
      <div className="rows">
        <TechnicalRow label="Scheduler" mono value={`${sched.busy ? 'ocupat' : 'liber'} · ${sched.queued} în coadă`} />
        <TechnicalRow label="Preflight" mono value={preflight.status} />
        <TechnicalRow label="GET_CAN_BAUD" mono value={result?.canBaud ? `${result.canBaud.rawHex} (arg 0x${result.canBaud.arg.toString(16).toUpperCase()})` : result?.canBaudError ?? null} />
        <TechnicalRow label="01 0D / 01 0C" mono value={result && `${result.speed.exchange.transport} ${fmt(result.speed.value) ?? '—'} / ${result.rpm.exchange.transport} ${fmt(result.rpm.value) ?? '—'}`} />
        <TechnicalRow label="PID suportate" mono value={result?.supportedPids.map(p => p.toString(16).toUpperCase().padStart(2, '0')).join(' ') || null} />
      </div>
      {result && <ExpandablePanel title="01 0D (preflight) — cadre"><UdsResultView result={result.speed.exchange} /></ExpandablePanel>}
      {result && <ExpandablePanel title="01 0C (preflight) — cadre"><UdsResultView result={result.rpm.exchange} /></ExpandablePanel>}
    </ExpandablePanel>
  );
}

function LiveDiagnostics() {
  const live = liveStore.use();
  const now = useNow(1000);
  const { speed } = live;
  return (
    <ExpandablePanel title="Live speed diagnostics">
      <div className="rows">
        <TechnicalRow label="Stream" mono value={live.active ? (live.performanceMode ? 'ACTIVE · performanță' : 'ACTIVE') : 'OPRIT'} />
        <TechnicalRow label="Eșantioane viteză" mono value={`${speed.samples} / ${speed.requests}`} />
        <TechnicalRow label="Interval mediu" mono value={formatMs(speed.avgIntervalMs)} />
        <TechnicalRow label="Frecvență" mono value={speed.avgIntervalMs ? `${(1000 / speed.avgIntervalMs).toFixed(2)} Hz` : null} />
        <TechnicalRow label="Cel mai mare gol" mono value={formatMs(speed.maxGapMs || null)} />
        <TechnicalRow label="Vârsta ultimei viteze" mono value={speed.lastAt === null ? null : formatMs(now - speed.lastAt)} />
        <TechnicalRow label="Erori consecutive" mono value={live.consecutiveFailures} />
        <TechnicalRow label="Ultima eroare" mono value={live.lastError} />
      </div>
    </ExpandablePanel>
  );
}

function ManualTest() {
  const { manual } = useAppState();
  const canTx = useCanTransmit();
  const [form, setForm] = useState({ txHex: '7E0', rxHex: '7E8', bodyHex: '01 0D', timeoutMs: '200', delayAfterMs: '200', expectedResponseLength: '3' });
  const set = (key: keyof typeof form) => (e: ChangeEvent<HTMLInputElement>) => setForm(f => ({ ...f, [key]: e.target.value }));
  const run = () => void runManualRequest({
    txHex: form.txHex, rxHex: form.rxHex, bodyHex: form.bodyHex,
    timeoutMs: Number(form.timeoutMs), delayAfterMs: Number(form.delayAfterMs), expectedResponseLength: Number(form.expectedResponseLength),
  });
  const allowed = [...READ_ONLY_SIDS].map(s => s.toString(16).toUpperCase().padStart(2, '0')).join(' ');
  return (
    <ExpandablePanel title="Manual UDS / OBD test">
      <p className="small text--muted">Doar servicii de citire ({allowed}). Orice alt serviciu este blocat în motorul de protocol.</p>
      <div className="grid-2">
        <label className="field"><span className="eyebrow">TX (hex)</span><input value={form.txHex} onChange={set('txHex')} /></label>
        <label className="field"><span className="eyebrow">RX (hex)</span><input value={form.rxHex} onChange={set('rxHex')} /></label>
      </div>
      <label className="field"><span className="eyebrow">Cerere (hex)</span><input value={form.bodyHex} onChange={set('bodyHex')} /></label>
      <div className="grid-2">
        <label className="field"><span className="eyebrow">timeout ms</span><input inputMode="numeric" value={form.timeoutMs} onChange={set('timeoutMs')} /></label>
        <label className="field"><span className="eyebrow">delay_after ms</span><input inputMode="numeric" value={form.delayAfterMs} onChange={set('delayAfterMs')} /></label>
      </div>
      <label className="field"><span className="eyebrow">exp_len</span><input inputMode="numeric" value={form.expectedResponseLength} onChange={set('expectedResponseLength')} /></label>
      <div className="actions">
        <ActionButton onClick={run} busy={manual.status === 'running'} disabled={!canTx}>TRIMITE CEREREA</ActionButton>
      </div>
      {manual.status === 'error' && <p className="notice notice--error">{manual.error}</p>}
      {manual.result && <UdsResultView result={manual.result} finishedAt={manual.finishedAt} />}
    </ExpandablePanel>
  );
}
