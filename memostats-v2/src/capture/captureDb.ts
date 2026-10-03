// IndexedDB storage for capture sessions: survives tab switches and page refresh (the BLE link does not).
import type { CaptureEvent, CaptureSessionMeta } from './capture';

const DB_NAME = 'memostats-v2-capture';
const SESSIONS = 'sessions';
/** key: [sessionId, index] — one session's events are one key range, already in order */
const EVENTS = 'events';

let dbPromise: Promise<IDBDatabase> | null = null;

function db(): Promise<IDBDatabase> {
  if (typeof indexedDB === 'undefined') return Promise.reject(new Error('IndexedDB indisponibil'));
  dbPromise ??= new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => {
      request.result.createObjectStore(SESSIONS, { keyPath: 'id' });
      request.result.createObjectStore(EVENTS, { keyPath: ['sessionId', 'index'] });
    };
    request.onsuccess = () => {
      request.result.onclose = () => { dbPromise = null; };
      resolve(request.result);
    };
    request.onerror = () => {
      dbPromise = null;
      reject(request.error ?? new Error('IndexedDB open failed'));
    };
  });
  return dbPromise;
}

/** Resolves when the transaction commits; `body` queues the requests, the last one's result is returned. */
async function run<T>(stores: string[], mode: IDBTransactionMode, body: (tx: IDBTransaction) => IDBRequest<T> | null): Promise<T | null> {
  const tx = (await db()).transaction(stores, mode);
  const request = body(tx);
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve(request ? request.result : null);
    tx.onerror = () => reject(tx.error ?? new Error('IndexedDB transaction failed'));
    tx.onabort = () => reject(tx.error ?? new Error('IndexedDB transaction aborted'));
  });
}

const sessionRange = (id: string) => IDBKeyRange.bound([id, 0], [id, Number.MAX_SAFE_INTEGER]);

export async function saveSession(meta: CaptureSessionMeta): Promise<void> {
  await run([SESSIONS], 'readwrite', tx => tx.objectStore(SESSIONS).put(meta));
}

/** Event and updated session counters in one transaction, so they never disagree after a refresh. */
export async function appendEvent(event: CaptureEvent, meta: CaptureSessionMeta): Promise<void> {
  await run([SESSIONS, EVENTS], 'readwrite', tx => {
    tx.objectStore(EVENTS).put(event);
    return tx.objectStore(SESSIONS).put(meta);
  });
}

export async function listSessions(): Promise<CaptureSessionMeta[]> {
  const all = (await run([SESSIONS], 'readonly', tx => tx.objectStore(SESSIONS).getAll() as IDBRequest<CaptureSessionMeta[]>)) ?? [];
  return all.sort((a, b) => b.startedAt.localeCompare(a.startedAt));
}

export async function loadEvents(id: string): Promise<CaptureEvent[]> {
  return (await run([EVENTS], 'readonly', tx => tx.objectStore(EVENTS).getAll(sessionRange(id)) as IDBRequest<CaptureEvent[]>)) ?? [];
}

export async function deleteSession(id: string): Promise<void> {
  await run([SESSIONS, EVENTS], 'readwrite', tx => {
    tx.objectStore(SESSIONS).delete(id);
    return tx.objectStore(EVENTS).delete(sessionRange(id));
  });
}
