import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import { Command } from 'commander';
import { CommandDescriptionSchema } from '../describe/schema.js';
import type { CommandDescription } from '../describe/schema.js';
import { collectSpecs, enumerateRegisteredCommands } from '../describe/registry.js';
import { buildManifest } from '../describe/manifest.js';
import { applySpec } from '../describe/applySpec.js';
import { buildProgram } from '../index.js';

// ─── Module-level state ──────────────────────────────────────────────────────
// Populated once in the top-level before() hook.
// liveCommands: authoritative command list from the real buildProgram() registry.
// allSpecs / specsByName: authored spec inventory from collectSpecs().
// These are independent sources — the completeness check is non-circular.
let liveCommands: string[] = [];
let allSpecs: CommandDescription[] = [];
let specsByName = new Map<string, CommandDescription>();

before(() => {
  liveCommands = enumerateRegisteredCommands(buildProgram());
  allSpecs = collectSpecs();
  specsByName = new Map(allSpecs.map((s) => [s.name, s]));
});

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
  assert.fail(
    `buildCommandForSpec: spec "${spec.name}" has ${parts.length} segments (max 2 supported)`
  );
}

// Conservative lower bound on registered command count (34 as of epic-009).
// Raise this when commands are intentionally added; never lower it without
// a corresponding command removal.
const COMMAND_FLOOR = 30;

// ---------------------------------------------------------------------------
// Main suite — live-registry completeness check (non-circular).
// liveCommands derives from buildProgram() (the live Commander registry).
// specsByName derives from collectSpecs() (the authored spec inventory).
// The two sides are independent — a command absent from collectSpecs() while
// still registered in buildProgram() is immediately detected.
// ---------------------------------------------------------------------------

describe('describe completeness: live registry vs spec inventory', () => {
  it('live registry is non-empty (buildProgram registers at least one command)', () => {
    assert.ok(liveCommands.length > 0, 'enumerateRegisteredCommands(buildProgram()) must return at least one command');
  });

  it(`live registry has at least ${COMMAND_FLOOR} commands (floor guards against accidental mass removal)`, () => {
    assert.ok(
      liveCommands.length >= COMMAND_FLOOR,
      `Expected at least ${COMMAND_FLOOR} commands from buildProgram(), got ${liveCommands.length}`
    );
  });

  it('every registered command resolves to a CommandDescription (non-circular check)', () => {
    // Non-circular: liveCommands comes from buildProgram() (the live Commander registry);
    // specsByName comes from collectSpecs() (the authored spec inventory).
    // A command registered in buildProgram() but absent from collectSpecs() is named here.
    const missing = liveCommands.filter((name) => !specsByName.has(name));
    assert.equal(
      missing.length,
      0,
      `Registered commands without specs (add them to collectSpecs()): ${missing.join(', ')}`
    );
  });

  it('publish is in the live registry and resolves to a spec (AC4)', () => {
    assert.ok(
      liveCommands.includes('publish'),
      `publish must appear in enumerateRegisteredCommands(buildProgram()); got: ${liveCommands.join(', ')}`
    );
    assert.ok(specsByName.has('publish'), 'publish must resolve to a CommandDescription in collectSpecs()');
    const pub = specsByName.get('publish')!;
    assert.ok(pub.summary.length > 0, 'publish CommandDescription must have a non-empty summary');
  });

  it('release is in the live registry and resolves to a spec (AC4)', () => {
    assert.ok(
      liveCommands.includes('release'),
      `release must appear in enumerateRegisteredCommands(buildProgram()); got: ${liveCommands.join(', ')}`
    );
    assert.ok(specsByName.has('release'), 'release must resolve to a CommandDescription in collectSpecs()');
    const rel = specsByName.get('release')!;
    assert.ok(rel.summary.length > 0, 'release CommandDescription must have a non-empty summary');
  });

  it('would have caught the missing publish command — AC3 simulation', () => {
    // Precondition: publish must be in the live registry for this simulation to be valid.
    assert.ok(liveCommands.includes('publish'), 'precondition: publish must be in liveCommands for the AC3 simulation to be valid');
    // Simulate the prior defect: collectSpecs() did not include publishSpec.
    // The live program still registers publish. With the non-circular check the gap is visible.
    const specsWithoutPublish = new Map(specsByName);
    specsWithoutPublish.delete('publish');

    const wouldBeMissing = liveCommands.filter((name) => !specsWithoutPublish.has(name));
    assert.ok(
      wouldBeMissing.includes('publish'),
      `AC3: dropping publishSpec from collectSpecs() must cause 'publish' to appear as missing ` +
        `in the non-circular check — the tripwire is broken if this assertion fails`
    );
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
    for (const spec of allSpecs) {
      const cmd = buildCommandForSpec(spec);
      const normalize = (n: string) => (n.startsWith('--') ? n : `--${n}`);
      const specOptionNames = new Set(spec.options.map((o) => normalize(o.name)));
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
// Meta-proof — demonstrates the tripwire goes red for a missing spec.
// Uses the real buildProgram() augmented with a synthetic command so the
// proof exercises the actual live registry path, not just a toy program.
// ---------------------------------------------------------------------------

describe('meta-proof: completeness tripwire fails loud on missing spec (AC2)', () => {
  it('detects a registered command with no matching spec — names it in the error', () => {
    // Augment the live program with a synthetic command that has no spec.
    const program = buildProgram();
    program.command('phantom-cmd');

    const enumerated = enumerateRegisteredCommands(program);
    assert.ok(enumerated.includes('phantom-cmd'), '"phantom-cmd" must appear in enumeration');

    // The completeness check must name phantom-cmd as missing.
    const missing = enumerated.filter((name) => !specsByName.has(name));
    assert.ok(
      missing.includes('phantom-cmd'),
      `tripwire must detect "phantom-cmd" which has no spec — the check is broken if this assertion fails`
    );
  });

  it('inventory is registry-driven: adding a command to a program makes it enumerable without code changes here', () => {
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

  it('detects a structurally invalid spec (missing required summary field)', () => {
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
});

// ---------------------------------------------------------------------------
// buildManifest fail-closed — THROWS (not warns) when any registered command
// lacks a spec. Confirms the manifest build itself is a hard gate.
// ---------------------------------------------------------------------------

describe('buildManifest fails closed: throws on any unspecced registered command', () => {
  it('throws when a registered command has no matching spec, and names the command in the error', () => {
    const program = buildProgram();
    program.command('manifest-phantom');

    assert.throws(
      () => buildManifest(program),
      (err: unknown) => {
        assert.ok(err instanceof Error, 'expected an Error instance');
        assert.ok(
          err.message.includes('manifest-phantom'),
          `error message must name the missing command; got: "${err.message}"`
        );
        return true;
      }
    );
  });

  it('does not throw for the clean program (all registered commands have specs)', () => {
    assert.doesNotThrow(
      () => buildManifest(buildProgram()),
      'buildManifest(buildProgram()) must succeed when every registered command has a spec'
    );
  });
});
