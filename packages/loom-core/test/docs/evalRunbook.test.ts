import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

// ── Helpers ───────────────────────────────────────────────────────────────────

function findRunbook(): string {
  let dir = __dirname;
  for (let i = 0; i < 12; i++) {
    const candidate = path.join(dir, 'docs', 'eval', 'intake-classifier-rerun.md');
    if (fs.existsSync(candidate)) return candidate;
    dir = path.dirname(dir);
  }
  throw new Error('could not locate docs/eval/intake-classifier-rerun.md');
}

// ── Runbook completeness (AC3, FR-9) ─────────────────────────────────────────
//
// The operator runbook must exist and explicitly enumerate every metric the
// operator must record after the post-merge eval run. Verified fields:
//   - per-axis accuracy for both type and size axes
//   - ConfusionMatrix count tables for both axes
//   - failure-reason counts (invalid_output, timeout, llm_error)
//   - GateDecision (proceed | do-not-proceed | inconclusive)
//   - the under-sizing cell counts['epic']['story'] and its ≤ 2 threshold (FR-9)

describe('evalRunbook — docs/eval/intake-classifier-rerun.md completeness (AC3, FR-9)', () => {
  let content: string;

  it('runbook file exists and is non-empty', () => {
    const p = findRunbook();
    content = fs.readFileSync(p, 'utf8');
    assert.ok(content.length > 0, 'intake-classifier-rerun.md must not be empty');
  });

  it('contains an epic-026 operator section', () => {
    assert.ok(
      /epic-026/i.test(content),
      'runbook must contain an epic-026 section',
    );
  });

  it('documents per-axis accuracy for both type and size axes', () => {
    assert.ok(
      /per-axis accuracy/i.test(content) || (/per-axis/i.test(content) && /accuracy/i.test(content)),
      'runbook must mention per-axis accuracy',
    );
    // Both axis names must appear in the accuracy recording instructions
    const accuracyIdx = content.search(/per-axis accuracy/i);
    assert.ok(accuracyIdx !== -1, 'must have per-axis accuracy heading');
    const accuracySection = content.slice(accuracyIdx, accuracyIdx + 800);
    assert.ok(/\btype\b/i.test(accuracySection), 'accuracy section must mention type axis');
    assert.ok(/\bsize\b/i.test(accuracySection), 'accuracy section must mention size axis');
  });

  it('documents ConfusionMatrix counts for both axes', () => {
    assert.ok(
      /ConfusionMatrix/i.test(content) || /confusion.*matrix/i.test(content) || /confusion.*counts/i.test(content),
      'runbook must mention ConfusionMatrix or confusion matrix counts',
    );
    // Must cover both axes in the matrix tables
    const matrixIdx = content.search(/ConfusionMatrix|confusion.*matrix/i);
    assert.ok(matrixIdx !== -1, 'must have a ConfusionMatrix section');
    // Both type and size matrices must appear
    assert.ok(
      /type axis/i.test(content) && /size axis/i.test(content),
      'runbook must cover both type and size ConfusionMatrix tables',
    );
  });

  it('documents failure-reason counts (invalid_output, timeout, llm_error)', () => {
    assert.ok(
      /failure.reason/i.test(content) || (/failure/i.test(content) && /reason/i.test(content)),
      'runbook must mention failure-reason counts',
    );
    assert.ok(/invalid_output/i.test(content), 'runbook must name the invalid_output failure reason');
    assert.ok(/timeout/i.test(content), 'runbook must name the timeout failure reason');
    assert.ok(/llm_error/i.test(content), 'runbook must name the llm_error failure reason');
  });

  it('documents GateDecision with all three possible values', () => {
    assert.ok(
      /GateDecision|gate\.decision|gate decision/i.test(content),
      'runbook must mention GateDecision',
    );
    assert.ok(/\bproceed\b/i.test(content), 'runbook must list the "proceed" gate value');
    assert.ok(/do-not-proceed/i.test(content), 'runbook must list the "do-not-proceed" gate value');
    assert.ok(/\binconclusive\b/i.test(content), 'runbook must list the "inconclusive" gate value');
  });

  it('documents the under-sizing cell counts["epic"]["story"] and its ≤ 2 gate threshold (FR-9)', () => {
    assert.ok(
      /counts\[.epic.\]\[.story.\]/i.test(content) || /epic.*story.*under.siz/i.test(content),
      "runbook must call out counts['epic']['story'] or the epic→story under-sizing cell",
    );
    assert.ok(
      /≤\s*2|<=\s*2|≤\s*2/i.test(content) || /\b2\b.*threshold|threshold.*\b2\b/i.test(content),
      'runbook must state the ≤ 2 gate threshold for epic→story under-sizing (FR-9)',
    );
  });
});
