import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { IntegrationBranch } from '../orchestrator/IntegrationBranch.js';

let repo: string;
let base: string;

function gitc(args: string[], cwd = repo): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

/** True when `cwd`'s worktree has a merge in progress (MERGE_HEAD set). */
function mergeInProgress(cwd: string): boolean {
  try {
    execFileSync('git', ['rev-parse', '--verify', '--quiet', 'MERGE_HEAD'], {
      cwd,
      stdio: 'ignore',
    });
    return true;
  } catch {
    return false;
  }
}

/** Creates `story/<id>` off `base` carrying a one-line change to `file`. */
function storyBranch(id: string, file: string, content: string): void {
  gitc(['checkout', '-q', '-b', `story/${id}`, base]);
  fs.writeFileSync(path.join(repo, file), content);
  gitc(['add', '.']);
  gitc(['commit', '-q', '-m', `${id}: work`]);
  gitc(['checkout', '-q', base]);
}

beforeEach(() => {
  repo = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'loom-ib-')));
  gitc(['init', '-q']);
  gitc(['config', 'user.email', 'test@loom.dev']);
  gitc(['config', 'user.name', 'Loom Test']);
  gitc(['config', 'commit.gpgsign', 'false']);
  fs.writeFileSync(path.join(repo, 'README.md'), '# test\n');
  gitc(['add', '.']);
  gitc(['commit', '-q', '-m', 'initial']);
  base = gitc(['rev-parse', 'HEAD']);
});

afterEach(() => {
  fs.rmSync(repo, { recursive: true, force: true });
});

describe('IntegrationBranch', () => {
  it('creates epic/<id> at base in a worktree under .loom/integration', () => {
    const ib = new IntegrationBranch(repo);
    assert.equal(ib.tip('epic-001'), null);

    const info = ib.ensure('epic-001', base);
    assert.equal(info.branch, 'epic/epic-001');
    assert.equal(info.path, path.join(repo, '.loom', 'integration', 'epic-001'));
    assert.equal(info.tip, base);
    assert.ok(fs.existsSync(info.path), 'worktree dir should exist');
    assert.equal(ib.tip('epic-001'), base);
    // Deliberately OUTSIDE .loom/worktrees so the orphan janitor never prunes it.
    assert.ok(!info.path.includes(path.join('.loom', 'worktrees')));
  });

  it('merges a story branch and advances the tip with the file present', () => {
    storyBranch('s1', 'a.txt', 'A\n');
    const ib = new IntegrationBranch(repo);
    const info = ib.ensure('epic-001', base);

    const out = ib.mergeStory('epic-001', 's1', 'Story one');
    assert.equal(out.ok, true);
    assert.equal(out.conflict, false);
    assert.equal(out.alreadyMerged, false);
    assert.notEqual(ib.tip('epic-001'), base);
    assert.ok(fs.existsSync(path.join(info.path, 'a.txt')), 'merged file present in worktree');
  });

  it('reports a re-merge of the same story as already up to date (idempotent)', () => {
    storyBranch('s1', 'a.txt', 'A\n');
    const ib = new IntegrationBranch(repo);
    ib.ensure('epic-001', base);
    assert.equal(ib.mergeStory('epic-001', 's1', 'Story one').ok, true);

    const again = ib.mergeStory('epic-001', 's1', 'Story one');
    assert.equal(again.ok, true);
    assert.equal(again.alreadyMerged, true);
  });

  it('aborts a conflicting merge, leaves the work on the story branch, stays clean', () => {
    storyBranch('s1', 'shared.txt', 'from s1\n');
    storyBranch('s2', 'shared.txt', 'from s2\n');
    const ib = new IntegrationBranch(repo);
    const info = ib.ensure('epic-001', base);

    assert.equal(ib.mergeStory('epic-001', 's1', 'Story one').ok, true);
    const tipAfterS1 = ib.tip('epic-001');

    const conflict = ib.mergeStory('epic-001', 's2', 'Story two');
    assert.equal(conflict.ok, false);
    assert.equal(conflict.conflict, true);
    // Tip is unchanged and the worktree is not left mid-merge.
    assert.equal(ib.tip('epic-001'), tipAfterS1);
    assert.ok(!mergeInProgress(info.path), 'no merge left in progress');
    const status = gitc(['status', '--porcelain'], info.path);
    assert.equal(status, '', 'worktree must be clean after an aborted merge');
    // s2's commit is preserved on its own branch.
    assert.ok(gitc(['rev-parse', 'refs/heads/story/s2']).length > 0);
  });

  it('is idempotent on ensure(): reuse keeps merged work instead of resetting', () => {
    storyBranch('s1', 'a.txt', 'A\n');
    const ib = new IntegrationBranch(repo);
    ib.ensure('epic-001', base);
    ib.mergeStory('epic-001', 's1', 'Story one');
    const tip = ib.tip('epic-001');

    // A second ensure (e.g. finalize after dispatch) must NOT reset to base.
    const info = ib.ensure('epic-001', base);
    assert.equal(info.tip, tip);
    assert.ok(fs.existsSync(path.join(info.path, 'a.txt')));
  });

  it('recovers from a crash that left a half-finished merge in the worktree', () => {
    storyBranch('s1', 'shared.txt', 'from s1\n');
    storyBranch('s2', 'shared.txt', 'from s2\n');
    const ib = new IntegrationBranch(repo);
    const info = ib.ensure('epic-001', base);
    ib.mergeStory('epic-001', 's1', 'Story one');

    // Simulate a crash mid-merge: start a conflicting merge and DON'T abort.
    try {
      execFileSync('git', ['merge', '--no-ff', '-m', 'crash', 'story/s2'], {
        cwd: info.path,
        stdio: 'ignore',
      });
    } catch {
      // expected conflict — left in place to mimic a crash
    }
    assert.ok(mergeInProgress(info.path), 'merge left in progress');

    // ensure() must clear it so the next merge starts from a clean tip.
    ib.ensure('epic-001', base);
    assert.ok(!mergeInProgress(info.path));
    assert.equal(gitc(['status', '--porcelain'], info.path), '');
  });

  it('recovers when an orphaned non-worktree directory sits at the worktree path', () => {
    const ib = new IntegrationBranch(repo);
    const wtPath = ib.path('epic-001');
    // Simulate a crash between mkdir and `worktree add`: a non-empty dir that
    // is NOT a registered worktree. A naive `worktree add` would refuse it.
    fs.mkdirSync(wtPath, { recursive: true });
    fs.writeFileSync(path.join(wtPath, 'stale.txt'), 'left over\n');

    const info = ib.ensure('epic-001', base);
    assert.equal(info.tip, base);
    assert.equal(
      gitc(['rev-parse', '--is-inside-work-tree'], info.path),
      'true',
      'a clean worktree now exists at the path'
    );
    assert.ok(!fs.existsSync(path.join(info.path, 'stale.txt')), 'stale content cleared');
  });

  it('leaveConflict keeps the merge in progress and reports the conflicted files', () => {
    storyBranch('s1', 'shared.txt', 'from s1\n');
    storyBranch('s2', 'shared.txt', 'from s2\n');
    const ib = new IntegrationBranch(repo);
    const info = ib.ensure('epic-001', base);
    ib.mergeStory('epic-001', 's1', 'Story one');

    const out = ib.mergeStory('epic-001', 's2', 'Story two', { leaveConflict: true });
    assert.equal(out.ok, false);
    assert.equal(out.conflict, true);
    assert.deepEqual(out.conflictedFiles, ['shared.txt']);
    // The merge is LEFT in place (not aborted) so the integrator can work on it.
    assert.ok(mergeInProgress(info.path), 'conflicted merge preserved');
    assert.deepEqual(ib.unmergedPaths('epic-001'), ['shared.txt']);
    assert.ok(ib.hasConflictMarkers('epic-001', ['shared.txt']), 'markers are present');
  });

  it('commitResolved finalizes the merge after the markers are cleared', () => {
    storyBranch('s1', 'shared.txt', 'from s1\n');
    storyBranch('s2', 'shared.txt', 'from s2\n');
    const ib = new IntegrationBranch(repo);
    const info = ib.ensure('epic-001', base);
    ib.mergeStory('epic-001', 's1', 'Story one');
    ib.mergeStory('epic-001', 's2', 'Story two', { leaveConflict: true });

    // Resolve the markers, then commit the merge.
    fs.writeFileSync(path.join(info.path, 'shared.txt'), 'merged\n');
    assert.equal(ib.hasConflictMarkers('epic-001', ['shared.txt']), false);
    const committed = ib.commitResolved('epic-001', 'Merge s2 (resolved)');
    assert.equal(committed.ok, true);
    assert.ok(!mergeInProgress(info.path), 'merge committed, none in progress');
    assert.equal(gitc(['show', 'epic/epic-001:shared.txt']), 'merged');
  });

  it('reset rolls the worktree and branch back to a prior tip', () => {
    storyBranch('s1', 'a.txt', 'A\n');
    storyBranch('s2', 'b.txt', 'B\n');
    const ib = new IntegrationBranch(repo);
    const info = ib.ensure('epic-001', base);
    ib.mergeStory('epic-001', 's1', 'Story one');
    const tipAfterS1 = ib.tip('epic-001')!;
    ib.mergeStory('epic-001', 's2', 'Story two');
    assert.notEqual(ib.tip('epic-001'), tipAfterS1);

    ib.reset('epic-001', tipAfterS1);
    assert.equal(ib.tip('epic-001'), tipAfterS1);
    assert.ok(fs.existsSync(path.join(info.path, 'a.txt')));
    assert.ok(!fs.existsSync(path.join(info.path, 'b.txt')), 's2 work rolled back');
  });

  it('abortMerge clears a left-in-place conflict so the worktree is clean again', () => {
    storyBranch('s1', 'shared.txt', 'from s1\n');
    storyBranch('s2', 'shared.txt', 'from s2\n');
    const ib = new IntegrationBranch(repo);
    const info = ib.ensure('epic-001', base);
    ib.mergeStory('epic-001', 's1', 'Story one');
    ib.mergeStory('epic-001', 's2', 'Story two', { leaveConflict: true });
    assert.ok(mergeInProgress(info.path));

    ib.abortMerge('epic-001');
    assert.ok(!mergeInProgress(info.path), 'merge aborted');
    assert.equal(gitc(['status', '--porcelain'], info.path), '', 'worktree clean');
  });

  it('isStoryMerged: true after the story branch is folded into epic/<id>', () => {
    storyBranch('s1', 'a.txt', 'A\n');
    const ib = new IntegrationBranch(repo);
    ib.ensure('epic-001', base);
    // Not merged yet — only the story branch exists.
    assert.equal(ib.isStoryMerged('epic-001', 's1'), false);
    // After a successful merge-back, the story is an ancestor of the epic.
    ib.mergeStory('epic-001', 's1', 'one');
    assert.equal(ib.isStoryMerged('epic-001', 's1'), true);
  });

  it('isStoryMerged: false when either branch is missing (never throws)', () => {
    const ib = new IntegrationBranch(repo);
    // Neither branch exists — both pre-check guards fire.
    assert.equal(ib.isStoryMerged('epic-001', 'ghost'), false);
    // Epic exists, story branch absent.
    ib.ensure('epic-001', base);
    assert.equal(ib.isStoryMerged('epic-001', 'ghost'), false);
    // Story exists, epic absent.
    storyBranch('orphan', 'a.txt', 'A\n');
    assert.equal(ib.isStoryMerged('epic-missing', 'orphan'), false);
  });

  it('remove() drops the worktree but keeps the branch; removeBranch() drops both', () => {
    const ib = new IntegrationBranch(repo);
    const info = ib.ensure('epic-001', base);

    ib.remove('epic-001');
    assert.ok(!fs.existsSync(info.path), 'worktree dir removed');
    assert.ok(gitc(['rev-parse', 'refs/heads/epic/epic-001']).length > 0, 'branch kept');

    ib.removeBranch('epic-001');
    const exists = execFileSync('git', ['branch', '--list', 'epic/epic-001'], {
      cwd: repo,
      encoding: 'utf8',
    }).trim();
    assert.equal(exists, '', 'branch removed');
  });
});
