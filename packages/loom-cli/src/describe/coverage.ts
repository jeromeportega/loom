import { readFileSync, existsSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import type { Command } from 'commander';
import yaml from 'js-yaml';
import { collectSpecs, enumerateRegisteredCommands } from './registry.js';

// ---------------------------------------------------------------------------
// Shared token types — consumed by coverage-check.ts (story-015-002)
// ---------------------------------------------------------------------------

/** A normalized identifier as it appears both on the page and in a live source.
 *
 * command tokens: command path with NO "loom " prefix — "epic", "guard check"
 * knob tokens:    dotted leaf paths with NO "policy." prefix — "git.protected_branches"
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

/**
 * Find the monorepo root by walking up from `fromDir` until a directory
 * containing `schemas/policy.schema.yaml` is found.
 *
 * Defaults to __dirname (dist/describe/ at runtime) when omitted, so
 * the walk reaches the repo root in a standard worktree layout:
 *   dist/describe/ → dist/ → packages/loom-cli/ → packages/ → repo root
 */
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

/**
 * Subset rule for commands:
 *   A CommandDescription with audience === 'internal' is excluded.
 *   A CommandDescription with absent/undefined audience defaults to 'operator' and is included.
 *   Each included spec contributes spec.name + (spec.aliases ?? []) as tokens.
 *
 * When a Commander program is supplied, the command names are sourced from
 * enumerateRegisteredCommands(program) — proving derivation from the live
 * registry rather than a hardcoded list.  Each name is then looked up in
 * collectSpecs() to obtain its audience and alias annotations; a name with
 * no matching spec defaults to audience 'operator' (included).
 *
 * When no program is supplied, spec names come from collectSpecs() directly.
 */
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

/**
 * Subset rule for knobs:
 *   Only leaf scalar paths under the top-level git | filesystem | agents blocks
 *   are included.  "Leaf" means the field is not a JSON-Schema object with
 *   nested properties — scalars, arrays, and enums all qualify.
 *   Any field carrying `x-internal: true` is excluded regardless of depth.
 *   Container (non-leaf) nodes are not emitted as tokens.
 *   Fields outside git | filesystem | agents are not included.
 *
 * The dotted path uses NO "policy." prefix: "agents.max_concurrent",
 * "git.protected_branches", etc.
 */
export function operatorKnobs(schemaPath?: string): Set<Token> {
  const resolvedPath = schemaPath ?? join(repoRoot(), 'schemas', 'policy.schema.yaml');
  const raw = readFileSync(resolvedPath, 'utf8');
  const schema = yaml.load(raw) as Record<string, unknown>;

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

/**
 * Recurse into `props` and emit dotted paths for every leaf scalar field.
 * Fields tagged `x-internal: true` at any depth are silently skipped.
 * Container nodes (type=object with nested properties) are recursed into but
 * not emitted themselves.
 */
function collectLeafPaths(
  prefix: string,
  props: Record<string, unknown>,
  tokens: Set<Token>
): void {
  for (const [key, fieldSchema] of Object.entries(props)) {
    const field = fieldSchema as Record<string, unknown>;
    const dotPath = `${prefix}.${key}`;

    if (field['x-internal'] === true) continue;

    const isContainerObject =
      field.type === 'object' && field.properties != null;

    if (isContainerObject) {
      collectLeafPaths(dotPath, field.properties as Record<string, unknown>, tokens);
    } else {
      tokens.add(dotPath);
    }
  }
}
