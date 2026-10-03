import { useState } from 'react';
import { hexId } from '../../../core/bytes';
import { type MileageReading, mileageDeltas } from '../../../diagnostics/mileage';
import { runMileageCheck } from '../../../state/actions';
import { useAppState } from '../../../state/appState';
import { useW176Db } from '../../../w176/useW176Db';
import { useCanTransmit } from '../../hooks';
import { ActionButton, SectionHeader, StatusBadge, TechnicalRow } from '../../components/primitives';

// Mileage Check (spec §18): reads every odometer source in the DB and shows the values, raw responses
// and factual deltas. Never labels a difference as fraud.
export function MileageScreen() {
  const { db } = useW176Db();
  const { connection } = useAppState();
  const canTx = useCanTransmit();
  const [readings, setReadings] = useState<MileageReading[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const run = async () => {
    if (!db) return;
    setBusy(true);
    setError(null);
    try {
      setReadings(await runMileageCheck(db));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const deltas = readings ? mileageDeltas(readings) : [];
  return (
    <section className="card">
      <SectionHeader title="Kilometraj" meta={<span className="tag">Read only</span>} />
      <p className="lede">Citește kilometrajul din fiecare sursă (EZS166, IC172, MED40) și compară valorile. Doar informativ.</p>
      <div className="actions">
        <ActionButton onClick={() => void run()} busy={busy} disabled={!canTx || connection !== 'connected'}>CITEȘTE KILOMETRAJUL</ActionButton>
      </div>
      {error && <p className="notice notice--error">{error}</p>}
      <div className="list">
        {(readings ?? []).map(r => (
          <details key={r.reference} className="item">
            <summary>
              <div className="item__head">
                <div style={{ minWidth: 0 }}>
                  <p className="item__title">{r.km !== null ? `${r.km.toLocaleString('ro-RO')} ${r.unit}` : '—'}</p>
                  <p className="item__sub">{r.ecuName} · {r.measureName}</p>
                </div>
                <StatusBadge tone={r.error ? 'warn' : 'ok'}>{r.error ? 'FĂRĂ CITIRE' : 'CITIT'}</StatusBadge>
              </div>
            </summary>
            <div className="rows">
              <TechnicalRow label="Sursă" value={`${r.ecuName} (${hexId(r.txId)} → ${hexId(r.rxId)})`} />
              <TechnicalRow label="Cerere" mono value={r.request} />
              <TechnicalRow label="Răspuns brut" mono value={r.rawResponse} />
              {r.error && <TechnicalRow label="Stare" value={r.error} tone="warn" />}
            </div>
          </details>
        ))}
      </div>
      {deltas.length > 0 && (
        <div className="rows">
          <SectionHeader title="Diferențe" />
          {deltas.map(d => <TechnicalRow key={`${d.a}-${d.b}`} label={`${d.a} − ${d.b}`} mono value={`${d.deltaKm.toLocaleString('ro-RO')} km`} />)}
        </div>
      )}
    </section>
  );
}
