import type { UdsExchangeResult } from '../core/uds/udsChannel';
import type { Med40TestResult } from '../vehicle/identification/med40Test';
import type { ReplicaTestResult } from '../vehicle/identification/officialReplica';
import type { PreflightResult } from '../vehicle/v1Preflight';
import { createStore } from './createStore';

export type ConnectionState = 'disconnected' | 'connecting' | 'connected' | 'lost';

/** A value plus when it was read (epoch ms). Never shown as live once the link is gone. */
export interface Sample<T> {
  value: T;
  at: number;
}

export interface DongleState {
  name?: string;
  firmware?: string;
  voltage?: Sample<number>;
  errors: string[];
  reading: boolean;
}

export interface TestState<T> {
  status: 'idle' | 'running' | 'done' | 'error';
  result?: T;
  error?: string;
  finishedAt?: number;
}

export interface AppState {
  connection: ConnectionState;
  connectionError?: string;
  bleDeviceName?: string;
  dongle: DongleState;
  /** V1 connect-time sequence: GET_CAN_BAUD, 01 0D, 01 0C, supported PIDs */
  preflight: TestState<PreflightResult>;
  med40: TestState<Med40TestResult>;
  replica: TestState<ReplicaTestResult>;
  manual: TestState<UdsExchangeResult>;
}

const appStore = createStore<AppState>({
  connection: 'disconnected',
  dongle: { errors: [], reading: false },
  preflight: { status: 'idle' },
  med40: { status: 'idle' },
  replica: { status: 'idle' },
  manual: { status: 'idle' },
});

export const getState = appStore.get;
export const setState = appStore.set;
export const useAppState = appStore.use;
