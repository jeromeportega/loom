import fs from 'node:fs';
import path from 'node:path';
import yaml from 'js-yaml';
import { z } from 'zod';
import { PolicySchema } from '../types.js';
import { describePolicyIssues, PolicyValidationError } from '../guardrails/policyError.js';

export const TEAM_CONFIG_FILENAME = 'team-config.yaml';

// ADR-001: derive, do not fork. TeamConfigSchema is a strict deep-partial of
// PolicySchema so it can never drift from the canonical policy shape.
export const TeamConfigSchema = PolicySchema.deepPartial();
export type TeamConfig = z.infer<typeof TeamConfigSchema>;

// Matches the ConfigLayer interface in config/types.ts (owned by story-055-002).
// Defined locally so this module compiles standalone; structural compatibility
// is guaranteed because the shape is identical.
interface ConfigLayer {
  name: 'team' | 'repo' | 'env';
  tree: unknown;
}

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
  const raw = yaml.load(content) as unknown;

  // js-yaml returns null for empty or comment-only files.
  if (raw === null || raw === undefined) {
    return { name: 'team', tree: {} };
  }

  const result = TeamConfigSchema.safeParse(raw);
  if (!result.success) {
    throw new PolicyValidationError(filePath, describePolicyIssues(result.error));
  }

  // Return raw (not result.data) so defaults are not injected into the layer
  // tree — ADR-007: absence ≠ empty.
  return { name: 'team', tree: raw };
}
