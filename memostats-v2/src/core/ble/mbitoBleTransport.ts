import { type Bytes, toHex } from '../bytes';
import { MBITO_CHARACTERISTIC_UUID, MBITO_SERVICE_UUID } from '../mbito/constants';
import { log } from '../../logs/logStore';

/** What the MBito client needs from a byte pipe. Implemented by the BLE transport and by test fakes. */
export interface ByteTransport {
  write(bytes: Bytes): Promise<void>;
  onData(listener: (chunk: Bytes) => void): () => void;
  /** userInitiated=false means the link dropped on its own. */
  onDisconnect(listener: (userInitiated: boolean) => void): () => void;
}

/** One raw link event: a notification exactly as received, or a write attempt exactly as requested. */
export interface RawLinkEvent {
  direction: 'RX' | 'TX';
  bytes: Bytes;
  /** performance.now() */
  perfMs: number;
  /** TX refused because writes are blocked (nothing reached the dongle) */
  blocked: boolean;
}

/** What passive capture needs: a raw tap and a way to keep MemoStats silent. */
export interface RawLink {
  onRaw(listener: (event: RawLinkEvent) => void): () => void;
  /** Non-null = every write is refused with this reason. */
  blockWrites(reason: string | null): void;
}

function isolated(run: () => void): void {
  try {
    run();
  } catch (error) {
    log('BLE', 'Notification listener failed', { error: error instanceof Error ? error.message : String(error) }, 'error');
  }
}

// Web Bluetooth allows at most 512 bytes per characteristic write.
const MAX_GATT_WRITE = 512;

/**
 * Web Bluetooth transport for the MBito dongle. Knows GATT, nothing about MBito or UDS semantics.
 * Connect sequence and write fallback chain are the ones proven on Bluefy by old MemoStats.
 */
export class MbitoBleTransport implements ByteTransport, RawLink {
  private device?: BluetoothDevice;
  private characteristic?: BluetoothRemoteGATTCharacteristic;
  private writeChain: Promise<void> = Promise.resolve();
  private userInitiatedDisconnect = false;
  private writeBlock: string | null = null;
  private readonly dataListeners = new Set<(chunk: Bytes) => void>();
  private readonly disconnectListeners = new Set<(userInitiated: boolean) => void>();
  private readonly rawListeners = new Set<(event: RawLinkEvent) => void>();

  static isSupported(): boolean {
    return typeof navigator !== 'undefined' && 'bluetooth' in navigator;
  }

  get connected(): boolean {
    return this.device?.gatt?.connected === true && this.characteristic !== undefined;
  }

  get deviceName(): string | undefined {
    return this.device?.name ?? undefined;
  }

  /** Opens the browser device chooser (must run inside a user gesture), then connects. */
  async connect(): Promise<string> {
    if (!MbitoBleTransport.isSupported()) throw new Error('Web Bluetooth indisponibil în acest browser');
    log('BLE', 'Requesting device', { service: MBITO_SERVICE_UUID });
    const device = await navigator.bluetooth.requestDevice({
      filters: [{ services: [MBITO_SERVICE_UUID] }],
      optionalServices: [MBITO_SERVICE_UUID],
    });
    if (this.device !== device) {
      this.device?.removeEventListener('gattserverdisconnected', this.handleGattDisconnected);
      this.device = device;
      device.addEventListener('gattserverdisconnected', this.handleGattDisconnected);
    }
    await this.openGatt();
    return device.name ?? 'MBito';
  }

  /** Reconnects to the previously chosen device without the chooser. */
  async reconnect(): Promise<string> {
    if (!this.device) throw new Error('No previously selected MBito device');
    await this.openGatt();
    return this.device.name ?? 'MBito';
  }

  disconnect(): void {
    this.userInitiatedDisconnect = true;
    if (this.device?.gatt?.connected) this.device.gatt.disconnect();
    else this.teardown();
  }

  write(bytes: Bytes): Promise<void> {
    if (this.writeBlock !== null) {
      // Passive capture: nothing may reach the dongle. The attempt itself is recorded, never sent.
      log('BLE', 'UNEXPECTED MEMOSTATS TX (blocked)', { hex: toHex(bytes), reason: this.writeBlock }, 'error');
      this.tap('TX', bytes, true);
      return Promise.reject(new Error(this.writeBlock));
    }
    // GATT allows one operation at a time; chain writes so callers never collide.
    const run = this.writeChain.then(() => this.writeNow(bytes));
    this.writeChain = run.catch(() => undefined);
    return run;
  }

  onData(listener: (chunk: Bytes) => void): () => void {
    this.dataListeners.add(listener);
    return () => this.dataListeners.delete(listener);
  }

  onRaw(listener: (event: RawLinkEvent) => void): () => void {
    this.rawListeners.add(listener);
    return () => this.rawListeners.delete(listener);
  }

  blockWrites(reason: string | null): void {
    this.writeBlock = reason;
    log('BLE', reason === null ? 'Writes allowed again' : `Writes blocked: ${reason}`);
  }

  private tap(direction: RawLinkEvent['direction'], bytes: Bytes, blocked: boolean): void {
    const event = { direction, bytes: bytes.slice(), perfMs: performance.now(), blocked };
    for (const listener of this.rawListeners) isolated(() => listener(event));
  }

  onDisconnect(listener: (userInitiated: boolean) => void): () => void {
    this.disconnectListeners.add(listener);
    return () => this.disconnectListeners.delete(listener);
  }

  private async openGatt(): Promise<void> {
    const gatt = this.device?.gatt;
    if (!gatt) throw new Error('Selected device exposes no GATT server');
    this.userInitiatedDisconnect = false;
    log('BLE', 'Connecting GATT', { device: this.device?.name ?? null });
    const server = await gatt.connect();
    const service = await server.getPrimaryService(MBITO_SERVICE_UUID);
    const characteristic = await service.getCharacteristic(MBITO_CHARACTERISTIC_UUID);
    await characteristic.startNotifications();
    characteristic.addEventListener('characteristicvaluechanged', this.handleValue);
    this.characteristic = characteristic;
    log('BLE', 'Connected, notifications enabled', {
      device: this.device?.name ?? null,
      write: characteristic.properties.write,
      writeWithoutResponse: characteristic.properties.writeWithoutResponse,
    });
  }

  private async writeNow(bytes: Bytes): Promise<void> {
    const characteristic = this.characteristic;
    if (!characteristic || !this.connected) throw new Error('MBito nu este conectat');
    if (bytes.length > MAX_GATT_WRITE) throw new RangeError(`GATT write of ${bytes.length} B exceeds ${MAX_GATT_WRITE} B`);
    log('BLE', 'TX', { hex: toHex(bytes), length: bytes.length });
    this.tap('TX', bytes, false);
    // Bluefy may expose only the legacy writeValue(); keep the fallback chain old MemoStats proved.
    if (characteristic.writeValueWithResponse) await characteristic.writeValueWithResponse(bytes);
    else if (characteristic.writeValueWithoutResponse) await characteristic.writeValueWithoutResponse(bytes);
    else await characteristic.writeValue(bytes);
  }

  private readonly handleValue = (event: Event): void => {
    const value = (event.target as BluetoothRemoteGATTCharacteristic).value;
    if (!value) return;
    // Copy: some stacks reuse the DataView's buffer for the next notification.
    const chunk = new Uint8Array(value.buffer, value.byteOffset, value.byteLength).slice();
    log('BLE', 'RX', { hex: toHex(chunk), length: chunk.length });
    // Raw tap first: every notification on FF01, including replies to the official MBito app.
    this.tap('RX', chunk, false);
    // Every listener gets the same notification; one failing listener never starves the others.
    for (const listener of this.dataListeners) isolated(() => listener(chunk));
  };

  private readonly handleGattDisconnected = (): void => {
    log('BLE', this.userInitiatedDisconnect ? 'Disconnected by user' : 'Connection lost', undefined,
      this.userInitiatedDisconnect ? 'info' : 'warn');
    this.teardown();
  };

  private teardown(): void {
    this.characteristic?.removeEventListener('characteristicvaluechanged', this.handleValue);
    this.characteristic = undefined;
    for (const listener of this.disconnectListeners) listener(this.userInitiatedDisconnect);
  }
}
