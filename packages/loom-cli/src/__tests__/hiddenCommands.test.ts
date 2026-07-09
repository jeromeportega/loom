/**
 * Tests for story-087-001: hidden-flag wiring for speculative and internal commands.
 *
 * Seven commands are hidden from `loom --help` but remain callable by explicit name:
 *   scan, opportunities, propose  (Signal-Scout / Flywheel)
 *   pull-guidance, describe, release, migrate  (internal plumbing)
 *
 * Commander v12 stores the hidden flag as `_hidden: boolean` on Command objects.
 * The test plan's `.hidden === true` assertion maps to `(cmd as any)._hidden === true`
 * in this Commander version; we verify both the internal flag and the help-output
 * behaviour (the user-visible contract).
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { buildProgram } from '../index.js';

// ─── Constants ───────────────────────────────────────────────────────────────

const HIDDEN_COMMANDS = [
  'scan',
  'opportunities',
  'propose',
  'pull-guidance',
  'describe',
  'release',
  'migrate',
  // story-087-003: deprecated aliases redirecting to recover / weave / projects
  'publish',
  'finalize',
  'reconcile',
  'epic',
  'project',
] as const;

// Commands that must remain visible in --help output after this story.
// Does NOT include commands hidden by sibling stories (publish, finalize, etc.)
// — we only assert the ones we know are operator-visible at this story's scope.
const SAMPLE_VISIBLE_COMMANDS = [
  'weave',
  'approve',
  'run',
  'status',
  'diff',
  'review',
  'artifacts',
  'traces',
  'audit',
  'autonomy',
  'init',
  'archive',
  'revert',
  'retry',
  'stop',
  'cost',
  'web',
];

// ─── Unit: Commander registration — hidden flag ───────────────────────────────

describe('buildProgram() — hidden-flag unit checks', () => {
  const program = buildProgram();

  for (const name of HIDDEN_COMMANDS) {
    it(`"${name}" command has _hidden === true (Commander v12 internal flag)`, () => {
      const cmd = program.commands.find((c) => c.name() === name);
      assert.ok(cmd, `command "${name}" must be registered in buildProgram()`);
      // Commander v12 stores the hidden flag as _hidden; the CommandOptions.hidden
      // parameter during .command(name, {hidden:true}) maps to this property.
      assert.equal(
        (cmd as unknown as { _hidden: boolean })._hidden,
        true,
        `"${name}" must have _hidden === true`
      );
    });
  }

  for (const name of SAMPLE_VISIBLE_COMMANDS) {
    it(`"${name}" command does NOT have _hidden === true`, () => {
      const cmd = program.commands.find((c) => c.name() === name);
      assert.ok(cmd, `command "${name}" must be registered in buildProgram()`);
      assert.equal(
        (cmd as unknown as { _hidden: boolean })._hidden,
        false,
        `"${name}" must NOT be hidden`
      );
    });
  }
});

// ─── Integration: help output exclusion ──────────────────────────────────────

describe('program.helpInformation() — hidden commands absent', () => {
  let helpText: string;

  it('produces help text', () => {
    const program = buildProgram();
    helpText = program.helpInformation();
    assert.ok(helpText.length > 0, 'helpInformation() must return non-empty text');
  });

  for (const name of HIDDEN_COMMANDS) {
    it(`"${name}" is absent from loom --help output`, () => {
      const program2 = buildProgram();
      const help = program2.helpInformation();
      // Match the command name as a standalone word to avoid false positives
      // (e.g. "scan" inside "signal-scan" should not count).
      const cmdLinePattern = new RegExp(`^\\s+${name}\\b`, 'm');
      assert.ok(
        !cmdLinePattern.test(help),
        `"${name}" must not appear in loom --help; found in: ${help}`
      );
    });
  }
});

// ─── Integration: hidden commands still callable ──────────────────────────────

describe('hidden commands — still registered and have help text', () => {
  const program = buildProgram();

  for (const name of HIDDEN_COMMANDS) {
    it(`"${name}" is still registered (callable by explicit name)`, () => {
      const cmd = program.commands.find((c) => c.name() === name);
      assert.ok(
        cmd !== undefined,
        `"${name}" must remain registered even though it is hidden from --help`
      );
    });

    it(`"${name}" has its own help text (loom ${name} --help would not say "unknown command")`, () => {
      const cmd = program.commands.find((c) => c.name() === name);
      assert.ok(cmd, `"${name}" must be registered`);
      // The command's own helpInformation() must not include "unknown command"
      const cmdHelp = cmd.helpInformation();
      assert.ok(
        !cmdHelp.toLowerCase().includes('unknown command'),
        `"${name}" help text must not say "unknown command"`
      );
      assert.ok(cmdHelp.length > 0, `"${name}" must produce non-empty help text`);
    });
  }
});

// ─── Edge: exact count reduction ─────────────────────────────────────────────

describe('visible command count — reduced by exactly the hidden set', () => {
  it(`exactly ${HIDDEN_COMMANDS.length} top-level commands are hidden`, () => {
    const program = buildProgram();
    const hiddenCount = program.commands.filter(
      (c) => (c as unknown as { _hidden: boolean })._hidden
    ).length;
    assert.equal(
      hiddenCount,
      HIDDEN_COMMANDS.length,
      `expected exactly ${HIDDEN_COMMANDS.length} hidden commands; got ${hiddenCount}`
    );
  });

  it(`visible command count has not dropped below (total - ${HIDDEN_COMMANDS.length})`, () => {
    const program = buildProgram();
    const total = program.commands.length;
    const visible = program.commands.filter(
      (c) => !(c as unknown as { _hidden: boolean })._hidden
    ).length;
    assert.ok(
      visible >= total - HIDDEN_COMMANDS.length,
      `visible commands (${visible}) dropped below expected minimum ${total - HIDDEN_COMMANDS.length}`
    );
  });
});

// ─── Edge: scan --help still prints usage (Flywheel pipeline usability) ───────

describe('scan --help — still produces usage text', () => {
  it('scan command help includes "Usage"', () => {
    const program = buildProgram();
    const scanCmd = program.commands.find((c) => c.name() === 'scan');
    assert.ok(scanCmd, 'scan must be registered');
    const help = scanCmd.helpInformation();
    assert.ok(
      help.toLowerCase().includes('usage'),
      `scan --help must include "Usage"; got: ${help}`
    );
  });
});
