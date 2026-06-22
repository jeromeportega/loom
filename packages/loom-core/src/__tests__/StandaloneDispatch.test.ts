/**
 * story-047-003: Standalone dispatch, single-PR finalize, and full provenance.
 *
 * Verifies that a standalone story container (kind='standalone') routes through
 * the UNMODIFIED Supervisor → WorktreeManager → IntegrationGate → EpicFinalizer
 * stack with identical observable behavior to an epic-parented story, using the
 * flat branch scheme (story/story-NNN) with no phantom epic id segment.
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import yaml from 'js-yaml';
import { openDatabase, resetDatabaseForTest } from '../state/Database.js';
import { EpicStore } from '../state/EpicStore.js';
import { AgentStore } from '../state/AgentStore.js';
import { AuditLog } from '../state/AuditLog.js';
import { DecisionTraceStore } from '../state/DecisionTraceStore.js';
import { Supervisor } from '../orchestrator/Supervisor.js';
import { MockWorkerRunner } from '../orchestrator/MockWorkerRunner.js';
import { EpicFinalizer } from '../orchestrator/EpicFinalizer.js';
import { IntegrationGate } from '../orchestrator/IntegrationGate.js';
import { WorktreeManager } from '../orchestrator/WorktreeManager.js';
import {
  standaloneStoryId,
  standaloneBranch,
} from '../intake/routing.js';
import { PolicyEngine } from '../guardrails/PolicyEngine.js';
import type Database from 'better-sqlite3';

// ─── helpers ──────────────────────────────────────────────────────────────────

let repo: string;

function gitc(args: string[], cwd = repo): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

/**
 * Seeds a standalone story container and returns the opened DB handle.
 *
 * Mirrors what Planner.runStandalone does for a successfully-planned brief:
 *  1. Writes the epic YAML file (one flat story-NNN entry)
 *  2. Creates epics row with kind='standalone'
 *  3. Sets yaml_path so Supervisor.loadStories() can read it
 *  4. Sets status='approved' so selectEpics() picks it up
 *
 * The agent row is intentionally NOT pre-seeded — Supervisor.taskFor() creates
 * it at dispatch time; any Planner-seeded pending agent row is bypassed because
 * taskFor only reuses rows already in a SUCCESS state.
 *
 * Returns the DB handle so callers share a single connection and avoid a
 * second openDatabase() call in the same test.
 */
function seedStandalone(epicId: string, storyId: string): Database.Database {
  const epicYaml = {
    epic_id: epicId,
    title: `Standalone ${storyId}`,
    status: 'planned',
    priority: 'must-have',
    prd_ref: 'brief',
    requirements: [],
    stories: [
      {
        id: storyId,
        title: `Story ${storyId}`,
        description: 'Implement the standalone thing.',
        acceptance_criteria: ['it works'],
        estimated_complexity: 'small',
        dependencies: [],
      },
    ],
  };

  const rel = `.loom/planning/${epicId}/epics/${epicId}.yaml`;
  const abs = path.join(repo, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, yaml.dump(epicYaml));

  const db = openDatabase(path.join(repo, '.loom'));
  const epicStore = new EpicStore(db);
  epicStore.createStandalone(epicId, epicYaml.title);
  epicStore.updatePaths(epicId, { yaml_path: rel });
  epicStore.updateStatus(epicId, 'approved');

  return db;
}

/** Worker that commits real work into its assigned worktree. */
function committingWorker(): MockWorkerRunner {
  return new MockWorkerRunner(async (a) => {
    execFileSync('git', ['commit', '--allow-empty', '-m', `${a.storyId}: standalone work`], {
      cwd: a.worktreePath,
    });
    return { status: 'done' as const, commitCount: 1, summary: 'ok', logTail: '' };
  });
}

beforeEach(() => {
  resetDatabaseForTest();
  repo = fs.mkdtempSync(path.join(os.tmpdir(), 'loom-sa-'));
  gitc(['init', '-q']);
  gitc(['config', 'user.email', 'test@loom.dev']);
  gitc(['config', 'user.name', 'Loom Test']);
  gitc(['config', 'commit.gpgsign', 'false']);
  fs.writeFileSync(path.join(repo, 'README.md'), '# test\n');
  gitc(['add', '.']);
  gitc(['commit', '-q', '-m', 'initial']);
});

afterEach(() => {
  fs.rmSync(repo, { recursive: true, force: true });
});

// ─── Unit: branch naming (AC2) ────────────────────────────────────────────────

describe('Standalone branch naming (AC2)', () => {
  it('standaloneStoryId derives flat story-NNN from epic-NNN', () => {
    assert.equal(standaloneStoryId('epic-047'), 'story-047');
    assert.equal(standaloneStoryId('epic-001'), 'story-001');
    assert.equal(standaloneStoryId('epic-123'), 'story-123');
  });

  it('standaloneBranch produces story/story-NNN — flat, no phantom epic segment', () => {
    assert.equal(standaloneBranch('story-047'), 'story/story-047');
    assert.equal(standaloneBranch('story-001'), 'story/story-001');
  });

  it('WorktreeManager.branchName agrees with standaloneBranch for a standalone story id', () => {
    const wtm = new WorktreeManager(repo);
    const storyId = standaloneStoryId('epic-001');
    // The WorktreeManager uses the generic `story/${storyId}` scheme, which
    // must equal what standaloneBranch produces — so the naming contract holds
    // through the unmodified WorktreeManager without any standalone-specific code.
    assert.equal(wtm.branchName(storyId), standaloneBranch(storyId));
    assert.equal(wtm.branchName(storyId), 'story/story-001');
  });

  it('standalone branch has no phantom epic id segment in the name', () => {
    const branch = standaloneBranch(standaloneStoryId('epic-001'));
    // Must NOT contain 'epic' or a second numeric group separated by '/'
    assert.doesNotMatch(branch, /epic/);
    assert.equal(branch, 'story/story-001');
  });
});

// ─── Integration: dispatch parity (AC1) ───────────────────────────────────────

describe('Standalone dispatch through unmodified Supervisor (AC1)', () => {
  it('dispatches a standalone story via the same worker/worktree flow as an epic-parented story', async () => {
    const db = seedStandalone('epic-001', 'story-001');

    const result = await new Supervisor({
      projectRoot: repo,
      db,
      worker: new MockWorkerRunner({ status: 'done' }),
      maxConcurrent: 1,
    }).run();

    assert.equal(result.storiesDone, 1, 'standalone story must complete');
    assert.equal(result.storiesFailed, 0);
  });

  it('dispatches to the correct flat story id (story-NNN, no phantom suffix)', async () => {
    const db = seedStandalone('epic-001', 'story-001');

    // Capture dispatched story ids via the callback form so tracking is explicit.
    const captured: string[] = [];
    const worker = new MockWorkerRunner(async (a) => {
      captured.push(a.storyId);
      return { status: 'done' as const, commitCount: 0, summary: 'ok', logTail: '' };
    });

    await new Supervisor({ projectRoot: repo, db, worker, maxConcurrent: 1 }).run();

    assert.equal(captured.length, 1, 'exactly one story dispatched');
    assert.equal(captured[0], 'story-001', 'dispatched story id must be flat');
  });

  it('creates the worktree at story/story-NNN — flat branch, no phantom epic segment', async () => {
    const db = seedStandalone('epic-001', 'story-001');

    let capturedWorktreePath = '';
    const worker = new MockWorkerRunner(async (a) => {
      capturedWorktreePath = a.worktreePath;
      return { status: 'done' as const, commitCount: 0, summary: 'ok', logTail: '' };
    });

    await new Supervisor({ projectRoot: repo, db, worker, maxConcurrent: 1 }).run();

    // Worktree directory name is the story id (WorktreeManager.worktreePath)
    assert.ok(
      capturedWorktreePath.endsWith('story-001'),
      `worktree path must end in story-001, got ${capturedWorktreePath}`
    );
    // Branch recorded on agent after dispatch
    const agent = new AgentStore(db).getByStory('story-001');
    assert.ok(agent, 'agent row must exist for story-001');
    assert.equal(agent.branch_name, 'story/story-001', 'agent branch_name must be the flat scheme');
  });

  it('standalone container is selected by Supervisor without any kind-specific code path', async () => {
    // A regular epic and a standalone container must both appear in epicsProcessed
    // after a run — the Supervisor's selectEpics() does not filter by kind.
    const epicYamlReg = {
      epic_id: 'epic-001',
      title: 'Regular epic',
      status: 'planned',
      priority: 'must-have',
      prd_ref: 'x',
      requirements: [],
      stories: [
        {
          id: 'story-001-001',
          title: 'Regular story',
          description: 'Do it.',
          acceptance_criteria: ['done'],
          estimated_complexity: 'small',
          dependencies: [],
        },
      ],
    };
    const relReg = '.loom/planning/epic-001/epics/epic-001.yaml';
    const absReg = path.join(repo, relReg);
    fs.mkdirSync(path.dirname(absReg), { recursive: true });
    fs.writeFileSync(absReg, yaml.dump(epicYamlReg));

    // Open DB via seedStandalone so there is a single connection in this test.
    const db = seedStandalone('epic-002', 'story-002');
    const epicStore = new EpicStore(db);
    epicStore.create('epic-001', epicYamlReg.title, relReg);
    epicStore.updateStatus('epic-001', 'approved');

    const worker = new MockWorkerRunner({ status: 'done' });
    const result = await new Supervisor({ projectRoot: repo, db, worker, maxConcurrent: 2 }).run();

    assert.ok(result.epicsProcessed.includes('epic-001'), 'regular epic processed');
    assert.ok(result.epicsProcessed.includes('epic-002'), 'standalone container processed');
    assert.equal(result.storiesDone, 2, 'both stories completed');
  });
});

// ─── Integration: single PR finalize (AC3) ────────────────────────────────────

describe('Standalone single-PR finalize (AC3)', () => {
  /**
   * Sets up a bare git repo as a fake remote so the EpicFinalizer can reach
   * the push + openPr path.  Without a remote `defaultRemote()` returns null
   * and finalize returns early before calling openPr.
   *
   * Uses 'file://**' as the allowedRemotes glob — explicitly matching the
   * file:// scheme so the minimatch call in EpicFinalizer.remoteAllowed()
   * is unambiguous about which pattern is being exercised.
   */
  function addFakeRemote(): string {
    const bare = fs.mkdtempSync(path.join(os.tmpdir(), 'loom-bare-'));
    execFileSync('git', ['init', '--bare', '-q'], { cwd: bare });
    gitc(['remote', 'add', 'origin', `file://${bare}`]);
    return bare;
  }

  it('EpicFinalizer opens exactly one pull request for a standalone story container', async () => {
    const bare = addFakeRemote();
    try {
      const db = seedStandalone('epic-001', 'story-001');

      let prCount = 0;
      const finalizer = new EpicFinalizer({
        projectRoot: repo,
        db,
        // 'file://**' explicitly matches file:// remote URLs created by addFakeRemote.
        allowedRemotes: ['file://**'],
        prStrategy: 'per-epic',
        pushBranch: (_remote, _branch) => ({ ok: true, output: '' }),
        openPr: (_input) => {
          prCount++;
          return `https://github.com/example/pr/${prCount}`;
        },
      });

      await new Supervisor({
        projectRoot: repo,
        db,
        worker: committingWorker(),
        maxConcurrent: 1,
        epicFinalizer: finalizer,
      }).run();

      assert.equal(prCount, 1, 'exactly one PR must be opened for a standalone story container');
    } finally {
      fs.rmSync(bare, { recursive: true, force: true });
    }
  });

  it('the epic branch created for a standalone container carries the story work', async () => {
    const db = seedStandalone('epic-001', 'story-001');

    await new Supervisor({
      projectRoot: repo,
      db,
      worker: committingWorker(),
      maxConcurrent: 1,
      epicFinalizer: new EpicFinalizer({
        projectRoot: repo,
        db,
        allowedRemotes: [],
        prStrategy: 'per-epic',
      }),
    }).run();

    // The epic branch must exist and carry the merge commit for the lone story.
    const epicSha = gitc(['rev-parse', 'refs/heads/epic/epic-001']);
    assert.ok(epicSha.length > 0, 'epic/epic-001 branch must be created by the finalizer');
    const log = gitc(['log', '--oneline', 'epic/epic-001']);
    assert.match(log, /story-001/, 'epic branch log must reference the standalone story');
  });
});

// ─── Integration: provenance write-through (AC4) ──────────────────────────────

describe('Standalone provenance parity (AC4)', () => {
  it('writes an audit_log dispatch row keyed to the flat story id and the agent_id', async () => {
    const db = seedStandalone('epic-001', 'story-001');

    await new Supervisor({
      projectRoot: repo,
      db,
      worker: new MockWorkerRunner({ status: 'done' }),
      maxConcurrent: 1,
    }).run();

    const audit = new AuditLog(db);
    const agent = new AgentStore(db).getByStory('story-001');
    assert.ok(agent, 'agent row must exist for story-001');

    // The dispatch row has both agent_id and command set, same as an epic-parented story.
    const rows = audit.getByStory('story-001');
    const dispatch = rows.find((r) => r.action === 'dispatch');
    assert.ok(dispatch, 'audit_log must have a dispatch row for the standalone story');
    assert.equal(dispatch!.command, 'story-001', 'dispatch command must be the flat story id');
    assert.equal(dispatch!.agent_id, agent!.id, 'dispatch agent_id must match the agent record');
  });

  it('writes decision_traces with the correct epic_id and story_id for a standalone run', async () => {
    const db = seedStandalone('epic-001', 'story-001');

    const worker = new MockWorkerRunner(async (a) => {
      a.onTrace?.({ kind: 'thinking', rationale: 'Standalone story reasoning.' });
      a.onTrace?.({ kind: 'tool_intent', subject: 'Bash', rationale: 'Running build command.' });
      return { status: 'done' as const, commitCount: 0, summary: 'ok', logTail: '' };
    });

    await new Supervisor({ projectRoot: repo, db, worker, maxConcurrent: 1 }).run();

    const traces = new DecisionTraceStore(db).getByStory('story-001');
    assert.equal(traces.length, 2, 'both emitted traces must be persisted');
    assert.equal(traces[0].kind, 'thinking');
    assert.match(traces[0].rationale, /Standalone story reasoning/);
    assert.equal(traces[1].kind, 'tool_intent');
    assert.equal(traces[1].subject, 'Bash');

    // Traces must carry the correct container epic_id — same provenance shape
    // as an epic-parented story.
    assert.equal(traces[0].epic_id, 'epic-001', 'trace epic_id must be the container epic id');
    assert.equal(traces[0].story_id, 'story-001', 'trace story_id must be the flat story id');
  });

  it('decision_traces queryable by agent_id as well as story_id', async () => {
    const db = seedStandalone('epic-001', 'story-001');

    const worker = new MockWorkerRunner(async (a) => {
      a.onTrace?.({ kind: 'thinking', rationale: 'Agent-keyed trace.' });
      return { status: 'done' as const, commitCount: 0, summary: 'ok', logTail: '' };
    });

    await new Supervisor({ projectRoot: repo, db, worker, maxConcurrent: 1 }).run();

    const agent = new AgentStore(db).getByStory('story-001');
    assert.ok(agent, 'agent must exist');
    const byAgent = new DecisionTraceStore(db).getByAgent(agent!.id);
    assert.ok(byAgent.length >= 1, 'traces must be queryable by agent_id');
    assert.equal(byAgent[0].agent_id, agent!.id);
  });

  it('audit_log rows are queryable by agent_id for a standalone story', async () => {
    const db = seedStandalone('epic-001', 'story-001');

    await new Supervisor({
      projectRoot: repo,
      db,
      worker: new MockWorkerRunner({ status: 'done' }),
      maxConcurrent: 1,
    }).run();

    const agent = new AgentStore(db).getByStory('story-001');
    assert.ok(agent, 'agent must exist');
    const auditByAgent = new AuditLog(db).getByAgent(agent!.id);
    assert.ok(auditByAgent.length >= 1, 'audit rows must be queryable by agent_id');
    const dispatchRow = auditByAgent.find((r) => r.action === 'dispatch');
    assert.ok(dispatchRow, 'dispatch audit row must appear in getByAgent results');
  });
});

// ─── Integration: guardrail parity (AC5) ──────────────────────────────────────

describe('Guardrail parity for standalone stories (AC5)', () => {
  it('PolicyEngine.check exits non-zero for a forbidden command — invariant 1 is structural', () => {
    const engine = new PolicyEngine(PolicyEngine.defaultPolicy());
    // The guard must block force-push regardless of whether the caller is a
    // standalone story or an epic-parented story — no kind discrimination.
    const r = engine.check('git push --force');
    assert.equal(r.allowed, false, 'force push must be forbidden by the policy engine');
    assert.equal(r.rule, 'git.forbidden_flags');
  });

  it('allowed_remotes gate blocks push for a standalone container (policy.git.allowed_remotes)', async () => {
    const db = seedStandalone('epic-001', 'story-001');

    // EpicFinalizer with an empty allowedRemotes list — any push attempt is blocked.
    let pushAttempted = false;
    const finalizer = new EpicFinalizer({
      projectRoot: repo,
      db,
      allowedRemotes: [],
      prStrategy: 'per-epic',
      pushBranch: (_remote, _branch) => {
        pushAttempted = true;
        return { ok: false, output: 'remote not allowed' };
      },
      openPr: (_input) => {
        throw new Error('openPr must not be called when push is blocked by allowedRemotes');
      },
    });

    await new Supervisor({
      projectRoot: repo,
      db,
      worker: committingWorker(),
      maxConcurrent: 1,
      epicFinalizer: finalizer,
    }).run();

    // The finalizer never calls pushBranch when allowedRemotes is empty —
    // the gate is enforced structurally before any network call.
    assert.equal(pushAttempted, false, 'push must not be attempted when allowedRemotes is empty');
    // The epic branch is built locally but no PR is opened.
    const epicSha = gitc(['rev-parse', 'refs/heads/epic/epic-001']);
    assert.ok(epicSha.length > 0, 'epic branch must still be built locally');
  });
});

// ─── Integration: integration gate parity (AC5, NFR-2) ────────────────────────

describe('Integration gate parity for standalone stories (AC5)', () => {
  function redGate(): IntegrationGate {
    return new IntegrationGate({
      testCommand: 'run-tests',
      runner: () => ({
        exitCode: 1,
        output: 'test suite failed',
        timedOut: false,
        durationMs: 5,
      }),
    });
  }

  it('block-mode gate withholds the PR and records an audit row for a standalone story', async () => {
    const db = seedStandalone('epic-001', 'story-001');

    await new Supervisor({
      projectRoot: repo,
      db,
      worker: committingWorker(),
      maxConcurrent: 1,
      epicFinalizer: new EpicFinalizer({
        projectRoot: repo,
        db,
        allowedRemotes: [],
        prStrategy: 'per-epic',
        integrationGate: 'block',
        gate: redGate(),
      }),
    }).run();

    // Gate blocked → epic flipped back to in_progress (same as an epic-parented story).
    const epic = new EpicStore(db).get('epic-001');
    assert.equal(epic?.status, 'in_progress', 'blocked standalone container must revert to in_progress');

    // Gate result is durably recorded keyed by the container epic id.
    const row = new AuditLog(db).latestActionByCommand('epic-001', ['epic_integration_gate']);
    assert.ok(row, 'expected an epic_integration_gate audit row for the standalone container');
    assert.equal(JSON.parse(row!.detail ?? '{}').ok, false, 'gate audit detail must record ok=false');
  });

  it('warn-mode gate records the failure but does not block finalization', async () => {
    const db = seedStandalone('epic-001', 'story-001');

    await new Supervisor({
      projectRoot: repo,
      db,
      worker: committingWorker(),
      maxConcurrent: 1,
      epicFinalizer: new EpicFinalizer({
        projectRoot: repo,
        db,
        allowedRemotes: [],
        prStrategy: 'per-epic',
        integrationGate: 'warn',
        gate: redGate(),
      }),
    }).run();

    // Warn never blocks — finalization proceeds past the gate.
    const epic = new EpicStore(db).get('epic-001');
    assert.notEqual(epic?.status, 'in_progress', 'warn mode must NOT block the standalone finalize');

    const row = new AuditLog(db).latestActionByCommand('epic-001', ['epic_integration_gate']);
    assert.ok(row, 'gate audit row must still be written in warn mode');
  });
});
