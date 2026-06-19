import { describe, it, beforeEach, afterEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { MockLLMClient, resetDatabaseForTest, EpicStore, openDatabase } from '@loom-ai/core';
import type { LLMRequest } from '@loom-ai/core';
import { runWeave } from '../commands/weave.js';
import { buildProgram } from '../index.js';
import { collectSpecs } from '../describe/registry.js';

const LOOM_CLI = path.resolve(__dirname, '../index.js');

// ── Helpers ────────────────────────────────────────────────────────────────────

function jsonBlock(obj: unknown): string {
  return '```json\n' + JSON.stringify(obj) + '\n```';
}

function pipelineResponder(opts: { ready: boolean; score: number }) {
  return (req: LLMRequest): string => {
    const last = req.messages[req.messages.length - 1].content;
    if (last.includes('Apply the discipline above')) {
      return jsonBlock({
        ready: opts.ready,
        quality_score: opts.score,
        refined_brief: '# Brief\n\n## Goal\nShip it.',
        critique: opts.ready
          ? { strong_points: ['clear'], ambiguities: [], missing_scope: [], untestable_claims: [], hidden_complexity: [] }
          : { strong_points: [], ambiguities: ['"fast" is not quantified'], missing_scope: [], untestable_claims: [], hidden_complexity: [] },
        questions: [],
        delta: { added_sections: [], clarifications: [], flagged_assumptions: [] },
      });
    }
    if (last.includes('Produce the project brief')) return '# Brief\n\n## The Problem\nA gap.';
    if (last.includes('Headless task A: produce the PRD')) return '# PRD\n\n## Goals\nShip it.';
    if (last.includes('Headless task B: produce the epic')) {
      const m = last.match(/starting at "(epic-\d+)"/);
      const eid = m ? m[1] : 'epic-001';
      const num = eid.slice(5);
      return jsonBlock({
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
      });
    }
    if (last.includes('Headless task A: produce the architecture'))
      return '# Architecture\n\n## Architecture Philosophy\nBoring tech.';
    if (last.includes('Headless task B: produce per-story')) return '```json\n{"tech_notes":{}}\n```';
    throw new Error('unexpected planning message: ' + last.slice(0, 60));
  };
}

async function runWeaveCapture(
  brief: string,
  opts: { force?: boolean; llm: MockLLMClient }
): Promise<number | null> {
  const origExit = process.exit;
  const origLog = console.log;
  const origErr = console.error;
  let exitCode: number | null = null;
  class ExitSignal extends Error {}
  (process as unknown as { exit: (c?: number) => never }).exit = (c?: number) => {
    exitCode = c ?? 0;
    throw new ExitSignal();
  };
  console.log = () => {};
  console.error = () => {};
  try {
    await runWeave(brief, opts);
  } catch (err) {
    if (!(err instanceof ExitSignal)) throw err;
  } finally {
    process.exit = origExit;
    console.log = origLog;
    console.error = origErr;
  }
  return exitCode;
}

// ── Fixtures ──────────────────────────────────────────────────────────────────

let tmpDir: string;
let prevCwd: string;
let prevLoomHome: string | undefined;
let loomHomeDir: string;

const BRIEF = 'Build a small demo feature for verifying the loom weave command works end to end.';

beforeEach(() => {
  resetDatabaseForTest();
  prevLoomHome = process.env.LOOM_HOME;
  loomHomeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'loom-cli-home-'));
  process.env.LOOM_HOME = loomHomeDir;

  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'loom-weave-'));
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: tmpDir });
  execFileSync('git', ['config', 'user.email', 'test@loom.dev'], { cwd: tmpDir });
  execFileSync('git', ['config', 'user.name', 'Loom Test'], { cwd: tmpDir });
  execFileSync('git', ['config', 'commit.gpgsign', 'false'], { cwd: tmpDir });
  fs.writeFileSync(path.join(tmpDir, 'README.md'), '# test\n');
  execFileSync('git', ['add', '.'], { cwd: tmpDir });
  execFileSync('git', ['commit', '-q', '-m', 'initial'], { cwd: tmpDir });
  execFileSync('node', [LOOM_CLI, 'init'], { cwd: tmpDir, stdio: 'ignore' });

  prevCwd = process.cwd();
  process.chdir(tmpDir);
  resetDatabaseForTest();
});

afterEach(() => {
  mock.restoreAll();
  process.chdir(prevCwd);
  resetDatabaseForTest();
  fs.rmSync(tmpDir, { recursive: true, force: true });
  fs.rmSync(loomHomeDir, { recursive: true, force: true });
  if (prevLoomHome === undefined) delete process.env.LOOM_HOME;
  else process.env.LOOM_HOME = prevLoomHome;
});

// ── Command registration (integration) ────────────────────────────────────────

describe('loom weave command registration', () => {
  it('loom weave is registered in buildProgram()', () => {
    const program = buildProgram();
    const names = program.commands.map((c) => c.name());
    assert.ok(names.includes('weave'), `Expected "weave" in registered commands; got: ${names.join(', ')}`);
  });

  it('loom weave appears in collectSpecs()', () => {
    const specs = collectSpecs();
    const weave = specs.find((s) => s.name === 'weave');
    assert.ok(weave, 'weave spec must be in collectSpecs()');
    assert.ok(weave!.summary.length > 0, 'weave spec must have a non-empty summary');
  });

  it('loom weave --help shows --force and --verbose options', () => {
    const help = execFileSync('node', [LOOM_CLI, 'weave', '--help'], {
      cwd: tmpDir,
      encoding: 'utf8',
    });
    assert.match(help, /--force/);
    assert.match(help, /--verbose/);
  });

  it('loom weave --help includes the brief argument', () => {
    const help = execFileSync('node', [LOOM_CLI, 'weave', '--help'], {
      cwd: tmpDir,
      encoding: 'utf8',
    });
    assert.match(help, /brief/);
  });
});

// ── Pure pass-through (unit) ─────────────────────────────────────────────────

describe('runWeave — pure pass-through to runEpic', () => {
  it('delegates to runEpic exactly once with the same (brief, opts)', async () => {
    // CommonJS module cache allows replacing the export on the shared object.
    // weave.ts compiles to: const epic_js_1 = require("./epic.js"); epic_js_1.runEpic(...)
    // Replacing epicMod.runEpic replaces what weave.ts calls at runtime.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const epicMod = require('../commands/epic.js') as { runEpic: (brief: string, opts: unknown) => Promise<void> };
    const calls: Array<[string, unknown]> = [];
    const origRunEpic = epicMod.runEpic;
    epicMod.runEpic = async (brief: string, opts: unknown) => {
      calls.push([brief, opts]);
    };

    const opts = { force: false as const, verbose: false as const };
    try {
      await runWeave(BRIEF, opts);
    } finally {
      epicMod.runEpic = origRunEpic;
    }

    assert.equal(calls.length, 1, 'runEpic must be called exactly once');
    assert.equal(calls[0][0], BRIEF, 'brief must be passed through unchanged');
    assert.deepEqual(calls[0][1], opts, 'opts must be passed through unchanged');
  });

  it('passes opts.force and opts.verbose verbatim — no extra keys injected', async () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const epicMod = require('../commands/epic.js') as { runEpic: (brief: string, opts: unknown) => Promise<void> };
    let captured: unknown;
    const origRunEpic = epicMod.runEpic;
    epicMod.runEpic = async (_brief: string, opts: unknown) => {
      captured = opts;
    };

    const opts = { force: true as const, verbose: true as const };
    try {
      await runWeave(BRIEF, opts);
    } finally {
      epicMod.runEpic = origRunEpic;
    }

    assert.deepEqual(captured, opts, 'opts object forwarded verbatim — no callbacks, no extra shared state');
  });

  it('passes empty opts when called without opts argument', async () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const epicMod = require('../commands/epic.js') as { runEpic: (brief: string, opts: unknown) => Promise<void> };
    let capturedOpts: unknown;
    const origRunEpic = epicMod.runEpic;
    epicMod.runEpic = async (_brief: string, opts: unknown) => {
      capturedOpts = opts;
    };

    try {
      await runWeave(BRIEF);
    } finally {
      epicMod.runEpic = origRunEpic;
    }

    assert.deepEqual(capturedOpts, {}, 'missing opts defaults to {}');
  });
});

// ── Integration: runWeave reaches runEpic and an epic is produced ─────────────

describe('loom weave integration: produces an epic via runEpic', () => {
  it('happy path: runWeave with a passing brief produces a planned epic', async () => {
    const llm = new MockLLMClient(pipelineResponder({ ready: true, score: 9 }));
    const exitCode = await runWeaveCapture(BRIEF, { llm });

    assert.equal(exitCode, null, 'exit 0 (null = no explicit exit) on a passing brief');
    resetDatabaseForTest();
    const db = openDatabase(path.join(tmpDir, '.loom'));
    const epic = new EpicStore(db).get('epic-001');
    assert.equal(epic?.status, 'planned', 'planner completed an epic via runEpic');
    resetDatabaseForTest();
  });

  it('gate rejection exits 1 (same behaviour as loom epic)', async () => {
    const llm = new MockLLMClient(pipelineResponder({ ready: false, score: 2 }));
    const exitCode = await runWeaveCapture(BRIEF, { force: false, llm });
    assert.equal(exitCode, 1, 'brief gate failure exits 1 — same as loom epic');
  });

  it('--force bypasses the gate and produces an epic (delegates to runEpic --force)', async () => {
    const llm = new MockLLMClient(pipelineResponder({ ready: false, score: 2 }));
    const exitCode = await runWeaveCapture(BRIEF, { force: true, llm });
    assert.equal(exitCode, null, 'forced weave exits 0');

    resetDatabaseForTest();
    const db = openDatabase(path.join(tmpDir, '.loom'));
    const epic = new EpicStore(db).get('epic-001');
    assert.equal(epic?.status, 'planned', 'planner completed an epic when --force is passed');
    resetDatabaseForTest();
  });
});
