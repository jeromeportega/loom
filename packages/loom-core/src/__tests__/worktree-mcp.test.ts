import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import yaml from 'js-yaml';
import { McpRegistry } from '../mcp/McpRegistry.js';
import { pickPackage, toMcpJsonEntry } from '../mcp/adapter.js';
import type { McpJsonEntry, McpJsonStdioEntry } from '../mcp/adapter.js';
import { materializeWorktreeMcpConfig } from '../mcp/WorktreeMcp.js';
import { openDatabase, resetDatabaseForTest } from '../state/Database.js';
import { EpicStore } from '../state/EpicStore.js';
import { AuditLog } from '../state/AuditLog.js';
import { Supervisor } from '../orchestrator/Supervisor.js';
import { MockWorkerRunner } from '../orchestrator/MockWorkerRunner.js';
import type { Story } from '../types.js';

// ─── Fixtures ─────────────────────────────────────────────────────────────

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
        { name: 'JIRA_URL', description: 'The base URL', is_required: true, is_secret: false },
      ],
    },
  ],
};

const HTTP_SERVER = {
  name: 'hosted-mcp',
  description: 'A hosted MCP server',
  packages: [
    {
      registry_type: 'npm',
      identifier: '@org/hosted-mcp',
      version: '1.0.0',
      transport: {
        type: 'streamable-http',
        url: 'https://mcp.example.com/mcp',
        headers: [{ name: 'X-API-KEY', description: 'key', is_required: true, is_secret: true }],
      },
    },
  ],
};

const LOOM_ENTRY: McpJsonEntry = {
  command: 'node',
  args: ['/abs/loom/index.js', 'serve'],
  env: {},
};

let worktreePath: string;
let registryPath: string;

function writeServer(name: string, serverJson: object): void {
  const dir = path.join(registryPath, 'servers', name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'server.json'), JSON.stringify(serverJson));
}

function readConfig(p: string): { mcpServers: Record<string, McpJsonEntry> } {
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

beforeEach(() => {
  worktreePath = fs.mkdtempSync(path.join(os.tmpdir(), 'loom-wt-'));
  registryPath = fs.mkdtempSync(path.join(os.tmpdir(), 'loom-reg-'));
});

afterEach(() => {
  fs.rmSync(worktreePath, { recursive: true, force: true });
  fs.rmSync(registryPath, { recursive: true, force: true });
});

// ─── Unit: materializeWorktreeMcpConfig ─────────────────────────────────────

describe('materializeWorktreeMcpConfig', () => {
  it('null registry with no loom entry → zero servers (AC: empty registry)', () => {
    const res = materializeWorktreeMcpConfig({ worktreePath, registry: null });
    assert.deepEqual(res.serverNames, []);
    assert.equal(res.configPath, path.join(worktreePath, '.cursor', 'mcp.json'));
    const cfg = readConfig(res.configPath);
    assert.deepEqual(cfg.mcpServers, {});
  });

  it('empty registry (servers dir, no servers) → zero servers', () => {
    fs.mkdirSync(path.join(registryPath, 'servers'), { recursive: true });
    const registry = new McpRegistry(registryPath);
    const res = materializeWorktreeMcpConfig({ worktreePath, registry });
    assert.deepEqual(res.serverNames, []);
    assert.deepEqual(readConfig(res.configPath).mcpServers, {});
  });

  it('populated registry → keys are EXACTLY the registry servers, entries match toMcpJsonEntry', () => {
    writeServer('jira-mcp', STDIO_SERVER);
    writeServer('hosted-mcp', HTTP_SERVER);
    const registry = new McpRegistry(registryPath);

    const res = materializeWorktreeMcpConfig({ worktreePath, registry });
    assert.deepEqual(res.serverNames, ['hosted-mcp', 'jira-mcp']);

    const cfg = readConfig(res.configPath);
    assert.deepEqual(Object.keys(cfg.mcpServers).sort(), ['hosted-mcp', 'jira-mcp']);
    // Entries must come verbatim from the shared adapter.
    for (const def of registry.list()) {
      const expected = toMcpJsonEntry(pickPackage(def)!);
      assert.deepEqual(cfg.mcpServers[def.name], expected);
    }
  });

  it('secret ${VAR} references survive verbatim — no env expansion', () => {
    writeServer('jira-mcp', STDIO_SERVER);
    const registry = new McpRegistry(registryPath);
    const res = materializeWorktreeMcpConfig({ worktreePath, registry });

    const entry = readConfig(res.configPath).mcpServers['jira-mcp'] as McpJsonStdioEntry;
    assert.equal(entry.env.JIRA_TOKEN, '${JIRA_TOKEN}');
    assert.equal(entry.env.JIRA_URL, '${JIRA_URL}');
    // The literal '${' must appear in the raw file (proves no shell expansion).
    const raw = fs.readFileSync(res.configPath, 'utf8');
    assert.ok(raw.includes('${JIRA_TOKEN}'), 'literal ${JIRA_TOKEN} must survive');
  });

  it('skips a registry server that has no installable package', () => {
    writeServer('no-pkg', { name: 'no-pkg', description: 'no packages', packages: [] });
    writeServer('jira-mcp', STDIO_SERVER);
    const registry = new McpRegistry(registryPath);
    const res = materializeWorktreeMcpConfig({ worktreePath, registry });
    assert.deepEqual(res.serverNames, ['jira-mcp']);
  });

  it('loomServerEntry provided → loom present in file and sorted serverNames (cursor-cli shape)', () => {
    writeServer('jira-mcp', STDIO_SERVER);
    const registry = new McpRegistry(registryPath);
    const res = materializeWorktreeMcpConfig({
      worktreePath,
      registry,
      loomServerEntry: LOOM_ENTRY,
    });
    assert.deepEqual(res.serverNames, ['jira-mcp', 'loom']);
    const cfg = readConfig(res.configPath);
    assert.deepEqual(cfg.mcpServers.loom, LOOM_ENTRY);
  });

  it('loomServerEntry omitted → loom absent (claude-code shape)', () => {
    writeServer('jira-mcp', STDIO_SERVER);
    const registry = new McpRegistry(registryPath);
    const res = materializeWorktreeMcpConfig({ worktreePath, registry });
    assert.ok(!res.serverNames.includes('loom'));
    assert.equal(readConfig(res.configPath).mcpServers.loom, undefined);
  });

  it('loom-only config when registry is null but loom entry given', () => {
    const res = materializeWorktreeMcpConfig({
      worktreePath,
      registry: null,
      loomServerEntry: LOOM_ENTRY,
    });
    assert.deepEqual(res.serverNames, ['loom']);
    assert.deepEqual(readConfig(res.configPath).mcpServers, { loom: LOOM_ENTRY });
  });

  it('overwrites (never merges) a stale .cursor/mcp.json and is idempotent', () => {
    // Pre-seed a stale config with a server NOT in the registry.
    const cursorDir = path.join(worktreePath, '.cursor');
    fs.mkdirSync(cursorDir, { recursive: true });
    fs.writeFileSync(
      path.join(cursorDir, 'mcp.json'),
      JSON.stringify({ mcpServers: { stale: { command: 'x', args: [], env: {} } } })
    );
    writeServer('jira-mcp', STDIO_SERVER);
    const registry = new McpRegistry(registryPath);

    const first = materializeWorktreeMcpConfig({ worktreePath, registry });
    assert.deepEqual(first.serverNames, ['jira-mcp']);
    const afterFirst = fs.readFileSync(first.configPath, 'utf8');
    // The stale server is gone — whole-file write, not a merge.
    assert.equal(readConfig(first.configPath).mcpServers.stale, undefined);

    // A second call with the same registry produces byte-identical output.
    const second = materializeWorktreeMcpConfig({ worktreePath, registry });
    assert.deepEqual(second.serverNames, ['jira-mcp']);
    assert.equal(fs.readFileSync(second.configPath, 'utf8'), afterFirst);
  });

  it('serverNames are sorted regardless of registry insertion order', () => {
    writeServer('zeta', { name: 'zeta', description: '', packages: STDIO_SERVER.packages });
    writeServer('alpha', { name: 'alpha', description: '', packages: STDIO_SERVER.packages });
    writeServer('mike', { name: 'mike', description: '', packages: STDIO_SERVER.packages });
    const registry = new McpRegistry(registryPath);
    const res = materializeWorktreeMcpConfig({
      worktreePath,
      registry,
      loomServerEntry: LOOM_ENTRY,
    });
    assert.deepEqual(res.serverNames, ['alpha', 'loom', 'mike', 'zeta']);
  });

  it('registry round-trip: a server added to the registry appears on the next materialize', () => {
    // Models `loom mcp add` enlarging the allowlist the materializer reads:
    // a server.json added to the registry must show up in the next worker's
    // config without re-instantiating the registry (list() re-reads on call).
    writeServer('jira-mcp', STDIO_SERVER);
    const registry = new McpRegistry(registryPath);

    const before = materializeWorktreeMcpConfig({ worktreePath, registry });
    assert.deepEqual(before.serverNames, ['jira-mcp']);

    writeServer('hosted-mcp', HTTP_SERVER);
    const after = materializeWorktreeMcpConfig({ worktreePath, registry });
    assert.deepEqual(after.serverNames, ['hosted-mcp', 'jira-mcp']);
    assert.ok(readConfig(after.configPath).mcpServers['hosted-mcp']);
  });
});

// ─── Integration: Supervisor.dispatch call site ─────────────────────────────

let repo: string;
let savedPath: string | undefined;
let stubBinDir: string;

function gitc(args: string[], cwd = repo): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

// The frozen dispatch call site invokes enforceCursorMcpAllowlist with the
// default binary name ('cursor-agent'). Shadow it on PATH with a no-op stub so
// the cursor-cli path enumerates zero servers and the test never depends on a
// real cursor-agent or the developer's ~/.cursor config (QA determinism check).
function writeCursorAgentStub(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'loom-wt-bin-'));
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

describe('Supervisor.dispatch — worker MCP materialization', () => {
  beforeEach(() => {
    resetDatabaseForTest();
    repo = fs.mkdtempSync(path.join(os.tmpdir(), 'loom-sup-mcp-'));
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
  });

  it('writes .cursor/mcp.json in the worktree BEFORE the runner runs (claude-code, no registry)', async () => {
    seedEpic('epic-001', [story('story-001-001')]);
    const db = openDatabase(path.join(repo, '.loom'));

    let existedAtRun = false;
    let contentAtRun: { mcpServers: Record<string, McpJsonEntry> } | undefined;
    const worker = new MockWorkerRunner((a) => {
      const cfg = path.join(a.worktreePath, '.cursor', 'mcp.json');
      existedAtRun = fs.existsSync(cfg);
      if (existedAtRun) contentAtRun = readConfig(cfg);
      return { status: 'done', commitCount: 1, summary: 'ok', logTail: '' };
    });

    await new Supervisor({ projectRoot: repo, db, worker, maxConcurrent: 1 }).run();

    assert.ok(existedAtRun, 'config must exist before the worker runs');
    // No registry + claude-code backend → zero non-loom servers, no loom.
    assert.deepEqual(contentAtRun?.mcpServers, {});

    const row = new AuditLog(db)
      .getByStory('story-001-001')
      .find((r) => r.action === 'worker_mcp_servers');
    assert.ok(row, 'a worker_mcp_servers audit row is recorded');
    const detail = JSON.parse(row!.detail!) as Record<string, unknown>;
    assert.deepEqual(detail.servers, []);
    assert.equal(detail.backend, 'claude-code');
    assert.equal(detail.loomServerIncluded, false);
    assert.equal(detail.configPath, path.join('.cursor', 'mcp.json'));
  });

  it('materializes registry servers + loom for the cursor-cli backend', async () => {
    // Point policy at a registry checkout with one server, cursor-cli backend.
    writeServer('jira-mcp', STDIO_SERVER);
    writePolicy({
      agents: { worker_backend: 'cursor-cli' },
      mcp: { registry: registryPath },
    });
    seedEpic('epic-001', [story('story-001-001')]);
    const db = openDatabase(path.join(repo, '.loom'));

    let contentAtRun: { mcpServers: Record<string, McpJsonEntry> } | undefined;
    const worker = new MockWorkerRunner((a) => {
      contentAtRun = readConfig(path.join(a.worktreePath, '.cursor', 'mcp.json'));
      return { status: 'done', commitCount: 1, summary: 'ok', logTail: '' };
    });

    await new Supervisor({
      projectRoot: repo,
      db,
      worker,
      maxConcurrent: 1,
      loomServerEntry: LOOM_ENTRY,
    }).run();

    assert.deepEqual(Object.keys(contentAtRun!.mcpServers).sort(), ['jira-mcp', 'loom']);
    assert.deepEqual(contentAtRun!.mcpServers.loom, LOOM_ENTRY);

    const row = new AuditLog(db)
      .getByStory('story-001-001')
      .find((r) => r.action === 'worker_mcp_servers');
    const detail = JSON.parse(row!.detail!) as Record<string, unknown>;
    assert.deepEqual(detail.servers, ['jira-mcp', 'loom']);
    assert.equal(detail.backend, 'cursor-cli');
    assert.equal(detail.loomServerIncluded, true);
    // Cursor backend records the (stubbed) enforcer result.
    assert.deepEqual(detail.disabledServers, []);
    assert.deepEqual(detail.gaps, []);
  });

  it('cursor-cli without loomServerEntry → loom absent, third-party retained (story-002-005 AC#2+#3)', async () => {
    // Simulates the Phase-1 removal: run.ts no longer passes loomServerEntry,
    // so Supervisor receives undefined and must NOT write a loom entry.
    // Third-party registry servers must still appear unchanged (AC#3).
    writeServer('jira-mcp', STDIO_SERVER);
    writePolicy({
      agents: { worker_backend: 'cursor-cli' },
      mcp: { registry: registryPath },
    });
    seedEpic('epic-001', [story('story-001-001')]);
    const db = openDatabase(path.join(repo, '.loom'));

    let contentAtRun: { mcpServers: Record<string, McpJsonEntry> } | undefined;
    const worker = new MockWorkerRunner((a) => {
      contentAtRun = readConfig(path.join(a.worktreePath, '.cursor', 'mcp.json'));
      return { status: 'done', commitCount: 1, summary: 'ok', logTail: '' };
    });

    // No loomServerEntry passed — matches the new run.ts behavior.
    await new Supervisor({
      projectRoot: repo,
      db,
      worker,
      maxConcurrent: 1,
    }).run();

    // AC#2: loom self-server must NOT appear.
    assert.equal(
      contentAtRun!.mcpServers.loom,
      undefined,
      'loom self-server must be absent from cursor worktree mcp.json'
    );
    // AC#3: third-party registry server must be retained.
    assert.ok(
      contentAtRun!.mcpServers['jira-mcp'],
      'third-party registry server must still be present'
    );
    // AC#4: secrets must survive as ${VAR} references, not inlined.
    const jiraEntry = contentAtRun!.mcpServers['jira-mcp'] as McpJsonEntry & {
      env?: Record<string, string>;
    };
    if ('env' in jiraEntry && jiraEntry.env) {
      assert.ok(
        (jiraEntry.env['JIRA_TOKEN'] ?? '').includes('${'),
        'secret env var must remain as ${VAR} reference'
      );
    }

    const row = new AuditLog(db)
      .getByStory('story-001-001')
      .find((r) => r.action === 'worker_mcp_servers');
    const detail = JSON.parse(row!.detail!) as Record<string, unknown>;
    assert.equal(detail.loomServerIncluded, false, 'audit row must record loomServerIncluded=false');
    assert.deepEqual(detail.servers, ['jira-mcp']);
  });
});
