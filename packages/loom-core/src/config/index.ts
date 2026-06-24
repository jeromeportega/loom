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

// Re-exports from story-055-001
export {
  loadTeamConfigLayer,
  TeamConfigSchema,
  TEAM_CONFIG_FILENAME,
} from './teamConfig.js';
export type { TeamConfig } from './teamConfig.js';

// Re-exports from story-055-003
export { loadEnvLayer } from './envLayer.js';
