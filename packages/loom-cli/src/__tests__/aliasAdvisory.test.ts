import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { MockLLMClient, resetDatabaseForTest } from '@loom-ai/core';
import type { LLMRequest } from '@loom-ai/core';
import { runEpic } from '../commands/epic.js';
import { runRun } from '../commands/run.js';
import { cursorModelCheck } from '../commands/doctor.js';

/**
 * story-007-002 — the FR-1(b) alias advisory must surface at all three call
 * sites (loom epic, loom run, loom doctor) with NO per-site special-casing:
 *
 *   - alias (status:'ok', advisory:true)  → warn, proceed (never exit 1)
 *   - invalid                              → console.error + exit 1
 *   - exact match (status:'ok')            → silent
 *   - doctor alias                         → a `warn` Check (required:false), exit 0
 *
 * Every case stubs `cursor-agent --list-models` with a fixture shell script and
 * threads its path through the call sites' test seam — the real
 * `validateCursorModels` runs, so the advisory text is the SHARED function's
 * output, never re-derived in the call site. No real cursor-agent is spawned.
 */

const LOOM_CLI = path.resolve(__dirname, '../index.js');

// The id the operator types as an alias; the list carries only its decorated
// single-token expansion, forcing the boundary-prefix alias tier.
const ALIAS_CONFIGURED = 'claude-opus-4-8';
const ALIAS_RESOLVED = 'claude-opus-4-8-high';
const EXACT_ID = 'sonnet-4';
const INVALID_ID = 'made-up-model';

// A list with the exact id present (for the exact-match case) AND a decorated
// expansion of `claude-opus-4-8` but NOT `claude-opus-4-8` itself (for alias).
const ALIAS_LIST = `Available models

${EXACT_ID} - Sonnet 4
${ALIAS_RESOLVED} - Opus 4.8 High
`;

let tmpDir: string;
let prevCwd: string;
let prevLoomHome: string | undefined;
let loomHomeDir: string;
let listModelsBin: string;
let missingBin: string;

/** Writes a `cursor-agent` stub that prints `fixture` for any args. */
function writeListModelsStub(dir: string, name: string, fixture: string): string {
  const fixturePath = path.join(dir, `${name}.txt`);
  fs.writeFileSync(fixturePath, fixture);
  const bin = path.join(dir, name);
  fs.writeFileSync(bin, `#!/bin/sh\ncat ${JSON.stringify(fixturePath)}\n`);
  fs.chmodSync(bin, 0o755);
  return bin;
}

/** Minimal cursor-cli policy with the given cursor_model. */
function writeCursorPolicy(model: string): void {
  fs.writeFileSync(
    path.join(tmpDir, '.loom', 'policy.yaml'),
    `agents:\n  llm_backend: cursor-cli\n  worker_backend: cursor-cli\n  cursor_model: ${model}\n`
  );
}

/**
 * A pipeline responder that lets runEpic run all the way through the refiner
 * and the four planner stages (so a passing model check means it proceeds to
 * completion and exits null, not 1). The brief gate always passes.
 */
function pipelineResponder() {
  return (req: LLMRequest): string => {
    const last = req.messages[req.messages.length - 1].content;
    if (last.includes('Apply the discipline above')) {
      return (
        '```json\n' +
        JSON.stringify({
          ready: true,
          quality_score: 9,
          refined_brief: '# Brief\n\n## Goal\nShip it.',
          critique: {
            strong_points: ['clear'],
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
    }
    if (last.includes('Produce the project brief')) return '# Brief\n\n## The Problem\nA gap.';
    if (last.includes('Headless task A: produce the PRD')) return '# PRD\n\n## Goals\nShip it.';
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
    if (last.includes('Headless task B: produce per-story')) return '```json\n{"tech_notes":{}}\n```';
    throw new Error('unexpected planning message: ' + last.slice(0, 60));
  };
}

interface Captured {
  exitCode: number | null;
  warns: string[];
  errors: string[];
}

/** Runs `fn`, capturing process.exit, console.warn, and console.error. */
async function capture(fn: () => Promise<void> | void): Promise<Captured> {
  const origExit = process.exit;
  const origLog = console.log;
  const origWarn = console.warn;
  const origErr = console.error;
  const warns: string[] = [];
  const errors: string[] = [];
  let exitCode: number | null = null;
  class ExitSignal extends Error {}
  (process as unknown as { exit: (c?: number) => never }).exit = (c?: number) => {
    exitCode = c ?? 0;
    throw new ExitSignal();
  };
  console.log = () => {};
  console.warn = (...args: unknown[]) => {
    warns.push(args.map(String).join(' '));
  };
  console.error = (...args: unknown[]) => {
    errors.push(args.map(String).join(' '));
  };
  try {
    await fn();
  } catch (err) {
    if (!(err instanceof ExitSignal)) throw err;
  } finally {
    process.exit = origExit;
    console.log = origLog;
    console.warn = origWarn;
    console.error = origErr;
  }
  return { exitCode, warns, errors };
}

const BRIEF = 'Build a small demo feature for verifying the alias advisory path end to end.';

beforeEach(() => {
  resetDatabaseForTest();
  prevLoomHome = process.env.LOOM_HOME;
  loomHomeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'loom-cli-home-'));
  process.env.LOOM_HOME = loomHomeDir;

  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'loom-alias-advisory-'));
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: tmpDir });
  execFileSync('git', ['config', 'user.email', 'test@loom.dev'], { cwd: tmpDir });
  execFileSync('git', ['config', 'user.name', 'Loom Test'], { cwd: tmpDir });
  execFileSync('git', ['config', 'commit.gpgsign', 'false'], { cwd: tmpDir });
  fs.writeFileSync(path.join(tmpDir, 'README.md'), '# test\n');
  execFileSync('git', ['add', '.'], { cwd: tmpDir });
  execFileSync('git', ['commit', '-q', '-m', 'initial'], { cwd: tmpDir });
  execFileSync('node', [LOOM_CLI, 'init'], { cwd: tmpDir, stdio: 'ignore' });

  listModelsBin = writeListModelsStub(tmpDir, 'cursor-agent-stub', ALIAS_LIST);
  missingBin = path.join(tmpDir, 'cursor-agent-missing');

  prevCwd = process.cwd();
  process.chdir(tmpDir);
  resetDatabaseForTest();
});

afterEach(() => {
  process.chdir(prevCwd);
  resetDatabaseForTest();
  fs.rmSync(tmpDir, { recursive: true, force: true });
  fs.rmSync(loomHomeDir, { recursive: true, force: true });
  if (prevLoomHome === undefined) delete process.env.LOOM_HOME;
  else process.env.LOOM_HOME = prevLoomHome;
});

describe('loom epic — alias advisory (runEpic)', () => {
  it('alias: warns with the advisory and PROCEEDS (no exit 1)', async () => {
    writeCursorPolicy(ALIAS_CONFIGURED);
    const llm = new MockLLMClient(pipelineResponder());
    const { exitCode, warns, errors } = await capture(() =>
      runEpic(BRIEF, { llm, cursorBin: listModelsBin })
    );

    assert.equal(exitCode, null, 'alias must never exit non-zero — the command proceeds');
    assert.deepEqual(errors, [], 'an alias is not an error');
    const advisory = warns.find((w) => w.includes(ALIAS_CONFIGURED) && w.includes(ALIAS_RESOLVED));
    assert.ok(advisory, 'the FR-1(b) advisory was written to console.warn');
    // The text is the shared function's, not re-derived: it recommends pinning.
    assert.ok(advisory!.includes('set the explicit id'), 'advisory text comes from validateCursorModels');
  });

  it('invalid: console.error the message then exit 1', async () => {
    writeCursorPolicy(INVALID_ID);
    const llm = new MockLLMClient(pipelineResponder());
    const { exitCode, warns, errors } = await capture(() =>
      runEpic(BRIEF, { llm, cursorBin: listModelsBin })
    );

    assert.equal(exitCode, 1, 'a confirmed-invalid id exits non-zero');
    assert.ok(
      errors.some((e) => e.includes(INVALID_ID)),
      'the invalid message is written to console.error'
    );
    assert.deepEqual(warns, [], 'invalid is an error, not a warning');
  });

  it('exact match: silent (no warn, no error) and proceeds', async () => {
    writeCursorPolicy(EXACT_ID);
    const llm = new MockLLMClient(pipelineResponder());
    const { exitCode, warns, errors } = await capture(() =>
      runEpic(BRIEF, { llm, cursorBin: listModelsBin })
    );

    assert.equal(exitCode, null, 'an exact match proceeds');
    assert.deepEqual(errors, [], 'no error on an exact match');
    assert.equal(
      warns.filter((w) => w.includes('cursor_model')).length,
      0,
      'an exact match produces no advisory'
    );
  });
});

describe('loom run — alias advisory (runRun)', () => {
  it('alias: warns with the advisory and PROCEEDS (no exit 1)', async () => {
    writeCursorPolicy(ALIAS_CONFIGURED);
    // No approved epics: the supervisor returns early, so runRun proceeds past
    // the model check without spawning a single worker.
    const { exitCode, warns, errors } = await capture(() =>
      runRun([], { cursorBin: listModelsBin })
    );

    assert.equal(exitCode, null, 'alias must never exit non-zero — the run proceeds');
    assert.deepEqual(errors, [], 'an alias is not an error');
    const advisory = warns.find((w) => w.includes(ALIAS_CONFIGURED) && w.includes(ALIAS_RESOLVED));
    assert.ok(advisory, 'the FR-1(b) advisory was written to console.warn');
    assert.ok(advisory!.includes('set the explicit id'), 'advisory text comes from validateCursorModels');
  });

  it('invalid: console.error the message then exit 1', async () => {
    writeCursorPolicy(INVALID_ID);
    const { exitCode, errors } = await capture(() => runRun([], { cursorBin: listModelsBin }));

    assert.equal(exitCode, 1, 'a confirmed-invalid id exits non-zero');
    assert.ok(
      errors.some((e) => e.includes(INVALID_ID)),
      'the invalid message is written to console.error'
    );
  });

  it('exact match: silent (no cursor_model warn, no error) and proceeds', async () => {
    writeCursorPolicy(EXACT_ID);
    const { exitCode, warns, errors } = await capture(() =>
      runRun([], { cursorBin: listModelsBin })
    );

    assert.equal(exitCode, null, 'an exact match proceeds');
    assert.deepEqual(errors, [], 'no error on an exact match');
    assert.equal(
      warns.filter((w) => w.includes('cursor_model')).length,
      0,
      'an exact match produces no advisory'
    );
  });
});

describe('loom doctor — alias advisory (cursorModelCheck)', () => {
  it('alias: renders a warn Check (required:false) carrying the advisory', () => {
    writeCursorPolicy(ALIAS_CONFIGURED);
    const check = cursorModelCheck(tmpDir, listModelsBin);
    assert.ok(check, 'a cursor-cli backend yields a check');
    assert.equal(check!.name, 'cursor_model');
    assert.equal(check!.ok, false, 'an alias is not a clean pass — it is a warn');
    assert.equal(check!.required, false, 'a warn must never flip doctor to FAIL/exit 1');
    assert.ok(check!.detail.includes(ALIAS_CONFIGURED));
    assert.ok(check!.detail.includes(ALIAS_RESOLVED), 'the advisory recommends the explicit id');
    assert.ok(check!.detail.includes('set the explicit id'), 'detail is the shared advisory text');
  });

  it('invalid: renders a FAIL Check (required:true)', () => {
    writeCursorPolicy(INVALID_ID);
    const check = cursorModelCheck(tmpDir, listModelsBin);
    assert.ok(check);
    assert.equal(check!.ok, false);
    assert.equal(check!.required, true, 'a confirmed-invalid id is a FAIL → doctor exits 1');
    assert.ok(check!.detail.includes(INVALID_ID));
  });

  it('exact match: renders a clean pass Check (silent, required:false)', () => {
    writeCursorPolicy(EXACT_ID);
    const check = cursorModelCheck(tmpDir, listModelsBin);
    assert.ok(check);
    assert.equal(check!.ok, true, 'an exact match is a clean pass');
    assert.equal(check!.required, false);
    assert.ok(check!.detail.includes('valid Cursor model'));
    assert.ok(!check!.detail.includes('set the explicit id'), 'no advisory on an exact match');
  });

  it('unavailable probe: renders a warn Check (required:false), same branch as alias', () => {
    writeCursorPolicy(ALIAS_CONFIGURED);
    const check = cursorModelCheck(tmpDir, missingBin);
    assert.ok(check);
    assert.equal(check!.ok, false, 'a degraded probe warns');
    assert.equal(check!.required, false, "'unavailable' is a warn, never a FAIL");
  });

  it('no cursor-cli backend: no check at all', () => {
    fs.writeFileSync(
      path.join(tmpDir, '.loom', 'policy.yaml'),
      'agents:\n  llm_backend: claude-cli\n  worker_backend: claude-code\n'
    );
    const check = cursorModelCheck(tmpDir, listModelsBin);
    assert.equal(check, undefined, 'nothing to validate when no cursor backend is configured');
  });
});

describe('regression guard — identical branch shape across all three sites', () => {
  it("'unavailable' and 'advisory' both warn-and-proceed everywhere (no per-site special-casing)", async () => {
    // 'unavailable' (probe missing) and 'advisory' (alias) must be treated
    // identically: warn, never exit 1. Proving they share the one branch.
    writeCursorPolicy(ALIAS_CONFIGURED);

    // runEpic — unavailable proceeds just like alias.
    const epicUnavail = await capture(() =>
      runEpic(BRIEF, { llm: new MockLLMClient(pipelineResponder()), cursorBin: missingBin })
    );
    assert.equal(epicUnavail.exitCode, null, 'runEpic proceeds on unavailable');
    assert.ok(epicUnavail.warns.length >= 1, 'runEpic warns on unavailable');

    // runRun — unavailable proceeds just like alias.
    const runUnavail = await capture(() => runRun([], { cursorBin: missingBin }));
    assert.equal(runUnavail.exitCode, null, 'runRun proceeds on unavailable');
    assert.ok(runUnavail.warns.length >= 1, 'runRun warns on unavailable');

    // doctor — unavailable and alias both produce a non-required warn Check.
    const docUnavail = cursorModelCheck(tmpDir, missingBin);
    const docAlias = cursorModelCheck(tmpDir, listModelsBin);
    assert.equal(docUnavail!.ok, false);
    assert.equal(docUnavail!.required, false);
    assert.equal(docAlias!.ok, false);
    assert.equal(docAlias!.required, false);
  });
});
