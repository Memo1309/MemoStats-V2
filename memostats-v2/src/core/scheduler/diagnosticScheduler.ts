import { log } from '../../logs/logStore';

/** Lower runs first. Performance timing outranks everything (spec §22). */
export const Priority = {
  PERFORMANCE: 0,
  INTERACTIVE: 1,
  TELEMETRY: 2,
  BACKGROUND: 3,
} as const;
export type Priority = (typeof Priority)[keyof typeof Priority];

interface Job {
  seq: number;
  label: string;
  priority: Priority;
  controller: AbortController;
  run(signal: AbortSignal): Promise<unknown>;
  resolve(value: unknown): void;
  reject(reason: unknown): void;
}

export class CancelledError extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = 'CancelledError';
  }
}

/**
 * The single gate to the dongle: exactly one diagnostic operation in flight, the rest queued by
 * priority then arrival. Scan, DTC, live and performance requests can never overlap.
 */
export class DiagnosticScheduler {
  private queue: Job[] = [];
  private active?: Job;
  private seq = 0;
  /** Non-null reason = refuse every new operation (passive capture: MemoStats must not transmit). */
  private readonly gate: () => string | null;

  constructor(gate: () => string | null = () => null) {
    this.gate = gate;
  }

  get busy(): boolean {
    return this.active !== undefined;
  }

  get queued(): number {
    return this.queue.length;
  }

  run<T>(label: string, priority: Priority, task: (signal: AbortSignal) => Promise<T>, signal?: AbortSignal): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const job: Job = {
        seq: this.seq++,
        label,
        priority,
        controller: new AbortController(),
        run: task,
        resolve: value => resolve(value as T),
        reject,
      };
      const refused = this.gate();
      if (refused) {
        log('APP', `${label} refused: ${refused}`, undefined, 'warn');
        return reject(new CancelledError(`${label}: ${refused}`));
      }
      if (signal) {
        if (signal.aborted) return reject(new CancelledError(`${label}: cancelled before start`));
        signal.addEventListener('abort', () => this.cancel(job, `${label}: cancelled`), { once: true });
      }
      this.queue.push(job);
      this.queue.sort((a, b) => a.priority - b.priority || a.seq - b.seq);
      this.pump();
    });
  }

  /** Aborts the active operation and rejects everything queued (BLE disconnect, user stop). */
  cancelAll(reason: string): void {
    const queued = this.queue;
    this.queue = [];
    for (const job of queued) job.reject(new CancelledError(reason));
    this.active?.controller.abort(new CancelledError(reason));
    if (queued.length || this.active) log('APP', 'Scheduler cancelled', { reason, queued: queued.length, active: this.active?.label ?? null });
  }

  private cancel(job: Job, reason: string): void {
    if (this.active === job) {
      job.controller.abort(new CancelledError(reason));
      return;
    }
    const index = this.queue.indexOf(job);
    if (index >= 0) {
      this.queue.splice(index, 1);
      job.reject(new CancelledError(reason));
    }
  }

  private pump(): void {
    if (this.active) return;
    const job = this.queue.shift();
    if (!job) return;
    this.active = job;
    Promise.resolve().then(() => job.run(job.controller.signal)).then(job.resolve, job.reject).finally(() => {
      this.active = undefined;
      this.pump();
    });
  }
}
