import { useState } from 'react';
import { scanDebugStore } from '../../diagnostics/scanDebug';
import { runIdentifyDebug, runProbeDebug } from '../../state/actions';
import { formatCanId } from '../../w176/canId';
import { useCanTransmit } from '../hooks';
import { ActionButton, HexBlock, StatusBadge, TechnicalRow } from '../components/primitives';

// Developer-only single-probe transport test for the raw 0x33 scan. Runs ONE probe (and one 0x40
// fallback) so one ECU can be tested in seconds. Not Passive Capture — capture stays exclusive with TX.
const PAIRS: { name: string; tx: number; rx: number }[] = [
  { name: 'IC172', tx: 0x60a, rx: 0x481 },
  { name: 'HERMES', tx: 0x60b, rx: 0x58b },
  { name: 'EZS166', tx: 0x612, rx: 0x482 },
];

export function ScanTransportTest() {
  const canTx = useCanTransmit();
  const { probe, uds, note, running } = scanDebugStore.use();
  const [busy, setBusy] = useState<string | null>(null);

  const run = async (fn: () => Promise<unknown>, id: string) => {
    setBusy(id);
    try { await fn(); } catch { /* result/error is surfaced via the store + raw log */ } finally { setBusy(null); }
  };

  return (
    <div className="rows">
      <p className="small text--muted">Testează o singură pereche prin 0x33 (scanare) și prin 0x40 (22 F1 00). Vezi cadrele BLE brute, decodarea și decizia de prezență. Independent de Captura Pasivă.</p>
      {PAIRS.map(p => (
        <div key={p.name} className="actions actions--row">
          <ActionButton variant="secondary" onClick={() => void run(() => runProbeDebug(p.tx, p.rx), `33-${p.name}`)} busy={busy === `33-${p.name}`} disabled={!canTx || running}>
            {p.name} · 0x33
          </ActionButton>
          <ActionButton variant="secondary" onClick={() => void run(() => runIdentifyDebug(p.tx, p.rx), `40-${p.name}`)} busy={busy === `40-${p.name}`} disabled={!canTx || running}>
            {p.name} · 0x40
          </ActionButton>
        </div>
      ))}

      {note && <p className="notice notice--error">{note}</p>}

      {probe && (
        <section className="card">
          <div className="item__head">
            <p className="item__title">0x33 · {formatCanId(probe.txId)} → {formatCanId(probe.rxId)}</p>
            <StatusBadge tone={probe.result === 'PRESENT' ? 'ok' : probe.result === 'NO_B3' ? 'error' : 'warn'}>{probe.result}</StatusBadge>
          </div>
          <div className="rows">
            <HexBlock label={`REQUEST (${probe.requestOk ? '36 B OK' : 'FRAME INVALID'})`} hex={probe.requestHex} />
            <TechnicalRow label="Cadre BLE brute recepționate" mono value={String(probe.notifications.length)} tone={probe.notifications.length ? undefined : 'warn'} />
            {probe.notifications.map((n, i) => <HexBlock key={i} label={`NOTIFY +${n.atMs}ms · ${n.len} B`} hex={n.hex} />)}
            {probe.notifications.length === 0 && <p className="small text--warn">Niciun cadru BLE recepționat în fereastra probei (dongle-ul nu a răspuns la 0x33).</p>}
            <TechnicalRow label="B3 recepționat" value={probe.b3Received ? 'DA' : 'NU'} tone={probe.b3Received ? 'ok' : 'error'} />
            {probe.decodedHex && <HexBlock label="CADRU DECODAT (B3)" hex={probe.decodedHex} />}
            <TechnicalRow label="Slot răspuns (8 B)" mono value={probe.responseSlotHex} />
            <TechnicalRow label="Outcome" mono value={probe.outcome} />
            <TechnicalRow label="Latență" mono value={probe.latencyMs === null ? '—' : `${Math.round(probe.latencyMs)} ms`} />
            <TechnicalRow label="Rezultat" value={probe.result} tone={probe.result === 'PRESENT' ? 'ok' : probe.result === 'NO_B3' ? 'error' : 'warn'} />
          </div>
        </section>
      )}

      {uds && (
        <section className="card">
          <div className="item__head">
            <p className="item__title">0x40 · 22 F1 00 · {formatCanId(uds.txId)} → {formatCanId(uds.rxId)}</p>
            <StatusBadge tone={uds.result === 'VALID_RESPONSE' ? 'ok' : 'error'}>{uds.result}</StatusBadge>
          </div>
          <div className="rows">
            <TechnicalRow label="Cerere UDS" mono value={uds.requestHex} />
            <TechnicalRow label="Cadre RX" mono value={uds.framesHex} />
            <TechnicalRow label="UDS body" mono value={uds.udsBody} />
            <TechnicalRow label="Semantic / transport" mono value={`${uds.semantic} · ${uds.transport}`} />
            <TechnicalRow label="Prezent" value={uds.present ? 'DA' : 'NU'} tone={uds.present ? 'ok' : 'warn'} />
          </div>
        </section>
      )}
    </div>
  );
}
