import { hexId, toHex } from '../../core/bytes';
import { MED40 } from '../../data/w176/knownEcus';
import { runMed40Test } from '../../state/actions';
import { useAppState } from '../../state/appState';
import { useCanTransmit } from '../hooks';
import { MED40_IDENTIFICATION_REQUEST } from '../../vehicle/identification/med40Test';
import { ActionButton, SectionHeader, TechnicalRow } from '../components/primitives';
import { UdsResultView } from './UdsResultView';

export function Med40TestPanel() {
  const { med40, replica } = useAppState();
  const canTx = useCanTransmit();
  const { result } = med40;
  const request = MED40_IDENTIFICATION_REQUEST;

  return (
    <section className="card">
      <SectionHeader title="TEST MED40" meta={<span className="stage">AȘTEAPTĂ VALIDARE PE VEHICUL</span>} />
      <p className="lede">
        O singură cerere read-only <span className="mono">{toHex(request.body)}</span> (ReadDataByIdentifier F100) către
        motor, <span className="mono">{hexId(request.txId)} → {hexId(request.rxId)}</span>. Test 1 (28.09): FD / fără răspuns CAN,
        la 12,43 V — rulează-l după testul SCCM166, cu contactul pus.
      </p>

      <div className="actions">
        <ActionButton
          variant="secondary"
          onClick={() => void runMed40Test()}
          busy={med40.status === 'running'}
          disabled={!canTx || replica.status === 'running'}
        >
          {med40.status === 'running' ? 'SE TRIMITE…' : 'TEST MED40'}
        </ActionButton>
      </div>

      {med40.status === 'error' && <p className="notice notice--error">{med40.error}</p>}

      {result && (
        <UdsResultView
          result={result}
          finishedAt={med40.finishedAt}
          extraRows={(
            <TechnicalRow
              label="Op code"
              mono
              value={result.opCode && (
                <>
                  {result.opCode}
                  <span className={result.opCodeMatchesCatalog ? 'text--ok' : 'text--warn'}>
                    {result.opCodeMatchesCatalog ? ` · ${MED40.variantName}` : ` · diferit de catalog (${MED40.opCode})`}
                  </span>
                </>
              )}
            />
          )}
        />
      )}
    </section>
  );
}
