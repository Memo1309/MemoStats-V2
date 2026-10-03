import { createStore, loadJson, saveJson } from './createStore';

export interface Settings {
  /** V1 live cycle period (V1 default 300 ms) */
  pollPeriodMs: 300 | 500 | 1000;
  /** start live data automatically when the V1 preflight got an OBD answer */
  autoStartLive: boolean;
  /** read F100 (variant) after a positive 0x33 probe during ECU scan */
  identifyAfterProbe: boolean;
}

const KEY = 'memostats.v2.settings.v1';
const DEFAULTS: Settings = { pollPeriodMs: 300, autoStartLive: true, identifyAfterProbe: true };

const isSettings = (v: unknown): v is Settings =>
  typeof v === 'object' && v !== null && [300, 500, 1000].includes((v as Settings).pollPeriodMs)
  && typeof (v as Settings).autoStartLive === 'boolean' && typeof (v as Settings).identifyAfterProbe === 'boolean';

export const settingsStore = createStore<Settings>(loadJson(KEY, DEFAULTS, isSettings));

export function updateSettings(patch: Partial<Settings>): void {
  settingsStore.set(s => ({ ...s, ...patch }));
  saveJson(KEY, settingsStore.get());
}
