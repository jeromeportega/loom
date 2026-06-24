import { z } from 'zod';
import { PolicySchema } from '../types.js';

// ConfigLayer interface — mirrors types.ts (story-055-002). Defined locally so
// this module compiles standalone; the shape is identical to the shared type.
interface ConfigLayer {
  name: 'team' | 'repo' | 'env';
  tree: unknown;
}

const ENV_PREFIX = 'LOOM_';

// ── Zod unwrapping ────────────────────────────────────────────────────────────

function unwrapZod(schema: z.ZodTypeAny): z.ZodTypeAny {
  if (schema instanceof z.ZodDefault) return unwrapZod(schema._def.innerType);
  if (schema instanceof z.ZodOptional) return unwrapZod(schema._def.innerType);
  if (schema instanceof z.ZodNullable) return unwrapZod(schema._def.innerType);
  return schema;
}

// ── Schema path map ───────────────────────────────────────────────────────────

// Maps "section.field" (or top-level "field") → the unwrapped ZodTypeAny.
// Built once on first use.
let _pathCache: Map<string, z.ZodTypeAny> | null = null;

/** Exposed for tests that inject a modified PolicySchema. Never call in production. */
export function _resetPathCacheForTesting(): void {
  _pathCache = null;
}

function schemaPathMap(): Map<string, z.ZodTypeAny> {
  if (_pathCache) return _pathCache;
  const result = new Map<string, z.ZodTypeAny>();

  for (const [sectionKey, sectionSchema] of Object.entries(PolicySchema.shape) as [string, z.ZodTypeAny][]) {
    const inner = unwrapZod(sectionSchema);
    if (inner instanceof z.ZodObject) {
      for (const [fieldKey, fieldSchema] of Object.entries(inner.shape) as [string, z.ZodTypeAny][]) {
        result.set(`${sectionKey}.${fieldKey}`, fieldSchema as z.ZodTypeAny);
      }
    } else {
      // Top-level scalar (e.g. loom_home)
      result.set(sectionKey, sectionSchema as z.ZodTypeAny);
    }
  }

  _pathCache = result;
  return result;
}

// ── Path resolution (ADR-008: longest-valid-schema-path) ─────────────────────

/**
 * Given a lowercased env-key suffix (LOOM_ stripped), resolve to the longest
 * valid PolicySchema path. Tries every underscore split point and picks the
 * candidate with the longest field segment (most underscores kept in the field
 * name), so `filesystem_allowed_write_root` → `filesystem.allowed_write_root`
 * rather than any greedy misparse.
 */
function resolveSchemaPath(
  suffix: string,
): { path: string; schema: z.ZodTypeAny } | null {
  const paths = schemaPathMap();
  const tokens = suffix.split('_');
  const n = tokens.length;

  let best: { path: string; schema: z.ZodTypeAny; fieldLen: number } | null = null;

  // Try every section/field split at each underscore boundary.
  for (let i = 1; i < n; i++) {
    const section = tokens.slice(0, i).join('_');
    const field = tokens.slice(i).join('_');
    const dotPath = `${section}.${field}`;
    const schema = paths.get(dotPath);
    if (schema !== undefined) {
      // Prefer splits with longer field names (rightmost valid split wins).
      if (!best || field.length > best.fieldLen) {
        best = { path: dotPath, schema, fieldLen: field.length };
      }
    }
  }

  // Also try the full suffix as a top-level key (e.g. LOOM_LOOM_HOME → loom_home).
  // section.field candidates always win over top-level when both match (ADR-008):
  // a nested path is more specific than a coincidental top-level name.
  if (!best) {
    const topSchema = paths.get(suffix);
    if (topSchema !== undefined) {
      best = { path: suffix, schema: topSchema, fieldLen: suffix.length };
    }
  }

  return best ? { path: best.path, schema: best.schema } : null;
}

// ── Value coercion ────────────────────────────────────────────────────────────

/**
 * Coerce a raw env string to the target zod type. Throws on type mismatch so
 * the caller can emit a warning and skip the key.
 */
function coerceValue(raw: string, schema: z.ZodTypeAny): unknown {
  const inner = unwrapZod(schema);

  if (inner instanceof z.ZodBoolean) {
    if (raw === 'true') return true;
    if (raw === 'false') return false;
    throw new Error(`expected "true" or "false", got "${raw}"`);
  }

  if (inner instanceof z.ZodNumber) {
    const n = Number(raw);
    if (!Number.isFinite(n)) throw new Error(`cannot convert "${raw}" to a number`);
    return n;
  }

  if (inner instanceof z.ZodArray) {
    // Try JSON array first; fall back to comma-split.
    const trimmed = raw.trim();
    if (trimmed.startsWith('[')) {
      try {
        const parsed = JSON.parse(trimmed);
        if (Array.isArray(parsed)) return parsed;
      } catch {
        // fall through to comma-split
      }
    }
    return raw.split(',').map(s => s.trim()).filter(s => s.length > 0);
  }

  // String, enum, and any other type: return as-is and let PolicySchema.parse
  // validate the value when layers are merged.
  return raw;
}

// ── Sparse tree helpers ───────────────────────────────────────────────────────

const PROTOTYPE_POISON = new Set(['__proto__', 'constructor', 'prototype']);

function setAtPath(
  obj: Record<string, unknown>,
  dotPath: string,
  value: unknown,
): void {
  const parts = dotPath.split('.');
  let cur = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    const k = parts[i];
    if (PROTOTYPE_POISON.has(k)) return;
    if (typeof cur[k] !== 'object' || cur[k] === null) cur[k] = {};
    cur = cur[k] as Record<string, unknown>;
  }
  const last = parts[parts.length - 1];
  if (PROTOTYPE_POISON.has(last)) return;
  cur[last] = value;
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Maps LOOM_<SECTION>_<KEY> env variables into a sparse policy tree (ADR-008),
 * coercing each value to its target zod field type (number, boolean, or list).
 * Ambiguous underscores resolve via longest-valid-schema-path match.
 * Unmappable keys are silently ignored after emitting a console.warn.
 *
 * SECRETS ARE NEVER MAPPED HERE (FR-5 / ADR-005 / T2).
 * ANTHROPIC_* variables carry the Anthropic API credentials and must not enter
 * the config object. They continue to flow exclusively through
 * BaseCliWorker.workerEnv(), which reads process.env directly.
 */
export function loadEnvLayer(env: NodeJS.ProcessEnv): ConfigLayer {
  const tree: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) continue;

    // FR-5 / ADR-005: ANTHROPIC_* are secrets, not config.  They are read only
    // by BaseCliWorker.workerEnv() from process.env — never here.
    if (key.startsWith('ANTHROPIC_')) continue;

    if (!key.startsWith(ENV_PREFIX)) continue;

    const suffix = key.slice(ENV_PREFIX.length).toLowerCase();
    if (!suffix) continue;

    const resolved = resolveSchemaPath(suffix);
    if (!resolved) {
      console.warn(`[loom] loadEnvLayer: "${key}" does not map to any known config key — ignoring`);
      continue;
    }

    let coerced: unknown;
    try {
      coerced = coerceValue(value, resolved.schema);
    } catch (err) {
      // Omit the raw value from the warning to avoid leaking misrouted secrets.
      console.warn(
        `[loom] loadEnvLayer: cannot coerce "${key}" (type mismatch: ${(err as Error).message}) — ignoring`,
      );
      continue;
    }

    setAtPath(tree, resolved.path, coerced);
  }

  return { name: 'env', tree };
}
