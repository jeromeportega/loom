import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { Command } from 'commander';
import type { CommandDescription, PositionalArg } from '../schema.js';
import { PositionalArgSchema } from '../schema.js';
import { renderHelpSupplement, renderValueMeanings } from '../helpSupplement.js';
import { applySpec } from '../applySpec.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeArgWithMeanings(): PositionalArg {
  return {
    name: 'level',
    type: 'enum',
    required: false,
    description: 'Autonomy level',
    values: ['full-auto', 'checkpoint', 'manual'],
    valueMeanings: {
      'full-auto': 'run continuously without pausing',
      'checkpoint': 'pause after each story for review',
      'manual': 'require explicit approval at each step',
    },
  };
}

function makeSpecWithMeaningsAndExitCodes(): CommandDescription {
  return {
    name: 'autonomy',
    summary: 'Set or show the autonomy level for an epic',
    whenToUse: 'Use to control autonomy.',
    arguments: [
      { name: 'epic-id', type: 'string', required: true, description: 'Epic id' },
      makeArgWithMeanings(),
    ],
    options: [],
    output: { text: 'Level shown or updated' },
    examples: [{ command: 'loom autonomy epic-001', description: 'Show level' }],
    exitCodes: [
      { code: 0, meaning: 'Level shown or updated' },
      { code: 1, meaning: 'Epic not found' },
    ],
    errors: [],
    relationships: { prerequisites: [], nextSteps: [] },
  };
}

function makeSpecWithExitCodesOnly(): CommandDescription {
  return {
    name: 'status',
    summary: 'Show the current state of all epics and stories',
    whenToUse: 'Use to check status.',
    arguments: [],
    options: [],
    output: { text: 'Table of epics' },
    examples: [{ command: 'loom status', description: 'Show status' }],
    exitCodes: [
      { code: 0, meaning: 'Success' },
      { code: 1, meaning: 'No loom project found' },
    ],
    errors: [],
    relationships: { prerequisites: [], nextSteps: [] },
  };
}

function makeSpecWithNoExtraBlocks(): CommandDescription {
  return {
    name: 'minimal',
    summary: 'Minimal command with no enum values or exit codes',
    whenToUse: 'Use for testing.',
    arguments: [],
    options: [],
    output: { text: 'Nothing' },
    examples: [{ command: 'loom minimal', description: 'Run minimal' }],
    exitCodes: [],
    errors: [],
    relationships: { prerequisites: [], nextSteps: [] },
  };
}

// ---------------------------------------------------------------------------
// renderValueMeanings
// ---------------------------------------------------------------------------

describe('renderValueMeanings — Values block generation', () => {
  it('emits a Values: block with each enum value and its meaning', () => {
    const arg = makeArgWithMeanings();
    const result = renderValueMeanings(arg);
    assert.ok(result.startsWith('Values:'), 'must start with "Values:"');
    assert.ok(result.includes('full-auto'), 'must include full-auto');
    assert.ok(result.includes('checkpoint'), 'must include checkpoint');
    assert.ok(result.includes('manual'), 'must include manual');
    assert.ok(result.includes('run continuously without pausing'), 'must include full-auto meaning');
    assert.ok(result.includes('pause after each story for review'), 'must include checkpoint meaning');
    assert.ok(result.includes('require explicit approval at each step'), 'must include manual meaning');
  });

  it('uses <value> — <meaning> format with em dash separator', () => {
    const arg = makeArgWithMeanings();
    const result = renderValueMeanings(arg);
    assert.ok(result.includes('— '), 'must use em dash separator');
    const lines = result.split('\n');
    const valueLine = lines.find(l => l.includes('full-auto'));
    assert.ok(valueLine, 'must have a full-auto line');
    assert.match(valueLine!, /full-auto.*—.*run continuously without pausing/);
  });

  it('aligns values with consistent padding before the em dash', () => {
    const arg = makeArgWithMeanings();
    const result = renderValueMeanings(arg);
    const lines = result.split('\n').filter(l => l.startsWith('  '));
    // All value lines must have — at the same column
    const dashPositions = lines.map(l => l.indexOf('—'));
    assert.ok(dashPositions.length > 0, 'must have value lines');
    const first = dashPositions[0];
    for (const pos of dashPositions) {
      assert.equal(pos, first, 'all em dash characters must be at the same column (aligned)');
    }
  });

  it('returns empty string when valueMeanings is absent', () => {
    const arg: PositionalArg = {
      name: 'level',
      type: 'enum',
      required: false,
      description: 'Autonomy level',
      values: ['a', 'b'],
    };
    assert.equal(renderValueMeanings(arg), '');
  });

  it('returns empty string when valueMeanings is an empty object', () => {
    const arg: PositionalArg = {
      name: 'level',
      type: 'enum',
      required: false,
      description: 'Autonomy level',
      values: ['a', 'b'],
      valueMeanings: {},
    };
    assert.equal(renderValueMeanings(arg), '');
  });
});

// ---------------------------------------------------------------------------
// renderHelpSupplement
// ---------------------------------------------------------------------------

describe('renderHelpSupplement — combined block', () => {
  it('emits both Values and Exit codes blocks when spec has both', () => {
    const spec = makeSpecWithMeaningsAndExitCodes();
    const result = renderHelpSupplement(spec);
    assert.ok(result.includes('Values:'), 'must include Values: block');
    assert.ok(result.includes('Exit codes:'), 'must include Exit codes: block');
    assert.ok(result.includes('full-auto'), 'must include enum values');
    assert.ok(result.includes('Level shown or updated'), 'must include exit code meaning');
  });

  it('emits only Exit codes block when no arg has valueMeanings', () => {
    const spec = makeSpecWithExitCodesOnly();
    const result = renderHelpSupplement(spec);
    assert.ok(!result.includes('Values:'), 'must NOT include Values: block');
    assert.ok(result.includes('Exit codes:'), 'must include Exit codes: block');
    assert.ok(result.includes('Success'), 'must include exit code meaning');
  });

  it('emits Exit codes with code and meaning on each line', () => {
    const spec = makeSpecWithExitCodesOnly();
    const result = renderHelpSupplement(spec);
    const lines = result.split('\n');
    const zeroLine = lines.find(l => /\b0\b/.test(l) && l.includes('Success'));
    const oneLine = lines.find(l => /\b1\b/.test(l) && l.includes('No loom project found'));
    assert.ok(zeroLine, 'must have a line for exit code 0');
    assert.ok(oneLine, 'must have a line for exit code 1');
  });

  it('returns empty string when exitCodes is empty and no valueMeanings', () => {
    const spec = makeSpecWithNoExtraBlocks();
    const result = renderHelpSupplement(spec);
    assert.equal(result, '', 'must return empty string when neither block applies');
  });

  it('returns empty string when spec has no arguments and empty exitCodes', () => {
    const spec: CommandDescription = {
      ...makeSpecWithNoExtraBlocks(),
      arguments: [],
      exitCodes: [],
    };
    assert.equal(renderHelpSupplement(spec), '');
  });
});

// ---------------------------------------------------------------------------
// Schema — valueMeanings refinement
// ---------------------------------------------------------------------------

describe('PositionalArgSchema — valueMeanings refinement', () => {
  it('accepts a spec with valueMeanings whose keys are a subset of values', () => {
    const result = PositionalArgSchema.safeParse({
      name: 'level',
      type: 'enum',
      required: false,
      description: 'Autonomy level',
      values: ['full-auto', 'checkpoint', 'manual'],
      valueMeanings: {
        'full-auto': 'run continuously',
        'checkpoint': 'pause after each story',
      },
    });
    assert.equal(result.success, true, 'partial valueMeanings (subset of values) must pass');
  });

  it('accepts a spec with all values covered by valueMeanings', () => {
    const result = PositionalArgSchema.safeParse(makeArgWithMeanings());
    assert.equal(result.success, true, 'complete valueMeanings must pass');
  });

  it('rejects a spec whose valueMeanings has a key not in values', () => {
    const result = PositionalArgSchema.safeParse({
      name: 'level',
      type: 'enum',
      required: false,
      description: 'Autonomy level',
      values: ['full-auto', 'checkpoint', 'manual'],
      valueMeanings: {
        'full-auto': 'run continuously',
        'unknown-level': 'this key is not in values',
      },
    });
    assert.equal(result.success, false, 'valueMeanings key not in values must fail');
    if (!result.success) {
      const msg = result.error.issues.map(i => i.message).join('\n');
      assert.match(msg, /valueMeanings keys must be a subset of values/);
    }
  });

  it('accepts a spec with no valueMeanings (backward compat)', () => {
    const result = PositionalArgSchema.safeParse({
      name: 'level',
      type: 'enum',
      required: false,
      description: 'Autonomy level',
      values: ['a', 'b'],
    });
    assert.equal(result.success, true, 'omitting valueMeanings must still pass (backward compat)');
  });
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function captureHelp(cmd: Command): string {
  let output = '';
  cmd.configureOutput({ writeOut: (str) => { output += str; } });
  cmd.outputHelp();
  return output;
}

// ---------------------------------------------------------------------------
// applySpec wiring — integration test
// ---------------------------------------------------------------------------

describe('applySpec wiring — help text integration', () => {
  it('adds help text after when supplement is non-empty', () => {
    const spec = makeSpecWithMeaningsAndExitCodes();
    const cmd = new Command('autonomy');
    cmd.exitOverride();
    applySpec(cmd, spec);
    const helpText = captureHelp(cmd);
    assert.ok(helpText.includes('Values:'), '--help must include Values: block');
    assert.ok(helpText.includes('Exit codes:'), '--help must include Exit codes: block');
    assert.ok(helpText.includes('full-auto'), '--help must list full-auto value');
    assert.ok(helpText.includes('Level shown or updated'), '--help must include exit code meaning');
  });

  it('does not add extra help text when supplement is empty', () => {
    const spec = makeSpecWithNoExtraBlocks();
    const cmd = new Command('minimal');
    cmd.exitOverride();
    applySpec(cmd, spec);
    const helpText = captureHelp(cmd);
    assert.ok(!helpText.includes('Values:'), '--help must NOT include Values: block');
    assert.ok(!helpText.includes('Exit codes:'), '--help must NOT include Exit codes: block');
  });
});

// ---------------------------------------------------------------------------
// Drift proof (NFR-3) — spec change flows through to --help
// ---------------------------------------------------------------------------

describe('NFR-3 drift proof — spec changes flow through to --help', () => {
  it('mutating exitCodes changes the --help output', () => {
    const spec1 = makeSpecWithMeaningsAndExitCodes();
    const cmd1 = new Command('test1');
    cmd1.exitOverride();
    applySpec(cmd1, spec1);
    const help1 = captureHelp(cmd1);

    const spec2: CommandDescription = {
      ...spec1,
      exitCodes: [
        { code: 0, meaning: 'DIFFERENT SUCCESS MESSAGE' },
        { code: 2, meaning: 'DIFFERENT ERROR CODE' },
      ],
    };
    const cmd2 = new Command('test2');
    cmd2.exitOverride();
    applySpec(cmd2, spec2);
    const help2 = captureHelp(cmd2);

    assert.ok(!help1.includes('DIFFERENT SUCCESS MESSAGE'), 'original help must not contain new meaning');
    assert.ok(help2.includes('DIFFERENT SUCCESS MESSAGE'), 'mutated spec must flow to --help');
    assert.ok(help2.includes('DIFFERENT ERROR CODE'), 'new exit code must appear in --help');
    assert.notEqual(help1, help2, '--help must differ after spec mutation');
  });

  it('mutating a value meaning changes the supplement output', () => {
    const spec1 = makeSpecWithMeaningsAndExitCodes();
    const result1 = renderHelpSupplement(spec1);

    const spec2: CommandDescription = {
      ...spec1,
      arguments: [
        spec1.arguments[0],
        {
          ...makeArgWithMeanings(),
          valueMeanings: {
            'full-auto': 'UPDATED MEANING FOR FULL-AUTO',
            'checkpoint': 'pause after each story for review',
            'manual': 'require explicit approval at each step',
          },
        },
      ],
    };
    const result2 = renderHelpSupplement(spec2);

    assert.ok(!result1.includes('UPDATED MEANING FOR FULL-AUTO'), 'original must not have new meaning');
    assert.ok(result2.includes('UPDATED MEANING FOR FULL-AUTO'), 'mutated spec must produce updated output');
    assert.notEqual(result1, result2, 'supplement must differ after spec mutation');
  });
});
