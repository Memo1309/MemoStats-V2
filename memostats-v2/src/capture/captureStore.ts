import { toHex } from '../core/bytes';
import type { RawLink, RawLinkEvent } from '../core/ble/mbitoBleTransport';
import { MBITO_CHARACTERISTIC_UUID, MBITO_SERVICE_UUID } from '../core/mbito/constants';
import { log } from '../logs/logStore';
import { createStore } from '../state/createStore';
import { type CaptureEvent, type CapturePacket, type CaptureSessionMeta, parsePacket } from './capture';
import { appendEvent, deleteSession, listSessions, loadEvents, saveSession } from './captureDb';

// One passive capture at a time. While it runs the link refuses every MemoStats write, so the
// session contains only what the dongle notified (e.g. replies to the official MBito app).

export interface CaptureState {
  status: 'READY' | 'CAPTURING';
  /** the live session, or a saved one reopened for viewing */
  session: CaptureSessionMeta | null;
  events: CaptureEvent[];
  saved: CaptureSessionMeta[];
  /** storage problem; the capture itself keeps running in memory */
  storageError: string | null;
}

export const captureStore = createStore<CaptureState>({ status: 'READY', session: null, events: [], saved: [], storageError: null });

export const SILENT_REASON = 'Captură pasivă activă — MemoStats nu transmite nimic';

let link: RawLink | null = null;
let untap: (() => void) | null = null;
let startPerf = 0;

export const isCapturing = (): boolean => captureStore.get().status === 'CAPTURING';

const storageFailed = (error: unknown): void => {
  const message = error instanceof Error ? error.message : String(error);
  captureStore.set(s => (s.storageError === message ? s : { ...s, storageError: message }));
};

function sessionId(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `capture-${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
}

function record(build: (base: { sessionId: string; index: number; iso: string; perfMs: number; relMs: number }) => CaptureEvent, perfMs = performance.now()): void {
  const { session, events } = captureStore.get();
  if (!session) return;
  const event = build({ sessionId: session.id, index: (events.at(-1)?.index ?? 0) + 1, iso: new Date().toISOString(), perfMs, relMs: perfMs - startPerf });
  const packet = event.kind === 'PACKET' ? event : null;
  const meta: CaptureSessionMeta = {
    ...session,
    packetCount: session.packetCount + (packet ? 1 : 0),
    byteCount: session.byteCount + (packet?.length ?? 0),
    markerCount: session.markerCount + (packet ? 0 : 1),
    unexpectedTxCount: session.unexpectedTxCount + (packet?.unexpectedTx ? 1 : 0),
    lastRxAt: packet?.direction === 'RX' ? event.iso : session.lastRxAt,
  };
  captureStore.set(s => ({ ...s, session: meta, events: [...s.events, event] }));
  appendEvent(event, meta).catch(storageFailed);
}

function onRaw(raw: RawLinkEvent): void {
  // While listening every TX is unexpected: MemoStats must stay silent (the link blocked it).
  const unexpectedTx = raw.direction === 'TX';
  if (unexpectedTx) log('APP', 'UNEXPECTED MEMOSTATS TX during passive capture', { hex: toHex(raw.bytes), blocked: raw.blocked }, 'error');
  record(base => ({
    ...base, kind: 'PACKET', direction: raw.direction, rawHex: toHex(raw.bytes), length: raw.bytes.length, unexpectedTx, ...parsePacket(raw.bytes),
  }) satisfies CapturePacket, raw.perfMs);
}

/** START CAPTURE: callers stop their own traffic first; from here the link refuses every write. */
export function startCapture(target: RawLink, info: { app: string; device: string | null; firmware: string | null }): void {
  if (isCapturing()) return;
  const now = new Date();
  const session: CaptureSessionMeta = {
    id: sessionId(now), startedAt: now.toISOString(), endedAt: null, ...info,
    service: MBITO_SERVICE_UUID, characteristic: MBITO_CHARACTERISTIC_UUID,
    packetCount: 0, byteCount: 0, markerCount: 0, unexpectedTxCount: 0, lastRxAt: null,
  };
  link = target;
  link.blockWrites(SILENT_REASON);
  startPerf = performance.now();
  untap = link.onRaw(onRaw);
  captureStore.set(s => ({ ...s, status: 'CAPTURING', session, events: [], storageError: null }));
  saveSession(session).catch(storageFailed);
  log('APP', `Passive capture started (${session.id})`);
}

export function stopCapture(): void {
  if (!isCapturing()) return;
  untap?.();
  untap = null;
  link?.blockWrites(null);
  link = null;
  const session = captureStore.get().session;
  const ended = session && { ...session, endedAt: new Date().toISOString() };
  captureStore.set(s => ({ ...s, status: 'READY', session: ended }));
  if (ended) saveSession(ended).then(refreshSaved).catch(storageFailed);
  log('APP', `Passive capture stopped (${ended?.packetCount ?? 0} packets)`);
}

/** Timeline-only note; nothing is sent. */
export function addMarker(text: string): void {
  if (!isCapturing()) return;
  const n = captureStore.get().session?.markerCount ?? 0;
  record(base => ({ ...base, kind: 'MARKER', text: text.trim() || `Marker ${n + 1}` }));
}

/** CLEAR SESSION: stops a live capture and deletes the open session (view + storage). */
export function clearSession(): void {
  stopCapture();
  const id = captureStore.get().session?.id;
  captureStore.set(s => ({ ...s, session: null, events: [] }));
  if (id) deleteSession(id).then(refreshSaved).catch(storageFailed);
}

export async function refreshSaved(): Promise<void> {
  try {
    const saved = await listSessions();
    captureStore.set(s => ({ ...s, saved }));
  } catch (error) {
    storageFailed(error);
  }
}

export async function openSaved(id: string): Promise<void> {
  if (isCapturing()) return;
  try {
    const session = captureStore.get().saved.find(s => s.id === id);
    const events = await loadEvents(id);
    if (session) captureStore.set(s => ({ ...s, session, events }));
  } catch (error) {
    storageFailed(error);
  }
}

// ---------- file helpers ----------

export function downloadText(filename: string, text: string, mime = 'application/json'): void {
  const url = URL.createObjectURL(new Blob([text], { type: mime }));
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** Clipboard API first; Bluefy/older WebKit fall back to a selected textarea. */
export async function copyText(text: string): Promise<void> {
  if (navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      return;
    } catch {
      // fall through to the legacy path
    }
  }
  const area = document.createElement('textarea');
  area.value = text;
  area.setAttribute('readonly', '');
  area.style.position = 'fixed';
  area.style.opacity = '0';
  document.body.appendChild(area);
  area.select();
  area.setSelectionRange(0, text.length);
  try {
    if (!document.execCommand('copy')) throw new Error('Copierea a fost refuzată de browser');
  } finally {
    area.remove();
  }
}
