import type { ConfigLayer, LayerName, MergeStrategy, ProvenanceMap } from './types.js';
import { ConfigMergeError } from './errors.js';

type Kind = 'scalar' | 'map' | 'list';

function getKind(v: unknown): Kind | 'absent' {
  if (v === null || v === undefined) return 'absent';
  if (Array.isArray(v)) return 'list';
  if (typeof v === 'object') return 'map';
  return 'scalar';
}

interface LayerValue {
  name: LayerName;
  value: unknown;
}

function mergeAtPath(
  dotPath: string,
  layers: LayerValue[],
  registry: Record<string, MergeStrategy>,
  provenance: ProvenanceMap,
): unknown {
  // Only consider layers that carry a present (non-null, non-undefined) value.
  const present = layers.filter(l => getKind(l.value) !== 'absent');
  if (present.length === 0) return undefined;

  // Classify each present value's structural type.
  const kinds = present.map(l => ({
    layer: l.name,
    kind: getKind(l.value) as Kind,
  }));

  // Cross-layer type conflict → deterministic error (FR-8).
  const distinctKinds = new Set(kinds.map(k => k.kind));
  if (distinctKinds.size > 1) {
    throw new ConfigMergeError(dotPath, kinds);
  }

  const kind = kinds[0].kind;

  // Determine merge strategy: explicit registry entry, or structural default.
  let strategy: MergeStrategy;
  if (Object.prototype.hasOwnProperty.call(registry, dotPath)) {
    strategy = registry[dotPath];
  } else {
    switch (kind) {
      case 'map':    strategy = 'deep';    break;
      case 'list':   strategy = 'replace'; break;
      case 'scalar': strategy = 'scalar';  break;
    }
  }

  switch (strategy) {
    case 'scalar':
    case 'replace': {
      // Higher layer (last in low→high order) wins.
      const winner = present[present.length - 1];
      provenance[dotPath] = winner.name;
      return winner.value;
    }

    case 'deep': {
      // Key-wise recursive merge across all present map values.
      const allKeys = new Set<string>();
      for (const l of present) {
        for (const k of Object.keys(l.value as Record<string, unknown>)) {
          allKeys.add(k);
        }
      }
      const result: Record<string, unknown> = {};
      for (const k of allKeys) {
        const childPath = dotPath ? `${dotPath}.${k}` : k;
        const childLayers: LayerValue[] = layers.map(l => ({
          name: l.name,
          value:
            l.value !== null && l.value !== undefined
              ? (l.value as Record<string, unknown>)[k]
              : undefined,
        }));
        const merged = mergeAtPath(childPath, childLayers, registry, provenance);
        if (merged !== undefined) {
          result[k] = merged;
        }
      }
      if (dotPath) provenance[dotPath] = present[present.length - 1].name;
      return Object.keys(result).length > 0 ? result : undefined;
    }

    case 'union': {
      // Denylist: union of all present layer values (ADR-004).
      // No layer can remove an entry contributed by another layer.
      const all = present.flatMap(l => l.value as unknown[]);
      provenance[dotPath] = present[present.length - 1].name;
      return [...new Set(all)];
    }

    case 'intersect': {
      // Allowlist: intersection of all present layer values (ADR-004).
      // No layer can add an entry that another layer does not also permit.
      // Absent layers are ignored — they do not collapse the result to [].
      const sets = present.map(l => l.value as unknown[]);
      const intersected = sets.slice(1).reduce(
        (acc, arr) => acc.filter(v => arr.includes(v)),
        [...sets[0]],
      );
      provenance[dotPath] = present[present.length - 1].name;
      return intersected;
    }

    case 'and': {
      // Guard boolean: `true` wins regardless of which layer sets it (ADR-004).
      const hasTrue = present.some(l => l.value === true);
      provenance[dotPath] = present[present.length - 1].name;
      return hasTrue ? true : present[present.length - 1].value;
    }
  }
}

/**
 * Merge raw layers ordered low→high. Operates on `unknown` trees (no zod mid-merge).
 * Detects scalar-vs-map / scalar-vs-list conflicts and throws ConfigMergeError.
 * Does NOT call PolicySchema.parse() — callers apply defaults exactly once (ADR-007).
 */
export function mergeLayers(
  layers: ConfigLayer[],
  registry: Record<string, MergeStrategy>,
): { tree: unknown; provenance: ProvenanceMap } {
  const provenance: ProvenanceMap = {};
  const layerValues: LayerValue[] = layers.map(l => ({ name: l.name, value: l.tree }));
  const tree = mergeAtPath('', layerValues, registry, provenance);
  return { tree: tree ?? {}, provenance };
}
