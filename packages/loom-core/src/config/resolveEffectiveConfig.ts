import fs from 'node:fs';
import path from 'node:path';
import yaml from 'js-yaml';
import { ZodError } from 'zod';
import { PolicySchema } from '../types.js';
import { describePolicyIssues, PolicyValidationError } from '../guardrails/policyError.js';
import { resolveLoomHomePath } from '../home/resolveLoomHomePath.js';
import { loadTeamConfigLayer } from './teamConfig.js';
import { loadEnvLayer } from './envLayer.js';
import { mergeLayers } from './mergeLayers.js';
import { MERGE_STRATEGY } from './mergeStrategy.js';
import type { ConfigLayer, EffectiveConfig, ResolveOptions } from './types.js';

/**
 * Pure fn of (team file, policy.yaml, env). Same inputs → identical output (NFR-2).
 *
 * Orchestration order (fixed):
 *   1. Read <loomdir>/policy.yaml          → repo layer (raw)
 *   2. loomHome = resolveLoomHomePath(projectRoot, repoPolicy)   // ADR-006: repo-only
 *   3. team = loadTeamConfigLayer(loomHome)                      // story-055-001
 *   4. env  = loadEnvLayer(opts.env ?? process.env)              // story-055-003
 *   5. merged = mergeLayers([team, repo, env], MERGE_STRATEGY)   // story-055-002
 *   6. policy = PolicySchema.parse(merged)  // defaults applied ONCE (ADR-007)
 *
 * Throws ConfigMergeError on cross-layer type conflict (FR-8).
 * Throws PolicyValidationError if the merged tree fails PolicySchema.
 */
export function resolveEffectiveConfig(opts: ResolveOptions): EffectiveConfig {
  // Step 1: Read repo layer (policy.yaml) — raw, pre-validation.
  const policyPath = path.join(opts.loomdir, 'policy.yaml');
  let repoTree: unknown = {};
  if (fs.existsSync(policyPath)) {
    const raw = yaml.load(fs.readFileSync(policyPath, 'utf8')) as unknown;
    if (raw !== null && raw !== undefined && (typeof raw !== 'object' || Array.isArray(raw))) {
      throw new PolicyValidationError(policyPath, [{
        fieldPath: '',
        received: Array.isArray(raw) ? 'sequence' : typeof raw,
        constraint: 'YAML mapping (object)',
        hint: 'policy.yaml root must be a YAML mapping, not a scalar or sequence',
      }]);
    }
    repoTree = raw ?? {};
  }
  const repoLayer: ConfigLayer = { name: 'repo', tree: repoTree };

  // Step 2: Derive loom-home from the repo layer ONLY (ADR-006).
  // Team-config lives under loom-home, so loom-home must be resolved before
  // team-config is loaded — it cannot itself come from team-config.
  const loomHome = resolveLoomHomePath(
    opts.projectRoot,
    repoTree as { loom_home?: string },
  );

  // Step 3: Team layer.
  const teamLayer = loadTeamConfigLayer(loomHome);

  // Step 4: Env layer.
  const envLayer = loadEnvLayer(opts.env ?? process.env);

  // Step 5: Merge layers low → high [team, repo, env].
  const { tree: merged, provenance } = mergeLayers(
    [teamLayer, repoLayer, envLayer],
    MERGE_STRATEGY,
  );

  // Step 6: Apply PolicySchema defaults ONCE (ADR-007).
  // The merge operates on raw trees; defaults are never injected per-layer.
  try {
    const policy = PolicySchema.parse(merged ?? {});
    return { policy, provenance };
  } catch (err) {
    if (err instanceof ZodError) {
      throw new PolicyValidationError(policyPath, describePolicyIssues(err));
    }
    throw err;
  }
}
