import fs from 'node:fs';
import path from 'node:path';
import yaml from 'js-yaml';

export interface MissingPolicyKey {
  /** Dotted path, e.g. "agents.review_max_passes". */
  path: string;
  /** The template's value for the knob — what applies until the user sets it. */
  default: unknown;
}

function asRecord(v: unknown): Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

/**
 * Knobs present in the policy TEMPLATE (`templateYaml`, what `loom init` writes)
 * but absent from a project's policy.yaml — i.e. added to loom since the file was
 * generated. `loom init` and `loom doctor` surface these so a user on an older
 * policy.yaml learns about new knobs without us rewriting their commented file
 * (js-yaml does not preserve comments on a round-trip).
 *
 * Template-driven on purpose: a fresh `loom init` (whose policy.yaml IS the
 * template) reports nothing, and only genuinely template-new knobs appear later.
 * Commented-out optional knobs in the template (e.g. `# budget_tokens_per_story`)
 * are not parsed as keys, so they are never reported.
 */
export function missingPolicyKeys(loomDir: string, templateYaml: string): MissingPolicyKey[] {
  const policyPath = path.join(loomDir, 'policy.yaml');
  if (!fs.existsSync(policyPath)) return [];

  let userRoot: Record<string, unknown>;
  let templateRoot: Record<string, unknown>;
  try {
    userRoot = asRecord(yaml.load(fs.readFileSync(policyPath, 'utf8')));
    templateRoot = asRecord(yaml.load(templateYaml));
  } catch {
    // Malformed YAML is surfaced where it matters (PolicyEngine.load throws on
    // real use); the drift report just stays silent.
    return [];
  }

  const missing: MissingPolicyKey[] = [];
  for (const [section, templateSection] of Object.entries(templateRoot)) {
    const tplMap = asRecord(templateSection);
    if (Object.keys(tplMap).length === 0) {
      // A scalar/array top-level value (none in today's template) — compare at
      // the section level rather than walking into it.
      if (!(section in userRoot)) missing.push({ path: section, default: templateSection });
      continue;
    }
    const userMap = asRecord(userRoot[section]);
    for (const [key, def] of Object.entries(tplMap)) {
      if (!(key in userMap)) missing.push({ path: `${section}.${key}`, default: def });
    }
  }
  return missing;
}
