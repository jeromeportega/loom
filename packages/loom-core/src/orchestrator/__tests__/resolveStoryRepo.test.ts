import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { resolveStoryRepo } from '../resolveStoryRepo.js';
import type { Story } from '../../types.js';
import type { WorkspaceManifest, ManifestEntry } from '../../home/workspaceManifest.js';

// ── Fixtures ──────────────────────────────────────────────────────────────────

function entry(slug: string, root?: string): ManifestEntry {
  return { slug, path: root ?? `/realpath/repos/${slug}`, remote_url: null };
}

function manifest(repos: ManifestEntry[]): WorkspaceManifest {
  return { version: 1, repos };
}

function story(id: string, repo?: string): Story {
  return {
    id,
    title: `Story ${id} title long enough`,
    description: 'description',
    acceptance_criteria: ['AC1'],
    estimated_complexity: 'medium',
    dependencies: [],
    ...(repo !== undefined ? { repo } : {}),
  };
}

// ── AC3: resolveStoryRepo with story.repo present ─────────────────────────────

describe('resolveStoryRepo — story.repo is set', () => {
  it('returns {slug, root} from story.repo when present', () => {
    const m = manifest([
      entry('repo-a'),
      entry('repo-b', '/realpath/repo-b'),
    ]);
    const s = story('story-058-001', 'repo-b');
    const result = resolveStoryRepo(s, m, 'repo-a');
    assert.equal(result.slug, 'repo-b');
    assert.equal(result.root, '/realpath/repo-b');
  });

  it('realpath comes through from manifest entry.path', () => {
    const realpathRoot = '/verified/realpath/my-service-a1b2c3d4';
    const m = manifest([entry('my-service-a1b2c3d4', realpathRoot)]);
    const s = story('story-058-002', 'my-service-a1b2c3d4');
    const result = resolveStoryRepo(s, m, 'my-service-a1b2c3d4');
    assert.equal(result.root, realpathRoot);
  });
});

// ── AC3: resolveStoryRepo with story.repo absent ──────────────────────────────

describe('resolveStoryRepo — story.repo absent, uses primarySlug', () => {
  it('returns {slug, root} from primarySlug when story.repo is undefined', () => {
    const m = manifest([
      entry('primary-repo', '/realpath/primary'),
      entry('other-repo'),
    ]);
    const s = story('story-058-001');
    const result = resolveStoryRepo(s, m, 'primary-repo');
    assert.equal(result.slug, 'primary-repo');
    assert.equal(result.root, '/realpath/primary');
  });
});

// ── AC3: throws when slug is not in manifest ──────────────────────────────────

describe('resolveStoryRepo — throws for unregistered slug', () => {
  it('throws when story.repo references an unregistered slug', () => {
    const m = manifest([entry('repo-a')]);
    const s = story('story-058-001', 'not-registered');
    assert.throws(
      () => resolveStoryRepo(s, m, 'repo-a'),
      /not registered/i,
    );
  });

  it('throws when primarySlug is not in manifest', () => {
    const m = manifest([entry('repo-a')]);
    const s = story('story-058-001'); // no repo set
    assert.throws(
      () => resolveStoryRepo(s, m, 'missing-primary'),
      /not registered/i,
    );
  });
});

// ── AC4: Single-repo epic backward compatibility ──────────────────────────────

describe('resolveStoryRepo — single-repo epic backward compat (AC4)', () => {
  it('all stories of a single-repo epic with no repo declaration resolve to the one slug/root', () => {
    const singleRoot = '/realpath/my-monorepo-a1b2c3d4';
    const singleSlug = 'my-monorepo-a1b2c3d4';
    const m = manifest([entry(singleSlug, singleRoot)]);

    const stories = [
      story('story-058-001'),
      story('story-058-002'),
      story('story-058-003'),
    ];

    for (const s of stories) {
      const result = resolveStoryRepo(s, m, singleSlug);
      assert.equal(result.slug, singleSlug, `story ${s.id} should resolve to ${singleSlug}`);
      assert.equal(result.root, singleRoot, `story ${s.id} should resolve to root ${singleRoot}`);
    }
  });

  it('single-repo epic: stories without repo field return same result as primarySlug lookup', () => {
    const slug = 'solo-repo-deadbeef';
    const root = '/realpath/solo-repo';
    const m = manifest([entry(slug, root)]);
    const s = story('story-001-001');

    const result = resolveStoryRepo(s, m, slug);
    assert.deepEqual(result, { slug, root });
  });
});
