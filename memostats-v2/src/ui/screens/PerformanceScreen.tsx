import { armPerformance, perfStore, resetPerformance } from '../../performance/performanceStore';
import type { PerfState } from '../../performance/zeroToHundred';
import { liveStore } from '../../telemetry/liveTelemetry';
import { ActionButton, MetricCard, SectionHeader, StatusBadge, type Tone } from '../components/primitives';
import { fmt, formatDateTime } from '../format';

const STATE_TONE: Record<PerfState, Tone> = { READY: 'muted', ARMED: 'warn', RUNNING: 'active', COMPLETE: 'ok', INVALID: 'error' };

export function PerformanceScreen() {
  const { snap, history } = perfStore.use();
  const live = liveStore.use();
  const running = snap.state === 'RUNNING';
  const armed = snap.state === 'ARMED';

  const big = snap.state === 'COMPLETE' && snap.resultMs !== null ? { value: (snap.resultMs / 1000).toFixed(2), unit: 'S' }
    : running && snap.elapsedMs !== null ? { value: (snap.elapsedMs / 1000).toFixed(1), unit: 'S' }
    : { value: fmt(snap.currentSpeedKmh) ?? '--', unit: 'KM/H' };
  const best = history.length ? Math.min(...history.map(r => r.resultMs)) : null;

  return (
    <div className="screen">
      <section className="card hero">
        <p className="eyebrow">0–100 km/h</p>
        <div className="hero__row">
          <span className={`hero__value${big.value === '--' ? ' hero__value--dim' : ''}`}>{big.value}</span>
          <span className="hero__unit">{big.unit}</span>
        </div>
        <div className="hero__foot"><StatusBadge tone={STATE_TONE[snap.state]}>{snap.state}</StatusBadge></div>
        <p className={snap.state === 'INVALID' ? 'notice notice--error' : 'lede'}>{snap.message}</p>
        {!live.active && snap.state !== 'INVALID' && <p className="notice">Pornește datele live din DATE LIVE.</p>}
        <div className="actions actions--row">
          <ActionButton onClick={armPerformance} disabled={!live.active || armed || running}>ARMEAZĂ</ActionButton>
          <ActionButton variant="secondary" onClick={resetPerformance} disabled={snap.state === 'READY'}>RESETEAZĂ</ActionButton>
        </div>
      </section>

      <section className="card">
        <SectionHeader title="Rezultat" meta={<span className="tag">Read only</span>} />
        <div className="stats">
          <MetricCard label="REZULTAT" value={snap.resultMs === null ? null : (snap.resultMs / 1000).toFixed(2)} unit="S" naText="—" />
          <MetricCard label="VITEZĂ MAXIMĂ" value={fmt(snap.maxSpeedKmh)} unit="KM/H" naText="—" />
          <MetricCard label="MAX RPM" value={fmt(snap.maxRpm)} naText="—" />
          <MetricCard label="MAX THROTTLE" value={fmt(snap.maxThrottlePct)} unit="%" naText="—" />
          <MetricCard label="EȘANTIOANE" value={String(snap.samples)} />
          <MetricCard label="FRECVENȚĂ" value={fmt(snap.hz, 1)} unit="HZ" naText="—" />
          <MetricCard label="CEL MAI MARE GOL" value={fmt(snap.maxGapMs)} unit="MS" naText="—" />
        </div>
      </section>

      <section className="card">
        <SectionHeader title="Istoric" meta={<span className="eyebrow">{history.length} curse</span>} />
        {history.length === 0 && <p className="text--muted small">Nicio cursă completă încă.</p>}
        <div className="list">
          {history.slice(0, 20).map(run => (
            <div key={run.id} className="item">
              <div className="item__head">
                <span className="item__title mono">{(run.resultMs / 1000).toFixed(2)} s</span>
                {run.resultMs === best && <span className="tag">BEST</span>}
              </div>
              <p className="item__sub">
                {formatDateTime(run.date)} · max {fmt(run.maxSpeedKmh) ?? '—'} km/h · {fmt(run.hz, 1) ?? '—'} Hz · gol {fmt(run.maxGapMs) ?? '—'} ms
              </p>
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}
