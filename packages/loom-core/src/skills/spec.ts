/**
 * agentskills.io specification limits for SKILL.md files. This is the
 * open standard consumed by hermes-agent (Nous Research), Anthropic
 * Claude Skills, OpenAI Codex Skills, and other agent runtimes — loom
 * keeps generated and proposed skills inside these bounds so they remain
 * portable across consumers.
 *
 * Spec reference: https://agentskills.io/specification
 *
 * These constants are the single source of truth. SkillGenerator validates
 * candidates against them; the conformance test in __tests__ asserts that
 * loom's own generated/proposed output never violates them.
 */
export const AGENTSKILLS_SPEC = {
  /** Max length of `name` in frontmatter (lowercase + single hyphens). */
  NAME_MAX_CHARS: 64,
  /** Allowed shape: lowercase letters / digits, single hyphens only. */
  NAME_REGEX: /^[a-z0-9]+(-[a-z0-9]+)*$/,
  /** Max length of `description` in frontmatter. */
  DESCRIPTION_MAX_CHARS: 1024,
  /**
   * Soft upper bound on the body. The spec recommends ≤ 5000 tokens; we
   * approximate as 20000 characters to avoid pulling a tokenizer into the
   * runtime. A body over this size is highly likely to violate the spec.
   */
  BODY_MAX_CHARS: 20000,
} as const;

/**
 * loom-internal metadata keys that exist only inside the local
 * `~/.loom/skills/generated/` lifecycle and have no meaning to external
 * agentskills.io consumers. SkillProposer strips these before publishing
 * a candidate; the conformance test asserts the strip list is exhaustive.
 *
 * Keeping the list here (next to the spec) instead of inside the
 * proposer's private helper makes it the canonical contract:
 * "no key in this set ever leaves loom's local skill store."
 */
export const LOOM_INTERNAL_METADATA_KEYS = [
  'lifecycle',
  'generated_from_story_id',
  'generated_from_epic_id',
] as const;

/**
 * Strip loom-internal metadata from a parsed frontmatter object in place
 * (and return it). Drops every key in {@link LOOM_INTERNAL_METADATA_KEYS}
 * plus `source: 'generated'` (the only `source` value that is loom-local;
 * other values mean something to consumers).
 *
 * Pure data manipulation — no file I/O. Callers handle persistence.
 */
export function stripLoomInternalMetadata(
  metadata: Record<string, unknown>,
): Record<string, unknown> {
  for (const key of LOOM_INTERNAL_METADATA_KEYS) {
    delete metadata[key];
  }
  if (metadata.source === 'generated') delete metadata.source;
  return metadata;
}

export interface ConformanceInput {
  name: unknown;
  description: unknown;
  /** Body content AFTER frontmatter — i.e. matter().content. */
  body: string;
}

export interface ConformanceResult {
  ok: boolean;
  /** Human-readable list of every spec violation. Empty when ok. */
  violations: string[];
}

/**
 * Check a SKILL.md against the agentskills.io spec contract. Pure — no
 * I/O — so callers can use it before writing to disk or in tests.
 */
export function checkSkillConformance(input: ConformanceInput): ConformanceResult {
  const violations: string[] = [];

  if (typeof input.name !== 'string' || input.name.length === 0) {
    violations.push('name must be a non-empty string');
  } else {
    if (input.name.length > AGENTSKILLS_SPEC.NAME_MAX_CHARS) {
      violations.push(
        `name exceeds ${AGENTSKILLS_SPEC.NAME_MAX_CHARS} chars (got ${input.name.length})`,
      );
    }
    if (!AGENTSKILLS_SPEC.NAME_REGEX.test(input.name)) {
      violations.push(
        'name must be lowercase letters/digits with single hyphens (no spaces, underscores, uppercase)',
      );
    }
  }

  if (typeof input.description !== 'string' || input.description.length === 0) {
    violations.push('description must be a non-empty string');
  } else if (input.description.length > AGENTSKILLS_SPEC.DESCRIPTION_MAX_CHARS) {
    violations.push(
      `description exceeds ${AGENTSKILLS_SPEC.DESCRIPTION_MAX_CHARS} chars (got ${input.description.length})`,
    );
  }

  if (input.body.length > AGENTSKILLS_SPEC.BODY_MAX_CHARS) {
    violations.push(
      `body exceeds ${AGENTSKILLS_SPEC.BODY_MAX_CHARS} chars (got ${input.body.length})`,
    );
  }

  return { ok: violations.length === 0, violations };
}
