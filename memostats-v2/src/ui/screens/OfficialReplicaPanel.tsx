import { hexByte, hexId, toHex } from '../../core/bytes';
import { runOfficialReplicaTest } from '../../state/actions';
import { useAppState } from '../../state/appState';
import { useCanTransmit } from '../hooks';
import { SCCM166_F100_REPLICA } from '../../vehicle/identification/officialReplica';
import { ActionButton, ExpandablePanel, HexBlock, SectionHeader, TechnicalRow } from '../components/primitives';
import { HeaderRows, UdsResultView } from './UdsResultView';

export function OfficialReplicaPanel() {
  const { replica: test, med40 } = useAppState();
  const canTx = useCanTransmit();
  const replica = SCCM166_F100_REPLICA;
  const { spec } = replica;
  const { result } = test;

  return (
    <section className="card card--accent">
      <SectionHeader title={`TEST CAPTURĂ OFICIALĂ · ${replica.ecu}`} meta={<span className="stage">TESTUL URMĂTOR</span>} />
      <p className="lede">
        Repetă exact tranzacția pe care aplicația oficială MBito a făcut-o pe mașina ta ({replica.captureSession}):
        <span className="mono"> {toHex(spec.body)}</span> către <span className="mono">{hexId(spec.txId)} → {hexId(spec.rxId)}</span>.
        Toți parametrii EXEC_UDS sunt copiați din cadrul capturat. Read-only.
      </p>

      <div className="rows">
        <TechnicalRow label="request_nr" mono value={spec.requestNr} />
        <TechnicalRow label="timeout / delay_after" mono value={`${spec.timeoutMs} ms / ${spec.delayAfterMs} ms`} />
        <TechnicalRow label="exp_len / cmd_len" mono value={`${spec.expectedResponseLength} / ${spec.body.length}`} />
        <TechnicalRow label="Răspuns oficial" mono value={toHex(replica.captured.udsBody)} />
      </div>

      <ExpandablePanel title="Cadrele: captura oficială și TX-ul replicii">
        <HexBlock label="RX OFICIAL CAPTURAT" note={`resp_status ${hexByte(replica.captured.header.responseType)}`} hex={toHex(replica.capturedRx)} />
        <HexBlock label="TX REPLICĂ" note="exact ce se trimite" hex={toHex(replica.txPreview)} />
        <HeaderRows header={replica.captured.header} />
      </ExpandablePanel>

      <div className="actions">
        <ActionButton
          onClick={() => void runOfficialReplicaTest()}
          busy={test.status === 'running'}
          disabled={!canTx || med40.status === 'running'}
        >
          {test.status === 'running' ? 'SE TRIMITE…' : `TEST ${replica.ecu}`}
        </ActionButton>
      </div>

      {test.status === 'error' && <p className="notice notice--error">{test.error}</p>}

      {result && (
        <UdsResultView
          result={result}
          finishedAt={test.finishedAt}
          extraRows={(
            <>
              <TechnicalRow
                label="Identic cu captura"
                mono
                value={result.bodyMatchesCapture === null ? null : result.bodyMatchesCapture ? 'DA' : 'NU'}
                tone={result.bodyMatchesCapture ? 'ok' : result.bodyMatchesCapture === false ? 'warn' : undefined}
              />
              <TechnicalRow
                label="Op code"
                mono
                value={result.opCode && `${result.opCode}${result.opCodeMatchesCatalog ? ' · = catalog' : ` · catalog ${replica.catalogOpCode ?? '—'}`}`}
                tone={result.opCodeMatchesCatalog ? 'ok' : result.opCode ? 'warn' : undefined}
              />
            </>
          )}
        />
      )}
    </section>
  );
}
