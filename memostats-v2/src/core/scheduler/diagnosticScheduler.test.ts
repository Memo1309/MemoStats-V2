import { describe, expect, it } from 'vitest';
import { CancelledError, DiagnosticScheduler, Priority } from './diagnosticScheduler';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(r => { resolve = r; });
  return { promise, resolve };
}

describe('DiagnosticScheduler', () => {
  it('never runs two operations at once', async () => {
    const scheduler = new DiagnosticScheduler();
    let active = 0;
    let maxActive = 0;
    const job = async () => {
      active++;
      maxActive = Math.max(maxActive, active);
      await new Promise(r => setTimeout(r, 2));
      active--;
    };
    await Promise.all([1, 2, 3, 4].map(n => scheduler.run(`job${n}`, Priority.TELEMETRY, job)));
    expect(maxActive).toBe(1);
  });

  it('runs queued work by priority, then arrival', async () => {
    const scheduler = new DiagnosticScheduler();
    const gate = deferred();
    const order: string[] = [];
    const record = (name: string) => async () => { order.push(name); };
    const first = scheduler.run('first', Priority.BACKGROUND, () => gate.promise.then(() => { order.push('first'); }));
    const jobs = [
      scheduler.run('scan', Priority.BACKGROUND, record('scan')),
      scheduler.run('live', Priority.TELEMETRY, record('live')),
      scheduler.run('perf', Priority.PERFORMANCE, record('perf')),
      scheduler.run('live2', Priority.TELEMETRY, record('live2')),
    ];
    gate.resolve();
    await Promise.all([first, ...jobs]);
    expect(order).toEqual(['first', 'perf', 'live', 'live2', 'scan']);
  });

  it('cancelAll aborts the active operation and rejects everything queued', async () => {
    const scheduler = new DiagnosticScheduler();
    let seenSignal: AbortSignal | undefined;
    const active = scheduler.run('active', Priority.INTERACTIVE, signal => {
      seenSignal = signal;
      return new Promise((_, reject) => signal.addEventListener('abort', () => reject(signal.reason)));
    });
    const queued = scheduler.run('queued', Priority.INTERACTIVE, async () => 'never');
    await Promise.resolve();
    scheduler.cancelAll('BLE disconnected');
    await expect(active).rejects.toBeInstanceOf(CancelledError);
    await expect(queued).rejects.toBeInstanceOf(CancelledError);
    expect(seenSignal?.aborted).toBe(true);
  });

  it('an external signal removes a queued job without touching the active one', async () => {
    const scheduler = new DiagnosticScheduler();
    const gate = deferred();
    const active = scheduler.run('active', Priority.INTERACTIVE, () => gate.promise.then(() => 'done'));
    const controller = new AbortController();
    const queued = scheduler.run('queued', Priority.INTERACTIVE, async () => 'never', controller.signal);
    controller.abort();
    await expect(queued).rejects.toBeInstanceOf(CancelledError);
    gate.resolve();
    await expect(active).resolves.toBe('done');
  });
});
