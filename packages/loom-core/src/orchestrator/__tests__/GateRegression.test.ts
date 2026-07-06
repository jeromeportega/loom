import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { checkCrossEpicRegressions } from '../GateRegression.js';
import { runFinalizeGates } from '../FinalizeGates.js';
import { SharedContract } from '../SharedContract.js';
import { openDatabase, resetDatabaseForTest } from '../../state/Database.js';
import { EpicStore } from '../../state/EpicStore.js';

// ─── story-077-004 — GateRegression unit tests (tree-presence rework) ────────
//
// A cross-epic regression is a symbol a prior delivered epic pinned that was
// present in the tree BEFORE this epic (basePresent) and is gone AFTER it
// (headPresent). "Present-then-absent across this epic" is what attributes the
// removal to the current epic and ignores churn (a moved/renamed-but-still-alive
// symbol is present at head, so it is not flagged).

// ── git repo helper ──────────────────────────────────────────────────────────

function makeGitRepo(): { root: string; git: (args: string[]) => string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'loom-rg-'));
  const git = (args: string[]) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
  git(['init', '-q']);
  git(['config', 'user.email', 'test@loom.dev']);
  git(['config', 'user.name', 'Loom Test']);
  git(['config', 'commit.gpgsign', 'false']);
  return { root, git };
}

// ── checkCrossEpicRegressions — core behaviour ───────────────────────────────

describe('checkCrossEpicRegressions', () => {
  it('returns [] when priorContracts is empty', () => {
    const result = checkCrossEpicRegressions({
      priorContracts: new Map(),
      basePresent: new Set(['UserRecord']),
      headPresent: new Set(),
    });
    assert.deepEqual(result, []);
  });

  it('flags a symbol present before this epic but gone after', () => {
    const result = checkCrossEpicRegressions({
      priorContracts: new Map([['epic-A', ['UserRecord']]]),
      basePresent: new Set(['UserRecord']),
      headPresent: new Set(), // removed by this epic
    });
    assert.equal(result.length, 1);
    assert.equal(result[0].symbol, 'UserRecord');
    assert.equal(result[0].priorEpicId, 'epic-A');
  });

  it('does not flag a symbol still present at head (churn / rename that stays alive)', () => {
    const result = checkCrossEpicRegressions({
      priorContracts: new Map([['epic-A', ['UserRecord']]]),
      basePresent: new Set(['UserRecord']),
      headPresent: new Set(['UserRecord']),
    });
    assert.deepEqual(result, []);
  });

  it('does not flag a symbol that was already absent before this epic', () => {
    // Not present at base → this epic did not remove it; not our regression.
    const result = checkCrossEpicRegressions({
      priorContracts: new Map([['epic-A', ['UserRecord']]]),
      basePresent: new Set(),
      headPresent: new Set(),
    });
    assert.deepEqual(result, []);
  });

  it('multiple prior epics: only the regressed one is flagged', () => {
    const result = checkCrossEpicRegressions({
      priorContracts: new Map([
        ['epic-A', ['UserRecord']],    // removed → regression
        ['epic-B', ['PaymentRecord']], // still present → no regression
      ]),
      basePresent: new Set(['UserRecord', 'PaymentRecord']),
      headPresent: new Set(['PaymentRecord']),
    });
    assert.equal(result.length, 1);
    assert.equal(result[0].priorEpicId, 'epic-A');
    assert.equal(result[0].symbol, 'UserRecord');
  });
});

// ── runFinalizeGates — regression gate policy wiring (real git tree) ─────────

describe('runFinalizeGates — regression gate policy modes', () => {
  let repo: ReturnType<typeof makeGitRepo>;
  let baseSha: string;

  // base has UserRecord; head removes it entirely → a genuine regression.
  beforeEach(() => {
    repo = makeGitRepo();
    fs.writeFileSync(path.join(repo.root, 'models.ts'), 'export interface UserRecord { id: string; }\n');
    repo.git(['add', '.']);
    repo.git(['commit', '-q', '-m', 'base: UserRecord present']);
    baseSha = repo.git(['rev-parse', 'HEAD']);

    // Head must not even mention the symbol — a comment naming it would (correctly)
    // count as present under the tree-wide grep, which is exactly the point.
    fs.writeFileSync(path.join(repo.root, 'models.ts'), '// model type deleted in this epic\n');
    repo.git(['add', '.']);
    repo.git(['commit', '-q', '-m', 'head: model removed']);
  });

  afterEach(() => {
    fs.rmSync(repo.root, { recursive: true, force: true });
  });

  function run(mode: 'off' | 'warn' | 'block') {
    SharedContract.write(
      repo.root,
      'prior-epic',
      '```typescript\nexport interface UserRecord { id: string; }\n```'
    );
    return runFinalizeGates({
      contractRoot: repo.root,
      treeRoot: repo.root,
      headRef: 'HEAD',
      baseRef: baseSha,
      epicId: 'current-epic',
      epicDiff: '',
      mode,
      deliveredEpicIds: ['prior-epic'],
    });
  }

  it('mode=off: returns [] regressions and hardFail=false even with a real regression', async () => {
    const result = await run('off');
    assert.deepEqual(result.regressions, []);
    assert.equal(result.hardFail, false);
  });

  it('mode=warn with regression: regressions returned but hardFail=false', async () => {
    const result = await run('warn');
    assert.ok(result.regressions.some(r => r.symbol === 'UserRecord'));
    assert.equal(result.regressions[0].priorEpicId, 'prior-epic');
    assert.equal(result.hardFail, false);
  });

  it('mode=block: regression is ADVISORY — finding present but hardFail=false', async () => {
    // Like symbol drift, the cross-epic regression gate is a heuristic over
    // prose-heavy contracts and must never withhold a PR on its own.
    const result = await run('block');
    assert.ok(result.regressions.some(r => r.symbol === 'UserRecord'), 'regression still reported');
    assert.equal(result.hardFail, false, 'regression alone must NOT hard-fail');
  });

  it('mode=block with no regression: hardFail=false (symbol still present at head)', async () => {
    // Prior contract pins a symbol that is NOT removed — restore UserRecord at head.
    fs.writeFileSync(path.join(repo.root, 'models.ts'), 'export interface UserRecord { id: string; }\n');
    repo.git(['add', '.']);
    repo.git(['commit', '-q', '-m', 'head: UserRecord restored']);
    const result = await run('block');
    assert.deepEqual(result.regressions, []);
    assert.equal(result.hardFail, false);
  });
});

// ── Integration: only delivered (done) epic contracts are checked ────────────

describe('runFinalizeGates — delivered-only contract filtering', () => {
  let repo: ReturnType<typeof makeGitRepo>;
  let baseSha: string;

  beforeEach(() => {
    resetDatabaseForTest();
    repo = makeGitRepo();
    // base has BOTH symbols; head removes BOTH.
    fs.writeFileSync(
      path.join(repo.root, 'models.ts'),
      'export interface UserRecord { id: string; }\nexport interface RunningSymbol { value: number; }\n'
    );
    repo.git(['add', '.']);
    repo.git(['commit', '-q', '-m', 'base: both present']);
    baseSha = repo.git(['rev-parse', 'HEAD']);

    fs.writeFileSync(path.join(repo.root, 'models.ts'), '// both removed\n');
    repo.git(['add', '.']);
    repo.git(['commit', '-q', '-m', 'head: both removed']);
  });

  afterEach(() => {
    resetDatabaseForTest();
    fs.rmSync(repo.root, { recursive: true, force: true });
  });

  it('checks only done-epic contracts, not in_progress-epic contracts', async () => {
    const db = openDatabase(path.join(repo.root, '.loom'));
    const epicStore = new EpicStore(db);

    epicStore.create('epic-done', 'Delivered Epic', '.loom/epics/epic-done.yaml');
    epicStore.updateStatus('epic-done', 'done');
    epicStore.create('epic-inflight', 'In-Flight Epic', '.loom/epics/epic-inflight.yaml');
    epicStore.updateStatus('epic-inflight', 'in_progress');

    SharedContract.write(repo.root, 'epic-done', '```typescript\nexport interface UserRecord { id: string; }\n```');
    SharedContract.write(repo.root, 'epic-inflight', '```typescript\nexport interface RunningSymbol { value: number; }\n```');

    const deliveredEpicIds = epicStore.listByStatus('done').map(r => r.id);
    assert.deepEqual(deliveredEpicIds, ['epic-done']);

    const result = await runFinalizeGates({
      contractRoot: repo.root,
      treeRoot: repo.root,
      headRef: 'HEAD',
      baseRef: baseSha,
      epicId: 'current-epic',
      epicDiff: '',
      mode: 'warn',
      deliveredEpicIds,
    });

    const symbols = result.regressions.map(r => r.symbol);
    assert.ok(symbols.includes('UserRecord'), 'done-epic symbol must be flagged');
    assert.ok(!symbols.includes('RunningSymbol'), 'in_progress-epic symbol must NOT be checked');
  });
});
