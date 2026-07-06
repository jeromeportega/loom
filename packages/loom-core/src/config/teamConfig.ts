import fs from 'node:fs';
import path from 'node:path';
import yaml from 'js-yaml';
import { z } from 'zod';
import { PolicySchema } from '../types.js';
import { describePolicyIssues, PolicyValidationError } from '../guardrails/policyError.js';
import type { ConfigLayer } from './types.js';

export const TEAM_CONFIG_FILENAME = 'team-config.yaml';

// ADR-001: derive, do not fork. TeamConfigSchema is a strict deep-partial of
// PolicySchema so it can never drift from the canonical policy shape.
export const TeamConfigSchema = PolicySchema.deepPartial();
export type TeamConfig = z.infer<typeof TeamConfigSchema>;

/**
 * Reads <loomHomeDir>/team-config.yaml and validates against TeamConfigSchema.
 * Returns { name: 'team', tree: {} } when the file is absent or empty (ADR-007:
 * absence ≠ empty — an empty tree contributes nothing to the effective config).
 * The returned tree is the raw pre-validation YAML tree; defaults are NOT
 * applied here — PolicySchema.parse() applies them exactly once at resolve time.
 */
export function loadTeamConfigLayer(loomHomeDir: string): ConfigLayer {
  const filePath = path.join(loomHomeDir, TEAM_CONFIG_FILENAME);

  if (!fs.existsSync(filePath)) {
    return { name: 'team', tree: {} };
  }

  const content = fs.readFileSync(filePath, 'utf8');
  // yaml.JSON_SCHEMA restricts the parser to JSON-compatible types, preventing
  // non-scalar YAML tags (!!timestamp, !!binary, !!merge) from injecting typed
  // values into the pre-validation merge tree.
  const raw = yaml.load(content, { schema: yaml.JSON_SCHEMA }) as unknown;

  // js-yaml returns null for empty or comment-only files.
  if (raw === null || raw === undefined) {
    return { name: 'team', tree: {} };
  }

  const result = TeamConfigSchema.safeParse(raw);
  if (!result.success) {
    // Pass the raw tree so numeric out-of-range errors echo the operator's actual
    // value (the rawInput-by-path fallback) instead of "Received: undefined" — the
    // team-config layer must match the policy.yaml layer's error quality.
    throw new PolicyValidationError(filePath, describePolicyIssues(result.error, raw));
  }

  // Return raw (not result.data) so defaults are not injected into the layer
  // tree — ADR-007: absence ≠ empty.
  return { name: 'team', tree: raw };
}
