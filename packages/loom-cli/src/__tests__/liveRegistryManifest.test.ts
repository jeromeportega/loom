// story-009-001: factory purity (AC4), recoverSpec collected (AC2), manifest completeness (AC1, AC3).
import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import { buildProgram } from '../index.js';
import { collectSpecs, enumerateRegisteredCommands } from '../describe/registry.js';
import { buildManifest } from '../describe/manifest.js';
import type { Manifest } from '../describe/schema.js';

// ─── Factory purity (AC4 enabling refactor) ──────────────────────────────────
// Reaching this block at all proves the implicit purity invariant: if buildProgram()
// called .parse() at module load, Commander would have exited on the test runner's argv
// before any test ran. The explicit checks below make the invariant test-visible.

describe('buildProgram factory purity (AC4 enabling refactor)', () => {
  let program: ReturnType<typeof buildProgram>;

  before(() => {
    program = buildProgram();
  });

  it('buildProgram is exported as a function', () => {
    assert.equal(typeof buildProgram, 'function');
  });

  it('factory does not call .parse() — program.args is empty after construction', () => {
    // program.args is populated only when .parse() is called.
    // An empty array proves the factory did not consume process.argv during construction.
    assert.equal(program.args.length, 0);
  });

  it('returns a Command named "loom"', () => {
    assert.equal(program.name(), 'loom');
  });

  it('registers recover as a top-level command', () => {
    const names = program.commands.map((c) => c.name());
    assert.ok(names.includes('recover'), `expected recover in top-level commands; got: ${names.join(', ')}`);
  });
});

// ─── recover collected into collectSpecs (AC2) ───────────────────────────────

describe('collectSpecs includes recoverSpec (AC2)', () => {
  it('collectSpecs() returns a spec named "recover"', () => {
    const specs = collectSpecs();
    const names = specs.map((s) => s.name);
    assert.ok(names.includes('recover'), `recover not found in collectSpecs(); got: ${names.join(', ')}`);
  });

  it('recover spec has a non-empty summary', () => {
    const specs = collectSpecs();
    const rec = specs.find((s) => s.name === 'recover');
    assert.ok(rec, 'recover spec must exist in collectSpecs()');
    assert.ok(rec.summary.length > 0, 'recover spec summary must be non-empty');
  });

  it('recover spec has operator audience (visible in loom describe)', () => {
    const specs = collectSpecs();
    const rec = specs.find((s) => s.name === 'recover');
    assert.ok(rec, 'recover spec must exist in collectSpecs()');
    const audience = rec.audience ?? 'operator';
    assert.equal(audience, 'operator', 'recover must have operator audience so it appears in loom describe');
  });
});

// ─── buildManifest completeness driven by live program (AC1, AC3) ────────────

describe('buildManifest via live buildProgram() (AC1, AC3)', () => {
  let manifest: Manifest;

  before(() => {
    try {
      manifest = buildManifest(buildProgram());
    } catch (err) {
      throw new Error(
        `buildManifest setup failed — ${err instanceof Error ? err.message : String(err)}`
      );
    }
  });

  it('Manifest.source is "live-commander-registry" (AC1)', () => {
    assert.equal(manifest.source, 'live-commander-registry');
  });

  it('manifest commands contains recover with non-empty summary', () => {
    const rec = manifest.commands.find((c) => c.name === 'recover');
    assert.ok(rec, 'recover must appear in manifest.commands');
    assert.ok(rec.summary.length > 0, 'recover CommandDescription must have a non-empty summary');
  });

  it('manifest commands does not contain internal commands (publish, release, scan, epic, etc.)', () => {
    const internalNames = ['publish', 'release', 'scan', 'opportunities', 'propose', 'pull-guidance',
      'migrate', 'reconcile', 'finalize', 'epic', 'project', 'describe'];
    const manifestNames = new Set(manifest.commands.map((c) => c.name));
    for (const name of internalNames) {
      assert.ok(
        !manifestNames.has(name),
        `internal command "${name}" must not appear in manifest.commands (audience=internal)`
      );
    }
  });

  it('every registered command has a spec in collectSpecs() (cross-check invariant, AC1)', () => {
    // After audience filtering, manifest.commands only contains operator specs.
    // The cross-check invariant compares against collectSpecs() (all specs, including internal),
    // not manifest.commands — so internal commands still have specs even if not in the manifest output.
    const liveNames = enumerateRegisteredCommands(buildProgram());
    const allSpecNames = new Set(collectSpecs().map((s) => s.name));
    for (const name of liveNames) {
      assert.ok(
        allSpecNames.has(name),
        `live command "${name}" has no spec in collectSpecs() — add a CommandDescription`
      );
    }
  });
});
