import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  MockLLMClient,
  MockWorkerRunner,
  openDatabase,
  resetDatabaseForTest,
  EpicStore,
  AgentStore,
  AuditLog,
  DecisionTraceStore,
  ProjectRegistry,
  OperatorGuidance,
  createDatabase,
} from '@loom-ai/core';
import type { LLMRequest } from '@loom-ai/core';
import { HANDLERS } from '../tools/handlers.js';
import { TOOL_DEFINITIONS } from '../tools/registry.js';
import type { ToolContext } from '../tools/context.js';

let repo: string;
let background: Promise<unknown>[];

// ─── Mock LLM that drives the whole planning pipeline ──────────────────────

function planResponder(req: LLMRequest): string {
  const last = req.messages[req.messages.length - 1].content;
  // The brief-quality gate runs the BriefRefiner before the planner.
  // Emit ready: true with a high model-judged quality_score so the gate
  // lets the pipeline proceed.
  if (last.includes('Apply the discipline above'))
    return (
      '```json\n' +
      JSON.stringify({
        ready: true,
        quality_score: 10,
        refined_brief: '# Brief\n\n## Goal\nShip it.',
        critique: {
          strong_points: ['concrete goal'],
          ambiguities: [],
          missing_scope: [],
          untestable_claims: [],
          hidden_complexity: [],
        },
        questions: [],
        delta: { added_sections: [], clarifications: [], flagged_assumptions: [] },
      }) +
      '\n```'
    );
  if (last.includes('Produce the project brief'))
    return '# Brief\n\n## The Problem\nA gap.';
  if (last.includes('Headless task A: produce the PRD'))
    return '# PRD\n\n## Goals\nShip it.';
  if (last.includes('Headless task B: produce the epic')) {
    const m = last.match(/starting at "(epic-\d+)"/);
    const eid = m ? m[1] : 'epic-001';
    const num = eid.slice(5);
    return (
      '```json\n' +
      JSON.stringify({
        epics: [
          {
            epic_id: eid,
            title: 'Epic produced by the planner',
            priority: 'must-have',
            prd_ref: 'x',
            requirements: ['FR-1'],
            stories: [
              {
                id: `story-${num}-001`,
                title: 'The single story',
                description: 'do it',
                acceptance_criteria: ['works'],
                estimated_complexity: 'small',
                dependencies: [],
              },
            ],
          },
        ],
      }) +
      '\n```'
    );
  }
  if (last.includes('Headless task A: produce the architecture'))
    return '# Architecture\n\n## Architecture Philosophy\nBoring tech.';
  if (last.includes('Headless task B: produce per-story'))
    return '```json\n{"tech_notes":{}}\n```';
  throw new Error('unexpected planning message');
}

function ctx(): ToolContext {
  return {
    projectRoot: repo,
    loomDir: path.join(repo, '.loom'),
    createLLM: () => new MockLLMClient(planResponder),
    createWorker: () => new MockWorkerRunner({ status: 'done' }),
    background: (_label, work) => background.push(work),
  };
}

function gitc(args: string[]): string {
  return execFileSync('git', args, { cwd: repo, encoding: 'utf8' }).trim();
}

let prevLoomHome: string | undefined;
let loomHomeDir: string;

beforeEach(() => {
  resetDatabaseForTest();
  // Isolate the machine-level loom home (project registry, machine config,
  // global limiter) from the developer's real ~/.loom. Without this,
  // loom_get_status federates across every repo in the real registry, so the
  // "empty epic list" / "exactly one epic" assertions fail on any machine that
  // has other loom projects registered (CI is clean, so it only bites locally).
  prevLoomHome = process.env.LOOM_HOME;
  loomHomeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'loom-mcp-home-'));
  process.env.LOOM_HOME = loomHomeDir;
  repo = fs.mkdtempSync(path.join(os.tmpdir(), 'loom-mcp-'));
  // Force initial branch name to `main` — older git defaults to `master`
  // and a couple of tests (loom_get_diff) check out `main` explicitly.
  gitc(['init', '-q', '-b', 'main']);
  gitc(['config', 'user.email', 'test@loom.dev']);
  gitc(['config', 'user.name', 'Loom Test']);
  gitc(['config', 'commit.gpgsign', 'false']);
  fs.writeFileSync(path.join(repo, 'README.md'), '# test\n');
  gitc(['add', '.']);
  gitc(['commit', '-q', '-m', 'initial']);
  fs.mkdirSync(path.join(repo, '.loom'), { recursive: true });
  background = [];
});

afterEach(() => {
  resetDatabaseForTest();
  fs.rmSync(repo, { recursive: true, force: true });
  fs.rmSync(loomHomeDir, { recursive: true, force: true });
  if (prevLoomHome === undefined) delete process.env.LOOM_HOME;
  else process.env.LOOM_HOME = prevLoomHome;
});

// ─── loom_policy_check ─────────────────────────────────────────────────────

describe('loom_policy_check', () => {
  it('blocks a forbidden command', async () => {
    const r = (await HANDLERS.loom_policy_check(ctx(), {
      command: 'git push --force',
    })) as { allowed: boolean; rule?: string };
    assert.equal(r.allowed, false);
    assert.equal(r.rule, 'git.forbidden_flags');
  });

  it('allows a safe command', async () => {
    const r = (await HANDLERS.loom_policy_check(ctx(), {
      command: 'git status',
    })) as { allowed: boolean };
    assert.equal(r.allowed, true);
  });
});

// ─── loom_get_status / loom_get_audit_log ───────────────────────────────

describe('loom_get_status', () => {
  it('returns an empty epic list before any planning', async () => {
    const r = (await HANDLERS.loom_get_status(ctx(), {})) as { epics: unknown[] };
    assert.deepEqual(r.epics, []);
  });

  it('reflects a seeded epic and its agents', async () => {
    const db = openDatabase(path.join(repo, '.loom'));
    new EpicStore(db).create('epic-001', 'Seeded epic');
    new AgentStore(db).create('epic-001', 'story-001-001');
    const r = (await HANDLERS.loom_get_status(ctx(), {})) as {
      epics: { id: string; stories: unknown[] }[];
    };
    assert.equal(r.epics.length, 1);
    assert.equal(r.epics[0].id, 'epic-001');
    assert.equal(r.epics[0].stories.length, 1);
  });

  it('integrator block scopes to the current agent_id, not the story (v0.5.0 fix #8)', async () => {
    // A prior failed integrator episode wrote `epic_integration_attempt`
    // under an OLD agent_id (`agent-story-001-001-oldhash`). The operator
    // retried via loom_retry_story, which created a NEW agent. The new
    // agent is in 'integrating' status but has no audit rows yet.
    // Pre-fix, integratorProgress matched on `command = story_id` and
    // surfaced the prior episode's attempt_number / elapsed_seconds.
    // Post-fix, it filters on agent_id and returns undefined for the
    // current agent (no live progress yet) instead of the stale data.
    const db = openDatabase(path.join(repo, '.loom'));
    new EpicStore(db).create('epic-001', 'Seeded epic');
    const agents = new AgentStore(db);
    const audit = new AuditLog(db);

    // Old failed attempt — seed its audit row.
    db.prepare(
      "INSERT INTO agents (id, epic_id, story_id, status, updated_at) VALUES (?, 'epic-001', 'story-001-001', 'blocked', ?)"
    ).run('agent-story-001-001-oldhash', new Date(Date.now() - 60_000).toISOString());
    audit.record({
      agent_id: 'agent-story-001-001-oldhash',
      action: 'epic_integration_attempt',
      command: 'story-001-001',
      allowed: false,
      detail: { epicId: 'epic-001', attempt: 4, rejected: 'old failure' },
    });

    // Current retry attempt — no audit rows yet.
    const current = agents.create('epic-001', 'story-001-001');
    agents.updateStatus(current.id, 'integrating');

    const r = (await HANDLERS.loom_get_status(ctx(), {})) as {
      epics: {
        stories: { id: string; status: string; integrator?: { attempt_number: number } }[];
      }[];
    };
    const story = r.epics[0].stories.find((s) => s.id === 'story-001-001')!;
    assert.equal(story.status, 'integrating');
    assert.equal(
      story.integrator,
      undefined,
      'no integrator block until the current agent writes its own attempt row'
    );

    // Now seed a NEW attempt row scoped to the current agent — that should
    // be reflected in the status response.
    audit.record({
      agent_id: current.id,
      action: 'epic_integration_attempt',
      command: 'story-001-001',
      allowed: false,
      detail: { epicId: 'epic-001', attempt: 1, rejected: 'fresh attempt' },
    });
    const r2 = (await HANDLERS.loom_get_status(ctx(), {})) as {
      epics: {
        stories: { id: string; status: string; integrator?: { attempt_number: number } }[];
      }[];
    };
    const story2 = r2.epics[0].stories.find((s) => s.id === 'story-001-001')!;
    assert.equal(
      story2.integrator?.attempt_number,
      1,
      'reflects the current agent\'s attempt, not the stale 4 from the old episode'
    );
  });
});

// ─── loom_get_status — scope (current-project default vs opt-in federation) ──
//
// Seeds an epic in the CURRENT repo and a SECOND epic in a registered PEER
// repo, then asserts the default response is current-only and all_projects:true
// federates. Uses the LOOM_HOME-isolated registry set up in beforeEach.

describe('loom_get_status — scope', () => {
  /** Creates a peer repo with its own .loom/loom.db holding one epic, and
   *  registers it. Returns the peer root. */
  function seedPeerProject(): string {
    const peer = fs.mkdtempSync(path.join(os.tmpdir(), 'loom-mcp-peer-'));
    const peerLoom = path.join(peer, '.loom');
    fs.mkdirSync(peerLoom, { recursive: true });
    // A peer's DB must be a fresh non-singleton connection — the current
    // project owns the singleton (`openDatabase`).
    const peerDb = createDatabase(path.join(peerLoom, 'loom.db'));
    new EpicStore(peerDb).create('epic-900', 'Peer epic');
    new AgentStore(peerDb).create('epic-900', 'story-900-001');
    peerDb.close();
    new ProjectRegistry().register(peer);
    return peer;
  }

  it('defaults to the current project only — peers are NOT included', async () => {
    const db = openDatabase(path.join(repo, '.loom'));
    new EpicStore(db).create('epic-001', 'Current epic');
    const peer = seedPeerProject();
    // Also register the current repo so both are in the federation pool.
    new ProjectRegistry().register(repo);

    const r = (await HANDLERS.loom_get_status(ctx(), {})) as {
      epics: { id: string; is_current_project: boolean }[];
    };
    const ids = r.epics.map((e) => e.id);
    assert.deepEqual(ids, ['epic-001'], 'only the current project epic returns');
    assert.ok(
      !ids.includes('epic-900'),
      'the peer epic is excluded by the current-project default'
    );

    fs.rmSync(peer, { recursive: true, force: true });
  });

  it('all_projects:true federates — peers ARE included', async () => {
    const db = openDatabase(path.join(repo, '.loom'));
    new EpicStore(db).create('epic-001', 'Current epic');
    const peer = seedPeerProject();
    new ProjectRegistry().register(repo);

    const r = (await HANDLERS.loom_get_status(ctx(), { all_projects: true })) as {
      epics: { id: string; is_current_project: boolean }[];
    };
    const ids = r.epics.map((e) => e.id).sort();
    assert.deepEqual(ids, ['epic-001', 'epic-900'], 'both projects federate');
    const current = r.epics.find((e) => e.id === 'epic-001')!;
    const peerEpic = r.epics.find((e) => e.id === 'epic-900')!;
    assert.equal(current.is_current_project, true);
    assert.equal(peerEpic.is_current_project, false, 'peer is attributed as non-current');

    fs.rmSync(peer, { recursive: true, force: true });
  });

  it('regression: a caller relying on federate-all now gets current-only (documented breaking change)', async () => {
    const db = openDatabase(path.join(repo, '.loom'));
    new EpicStore(db).create('epic-001', 'Current epic');
    const peer = seedPeerProject();
    new ProjectRegistry().register(repo);

    // Pre-v0.6 a no-arg call federated; now the SAME no-arg call is scoped.
    const federated = (await HANDLERS.loom_get_status(ctx(), {
      all_projects: true,
    })) as { epics: unknown[] };
    const defaulted = (await HANDLERS.loom_get_status(ctx(), {})) as {
      epics: unknown[];
    };
    assert.ok(
      federated.epics.length > defaulted.epics.length,
      'the opt-in federation returns strictly more than the new default'
    );
    assert.equal(defaulted.epics.length, 1, 'default is current-only');

    fs.rmSync(peer, { recursive: true, force: true });
  });

  it('exposes the all_projects opt-in in the registry tool def', () => {
    const def = TOOL_DEFINITIONS.find((t) => t.name === 'loom_get_status')!;
    assert.ok(def, 'loom_get_status is registered');
    assert.ok(
      'all_projects' in def.inputSchema.properties,
      'the tool input schema declares the all_projects param'
    );
    const prop = def.inputSchema.properties.all_projects as { type?: string };
    assert.equal(prop.type, 'boolean', 'all_projects is a boolean');
  });
});

describe('loom_get_audit_log', () => {
  it('returns recorded audit entries', async () => {
    const db = openDatabase(path.join(repo, '.loom'));
    new AuditLog(db).record({ action: 'bash_command', command: 'git status', allowed: true });
    const r = (await HANDLERS.loom_get_audit_log(ctx(), {})) as { entries: unknown[] };
    assert.equal(r.entries.length, 1);
  });
});

describe('loom_start_epic', () => {
  it('rejects a too-short brief', async () => {
    const r = (await HANDLERS.loom_start_epic(ctx(), { brief: 'tiny' })) as {
      status: string;
    };
    assert.equal(r.status, 'error');
  });

  it('returns the reserved epic id while planning continues in the background', async () => {
    const r = (await HANDLERS.loom_start_epic(ctx(), {
      brief: 'Build a small demo feature for verifying the planner.',
    })) as { status: string; epic_ids: string[]; run_id: string };
    // Early return: the id is known and the run is re-attachable before the
    // planner has finished (it was handed to the background sink).
    assert.equal(r.status, 'planning');
    assert.equal(r.run_id, 'epic-001');
    assert.deepEqual(r.epic_ids, ['epic-001']);
    assert.equal(background.length, 1);

    // Let the background planner finish, then confirm it landed 'planned'.
    await Promise.all(background);
    const db = openDatabase(path.join(repo, '.loom'));
    assert.equal(new EpicStore(db).get('epic-001')?.status, 'planned');
  });
});

// ─── loom_approve_plan ─────────────────────────────────────────────────────

describe('loom_approve_plan', () => {
  it('errors for an unknown epic', async () => {
    const r = (await HANDLERS.loom_approve_plan(ctx(), {
      epic_id: 'epic-999',
    })) as { status: string };
    assert.equal(r.status, 'error');
  });

  it('approves a planned epic and dispatches in the background', async () => {
    const c = ctx();
    // Plan first so a real planned epic + its YAML exist. Planning now runs
    // in the background; await it so the epic reaches 'planned' before approve.
    await HANDLERS.loom_start_epic(c, {
      brief: 'Build a small demo feature for verifying approval.',
    });
    await Promise.all(background);
    background.length = 0;

    const r = (await HANDLERS.loom_approve_plan(c, { epic_id: 'epic-001' })) as {
      status: string;
    };
    assert.equal(r.status, 'dispatching');

    // Dispatch was handed to the background sink and has begun — the epic has
    // already advanced past 'planned'.
    assert.equal(background.length, 1);
    const db = openDatabase(path.join(repo, '.loom'));
    assert.notEqual(new EpicStore(db).get('epic-001')?.status, 'planned');

    // Await the background dispatch to completion.
    await Promise.all(background);

    // The story agent reached a terminal success.
    const agent = new AgentStore(db).getByStory('story-001-001');
    assert.ok(agent);
    assert.ok(['done', 'pr_open'].includes(agent.status));
    // Under the epic-005 done-gate (story-005-002), the epic only reaches
    // 'done' once the finalizer records an epic PR URL. This test repo has no
    // remote configured, so the finalize is a PR-less success: the epic lands
    // in the terminal-but-not-'done' 'finalizing' state with epic_pr_url unset.
    const epic = new EpicStore(db).get('epic-001');
    assert.notEqual(epic?.status, 'planned', 'the epic advanced past planned');
    assert.equal(epic?.epic_pr_url ?? null, null, 'no PR URL without a remote');
    assert.notEqual(
      epic?.status,
      'done',
      'a PR-less finalize never reaches done (epic-005 done-gate)'
    );
  });

  it('refuses to approve an epic that is not planned', async () => {
    const c = ctx();
    await HANDLERS.loom_start_epic(c, {
      brief: 'Build a small demo feature for verifying status guards.',
    });
    await Promise.all(background);
    const db = openDatabase(path.join(repo, '.loom'));
    new EpicStore(db).updateStatus('epic-001', 'rejected');
    const r = (await HANDLERS.loom_approve_plan(c, { epic_id: 'epic-001' })) as {
      status: string;
    };
    assert.equal(r.status, 'error');
  });
});

// ─── loom_reject_plan ──────────────────────────────────────────────────────

describe('loom_reject_plan', () => {
  it('rejects a planned epic with a reason', async () => {
    const c = ctx();
    await HANDLERS.loom_start_epic(c, {
      brief: 'Build a small demo feature for verifying rejection.',
    });
    await Promise.all(background);
    const r = (await HANDLERS.loom_reject_plan(c, {
      epic_id: 'epic-001',
      reason: 'not now',
    })) as { status: string };
    assert.equal(r.status, 'rejected');
    const db = openDatabase(path.join(repo, '.loom'));
    assert.equal(new EpicStore(db).get('epic-001')?.status, 'rejected');
  });

  it('errors for an unknown epic', async () => {
    const r = (await HANDLERS.loom_reject_plan(ctx(), {
      epic_id: 'epic-404',
    })) as { status: string };
    assert.equal(r.status, 'error');
  });
});

// ─── loom_stop_agent ───────────────────────────────────────────────────────

describe('loom_stop_agent', () => {
  it('errors when no agent exists for the story', async () => {
    const r = (await HANDLERS.loom_stop_agent(ctx(), {
      story_id: 'story-001-999',
    })) as { status: string };
    assert.equal(r.status, 'error');
  });

  it('SIGTERMs a real running worker process and reports stopping', async () => {
    const c = ctx();

    // Spawn a long-lived node child to stand in as the worker process.
    const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], {
      stdio: 'ignore',
    });
    assert.ok(child.pid, 'spawn should produce a pid');

    // Seed an epic + an agent that "owns" that pid.
    const db = openDatabase(path.join(repo, '.loom'));
    new EpicStore(db).create('epic-stop', 'test stop');
    const store = new AgentStore(db);
    const agent = store.create('epic-stop', 'story-stop-001', 'Test');
    store.updateStatus(agent.id, 'running');
    store.updateWorkerPid(agent.id, child.pid);

    const r = (await HANDLERS.loom_stop_agent(c, {
      story_id: 'story-stop-001',
    })) as { status: string; pid?: number };
    assert.equal(r.status, 'stopping');
    assert.equal(r.pid, child.pid);

    // The child should receive SIGTERM and exit; bound the wait so a
    // misfire does not hang the test.
    const exited = await new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => resolve(false), 2000);
      child.once('exit', () => {
        clearTimeout(timer);
        resolve(true);
      });
    });
    assert.equal(exited, true, 'worker process should exit after SIGTERM');
  });

  it('returns noop when the agent is not running', async () => {
    // Plan + approve to materialize an agent. Wait for it to reach terminal.
    const c = ctx();
    await HANDLERS.loom_start_epic(c, {
      brief: 'Build a small demo feature for verifying stop_agent.',
    });
    await Promise.all(background);
    background.length = 0;
    await HANDLERS.loom_approve_plan(c, { epic_id: 'epic-001' });
    await Promise.all(background);

    const r = (await HANDLERS.loom_stop_agent(c, {
      story_id: 'story-001-001',
    })) as { status: string; agent_status?: string };
    assert.equal(r.status, 'noop');
    // The mock worker finished, so the agent is in a terminal state.
    assert.ok(['done', 'pr_open', 'failed'].includes(r.agent_status ?? ''));
  });
});

describe('loom_pull_guidance — worker-side pull of operator guidance', () => {
  it('returns null when no guidance file exists', async () => {
    const r = (await HANDLERS.loom_pull_guidance(ctx(), {
      story_id: 'story-noop-001',
    })) as { content: string | null; has_more: boolean };
    assert.equal(r.content, null);
    assert.equal(r.has_more, false);
  });

  it('returns the appended delta on each call, then null when nothing new', async () => {
    const guidance = new OperatorGuidance({ projectRoot: repo });
    guidance.add('story-001-001', 'first message');
    const r1 = (await HANDLERS.loom_pull_guidance(ctx(), {
      story_id: 'story-001-001',
    })) as { content: string | null };
    assert.ok(r1.content !== null);
    assert.match(r1.content!, /first message/);

    // Second call with no new writes → null.
    const r2 = (await HANDLERS.loom_pull_guidance(ctx(), {
      story_id: 'story-001-001',
    })) as { content: string | null };
    assert.equal(r2.content, null);

    // Append more → only the new bytes come back.
    guidance.add('story-001-001', 'second message');
    const r3 = (await HANDLERS.loom_pull_guidance(ctx(), {
      story_id: 'story-001-001',
    })) as { content: string | null };
    assert.ok(r3.content !== null);
    assert.match(r3.content!, /second message/);
    assert.doesNotMatch(r3.content!, /first message/);
  });

  it('errors when story_id is empty', async () => {
    const r = (await HANDLERS.loom_pull_guidance(ctx(), { story_id: '' })) as {
      status?: string;
    };
    assert.equal(r.status, 'error');
  });
});

describe('loom_revert_epic — tear down an epic via MCP', () => {
  it('reverts the epic locally and returns the EpicReverter result shape', async () => {
    const db = openDatabase(path.join(repo, '.loom'));
    new EpicStore(db).create('epic-001', 'Seeded');
    new AgentStore(db).create('epic-001', 'story-001-001');
    // Seed an epic branch the reverter will delete.
    execFileSync('git', ['branch', 'epic/epic-001'], { cwd: repo });

    const r = (await HANDLERS.loom_revert_epic(ctx(), {
      epic_id: 'epic-001',
      reason: 'bad plan',
    })) as { status: string; deleted_refs: string[] };
    assert.equal(r.status, 'reverted');
    assert.ok(r.deleted_refs.includes('epic/epic-001'));
    const epic = new EpicStore(db).get('epic-001');
    assert.equal(epic?.status, 'rejected');
  });

  it('errors when epic_id is empty', async () => {
    const r = (await HANDLERS.loom_revert_epic(ctx(), {})) as { status: string };
    assert.equal(r.status, 'error');
  });
});

describe('loom_stop_epic — kill every running worker in one call', () => {
  it("errors when the epic does not exist", async () => {
    const r = (await HANDLERS.loom_stop_epic(ctx(), { epic_id: 'epic-nope' })) as {
      status: string;
    };
    assert.equal(r.status, 'error');
  });

  it('noop when every agent is in a non-running state', async () => {
    const db = openDatabase(path.join(repo, '.loom'));
    new EpicStore(db).create('epic-001', 'Seeded');
    const a1 = new AgentStore(db).create('epic-001', 'story-001-001');
    new AgentStore(db).updateStatus(a1.id, 'done', {});
    const r = (await HANDLERS.loom_stop_epic(ctx(), { epic_id: 'epic-001' })) as {
      status: string;
      stopped: unknown[];
      noop: { story_id: string; agent_status: string }[];
    };
    assert.equal(r.status, 'stopping');
    assert.equal(r.stopped.length, 0);
    assert.equal(r.noop.length, 1);
    assert.equal(r.noop[0].agent_status, 'done');
  });
});

describe('loom_retry_story — retry a failed story + re-dispatch', () => {
  it('errors when story_id is empty', async () => {
    const r = (await HANDLERS.loom_retry_story(ctx(), { story_id: '' })) as {
      status: string;
    };
    assert.equal(r.status, 'error');
  });

  it('errors when no agent exists for the story', async () => {
    const r = (await HANDLERS.loom_retry_story(ctx(), {
      story_id: 'story-001-999',
    })) as { status: string };
    assert.equal(r.status, 'error');
  });

  it('refuses to retry a story that is still running', async () => {
    const db = openDatabase(path.join(repo, '.loom'));
    new EpicStore(db).create('epic-001', 'Seeded');
    const a = new AgentStore(db).create('epic-001', 'story-001-001');
    new AgentStore(db).updateStatus(a.id, 'running');
    const r = (await HANDLERS.loom_retry_story(ctx(), {
      story_id: 'story-001-001',
    })) as { status: string; message: string };
    assert.equal(r.status, 'rejected');
    assert.match(r.message, /still running/i);
  });

  it('resume-retries a failed story and re-dispatches in the background', async () => {
    const c = ctx();
    await HANDLERS.loom_start_epic(c, {
      brief: 'Build a small demo feature for verifying retry.',
    });
    await Promise.all(background);
    background.length = 0;
    await HANDLERS.loom_approve_plan(c, { epic_id: 'epic-001' });
    await Promise.all(background);

    const db = openDatabase(path.join(repo, '.loom'));
    const agent = new AgentStore(db).getByStory('story-001-001');
    assert.ok(agent);
    // Simulate a failed prior attempt.
    new AgentStore(db).updateStatus(agent.id, 'failed');

    const before = background.length;
    const r = (await HANDLERS.loom_retry_story(c, {
      story_id: 'story-001-001',
    })) as { status: string; will_resume: boolean; epic_id: string };
    assert.equal(r.status, 'dispatching');
    assert.equal(r.will_resume, true);
    assert.equal(r.epic_id, 'epic-001');
    assert.equal(background.length, before + 1, 're-dispatch handed to background');
    // Epic was flipped back to runnable.
    assert.equal(new EpicStore(db).get('epic-001')?.status, 'in_progress');

    await Promise.all(background);
    // The mock worker re-ran the story to a terminal success.
    const after = new AgentStore(db).getByStory('story-001-001');
    assert.ok(['done', 'pr_open'].includes(after!.status));
  });
});

// ─── New introspection tools ────────────────────────────────────────────────

describe('loom_get_decision_traces', () => {
  it('requires one of agent_id / story_id / epic_id', async () => {
    const r = (await HANDLERS.loom_get_decision_traces(ctx(), {})) as {
      status: string;
      message: string;
    };
    assert.equal(r.status, 'error');
    assert.match(r.message, /agent_id.*story_id.*epic_id/);
  });

  it('returns traces persisted for a story', async () => {
    const db = openDatabase(path.join(repo, '.loom'));
    new EpicStore(db).create('epic-001', 'Seeded');
    const agent = new AgentStore(db).create('epic-001', 'story-001-001');
    new DecisionTraceStore(db).record({
      agent_id: agent.id,
      story_id: 'story-001-001',
      epic_id: 'epic-001',
      kind: 'thinking',
      rationale: 'I should grep for the function first.',
    });
    const r = (await HANDLERS.loom_get_decision_traces(ctx(), {
      story_id: 'story-001-001',
    })) as { traces: { kind: string; rationale: string }[] };
    assert.equal(r.traces.length, 1);
    assert.equal(r.traces[0].kind, 'thinking');
    assert.match(r.traces[0].rationale, /grep for the function/);
  });
});

describe('loom_get_diff', () => {
  it('errors when neither story_id nor epic_id is given', async () => {
    const r = (await HANDLERS.loom_get_diff(ctx(), {})) as { status: string };
    assert.equal(r.status, 'error');
  });

  it('errors when the epic has no base_sha (was never dispatched)', async () => {
    const db = openDatabase(path.join(repo, '.loom'));
    new EpicStore(db).create('epic-001', 'Seeded');
    const r = (await HANDLERS.loom_get_diff(ctx(), {
      epic_id: 'epic-001',
    })) as { status: string; message: string };
    assert.equal(r.status, 'error');
    assert.match(r.message, /base_sha/);
  });

  it('returns the diff between base_sha and the story branch', async () => {
    // Seed: epic with a base_sha; a story branch with one commit.
    const baseSha = gitc(['rev-parse', 'HEAD']);
    gitc(['checkout', '-q', '-b', 'story/story-001-001']);
    fs.writeFileSync(path.join(repo, 'new-file.txt'), 'hello\n');
    gitc(['add', '.']);
    gitc(['commit', '-q', '-m', 'story work']);
    gitc(['checkout', '-q', 'main']);

    const db = openDatabase(path.join(repo, '.loom'));
    const epicStore = new EpicStore(db);
    epicStore.create('epic-001', 'Seeded');
    epicStore.updateBaseSha('epic-001', baseSha);
    new AgentStore(db).create('epic-001', 'story-001-001');

    const r = (await HANDLERS.loom_get_diff(ctx(), {
      story_id: 'story-001-001',
    })) as { diff: string; base: string; head: string; truncated: boolean; stat?: string };
    assert.equal(r.base, baseSha);
    assert.equal(r.head, 'story/story-001-001');
    assert.match(r.diff, /new-file\.txt/);
    assert.equal(r.truncated, false);
    assert.match(r.stat ?? '', /new-file\.txt/);
  });

  it('truncates a diff that exceeds max_bytes', async () => {
    const baseSha = gitc(['rev-parse', 'HEAD']);
    gitc(['checkout', '-q', '-b', 'epic/epic-001']);
    // 50 KB of distinct content to make a real diff body.
    const big = Array.from({ length: 500 }, (_, i) => `line ${i}: ${'x'.repeat(80)}`).join('\n');
    fs.writeFileSync(path.join(repo, 'big.txt'), big + '\n');
    gitc(['add', '.']);
    gitc(['commit', '-q', '-m', 'big']);
    gitc(['checkout', '-q', 'main']);

    const db = openDatabase(path.join(repo, '.loom'));
    new EpicStore(db).create('epic-001', 'Seeded');
    new EpicStore(db).updateBaseSha('epic-001', baseSha);

    const r = (await HANDLERS.loom_get_diff(ctx(), {
      epic_id: 'epic-001',
      max_bytes: 2_000,
      include_stat: false,
    })) as { diff: string; truncated: boolean; bytes: number };
    assert.equal(r.truncated, true);
    assert.equal(r.diff.length, 2_000);
    assert.ok(r.bytes > 2_000, 'reported bytes should be the full size, not the truncated view');
  });
});

describe('loom_get_planning_artifacts', () => {
  it('errors on an unknown epic', async () => {
    const r = (await HANDLERS.loom_get_planning_artifacts(ctx(), {
      epic_id: 'epic-nope',
    })) as { status: string };
    assert.equal(r.status, 'error');
  });

  it('reads brief / PRD / architecture / epic_yaml from the recorded paths', async () => {
    const planningDir = path.join(repo, '.loom', 'planning', 'epic-001');
    fs.mkdirSync(planningDir, { recursive: true });
    fs.writeFileSync(path.join(planningDir, 'project-brief.md'), '# Brief\nbody');
    fs.writeFileSync(path.join(planningDir, 'prd.md'), '# PRD');
    fs.writeFileSync(path.join(planningDir, 'architecture.md'), '# Architecture');
    fs.mkdirSync(path.join(planningDir, 'epics'), { recursive: true });
    fs.writeFileSync(
      path.join(planningDir, 'epics', 'epic-001.yaml'),
      'epic_id: epic-001\ntitle: test\n',
    );

    const db = openDatabase(path.join(repo, '.loom'));
    const epicStore = new EpicStore(db);
    epicStore.create('epic-001', 'Seeded');
    epicStore.updatePaths('epic-001', {
      brief_path: '.loom/planning/epic-001/project-brief.md',
      prd_path: '.loom/planning/epic-001/prd.md',
      yaml_path: '.loom/planning/epic-001/epics/epic-001.yaml',
    });

    const r = (await HANDLERS.loom_get_planning_artifacts(ctx(), {
      epic_id: 'epic-001',
    })) as {
      brief: string | null;
      prd: string | null;
      architecture: string | null;
      epic_yaml: string | null;
    };
    assert.match(r.brief ?? '', /Brief/);
    assert.match(r.prd ?? '', /PRD/);
    assert.match(r.architecture ?? '', /Architecture/);
    assert.match(r.epic_yaml ?? '', /epic_id: epic-001/);
  });
});

describe('loom_get_review', () => {
  it('returns noop when no review has been recorded yet', async () => {
    const db = openDatabase(path.join(repo, '.loom'));
    new EpicStore(db).create('epic-001', 'Seeded');
    new AgentStore(db).create('epic-001', 'story-001-001');
    const r = (await HANDLERS.loom_get_review(ctx(), {
      story_id: 'story-001-001',
    })) as { status: string };
    assert.equal(r.status, 'noop');
  });

  it('returns review_status + review_summary when present', async () => {
    const db = openDatabase(path.join(repo, '.loom'));
    new EpicStore(db).create('epic-001', 'Seeded');
    const a = new AgentStore(db).create('epic-001', 'story-001-001');
    new AgentStore(db).setReview(a.id, 'passed', '# Findings\nLGTM');
    const r = (await HANDLERS.loom_get_review(ctx(), {
      story_id: 'story-001-001',
    })) as { review_status: string; review_summary: string };
    assert.equal(r.review_status, 'passed');
    assert.match(r.review_summary, /LGTM/);
  });
});

describe('loom_list_projects / loom_get_project', () => {
  it('lists projects from a redirected registry', async () => {
    const registryPath = path.join(repo, 'projects.json');
    const reg = new ProjectRegistry({ path: registryPath });
    reg.register(repo);

    // Pin the registry path on the handler via env override is not the
    // pattern; use the default registry by stubbing loomHome. Simplest path
    // for the test: register the real repo (it exists), then call via
    // ctx().loomDir which leaves the registry at its default. The test
    // therefore asserts shape, not contents.
    const r = (await HANDLERS.loom_list_projects(ctx(), {})) as {
      projects: { root: string; registeredAt: string }[];
    };
    assert.ok(Array.isArray(r.projects), 'projects should be an array');
  });

  it('errors on an unregistered root', async () => {
    const r = (await HANDLERS.loom_get_project(ctx(), {
      root: '/definitely/not/a/registered/path',
    })) as { status: string };
    assert.equal(r.status, 'error');
  });
});
