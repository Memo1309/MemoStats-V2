import { beforeEach, describe, expect, it } from 'vitest';
import { clearHistory, historyStore, recordScan } from './inventoryHistory';

const scan = (responding: string[], all = ['a', 'b', 'c']) =>
  all.map(key => ({ key, name: key.toUpperCase(), responded: responding.includes(key), status: responding.includes(key) ? 'RESPONDS' : 'NO_ANSWER' }));

describe('inventory history', () => {
  beforeEach(() => clearHistory());

  it('the first scan is the baseline: nothing is "new"', () => {
    expect(recordScan(scan(['a', 'b']), 1)).toEqual([]);
    expect(historyStore.get().modules.a?.seenCount).toBe(1);
  });

  it('a module seen for the first time after the baseline is new', () => {
    recordScan(scan(['a', 'b']), 1);
    expect(recordScan(scan(['a', 'b', 'c']), 2)).toEqual(['c']);
  });

  it('a missed module is kept with a miss count, never deleted', () => {
    recordScan(scan(['a', 'b']), 1);
    recordScan(scan(['a']), 2);
    expect(historyStore.get().modules.b).toMatchObject({ seenCount: 1, missCount: 1, lastSeenAt: 1, lastStatus: 'NO_ANSWER' });
  });

  it('never-seen silent modules are not recorded', () => {
    recordScan(scan([]), 1);
    expect(historyStore.get().modules).toEqual({});
  });
});
