export type PluginFormat = 'vst' | 'vst3' | 'au' | 'clap' | 'aax';
export type PluginKind = 'instrument' | 'effect' | 'unknown';

export interface PluginSibling {
  path: string;
  format: PluginFormat;
}

export interface PluginEntry {
  name: string;
  path: string;
  format: PluginFormat;
  kind: PluginKind;
  scope: 'system' | 'user' | 'custom';
  vendor: string | null;
  bundleId: string | null;
  sizeBytes: number;
  siblings: PluginSibling[];
}

export type LeftoverCategory =
  | 'binary'
  | 'sibling'
  | 'presets'
  | 'appSupport'
  | 'prefs'
  | 'caches'
  | 'documents'
  | 'icloud'
  | 'registry';

export type LeftoverConfidence = 'exact' | 'high' | 'vendor';

export interface LeftoverItem {
  path: string;
  sizeBytes: number;
  category: LeftoverCategory;
  confidence: LeftoverConfidence;
  /** Other installed plugins from the same vendor also use this location. */
  shared: boolean;
  isRegistryKey: boolean;
}

export interface LeftoverReport {
  pluginName: string;
  vendor: string | null;
  bundleId: string | null;
  items: LeftoverItem[];
  totalSizeBytes: number;
  needsElevation: boolean;
}

export interface DeleteFailure {
  path: string;
  error: string;
}

export interface DeleteReport {
  deleted: string[];
  failed: DeleteFailure[];
  bytesFreed: number;
  elevationUsed: boolean;
  elevationCancelled: boolean;
}
