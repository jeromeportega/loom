import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { CommandDescriptionSchema } from '../schema.js';
import { collectSpecs } from '../registry.js';
import { spec as weaveSpec } from '../../commands/weave.js';

// ---------------------------------------------------------------------------
// weave spec — self-validation
// ---------------------------------------------------------------------------

describe('weave spec — CommandDescriptionSchema validation', () => {
  it('spec passes CommandDescriptionSchema validation', () => {
    const result = CommandDescriptionSchema.safeParse(weaveSpec);
    if (!result.success) {
      const msgs = result.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('\n');
      assert.fail(`weave spec failed CommandDescriptionSchema:\n${msgs}`);
    }
  });

  it('spec name is "weave"', () => {
    assert.equal(weaveSpec.name, 'weave');
  });

  it('weave spec is present in collectSpecs()', () => {
    const found = collectSpecs().find((s) => s.name === 'weave');
    assert.ok(found, 'weave spec must appear in collectSpecs()');
  });

  it('weave spec in collectSpecs() matches the authored spec', () => {
    const found = collectSpecs().find((s) => s.name === 'weave');
    assert.ok(found, 'weave spec must appear in collectSpecs()');
    assert.deepEqual(found, JSON.parse(JSON.stringify(weaveSpec)));
  });
});

// ---------------------------------------------------------------------------
// docs/capabilities.md — weave entry
// ---------------------------------------------------------------------------

describe('docs/capabilities.md — weave entry', () => {
  // __dirname at runtime: dist/describe/__tests__
  // 5 levels up: dist/describe/__tests__ → dist/describe → dist → loom-cli → packages → repo root
  const repoRoot = resolve(__dirname, '..', '..', '..', '..', '..');
  const capabilitiesPath = resolve(repoRoot, 'docs', 'capabilities.md');

  function readDoc(): string {
    return readFileSync(capabilitiesPath, 'utf8');
  }

  it('contains a "loom weave" table row', () => {
    const doc = readDoc();
    const hasWeaveRow = doc
      .split('\n')
      .some((line) => line.includes('loom weave') && line.trimStart().startsWith('|'));
    assert.ok(hasWeaveRow, 'docs/capabilities.md must contain a table row for loom weave');
  });

  it('coverage fence includes `loom weave`', () => {
    const doc = readDoc();
    const fenceStart = doc.indexOf('<!-- coverage:command:start -->');
    const fenceEnd = doc.indexOf('<!-- coverage:command:end -->');
    assert.ok(fenceStart !== -1, 'coverage:command:start fence must exist');
    assert.ok(fenceEnd !== -1, 'coverage:command:end fence must exist');
    const fenceContent = doc.slice(fenceStart, fenceEnd);
    assert.ok(
      fenceContent.includes('`loom weave`'),
      'coverage:command fence must include the `loom weave` token'
    );
  });

  it('weave entry references the intake-classification behavior', () => {
    // intake_routing was baked to "advisory" (knob-hardening) — the verdict is
    // now always injected as a PM sizing constraint, so the weave entry points
    // at the intake-classification layer rather than the removed knob.
    const doc = readDoc();
    const weaveRow = doc
      .split('\n')
      .find((line) => line.includes('**Plan via the weave intake path**') && line.trimStart().startsWith('|'));
    assert.ok(weaveRow, 'weave row must exist');
    assert.ok(
      /intake-classification|sizing constraint/i.test(weaveRow),
      'capabilities.md weave entry must reference the intake-classification / sizing-constraint behavior'
    );
  });
});
