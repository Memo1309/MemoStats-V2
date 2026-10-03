import { connectDongle, disconnectDongle, isBluetoothSupported, runPreflight } from '../../state/actions';
import { useAppState } from '../../state/appState';
import { useCanTransmit } from '../hooks';
import { ActionButton, StatusBadge } from '../components/primitives';

// VERIFIED REAL VEHICLE: the user's dongle answers GET_DEV_NAME with this name.
const KNOWN_DONGLE_NAME = 'V2407127C3';

/** Top of DATE LIVE: connect, then only the adapter facts a driver cares about. */
export function ConnectionPanel() {
  const { connection, connectionError, dongle, preflight } = useAppState();
  const canTx = useCanTransmit();
  const supported = isBluetoothSupported();

  if (connection !== 'connected') {
    return (
      <section className="card">
        <div>
          <p className="eyebrow">Adaptor</p>
          <h2 style={{ fontSize: 18, fontWeight: 800, marginTop: 4 }}>
            {connection === 'lost' ? 'Conexiunea s-a pierdut' : 'Conectează MBito'}
          </h2>
        </div>
        {!supported && <p className="notice notice--warn">Web Bluetooth indisponibil aici. Pe iPhone deschide MemoStats în Bluefy.</p>}
        {connectionError && <p className="notice notice--error">{connectionError}</p>}
        <div className="actions">
          <ActionButton onClick={() => void connectDongle()} busy={connection === 'connecting'} disabled={!supported}>
            {connection === 'lost' ? 'RECONECTEAZĂ MBITO' : 'CONECTEAZĂ MBITO'}
          </ActionButton>
        </div>
      </section>
    );
  }

  const obd = preflight.result;
  return (
    <section className="card">
      <div className="connect__facts">
        <Fact label="MBito" value={dongle.name ?? '—'} warn={Boolean(dongle.name && dongle.name !== KNOWN_DONGLE_NAME)} />
        <Fact label="Firmware" value={dongle.firmware ?? '—'} />
        <Fact label="Tensiune" value={dongle.voltage ? `${dongle.voltage.value.toFixed(2)} V` : '—'} />
      </div>
      {preflight.status === 'running' && <p className="notice">Verific legătura OBD cu motorul…</p>}
      {preflight.status === 'done' && obd && (obd.speedOk || obd.rpmOk
        ? <p className="notice"><span className="text--ok">●</span> Motorul răspunde pe OBD.</p>
        : (
          <div className="notice notice--warn">
            Motorul nu răspunde pe OBD. Contactul trebuie să fie pus (ideal motor pornit).
            <div className="actions" style={{ marginTop: 10 }}>
              <ActionButton variant="secondary" onClick={() => void runPreflight()} disabled={!canTx}>REÎNCEARCĂ</ActionButton>
            </div>
          </div>
        ))}
      {preflight.status === 'error' && <p className="notice notice--error">{preflight.error}</p>}
      {dongle.errors.map(error => <p key={error} className="notice notice--error">{error}</p>)}
      <div className="actions">
        <ActionButton variant="quiet" onClick={disconnectDongle}>DECONECTEAZĂ</ActionButton>
      </div>
    </section>
  );
}

function Fact({ label, value, warn = false }: { label: string; value: string; warn?: boolean }) {
  return (
    <div className="fact">
      <span className="eyebrow">{label}</span>
      <p className={`fact__value${warn ? ' text--warn' : ''}`}>{value}</p>
    </div>
  );
}

export function ConnectionBadge() {
  const { connection, dongle, preflight } = useAppState();
  if (connection === 'connected') {
    return <StatusBadge tone="active">{dongle.reading || preflight.status === 'running' ? 'CONECTARE…' : 'CONECTAT'}</StatusBadge>;
  }
  if (connection === 'connecting') return <StatusBadge tone="muted">CONECTARE…</StatusBadge>;
  if (connection === 'lost') return <StatusBadge tone="warn">PIERDUT</StatusBadge>;
  return <StatusBadge tone="muted">DECONECTAT</StatusBadge>;
}
