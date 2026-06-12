import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import yaml from 'js-yaml';
import { enforceCursorMcpAllowlist } from '../orchestrator/CursorMcpEnforcer.js';
import { openDatabase, resetDatabaseForTest } from '../state/Database.js';
import { EpicStore } from '../state/EpicStore.js';
import { AuditLog } from '../state/AuditLog.js';
import { Supervisor } from '../orchestrator/Supervisor.js';
import { MockWorkerRunner } from '../orchestrator/MockWorkerRunner.js';
import type { McpJsonEntry } from '../mcp/adapter.js';
import type { Story } from '../types.js';

// ─── Fake cursor-agent binary ───────────────────────────────────────────────
// A self-contained Node stub so tests are deterministic and never touch the
// real CLI or the developer's ~/.cursor config. Behavior is baked into the
// generated script per test; `mcp disable` appends each {name, cwd} call to a
// log we can assert against.

interface StubOptions {
  /** Lines `cursor-agent mcp list` should print (raw text). */
  listOutput: string;
  /** Server names whose `disable` exits non-zero. */
  failServers?: string[];
  /** Server names whose `disable` hangs (never exits) — tests the timeout. */
  hangServers?: string[];
  /** File name to write the stub as (default 'cursor-agent'). */
  binName?: string;
}

interface Stub {
  bin: string;
  callLogPath: string;
  dir: string;
}

let stubRoot: string;

function listText(names: string[]): string {
  return names.map((n) => `${n}: ready`).join('\n') + '\n';
}

function makeStub(opts: StubOptions): Stub {
  const dir = fs.mkdtempSync(path.join(stubRoot, 'stub-'));
  const callLogPath = path.join(dir, 'calls.log');
  const binName = opts.binName ?? 'cursor-agent';
  const bin = path.join(dir, binName);
  const body = [
    '#!/usr/bin/env node',
    "const fs = require('fs');",
    `const LIST = ${JSON.stringify(opts.listOutput)};`,
    `const FAIL = new Set(${JSON.stringify(opts.failServers ?? [])});`,
    `const HANG = new Set(${JSON.stringify(opts.hangServers ?? [])});`,
    `const LOG = ${JSON.stringify(callLogPath)};`,
    'const a = process.argv.slice(2);',
    "if (a[0] === 'mcp' && a[1] === 'list') { process.stdout.write(LIST); process.exit(0); }",
    "if (a[0] === 'mcp' && a[1] === 'disable') {",
    '  const n = a[2];',
    "  fs.appendFileSync(LOG, JSON.stringify({ name: n, cwd: process.cwd() }) + '\\n');",
    '  if (HANG.has(n)) { setTimeout(() => {}, 1000000); }',
    "  else if (FAIL.has(n)) { process.stderr.write('refused'); process.exit(1); }",
    '  else { process.exit(0); }',
    '} else { process.exit(0); }',
    '',
  ].join('\n');
  fs.writeFileSync(bin, body, { mode: 0o755 });
  return { bin, callLogPath, dir };
}

function readCalls(stub: Stub): Array<{ name: string; cwd: string }> {
  if (!fs.existsSync(stub.callLogPath)) return [];
  return fs
    .readFileSync(stub.callLogPath, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l));
}

beforeEach(() => {
  stubRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'loom-enf-'));
});

afterEach(() => {
  fs.rmSync(stubRoot, { recursive: true, force: true });
});

// ─── Unit: enforceCursorMcpAllowlist ────────────────────────────────────────

describe('enforceCursorMcpAllowlist', () => {
  it('disables exactly the non-allowlisted servers, against the worktree cwd (QA case 1)', () => {
    const stub = makeStub({
      listOutput: listText(['user-jira', 'internal-tools', 'loom', 'registry-a']),
    });
    const worktreePath = stub.dir; // any real dir works as cwd

    const res = enforceCursorMcpAllowlist({
      worktreePath,
      allowlist: ['registry-a', 'loom'],
      cursorBin: stub.bin,
    });

    assert.deepEqual(res.disabled, ['internal-tools', 'user-jira']);
    assert.deepEqual(res.gaps, []);

    const calls = readCalls(stub);
    assert.deepEqual(
      calls.map((c) => c.name).sort(),
      ['internal-tools', 'user-jira']
    );
    const expectedCwd = fs.realpathSync(worktreePath);
    for (const c of calls) {
      assert.equal(c.cwd, expectedCwd, 'each disable runs with cwd === worktreePath');
    }
  });

  it('empty registry (allowlist = [loom]) → every non-loom server disabled (QA case 2 / AC)', () => {
    const stub = makeStub({
      listOutput: listText(['user-jira', 'analytics', 'internal-tools', 'loom']),
    });

    const res = enforceCursorMcpAllowlist({
      worktreePath: stub.dir,
      allowlist: ['loom'],
      cursorBin: stub.bin,
    });

    assert.deepEqual(res.disabled, ['analytics', 'internal-tools', 'user-jira']);
    assert.deepEqual(res.gaps, []);
  });

  it("protects 'loom' even when it is absent from the passed allowlist", () => {
    const stub = makeStub({ listOutput: listText(['loom', 'rogue']) });

    const res = enforceCursorMcpAllowlist({
      worktreePath: stub.dir,
      allowlist: [], // loom not passed — must still survive
      cursorBin: stub.bin,
    });

    assert.deepEqual(res.disabled, ['rogue']);
    assert.deepEqual(readCalls(stub).map((c) => c.name), ['rogue']);
  });

  it('all servers already allowlisted → zero disable calls (QA case 3)', () => {
    const stub = makeStub({ listOutput: listText(['registry-a', 'registry-b', 'loom']) });

    const res = enforceCursorMcpAllowlist({
      worktreePath: stub.dir,
      allowlist: ['registry-a', 'registry-b', 'loom'],
      cursorBin: stub.bin,
    });

    assert.deepEqual(res.disabled, []);
    assert.deepEqual(res.gaps, []);
    assert.deepEqual(readCalls(stub), []);
  });

  it('a non-zero disable lands in gaps, never throws, other disables still attempted (QA case 4)', () => {
    const stub = makeStub({
      listOutput: listText(['bad-one', 'good-one', 'loom']),
      failServers: ['bad-one'],
    });

    const res = enforceCursorMcpAllowlist({
      worktreePath: stub.dir,
      allowlist: ['loom'],
      cursorBin: stub.bin,
    });

    assert.deepEqual(res.disabled, ['good-one']);
    assert.deepEqual(res.gaps, ['bad-one']);
    // Both were attempted — failure of one does not abort the loop.
    assert.deepEqual(readCalls(stub).map((c) => c.name).sort(), ['bad-one', 'good-one']);
  });

  it('a hanging disable is killed by the timeout and recorded as a gap (QA case 4: hang)', () => {
    const stub = makeStub({
      listOutput: listText(['wedged', 'fine', 'loom']),
      hangServers: ['wedged'],
    });
    process.env.LOOM_CURSOR_MCP_DISABLE_TIMEOUT_MS = '200';
    try {
      const res = enforceCursorMcpAllowlist({
        worktreePath: stub.dir,
        allowlist: ['loom'],
        cursorBin: stub.bin,
      });
      assert.deepEqual(res.disabled, ['fine']);
      assert.deepEqual(res.gaps, ['wedged']);
    } finally {
      delete process.env.LOOM_CURSOR_MCP_DISABLE_TIMEOUT_MS;
    }
  });

  it('unparseable mcp list output → no crash, empty result (QA case 5)', () => {
    const stub = makeStub({ listOutput: 'totally not a server line\n\n=== banner ===\n' });

    const res = enforceCursorMcpAllowlist({
      worktreePath: stub.dir,
      allowlist: ['loom'],
      cursorBin: stub.bin,
    });

    assert.deepEqual(res, { disabled: [], gaps: [] });
    assert.deepEqual(readCalls(stub), []);
  });

  it('empty mcp list output → empty result', () => {
    const stub = makeStub({ listOutput: '' });
    const res = enforceCursorMcpAllowlist({
      worktreePath: stub.dir,
      allowlist: ['loom'],
      cursorBin: stub.bin,
    });
    assert.deepEqual(res, { disabled: [], gaps: [] });
  });

  it('missing/unrunnable binary → empty result, never throws', () => {
    const res = enforceCursorMcpAllowlist({
      worktreePath: stubRoot,
      allowlist: ['loom'],
      cursorBin: path.join(stubRoot, 'does-not-exist'),
    });
    assert.deepEqual(res, { disabled: [], gaps: [] });
  });
});

// ─── Integration: Supervisor.dispatch feeds disabled/gaps into the audit row ──
// The frozen call site invokes enforceCursorMcpAllowlist with the default
// binary name, so we put a fake `cursor-agent` first on PATH for the duration
// of the test — deterministic, and the real CLI is never touched.

const LOOM_ENTRY: McpJsonEntry = {
  command: 'node',
  args: ['/abs/loom/index.js', 'serve'],
  env: {},
};

let repo: string;
let registryPath: string;
let savedPath: string | undefined;

function gitc(args: string[], cwd = repo): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

function story(id: string): Story {
  return {
    id,
    title: `Story ${id} title`,
    description: 'Implement the thing.',
    acceptance_criteria: ['it works'],
    estimated_complexity: 'small',
    dependencies: [],
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

function writeServer(name: string): void {
  const dir = path.join(registryPath, 'servers', name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'server.json'),
    JSON.stringify({
      name,
      description: 'x',
      packages: [
        {
          registry_type: 'npm',
          identifier: `@org/${name}`,
          version: '1.0.0',
          transport: { type: 'stdio' },
          environment_variables: [],
        },
      ],
    })
  );
}

describe('Supervisor.dispatch — cursor enforcer wiring (QA case 6)', () => {
  beforeEach(() => {
    resetDatabaseForTest();
    repo = fs.mkdtempSync(path.join(os.tmpdir(), 'loom-enf-sup-'));
    registryPath = fs.mkdtempSync(path.join(os.tmpdir(), 'loom-enf-reg-'));
    stubRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'loom-enf-'));
    savedPath = process.env.PATH;
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
    fs.rmSync(repo, { recursive: true, force: true });
    fs.rmSync(registryPath, { recursive: true, force: true });
    fs.rmSync(stubRoot, { recursive: true, force: true });
  });

  it('cursor-cli backend: enforcer runs and disabled/gaps land in the audit row', async () => {
    // Fake cursor-agent on PATH: lists allowlisted jira-mcp+loom plus two
    // inherited servers (one of which refuses to disable → a gap).
    const stub = makeStub({
      listOutput: listText(['jira-mcp', 'loom', 'rogue-server', 'wedged-server']),
      failServers: ['wedged-server'],
    });
    process.env.PATH = `${stub.dir}${path.delimiter}${savedPath}`;

    writeServer('jira-mcp');
    writePolicy({
      agents: { worker_backend: 'cursor-cli' },
      mcp: { registry: registryPath },
    });
    seedEpic('epic-001', [story('story-001-001')]);
    const db = openDatabase(path.join(repo, '.loom'));

    const worker = new MockWorkerRunner(() => ({
      status: 'done',
      commitCount: 1,
      summary: 'ok',
      logTail: '',
    }));

    await new Supervisor({
      projectRoot: repo,
      db,
      worker,
      maxConcurrent: 1,
      loomServerEntry: LOOM_ENTRY,
    }).run();

    const row = new AuditLog(db)
      .getByStory('story-001-001')
      .find((r) => r.action === 'worker_mcp_servers');
    assert.ok(row, 'a worker_mcp_servers audit row is recorded');
    const detail = JSON.parse(row!.detail!) as Record<string, unknown>;
    assert.equal(detail.backend, 'cursor-cli');
    assert.deepEqual(detail.disabledServers, ['rogue-server']);
    assert.deepEqual(detail.gaps, ['wedged-server']);

    // The disable ran against the worktree, not the repo root.
    const calls = readCalls(stub);
    const wtPath = fs.realpathSync(path.join(repo, '.loom', 'worktrees', 'story-001-001'));
    for (const c of calls) assert.equal(c.cwd, wtPath);
  });

  it('claude-code backend: enforcer never runs, no disabledServers/gaps in the row', async () => {
    // Even with a fake cursor-agent on PATH, the claude-code path must not call it.
    const stub = makeStub({ listOutput: listText(['rogue-server', 'loom']) });
    process.env.PATH = `${stub.dir}${path.delimiter}${savedPath}`;

    seedEpic('epic-001', [story('story-001-001')]);
    const db = openDatabase(path.join(repo, '.loom'));

    const worker = new MockWorkerRunner(() => ({
      status: 'done',
      commitCount: 1,
      summary: 'ok',
      logTail: '',
    }));

    await new Supervisor({ projectRoot: repo, db, worker, maxConcurrent: 1 }).run();

    const row = new AuditLog(db)
      .getByStory('story-001-001')
      .find((r) => r.action === 'worker_mcp_servers');
    const detail = JSON.parse(row!.detail!) as Record<string, unknown>;
    assert.equal(detail.backend, 'claude-code');
    assert.equal(detail.disabledServers, undefined);
    assert.equal(detail.gaps, undefined);
    assert.deepEqual(readCalls(stub), [], 'enforcer never invoked the binary');
  });
});
