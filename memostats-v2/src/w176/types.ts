// Read-only TypeScript shapes for the immutable W176 DB
// (public/data/w176/memostats-w176-ecu-db-2026-09-29.json). Every field mirrors the JSON exactly;
// nothing here is written back. The file itself is never modified — see src/w176/db.ts.

export interface W176FeatureOption {
  readonly id: number;
  readonly bit_position: number;
  readonly bit_length: number;
  readonly value: number;
  readonly value_meaning: string;
  readonly custom_options: {
    readonly comment?: string;
    readonly overwrites?: readonly { readonly value: string; readonly bit_length: string; readonly bit_position: string }[];
  };
}

export interface W176Section {
  readonly id: number;
  readonly section: string | null;
  readonly ecu_id: number;
  readonly coding_length: number;
  readonly payload_to_read: string;
  readonly payload_to_write: string;
  readonly access_level: number;
  readonly dll_name: string | null;
  readonly seed_length: number | null;
  readonly key_length: number | null;
  readonly UnlockDllConfig: unknown;
  readonly ECUFeatureOptionsConnectors?: readonly {
    readonly option_id: number;
    readonly feature_id: number;
    readonly ecu_variant_id: number;
    readonly section_id: number;
    readonly FeatureOption: W176FeatureOption;
  }[];
}

export interface W176FeatureOptionBinding {
  readonly ECUSection: W176Section;
  readonly ECUVariant: { readonly id: number; readonly ecu_id: number };
  readonly FeatureOption: W176FeatureOption;
}

export interface W176Feature {
  readonly id: number;
  readonly function_name: string;
  readonly function_name_en: string;
  readonly description: string;
  readonly description_en: string;
  readonly feature_type: string; // 'single' | 'sequence' | 'multi' | ...
  readonly min_fw_version: number | null;
  readonly estimated_wait_time_seconds: number | null;
  readonly FeaturesOptions?: readonly W176FeatureOptionBinding[];
}

export interface W176InventoryEcu {
  readonly user_vehicle_ecu_id?: number;
  readonly ecu_id: number;
  readonly name: string;
  readonly display_name: string;
  readonly description: string;
  readonly group: string;
  readonly type: string;
  readonly variant_id: number;
  readonly variant_name: string;
  readonly op_code: string;
  readonly serial_number?: string;
  readonly hardware_number?: string;
  readonly software_number?: string;
  readonly transmit_id: string; // "0x6f3"
  readonly receive_id: string; // "0x4de"
  readonly inventory_scope: string;
}

export interface W176EcuDefinition {
  readonly id: number;
  readonly name: string;
  readonly display_name: string;
  readonly description: string;
  readonly type: string;
  readonly group: string;
  readonly transmit_id: string; // "0x60a"
  readonly receive_id: string; // "0x481"
  readonly CarControlUnitVariants?: readonly { readonly id: number; readonly name: string; readonly op_code: string }[];
}

export interface W176ScanCandidate {
  readonly transmit_id: string;
  readonly receive_id: string;
  readonly possible_modules: readonly {
    readonly ecu_id: number;
    readonly name: string;
    readonly display_name: string;
    readonly description: string;
    readonly type: string;
    readonly group: string;
  }[];
  readonly possible_module_count: number;
}

export interface W176MeasureCommand {
  readonly id: number;
  readonly parse_type: string;
  readonly payload_to_get: string;
  readonly len_rec: number;
  readonly parsing_options: readonly (
    | { readonly op: 'read'; readonly start_bit: number; readonly byte_order: 'big' | 'little'; readonly length_bits: number }
    | { readonly op: 'multiply'; readonly unit: string; readonly value: number }
    | { readonly op: string; readonly [k: string]: unknown }
  )[];
  readonly variant_id: number;
  readonly ecu_id: number;
  readonly ecu_name: string;
  readonly measure_type_name: string;
  readonly measure_name: string;
  readonly reference: string;
}

export interface W176DtcDefinition {
  readonly id: number;
  readonly fault_code: string;
  readonly fault_description: string;
  readonly fault_description_en: string;
  readonly [k: string]: unknown;
}

export interface W176StaticFunction {
  readonly id: number;
  readonly payload_to_get: string;
  readonly len_rec: number;
  readonly response_timout: number; // sic: MBito spelling
  readonly request_type: number;
  readonly is_hard_reset: boolean | null;
  readonly ignore_response: boolean | null;
}

export type W176WorkflowStep =
  | {
      readonly order: number;
      readonly ecu_id: number;
      readonly ecu_name: string;
      readonly transmit_id: string;
      readonly receive_id: string;
      readonly type: 'static';
      readonly static_function: W176StaticFunction;
    }
  | {
      readonly order: number;
      readonly ecu_id: number;
      readonly ecu_name: string;
      readonly transmit_id: string;
      readonly receive_id: string;
      readonly type: 'koding';
      readonly coding_feature_id: number;
      readonly coding_value_meaning: string;
    };

export interface W176Workflow {
  readonly feature_id: number;
  readonly feature_name: string;
  readonly options: Readonly<Record<string, {
    readonly option_id: number;
    readonly value_meaning: string;
    readonly steps: readonly W176WorkflowStep[];
  }>>;
}

export interface W176Db {
  readonly schema_version: number;
  readonly generated_at: string;
  readonly vehicle: {
    readonly platform: string;
    readonly model: string;
    readonly communication_type: string;
    readonly user_vehicle_id: number;
    readonly vin_included: boolean;
  };
  readonly inventory: {
    readonly latest_ecus: readonly W176InventoryEcu[];
    readonly supplemental_ecus: readonly W176InventoryEcu[];
    readonly latest_ecu_count: number;
    readonly supplemental_ecu_count: number;
  };
  readonly coding: {
    readonly sections: readonly W176Section[];
    readonly features: readonly W176Feature[];
    readonly section_count: number;
    readonly feature_count: number;
    readonly multi_feature_workflows: Readonly<Record<string, W176Workflow>>;
    readonly med40: {
      readonly ecu_id: number;
      readonly variant_id: number;
      readonly variant_name: string;
      readonly read_write_did: string;
      readonly coding_length: number;
      readonly known_option_bit_position: number;
      readonly known_option_bit_length: number;
      readonly security_access_metadata_only: readonly {
        readonly section_id: number;
        readonly access_level: number;
        readonly seed: string;
        readonly key: string;
        readonly dll: string;
      }[];
      readonly feature_369: W176Feature & {
        readonly ActivationSequence?: unknown;
        readonly options?: unknown;
        readonly access_level: number;
      };
    };
  };
  readonly diagnostics: {
    readonly service_functions: readonly unknown[];
    readonly measure_commands: readonly W176MeasureCommand[];
    readonly dtc_definitions_by_ecu: Readonly<Record<string, readonly W176DtcDefinition[]>>;
    readonly dtc_counts_by_ecu: Readonly<Record<string, number>>;
    readonly dtc_total: number;
  };
  readonly w176_catalog: {
    readonly car_id: number;
    readonly ecu_definition_count: number;
    readonly variant_definition_count: number;
    readonly unique_diagnostic_address_pairs: number;
    readonly ecu_definitions: readonly W176EcuDefinition[];
    readonly scan_candidates: readonly W176ScanCandidate[];
  };
}

/** The immutable DB filename and its expected integrity, asserted by the build/dev check. */
export const W176_DB_FILE = 'memostats-w176-ecu-db-2026-09-29.json';
export const W176_DB_PATH = `/data/w176/${W176_DB_FILE}`;
export const W176_DB_SHA256 = 'df85e634a8074bb1a78e9cbfbaf78d4649c34a3b4a8f5db106fff63f4ffc4f85';
export const W176_DB_BYTES = 2391184;
