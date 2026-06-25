/**
 * story-062-002 — Approval-time cycle detection (ADR-002, fail-closed seam).
 *
 * Tests for the `approveAndDispatch` cycle check: a cyclic repo dependency
 * graph is detected at approve time, the epic stays 'planned', and therefore
 * no worker can ever be dispatched.
 *
 * Unit-level: all deps are in-process. Stories and manifests are constructed
 * in-memory; no file system or network access is needed.
 */
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDatabase, resetDatabaseForTest } from '../../state/Database.js';
import { EpicStore } from '../../state/EpicStore.js';
import { AuditLog } from '../../state/AuditLog.js';
import { PolicyEngine } from '../../guardrails/index.js';
import { approveAndDispatch, CyclicRepoDependencyError } from '../actions/approveAndDispatch.js';
import type { Story } from '../../types.js';
import type { WorkspaceManifest, ManifestEntry } from '../../home/workspaceManifest.js';

// ── Fixtures ──────────────────────────────────────────────────────────────────

function entry(slug: string, opts: { primary?: boolean } = {}): ManifestEntry {
  return { slug, path: `/repos/${slug}`, remote_url: null, ...opts };
}

function manifest(repos: ManifestEntry[]): WorkspaceManifest {
  return { version: 1, repos };
}

function story(id: string, deps: string[] = [], repo?: string): Story {
  return {
    id,
    title: `Story ${id} title long enough`,
    description: 'A test story',
    acceptance_criteria: ['AC1'],
    estimated_complexity: 'small',
    dependencies: deps,
    ...(repo !== undefined ? { repo } : {}),
  };
}

// ── Test lifecycle ────────────────────────────────────────────────────────────

let tmpDir: string;
let epicStore: EpicStore;
let auditLog: AuditLog;

beforeEach(() => {
  resetDatabaseForTest();
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'loom-approve-cycle-'));
  const loomDir = path.join(tmpDir, '.loom');
  fs.mkdirSync(loomDir, { recursive: true });
  const db = openDatabase(loomDir);
  epicStore = new EpicStore(db);
  auditLog = new AuditLog(db);
});

afterEach(() => {
  resetDatabaseForTest();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function seedPlannedEpic(epicId: string): void {
  epicStore.create(epicId, `Title for ${epicId}`);
}

function makePolicy() {
  return PolicyEngine.defaultPolicy();
}

// ── Cycle detection tests ─────────────────────────────────────────────────────

describe('approveAndDispatch — cycle detection (story-062-002)', () => {
  // AC1 happy-reject: 2-repo cycle A→B→A
  it('AC1: 2-cycle A→B→A is detected; approveAndDispatch throws CyclicRepoDependencyError', async () => {
    seedPlannedEpic('epic-001');

    // Story in repo-a depends on a story in repo-b, and vice versa → cycle.
    const stories = [
      story('story-001-001', ['story-001-002'], 'repo-a'),
      story('story-001-002', ['story-001-001'], 'repo-b'),
    ];
    const m = manifest([entry('repo-a', { primary: true }), entry('repo-b')]);

    await assert.rejects(
      () =>
        approveAndDispatch(
          { epicStore, auditLog, policy: makePolicy() },
          'epic-001',
          { actor: 'human', stories, manifest: m, primarySlug: 'repo-a' },
        ),
      (err: unknown) => {
        assert.ok(err instanceof CyclicRepoDependencyError, 'must throw CyclicRepoDependencyError');
        assert.match(err.message, /Cannot approve epic "epic-001"/);
        assert.match(err.message, /cycle/i);
        assert.ok(
          err.cyclicRepos.includes('repo-a') && err.cyclicRepos.includes('repo-b'),
          `cyclic repos must include "repo-a" and "repo-b", got: ${err.cyclicRepos}`,
        );
        return true;
      },
    );
  });

  // AC2/AC4: no dispatch — status must NOT change to 'approved' when a cycle is found.
  // Rejection before status mutation means no worker can ever be dispatched for this epic.
  it('AC2/AC4: cyclic epic stays "planned" — status never transitions to "approved"', async () => {
    seedPlannedEpic('epic-002');

    const stories = [
      story('story-002-001', ['story-002-002'], 'repo-x'),
      story('story-002-002', ['story-002-001'], 'repo-y'),
    ];
    const m = manifest([entry('repo-x', { primary: true }), entry('repo-y')]);

    await assert.rejects(
      () =>
        approveAndDispatch(
          { epicStore, auditLog, policy: makePolicy() },
          'epic-002',
          { actor: 'human', stories, manifest: m, primarySlug: 'repo-x' },
        ),
    );

    // The epic must still be 'planned' — no status mutation happened.
    const epic = epicStore.get('epic-002');
    assert.equal(epic?.status, 'planned', 'cyclic epic must remain "planned" — dispatch impossible');
  });

  // AC1 (longer cycle): A→B→C→A
  it('3-cycle A→B→C→A is detected; all three repos named in the error', async () => {
    seedPlannedEpic('epic-003');

    const stories = [
      story('story-003-001', ['story-003-003'], 'repo-a'),  // repo-a depends on repo-c
      story('story-003-002', ['story-003-001'], 'repo-b'),  // repo-b depends on repo-a
      story('story-003-003', ['story-003-002'], 'repo-c'),  // repo-c depends on repo-b → cycle
    ];
    const m = manifest([
      entry('repo-a', { primary: true }),
      entry('repo-b'),
      entry('repo-c'),
    ]);

    await assert.rejects(
      () =>
        approveAndDispatch(
          { epicStore, auditLog, policy: makePolicy() },
          'epic-003',
          { actor: 'human', stories, manifest: m, primarySlug: 'repo-a' },
        ),
      (err: unknown) => {
        assert.ok(err instanceof CyclicRepoDependencyError);
        assert.ok(err.cyclicRepos.length >= 3, 'all three repos must be reported');
        return true;
      },
    );
  });

  // Negative case: acyclic ≥3-repo DAG must NOT be rejected.
  it('acyclic 3-repo DAG (A→B→C, no back-edges) is approved without error', async () => {
    seedPlannedEpic('epic-004');

    const stories = [
      story('story-004-001', [], 'repo-c'),                    // repo-c has no deps (root)
      story('story-004-002', ['story-004-001'], 'repo-b'),     // repo-b depends on repo-c
      story('story-004-003', ['story-004-002'], 'repo-a'),     // repo-a depends on repo-b
    ];
    const m = manifest([
      entry('repo-a', { primary: true }),
      entry('repo-b'),
      entry('repo-c'),
    ]);

    // Must resolve without throwing.
    const result = await approveAndDispatch(
      { epicStore, auditLog, policy: makePolicy() },
      'epic-004',
      { actor: 'human', stories, manifest: m, primarySlug: 'repo-a' },
    );

    assert.equal(result.status, 'dispatching', 'acyclic graph must be approved');
    assert.equal(epicStore.get('epic-004')?.status, 'approved', 'epic must reach "approved"');
  });

  // No false positives for a single-repo epic (no cross-repo edges at all).
  it('single-repo epic with no cross-repo deps is approved without error', async () => {
    seedPlannedEpic('epic-005');

    const stories = [
      story('story-005-001', []),
      story('story-005-002', ['story-005-001']),
    ];
    const m = manifest([entry('repo-mono', { primary: true })]);

    const result = await approveAndDispatch(
      { epicStore, auditLog, policy: makePolicy() },
      'epic-005',
      { actor: 'human', stories, manifest: m, primarySlug: 'repo-mono' },
    );

    assert.equal(result.status, 'dispatching');
    assert.equal(epicStore.get('epic-005')?.status, 'approved');
  });

  // AC3 seam documentation: when stories/manifest are NOT provided (existing callers),
  // approveAndDispatch must still succeed — cycle check is opt-in and backward-compatible.
  it('backward compat: no stories/manifest → cycle check skipped, approve proceeds', async () => {
    seedPlannedEpic('epic-006');

    const result = await approveAndDispatch(
      { epicStore, auditLog, policy: makePolicy() },
      'epic-006',
      { actor: 'full-auto' }, // no stories/manifest — legacy caller path
    );

    assert.equal(result.status, 'dispatching');
    assert.equal(epicStore.get('epic-006')?.status, 'approved');
  });

  // AC1 error message quality: the error must name the cyclic repos.
  it('CyclicRepoDependencyError message is operator-readable and names the cyclic repos', async () => {
    seedPlannedEpic('epic-007');

    const stories = [
      story('story-007-001', ['story-007-002'], 'alpha'),
      story('story-007-002', ['story-007-001'], 'beta'),
    ];
    const m = manifest([entry('alpha', { primary: true }), entry('beta')]);

    let caughtErr: unknown;
    try {
      await approveAndDispatch(
        { epicStore, auditLog, policy: makePolicy() },
        'epic-007',
        { actor: 'human', stories, manifest: m, primarySlug: 'alpha' },
      );
      assert.fail('expected CyclicRepoDependencyError');
    } catch (err) {
      caughtErr = err;
    }

    assert.ok(caughtErr instanceof CyclicRepoDependencyError);
    assert.match(caughtErr.message, /"alpha"/, 'error must name "alpha"');
    assert.match(caughtErr.message, /"beta"/, 'error must name "beta"');
    assert.match(caughtErr.message, /cycle/i, 'error must mention cycle');
    assert.ok(caughtErr.edges.length > 0, 'edges must be surfaced');
    assert.match(caughtErr.edges[0].reason, /cycle/i, 'each edge reason is operator-readable');
  });

  // AC3 (topoSortRepos backstop): confirm the approval-time seam is the primary fail-closed
  // check. The topoSortRepos throw in CrossRepoCoordinator is a separate last-line defense.
  // This test simply verifies that the approval-time seam rejects cycles BEFORE dispatch.
  it('AC3: approval-time seam rejects cycles; no audit epic_approved row is written', async () => {
    seedPlannedEpic('epic-008');

    const stories = [
      story('story-008-001', ['story-008-002'], 'svc-a'),
      story('story-008-002', ['story-008-001'], 'svc-b'),
    ];
    const m = manifest([entry('svc-a', { primary: true }), entry('svc-b')]);

    await assert.rejects(
      () =>
        approveAndDispatch(
          { epicStore, auditLog, policy: makePolicy() },
          'epic-008',
          { actor: 'human', stories, manifest: m, primarySlug: 'svc-a' },
        ),
    );

    // No epic_approved audit row must have been written.
    const approvedRows = auditLog.recent(50).filter(
      r => r.action === 'epic_approved' && r.command === 'epic-008',
    );
    assert.equal(
      approvedRows.length,
      0,
      'no epic_approved audit row must exist when cycle rejected',
    );
  });
});
