// Types
export type {
  LayerName,
  ConfigLayer,
  MergeStrategy,
  ProvenanceMap,
  EffectiveConfig,
  ResolveOptions,
} from './types.js';

// Error
export { ConfigMergeError } from './errors.js';

// Merge strategy registry
export { MERGE_STRATEGY } from './mergeStrategy.js';

// Core merge engine
export { mergeLayers } from './mergeLayers.js';

// Resolver
export { resolveEffectiveConfig } from './resolveEffectiveConfig.js';

export {
  loadTeamConfigLayer,
  TeamConfigSchema,
  TEAM_CONFIG_FILENAME,
} from './teamConfig.js';
export type { TeamConfig } from './teamConfig.js';

export { loadEnvLayer } from './envLayer.js';
