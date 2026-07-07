import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import yaml from 'js-yaml';
import { openDatabase, resetDatabaseForTest } from '../../state/Database.js';
import { EpicStore } from '../../state/EpicStore.js';
import { AgentStore } from '../../state/AgentStore.js';
import { PolicyEngine } from '../../guardrails/PolicyEngine.js';
import { EpicFinalizer } from '../EpicFinalizer.js';
import type { Story } from '../../types.js';

// ─── epic-078 regression — policy.agents.test_commands must reach the gate ────
//
// The blocker this guards: story-078 wired the test_commands EXECUTION into
// IntegrationGate.run(), but the four CLI callers built EpicFinalizer without
// forwarding `policy.agents.test_commands`, so the configured suites never ran
// in production — a documented, doctor-blessed gate that silently no-op'd.
//
// This test drives the REAL chain end to end: a policy.yaml on disk →
// PolicyEngine.load → EpicFinalizer (no injected gate, so it builds a real
// IntegrationGate from opts) → finalize() → the matched command actually
// executes against the merged tree. A non-matching command is skipped. If any
// caller (or the finalizer→gate seam) stops forwarding test_commands, the
// sentinel is never written and this fails.

describe('test_commands wiring — policy → EpicFinalizer → real gate execution', () => {
  let repo: string;
  let prevLoomHome: string | undefined;
  let loomHomeDir: string;

  function gitc(args: string[], cwd = repo): string {
    return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
  }

  function storyObj(id: string): Story {
    return {
      id,
      title: `Story ${id}`,
      description: 'Touch the backend.',
      acceptance_criteria: ['it works'],
      estimated_complexity: 'small',
      dependencies: [],
    };
  }

  function seedApprovedEpic(epicId: string, stories: Story[]): void {
    const epicYaml = {
      epic_id: epicId,
      title: `Epic ${epicId}`,
      status: 'planned',
      priority: 'must-have',
      prd_ref: 'x',
      requirements: ['FR-1'],
      stories,
    };
    const rel = `.loom/planning/${epicId}/epics/${epicId}.yaml`;
    const abs = path.join(repo, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, yaml.dump(epicYaml));
    const db = openDatabase(path.join(repo, '.loom'));
    const store = new EpicStore(db);
    store.create(epicId, epicYaml.title, rel);
    store.updateStatus(epicId, 'approved');
  }

  beforeEach(() => {
    resetDatabaseForTest();
    prevLoomHome = process.env.LOOM_HOME;
    loomHomeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'loom-tcw-home-'));
    process.env.LOOM_HOME = loomHomeDir;
    repo = fs.mkdtempSync(path.join(os.tmpdir(), 'loom-tcw-'));
    gitc(['init', '-q']);
    gitc(['config', 'user.email', 'test@loom.dev']);
    gitc(['config', 'user.name', 'Loom Test']);
    gitc(['config', 'commit.gpgsign', 'false']);
    fs.mkdirSync(path.join(repo, 'backend'), { recursive: true });
    fs.writeFileSync(path.join(repo, 'backend', 'app.py'), 'x = 1\n');
    fs.mkdirSync(path.join(repo, '.loom'), { recursive: true });
    gitc(['add', '.']);
    gitc(['commit', '-q', '-m', 'initial']);
  });

  afterEach(() => {
    resetDatabaseForTest();
    fs.rmSync(repo, { recursive: true, force: true });
    fs.rmSync(loomHomeDir, { recursive: true, force: true });
    if (prevLoomHome === undefined) delete process.env.LOOM_HOME;
    else process.env.LOOM_HOME = prevLoomHome;
  });

  it('runs a path-matched test_commands entry and skips a non-matching one', async () => {
    const storyId = 'story-091-001';
    const epicId = 'epic-091';
    seedApprovedEpic(epicId, [storyObj(storyId)]);

    const db = openDatabase(path.join(repo, '.loom'));
    const epicStore = new EpicStore(db);
    const agentStore = new AgentStore(db);
    epicStore.updateBaseSha(epicId, gitc(['rev-parse', 'HEAD']));

    // Story branch modifies backend/app.py → changed path matches `backend/**`.
    gitc(['checkout', '-b', `story/${storyId}`]);
    fs.writeFileSync(path.join(repo, 'backend', 'app.py'), 'x = 2\n');
    gitc(['add', 'backend/app.py']);
    gitc(['commit', '-q', '-m', `${storyId}: bump backend`]);
    gitc(['checkout', '-']);

    const agent = agentStore.create(epicId, storyId, storyId);
    agentStore.updateStatus(agent.id, 'done');

    // Sentinels the gate commands write. Absolute paths so cwd is irrelevant.
    const backendSentinel = path.join(loomHomeDir, 'backend-ran');
    const frontendSentinel = path.join(loomHomeDir, 'frontend-ran');

    // policy.yaml with two entries: one matches the changed path, one does not.
    const policyYaml = {
      git: { allowed_remotes: [] },
      agents: {
        integration_gate: 'block',
        test_commands: [
          { name: 'backend', command: `touch ${backendSentinel}`, paths: ['backend/**'] },
          { name: 'frontend', command: `touch ${frontendSentinel}`, paths: ['frontend/**'] },
        ],
      },
    };
    fs.writeFileSync(path.join(repo, '.loom', 'policy.yaml'), yaml.dump(policyYaml));

    // Load policy the way the CLI does, then construct the finalizer the way the
    // FIXED CLI callers do — forwarding policy.agents.test_commands. No `gate`
    // injected, so EpicFinalizer builds a real IntegrationGate from these opts.
    const policy = PolicyEngine.load(path.join(repo, '.loom')).policyData;
    assert.ok(
      Array.isArray(policy.agents.test_commands) && policy.agents.test_commands.length === 2,
      'PolicyEngine must surface the two test_commands entries'
    );

    const finalizer = new EpicFinalizer({
      projectRoot: repo,
      db,
      allowedRemotes: [],
      prStrategy: 'per-epic',
      integrationGate: policy.agents.integration_gate,
      testCommands: policy.agents.test_commands,
      pushBranch: () => ({ ok: true, output: 'pushed' }),
      openPr: () => 'https://example.com/pull/1',
    });

    await finalizer.finalize(epicId);

    assert.ok(
      fs.existsSync(backendSentinel),
      'the backend entry matched the changed path and its command MUST have run'
    );
    assert.ok(
      !fs.existsSync(frontendSentinel),
      'the frontend entry matched nothing and MUST have been skipped'
    );
  });

  it('runs the smoke command forwarded from policy.agents.smoke_command (epic-079 regression)', async () => {
    // Guards the epic-079 blocker: smoke_command was implemented + tested at the
    // finalizer seam but never forwarded from the CLI callers, so the explicit
    // knob was dead in production. This drives policy.yaml → PolicyEngine →
    // EpicFinalizer (no injected gate or smokeRunner, so the REAL smoke executor
    // spawns the command) → finalize, and asserts the command physically ran.
    const storyId = 'story-091-001';
    const epicId = 'epic-091';
    seedApprovedEpic(epicId, [storyObj(storyId)]);

    const db = openDatabase(path.join(repo, '.loom'));
    const epicStore = new EpicStore(db);
    const agentStore = new AgentStore(db);
    epicStore.updateBaseSha(epicId, gitc(['rev-parse', 'HEAD']));

    gitc(['checkout', '-b', `story/${storyId}`]);
    fs.writeFileSync(path.join(repo, 'backend', 'app.py'), 'x = 2\n');
    gitc(['add', 'backend/app.py']);
    gitc(['commit', '-q', '-m', `${storyId}: bump backend`]);
    gitc(['checkout', '-']);

    const agent = agentStore.create(epicId, storyId, storyId);
    agentStore.updateStatus(agent.id, 'done');

    const smokeSentinel = path.join(loomHomeDir, 'smoke-ran');
    const policyYaml = {
      git: { allowed_remotes: [] },
      agents: { integration_gate: 'block', smoke_command: `touch ${smokeSentinel}` },
    };
    fs.writeFileSync(path.join(repo, '.loom', 'policy.yaml'), yaml.dump(policyYaml));

    const policy = PolicyEngine.load(path.join(repo, '.loom')).policyData;
    assert.equal(policy.agents.smoke_command, `touch ${smokeSentinel}`, 'policy must surface smoke_command');

    const finalizer = new EpicFinalizer({
      projectRoot: repo,
      db,
      allowedRemotes: [],
      prStrategy: 'per-epic',
      integrationGate: policy.agents.integration_gate,
      smokeCommand: policy.agents.smoke_command,
      smokeTimeoutMinutes: policy.agents.smoke_timeout_minutes,
      pushBranch: () => ({ ok: true, output: 'pushed' }),
      openPr: () => 'https://example.com/pull/1',
    });

    await finalizer.finalize(epicId);

    assert.ok(
      fs.existsSync(smokeSentinel),
      'the smoke command forwarded from policy MUST have physically executed'
    );
  });
});
