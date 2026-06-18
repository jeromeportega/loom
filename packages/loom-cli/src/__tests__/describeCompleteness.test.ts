import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { Command } from 'commander';
import { CommandDescriptionSchema } from '../describe/schema.js';
import type { CommandDescription } from '../describe/schema.js';
import { collectSpecs, enumerateRegisteredCommands } from '../describe/registry.js';
import { applySpec } from '../describe/applySpec.js';

// Builds a fresh Commander command for a single spec — used only for ADR-003 drift checks.
// Handles top-level (1-part) and grouped (2-part) spec names.
// Throws for 3+ segments so the caller discovers unsupported depth early.
function buildCommandForSpec(spec: CommandDescription): Command {
  const root = new Command('__test__');
  const parts = spec.name.split(' ');
  if (parts.length === 1) {
    return applySpec(root.command(parts[0]), spec);
  }
  if (parts.length === 2) {
    const parent = root.command(parts[0]);
    return applySpec(parent.command(parts[1]), spec);
  }
  throw new Error(`buildCommandForSpec: spec "${spec.name}" has ${parts.length} segments (max 2)`);
}

// ---------------------------------------------------------------------------
// Main suite — derives inventory from the live spec registry (ADR-001).
// Iterates collectSpecs() directly so the schema and drift checks are
// non-circular: spec validity is asserted independently of Commander wiring.
// ---------------------------------------------------------------------------

describe('describe completeness: every registered command has a valid spec', () => {
  const allSpecs = collectSpecs();
  const specsByName = new Map<string, CommandDescription>(allSpecs.map((s) => [s.name, s]));

  it('registry is non-empty (collectSpecs returns at least one spec)', () => {
    assert.ok(allSpecs.length > 0, 'collectSpecs() must return at least one spec');
  });

  it('at least 10 commands enumerated (dynamic count, not a hardcoded list)', () => {
    assert.ok(
      allSpecs.length >= 10,
      `Expected at least 10 specs in collectSpecs(), got ${allSpecs.length}`
    );
  });

  it('guard subcommands appear as full-path entries in the spec names', () => {
    // Verifies 2-part spec names are correctly authored for guard subcommands.
    for (const expected of ['guard check', 'guard hook']) {
      assert.ok(
        specsByName.has(expected),
        `Expected a spec named "${expected}" in collectSpecs()`
      );
    }
  });

  it('spec names are unique across collectSpecs()', () => {
    const names = allSpecs.map((s) => s.name);
    const unique = new Set(names);
    const duplicates = names.filter((n, i) => names.indexOf(n) !== i);
    assert.equal(
      unique.size,
      names.length,
      `Duplicate spec names: ${duplicates.join(', ')}`
    );
  });

  it('no spec has 3+ name segments (unsupported nesting depth)', () => {
    const deep = allSpecs.filter((s) => s.name.split(' ').length > 2);
    assert.equal(
      deep.length,
      0,
      `Specs with 3+ name segments are not supported: ${deep.map((s) => s.name).join(', ')}`
    );
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

  it('ADR-003 drift check: spec options round-trip through applySpec without drift', () => {
    // For each spec, wire it into a fresh Commander and compare option sets.
    // Both sides use the "--flag" convention so no normalization is needed.
    for (const spec of allSpecs) {
      const cmd = buildCommandForSpec(spec);
      const specOptionNames = new Set(spec.options.map((o) => o.name));
      // Commander adds --help automatically; exclude it.
      const cmdOptionNames = new Set(
        cmd.options
          .filter((o) => o.long !== '--help')
          .map((o) => o.long ?? '')
          .filter(Boolean)
      );

      for (const optName of specOptionNames) {
        assert.ok(
          cmdOptionNames.has(optName),
          `Spec "${spec.name}" declares option "${optName}" but Commander does not register it via applySpec — drift detected`
        );
      }
      for (const optName of cmdOptionNames) {
        assert.ok(
          specOptionNames.has(optName),
          `Spec "${spec.name}": Commander registered option "${optName}" via applySpec but spec does not declare it — drift detected`
        );
      }
    }
  });
});

// ---------------------------------------------------------------------------
// Meta-proof — demonstrates the tripwire goes red for missing / invalid specs.
// Uses enumerateRegisteredCommands with synthetic programs to avoid the
// circular dependency that would arise from using the spec-derived program.
// ---------------------------------------------------------------------------

describe('meta-proof: completeness tripwire fails loud for bad specs', () => {
  it('detects a registered command with no matching spec', () => {
    const testProgram = new Command('loom-test');
    testProgram.command('phantom-cmd');

    const testNames = enumerateRegisteredCommands(testProgram);
    assert.ok(testNames.includes('phantom-cmd'), '"phantom-cmd" must appear in enumeration');

    const specsByName = new Map(collectSpecs().map((s) => [s.name, s]));
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

  it('inventory is registry-driven: adding a command to a program makes it enumerable without code changes here', () => {
    // Proves enumerateRegisteredCommands is dynamic — the inventory grows when
    // a new command is registered, so a hardcoded list would immediately lag.
    const base = new Command('loom-test');
    base.command('existing-cmd');
    const baseNames = enumerateRegisteredCommands(base);

    const augmented = new Command('loom-test');
    augmented.command('existing-cmd');
    augmented.command('future-cmd');
    const augmentedNames = enumerateRegisteredCommands(augmented);

    assert.ok(
      augmentedNames.includes('future-cmd'),
      '"future-cmd" must appear when added to the program — proving the inventory is registry-driven, not hardcoded'
    );
    assert.ok(
      !baseNames.includes('future-cmd'),
      'base names must not include "future-cmd" (it was added only to the augmented program)'
    );
  });
});
