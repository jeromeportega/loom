/**
 * Tests for the story schema extension — provides, requires, estimated_effort
 * (epic-095 story-095-001).
 *
 * Covers: StorySchema parse (happy + error), round-trip serialisation, YAML
 * schema file content, and persona file smoke checks.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { StorySchema, EpicYamlSchema } from '../types.js';

// dist/__tests__ → dist → loom-core → packages → repo root (worktree)
const REPO_ROOT = path.resolve(__dirname, '..', '..', '..', '..');
const PERSONAS_DIR = path.join(__dirname, '..', '..', 'personas');
const SCHEMA_FILE = path.join(REPO_ROOT, 'schemas', 'epic.schema.yaml');

const MINIMAL_STORY = {
  id: 'story-001-001',
  title: 'Minimal story title',
  description: 'Does something useful.',
  acceptance_criteria: ['It works'],
  estimated_complexity: 'small' as const,
  dependencies: [],
};

describe('StorySchema extension — provides / requires / estimated_effort', () => {
  // ── Happy-path: all three new fields present ────────────────────────────────

  it('[AC-all-fields] z.parse with all three new fields set returns correct types', () => {
    const result = StorySchema.parse({
      ...MINIMAL_STORY,
      provides: { jwt_shape: '{ token: string, expires_at: string }', count: 42 },
      requires: { db_schema: 'story-001-000', user_record: 'story-001-000' },
      estimated_effort: 60,
    });

    assert.deepEqual(result.provides, {
      jwt_shape: '{ token: string, expires_at: string }',
      count: 42,
    });
    assert.deepEqual(result.requires, {
      db_schema: 'story-001-000',
      user_record: 'story-001-000',
    });
    assert.equal(result.estimated_effort, 60);
  });

  // ── Backward-compat: none of the three new fields ──────────────────────────

  it('[AC-no-new-fields] z.parse a story with none of the three new fields passes (backward-compat)', () => {
    assert.doesNotThrow(() => StorySchema.parse(MINIMAL_STORY));
    const result = StorySchema.parse(MINIMAL_STORY);
    assert.equal(result.provides, undefined);
    assert.equal(result.requires, undefined);
    assert.equal(result.estimated_effort, undefined);
  });

  // ── Validation errors ───────────────────────────────────────────────────────

  it('[AC-effort-min] z.parse with estimated_effort: -1 throws (min: 0)', () => {
    assert.throws(
      () => StorySchema.parse({ ...MINIMAL_STORY, estimated_effort: -1 }),
      /too_small|Number must be greater than or equal to 0/i,
    );
  });

  it('[AC-effort-float] z.parse with estimated_effort: 1.5 throws (must be integer)', () => {
    assert.throws(
      () => StorySchema.parse({ ...MINIMAL_STORY, estimated_effort: 1.5 }),
      /Expected integer/i,
    );
  });

  it('[AC-requires-bad-value] z.parse with requires value that is not a string throws', () => {
    assert.throws(
      () =>
        StorySchema.parse({
          ...MINIMAL_STORY,
          requires: { db_schema: 42 },
        }),
      /Expected string/i,
    );
  });

  it('[AC-requires-nested-object] z.parse with requires value that is an object throws', () => {
    assert.throws(
      () =>
        StorySchema.parse({
          ...MINIMAL_STORY,
          requires: { db_schema: { nested: true } },
        }),
      /Expected string/i,
    );
  });

  // ── Round-trip: serialise → JSON.parse → StorySchema.parse ─────────────────

  it('[AC-roundtrip] all three fields survive JSON serialisation and deserialization', () => {
    const original = StorySchema.parse({
      ...MINIMAL_STORY,
      provides: { jwt_shape: 'string', metadata: { version: 1 } },
      requires: { upstream_type: 'story-001-000' },
      estimated_effort: 90,
    });

    const serialised = JSON.stringify(original);
    const parsed = StorySchema.parse(JSON.parse(serialised));

    assert.deepEqual(parsed.provides, original.provides, 'provides must survive round-trip');
    assert.deepEqual(parsed.requires, original.requires, 'requires must survive round-trip');
    assert.equal(parsed.estimated_effort, original.estimated_effort, 'estimated_effort must survive round-trip');
    assert.equal(parsed.id, original.id, 'id must survive round-trip');
    assert.equal(parsed.title, original.title, 'title must survive round-trip');
  });

  it('[AC-roundtrip-absent] absent fields remain undefined after round-trip', () => {
    const original = StorySchema.parse(MINIMAL_STORY);
    const parsed = StorySchema.parse(JSON.parse(JSON.stringify(original)));
    assert.equal(parsed.provides, undefined);
    assert.equal(parsed.requires, undefined);
    assert.equal(parsed.estimated_effort, undefined);
  });

  // ── EpicYamlSchema accepts new fields on stories ────────────────────────────

  it('[AC-epic-schema-accepts-new-fields] EpicYamlSchema.parse accepts stories with all three new fields', () => {
    const epic = {
      epic_id: 'epic-001',
      title: 'Test epic title',
      priority: 'must-have' as const,
      prd_ref: '.loom/planning/prd.md',
      requirements: ['FR-1'],
      stories: [
        {
          ...MINIMAL_STORY,
          provides: { output_type: 'AuthToken' },
          requires: { db_ready: 'story-001-000' },
          estimated_effort: 60,
        },
      ],
    };
    assert.doesNotThrow(() => EpicYamlSchema.parse(epic));
    const result = EpicYamlSchema.parse(epic);
    assert.equal(result.stories[0].estimated_effort, 60);
  });

  it('[AC-epic-schema-backward-compat] EpicYamlSchema.parse accepts stories without new fields', () => {
    const epic = {
      epic_id: 'epic-001',
      title: 'Test epic title',
      priority: 'must-have' as const,
      prd_ref: '.loom/planning/prd.md',
      requirements: ['FR-1'],
      stories: [MINIMAL_STORY],
    };
    assert.doesNotThrow(() => EpicYamlSchema.parse(epic));
  });

  it('[AC-epic-schema-rejects-bad-effort] EpicYamlSchema.parse rejects estimated_effort: "not-a-number"', () => {
    const epic = {
      epic_id: 'epic-001',
      title: 'Test epic title',
      priority: 'must-have' as const,
      prd_ref: '.loom/planning/prd.md',
      requirements: ['FR-1'],
      stories: [{ ...MINIMAL_STORY, estimated_effort: 'not-a-number' }],
    };
    assert.throws(() => EpicYamlSchema.parse(epic), /Expected number/i);
  });

  // ── YAML schema file content check ─────────────────────────────────────────

  it('[AC-yaml-schema-file] schemas/epic.schema.yaml contains provides, requires, estimated_effort', () => {
    assert.ok(fs.existsSync(SCHEMA_FILE), `schema file must exist at ${SCHEMA_FILE}`);
    const content = fs.readFileSync(SCHEMA_FILE, 'utf8');
    assert.ok(content.includes('provides'), 'epic.schema.yaml must contain "provides"');
    assert.ok(content.includes('requires'), 'epic.schema.yaml must contain "requires"');
    assert.ok(content.includes('estimated_effort'), 'epic.schema.yaml must contain "estimated_effort"');
    assert.ok(content.includes('minimum: 0'), 'epic.schema.yaml must constrain estimated_effort with minimum: 0');
  });
});

// ── Persona file smoke checks ───────────────────────────────────────────────

describe('Persona file smoke checks — provides field + JSON example block', () => {
  it('[AC-pm-persona] pm.md contains "provides" and a JSON example block', () => {
    const pmFile = path.join(PERSONAS_DIR, 'pm.md');
    assert.ok(fs.existsSync(pmFile), 'pm.md must exist');
    const content = fs.readFileSync(pmFile, 'utf8');
    assert.ok(content.includes('provides'), 'pm.md must contain the word "provides"');
    assert.ok(content.includes('requires'), 'pm.md must contain the word "requires"');
    assert.ok(content.includes('estimated_effort'), 'pm.md must contain the word "estimated_effort"');
    assert.ok(content.includes('```json'), 'pm.md must contain a JSON example block');
    // Must show a concrete example with the field
    assert.ok(
      content.includes('"provides"') || content.includes("'provides'"),
      'pm.md JSON example must reference the provides key',
    );
  });

  it('[AC-architect-persona] architect.md contains "provides" and a JSON example block', () => {
    const archFile = path.join(PERSONAS_DIR, 'architect.md');
    assert.ok(fs.existsSync(archFile), 'architect.md must exist');
    const content = fs.readFileSync(archFile, 'utf8');
    assert.ok(content.includes('provides'), 'architect.md must contain the word "provides"');
    assert.ok(content.includes('requires'), 'architect.md must contain the word "requires"');
    assert.ok(content.includes('estimated_effort'), 'architect.md must contain the word "estimated_effort"');
    assert.ok(content.includes('```json'), 'architect.md must contain a JSON example block');
    assert.ok(
      content.includes('"provides"') || content.includes("'provides'"),
      'architect.md JSON example must reference the provides key',
    );
  });
});
