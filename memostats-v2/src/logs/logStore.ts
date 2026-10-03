export type LogCategory =
  | 'APP' | 'BLE' | 'MBITO' | 'UDS' | 'OBD' | 'SCAN' | 'DTC'
  | 'LIVE' | 'PERF' | 'SESSION' | 'MILEAGE' | 'STROBE';

export type LogLevel = 'info' | 'warn' | 'error';

export type LogDetailValue = string | number | boolean | null;

export interface LogEntry {
  id: number;
  /** epoch ms, for humans */
  at: number;
  category: LogCategory;
  level: LogLevel;
  message: string;
  /** expanded technical data: raw frames, header fields, durations */
  detail?: Record<string, LogDetailValue>;
}

// ponytail: bounded ring, copied on each append (O(n)); fine at diagnostic rates, revisit if telemetry logs every sample.
const MAX_ENTRIES = 1500;

let entries: readonly LogEntry[] = [];
let nextId = 1;
const listeners = new Set<() => void>();

function emit(): void {
  for (const listener of listeners) listener();
}

export const logStore = {
  getSnapshot: (): readonly LogEntry[] => entries,
  subscribe(listener: () => void): () => void {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },
  clear(): void {
    entries = [];
    emit();
  },
};

export function log(
  category: LogCategory,
  message: string,
  detail?: Record<string, LogDetailValue>,
  level: LogLevel = 'info',
): void {
  const entry: LogEntry = { id: nextId++, at: Date.now(), category, level, message, detail };
  entries = entries.length >= MAX_ENTRIES ? [...entries.slice(1 - MAX_ENTRIES), entry] : [...entries, entry];
  emit();
}

/** Local wall-clock time with milliseconds, e.g. 23:03:13.438 */
export function formatLogTime(at: number): string {
  const d = new Date(at);
  const pad = (n: number, width = 2) => String(n).padStart(width, '0');
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}`;
}

export function formatLogEntry(entry: LogEntry): string {
  const head = `${formatLogTime(entry.at)} ${entry.level.toUpperCase().padEnd(5)} ${entry.category.padEnd(6)} ${entry.message}`;
  if (!entry.detail) return head;
  const lines = Object.entries(entry.detail).map(([key, value]) => `    ${key}: ${String(value)}`);
  return [head, ...lines].join('\n');
}
