import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runCrossEpicGate } from '../CrossEpicGate.js';
import { IntegrationGate, type GateOutcome, type CommandRunner } from '../IntegrationGate.js';
import { EpicFinalizer } from '../EpicFinalizer.js';
import type { EpicFinalizerOptions } from '../EpicFinalizer.js';
import yaml from 'js-yaml';
import { openDatabase, resetDatabaseForTest } from '../../state/Database.js';
import { EpicStore } from '../../state/EpicStore.js';
import { AgentStore } from '../../state/AgentStore.js';
import type { Story } from '../../types.js';

// ─── Story story-007-009 ────────────────────────────────────────────────────
// Cross-epic union gate (FR-9/FR-10) + the FR-11 finalizer hint. Integration
// level: real temp `git init` repos with real branches/merges, a stubbed /
// injected IntegrationGate.run(), no sleeps, no real cursor-agent. The real
// epic branches are NEVER mutated — asserted by snapshotting every ref before
// and after.

let repo: string;

function gitc(args: string[], cwd = repo): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

/** Realpath so `git worktree`'s realpath reporting matches path assertions. */
function makeRepo(): string {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'loom-xepic-')));
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: dir });
  execFileSync('git', ['config', 'user.email', 'test@loom.dev'], { cwd: dir });
  execFileSync('git', ['config', 'user.name', 'Loom Test'], { cwd: dir });
  execFileSync('git', ['config', 'commit.gpgsign', 'false'], { cwd: dir });
  return dir;
}

/** Writes `content` to `file`, commits it on the current branch, returns the sha. */
function commitFile(file: string, content: string, message: string): string {
  fs.writeFileSync(path.join(repo, file), content);
  gitc(['add', file]);
  gitc(['commit', '-q', '-m', message]);
  return gitc(['rev-parse', 'HEAD']);
}

/** Snapshot of every ref (branch tip) — the byte-equality witness for "untouched". */
function refSnapshot(): Record<string, string> {
  const out = gitc(['for-each-ref', '--format=%(refname) %(objectname)']);
  const map: Record<string, string> = {};
  for (const line of out.split('\n').filter(Boolean)) {
    const [ref, sha] = line.split(' ');
    map[ref] = sha;
  }
  return map;
}

function stubGate(over: Partial<GateOutcome> = {}): { run: () => Promise<GateOutcome> } {
  return {
    run: async () => ({
      ok: true,
      ran: true,
      command: 'stub',
      exitCode: 0,
      timedOut: false,
      durationMs: 1,
      output: '',
      amputated: [],
      summary: 'stub passed',
      ...over,
    }),
  };
}

beforeEach(() => {
  repo = makeRepo();
  commitFile('README.md', '# base\n', 'init');
});

afterEach(() => {
  fs.rmSync(repo, { recursive: true, force: true });
});

describe('runCrossEpicGate — graded outcomes', () => {
  it('(1) two epic branches that conflict → per-pair file list, exitCode 3, stops at first conflict', async () => {
    // Both epics diverge on the SAME file from the same base → a mechanical
    // conflict when the second is merged onto the first.
    gitc(['checkout', '-q', '-b', 'epic/epic-a']);
    commitFile('shared.txt', 'A-side\n', 'epic-a edits shared');
    gitc(['checkout', '-q', 'main']);
    gitc(['checkout', '-q', '-b', 'epic/epic-b']);
    commitFile('shared.txt', 'B-side\n', 'epic-b edits shared');
    gitc(['checkout', '-q', 'main']);

    const before = refSnapshot();
    let gateRan = false;
    const outcome = await runCrossEpicGate(
      { projectRoot: repo },
      {
        gate: { run: async () => { gateRan = true; return stubGate().run(); } },
        listEpicBranches: () => ['epic/epic-a', 'epic/epic-b'],
      }
    );

    assert.equal(outcome.exitCode, 3, 'a mechanical conflict is advisory exit 3');
    assert.equal(outcome.conflicts.length, 1, 'merging STOPS at the first conflict');
    const c = outcome.conflicts[0];
    assert.equal(c.epicA, 'epic/epic-a', 'epicA is the branch already on the union tip');
    assert.equal(c.epicB, 'epic/epic-b', 'epicB is the branch that failed to merge');
    assert.deepEqual(c.files, ['shared.txt'], 'the per-pair conflicting file list is reported');
    assert.equal(gateRan, false, 'the suite is NOT run once a conflict is found');
    assert.equal(outcome.gate, undefined, 'no gate result on the conflict path');

    // Real branches untouched.
    assert.deepEqual(refSnapshot(), before, 'no real ref moved');
    assert.equal(outcome.cleanedUp, true);
    assert.ok(!fs.existsSync(outcome.worktreePath));
  });

  it('(2) two epic branches merge clean but the gate fails → union failure, exitCode 3', async () => {
    gitc(['checkout', '-q', '-b', 'epic/epic-a']);
    commitFile('a.txt', 'A\n', 'epic-a');
    gitc(['checkout', '-q', 'main']);
    gitc(['checkout', '-q', '-b', 'epic/epic-b']);
    commitFile('b.txt', 'B\n', 'epic-b');
    gitc(['checkout', '-q', 'main']);

    const before = refSnapshot();
    const outcome = await runCrossEpicGate(
      { projectRoot: repo },
      {
        gate: stubGate({ ok: false, summary: 'suite red' }),
        listEpicBranches: () => ['epic/epic-a', 'epic/epic-b'],
      }
    );

    assert.equal(outcome.exitCode, 3, 'a clean-merge-but-failing-suite is advisory exit 3');
    assert.equal(outcome.conflicts.length, 0, 'no conflicts — all merged clean');
    assert.equal(outcome.gate?.ok, false, 'the union gate result is carried through');
    assert.match(outcome.summary, /union suite failed/i);
    assert.deepEqual(refSnapshot(), before, 'no real ref moved');
    assert.equal(outcome.cleanedUp, true);
  });

  it('(3) two epic branches merge clean and the gate passes → exitCode 0', async () => {
    gitc(['checkout', '-q', '-b', 'epic/epic-a']);
    commitFile('a.txt', 'A\n', 'epic-a');
    gitc(['checkout', '-q', 'main']);
    gitc(['checkout', '-q', '-b', 'epic/epic-b']);
    commitFile('b.txt', 'B\n', 'epic-b');
    gitc(['checkout', '-q', 'main']);

    const before = refSnapshot();
    const outcome = await runCrossEpicGate(
      { projectRoot: repo },
      {
        gate: stubGate({ ok: true, summary: 'suite green' }),
        listEpicBranches: () => ['epic/epic-a', 'epic/epic-b'],
      }
    );

    assert.equal(outcome.exitCode, 0, 'clean merges + green suite is exit 0');
    assert.equal(outcome.conflicts.length, 0);
    assert.equal(outcome.gate?.ok, true);
    assert.deepEqual(refSnapshot(), before, 'no real ref moved');
    assert.equal(outcome.cleanedUp, true);
  });
});

describe('runCrossEpicGate — operational errors (exitCode 1, distinct from advisory 3)', () => {
  it('(4a) no epic branches found (empty glob + empty allowlist) → exitCode 1', async () => {
    // No epic/* branches exist; the real glob lister returns nothing.
    const outcome = await runCrossEpicGate({ projectRoot: repo }, { gate: stubGate() });
    assert.equal(outcome.exitCode, 1, 'zero epic branches is operational, not a clean pass');
    assert.equal(outcome.conflicts.length, 0);
    assert.equal(outcome.gate, undefined, 'no worktree, no gate run');
    assert.match(outcome.summary, /no epic branches/i);
    assert.equal(outcome.cleanedUp, true, 'nothing was created, so nothing leaked');
    assert.ok(!fs.existsSync(path.join(repo, '.loom', 'integration')));
  });

  it('(4b) worktree creation failure → exitCode 1', async () => {
    gitc(['checkout', '-q', '-b', 'epic/epic-a']);
    commitFile('a.txt', 'A\n', 'epic-a');
    gitc(['checkout', '-q', 'main']);

    // Pre-create a NON-EMPTY directory exactly where the worktree would go, so
    // `git worktree add` refuses (a real, deterministic creation failure).
    const wtPath = path.join(repo, '.loom', 'integration', `cross-epic-gate-${process.pid}`);
    fs.mkdirSync(wtPath, { recursive: true });
    fs.writeFileSync(path.join(wtPath, 'occupied'), 'blocker\n');

    let gateRan = false;
    const outcome = await runCrossEpicGate(
      { projectRoot: repo },
      {
        gate: { run: async () => { gateRan = true; return stubGate().run(); } },
        listEpicBranches: () => ['epic/epic-a'],
      }
    );

    assert.equal(outcome.exitCode, 1, 'a worktree that cannot be created is operational');
    assert.equal(gateRan, false, 'the gate is never reached when the worktree fails');
    assert.match(outcome.summary, /could not create the union worktree/i);

    fs.rmSync(wtPath, { recursive: true, force: true });
  });

  it('(4c) gate command unresolvable → exitCode 1 (distinct from advisory 3)', async () => {
    gitc(['checkout', '-q', '-b', 'epic/epic-a']);
    commitFile('a.txt', 'A\n', 'epic-a');
    gitc(['checkout', '-q', 'main']);
    gitc(['checkout', '-q', '-b', 'epic/epic-b']);
    commitFile('b.txt', 'B\n', 'epic-b');
    gitc(['checkout', '-q', 'main']);

    // A gate that found no command degrades to ran:false — for the cross-epic
    // probe that is operational (we cannot prove the union builds).
    const outcome = await runCrossEpicGate(
      { projectRoot: repo },
      {
        gate: stubGate({ ran: false, command: undefined, summary: 'No test command found.' }),
        listEpicBranches: () => ['epic/epic-a', 'epic/epic-b'],
      }
    );

    assert.equal(outcome.exitCode, 1, 'an unresolvable gate command is operational, not advisory');
    assert.notEqual(outcome.exitCode, 3, 'must be distinct from the advisory exit code');
    assert.match(outcome.summary, /could not resolve a test command/i);
    assert.equal(outcome.cleanedUp, true);
  });
});

describe('runCrossEpicGate — branch resolution', () => {
  it('(5) --epics allowlist resolves EXACTLY those branches, not the epic/* glob', async () => {
    // Three epic branches exist on disk; the allowlist names only two of them.
    for (const id of ['epic-a', 'epic-b', 'epic-c']) {
      gitc(['checkout', '-q', '-b', `epic/${id}`]);
      commitFile(`${id}.txt`, `${id}\n`, id);
      gitc(['checkout', '-q', 'main']);
    }

    const merged: string[] = [];
    const gate = {
      run: async (): Promise<GateOutcome> => stubGate().run(),
    };
    const outcome = await runCrossEpicGate(
      { projectRoot: repo, epics: ['epic-a', 'epic-c'] },
      {
        gate,
        // listEpicBranches must be IGNORED when an allowlist is present.
        listEpicBranches: () => {
          throw new Error('listEpicBranches must not be called when --epics is given');
        },
      }
    );

    // The clean-merge path ran the gate over exactly the two allowlisted epics.
    assert.equal(outcome.exitCode, 0);
    assert.match(outcome.summary, /All 2 epic branches/);
    void merged;
  });

  it('(5b) bare ids and already-prefixed ids both resolve; the allowlist beats the real glob', async () => {
    gitc(['checkout', '-q', '-b', 'epic/only']);
    commitFile('only.txt', 'only\n', 'only epic');
    gitc(['checkout', '-q', 'main']);
    // Another epic branch the glob WOULD pick up but the allowlist excludes.
    gitc(['checkout', '-q', '-b', 'epic/excluded']);
    commitFile('excluded.txt', 'x\n', 'excluded');
    gitc(['checkout', '-q', 'main']);

    const outcome = await runCrossEpicGate(
      { projectRoot: repo, epics: ['epic/only'] }, // already-prefixed form
      { gate: stubGate() }
    );
    assert.equal(outcome.exitCode, 0);
    assert.match(outcome.summary, /All 1 epic branches/);
  });
});

describe('runCrossEpicGate — cleanup is unconditional (real branches untouched)', () => {
  async function assertCleanedUp(outcome: { worktreePath: string; cleanedUp: boolean }): Promise<void> {
    assert.equal(outcome.cleanedUp, true, 'cleanedUp must be true on every path');
    assert.ok(!fs.existsSync(outcome.worktreePath), 'the worktree dir must be gone');
    assert.ok(
      !gitc(['worktree', 'list']).includes('cross-epic-gate-'),
      'no worktree admin record may leak'
    );
  }

  function seedTwoCleanEpics(): void {
    gitc(['checkout', '-q', '-b', 'epic/epic-a']);
    commitFile('a.txt', 'A\n', 'epic-a');
    gitc(['checkout', '-q', 'main']);
    gitc(['checkout', '-q', '-b', 'epic/epic-b']);
    commitFile('b.txt', 'B\n', 'epic-b');
    gitc(['checkout', '-q', 'main']);
  }

  it('(6) cleanup + untouched refs on the CLEAN path', async () => {
    seedTwoCleanEpics();
    const before = refSnapshot();
    const outcome = await runCrossEpicGate(
      { projectRoot: repo },
      { gate: stubGate({ ok: true }), listEpicBranches: () => ['epic/epic-a', 'epic/epic-b'] }
    );
    await assertCleanedUp(outcome);
    assert.deepEqual(refSnapshot(), before, 'CLEAN path leaves every ref byte-unchanged');
  });

  it('(6) cleanup + untouched refs on the CONFLICT path', async () => {
    gitc(['checkout', '-q', '-b', 'epic/epic-a']);
    commitFile('shared.txt', 'A\n', 'epic-a');
    gitc(['checkout', '-q', 'main']);
    gitc(['checkout', '-q', '-b', 'epic/epic-b']);
    commitFile('shared.txt', 'B\n', 'epic-b');
    gitc(['checkout', '-q', 'main']);

    const before = refSnapshot();
    const outcome = await runCrossEpicGate(
      { projectRoot: repo },
      { gate: stubGate(), listEpicBranches: () => ['epic/epic-a', 'epic/epic-b'] }
    );
    assert.equal(outcome.exitCode, 3);
    await assertCleanedUp(outcome);
    assert.deepEqual(refSnapshot(), before, 'CONFLICT path leaves every ref byte-unchanged');
  });

  it('(6) cleanup + untouched refs on the GATE-FAIL path', async () => {
    seedTwoCleanEpics();
    const before = refSnapshot();
    const outcome = await runCrossEpicGate(
      { projectRoot: repo },
      { gate: stubGate({ ok: false }), listEpicBranches: () => ['epic/epic-a', 'epic/epic-b'] }
    );
    assert.equal(outcome.exitCode, 3);
    await assertCleanedUp(outcome);
    assert.deepEqual(refSnapshot(), before, 'GATE-FAIL path leaves every ref byte-unchanged');
  });

  it('(6) cleanup + untouched refs even when the gate THROWS (then re-raises)', async () => {
    seedTwoCleanEpics();
    const before = refSnapshot();
    const wtPath = path.join(repo, '.loom', 'integration', `cross-epic-gate-${process.pid}`);

    // A real IntegrationGate whose injected runner throws — exercises the
    // unhappy branch where the worktree must still be reaped and re-raised.
    const throwingRunner: CommandRunner = () => {
      throw new Error('gate boom');
    };
    const gate = new IntegrationGate({ testCommand: 'anything', runner: throwingRunner });

    await assert.rejects(
      runCrossEpicGate(
        { projectRoot: repo, testCommand: 'anything' },
        { gate, listEpicBranches: () => ['epic/epic-a', 'epic/epic-b'] }
      ),
      /gate boom/
    );

    assert.ok(!fs.existsSync(wtPath), 'the worktree is force-removed even when the gate throws');
    assert.ok(!gitc(['worktree', 'list']).includes('cross-epic-gate-'));
    assert.deepEqual(refSnapshot(), before, 'a throwing gate still leaves every ref byte-unchanged');
  });
});

// ─── FR-11: EpicFinalizer cross-epic-gate hint ──────────────────────────────
// After recordPrUrl, when OTHER epic/* branches have open PRs, the finalizer
// prints a one-line hint naming `loom doctor --cross-epic-gate`; when none do,
// no hint. The open-PR probe is injectable so no real `gh` / network runs.

function story(id: string, deps: string[] = []): Story {
  return {
    id,
    title: `Story ${id} title`,
    description: 'Implement the thing.',
    acceptance_criteria: ['it works'],
    estimated_complexity: 'small',
    dependencies: deps,
  };
}

/** Seeds an approved epic with one story and a base_sha so finalize can run. */
function seedFinalizableEpic(epicId: string, db: import('better-sqlite3').Database): void {
  const epicYaml = {
    epic_id: epicId,
    title: `Epic ${epicId} title`,
    status: 'planned',
    priority: 'must-have',
    prd_ref: 'x',
    requirements: ['FR-1'],
    stories: [story(`story-${epicId.split('-')[1]}-001`)],
  };
  const rel = `.loom/planning/${epicId}/epics/${epicId}.yaml`;
  const abs = path.join(repo, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, yaml.dump(epicYaml));
  const store = new EpicStore(db);
  store.create(epicId, epicYaml.title, rel);
  store.updateStatus(epicId, 'approved');
  store.updateBaseSha(epicId, gitc(['rev-parse', 'HEAD']));
}

function finalizerOpts(
  db: import('better-sqlite3').Database,
  over: Partial<EpicFinalizerOptions> = {}
): EpicFinalizerOptions {
  return {
    projectRoot: repo,
    db,
    allowedRemotes: ['https://example.com/**'],
    prStrategy: 'per-epic',
    integrationGate: 'off',
    pushBranch: () => ({ ok: true, output: 'pushed' }),
    openPr: () => 'https://example.com/acme/loom/pull/42',
    ...over,
  };
}

/** Captures console.log output for the duration of `fn`. */
async function captureStdout(fn: () => Promise<void>): Promise<string> {
  const lines: string[] = [];
  const orig = console.log;
  console.log = (...args: unknown[]) => {
    lines.push(args.map(String).join(' '));
  };
  try {
    await fn();
  } finally {
    console.log = orig;
  }
  return lines.join('\n');
}

describe('EpicFinalizer — FR-11 cross-epic-gate hint', () => {
  beforeEach(() => {
    resetDatabaseForTest();
  });
  afterEach(() => {
    resetDatabaseForTest();
  });

  function setupEpicForFinalize(epicId: string, db: import('better-sqlite3').Database): void {
    seedFinalizableEpic(epicId, db);
    gitc(['remote', 'add', 'origin', 'https://example.com/acme/loom.git']);
    const storyId = `story-${epicId.split('-')[1]}-001`;
    // A story branch with a commit so the finalizer has something to merge.
    gitc(['branch', `story/${storyId}`]);
    gitc(['checkout', '-q', `story/${storyId}`]);
    gitc(['commit', '--allow-empty', '-q', '-m', 'story work']);
    gitc(['checkout', '-q', 'main']);
    // Mark the story done.
    const agents = new AgentStore(db);
    const a = agents.create(epicId, storyId, 'one');
    agents.updateStatus(a.id, 'done');
  }

  it('prints a one-line hint naming `loom doctor --cross-epic-gate` when OTHER epic/* branches have open PRs', async () => {
    const db = openDatabase(path.join(repo, '.loom'));
    setupEpicForFinalize('epic-001', db);

    const out = await captureStdout(async () => {
      await new EpicFinalizer(
        finalizerOpts(db, {
          openEpicPrs: () => ['epic/epic-002', 'epic/epic-003'],
        })
      ).finalize('epic-001');
    });

    assert.match(out, /loom doctor --cross-epic-gate/, 'the hint must name the command');
    assert.match(out, /epic\/epic-002/, 'the sibling open-PR branches are named');
    // Exactly one hint line.
    const hintLines = out.split('\n').filter((l) => l.includes('loom doctor --cross-epic-gate'));
    assert.equal(hintLines.length, 1, 'the hint is a single line');
  });

  it('prints NO hint when there are no other epic/* branches with open PRs', async () => {
    const db = openDatabase(path.join(repo, '.loom'));
    setupEpicForFinalize('epic-001', db);

    const out = await captureStdout(async () => {
      await new EpicFinalizer(
        finalizerOpts(db, {
          openEpicPrs: () => [], // no sibling open PRs
        })
      ).finalize('epic-001');
    });

    assert.doesNotMatch(out, /loom doctor --cross-epic-gate/, 'no siblings ⇒ no hint');
  });

  it("excludes this epic's OWN branch from the sibling probe (no self-hint)", async () => {
    const db = openDatabase(path.join(repo, '.loom'));
    setupEpicForFinalize('epic-001', db);

    const out = await captureStdout(async () => {
      await new EpicFinalizer(
        finalizerOpts(db, {
          // The probe returns ONLY this epic's own branch → must be filtered out.
          openEpicPrs: (epicBranch) => [epicBranch],
        })
      ).finalize('epic-001');
    });

    assert.doesNotMatch(out, /loom doctor --cross-epic-gate/, 'the epic must not hint about itself');
  });
});
