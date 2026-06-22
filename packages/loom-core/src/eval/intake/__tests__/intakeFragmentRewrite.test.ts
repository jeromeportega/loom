import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { loadIntakeEvalSet } from '../loadIntakeEvalSet.js';

// ── Story-026-002: fragment brief rewrite — fixture validation ───────────────
//
// These tests are the pre-merge guard described in the story test plan:
//   1. Loader + schema still green
//   2. Label freeze (AC3) — id→{type,size} map is unchanged
//   3. Non-empty rewrites
//   4. Documentation completeness (AC5)
//
// The live eval is NOT run here. These checks are the entire pre-merge guarantee.

// The four briefs rewritten by story-026-002. Any id NOT in this set must have
// its label snapshot preserved exactly; ids IN this set must have non-empty briefs.
const REWRITTEN_IDS = new Set(['epic-001', 'epic-003', 'epic-005', 'epic-016']);

// Full id → label snapshot taken BEFORE the story-026-002 brief rewrites.
// This is the load-bearing guard: no label must deviate from these values.
const LABEL_SNAPSHOT: Record<string, { type: string; size: string }> = {
  'anchor-obvious-single-story': { type: 'feature', size: 'story' },
  'anchor-obvious-bug':          { type: 'bug',     size: 'story' },
  'anchor-obvious-large-epic':   { type: 'feature', size: 'epic'  },
  'epic-001':  { type: 'feature', size: 'epic' },
  'epic-002':  { type: 'feature', size: 'epic' },
  'epic-003':  { type: 'feature', size: 'epic' },
  'epic-004':  { type: 'feature', size: 'epic' },
  'epic-005':  { type: 'feature', size: 'epic' },
  'epic-006':  { type: 'feature', size: 'epic' },
  'epic-007':  { type: 'feature', size: 'epic' },
  'epic-008':  { type: 'feature', size: 'epic' },
  'epic-009':  { type: 'feature', size: 'epic' },
  'epic-010':  { type: 'feature', size: 'epic' },
  'epic-011':  { type: 'feature', size: 'epic' },
  'epic-012':  { type: 'feature', size: 'epic' },
  'epic-013':  { type: 'feature', size: 'epic' },
  'epic-014':  { type: 'feature', size: 'epic' },
  'epic-015':  { type: 'feature', size: 'epic' },
  'epic-016':  { type: 'feature', size: 'epic' },
  'epic-017':  { type: 'feature', size: 'epic' },
  'epic-018':  { type: 'feature', size: 'epic' },
  'epic-019':  { type: 'feature', size: 'epic' },
};

describe('intakeFragmentRewrite — story-026-002 (fixture/data validation)', () => {
  it('loader + schema: intake-classification.yaml loads and every case validates', () => {
    const cases = loadIntakeEvalSet();
    assert.ok(cases.length >= 22, `expected ≥22 cases, got ${cases.length}`);
    for (const c of cases) {
      assert.ok(typeof c.id === 'string' && c.id.length > 0, 'id must be non-empty string');
      assert.ok(typeof c.brief === 'string' && c.brief.trim().length > 0, `case ${c.id}: brief is empty`);
      assert.ok(['feature', 'bug', 'chore'].includes(c.label.type), `case ${c.id}: invalid label.type`);
      assert.ok(['story', 'epic'].includes(c.label.size), `case ${c.id}: invalid label.size`);
    }
  });

  it('label freeze (AC3): id→{type,size} map matches pre-rewrite snapshot for all 22 cases', () => {
    const cases = loadIntakeEvalSet();
    const byId = Object.fromEntries(cases.map((c) => [c.id, c]));
    for (const [id, expected] of Object.entries(LABEL_SNAPSHOT)) {
      const c = byId[id];
      assert.ok(c !== undefined, `case ${id} is missing from the fixture`);
      assert.equal(c.label.type, expected.type, `${id}: label.type changed — expected ${expected.type}`);
      assert.equal(c.label.size, expected.size, `${id}: label.size changed — expected ${expected.size}`);
    }
    // Reverse check: cases added after the snapshot was taken (not in LABEL_SNAPSHOT)
    // must still carry valid enum values. This prevents a future addition with a
    // malformed label from slipping through undetected.
    const VALID_TYPES = new Set(['feature', 'bug', 'chore']);
    const VALID_SIZES = new Set(['story', 'epic']);
    for (const c of cases) {
      if (!(c.id in LABEL_SNAPSHOT)) {
        assert.ok(VALID_TYPES.has(c.label.type), `${c.id}: label.type "${c.label.type}" is not a valid enum value`);
        assert.ok(VALID_SIZES.has(c.label.size), `${c.id}: label.size "${c.label.size}" is not a valid enum value`);
      }
    }
  });

  it('non-empty rewrites: every rewritten brief is non-whitespace', () => {
    const cases = loadIntakeEvalSet();
    const byId = Object.fromEntries(cases.map((c) => [c.id, c]));
    for (const id of REWRITTEN_IDS) {
      const c = byId[id];
      assert.ok(c !== undefined, `rewritten case ${id} is missing from the fixture`);
      assert.ok(c.brief.trim().length > 0, `case ${id}: rewritten brief collapsed to blank`);
    }
  });

  it('documentation completeness (AC5): RELABEL.md contains an entry for each rewritten id', () => {
    // Resolve RELABEL.md relative to the compiled output directory.
    // Compiled test lives at dist/eval/intake/__tests__/; eval-cases is four levels up at packages/loom-core/.
    const relabelPath = path.resolve(__dirname, '../../../../eval-cases/RELABEL.md');
    assert.ok(fs.existsSync(relabelPath), `RELABEL.md not found at ${relabelPath}`);
    const content = fs.readFileSync(relabelPath, 'utf8');

    // Split on '---' section dividers so field-presence checks are scoped to each
    // id's block, not the document globally. A missing field in one entry that
    // exists in another would otherwise produce a false pass.
    const blocks = content.split(/^---$/m);

    for (const id of REWRITTEN_IDS) {
      const block = blocks.find((b) => b.includes(`id:        ${id}`));
      assert.ok(block !== undefined, `RELABEL.md missing entry for "- id:        ${id}"`);
      assert.ok(block.includes('original:'),  `RELABEL.md entry for ${id} missing "original:" field`);
      assert.ok(block.includes('rewritten:'), `RELABEL.md entry for ${id} missing "rewritten:" field`);
      assert.ok(block.includes('rationale:'), `RELABEL.md entry for ${id} missing "rationale:" field`);
      assert.ok(block.includes('UNCHANGED'),  `RELABEL.md entry for ${id} missing explicit "UNCHANGED" labels assertion`);
    }
  });

  it('no collateral edits (AC4): well-formed briefs are non-empty and all 22 expected case ids are present', () => {
    const cases = loadIntakeEvalSet();
    const ids = new Set(cases.map((c) => c.id));
    for (const expectedId of Object.keys(LABEL_SNAPSHOT)) {
      assert.ok(ids.has(expectedId), `case ${expectedId} was removed — collateral edit detected`);
    }
    // Every non-rewritten case still has a non-empty brief
    for (const c of cases) {
      if (!REWRITTEN_IDS.has(c.id)) {
        assert.ok(c.brief.trim().length > 0, `case ${c.id}: well-formed brief became empty`);
      }
    }
  });
});
