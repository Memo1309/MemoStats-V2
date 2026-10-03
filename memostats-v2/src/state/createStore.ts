import { useSyncExternalStore } from 'react';

/** Minimal external store: immutable snapshots, React reads it with useSyncExternalStore. */
export function createStore<T>(initial: T) {
  let state = initial;
  const listeners = new Set<() => void>();
  const get = (): T => state;
  const subscribe = (listener: () => void): (() => void) => {
    listeners.add(listener);
    return () => listeners.delete(listener);
  };
  return {
    get,
    subscribe,
    set(update: (current: T) => T): void {
      state = update(state);
      for (const listener of listeners) listener();
    },
    use: (): T => useSyncExternalStore(subscribe, get),
  };
}

/** localStorage with a versioned key; any failure (private mode, quota, old schema) falls back. */
export function loadJson<T>(key: string, fallback: T, valid: (v: unknown) => v is T): T {
  try {
    const raw = localStorage.getItem(key);
    const parsed: unknown = raw ? JSON.parse(raw) : null;
    return valid(parsed) ? parsed : fallback;
  } catch {
    return fallback;
  }
}

export function saveJson(key: string, value: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // storage unavailable — the app keeps working in memory
  }
}
