import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Command } from 'commander';
import { openDatabase, resetDatabaseForTest, EpicStore } from '@loom-ai/core';
import { spec, runAutonomy } from '../../commands/autonomy.js';
import { PositionalArgSchema } from '../schema.js';
import { applySpec } from '../applySpec.js';

// Literal expected output from renderValueMeanings for the level arg.
// maxLen('checkpoint')=10; full-auto(9)+3sp, checkpoint(10)+2sp, manual(6)+6sp.
const EXPECTED_MEANINGS =
  'Values:\n' +
  '  full-auto   — run continuously without pausing\n' +
  '  checkpoint  — pause after each story for review\n' +
  '  manual      — require explicit approval at each step';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function captureHelp(cmd: Command): string {
  let output = '';
  cmd.configureOutput({ writeOut: (str) => { output += str; }, writeErr: (str) => { output += str; } });
  cmd.outputHelp();
  return output;
}

interface Captured {
  logs: string[];
  errors: string[];
  exitCode: number | null;
}

function captureRun(fn: () => void): Captured {
  const origExit = process.exit;
  const origLog = console.log;
  const origErr = console.error;
  const logs: string[] = [];
  const errors: string[] = [];
  let exitCode: number | null = null;
  class ExitSignal extends Error {}
  (process as unknown as { exit: (c?: number) => never }).exit = (c?: number) => {
    exitCode = c ?? 0;
    throw new ExitSignal();
  };
  console.log = (...args: unknown[]) => { logs.push(args.map(String).join(' ')); };
  console.error = (...args: unknown[]) => { errors.push(args.map(String).join(' ')); };
  try {
    fn();
  } catch (err) {
    if (!(err instanceof ExitSignal)) throw err;
  } finally {
    process.exit = origExit;
    console.log = origLog;
    console.error = origErr;
  }
  return { logs, errors, exitCode };
}

// ---------------------------------------------------------------------------
// Schema validation — valueMeanings on the level arg
// ---------------------------------------------------------------------------

describe('autonomy spec — valueMeanings on level arg', () => {
  it('spec.arguments[1] exists and has valueMeanings', () => {
    const levelArg = spec.arguments[1];
    assert.ok(levelArg, 'spec.arguments[1] must exist');
    assert.ok(levelArg.valueMeanings, 'level arg must have valueMeanings');
  });

  it('valueMeanings keys exactly match values (full-auto, checkpoint, manual)', () => {
    const levelArg = spec.arguments[1];
    assert.ok(levelArg.values, 'level arg must have values');
    assert.ok(levelArg.valueMeanings, 'level arg must have valueMeanings');
    const valueSet = new Set(levelArg.values);
    const meaningKeys = Object.keys(levelArg.valueMeanings);
    assert.deepEqual(
      meaningKeys.sort(),
      ['checkpoint', 'full-auto', 'manual'],
      'valueMeanings must have exactly the three level keys',
    );
    for (const key of meaningKeys) {
      assert.ok(valueSet.has(key), `valueMeanings key "${key}" must be in values`);
    }
  });

  it('spec.arguments[1] validates against PositionalArgSchema with valueMeanings refinement', () => {
    const result = PositionalArgSchema.safeParse(spec.arguments[1]);
    assert.equal(result.success, true, 'level arg must pass PositionalArgSchema validation');
  });

  it('rejects valueMeanings with a key not present in values', () => {
    const result = PositionalArgSchema.safeParse({
      name: 'level',
      type: 'enum',
      required: false,
      description: 'Autonomy level',
      values: ['full-auto', 'checkpoint', 'manual'],
      valueMeanings: {
        'full-auto': 'run continuously without pausing',
        'unknown-level': 'this key is not in values',
      },
    });
    assert.equal(result.success, false, 'valueMeanings key not in values must fail refinement');
    if (!result.success) {
      const msg = result.error.issues.map((i: { message: string }) => i.message).join('\n');
      assert.match(msg, /valueMeanings keys must be a subset of values/);
    }
  });

  it('each level has a non-empty one-line meaning', () => {
    const meanings = spec.arguments[1].valueMeanings!;
    for (const [level, meaning] of Object.entries(meanings)) {
      assert.ok(meaning.length > 0, `meaning for "${level}" must be non-empty`);
      assert.ok(!meaning.includes('\n'), `meaning for "${level}" must be a single line`);
    }
  });
});

// ---------------------------------------------------------------------------
// --help enum block
// ---------------------------------------------------------------------------

describe('loom autonomy --help — Values block', () => {
  it('lists full-auto, checkpoint, and manual each with a one-line meaning', () => {
    const cmd = new Command('autonomy');
    cmd.exitOverride();
    applySpec(cmd, spec);
    const helpText = captureHelp(cmd);
    assert.ok(helpText.includes('Values:'), '--help must include Values: block');
    assert.ok(helpText.includes('full-auto'), '--help must list full-auto');
    assert.ok(helpText.includes('checkpoint'), '--help must list checkpoint');
    assert.ok(helpText.includes('manual'), '--help must list manual');
    assert.ok(helpText.includes('run continuously without pausing'), '--help must include full-auto meaning');
    assert.ok(helpText.includes('pause after each story for review'), '--help must include checkpoint meaning');
    assert.ok(helpText.includes('require explicit approval at each step'), '--help must include manual meaning');
  });

  it('--help also shows exit codes block', () => {
    const cmd = new Command('autonomy');
    cmd.exitOverride();
    applySpec(cmd, spec);
    const helpText = captureHelp(cmd);
    assert.ok(helpText.includes('Exit codes:'), '--help must include Exit codes: block');
  });

  it('Values: block appears before Exit codes: block in --help', () => {
    const cmd = new Command('autonomy');
    cmd.exitOverride();
    applySpec(cmd, spec);
    const helpText = captureHelp(cmd);
    const valuesIdx = helpText.indexOf('Values:');
    const exitCodesIdx = helpText.indexOf('Exit codes:');
    assert.ok(valuesIdx !== -1, '--help must have Values: block');
    assert.ok(exitCodesIdx !== -1, '--help must have Exit codes: block');
    assert.ok(valuesIdx < exitCodesIdx, 'Values: must appear before Exit codes: in --help');
  });
});

// ---------------------------------------------------------------------------
// No-level echo — integration tests with real DB
// ---------------------------------------------------------------------------

let tmpDir: string;
let loomDir: string;
let prevCwd: string;
let prevLoomHome: string | undefined;
let loomHomeDir: string;

const MINIMAL_POLICY = `git:\n  allowed_remotes: []\nagents:\n  min_brief_quality_score: 6\n  max_concurrent: 5\n  review_strategy: "comment"\n  skill_generation: "on"\n`;

describe('runAutonomy — no-level echo', () => {
  beforeEach(() => {
    resetDatabaseForTest();
    prevCwd = process.cwd();
    prevLoomHome = process.env.LOOM_HOME;
    loomHomeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'loom-autonomy-home-'));
    process.env.LOOM_HOME = loomHomeDir;
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'loom-autonomy-'));
    loomDir = path.join(tmpDir, '.loom');
    fs.mkdirSync(loomDir, { recursive: true });
    fs.writeFileSync(path.join(loomDir, 'policy.yaml'), MINIMAL_POLICY);
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

  function seedEpic(epicId = 'epic-001'): void {
    const db = openDatabase(loomDir);
    new EpicStore(db).create(epicId, `Test epic ${epicId}`);
  }

  it('prints the current level then all three levels with meanings', () => {
    seedEpic('epic-001');
    const { logs, exitCode } = captureRun(() => runAutonomy('epic-001', undefined));
    assert.equal(exitCode, null, 'must not call process.exit');
    const allOutput = logs.join('\n');
    // Current level line
    assert.ok(allOutput.includes('epic-001'), 'must include epic id');
    assert.ok(allOutput.includes('autonomy:'), 'must include "autonomy:"');
    // Values block
    assert.ok(allOutput.includes('Values:'), 'must include Values: block');
    assert.ok(allOutput.includes('full-auto'), 'must include full-auto');
    assert.ok(allOutput.includes('checkpoint'), 'must include checkpoint');
    assert.ok(allOutput.includes('manual'), 'must include manual');
    assert.ok(allOutput.includes('run continuously without pausing'), 'must include full-auto meaning');
    assert.ok(allOutput.includes('pause after each story for review'), 'must include checkpoint meaning');
    assert.ok(allOutput.includes('require explicit approval at each step'), 'must include manual meaning');
  });

  it('current level line appears before the Values: block', () => {
    seedEpic('epic-001');
    const { logs } = captureRun(() => runAutonomy('epic-001', undefined));
    const allOutput = logs.join('\n');
    const levelLineIdx = allOutput.indexOf('autonomy:');
    const valuesIdx = allOutput.indexOf('Values:');
    assert.ok(levelLineIdx !== -1, 'must have a current level line');
    assert.ok(valuesIdx !== -1, 'must have a Values: block');
    assert.ok(levelLineIdx < valuesIdx, 'current level must appear before Values: block');
  });

  it('divergence guard — no-level echo Values block is byte-identical to the expected literal', () => {
    seedEpic('epic-001');
    const { logs } = captureRun(() => runAutonomy('epic-001', undefined));
    const meaningsFromEcho = logs.find(l => l.includes('Values:'));
    assert.ok(meaningsFromEcho, 'must find a Values: block in echo output');
    assert.equal(
      meaningsFromEcho,
      EXPECTED_MEANINGS,
      'no-level echo Values block must match the expected literal meanings',
    );
  });

  it('divergence guard — no-level echo Values block matches the --help Values block', () => {
    seedEpic('epic-001');
    const { logs } = captureRun(() => runAutonomy('epic-001', undefined));
    const meaningsFromEcho = logs.find(l => l.includes('Values:'));
    assert.ok(meaningsFromEcho, 'must find a Values: block in echo output');

    const cmd = new Command('autonomy');
    cmd.exitOverride();
    applySpec(cmd, spec);
    const helpText = captureHelp(cmd);
    assert.ok(helpText.includes(meaningsFromEcho), '--help must contain the same Values block as the no-level echo');
  });

  it('--json flag in read mode still returns JSON without the Values block', () => {
    seedEpic('epic-001');
    const { logs, exitCode } = captureRun(() => runAutonomy('epic-001', undefined, { json: true }));
    assert.equal(exitCode, null, 'must not call process.exit');
    assert.ok(logs.length > 0, 'must produce output');
    const json = JSON.parse(logs[0]);
    assert.equal(json.id, 'epic-001');
    assert.ok(typeof json.autonomy_level === 'string', 'autonomy_level must be a string');
    const allOutput = logs.join('\n');
    assert.ok(!allOutput.includes('Values:'), '--json must not include Values: block');
  });
});
