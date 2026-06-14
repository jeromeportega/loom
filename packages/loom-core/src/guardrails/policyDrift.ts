import fs from 'node:fs';
import path from 'node:path';
import yaml from 'js-yaml';
import { PolicySchema } from '../types.js';

export interface MissingPolicyKey {
  /** Dotted path, e.g. "agents.review_max_passes". */
  path: string;
  /** The schema default that applies until the user sets the knob. */
  default: unknown;
}

/**
 * Knobs that ship a schema default but are absent from a project's policy.yaml —
 * i.e. added to loom since the file was generated. `loom init` and `loom doctor`
 * surface these so a user on an older policy.yaml learns about new knobs without
 * us rewriting their commented file (js-yaml does not preserve comments on a
 * round-trip, so an in-place merge would mangle it).
 *
 * Schema-driven, so it stays correct as knobs are added. Optional knobs (no
 * default — e.g. test_command, budget_tokens_per_story) never appear here:
 * `PolicySchema.parse({})` omits them, so they are not reported as "missing".
 */
export function missingPolicyKeys(loomDir: string): MissingPolicyKey[] {
  const policyPath = path.join(loomDir, 'policy.yaml');
  if (!fs.existsSync(policyPath)) return [];

  let raw: unknown;
  try {
    raw = yaml.load(fs.readFileSync(policyPath, 'utf8')) ?? {};
  } catch {
    // Malformed YAML is surfaced where it matters (PolicyEngine.load throws on
    // real use); the drift report just stays silent.
    return [];
  }
  if (typeof raw !== 'object' || raw === null) return [];
  const rawObj = raw as Record<string, unknown>;

  const defaults = PolicySchema.parse({}) as Record<string, unknown>;
  const missing: MissingPolicyKey[] = [];

  for (const [section, sectionDefault] of Object.entries(defaults)) {
    const isMap =
      sectionDefault !== null && typeof sectionDefault === 'object' && !Array.isArray(sectionDefault);
    if (!isMap) {
      if (!(section in rawObj)) missing.push({ path: section, default: sectionDefault });
      continue;
    }
    const userSection = rawObj[section];
    const userMap =
      userSection !== null && typeof userSection === 'object' && !Array.isArray(userSection)
        ? (userSection as Record<string, unknown>)
        : {};
    for (const [key, def] of Object.entries(sectionDefault as Record<string, unknown>)) {
      if (!(key in userMap)) missing.push({ path: `${section}.${key}`, default: def });
    }
  }
  return missing;
}
