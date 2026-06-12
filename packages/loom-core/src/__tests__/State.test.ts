import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDatabase, resetDatabaseForTest } from '../state/Database.js';
import { EpicStore } from '../state/EpicStore.js';
import { AgentStore } from '../state/AgentStore.js';
import { AuditLog } from '../state/AuditLog.js';
import { ControlStore } from '../state/ControlStore.js';

let tmpDir: string;

before(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'loom-test-'));
  resetDatabaseForTest();
});

after(() => {
  resetDatabaseForTest();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ─── AgentStore: epics ────────────────────────────────────────────────────

describe('EpicStore', () => {
  it('creates an epic and retrieves it', () => {
    const db = openDatabase(tmpDir);
    const store = new EpicStore(db);

    const epic = store.create('epic-001', 'Test Epic', 'epics/epic-001.yaml');
    assert.equal(epic.id, 'epic-001');
    assert.equal(epic.title, 'Test Epic');
    assert.equal(epic.status, 'planned');
    assert.equal(epic.yaml_path, 'epics/epic-001.yaml');
  });

  it('retrieves an epic by ID', () => {
    const db = openDatabase(tmpDir);
    const store = new EpicStore(db);
    const found = store.get('epic-001');
    assert.ok(found);
    assert.equal(found.title, 'Test Epic');
  });

  it('returns undefined for unknown epic ID', () => {
    const db = openDatabase(tmpDir);
    const store = new EpicStore(db);
    assert.equal(store.get('epic-999'), undefined);
  });

  it('lists epics in descending creation order', () => {
    const db = openDatabase(tmpDir);
    const store = new EpicStore(db);
    store.create('epic-002', 'Second Epic');
    const epics = store.list();
    assert.ok(epics.length >= 2);
    // epic-002 created after epic-001, so it should appear first (DESC order)
    assert.equal(epics[0].id, 'epic-002');
  });

  it('updates epic status to approved', () => {
    const db = openDatabase(tmpDir);
    const store = new EpicStore(db);
    store.updateStatus('epic-001', 'approved');
    const epic = store.get('epic-001');
    assert.equal(epic?.status, 'approved');
  });

  it('updates epic status to rejected with reason', () => {
    const db = openDatabase(tmpDir);
    const store = new EpicStore(db);
    store.updateStatus('epic-002', 'rejected', 'Scope too large');
    const epic = store.get('epic-002');
    assert.equal(epic?.status, 'rejected');
    assert.equal(epic?.reason, 'Scope too large');
  });

  it('filters epics by status', () => {
    const db = openDatabase(tmpDir);
    const store = new EpicStore(db);
    const approved = store.listByStatus('approved');
    assert.ok(approved.length >= 1);
    assert.ok(approved.every((e) => e.status === 'approved'));
  });

  it('archives an epic: hidden from list() but kept and gettable', () => {
    const db = openDatabase(tmpDir);
    const store = new EpicStore(db);
    store.create('epic-900', 'Archivable Epic');

    assert.equal(store.archive('epic-900'), true);

    // Excluded from the default list…
    assert.ok(!store.list().some((e) => e.id === 'epic-900'));
    // …but still present with the flag set, and gettable by id.
    assert.ok(store.list({ includeArchived: true }).some((e) => e.id === 'epic-900'));
    const got = store.get('epic-900');
    assert.ok(got);
    assert.ok(got.archived_at, 'archived_at should be set');
    // And surfaced by the dedicated archive view.
    assert.ok(store.listArchived().some((e) => e.id === 'epic-900'));
  });

  it('excludes archived epics from listByStatus unless asked', () => {
    const db = openDatabase(tmpDir);
    const store = new EpicStore(db);
    store.create('epic-901', 'Archivable Approved');
    store.updateStatus('epic-901', 'approved');
    store.archive('epic-901');

    const approved = store.listByStatus('approved');
    assert.ok(!approved.some((e) => e.id === 'epic-901'));
    const withArchived = store.listByStatus('approved', { includeArchived: true });
    assert.ok(withArchived.some((e) => e.id === 'epic-901'));
  });

  it('unarchives an epic back into the default views', () => {
    const db = openDatabase(tmpDir);
    const store = new EpicStore(db);
    // Self-contained setup (PR #55 review fix): create + archive INSIDE this
    // test so unarchive is verified end-to-end. Previously this test reused
    // 'epic-900' from the preceding archive test — a failure between create
    // and archive in that test would make this one pass vacuously (no-op
    // unarchive plus a null archived_at satisfies every assertion).
    store.create('epic-902', 'Round-trip archive');
    store.archive('epic-902');
    assert.ok(store.get('epic-902')?.archived_at, 'precondition: archived');

    assert.equal(store.unarchive('epic-902'), true);
    assert.ok(store.list().some((e) => e.id === 'epic-902'));
    assert.equal(store.get('epic-902')?.archived_at, null);
    assert.ok(!store.listArchived().some((e) => e.id === 'epic-902'));
  });

  it('archive/unarchive return false for an unknown epic', () => {
    const db = openDatabase(tmpDir);
    const store = new EpicStore(db);
    assert.equal(store.archive('epic-does-not-exist'), false);
    assert.equal(store.unarchive('epic-does-not-exist'), false);
  });
});

// ─── AgentStore: agents ───────────────────────────────────────────────────

describe('AgentStore', () => {
  it('creates an agent and retrieves it', () => {
    const db = openDatabase(tmpDir);
    const store = new AgentStore(db);
    const agent = store.create('epic-001', 'story-001-001');
    assert.ok(agent.id.startsWith('agent-story-001-001-'));
    assert.equal(agent.epic_id, 'epic-001');
    assert.equal(agent.story_id, 'story-001-001');
    assert.equal(agent.status, 'pending');
  });

  it('stores the story title when one is given', () => {
    const db = openDatabase(tmpDir);
    const store = new AgentStore(db);
    const agent = store.create('epic-001', 'story-001-title', 'Add the login endpoint');
    assert.equal(agent.story_title, 'Add the login endpoint');
  });

  it('updates agent status to running with worktree and branch', () => {
    const db = openDatabase(tmpDir);
    const store = new AgentStore(db);
    const agent = store.create('epic-001', 'story-001-002');
    store.updateStatus(agent.id, 'running', {
      worktree_path: '.loom/worktrees/story-001-002',
      branch_name: 'story/story-001-002',
      started_at: new Date().toISOString(),
    });
    const updated = store.get(agent.id);
    assert.equal(updated?.status, 'running');
    assert.equal(updated?.worktree_path, '.loom/worktrees/story-001-002');
    assert.equal(updated?.branch_name, 'story/story-001-002');
  });

  it('updates agent status to pr_open with pr_url', () => {
    const db = openDatabase(tmpDir);
    const store = new AgentStore(db);
    const agent = store.create('epic-001', 'story-001-003');
    store.updateStatus(agent.id, 'pr_open', {
      pr_url: 'https://github.com/myorg/repo/pull/42',
    });
    const updated = store.get(agent.id);
    assert.equal(updated?.status, 'pr_open');
    assert.equal(updated?.pr_url, 'https://github.com/myorg/repo/pull/42');
  });

  it('lists agents for an epic', () => {
    const db = openDatabase(tmpDir);
    const store = new AgentStore(db);
    const agents = store.listByEpic('epic-001');
    assert.ok(agents.length >= 3);
    assert.ok(agents.every((a) => a.epic_id === 'epic-001'));
  });

  it('finds agent by story ID', () => {
    const db = openDatabase(tmpDir);
    const store = new AgentStore(db);
    const found = store.getByStory('story-001-001');
    assert.ok(found);
    assert.equal(found.story_id, 'story-001-001');
  });
});

// ─── AuditLog ─────────────────────────────────────────────────────────────

describe('AuditLog', () => {
  it('records a blocked command and retrieves it', () => {
    const db = openDatabase(tmpDir);
    const audit = new AuditLog(db);
    audit.record({
      action: 'bash_command',
      command: 'git push --force',
      allowed: false,
      policy_rule: 'git.forbidden_flags',
    });
    const entries = audit.recent(1);
    assert.equal(entries.length, 1);
    assert.equal(entries[0].command, 'git push --force');
    assert.equal(entries[0].allowed, 0); // SQLite stores booleans as 0/1
    assert.equal(entries[0].policy_rule, 'git.forbidden_flags');
  });

  it('records an allowed command', () => {
    const db = openDatabase(tmpDir);
    const audit = new AuditLog(db);
    audit.record({
      action: 'bash_command',
      command: 'git add .',
      allowed: true,
    });
    // Use FTS search to find specifically this entry rather than relying on insertion order
    const results = audit.search('add');
    const entry = results.find((e) => e.command === 'git add .');
    assert.ok(entry, 'expected entry for "git add ." to exist');
    assert.equal(entry!.allowed, 1);
  });

  it('retrieves entries for a specific agent', () => {
    const db = openDatabase(tmpDir);
    const store = new AgentStore(db);
    const audit = new AuditLog(db);
    const agent = store.create('epic-001', 'story-001-audit');
    audit.record({ agent_id: agent.id, action: 'bash_command', command: 'npm test', allowed: true });
    audit.record({ agent_id: agent.id, action: 'bash_command', command: 'git push --force', allowed: false });
    const entries = audit.getByAgent(agent.id);
    assert.equal(entries.length, 2);
    assert.ok(entries.every((e) => e.agent_id === agent.id));
  });

  it('searches audit log via FTS5', () => {
    const db = openDatabase(tmpDir);
    const audit = new AuditLog(db);
    audit.record({ action: 'bash_command', command: 'git push --force-with-lease', allowed: false });
    const results = audit.search('force');
    assert.ok(results.length >= 1);
    assert.ok(results.some((r) => r.command?.includes('force')));
  });

  // (filled in below)
  it('getByCommand filters by command and optional action list (chronological)', () => {
    const db = openDatabase(tmpDir);
    const audit = new AuditLog(db);
    audit.record({ action: 'skill_generated', command: 'jwt-auth', detail: { lifecycle: 'candidate' } });
    audit.record({ action: 'skill_lifecycle_change', command: 'jwt-auth', detail: { from: 'candidate', to: 'active', reason: 'good' } });
    audit.record({ action: 'skill_generated', command: 'other-skill' });

    const rows = audit.getByCommand('jwt-auth', ['skill_generated', 'skill_lifecycle_change']);
    assert.equal(rows.length, 2);
    assert.equal(rows[0].action, 'skill_generated');
    assert.equal(rows[1].action, 'skill_lifecycle_change');

    const filtered = audit.getByCommand('jwt-auth', ['skill_generated']);
    assert.equal(filtered.length, 1);
    assert.equal(filtered[0].action, 'skill_generated');

    const all = audit.getByCommand('jwt-auth');
    assert.equal(all.length, 2);
  });
});

// ─── ControlStore ───────────────────────────────────────────────────────────

describe('ControlStore', () => {
  it('defaults to running when nothing has been set', () => {
    const db = openDatabase(tmpDir);
    assert.equal(new ControlStore(db).getState(), 'running');
  });

  it('round-trips the stopping signal', () => {
    const db = openDatabase(tmpDir);
    const control = new ControlStore(db);
    control.setState('stopping');
    assert.equal(control.getState(), 'stopping');
    control.setState('running');
    assert.equal(control.getState(), 'running');
  });
});

// ─── DecisionTraceStore ──────────────────────────────────────────────────────

describe('DecisionTraceStore', () => {
  it('persists a trace and returns it via getByAgent in insertion order', async () => {
    const { DecisionTraceStore } = await import('../state/DecisionTraceStore.js');
    const db = openDatabase(tmpDir);
    const store = new DecisionTraceStore(db);
    store.record({
      agent_id: 'agent-1',
      epic_id: 'epic-001',
      story_id: 'story-001-001',
      kind: 'thinking',
      rationale: 'I need to find the bug site.',
    });
    store.record({
      agent_id: 'agent-1',
      story_id: 'story-001-001',
      kind: 'tool_intent',
      subject: 'Bash',
      rationale: 'Grepping for the function.',
      metadata: { command: 'grep -rn foo' },
    });
    const rows = store.getByAgent('agent-1');
    assert.equal(rows.length, 2);
    assert.equal(rows[0].kind, 'thinking');
    assert.equal(rows[1].kind, 'tool_intent');
    assert.equal(rows[1].subject, 'Bash');
    assert.match(rows[1].metadata ?? '', /grep -rn foo/);
  });

  it('truncates rationales above 16 KB so a runaway thinking block does not bloat the DB', async () => {
    const { DecisionTraceStore } = await import('../state/DecisionTraceStore.js');
    const db = openDatabase(tmpDir);
    const store = new DecisionTraceStore(db);
    const huge = 'A'.repeat(20_000);
    store.record({ agent_id: 'agent-big', kind: 'thinking', rationale: huge });
    const rows = store.getByAgent('agent-big');
    assert.equal(rows.length, 1);
    assert.ok(rows[0].rationale.length < huge.length);
    assert.match(rows[0].rationale, /truncated/);
  });

  it('getByStory aggregates across all agents that worked on the story', async () => {
    const { DecisionTraceStore } = await import('../state/DecisionTraceStore.js');
    const db = openDatabase(tmpDir);
    const store = new DecisionTraceStore(db);
    store.record({ agent_id: 'a1', story_id: 'story-x', kind: 'thinking', rationale: 'first attempt' });
    store.record({ agent_id: 'a2', story_id: 'story-x', kind: 'thinking', rationale: 'retry' });
    store.record({ agent_id: 'a3', story_id: 'story-y', kind: 'thinking', rationale: 'unrelated' });
    const rows = store.getByStory('story-x');
    assert.equal(rows.length, 2);
    assert.deepEqual(rows.map((r) => r.agent_id), ['a1', 'a2']);
  });
});
