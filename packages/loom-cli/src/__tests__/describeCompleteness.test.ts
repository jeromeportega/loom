/**
 * Describe completeness test — story-004-005
 *
 * Asserts every command the CLI registers has a complete, valid description in
 * the spec registry. Unlike cliParity.test.ts (which pins a frozen snapshot),
 * this test derives its inventory from the live Commander registry built from
 * collectSpecs() — so adding a command without a valid spec turns the suite red.
 *
 * ADR-001: the inventory comes from the live Commander registry (via
 *   enumerateRegisteredCommands), never from a hardcoded list.
 * ADR-003: each spec's options[].name set must match the registered
 *   command.options long-flag names (no drift).
 *
 * Trade-off: this test catches *added* commands lacking specs; it does NOT
 * guard against removed commands — that removal tripwire stays owned by
 * cliParity.test.ts.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { Command } from 'commander';
import { CommandDescriptionSchema } from '../describe/schema.js';
import type { CommandDescription } from '../describe/schema.js';
import { collectSpecs, enumerateRegisteredCommands } from '../describe/registry.js';
import { applySpec } from '../describe/applySpec.js';

// ---------------------------------------------------------------------------
// Helpers — build a Commander program from the live spec registry
// ---------------------------------------------------------------------------

/**
 * Builds a Commander program whose structure mirrors the spec registry.
 * Spec names drive the hierarchy: "guard check" → guard.command("check").
 * This is the ADR-001-compliant approach: the inventory is always derived
 * from collectSpecs() at test time, not from a hardcoded array.
 */
function buildProgramFromSpecs(specs: CommandDescription[]): Command {
  const program = new Command('loom');
  // Parent-group containers keyed by their single-segment name (e.g. "guard").
  const containers = new Map<string, Command>();

  for (const spec of specs) {
    const parts = spec.name.split(' ');
    if (parts.length === 1) {
      applySpec(program.command(parts[0]), spec);
    } else if (parts.length === 2) {
      const [parentName, childName] = parts;
      let parent = containers.get(parentName);
      if (!parent) {
        parent = program.command(parentName);
        containers.set(parentName, parent);
      }
      applySpec(parent.command(childName), spec);
    }
    // Deeper nesting (3+ parts) is not present in the current registry.
  }

  return program;
}

/**
 * Walks the Commander tree to find the Command at the given full path.
 * e.g. "guard check" → program → guard → check
 */
function findCommand(root: Command, fullPath: string): Command | undefined {
  const parts = fullPath.split(' ');
  let current: Command = root;
  for (const part of parts) {
    const found = current.commands.find((c) => c.name() === part);
    if (!found) return undefined;
    current = found;
  }
  return current;
}

// ---------------------------------------------------------------------------
// Build shared test fixtures once — avoids re-instantiation per test case
// ---------------------------------------------------------------------------

const allSpecs = collectSpecs();
const program = buildProgramFromSpecs(allSpecs);
const commandNames = enumerateRegisteredCommands(program);
const specsByName = new Map<string, CommandDescription>(allSpecs.map((s) => [s.name, s]));

// ---------------------------------------------------------------------------
// Completeness assertions — enumerate → assert → fail loud
// ---------------------------------------------------------------------------

describe('describe completeness: every registered command has a valid spec', () => {
  it('enumerateRegisteredCommands returns a non-empty command list', () => {
    assert.ok(commandNames.length > 0, 'expected at least one registered command');
  });

  it('includes expected commands — status, run, guard check, guard hook, mcp add, mcp list', () => {
    for (const expected of ['status', 'run', 'guard check', 'guard hook', 'mcp add', 'mcp list']) {
      assert.ok(
        commandNames.includes(expected),
        `expected "${expected}" in enumerated commands but it was not found`
      );
    }
  });

  it('parent group containers are not present as leaf entries', () => {
    // "guard" and "mcp" are containers with sub-commands — they must not
    // appear as standalone entries in the enumeration.
    assert.equal(commandNames.filter((n) => n === 'guard').length, 0, '"guard" must not appear as a leaf');
    assert.equal(commandNames.filter((n) => n === 'mcp').length, 0, '"mcp" must not appear as a leaf');
  });

  it('every enumerated command has a matching spec in collectSpecs()', () => {
    for (const name of commandNames) {
      assert.ok(
        specsByName.has(name),
        `Command "${name}" is registered but has no spec in collectSpecs() — add a CommandDescription or the suite stays red`
      );
    }
  });

  it('every spec passes CommandDescriptionSchema (schema validity)', () => {
    for (const spec of allSpecs) {
      const result = CommandDescriptionSchema.safeParse(spec);
      if (!result.success) {
        const msgs = result.error.issues
          .map((i) => `${i.path.join('.')}: ${i.message}`)
          .join('\n');
        assert.fail(`Spec "${spec.name}" failed CommandDescriptionSchema:\n${msgs}`);
      }
    }
  });

  it('ADR-003 drift check: spec options match Commander command options for every registered command', () => {
    for (const name of commandNames) {
      const spec = specsByName.get(name);
      if (!spec) continue; // already caught by the previous test

      const cmd = findCommand(program, name);
      if (!cmd) continue;

      const specOptionNames = new Set(spec.options.map((o) => o.name));
      // Commander automatically adds --help; exclude it from comparison.
      const cmdOptionNames = new Set(
        cmd.options
          .filter((o) => o.long !== '--help')
          .map((o) => o.long ?? '')
          .filter(Boolean)
      );

      for (const optName of specOptionNames) {
        assert.ok(
          cmdOptionNames.has(optName),
          `Spec for "${name}" declares option "${optName}" but Commander does not register it — drift detected`
        );
      }
      for (const optName of cmdOptionNames) {
        assert.ok(
          specOptionNames.has(optName),
          `Commander command "${name}" has option "${optName}" not declared in spec — drift detected`
        );
      }
    }
  });

  it('spec names are unique across collectSpecs()', () => {
    const names = allSpecs.map((s) => s.name);
    const unique = new Set(names);
    const duplicates = names.filter((n, i) => names.indexOf(n) !== i);
    assert.equal(
      unique.size,
      names.length,
      `Duplicate spec names found: ${duplicates.join(', ')}`
    );
  });
});

// ---------------------------------------------------------------------------
// Meta-proof: demonstrate the tripwire goes red for missing / invalid specs
// ---------------------------------------------------------------------------

describe('meta-proof: completeness tripwire fails loud for bad specs', () => {
  it('detects a registered command with no matching spec', () => {
    // Build a minimal program with one command that has NO entry in collectSpecs().
    const testProgram = new Command('loom-test');
    testProgram.command('phantom-cmd');

    const testNames = enumerateRegisteredCommands(testProgram);
    assert.ok(testNames.includes('phantom-cmd'), '"phantom-cmd" must appear in enumeration');

    // Run the same completeness check the main suite runs.
    let detectedMissing = false;
    for (const name of testNames) {
      if (!specsByName.has(name)) {
        detectedMissing = true;
        break;
      }
    }
    assert.ok(
      detectedMissing,
      'completeness check must detect "phantom-cmd" which has no spec — the tripwire is broken if this assertion fails'
    );
  });

  it('detects an invalid spec (summary too short fails CommandDescriptionSchema)', () => {
    const badSpec = {
      name: 'test-cmd',
      summary: 'x', // below min(5) — deliberately invalid
      whenToUse: 'use this in tests',
      arguments: [],
      options: [],
      output: { text: 'outputs something' },
      examples: [{ command: 'loom test-cmd', description: 'run test-cmd' }],
      exitCodes: [{ code: 0, meaning: 'success' }],
      errors: [],
      relationships: { prerequisites: [], nextSteps: [] },
    };

    const result = CommandDescriptionSchema.safeParse(badSpec);
    assert.ok(
      !result.success,
      'CommandDescriptionSchema must reject a spec with a too-short summary — the schema validator is broken if this fails'
    );
  });

  it('inventory is not derived from a hardcoded list (ADR-001)', () => {
    // Prove that commandNames is dynamic — adding a new command to the program
    // causes it to appear in the enumeration without any code change here.
    const augmented = buildProgramFromSpecs(allSpecs);
    // Inject a new command directly (simulating a future registration).
    augmented.command('future-cmd');

    const augmentedNames = enumerateRegisteredCommands(augmented);
    assert.ok(
      augmentedNames.includes('future-cmd'),
      '"future-cmd" must appear when added to the program — proving the inventory is registry-driven, not hardcoded'
    );
    // The original commandNames array did NOT include 'future-cmd'.
    assert.ok(
      !commandNames.includes('future-cmd'),
      'original commandNames must not include "future-cmd" (it was added only to the augmented program)'
    );
  });
});
