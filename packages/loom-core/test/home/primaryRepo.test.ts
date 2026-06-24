import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import yaml from 'js-yaml';
import { resolvePrimaryRepo } from '../../src/home/primaryRepo.js';
import type { WorkspaceManifest, ManifestEntry } from '../../src/home/workspaceManifest.js';
import { StorySchema, EpicYamlSchema } from '../../src/types.js';

// ── Fixtures ──────────────────────────────────────────────────────────────────

function entry(slug: string, opts: { primary?: boolean } = {}): ManifestEntry {
  return { slug, path: `/repos/${slug}`, remote_url: null, ...opts };
}

function manifest(repos: ManifestEntry[]): WorkspaceManifest {
  return { version: 1, repos };
}

const BASE_STORY = {
  id: 'story-058-001',
  title: 'Per-story repo assignment',
  description: 'Adds optional repo field to the story model.',
  acceptance_criteria: ['AC1'],
  estimated_complexity: 'medium' as const,
  dependencies: [] as string[],
};

// ── AC1: StorySchema accepts repo field as optional ───────────────────────────

describe('StorySchema — repo field is optional', () => {
  it('validates a story WITH repo set to a slug string', () => {
    const result = StorySchema.safeParse({ ...BASE_STORY, repo: 'loom-a1b2c3d4' });
    assert.ok(result.success, `Expected parse success but got: ${JSON.stringify((result as { error: unknown }).error)}`);
    assert.equal(result.data.repo, 'loom-a1b2c3d4');
  });

  it('validates a story WITHOUT repo (field absent)', () => {
    const result = StorySchema.safeParse(BASE_STORY);
    assert.ok(result.success, `Expected parse success but got: ${JSON.stringify((result as { error: unknown }).error)}`);
    assert.equal(result.data.repo, undefined);
  });

  it('repo field is undefined on a parsed story with no repo declared', () => {
    const story = StorySchema.parse(BASE_STORY);
    assert.ok(!('repo' in story) || story.repo === undefined);
  });
});

// ── AC1: epic.schema.yaml accepts stories with and without repo via YAML→Zod path

describe('EpicYamlSchema — story repo field round-trips through yaml.load', () => {
  const epicBase = `
epic_id: epic-058
title: Cross-Repo Execution epic
status: planned
priority: must-have
prd_ref: docs/prd/epic-058.md
requirements: [FR-1]
stories:
`;

  it('accepts a story WITH repo via yaml.load + EpicYamlSchema', () => {
    const doc = yaml.load(`${epicBase}- id: story-058-001
  title: Per-story repo assignment long enough
  description: desc
  acceptance_criteria: [AC1]
  estimated_complexity: medium
  dependencies: []
  repo: loom-a1b2c3d4
`) as unknown;
    const result = EpicYamlSchema.safeParse(doc);
    assert.ok(result.success, `Expected parse success: ${JSON.stringify((result as { error: unknown }).error)}`);
    assert.equal(result.data.stories[0].repo, 'loom-a1b2c3d4');
  });

  it('accepts a story WITHOUT repo via yaml.load + EpicYamlSchema', () => {
    const doc = yaml.load(`${epicBase}- id: story-058-001
  title: Per-story repo assignment long enough
  description: desc
  acceptance_criteria: [AC1]
  estimated_complexity: medium
  dependencies: []
`) as unknown;
    const result = EpicYamlSchema.safeParse(doc);
    assert.ok(result.success, `Expected parse success: ${JSON.stringify((result as { error: unknown }).error)}`);
    assert.equal(result.data.stories[0].repo, undefined);
  });
});

// ── AC2 + AC3: resolvePrimaryRepo fail-closed chain ──────────────────────────

describe('resolvePrimaryRepo — one entry flagged primary:true', () => {
  it('returns the flagged slug when exactly one entry has primary:true', () => {
    const m = manifest([
      entry('repo-a'),
      entry('repo-b', { primary: true }),
      entry('repo-c'),
    ]);
    assert.equal(resolvePrimaryRepo(m), 'repo-b');
  });

  it('returns the flagged slug even when activeRepoSlug is provided', () => {
    const m = manifest([
      entry('repo-a', { primary: true }),
      entry('repo-b'),
    ]);
    assert.equal(resolvePrimaryRepo(m, 'repo-b'), 'repo-a');
  });
});

describe('resolvePrimaryRepo — no primary flag, exactly one repo', () => {
  it('returns that repo slug', () => {
    const m = manifest([entry('only-repo')]);
    assert.equal(resolvePrimaryRepo(m), 'only-repo');
  });

  it('returns the single repo slug even when activeRepoSlug is undefined', () => {
    const m = manifest([entry('solo-a1b2c3d4')]);
    assert.equal(resolvePrimaryRepo(m, undefined), 'solo-a1b2c3d4');
  });
});

describe('resolvePrimaryRepo — no primary flag, >1 repos, activeRepoSlug registered', () => {
  it('returns activeRepoSlug when it is registered', () => {
    const m = manifest([entry('repo-a'), entry('repo-b'), entry('repo-c')]);
    assert.equal(resolvePrimaryRepo(m, 'repo-b'), 'repo-b');
  });

  it('returns activeRepoSlug even when it is the first entry', () => {
    const m = manifest([entry('repo-a'), entry('repo-b')]);
    assert.equal(resolvePrimaryRepo(m, 'repo-a'), 'repo-a');
  });
});

describe('resolvePrimaryRepo — throws (fail-closed cases)', () => {
  it('throws when no flag and >1 repos and no activeRepoSlug provided', () => {
    const m = manifest([entry('repo-a'), entry('repo-b')]);
    assert.throws(() => resolvePrimaryRepo(m), /cannot guess|fail-closed/i);
  });

  it('throws when no flag and >1 repos and activeRepoSlug is not registered', () => {
    const m = manifest([entry('repo-a'), entry('repo-b')]);
    assert.throws(() => resolvePrimaryRepo(m, 'repo-unknown'), /cannot guess|fail-closed/i);
  });

  it('throws when more than one entry is flagged primary', () => {
    const m = manifest([
      entry('repo-a', { primary: true }),
      entry('repo-b', { primary: true }),
    ]);
    assert.throws(() => resolvePrimaryRepo(m), /2 repos flagged as primary|at most one/i);
  });

  it('throws when manifest has no registered repos', () => {
    const m = manifest([]);
    assert.throws(() => resolvePrimaryRepo(m), /no registered repos/i);
  });
});
