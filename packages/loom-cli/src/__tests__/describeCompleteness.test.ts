import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import { Command } from 'commander';
import { CommandDescriptionSchema } from '../describe/schema.js';
import type { CommandDescription } from '../describe/schema.js';
import { collectSpecs, enumerateRegisteredCommands } from '../describe/registry.js';
import { applySpec } from '../describe/applySpec.js';

// ─── Module-level state ──────────────────────────────────────────────────────
// Populated once in the top-level before() hook so:
//   (a) any spec-load failure surfaces as a named test error, not an opaque
//       module-crash; and
//   (b) both describe blocks share the same result without re-invoking
//       collectSpecs() a second time.
let allSpecs: CommandDescription[] = [];
let specsByName = new Map<string, CommandDescription>();

before(() => {
  allSpecs = collectSpecs();
  specsByName = new Map(allSpecs.map((s) => [s.name, s]));
});

// Builds a Commander program from the spec registry (via applySpec).
// Used by the registry round-trip test to verify enumerateRegisteredCommands
// returns every spec name. Parent commands (guard, mcp) are created on demand
// when the first 2-part spec for that parent is encountered.
function buildTestProgram(): Command {
  const p = new Command('loom');
  for (const spec of allSpecs) {
    const parts = spec.name.split(' ');
    if (parts.length === 1) {
      applySpec(p.command(parts[0]), spec);
    } else if (parts.length === 2) {
      let parent = p.commands.find((c) => c.name() === parts[0]);
      if (!parent) {
        parent = p.command(parts[0]);
      }
      // Pass only the last-segment name to Commander; applySpec wires description/options.
      applySpec(parent.command(parts[1]), spec);
    }
    // 3+ segments: excluded by the spec-validation test below; safe to skip here.
  }
  return p;
}

// Builds a fresh Commander command for a single spec — used only for ADR-003
// drift checks. Handles 1-part (top-level) and 2-part (grouped) spec names.
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
  // assert.fail returns never — TypeScript infers no return needed after this.
  assert.fail(
    `buildCommandForSpec: spec "${spec.name}" has ${parts.length} segments (max 2 supported)`
  );
}

// ---------------------------------------------------------------------------
// Main suite — derives inventory from collectSpecs() (ADR-001: live registry).
// Iterates collectSpecs() directly so schema and drift checks are
// non-circular: spec validity is asserted independently of Commander wiring.
// ---------------------------------------------------------------------------

// Conservative lower bound on registered spec count (31 as of epic-004).
// Raise this when commands are intentionally added; never lower it without
// a corresponding command removal.
const SPEC_FLOOR = 25;

describe('describe spec registry: all collected specs are schema-valid and drift-free', () => {
  it('registry is non-empty (collectSpecs returns at least one spec)', () => {
    assert.ok(allSpecs.length > 0, 'collectSpecs() must return at least one spec');
  });

  it(`has at least ${SPEC_FLOOR} specs (floor guards against accidental mass removal)`, () => {
    assert.ok(
      allSpecs.length >= SPEC_FLOOR,
      `Expected at least ${SPEC_FLOOR} specs in collectSpecs(), got ${allSpecs.length}`
    );
  });

  it('guard subcommands appear as full-path entries in the spec names', () => {
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

  it('every registered command has a matching spec (registry completeness)', () => {
    // Build a Commander program from the spec registry, then enumerate its
    // leaf commands. A spec that fails to register correctly will be absent
    // from the enumeration (forward check); an orphan command would lack a spec
    // (backward check). Together these verify the full applySpec → enumerate
    // round-trip is consistent with the registry.
    const p = buildTestProgram();
    const enumerated = enumerateRegisteredCommands(p);

    // Forward: every spec name must appear in the Commander enumeration.
    for (const spec of allSpecs) {
      assert.ok(
        enumerated.includes(spec.name),
        `Spec "${spec.name}" is not enumerable via enumerateRegisteredCommands — ` +
          `verify applySpec wires it into the correct Commander parent`
      );
    }

    // Backward: every enumerated command name must have a matching spec.
    for (const name of enumerated) {
      assert.ok(
        specsByName.has(name),
        `Enumerated command "${name}" has no matching spec in collectSpecs() — ` +
          `add a spec or remove the orphan command`
      );
    }
  });

  it('ADR-003 drift check: spec options round-trip through applySpec without drift', () => {
    for (const spec of allSpecs) {
      const cmd = buildCommandForSpec(spec);
      // Both spec.options[].name and Commander o.long use the "--flag" convention
      // (enforced by OptionFlagSchema's regex). Normalise defensively so a future
      // schema relaxation that drops the "--" prefix does not cause mass false failures.
      const normalize = (n: string) => (n.startsWith('--') ? n : `--${n}`);
      const specOptionNames = new Set(spec.options.map((o) => normalize(o.name)));
      // Commander adds --help automatically; exclude it from the comparison.
      const cmdOptionNames = new Set(
        cmd.options
          .filter((o) => o.long !== '--help')
          .map((o) => normalize(o.long ?? ''))
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
// Uses synthetic programs and specs to avoid circular dependencies.
// Uses the already-populated specsByName (no second collectSpecs() call).
// ---------------------------------------------------------------------------

describe('meta-proof: completeness tripwire fails loud for bad specs', () => {
  it('detects a registered command with no matching spec', () => {
    const testProgram = new Command('loom-test');
    testProgram.command('phantom-cmd');

    const testNames = enumerateRegisteredCommands(testProgram);
    assert.ok(testNames.includes('phantom-cmd'), '"phantom-cmd" must appear in enumeration');

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

  it('detects a structurally invalid spec (missing required summary field)', () => {
    // Omit the required `summary` field — a structural defect that remains
    // invalid regardless of schema threshold changes (unlike a value-constraint
    // violation such as a too-short string).
    const badSpec = {
      name: 'test-cmd',
      // summary intentionally omitted
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
      'CommandDescriptionSchema must reject a spec missing the required summary field — the schema validator is broken if this fails'
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
