// story-009-001: factory purity (AC4), publishSpec collected (AC2), manifest completeness (AC1, AC3).
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

  it('registers publish as a top-level command', () => {
    const names = program.commands.map((c) => c.name());
    assert.ok(names.includes('publish'), `expected publish in top-level commands; got: ${names.join(', ')}`);
  });

  it('registers release as a top-level command', () => {
    const names = program.commands.map((c) => c.name());
    assert.ok(names.includes('release'), `expected release in top-level commands; got: ${names.join(', ')}`);
  });

  it('help text mentions publish (no user-facing regression)', () => {
    assert.ok(program.helpInformation().includes('publish'), 'loom --help must mention publish');
  });

  it('help text mentions release (no user-facing regression)', () => {
    assert.ok(program.helpInformation().includes('release'), 'loom --help must mention release');
  });
});

// ─── publish collected into collectSpecs (AC2) ───────────────────────────────

describe('collectSpecs includes publishSpec (AC2)', () => {
  it('collectSpecs() returns a spec named "publish"', () => {
    const specs = collectSpecs();
    const names = specs.map((s) => s.name);
    assert.ok(names.includes('publish'), `publish not found in collectSpecs(); got: ${names.join(', ')}`);
  });

  it('publish spec has a non-empty summary', () => {
    const specs = collectSpecs();
    const pub = specs.find((s) => s.name === 'publish');
    assert.ok(pub, 'publish spec must exist in collectSpecs()');
    assert.ok(pub.summary.length > 0, 'publish spec summary must be non-empty');
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

  it('manifest commands contains publish with non-empty summary (AC3)', () => {
    const pub = manifest.commands.find((c) => c.name === 'publish');
    assert.ok(pub, 'publish must appear in manifest.commands');
    assert.ok(pub.summary.length > 0, 'publish CommandDescription must have a non-empty summary');
  });

  it('manifest commands contains release with non-empty summary (AC3)', () => {
    const rel = manifest.commands.find((c) => c.name === 'release');
    assert.ok(rel, 'release must appear in manifest.commands');
    assert.ok(rel.summary.length > 0, 'release CommandDescription must have a non-empty summary');
  });

  it('every live command enumerated by enumerateRegisteredCommands has a spec in the manifest (AC1)', () => {
    const liveNames = enumerateRegisteredCommands(buildProgram());
    const manifestNames = new Set(manifest.commands.map((c) => c.name));
    for (const name of liveNames) {
      assert.ok(
        manifestNames.has(name),
        `live command "${name}" is not represented in the manifest — collectSpecs() is incomplete`
      );
    }
  });
});
