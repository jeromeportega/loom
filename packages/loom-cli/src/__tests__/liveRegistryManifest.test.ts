/**
 * story-009-001: Live registry manifest — factory purity and collect completeness.
 *
 * Verifies:
 *   AC1 — Manifest.source === 'live-commander-registry' and collection reads the live registry.
 *   AC2 — publishSpec is included in collectSpecs() (publish now collected into manifest).
 *   AC3 — buildManifest(buildProgram()) resolves descriptions for both publish and release.
 *   AC4 — buildProgram() structural shape is unchanged (no user-facing CLI regression).
 *
 * Factory purity is proven implicitly: this file imports { buildProgram } from '../index.js'.
 * If index.ts called .parse() at module load, the test runner's argv would cause Commander
 * to exit 1 here — the test file would never run. Reaching the first assertion IS the proof.
 */
import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import { buildProgram } from '../index.js';
import { collectSpecs, enumerateRegisteredCommands } from '../describe/registry.js';
import { buildManifest } from '../describe/manifest.js';
import type { Manifest } from '../describe/schema.js';

// ─── Factory purity ───────────────────────────────────────────────────────────
// The module loaded without calling .parse() — otherwise the test runner's argv
// would trip Commander and exit before reaching here. These assertions confirm
// the factory is callable and returns a well-formed program.

describe('buildProgram factory purity (AC4 enabling refactor)', () => {
  it('buildProgram is exported as a function', () => {
    assert.equal(typeof buildProgram, 'function');
  });

  it('buildProgram() returns a Command named "loom"', () => {
    const program = buildProgram();
    assert.equal(program.name(), 'loom');
  });

  it('buildProgram() registers publish as a leaf command', () => {
    const program = buildProgram();
    const names = program.commands.map((c) => c.name());
    assert.ok(names.includes('publish'), `expected publish in top-level commands; got: ${names.join(', ')}`);
  });

  it('buildProgram() registers release as a leaf command', () => {
    const program = buildProgram();
    const names = program.commands.map((c) => c.name());
    assert.ok(names.includes('release'), `expected release in top-level commands; got: ${names.join(', ')}`);
  });

  it('buildProgram() help text mentions publish (no user-facing regression)', () => {
    const program = buildProgram();
    const help = program.helpInformation();
    assert.ok(help.includes('publish'), 'loom --help must mention publish');
  });

  it('buildProgram() help text mentions release (no user-facing regression)', () => {
    const program = buildProgram();
    const help = program.helpInformation();
    assert.ok(help.includes('release'), 'loom --help must mention release');
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
    manifest = buildManifest(buildProgram());
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
    const program = buildProgram();
    const liveNames = enumerateRegisteredCommands(program);
    const manifestNames = new Set(manifest.commands.map((c) => c.name));
    for (const name of liveNames) {
      assert.ok(
        manifestNames.has(name),
        `live command "${name}" is not represented in the manifest — collectSpecs() is incomplete`
      );
    }
  });
});
