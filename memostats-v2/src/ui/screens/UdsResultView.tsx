import type { ReactNode } from 'react';
import { hexByte, hexId, toHex } from '../../core/bytes';
import type { ExecUdsHeader } from '../../core/uds/execUds';
import type { UdsExchangeResult } from '../../core/uds/udsChannel';
import { NRC_NAMES } from '../../core/uds/udsSemantics';
import { ExpandablePanel, HexBlock, StatusBadge, TechnicalRow } from '../components/primitives';
import { SEMANTIC_LABEL, formatClock, formatMs } from '../format';

/** Everything one EXEC_UDS exchange produced: outcome, timing, raw TX/RX, parsed header, warnings. */
export function UdsResultView({ result, finishedAt, extraRows }: { result: UdsExchangeResult; finishedAt?: number; extraRows?: ReactNode }) {
  const label = SEMANTIC_LABEL[result.semantic];
  const lastFrame = result.frames.at(-1);
  return (
    <div className="result">
      <div className="result__head">
        <StatusBadge tone={label.tone}>{label.text}</StatusBadge>
        {finishedAt && <span className="text--muted small">{formatClock(finishedAt)}</span>}
      </div>

      <div className="rows">
        {extraRows}
        <TechnicalRow label="Semantic UDS" mono value={result.semantic} />
        {result.nrc !== undefined && <TechnicalRow label="NRC" mono value={`${hexByte(result.nrc)} ${NRC_NAMES[result.nrc] ?? ''}`} />}
        <TechnicalRow
          label="Transport (raw)"
          mono
          value={result.final ? `${hexByte(result.final.header.responseType)} ${result.transport}` : result.transport}
        />
        <TechnicalRow label="Prezență ECU" mono value={result.presence} tone={result.presence === 'PRESENT' ? 'ok' : undefined} />
        <TechnicalRow
          label="request_nr ecou"
          mono
          value={result.requestNrEchoed === null ? null : result.requestNrEchoed ? `DA (${result.requestNr})` : `NU (trimis ${result.requestNr})`}
        />
        <TechnicalRow label="Total TX → RX" mono value={formatMs(result.latencyMs)} />
        <TechnicalRow label="Scriere BLE confirmată" mono value={result.writtenAt === null ? null : `+${formatMs(result.writtenAt - result.sentAt)}`} />
        <TechnicalRow
          label="Scriere → RX"
          mono
          value={result.writtenAt === null || !lastFrame ? null : `${formatMs(lastFrame.receivedAt - result.writtenAt)} (timeout dongle ${result.spec.timeoutMs} ms)`}
        />
      </div>

      <HexBlock label="TX RAW" note="pachet BLE trimis" hex={toHex(result.txRaw)} />
      {result.frames.length === 0 && <HexBlock label="RX RAW" hex="" note="niciun cadru EXEC_UDS" />}
      {result.frames.map(({ frame, receivedAt, decision }, index) => (
        <HexBlock
          key={`${receivedAt}-${index}`}
          label={result.frames.length > 1 ? `RX RAW #${index + 1}` : 'RX RAW'}
          note={`+${formatMs(receivedAt - result.sentAt)} · ${decision}`}
          hex={toHex(frame.raw)}
        />
      ))}
      {result.final && <HexBlock label="CORP UDS" note={`${result.final.udsBody.length} B`} hex={toHex(result.final.udsBody)} />}

      {result.warnings.map(warning => <p key={warning} className="notice notice--warn">{warning}</p>)}

      {result.final && (
        <ExpandablePanel title="Antet EXEC_UDS V2 primit (21 B)">
          <HeaderRows header={result.final.header} />
        </ExpandablePanel>
      )}
    </div>
  );
}

export function HeaderRows({ header }: { header: ExecUdsHeader }) {
  return (
    <div className="rows">
      <TechnicalRow label="request_type" mono value={header.requestType} />
      <TechnicalRow label="request_nr" mono value={header.requestNr} />
      <TechnicalRow label="resp_status" mono value={hexByte(header.responseType)} />
      <TechnicalRow label="tx_id" mono value={hexId(header.txId)} />
      <TechnicalRow label="rx_id" mono value={hexId(header.rxId)} />
      <TechnicalRow label="timeout" mono value={`${header.timeoutMs} ms`} />
      <TechnicalRow label="delay_after" mono value={`${header.delayAfterMs} ms`} />
      <TechnicalRow label="exp_len" mono value={header.expectedLength} />
      <TechnicalRow label="cmd_len" mono value={header.requestLength} />
      <TechnicalRow label="payload_len" mono value={header.actualLength} />
    </div>
  );
}
