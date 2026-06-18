import { readFileSync, existsSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import type { Command } from 'commander';
import yaml from 'js-yaml';
import { collectSpecs, enumerateRegisteredCommands } from './registry.js';

// ---------------------------------------------------------------------------
// Shared token types — consumed by coverage-check.ts (story-015-002)
// ---------------------------------------------------------------------------

/** A normalized identifier as it appears both on the page and in a live source.
 * command tokens: NO "loom " prefix — "epic", "guard check"
 * knob tokens: dotted leaf paths, NO "policy." prefix — "git.protected_branches"
 */
export type Token = string;

export interface SurfaceDiff {
  surface: 'command' | 'knob';
  /** in the live source, absent from the page  → page is stale */
  missing: Token[];
  /** on the page, not in the live source        → page is fictional */
  phantom: Token[];
}

export interface CoverageReport {
  /** true iff every diff has empty missing AND phantom */
  ok: boolean;
  /** exactly two entries: surface 'command' then 'knob' */
  diffs: SurfaceDiff[];
  /** human-readable failure lines for doctor/test output */
  messages: string[];
}

// ---------------------------------------------------------------------------
// repoRoot — walk up from a starting directory to find the repo root
// ---------------------------------------------------------------------------

/** Walk up from `fromDir` until a directory containing schemas/policy.schema.yaml is found. */
export function repoRoot(fromDir?: string): string {
  let dir = resolve(fromDir ?? __dirname);
  while (dir !== dirname(dir)) {
    if (existsSync(join(dir, 'schemas', 'policy.schema.yaml'))) {
      return dir;
    }
    dir = dirname(dir);
  }
  throw new Error(
    `repoRoot: could not find schemas/policy.schema.yaml walking up from ${fromDir ?? __dirname}`
  );
}

// ---------------------------------------------------------------------------
// operatorCommands — operator-visible command tokens from the live registry
// ---------------------------------------------------------------------------

// Subset rule: audience === 'internal' → excluded; absent audience defaults to 'operator' (included).
// Each included spec contributes spec.name + (spec.aliases ?? []) as tokens.
// With program: command names from enumerateRegisteredCommands (proves live derivation, not hardcoded list).
// Without program: command names from collectSpecs() only (spec-list, no Commander walk — diverges if a
//   command is registered in Commander but absent from specs; prefer passing a program when possible).

/** Operator command tokens from the live registry: collectSpecs() filtered to audience 'operator', names + aliases. */
export function operatorCommands(program?: Command): Set<Token> {
  const specs = collectSpecs();
  const specsByName = new Map(specs.map((s) => [s.name, s]));

  const commandNames: string[] = program
    ? enumerateRegisteredCommands(program)
    : specs.map((s) => s.name);

  const tokens = new Set<Token>();
  for (const name of commandNames) {
    const spec = specsByName.get(name);
    // Absent audience === 'operator' (default-visible)
    const audience = spec?.audience ?? 'operator';
    if (audience === 'operator') {
      tokens.add(name);
      for (const alias of spec?.aliases ?? []) {
        tokens.add(alias);
      }
    }
  }
  return tokens;
}

// ---------------------------------------------------------------------------
// operatorKnobs — operator-visible knob tokens from schemas/policy.schema.yaml
// ---------------------------------------------------------------------------

// Subset rule: only leaf scalar paths under the top-level git | filesystem | agents blocks.
// "Leaf" = not a JSON-Schema object with nested properties (scalars, arrays, enums all qualify).
// Fields with x-internal: true are excluded at any depth; container nodes are not emitted as tokens.
// Fields outside git | filesystem | agents are not included.
// Dotted path uses NO "policy." prefix: "agents.max_concurrent", "git.protected_branches".

/** Operator knob tokens from schemas/policy.schema.yaml: leaf scalars under git|filesystem|agents, x-internal excluded. */
export function operatorKnobs(schemaPath?: string): Set<Token> {
  const resolvedPath = schemaPath ?? join(repoRoot(), 'schemas', 'policy.schema.yaml');
  const raw = readFileSync(resolvedPath, 'utf8');
  const loaded = yaml.load(raw);
  if (!loaded || typeof loaded !== 'object') {
    throw new Error(`operatorKnobs: ${resolvedPath} did not parse to an object`);
  }
  const schema = loaded as Record<string, unknown>;

  const tokens = new Set<Token>();
  const ROOT_BLOCKS = ['git', 'filesystem', 'agents'] as const;

  const rootProps = (schema.properties ?? {}) as Record<string, unknown>;

  for (const block of ROOT_BLOCKS) {
    const blockSchema = rootProps[block] as Record<string, unknown> | undefined;
    if (!blockSchema) continue;
    const blockProps = (blockSchema.properties ?? {}) as Record<string, unknown>;
    collectLeafPaths(block, blockProps, tokens);
  }

  return tokens;
}

/** Recurse into props emitting dotted paths for every leaf scalar; x-internal fields skipped. */
function collectLeafPaths(
  prefix: string,
  props: Record<string, unknown>,
  tokens: Set<Token>
): void {
  for (const [key, fieldSchema] of Object.entries(props)) {
    const field = fieldSchema as Record<string, unknown>;
    const dotPath = `${prefix}.${key}`;

    if (field['x-internal'] === true) continue;

    // Gather sub-schema properties from allOf / anyOf / oneOf composition keywords.
    const composedProps: Record<string, unknown> = {};
    for (const keyword of ['allOf', 'anyOf', 'oneOf'] as const) {
      const arr = field[keyword] as Record<string, unknown>[] | undefined;
      if (Array.isArray(arr)) {
        for (const sub of arr) {
          if (sub.properties && typeof sub.properties === 'object') {
            Object.assign(composedProps, sub.properties as Record<string, unknown>);
          }
        }
      }
    }
    // TODO: $ref resolution is not implemented; a field using $ref is treated as a leaf scalar.

    const isContainerObject =
      (field.type === 'object' && field.properties != null) ||
      Object.keys(composedProps).length > 0;

    if (isContainerObject) {
      const mergedProps: Record<string, unknown> = {
        ...(field.properties as Record<string, unknown> ?? {}),
        ...composedProps,
      };
      collectLeafPaths(dotPath, mergedProps, tokens);
    } else {
      tokens.add(dotPath);
    }
  }
}
