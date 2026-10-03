import { describe, expect, it } from 'vitest';
import { nn } from '../testing/nn';
// Read-only import of the immutable DB (never written). Cast through unknown so tsc keeps no 2 MB literal type.
import rawDb from '../../public/data/w176/memostats-w176-ecu-db-2026-09-29.json';
import { readBits } from './bits';
import { codingFeaturesForVariant, decodeFeature } from './codingModel';
import { featureStatus } from './featureStatus';
import type { W176Db } from '../w176/types';

const db = rawDb as unknown as W176Db;

describe('coding model from the real W176 DB', () => {
  it('IC172 variant 11497 exposes Temperature units (section 14, read 220200, bit 0 len 1) with real options', () => {
    const features = codingFeaturesForVariant(db, 11497);
    const temp = features.find(f => f.name.toLowerCase().includes('temperature'));
    expect(temp).toBeTruthy();
    expect(temp?.section).toMatchObject({ id: 14, readHex: '220200', writeHex: '2E0200', codingLength: 6, accessLevel: 0 });
    expect(temp?.readField).toEqual({ bitPosition: 0, bitLength: 1 });
    expect(temp?.options.map(o => o.valueMeaning)).toHaveLength(2);
    expect(featureStatus(nn(temp), { ecuDetected: true, variantMatches: true, variantId: 11497 })).toBe('READY_READ_WRITE');
  });

  it('IC172 Needles sweep (section 85, read 220201, bit 2 len 1, coding length 12)', () => {
    const sweep = codingFeaturesForVariant(db, 11497).find(f => f.name.toLowerCase().includes('needle'));
    expect(sweep?.section).toMatchObject({ id: 85, readHex: '220201', codingLength: 12, accessLevel: 0 });
    expect(sweep?.readField).toEqual({ bitPosition: 2, bitLength: 1 });
  });

  it('decodes a current value from a block: temperature bit 0 = 1 -> the °F option', () => {
    const temp = nn(codingFeaturesForVariant(db, 11497).find(f => f.name.toLowerCase().includes('temperature')));
    const block = new Uint8Array(6);
    block[0] = 0x80; // bit 0 set
    const decoded = decodeFeature(block, temp, readBits);
    expect(decoded.currentValue).toBe(1);
    expect(decoded.currentOptionId).toBe(temp.options.find(o => o.patches[0]?.value === 1)?.optionId);
  });

  it('CBCBOLERO variant 7537 has a custom-overwrite feature (SAM antitheft, section 148) applied atomically', () => {
    const features = codingFeaturesForVariant(db, 7537);
    const custom = features.find(f => f.options.some(o => o.isCustom));
    expect(custom).toBeTruthy();
    const disabled = custom?.options.find(o => o.isCustom);
    expect(disabled?.patches.length).toBeGreaterThan(1); // multiple bit fields in one option
    expect(custom?.readField).toBeNull(); // custom features decode by matching, not a single field
  });

  it('One touch turn signal (CBC section 71, read 220363, bit 40 len 8, coding length 41)', () => {
    const oneTouch = codingFeaturesForVariant(db, 7537).find(f => f.name.toLowerCase().includes('one touch'));
    expect(oneTouch?.section).toMatchObject({ id: 71, readHex: '220363', codingLength: 41, accessLevel: 0 });
    expect(oneTouch?.readField).toEqual({ bitPosition: 40, bitLength: 8 });
  });

  it('every access-level-0 IC172/CBC feature is READY_READ_WRITE when detected + variant matches', () => {
    for (const variant of [11497, 7537]) {
      for (const f of codingFeaturesForVariant(db, variant)) {
        if (f.section.accessLevel === 0 && f.featureType !== 'sequence') {
          expect(featureStatus(f, { ecuDetected: true, variantMatches: true, variantId: variant })).toBe('READY_READ_WRITE');
        }
      }
    }
  });
});
