// Persistent coding backups (spec §8). Every write saves the ORIGINAL block here, before the write,
// keyed by ECU/variant/DID so Restore Original can be offered safely. Separate from the immutable DB.
export interface CodingBackup {
  readonly id: string; // `${ecuId}-${variantId}-${sectionId}-${timestamp}`
  readonly timestamp: number;
  readonly ecuId: number;
  readonly ecuName: string;
  readonly variantId: number;
  readonly variantName: string;
  readonly txId: number;
  readonly rxId: number;
  readonly hardwareNumber: string | null;
  readonly softwareNumber: string | null;
  readonly sectionId: number;
  readonly readHex: string;
  readonly writeHex: string;
  readonly codingLength: number;
  /** original block read from the ECU, hex */
  readonly originalBytes: string;
  /** block we intended to write, hex */
  readonly proposedBytes: string;
  readonly featureId: number;
  readonly featureName: string;
  readonly optionId: number;
  readonly optionMeaning: string;
  /** block read back after the write, hex; null until verified */
  readonly verifiedBytes: string | null;
  readonly status: 'PENDING' | 'VERIFIED' | 'FAILED' | 'RESTORED';
}

const DB_NAME = 'memostats-v2-coding';
const STORE = 'backups';
let dbPromise: Promise<IDBDatabase> | null = null;

// If IndexedDB is unavailable (private mode, test env), keep backups in memory for the session so the
// safety workflow can still save the original before a write — it just will not survive a reload.
const memory = new Map<string, CodingBackup>();
let useMemory = typeof indexedDB === 'undefined';

function db(): Promise<IDBDatabase> {
  if (typeof indexedDB === 'undefined') return Promise.reject(new Error('IndexedDB indisponibil'));
  dbPromise ??= new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => {
      const store = request.result.createObjectStore(STORE, { keyPath: 'id' });
      store.createIndex('by_ecu', ['ecuId', 'variantId', 'sectionId'], { unique: false });
    };
    request.onsuccess = () => {
      request.result.onclose = () => { dbPromise = null; };
      resolve(request.result);
    };
    request.onerror = () => { dbPromise = null; reject(request.error ?? new Error('IndexedDB open failed')); };
  });
  return dbPromise;
}

async function run<T>(mode: IDBTransactionMode, body: (store: IDBObjectStore) => IDBRequest<T> | null): Promise<T | null> {
  const tx = (await db()).transaction(STORE, mode);
  const request = body(tx.objectStore(STORE));
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve(request ? request.result : null);
    tx.onerror = () => reject(tx.error ?? new Error('IndexedDB transaction failed'));
    tx.onabort = () => reject(tx.error ?? new Error('IndexedDB transaction aborted'));
  });
}

export async function saveBackup(backup: CodingBackup): Promise<void> {
  if (!useMemory) {
    try {
      await run('readwrite', store => store.put(backup));
      return;
    } catch {
      useMemory = true; // fall back for the rest of the session
    }
  }
  memory.set(backup.id, backup);
}

export async function listBackups(): Promise<CodingBackup[]> {
  if (!useMemory) {
    try {
      const all = (await run('readonly', store => store.getAll() as IDBRequest<CodingBackup[]>)) ?? [];
      return all.sort((a, b) => b.timestamp - a.timestamp);
    } catch {
      useMemory = true;
    }
  }
  return [...memory.values()].sort((a, b) => b.timestamp - a.timestamp);
}

/** The most recent backup for a specific ECU/variant/section, for Restore Original. */
export async function latestBackupFor(ecuId: number, variantId: number, sectionId: number): Promise<CodingBackup | null> {
  const all = await listBackups();
  return all.find(b => b.ecuId === ecuId && b.variantId === variantId && b.sectionId === sectionId) ?? null;
}
