// Turns the immutable DB's coding metadata into a per-variant model the UI and writer consume.
// Nothing is hardcoded per feature: options, sections and bit fields all come from the JSON. A feature
// option is either a single bit field or a set of custom_options.overwrites applied atomically.
import { type BitPatch, parseCodingValue } from './bits';
import type { W176Db, W176Feature, W176FeatureOption, W176Section } from '../w176/types';

export interface CodingSectionRef {
  readonly id: number;
  readonly codingLength: number;
  readonly readHex: string; // e.g. "220200"
  readonly writeHex: string; // e.g. "2E0200"
  readonly accessLevel: number;
  readonly dllName: string | null;
  readonly seedLength: number | null;
  readonly keyLength: number | null;
}

export interface CodingOptionModel {
  readonly optionId: number;
  readonly valueMeaning: string;
  readonly patches: readonly BitPatch[];
  readonly isCustom: boolean;
}

export interface CodingFeatureModel {
  readonly featureId: number;
  readonly name: string;
  readonly description: string;
  readonly featureType: string;
  readonly section: CodingSectionRef;
  readonly options: readonly CodingOptionModel[];
  /** For plain single-field features, the bit field to read the current value from; null for custom features. */
  readonly readField: { readonly bitPosition: number; readonly bitLength: number } | null;
}

function sectionRef(s: W176Section): CodingSectionRef {
  return {
    id: s.id, codingLength: s.coding_length, readHex: s.payload_to_read, writeHex: s.payload_to_write,
    accessLevel: s.access_level ?? 0, dllName: s.dll_name, seedLength: s.seed_length, keyLength: s.key_length,
  };
}

function optionModel(fo: W176FeatureOption): CodingOptionModel {
  const overwrites = fo.custom_options?.overwrites;
  if (overwrites && overwrites.length) {
    return {
      optionId: fo.id, valueMeaning: fo.value_meaning, isCustom: true,
      patches: overwrites.map(o => ({ bitPosition: parseCodingValue(o.bit_position), bitLength: parseCodingValue(o.bit_length), value: parseCodingValue(o.value) })),
    };
  }
  return { optionId: fo.id, valueMeaning: fo.value_meaning, isCustom: false, patches: [{ bitPosition: fo.bit_position, bitLength: fo.bit_length, value: fo.value }] };
}

interface RawBinding {
  featureId: number;
  feature: W176Feature | undefined;
  section: W176Section;
  option: W176FeatureOption;
}

/** Collects every option binding for a variant from both metadata sources, then de-duplicates. */
function bindingsForVariant(db: W176Db, variantId: number): RawBinding[] {
  const featureById = new Map(db.coding.features.map(f => [f.id, f]));
  const seen = new Set<string>();
  const out: RawBinding[] = [];
  const add = (b: RawBinding) => {
    const key = `${b.featureId}/${b.section.id}/${b.option.id}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push(b);
  };
  for (const f of db.coding.features) {
    for (const fo of f.FeaturesOptions ?? []) {
      if (fo.ECUVariant.id === variantId) add({ featureId: f.id, feature: f, section: fo.ECUSection, option: fo.FeatureOption });
    }
  }
  for (const s of db.coding.sections) {
    for (const con of s.ECUFeatureOptionsConnectors ?? []) {
      if (con.ecu_variant_id === variantId) add({ featureId: con.feature_id, feature: featureById.get(con.feature_id), section: s, option: con.FeatureOption });
    }
  }
  return out;
}

/** The coding features available for a given ECU variant, assembled from the DB. */
export function codingFeaturesForVariant(db: W176Db, variantId: number): CodingFeatureModel[] {
  const grouped = new Map<number, RawBinding[]>();
  for (const b of bindingsForVariant(db, variantId)) {
    const list = grouped.get(b.featureId) ?? [];
    list.push(b);
    grouped.set(b.featureId, list);
  }
  const features: CodingFeatureModel[] = [];
  for (const [featureId, bindings] of grouped) {
    const feature = bindings[0]?.feature;
    const section = bindings[0]?.section;
    if (!section) continue;
    const options = bindings.map(b => optionModel(b.option));
    const first = options[0];
    const readField = first && !first.isCustom && options.every(o => !o.isCustom && o.patches[0]?.bitPosition === first.patches[0]?.bitPosition && o.patches[0]?.bitLength === first.patches[0]?.bitLength)
      ? { bitPosition: first.patches[0]?.bitPosition ?? 0, bitLength: first.patches[0]?.bitLength ?? 0 }
      : null;
    features.push({
      featureId,
      name: feature?.function_name ?? `Feature ${featureId}`,
      description: feature?.description ?? '',
      featureType: feature?.feature_type ?? 'single',
      section: sectionRef(section),
      options,
      readField,
    });
  }
  return features.sort((a, b) => a.featureId - b.featureId);
}

/** Decoded current state of a feature from a read coding block. */
export interface DecodedFeature {
  readonly currentOptionId: number | null;
  readonly currentValue: number | null;
  readonly currentMeaning: string | null;
}

/** Reads the feature's current value/option from a coding block (single field, or by matching overwrites). */
export function decodeFeature(block: Uint8Array, feature: CodingFeatureModel, read: (bytes: Uint8Array, pos: number, len: number) => number): DecodedFeature {
  if (feature.readField) {
    const value = read(block, feature.readField.bitPosition, feature.readField.bitLength);
    const option = feature.options.find(o => o.patches[0]?.value === value) ?? null;
    return { currentOptionId: option?.optionId ?? null, currentValue: value, currentMeaning: option?.valueMeaning ?? null };
  }
  const match = feature.options.find(o => o.patches.every(p => read(block, p.bitPosition, p.bitLength) === p.value)) ?? null;
  return { currentOptionId: match?.optionId ?? null, currentValue: null, currentMeaning: match?.valueMeaning ?? null };
}
