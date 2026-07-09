/**
 * story-087-003 — deprecated alias stubs + projects enhancement.
 *
 * Tests the five hidden alias stubs (publish, finalize, reconcile, epic, project)
 * and the optional [project-root] argument on `loom projects`.
 *
 * Unit:
 *   - Each alias writes the correct redirect notice to process.stderr
 *   - Each alias delegates to its replacement (verified via exit code / output
 *     from the delegate failing fast on a no-loom-init tmpDir or missing project)
 *   - Each command has _hidden === true on the Commander object
 *
 * Integration (CLI help):
 *   - None of the five aliases appear in `loom --help`
 *   - `loom projects --help` includes [project-root] as an optional positional
 *
 * projects enhancement (unit):
 *   - runProjects() with no argument lists all registered projects
 *   - runProjects(root) shows only the matching project and its latest epic
 *   - runProjects(nonexistent) prints a clear 'not found' message, no crash
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ProjectRegistry, openDatabase, resetDatabaseForTest, EpicStore } from '@loom-ai/core';
import { runProjects } from '../commands/projects.js';
import { buildProgram } from '../index.js';

// ─── Helpers ─────────────────────────────────────────────────────────────────

const MINIMAL_POLICY = `git:\n  allowed_remotes: []\nagents:\n  min_brief_quality_score: 6\n  max_concurrent: 5\n  review_strategy: "comment"\n  skill_generation: "on"\n`;

interface AliasCapture {
  stderrWrites: string[];
  logs: string[];
  errors: string[];
  exitCode: number | null;
}

/**
 * Like testUtils.capture but also intercepts process.stderr.write so we can
 * assert the redirect notice that stubs write before calling the delegate.
 */
async function captureAlias(fn: () => unknown): Promise<AliasCapture> {
  const stderrWrites: string[] = [];
  const logs: string[] = [];
  const errors: string[] = [];
  let exitCode: number | null = null;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const stderrObj = process.stderr as any;
  const origWrite = stderrObj.write.bind(process.stderr);
  const origLog = console.log;
  const origErr = console.error;
  const origExit = process.exit;

  class ExitSignal extends Error {}

  stderrObj.write = (chunk: string | Uint8Array) => {
    stderrWrites.push(chunk.toString());
    return true;
  };
  (process as unknown as { exit: (c?: number) => never }).exit = (c?: number) => {
    exitCode = c ?? 0;
    throw new ExitSignal();
  };
  console.log = (...args: unknown[]) => logs.push(args.map(String).join(' '));
  console.error = (...args: unknown[]) => errors.push(args.map(String).join(' '));

  try {
    await Promise.resolve(fn());
  } catch (err) {
    if (!(err instanceof ExitSignal)) throw err;
  } finally {
    stderrObj.write = origWrite;
    process.exit = origExit;
    console.log = origLog;
    console.error = origErr;
  }

  return { stderrWrites, logs, errors, exitCode };
}

// ─── Fixtures ─────────────────────────────────────────────────────────────────

let tmpDir: string;
let loomDir: string;
let prevCwd: string;
let prevLoomHome: string | undefined;
let loomHomeDir: string;

beforeEach(() => {
  resetDatabaseForTest();
  prevCwd = process.cwd();
  prevLoomHome = process.env.LOOM_HOME;
  loomHomeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'loom-alias-home-'));
  process.env.LOOM_HOME = loomHomeDir;
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'loom-alias-'));
  loomDir = path.join(tmpDir, '.loom');
  // No policy.yaml by default — stubs write redirect then delegate exits fast
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

// ─── Unit: Commander hidden-flag checks ──────────────────────────────────────

describe('deprecated alias stubs — Commander registration', () => {
  const ALIAS_NAMES = ['publish', 'finalize', 'reconcile', 'epic', 'project'] as const;

  for (const name of ALIAS_NAMES) {
    it(`"${name}" has _hidden === true`, () => {
      const program = buildProgram();
      const cmd = program.commands.find((c) => c.name() === name);
      assert.ok(cmd, `"${name}" must be registered`);
      assert.equal(
        (cmd as unknown as { _hidden: boolean })._hidden,
        true,
        `"${name}" must be hidden from --help`
      );
    });
  }
});

// ─── Unit: stderr redirect notices ───────────────────────────────────────────

describe('loom publish (alias) — redirect notice', () => {
  it('writes "→ use loom recover <epic-id>" to stderr before delegating', async () => {
    const result = await captureAlias(() =>
      buildProgram().parseAsync(['node', 'loom', 'publish', 'epic-007'])
    );
    const allStderr = result.stderrWrites.join('');
    assert.ok(
      allStderr.includes('→ use loom recover epic-007'),
      `expected redirect in stderr; got: ${JSON.stringify(allStderr)}`
    );
  });

  it('delegates to runRecover (exits non-zero when loom is not initialized)', async () => {
    const result = await captureAlias(() =>
      buildProgram().parseAsync(['node', 'loom', 'publish', 'epic-007'])
    );
    assert.equal(result.exitCode, 1, 'runRecover must be called and fail fast with exit 1');
  });
});

describe('loom finalize (alias) — redirect notice', () => {
  it('writes "→ use loom recover <epic-id>" to stderr before delegating', async () => {
    const result = await captureAlias(() =>
      buildProgram().parseAsync(['node', 'loom', 'finalize', 'epic-008'])
    );
    const allStderr = result.stderrWrites.join('');
    assert.ok(
      allStderr.includes('→ use loom recover epic-008'),
      `expected redirect in stderr; got: ${JSON.stringify(allStderr)}`
    );
  });

  it('delegates to runRecover (exits non-zero when loom is not initialized)', async () => {
    const result = await captureAlias(() =>
      buildProgram().parseAsync(['node', 'loom', 'finalize', 'epic-008'])
    );
    assert.equal(result.exitCode, 1);
  });
});

describe('loom reconcile (alias) — redirect notice', () => {
  it('writes "→ use loom recover <epic-id>" to stderr before delegating', async () => {
    const result = await captureAlias(() =>
      buildProgram().parseAsync(['node', 'loom', 'reconcile', 'epic-009'])
    );
    const allStderr = result.stderrWrites.join('');
    assert.ok(
      allStderr.includes('→ use loom recover epic-009'),
      `expected redirect in stderr; got: ${JSON.stringify(allStderr)}`
    );
  });

  it('delegates to runRecover (exits non-zero when loom is not initialized)', async () => {
    const result = await captureAlias(() =>
      buildProgram().parseAsync(['node', 'loom', 'reconcile', 'epic-009'])
    );
    assert.equal(result.exitCode, 1);
  });
});

describe('loom epic (alias) — redirect notice', () => {
  it('writes "→ use loom weave <brief>" to stderr (redirect is written before delegate init check)', async () => {
    // No policy.yaml — runWeave fails fast on the init check, but the redirect
    // is written first by the stub action.
    const result = await captureAlias(() =>
      buildProgram().parseAsync(['node', 'loom', 'epic', 'some brief'])
    );
    const allStderr = result.stderrWrites.join('');
    assert.ok(
      allStderr.includes('→ use loom weave <brief>'),
      `redirect must be written before the delegate check; got: ${JSON.stringify(allStderr)}`
    );
  });

  it('delegates to runWeave (exits non-zero when loom is not initialized)', async () => {
    const result = await captureAlias(() =>
      buildProgram().parseAsync(['node', 'loom', 'epic', 'some brief'])
    );
    assert.equal(result.exitCode, 1, 'runWeave must fail fast with exit 1 when not initialized');
  });
});

describe('loom project (alias) — redirect notice', () => {
  it('writes "→ use loom projects" to stderr before delegating', async () => {
    const result = await captureAlias(() =>
      buildProgram().parseAsync(['node', 'loom', 'project'])
    );
    const allStderr = result.stderrWrites.join('');
    assert.ok(
      allStderr.includes('→ use loom projects'),
      `expected redirect in stderr; got: ${JSON.stringify(allStderr)}`
    );
  });

  it('delegates to runProjects (prints no-projects message when registry is empty)', async () => {
    const result = await captureAlias(() =>
      buildProgram().parseAsync(['node', 'loom', 'project'])
    );
    const allLogs = result.logs.join('');
    assert.ok(
      allLogs.includes('No loom projects registered'),
      `expected no-projects message; got logs: ${JSON.stringify(result.logs)}`
    );
  });
});

// ─── Integration: CLI --help exclusion ────────────────────────────────────────

describe('loom --help — deprecated aliases absent', () => {
  const program = buildProgram();
  const help = program.helpInformation();
  const ALIASES = ['publish', 'finalize', 'reconcile', 'epic', 'project'] as const;

  for (const name of ALIASES) {
    it(`"${name}" is absent from loom --help`, () => {
      const cmdLinePattern = new RegExp(`^\\s+${name}\\b`, 'm');
      assert.ok(
        !cmdLinePattern.test(help),
        `"${name}" must not appear as a command line in loom --help`
      );
    });
  }
});

describe('loom projects --help — [project-root] appears', () => {
  it('projects command help includes [project-root] as optional positional', () => {
    const program = buildProgram();
    const projectsCmd = program.commands.find((c) => c.name() === 'projects');
    assert.ok(projectsCmd, 'projects command must be registered');
    const projectsHelp = projectsCmd.helpInformation();
    assert.ok(
      projectsHelp.includes('[project-root]'),
      `[project-root] must appear in loom projects --help; got:\n${projectsHelp}`
    );
  });
});

// ─── Unit: runProjects enhancement ───────────────────────────────────────────

describe('runProjects — no argument (existing behavior unchanged)', () => {
  it('lists all registered projects', () => {
    const reg = new ProjectRegistry();
    const dirA = fs.mkdtempSync(path.join(os.tmpdir(), 'loom-proj-a-'));
    const dirB = fs.mkdtempSync(path.join(os.tmpdir(), 'loom-proj-b-'));

    const origLog = console.log;
    const logs: string[] = [];
    console.log = (...args: unknown[]) => logs.push(args.map(String).join(' '));

    try {
      reg.register(dirA);
      reg.register(dirB);
      runProjects();
    } finally {
      console.log = origLog;
      fs.rmSync(dirA, { recursive: true, force: true });
      fs.rmSync(dirB, { recursive: true, force: true });
    }

    const out = logs.join('\n');
    assert.ok(out.includes(dirA), 'output must include project A root');
    assert.ok(out.includes(dirB), 'output must include project B root');
  });

  it('prints no-projects message when registry is empty', () => {
    const origLog = console.log;
    const logs: string[] = [];
    console.log = (...args: unknown[]) => logs.push(args.map(String).join(' '));

    try {
      runProjects();
    } finally {
      console.log = origLog;
    }

    const out = logs.join('\n');
    assert.ok(out.includes('No loom projects registered'), `got: ${out}`);
  });
});

describe('runProjects — with project-root argument', () => {
  let projectDir: string;
  let loomHomeForProject: string;

  beforeEach(() => {
    projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'loom-projdir-'));
    loomHomeForProject = fs.mkdtempSync(path.join(os.tmpdir(), 'loom-projhome-'));
    // Point LOOM_HOME to our test home so the registry is isolated
    process.env.LOOM_HOME = loomHomeForProject;
  });

  afterEach(() => {
    fs.rmSync(projectDir, { recursive: true, force: true });
    fs.rmSync(loomHomeForProject, { recursive: true, force: true });
  });

  it('shows only the matching project when root is provided', () => {
    const reg = new ProjectRegistry();
    const otherDir = fs.mkdtempSync(path.join(os.tmpdir(), 'loom-other-'));

    const origLog = console.log;
    const logs: string[] = [];
    console.log = (...args: unknown[]) => logs.push(args.map(String).join(' '));

    try {
      reg.register(projectDir);
      reg.register(otherDir);
      runProjects(projectDir);
    } finally {
      console.log = origLog;
      fs.rmSync(otherDir, { recursive: true, force: true });
    }

    const out = logs.join('\n');
    assert.ok(out.includes(projectDir), 'output must include the requested project root');
    assert.ok(!out.includes(path.basename(otherDir)), 'output must NOT include the other project');
  });

  it('shows latest epic when a project with epics is filtered', () => {
    resetDatabaseForTest();
    const reg = new ProjectRegistry();
    reg.register(projectDir);

    // Seed two epics using the openDatabase singleton (same loomDir)
    const projLoomDir = path.join(projectDir, '.loom');
    fs.mkdirSync(projLoomDir, { recursive: true });
    // Write minimal policy so prepareRepoState resolves the DB path
    fs.writeFileSync(path.join(projLoomDir, 'policy.yaml'), `loom_home: ${loomHomeForProject}\n`);

    const db = openDatabase(projLoomDir);
    const store = new EpicStore(db);
    store.create('epic-001', 'First Epic');
    store.create('epic-002', 'Second Epic');
    resetDatabaseForTest();

    const origLog = console.log;
    const logs: string[] = [];
    console.log = (...args: unknown[]) => logs.push(args.map(String).join(' '));

    try {
      runProjects(projectDir);
    } finally {
      console.log = origLog;
    }

    const out = logs.join('\n');
    assert.ok(out.includes(projectDir), 'root in output');
    assert.ok(out.includes('epic-002'), 'latest epic id in output');
    assert.ok(out.includes('Second Epic'), 'latest epic title in output');
  });

  it('prints a clear error message for a non-registered root (no crash)', () => {
    const origErr = console.error;
    const errors: string[] = [];
    const origExitCode = process.exitCode;
    console.error = (...args: unknown[]) => errors.push(args.map(String).join(' '));

    try {
      runProjects('/nonexistent/path/that/does/not/exist');
    } finally {
      console.error = origErr;
    }

    // Capture before restoring, then reset to avoid cross-test contamination
    const capturedExitCode = process.exitCode;
    process.exitCode = origExitCode as typeof process.exitCode;

    assert.equal(errors.length, 1, 'exactly one error message');
    const msg = errors[0];
    assert.ok(!msg.includes('Error:') && !msg.includes(' at '), 'no stack trace');
    assert.ok(
      msg.includes('not registered') || msg.includes('/nonexistent/path'),
      `message must reference the path or say not registered; got: ${msg}`
    );
    assert.equal(capturedExitCode, 1, 'process.exitCode must be set to 1');
  });
});
