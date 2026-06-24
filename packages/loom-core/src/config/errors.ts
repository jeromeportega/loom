import type { LayerName } from './types.js';

/** Thrown when the same key path carries different structural types across layers (FR-8).
 *  Always deterministic: identical conflict inputs produce identical error messages. */
export class ConfigMergeError extends Error {
  constructor(
    readonly keyPath: string,
    readonly conflict: { layer: LayerName; kind: 'scalar' | 'map' | 'list' }[],
  ) {
    super(
      `Config merge conflict at "${keyPath}": ` +
        conflict.map(c => `${c.layer}=${c.kind}`).join(', '),
    );
    this.name = 'ConfigMergeError';
  }
}
