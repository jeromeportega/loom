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
  // node_modules/ is gitignored in real repos; ensure() creates symlinks there.
  fs.writeFileSync(path.join(repo, '.gitignore'), 'node_modules/\n');
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

// ─── syncWithMain ──────────────────────────────────────────────────────────────

describe('IntegrationBranch.syncWithMain', () => {
  let remote: string;

  beforeEach(() => {
    // Create a bare remote repo and register it as origin in the shared test repo.
    // The integration worktree inherits the same .git config, so fetch runs against
    // this same remote.
    remote = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'loom-remote-')));
    execFileSync('git', ['init', '--bare', '-q'], { cwd: remote, encoding: 'utf8' });
    gitc(['remote', 'add', 'origin', remote]);
    // Seed the remote with the initial commit on branch 'main'.
    gitc(['push', '-q', 'origin', `${base}:refs/heads/main`]);
  });

  afterEach(() => {
    fs.rmSync(remote, { recursive: true, force: true });
  });

  it('returns alreadyCurrent when integration HEAD is already a descendant of origin/main', async () => {
    const ib = new IntegrationBranch(repo);
    ib.ensure('epic-001', base);
    // The integration branch is at the same commit as origin/main — already current.
    const result = await ib.syncWithMain('epic-001', 'main');
    assert.equal(result.alreadyCurrent, true);
    assert.equal(result.mergedCommits, 0);
    assert.equal(result.conflicted, false);
    assert.equal(result.diagnostic, undefined);
  });

  it('fetches and merges N new commits from main and returns mergedCommits=N', async () => {
    const ib = new IntegrationBranch(repo);
    ib.ensure('epic-001', base);

    // Add 2 commits to the main repo's default branch and push to origin/main.
    fs.writeFileSync(path.join(repo, 'new1.txt'), 'commit 1\n');
    gitc(['add', 'new1.txt']);
    gitc(['commit', '-q', '-m', 'main: commit 1']);
    fs.writeFileSync(path.join(repo, 'new2.txt'), 'commit 2\n');
    gitc(['add', 'new2.txt']);
    gitc(['commit', '-q', '-m', 'main: commit 2']);
    gitc(['push', '-q', 'origin', 'HEAD:refs/heads/main']);

    const result = await ib.syncWithMain('epic-001', 'main');
    assert.equal(result.alreadyCurrent, false);
    assert.equal(result.mergedCommits, 2);
    assert.equal(result.conflicted, false);

    // Verify the integration worktree received the merged files.
    const wtPath = ib.path('epic-001');
    assert.ok(fs.existsSync(path.join(wtPath, 'new1.txt')), 'new1.txt merged in');
    assert.ok(fs.existsSync(path.join(wtPath, 'new2.txt')), 'new2.txt merged in');
  });

  it('aborts on merge conflict, returns conflicted=true, leaves integration branch clean', async () => {
    const ib = new IntegrationBranch(repo);
    const info = ib.ensure('epic-001', base);

    // Commit a conflicting change to the integration branch.
    fs.writeFileSync(path.join(info.path, 'shared.txt'), 'from integration\n');
    execFileSync('git', ['add', 'shared.txt'], { cwd: info.path, encoding: 'utf8' });
    execFileSync('git', ['commit', '-q', '-m', 'integration: write shared'], {
      cwd: info.path,
      encoding: 'utf8',
    });

    // Commit the same file with different content on the main repo and push.
    fs.writeFileSync(path.join(repo, 'shared.txt'), 'from main\n');
    gitc(['add', 'shared.txt']);
    gitc(['commit', '-q', '-m', 'main: write shared']);
    gitc(['push', '-q', 'origin', 'HEAD:refs/heads/main']);

    const result = await ib.syncWithMain('epic-001', 'main');
    assert.equal(result.conflicted, true);
    assert.ok(typeof result.diagnostic === 'string' && result.diagnostic.length > 0, 'diagnostic present');
    assert.equal(result.alreadyCurrent, false);
    // The merge must be aborted — no unmerged paths and no MERGE_HEAD.
    assert.deepEqual(ib.unmergedPaths('epic-001'), []);
    assert.ok(!mergeInProgress(info.path), 'merge aborted — no MERGE_HEAD');
    const status = gitc(['status', '--porcelain'], info.path);
    assert.equal(status, '', 'integration worktree is clean');
  });

  it('returns conflicted=true with fetch diagnostic when git fetch fails (unreachable remote)', async () => {
    const ib = new IntegrationBranch(repo);
    ib.ensure('epic-001', base);

    // Point origin at a path that does not exist so the fetch fails.
    gitc(['remote', 'set-url', 'origin', '/nonexistent/loom-remote-does-not-exist']);

    const result = await ib.syncWithMain('epic-001', 'main');
    assert.equal(result.conflicted, true);
    assert.ok(typeof result.diagnostic === 'string' && result.diagnostic.length > 0, 'diagnostic present');
    assert.ok(result.diagnostic!.includes('git fetch'), `expected 'git fetch' in diagnostic, got: ${result.diagnostic}`);
    // No merge was attempted, so mergedCommits is 0.
    assert.equal(result.mergedCommits, 0);
  });

  it('defaults mainBranch to "main" when the param is omitted', async () => {
    const ib = new IntegrationBranch(repo);
    ib.ensure('epic-001', base);
    // Omit mainBranch — should behave identically to passing 'main'.
    const result = await ib.syncWithMain('epic-001');
    assert.equal(result.alreadyCurrent, true);
    assert.equal(result.conflicted, false);
  });

  it('refuses to sync when the integration path is a stale plain dir (protects the operator checkout)', async () => {
    const ib = new IntegrationBranch(repo);
    // A stale PLAIN directory at the integration worktree path — a crash between
    // mkdir and `worktree add`, NOT a real linked worktree. (No ensure() call.)
    const wtPath = ib.path('epic-001');
    fs.mkdirSync(wtPath, { recursive: true });
    fs.writeFileSync(path.join(wtPath, 'stale.txt'), 'leftover\n');

    // Operator has another branch checked out with a local commit. Without the
    // worktree validation, every git call in syncWithMain resolves UP to this
    // checkout and merges origin/main into `operator-work` (the reproduced bug).
    gitc(['checkout', '-q', '-b', 'operator-work']);
    fs.writeFileSync(path.join(repo, 'operator.txt'), 'operator work\n');
    gitc(['add', 'operator.txt']);
    gitc(['commit', '-q', '-m', 'operator commit']);
    const headBefore = gitc(['rev-parse', 'HEAD']);

    const result = await ib.syncWithMain('epic-001', 'main');

    assert.equal(result.conflicted, true, 'a stale non-worktree dir must be refused');
    assert.equal(result.alreadyCurrent, false);
    assert.equal(result.mergedCommits, 0);
    assert.match(result.diagnostic ?? '', /not a valid integration worktree|stale/i);

    // The operator's checkout was NOT mutated — no silent merge into their branch.
    assert.equal(gitc(['rev-parse', 'HEAD']), headBefore, 'operator HEAD must be unchanged');
    assert.equal(gitc(['rev-parse', '--abbrev-ref', 'HEAD']), 'operator-work', 'operator branch unchanged');
    assert.equal(mergeInProgress(repo), false, 'no merge left in progress in the operator checkout');
  });
});
