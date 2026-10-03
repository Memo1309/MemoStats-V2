import { type Bytes, hexByte, toHex } from '../bytes';
import type { ByteTransport } from '../ble/mbitoBleTransport';
import { log } from '../../logs/logStore';
import { MBITO_CMD_NAMES, MbitoArg, MbitoCmd } from './constants';
import { FrameAssembler, type MbitoFrame, decodeText, decodeVoltage, encodeRequest } from './frame';

/** What to do with a response frame of the pending command. */
export type FrameDecision<T> =
  | { kind: 'ignore'; reason: string }
  | { kind: 'wait'; reason: string; extendDeadlineMs?: number }
  | { kind: 'done'; value: T };

export interface ExchangeOptions<T> {
  command: MbitoCmd;
  payload?: Uint8Array;
  /** Browser-side deadline, measured from write completion. */
  timeoutMs: number;
  /** Earliest time a *different* exchange may reuse the link if this one is abandoned. */
  linkBusyForMs?: number;
  signal?: AbortSignal;
  onFrame(frame: MbitoFrame): FrameDecision<T>;
}

export interface ReceivedFrame {
  frame: MbitoFrame;
  /** performance.now() */
  receivedAt: number;
  decision: string;
}

export interface ExchangeResult<T> {
  value: T;
  tx: Bytes;
  /** performance.now() immediately before the GATT write */
  sentAt: number;
  /** performance.now() when the GATT write resolved; null if the reply won the race */
  writtenAt: number | null;
  frames: ReceivedFrame[];
}

export class ExchangeTimeoutError extends Error {
  readonly tx: Bytes;
  readonly sentAt: number;
  readonly writtenAt: number | null;
  readonly frames: ReceivedFrame[];
  constructor(message: string, tx: Bytes, sentAt: number, writtenAt: number | null, frames: ReceivedFrame[]) {
    super(message);
    this.name = 'ExchangeTimeoutError';
    this.tx = tx;
    this.sentAt = sentAt;
    this.writtenAt = writtenAt;
    this.frames = frames;
  }
}

const DONGLE_INFO_TIMEOUT_MS = 3000;

interface Pending {
  command: number;
  handle(frame: MbitoFrame, receivedAt: number): void;
  fail(error: Error): void;
}

/**
 * MBito command layer: frames requests, reassembles responses and runs exactly one exchange at a
 * time. Callers are expected to go through DiagnosticScheduler; the guard here only catches bugs.
 */
export class MbitoClient {
  private readonly assembler = new FrameAssembler();
  private pending?: Pending;
  private linkBusyUntil = 0;
  private readonly transport: ByteTransport;
  private readonly frameObservers = new Set<(frame: MbitoFrame, receivedAt: number) => void>();

  constructor(transport: ByteTransport) {
    this.transport = transport;
    transport.onData(chunk => this.handleChunk(chunk));
    transport.onDisconnect(() => {
      this.assembler.reset();
      this.linkBusyUntil = 0;
      this.pending?.fail(new Error('Conexiunea BLE s-a închis'));
    });
  }

  /** Every decoded frame, solicited or not (late replies, other apps' traffic). Observers never consume it. */
  onFrame(observer: (frame: MbitoFrame, receivedAt: number) => void): () => void {
    this.frameObservers.add(observer);
    return () => this.frameObservers.delete(observer);
  }

  async getDeviceName(signal?: AbortSignal): Promise<string> {
    return decodeText((await this.dongleInfo(MbitoCmd.GET_DEV_NAME, signal)).payload);
  }

  async getFirmwareVersion(signal?: AbortSignal): Promise<string> {
    return decodeText((await this.dongleInfo(MbitoCmd.GET_FW_VERSION, signal)).payload);
  }

  async getVoltage(signal?: AbortSignal): Promise<number> {
    return decodeVoltage((await this.dongleInfo(MbitoCmd.GET_VOLTAGE, signal)).payload);
  }

  /** V1 sent this before any CAN traffic. The reply's arg carries the baud enum, so any arg is accepted. */
  async getCanBaud(signal?: AbortSignal): Promise<{ arg: number; payload: Bytes; raw: Bytes }> {
    const { value } = await this.exchange<MbitoFrame>({
      command: MbitoCmd.GET_CAN_BAUD,
      timeoutMs: DONGLE_INFO_TIMEOUT_MS,
      signal,
      onFrame: frame => ({ kind: 'done', value: frame }),
    });
    return { arg: value.arg, payload: value.payload, raw: value.raw };
  }

  private async dongleInfo(command: MbitoCmd, signal?: AbortSignal): Promise<MbitoFrame> {
    const { value } = await this.exchange<MbitoFrame>({
      command,
      timeoutMs: DONGLE_INFO_TIMEOUT_MS,
      signal,
      onFrame: frame => ({ kind: 'done', value: frame }),
    });
    if (value.arg !== MbitoArg.SUCCESS) {
      throw new Error(`${MBITO_CMD_NAMES[command]} rejected by dongle (arg ${hexByte(value.arg)})`);
    }
    return value;
  }

  async exchange<T>(options: ExchangeOptions<T>): Promise<ExchangeResult<T>> {
    if (this.pending) throw new Error('MbitoClient: another exchange is in flight (scheduler bypassed)');
    options.signal?.throwIfAborted();
    const wait = this.linkBusyUntil - performance.now();
    if (wait > 0) {
      // A previous request was abandoned; let its late reply land before sending anything new.
      log('MBITO', 'Waiting for abandoned request window to close', { waitMs: Math.round(wait) });
      await sleep(wait, options.signal);
    }

    const name = MBITO_CMD_NAMES[options.command] ?? hexByte(options.command);
    const tx = encodeRequest(options.command, options.payload);
    const frames: ReceivedFrame[] = [];
    // Measured before the write: a reply can arrive before the GATT write acknowledgement resolves.
    const sentAt = performance.now();
    let writtenAt: number | null = null;

    return new Promise<ExchangeResult<T>>((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      let deadline = Number.POSITIVE_INFINITY;
      let settled = false;

      const finish = (outcome: () => void): void => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        options.signal?.removeEventListener('abort', onAbort);
        if (this.pending === pending) this.pending = undefined;
        outcome();
      };
      const armTimer = (): void => {
        if (timer) clearTimeout(timer);
        timer = setTimeout(() => {
          this.abandon(options.linkBusyForMs);
          log('MBITO', `${name} timed out`, { afterMs: Math.round(performance.now() - sentAt), frames: frames.length }, 'warn');
          finish(() => reject(new ExchangeTimeoutError(`${name}: niciun răspuns în ${options.timeoutMs} ms`, tx, sentAt, writtenAt, frames)));
        }, Math.max(0, deadline - performance.now()));
      };
      const onAbort = (): void => {
        this.abandon(options.linkBusyForMs);
        finish(() => reject(options.signal?.reason ?? new DOMException('Aborted', 'AbortError')));
      };

      const pending: Pending = {
        command: options.command,
        handle: (frame, receivedAt) => {
          let decision: FrameDecision<T>;
          try {
            decision = options.onFrame(frame);
          } catch (error) {
            finish(() => reject(error));
            return;
          }
          frames.push({ frame, receivedAt, decision: decision.kind === 'done' ? 'done' : `${decision.kind}: ${decision.reason}` });
          if (decision.kind === 'done') {
            finish(() => resolve({ value: decision.value, tx, sentAt, writtenAt, frames }));
          } else if (decision.kind === 'wait') {
            log('MBITO', `${name} interim frame, waiting`, { reason: decision.reason, hex: toHex(frame.raw) });
            if (decision.extendDeadlineMs !== undefined) {
              deadline = Math.max(Number.isFinite(deadline) ? deadline : 0, receivedAt + decision.extendDeadlineMs);
              armTimer();
            }
          } else {
            log('MBITO', `${name} frame ignored`, { reason: decision.reason, hex: toHex(frame.raw) }, 'warn');
          }
        },
        fail: error => {
          this.abandon(options.linkBusyForMs);
          finish(() => reject(error));
        },
      };
      this.pending = pending;
      options.signal?.addEventListener('abort', onAbort, { once: true });

      log('MBITO', `TX ${name}`, { hex: toHex(tx) });
      this.transport.write(tx).then(
        () => {
          writtenAt = performance.now();
          if (settled) return;
          // The browser deadline starts once the dongle has the request; never shorten an extension.
          if (!Number.isFinite(deadline)) {
            deadline = writtenAt + options.timeoutMs;
            armTimer();
          }
        },
        (error: unknown) => finish(() => reject(error)),
      );
    });
  }

  private abandon(linkBusyForMs = 0): void {
    this.linkBusyUntil = Math.max(this.linkBusyUntil, performance.now() + linkBusyForMs);
  }

  private handleChunk(chunk: Bytes): void {
    const receivedAt = performance.now();
    const { frames, dropped } = this.assembler.push(chunk, receivedAt);
    for (const bytes of dropped) log('MBITO', 'Dropped unparseable bytes', { hex: toHex(bytes) }, 'warn');
    for (const frame of frames) {
      const name = MBITO_CMD_NAMES[frame.command] ?? hexByte(frame.command);
      log('MBITO', `RX ${name}`, { hex: toHex(frame.raw), rawCommand: hexByte(frame.rawCommand), arg: hexByte(frame.arg) });
      // Broadcast first; a failing observer must never cost the waiting request its frame.
      for (const observer of this.frameObservers) {
        try {
          observer(frame, receivedAt);
        } catch (error) {
          log('MBITO', 'Frame observer failed', { error: (error as Error).message }, 'error');
        }
      }
      if (this.pending && frame.isResponse && frame.command === this.pending.command) {
        this.pending.handle(frame, receivedAt);
      } else {
        log('MBITO', 'Unsolicited frame (no matching request in flight)', { hex: toHex(frame.raw) }, 'warn');
      }
    }
  }
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => {
      clearTimeout(timer);
      reject(signal.reason);
    }, { once: true });
  });
}
