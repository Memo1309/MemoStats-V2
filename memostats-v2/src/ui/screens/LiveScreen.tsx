import { LIVE_PIDS, PIDS, PID_CATEGORY, type PidCategory, boostKpa } from '../../core/obd/pids';
import { startLiveData, stopLiveData } from '../../state/actions';
import { useAppState } from '../../state/appState';
import { freshValue, liveStore } from '../../telemetry/liveTelemetry';
import { ActionButton, ExpandablePanel, MetricCard, SectionHeader, StatusBadge } from '../components/primitives';
import { fmt } from '../format';
import { useCanTransmit, useNow } from '../hooks';
import { ConnectionPanel } from './ConnectionPanel';

const CARDS = [
  { label: 'RPM', pid: LIVE_PIDS.RPM, unit: 'RPM', digits: 0 },
  { label: 'COOLANT', pid: LIVE_PIDS.COOLANT, unit: '°C', digits: 0 },
  { label: 'INTAKE TEMP', pid: LIVE_PIDS.INTAKE, unit: '°C', digits: 0 },
  { label: 'THROTTLE', pid: LIVE_PIDS.THROTTLE, unit: '%', digits: 1 },
  { label: 'MAP', pid: LIVE_PIDS.MAP, unit: 'KPA', digits: 0 },
] as const;

export function LiveScreen() {
  const live = liveStore.use();
  const { connection, dongle } = useAppState();
  const now = useNow();
  const connected = connection === 'connected';
  const canTx = useCanTransmit();

  const speed = freshValue(live, LIVE_PIDS.SPEED, now);
  // A stale value is shown dimmed only while streaming; once stopped nothing pretends to be live.
  const lastSpeed = live.active ? live.values[LIVE_PIDS.SPEED]?.value ?? null : null;
  const noAnswer = live.active && live.consecutiveFailures >= 3;
  const badge = !live.active
    ? <StatusBadge tone="muted">OPRIT</StatusBadge>
    : speed !== null ? <span className="badge badge--active badge--live">LIVE</span>
    : <StatusBadge tone="warn">AȘTEPT DATE</StatusBadge>;

  const voltage = live.active && live.adapterVoltage ? live.adapterVoltage.value : connected ? dongle.voltage?.value ?? null : null;

  return (
    <div className="screen">
      <ConnectionPanel />

      <section className="card hero">
        <p className="eyebrow">Viteză live</p>
        <div className="hero__row">
          <span className={`hero__value${speed === null ? ' hero__value--dim' : ''}`}>{fmt(speed ?? lastSpeed) ?? '--'}</span>
          <span className="hero__unit">KM/H</span>
        </div>
        <div className="hero__foot">{badge}</div>
        {noAnswer && (
          <p className="notice notice--warn">Motorul nu răspunde ({live.consecutiveFailures} cereri fără răspuns). Contact pus?</p>
        )}
        <div className="actions">
          {live.active
            ? <ActionButton variant="secondary" onClick={stopLiveData}>OPREȘTE DATE LIVE</ActionButton>
            : <ActionButton onClick={startLiveData} disabled={!canTx}>PORNEȘTE DATE LIVE</ActionButton>}
        </div>
      </section>

      <section className="card">
        <SectionHeader title="Powertrain & body" meta={<span className="tag">Read only</span>} />
        <div className="metrics">
          {CARDS.map(card => {
            const fresh = freshValue(live, card.pid, now);
            const last = live.active ? live.values[card.pid]?.value ?? null : null;
            const unsupported = live.unsupported.includes(card.pid);
            return (
              <MetricCard
                key={card.label}
                label={card.label}
                value={unsupported ? null : fmt(fresh ?? last, card.digits)}
                unit={card.unit}
                stale={fresh === null && last !== null}
                naText={unsupported ? 'NESUPORTAT' : 'INDISPONIBIL'}
              />
            );
          })}
          <MetricCard label="ADAPTER VOLTAGE" value={fmt(voltage, 2)} unit="V" />
        </div>
        <MoreData now={now} />
      </section>
    </div>
  );
}

const CATEGORIES: PidCategory[] = ['MOTOR', 'AER / TURBO', 'COMBUSTIBIL', 'TEMPERATURI', 'ELECTRIC'];
const CORE: number[] = Object.values(LIVE_PIDS);

/** V1 "MAI MULTE DATE": only PIDs the ECU reported as supported; boost only from fresh MAP and BARO. */
function MoreData({ now }: { now: number }) {
  const live = liveStore.use();
  const { preflight } = useAppState();
  const supported = (preflight.result?.supportedPids ?? []).filter(pid => PIDS[pid] && !CORE.includes(pid));
  const boost = boostKpa(freshValue(live, LIVE_PIDS.MAP, now), freshValue(live, 0x33, now));
  const cell = (pid: number) => {
    const def = PIDS[pid];
    const fresh = freshValue(live, pid, now);
    const digits = def && Math.abs(fresh ?? 0) < 10 ? 2 : 1;
    return <MetricCard key={pid} label={def?.name.toUpperCase() ?? String(pid)} value={fmt(fresh, digits)} unit={def?.unit.toUpperCase()} naText={live.active ? 'AȘTEAPTĂ' : 'INDISPONIBIL'} />;
  };
  return (
    <ExpandablePanel title="MAI MULTE DATE">
      {supported.length === 0 && <p className="small text--muted">Nicio metrică suplimentară raportată de ECU (sau verificarea OBD nu a rulat încă).</p>}
      {CATEGORIES.map(category => {
        const pids = supported.filter(pid => PID_CATEGORY[pid] === category);
        const withBoost = category === 'AER / TURBO';
        if (!pids.length && !withBoost) return null;
        return (
          <div key={category} className="field">
            <span className="eyebrow">{category}</span>
            <div className="metrics">
              {withBoost && (
                <MetricCard
                  label="BOOST (MAP − BARO)"
                  value={boost === null ? null : `${boost >= 0 ? '+' : ''}${(boost / 100).toFixed(2)}`}
                  unit="BAR"
                  naText={supported.includes(0x33) ? 'AȘTEAPTĂ' : 'FĂRĂ BARO'}
                />
              )}
              {pids.map(cell)}
            </div>
          </div>
        );
      })}
    </ExpandablePanel>
  );
}
