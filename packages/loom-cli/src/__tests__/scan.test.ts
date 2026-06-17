/**
 * Smoke tests for `loom scan` (runScanCommand) and `loom opportunities`
 * (runOpportunitiesCommand).
 *
 * Tests inject a stub LLM and empty scanners so no real CLI processes or LLM
 * calls are made. The pipeline succeeds with zero signals and zero opportunities.
 *
 * Owner: story-004-006
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  resetDatabaseForTest,
  OpportunityStore,
  createDatabase,
  AuditLog,
  ProjectRegistry,
} from '@loom-ai/core';
import type { LLMClient, LLMRequest, LLMResponse } from '@loom-ai/core';
import { runScanCommand, runOpportunitiesCommand } from '../commands/scan.js';

// ─── Stub LLM ──────────────────────────────────────────────────────────────────

/** Minimal stub LLM — never called when scanners return []. */
class StubLLM implements LLMClient {
  calls = 0;
  async complete(_req: LLMRequest): Promise<LLMResponse> {
    this.calls++;
    return {
      text: '[]',
      usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0, requestCount: 1, costUsd: 0 },
      model: 'stub',
      stopReason: 'end_turn',
    };
  }
}

// ─── Capture helper ────────────────────────────────────────────────────────────

interface Captured { logs: string[]; errors: string[]; exitCode: number | null }

async function capture(fn: () => Promise<void> | void): Promise<Captured> {
  const origExit = process.exit as (code?: number) => never;
  const origLog = console.log;
  const origErr = console.error;
  const logs: string[] = [];
  const errors: string[] = [];
  let exitCode: number | null = null;
  (process as NodeJS.Process & { exit: (code?: number) => never }).exit = (
    code?: number
  ) => {
    exitCode = code ?? 0;
    throw new Error(`process.exit(${code})`);
  };
  console.log = (...args: unknown[]) => logs.push(args.map(String).join(' '));
  console.error = (...args: unknown[]) => errors.push(args.map(String).join(' '));
  try {
    await fn();
  } catch (e) {
    if (!(e instanceof Error && e.message.startsWith('process.exit'))) throw e;
  } finally {
    (process as NodeJS.Process & { exit: (code?: number) => never }).exit = origExit;
    console.log = origLog;
    console.error = origErr;
  }
  return { logs, errors, exitCode };
}

// ─── Lifecycle ──────────────────────────────────────────────────────────────────

let tmpDir: string;
let prevCwd: string;
let prevLoomHome: string | undefined;
let loomHomeDir: string;

beforeEach(() => {
  resetDatabaseForTest();
  prevCwd = process.cwd();
  prevLoomHome = process.env.LOOM_HOME;
  loomHomeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'loom-scan-home-'));
  process.env.LOOM_HOME = loomHomeDir;
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'loom-scan-'));
  // Initialize as a git repo with a .loom dir (policy.yaml not required for scan)
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: tmpDir });
  execFileSync('git', ['config', 'user.email', 'test@loom.dev'], { cwd: tmpDir });
  execFileSync('git', ['config', 'user.name', 'Loom Test'], { cwd: tmpDir });
  fs.writeFileSync(path.join(tmpDir, 'README.md'), '# test\n');
  execFileSync('git', ['add', '.'], { cwd: tmpDir });
  execFileSync('git', ['commit', '-q', '-m', 'initial'], { cwd: tmpDir });
  fs.mkdirSync(path.join(tmpDir, '.loom'), { recursive: true });
  process.chdir(tmpDir);
});

afterEach(() => {
  resetDatabaseForTest();
  process.chdir(prevCwd);
  fs.rmSync(tmpDir, { recursive: true, force: true });
  fs.rmSync(loomHomeDir, { recursive: true, force: true });
  if (prevLoomHome === undefined) delete process.env.LOOM_HOME;
  else process.env.LOOM_HOME = prevLoomHome;
});

// ─── loom scan ────────────────────────────────────────────────────────────────

describe('runScanCommand', () => {
  it('runs the pipeline end-to-end with empty scanners and prints the result', async () => {
    const llm = new StubLLM();
    const { logs, exitCode } = await capture(async () => {
      await runScanCommand({
        llm,
        scanners: [], // empty scanners → no signals → engine skips LLM
      });
    });

    assert.equal(exitCode, null, 'should not exit with error');
    const allOutput = logs.join('\n');
    assert.match(allOutput, /signals observed/, 'prints signal summary');
    assert.match(allOutput, /opportunities/, 'mentions opportunities');
    // No LLM call because there are no signals
    assert.equal(llm.calls, 0, 'LLM not called when no signals');
  });

  it('emits structured JSON with --json flag', async () => {
    const { logs, exitCode } = await capture(async () => {
      await runScanCommand({ llm: new StubLLM(), scanners: [], json: true });
    });

    assert.equal(exitCode, null, 'should not exit');
    const jsonLine = logs.find(l => l.trim().startsWith('{'));
    assert.ok(jsonLine, 'JSON line found in output');
    const parsed = JSON.parse(jsonLine!) as { opportunities: unknown[] };
    assert.ok(Array.isArray(parsed.opportunities), 'opportunities array present');
  });

  it('exits 1 if not in an initialized loom project (no policy.yaml, no injected LLM)', async () => {
    // No LLM injected AND no policy.yaml → requires initialization
    const { exitCode, errors } = await capture(async () => {
      await runScanCommand({ scanners: [] }); // no llm injection
    });

    assert.equal(exitCode, 1);
    assert.ok(errors.some(e => /not initialized/i.test(e)));
  });

  it('--project scopes the scan to the named project (not cwd)', async () => {
    // Create a second project distinct from cwd (tmpDir)
    const projectA = fs.mkdtempSync(path.join(os.tmpdir(), 'loom-scan-proj-a-'));
    fs.mkdirSync(path.join(projectA, '.loom'), { recursive: true });

    resetDatabaseForTest(); // ensure no leftover singleton

    try {
      // Register both projects via the test loomHome
      const registry = new ProjectRegistry();
      registry.register(projectA);
      registry.register(tmpDir);

      const llm = new StubLLM();
      const { exitCode } = await capture(async () => {
        await runScanCommand({ project: projectA, llm, scanners: [] });
      });

      assert.equal(exitCode, null, 'should not exit with error');

      // project A's DB must exist and contain a signal_scan audit record
      const dbAPath = path.join(projectA, '.loom', 'loom.db');
      assert.ok(fs.existsSync(dbAPath), 'projectA loom.db must be created by the scan');
      const dbA = createDatabase(dbAPath);
      const auditA = new AuditLog(dbA);
      const entries = auditA.recent(10);
      dbA.close();
      assert.ok(
        entries.some((e) => e.action === 'signal_scan'),
        'signal_scan must be recorded in projectA DB'
      );

      // cwd (tmpDir) must NOT have a loom.db — the scan never opened it
      assert.ok(
        !fs.existsSync(path.join(tmpDir, '.loom', 'loom.db')),
        'cwd loom.db must not be created when --project targets a different dir'
      );
    } finally {
      resetDatabaseForTest();
      fs.rmSync(projectA, { recursive: true, force: true });
    }
  });

  it('--project exits 1 when project is not registered', async () => {
    const { exitCode, errors } = await capture(async () => {
      await runScanCommand({
        project: '/tmp/not-a-registered-scan-project',
        llm: new StubLLM(),
        scanners: [],
      });
    });

    assert.equal(exitCode, 1, 'should exit 1 for unregistered project');
    assert.ok(errors.some((e) => /not registered/i.test(e)), 'error message must mention not registered');
  });
});

// ─── loom opportunities ───────────────────────────────────────────────────────

describe('runOpportunitiesCommand', () => {
  it('prints the empty state when no opportunities are stored', async () => {
    const { logs, exitCode } = await capture(() => {
      runOpportunitiesCommand();
    });

    assert.equal(exitCode, null, 'should not exit with error');
    const allOutput = logs.join('\n');
    assert.match(allOutput, /loom scan|No opportunities/i, 'prints empty state message');
  });

  it('emits JSON with --json when no opportunities', async () => {
    const { logs, exitCode } = await capture(() => {
      runOpportunitiesCommand({ json: true });
    });

    assert.equal(exitCode, null);
    const jsonLine = logs.find(l => l.trim().startsWith('{'));
    assert.ok(jsonLine, 'JSON line present');
    const parsed = JSON.parse(jsonLine!) as { opportunities: unknown[] };
    assert.ok(Array.isArray(parsed.opportunities));
    assert.equal(parsed.opportunities.length, 0);
  });
});
