import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

// __dirname = packages/loom-cli/dist/__tests__
const REPO_ROOT = path.resolve(__dirname, '../../../..');
const CAPABILITIES = path.join(REPO_ROOT, 'docs', 'capabilities.md');

/**
 * Returns the body cell text of the markdown table row whose bold label is
 * `label`. Rows look like `| **Label** | how-to | notes |`; we return the
 * whole line so a test can assert on any cell. Throws if the row is missing —
 * a missing row is itself a doc regression worth failing on.
 */
function row(doc: string, label: string): string {
  const line = doc
    .split('\n')
    .find((l) => l.includes(`**${label}**`) && l.trimStart().startsWith('|'));
  assert.ok(line, `capabilities.md should contain a "${label}" row`);
  return line as string;
}

/**
 * Returns the full table row line whose first cell contains `skillName`
 * (backtick-quoted). Throws if the row is missing.
 */
function skillRow(doc: string, skillName: string): string {
  const line = doc
    .split('\n')
    .find((l) => l.includes(`\`${skillName}\``) && l.trimStart().startsWith('|'));
  assert.ok(line, `capabilities.md should contain a row for skill "${skillName}"`);
  return line as string;
}

describe('capabilities.md — story-002-004: reviewer skill rows', () => {
  const doc = fs.readFileSync(CAPABILITIES, 'utf8');

  it('adversarial-review row is active under block-and-revise', () => {
    const r = skillRow(doc, 'adversarial-review');
    assert.match(r, /block-and-revise/, 'row should reference block-and-revise');
    assert.match(r, /LLM-backed|llm.backed/i, 'row should describe LLM-backed behavior');
    assert.match(r, /FR-10/, 'row should reference FR-10');
  });

  it('edge-case-hunter row is active under block-and-revise', () => {
    const r = skillRow(doc, 'edge-case-hunter');
    assert.match(r, /block-and-revise/, 'row should reference block-and-revise');
    assert.match(r, /LLM-backed|llm.backed/i, 'row should describe LLM-backed behavior');
    assert.match(r, /FR-10/, 'row should reference FR-10');
  });

  it('neither reviewer row still contains stale stub language', () => {
    const adversarial = skillRow(doc, 'adversarial-review');
    const edgeCase = skillRow(doc, 'edge-case-hunter');
    for (const [name, r] of [['adversarial-review', adversarial], ['edge-case-hunter', edgeCase]] as const) {
      assert.doesNotMatch(r, /scaffolded/i, `${name} row must not say "scaffolded"`);
      assert.doesNotMatch(r, /stub handler/i, `${name} row must not say "stub handler"`);
      assert.doesNotMatch(r, /not wired/i, `${name} row must not say "not wired"`);
    }
  });
});

// The four surfaces this epic changed, documented as public API. Single-owner
// story for docs/capabilities.md — these assertions are the verification bar.
describe('capabilities.md — epic-007 changed surfaces (story-007-010)', () => {
  const doc = fs.readFileSync(CAPABILITIES, 'utf8');

  it("'Approve a plan' row reflects the --run opt-in and makes no dispatch claim", () => {
    const approve = row(doc, 'Approve a plan');

    // Reflects the opt-in.
    assert.match(approve, /--run/, 'approve row should mention the --run opt-in');

    // No dispatch claim: approve on its own must not say it dispatches. The
    // only legitimate use of "dispatch" here is the chained `--run` / the
    // run-hint, both of which are explicitly NOT-on-its-own. Guard against the
    // false phrasing that approve itself dispatches workers.
    assert.doesNotMatch(
      approve,
      /approv\w*\s+(?:also\s+)?dispatch(?:es)?\s+workers/i,
      'approve row must not claim approve itself dispatches workers'
    );
    // Must affirmatively state approve does NOT dispatch on its own.
    assert.match(
      approve,
      /does\s+\*?\*?not\*?\*?\s+dispatch/i,
      'approve row should state it does not dispatch on its own'
    );
  });

  it('model-validation note documents the alias→advisory tier', () => {
    const doctor = row(doc, 'Prerequisites probe');
    assert.match(doctor, /alias/i, 'doctor row should mention the alias tier');
    assert.match(doctor, /advisory/i, 'doctor row should describe the advisory');
    // The advisory passes (never fails) — capture the "warning, not failure"
    // contract that distinguishes the alias tier from the invalid tier.
    assert.match(
      doctor,
      /warning,?\s+never\s+a\s+failure|still\s+passes/i,
      'alias note should say the advisory passes / warns, never fails'
    );
  });

  it("'loom doctor' row documents --cross-epic-gate alongside --dry-run-gate", () => {
    const doctor = row(doc, 'Prerequisites probe');
    assert.match(doctor, /--dry-run-gate/, 'doctor row should keep --dry-run-gate');
    assert.match(doctor, /--cross-epic-gate/, 'doctor row should add --cross-epic-gate');
    // The allowlist flag that narrows the union set.
    assert.match(doctor, /--epics/, 'doctor row should mention the --epics allowlist');
  });

  it('status row notes epics get a derived title from submission time', () => {
    const status = row(doc, 'Status from CLI');
    assert.match(status, /derived/i, 'status row should mention the derived title');
    assert.match(
      status,
      /placeholder|submission|submitted/i,
      'status row should tie the derived title to submission time'
    );
    // Concrete derivation rule so the note is buildable, not vague.
    assert.match(
      status,
      /heading|60\s+characters/i,
      'status row should state the derivation rule (heading / first 60 chars)'
    );
  });

  it('all four changed surfaces are present and coherent in the doc', () => {
    // Single-owner invariant: this story is the sole place the four new/changed
    // rows land. A coarse whole-doc check that each surface's signature token
    // appears exactly where expected guards against a regression silently
    // dropping one.
    assert.match(doc, /--run/, 'doc should document the approve --run opt-in');
    assert.match(doc, /alias.{0,40}advisory|advisory.{0,40}alias/is, 'doc should document the alias→advisory tier');
    assert.match(doc, /--cross-epic-gate/, 'doc should document the cross-epic gate');
    assert.match(doc, /derived\s+placeholder\s+title/i, 'doc should document the derived placeholder title');
  });
});
