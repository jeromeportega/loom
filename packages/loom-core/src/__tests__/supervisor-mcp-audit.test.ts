// story-002-004 — Audit-log each worker's exact MCP server set before spawn.
//
// Verifies the `worker_mcp_servers` audit row that story-002-001 wired into
// Supervisor.dispatch() (dispatch ordering step 4, ADR-4): one row per spawn,
// carrying the WorkerMcpServersDetail payload, written strictly BEFORE the
// worker process starts. The contract under test is what lands in audit_log
// and when — not Supervisor internals — so these are integration tests against
// a real SQLite database and a stub runner.
//
// No-migration finding (AC 3): the payload persists with ZERO schema changes.
// `audit_log.detail` is a free-form `TEXT` column (state/Database.ts) and
// `AuditLog.record()` already `JSON.stringify`s the detail object
// (state/AuditLog.ts). The cases below insert against the unmodified schema and
// read the JSON back — the suite passing IS the proof that no migration is
// needed for the WorkerMcpServersDetail shape.

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import yaml from 'js-yaml';
import type { McpJsonEntry } from '../mcp/adapter.js';
import { openDatabase, resetDatabaseForTest } from '../state/Database.js';
import { EpicStore } from '../state/EpicStore.js';
import { AgentStore } from '../state/AgentStore.js';
import { AuditLog } from '../state/AuditLog.js';
import { Supervisor } from '../orchestrator/Supervisor.js';
import { MockWorkerRunner } from '../orchestrator/MockWorkerRunner.js';
import type { Story } from '../types.js';

// ─── The shape this story verifies (frozen in the epic-002 contract §4) ──────

interface WorkerMcpServersDetail {
  servers: string[];
  backend: 'claude-code' | 'cursor-cli';
  configPath: string;
  disabledServers?: string[];
  gaps?: string[];
}

// ─── Fixtures ────────────────────────────────────────────────────────────────

const STDIO_SERVER = {
  name: 'jira-mcp',
  description: 'Jira integration',
  packages: [
    {
      registry_type: 'npm',
      identifier: '@org/jira-mcp',
      version: '2.0.0',
      transport: { type: 'stdio' },
      environment_variables: [
        { name: 'JIRA_TOKEN', description: 'A token', is_required: true, is_secret: true },
      ],
    },
  ],
};

let repo: string;
let registryPath: string;
let savedPath: string | undefined;
let stubBinDir: string;

function gitc(args: string[], cwd = repo): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

// The cursor-cli dispatch path invokes enforceCursorMcpAllowlist with the
// default 'cursor-agent' binary. Shadow it on PATH with a no-op stub so the
// enforcer enumerates zero servers (disabledServers/gaps = []) deterministically,
// never touching a real cursor-agent or the developer's ~/.cursor config.
function writeCursorAgentStub(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'loom-mcp-audit-bin-'));
  fs.writeFileSync(
    path.join(dir, 'cursor-agent'),
    '#!/usr/bin/env node\nprocess.exit(0);\n',
    { mode: 0o755 }
  );
  return dir;
}

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

function seedEpic(epicId: string, stories: Story[]): void {
  const epicYaml = {
    epic_id: epicId,
    title: `Epic ${epicId} title`,
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

function writePolicy(body: object): void {
  fs.mkdirSync(path.join(repo, '.loom'), { recursive: true });
  fs.writeFileSync(path.join(repo, '.loom', 'policy.yaml'), yaml.dump(body));
}

function writeServer(name: string, serverJson: object): void {
  const dir = path.join(registryPath, 'servers', name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'server.json'), JSON.stringify(serverJson));
}

function readConfig(p: string): { mcpServers: Record<string, McpJsonEntry> } {
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

function mcpRows(db: ReturnType<typeof openDatabase>, storyId: string) {
  return new AuditLog(db)
    .getByStory(storyId)
    .filter((r) => r.action === 'worker_mcp_servers');
}

describe('Supervisor.dispatch — worker_mcp_servers audit row', () => {
  beforeEach(() => {
    resetDatabaseForTest();
    repo = fs.mkdtempSync(path.join(os.tmpdir(), 'loom-mcp-audit-'));
    registryPath = fs.mkdtempSync(path.join(os.tmpdir(), 'loom-mcp-audit-reg-'));
    savedPath = process.env.PATH;
    stubBinDir = writeCursorAgentStub();
    process.env.PATH = `${stubBinDir}${path.delimiter}${savedPath ?? ''}`;
    gitc(['init', '-q']);
    gitc(['config', 'user.email', 'test@loom.dev']);
    gitc(['config', 'user.name', 'Loom Test']);
    gitc(['config', 'commit.gpgsign', 'false']);
    fs.writeFileSync(path.join(repo, 'README.md'), '# test\n');
    gitc(['add', '.']);
    gitc(['commit', '-q', '-m', 'initial']);
  });

  afterEach(() => {
    resetDatabaseForTest();
    if (savedPath !== undefined) process.env.PATH = savedPath;
    fs.rmSync(stubBinDir, { recursive: true, force: true });
    fs.rmSync(repo, { recursive: true, force: true });
    fs.rmSync(registryPath, { recursive: true, force: true });
  });

  // Case 1 — exactly ONE row per spawn, keyed correctly.
  it('writes exactly one worker_mcp_servers row per spawn with command=storyId and agent_id=task.agentId', async () => {
    seedEpic('epic-001', [story('story-001-001')]);
    const db = openDatabase(path.join(repo, '.loom'));

    await new Supervisor({
      projectRoot: repo,
      db,
      worker: new MockWorkerRunner({ status: 'done' }),
      maxConcurrent: 1,
    }).run();

    const rows = mcpRows(db, 'story-001-001');
    assert.equal(rows.length, 1, 'exactly one worker_mcp_servers row');

    const agent = new AgentStore(db).getByStory('story-001-001');
    assert.ok(agent, 'an agent was created for the story');
    assert.equal(rows[0].command, 'story-001-001');
    assert.equal(rows[0].agent_id, agent!.id);
  });

  // Case 2 — claude-code payload: WorkerMcpServersDetail shape, sorted servers
  // exactly matching the generated config, no registry → empty server set.
  it('claude-code: detail is a complete WorkerMcpServersDetail with loomServerIncluded=false', async () => {
    seedEpic('epic-001', [story('story-001-001')]);
    const db = openDatabase(path.join(repo, '.loom'));

    let serversInConfig: string[] = [];
    const worker = new MockWorkerRunner((a) => {
      const cfg = readConfig(path.join(a.worktreePath, '.cursor', 'mcp.json'));
      serversInConfig = Object.keys(cfg.mcpServers).sort((x, y) => x.localeCompare(y));
      return { status: 'done', commitCount: 1, summary: 'ok', logTail: '' };
    });

    await new Supervisor({ projectRoot: repo, db, worker, maxConcurrent: 1 }).run();

    const detail = JSON.parse(mcpRows(db, 'story-001-001')[0].detail!) as WorkerMcpServersDetail;
    assert.deepEqual(detail.servers, []);
    assert.deepEqual(detail.servers, serversInConfig, 'detail.servers == generated config keys (sorted)');
    assert.equal(detail.backend, 'claude-code');
    assert.equal('loomServerIncluded' in detail, false, 'loomServerIncluded must not appear in audit row');
    assert.equal(detail.configPath, path.join('.cursor', 'mcp.json'));
    // Case 3 (claude-code half): cursor-only fields are absent.
    assert.equal('disabledServers' in detail, false);
    assert.equal('gaps' in detail, false);
  });

  // Case 2 + 3 — cursor-cli payload: third-party servers sorted and matching
  // the generated config, enforcer's disabledServers/gaps present.
  it('cursor-cli: detail has sorted third-party servers and the enforcer disabledServers/gaps fields', async () => {
    writeServer('jira-mcp', STDIO_SERVER);
    writePolicy({
      agents: { worker_backend: 'cursor-cli' },
      mcp: { registry: registryPath },
    });
    seedEpic('epic-001', [story('story-001-001')]);
    const db = openDatabase(path.join(repo, '.loom'));

    let serversInConfig: string[] = [];
    const worker = new MockWorkerRunner((a) => {
      const cfg = readConfig(path.join(a.worktreePath, '.cursor', 'mcp.json'));
      serversInConfig = Object.keys(cfg.mcpServers).sort((x, y) => x.localeCompare(y));
      return { status: 'done', commitCount: 1, summary: 'ok', logTail: '' };
    });

    await new Supervisor({
      projectRoot: repo,
      db,
      worker,
      maxConcurrent: 1,
    }).run();

    const detail = JSON.parse(mcpRows(db, 'story-001-001')[0].detail!) as WorkerMcpServersDetail;
    assert.deepEqual(detail.servers, ['jira-mcp']);
    assert.deepEqual(detail.servers, serversInConfig, 'detail.servers == generated config keys (sorted)');
    assert.equal(detail.backend, 'cursor-cli');
    assert.equal('loomServerIncluded' in detail, false, 'loomServerIncluded must not appear in audit row');
    assert.equal(detail.configPath, path.join('.cursor', 'mcp.json'));
    // Enforcer is a no-op stub; the FIELDS must be present on the cursor-cli
    // path so dashboards can rely on them.
    assert.deepEqual(detail.disabledServers, []);
    assert.deepEqual(detail.gaps, []);
  });

  // Case 4 — write-before-spawn by OBSERVATION: the row is queryable from
  // inside runner.run(), proving it was persisted before the worker started.
  it('persists the worker_mcp_servers row BEFORE runner.run() executes', async () => {
    seedEpic('epic-001', [story('story-001-001')]);
    const db = openDatabase(path.join(repo, '.loom'));

    let rowExistedAtRun = false;
    let dispatchRowAtRun = false;
    const worker = new MockWorkerRunner(() => {
      const rows = new AuditLog(db).getByStory('story-001-001');
      rowExistedAtRun = rows.some((r) => r.action === 'worker_mcp_servers');
      dispatchRowAtRun = rows.some((r) => r.action === 'dispatch');
      return { status: 'done', commitCount: 1, summary: 'ok', logTail: '' };
    });

    await new Supervisor({ projectRoot: repo, db, worker, maxConcurrent: 1 }).run();

    assert.ok(rowExistedAtRun, 'worker_mcp_servers row must exist when the worker starts');
    assert.ok(dispatchRowAtRun, 'the dispatch row is also written before the worker starts');
  });

  // Case 5 — the existing 'dispatch' row is untouched: two distinct rows per
  // spawn, the dispatch row keeps its own detail shape (dashboards unbroken).
  it('still writes the dispatch row with its own detail shape (two rows per spawn)', async () => {
    seedEpic('epic-001', [story('story-001-001')]);
    const db = openDatabase(path.join(repo, '.loom'));

    await new Supervisor({
      projectRoot: repo,
      db,
      worker: new MockWorkerRunner({ status: 'done' }),
      maxConcurrent: 1,
    }).run();

    const all = new AuditLog(db).getByStory('story-001-001');
    const dispatch = all.filter((r) => r.action === 'dispatch');
    const mcp = all.filter((r) => r.action === 'worker_mcp_servers');
    assert.equal(dispatch.length, 1, 'exactly one dispatch row');
    assert.equal(mcp.length, 1, 'exactly one worker_mcp_servers row');

    // The dispatch row keeps its established detail shape ({ worktree, branch })
    // — the new row did not absorb or alter it.
    const dispatchDetail = JSON.parse(dispatch[0].detail!) as Record<string, unknown>;
    assert.ok('worktree' in dispatchDetail, 'dispatch detail still has worktree');
    assert.ok('branch' in dispatchDetail, 'dispatch detail still has branch');
    assert.equal('servers' in dispatchDetail, false, 'dispatch detail is not the MCP payload');
  });

  // Case 6 — no-migration confirmation: the row was inserted and read back
  // through the unmodified audit_log schema. Reaching a parseable detail object
  // here proves the free-form TEXT column stored the JSON without migration.
  it('persists the JSON payload against the unmodified audit_log schema (no migration)', async () => {
    seedEpic('epic-001', [story('story-001-001')]);
    const db = openDatabase(path.join(repo, '.loom'));

    await new Supervisor({
      projectRoot: repo,
      db,
      worker: new MockWorkerRunner({ status: 'done' }),
      maxConcurrent: 1,
    }).run();

    const row = mcpRows(db, 'story-001-001')[0];
    assert.ok(row, 'row persisted');
    assert.doesNotThrow(() => JSON.parse(row.detail!), 'detail is valid JSON in the TEXT column');
    const detail = JSON.parse(row.detail!) as WorkerMcpServersDetail;
    assert.ok(Array.isArray(detail.servers));
    assert.equal(typeof detail.backend, 'string');
    assert.equal('loomServerIncluded' in detail, false, 'loomServerIncluded must not appear in audit row');
  });
});
