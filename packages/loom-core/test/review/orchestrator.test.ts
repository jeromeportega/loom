import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  runReviewPass,
  runReviewLoop,
  type AuditSink,
  type ReviewPassResult,
  type ReviewLoopHooks,
} from '../../src/review/orchestrator.js';
import type { ReviewerInput, ReviewerRunner } from '../../src/review/reviewer.js';
import { ReviewerOutput } from '../../src/findings/schema.js';
import type { Finding, Severity } from '../../src/findings/schema.js';
import { SOURCE } from '../../src/findings/sources.js';

const INPUT: ReviewerInput = {
  diff: 'diff --git a/x b/x',
  changed_files: ['x'],
  story_context: 'story',
};

function finding(
  source: string,
  severity: Severity,
  over: { file?: string; line?: number; description?: string } = {},
): Finding {
  const line = over.line ?? 1;
  return {
    severity,
    category: 'test',
    location: { file: over.file ?? 'src/a.ts', line },
    description: over.description ?? `${source} ${severity}`,
    source,
  };
}

function reviewer(source: string, findings: Finding[]): ReviewerRunner {
  return { source: source as ReviewerRunner['source'], run: async () => ({ findings }) };
}

/** A reviewer whose output never validates — every call throws a ZodError. */
function malformedReviewer(source: string, counter: { calls: number }): ReviewerRunner {
  return {
    source: source as ReviewerRunner['source'],
    run: async () => {
      counter.calls += 1;
      // Forces a real schema-validation throw, exactly as invokeSkill would.
      return ReviewerOutput.parse({ findings: [{ not: 'a finding' }] });
    },
  };
}

function collector(): AuditSink & { entries: Array<{ action: string; detail: Record<string, unknown> }> } {
  const entries: Array<{ action: string; detail: Record<string, unknown> }> = [];
  return { entries, record: (action, detail) => entries.push({ action, detail }) };
}

const CTX = { story_id: 'story-001-003', epic_id: 'epic-001', revision_index: 0 };

describe('runReviewPass — fan-out & union (AC1)', () => {
  it('invokes all three reviewers and unions their findings', async () => {
    const sources: string[] = [];
    const track = (s: string, fs: Finding[]): ReviewerRunner => ({
      source: s as ReviewerRunner['source'],
      run: async () => {
        sources.push(s);
        return { findings: fs };
      },
    });
    const res = await runReviewPass(INPUT, {
      ...CTX,
      reviewers: [
        track(SOURCE.CODE_REVIEW, [finding(SOURCE.CODE_REVIEW, 'low', { line: 1 })]),
        track(SOURCE.ADVERSARIAL, [finding(SOURCE.ADVERSARIAL, 'low', { line: 2 })]),
        track(SOURCE.EDGE_CASE, [finding(SOURCE.EDGE_CASE, 'low', { line: 3 })]),
      ],
    });
    assert.deepEqual(sources.sort(), [SOURCE.ADVERSARIAL, SOURCE.CODE_REVIEW, SOURCE.EDGE_CASE].sort());
    assert.equal(res.findings.length, 3);
    assert.deepEqual(
      res.findings.map((f) => f.source).sort(),
      [SOURCE.ADVERSARIAL, SOURCE.CODE_REVIEW, SOURCE.EDGE_CASE].sort(),
    );
    assert.deepEqual(
      res.per_reviewer_status.map((s) => s.status),
      ['ok', 'ok', 'ok'],
    );
  });

  it('dedupes a finding reported by two reviewers at the same (file, line)', async () => {
    const res = await runReviewPass(INPUT, {
      ...CTX,
      reviewers: [
        reviewer(SOURCE.ADVERSARIAL, [finding(SOURCE.ADVERSARIAL, 'high', { line: 7, description: 'Race condition!' })]),
        reviewer(SOURCE.EDGE_CASE, [finding(SOURCE.EDGE_CASE, 'high', { line: 7, description: 'race   condition' })]),
      ],
    });
    assert.equal(res.findings.length, 1, 'identical-after-normalization findings collapse to one');
  });
});

describe('runReviewPass — revision trigger by severity (AC3)', () => {
  for (const sev of ['blocker', 'high'] as const) {
    it(`${sev} triggers a revision`, async () => {
      const res = await runReviewPass(INPUT, {
        ...CTX,
        reviewers: [reviewer(SOURCE.ADVERSARIAL, [finding(SOURCE.ADVERSARIAL, sev)])],
      });
      assert.equal(res.triggers_revision, true);
    });
  }

  for (const sev of ['medium', 'low', 'info'] as const) {
    it(`${sev} does NOT trigger a revision`, async () => {
      const res = await runReviewPass(INPUT, {
        ...CTX,
        reviewers: [reviewer(SOURCE.ADVERSARIAL, [finding(SOURCE.ADVERSARIAL, sev)])],
      });
      assert.equal(res.triggers_revision, false);
    });
  }

  it('no findings means no revision', async () => {
    const res = await runReviewPass(INPUT, {
      ...CTX,
      reviewers: [reviewer(SOURCE.ADVERSARIAL, [])],
    });
    assert.equal(res.triggers_revision, false);
  });
});

describe('runReviewPass — per-reviewer repair then warn-and-continue (AC5)', () => {
  it('malformed output: exactly one repair attempt, one warn-and-continue log, pass continues', async () => {
    const counter = { calls: 0 };
    const audit = collector();
    const res = await runReviewPass(INPUT, {
      ...CTX,
      audit,
      reviewers: [
        malformedReviewer(SOURCE.ADVERSARIAL, counter),
        reviewer(SOURCE.CODE_REVIEW, [finding(SOURCE.CODE_REVIEW, 'medium')]),
      ],
    });

    // Original call + exactly one repair re-prompt = 2 invocations, then skip.
    assert.equal(counter.calls, 2, 'exactly one repair attempt after the original');

    const warns = audit.entries.filter((e) => e.action === 'review.reviewer.warn_and_continue');
    assert.equal(warns.length, 1, 'exactly one warn-and-continue log entry');
    assert.equal(warns[0].detail.source, SOURCE.ADVERSARIAL);

    const status = res.per_reviewer_status.find((s) => s.source === SOURCE.ADVERSARIAL);
    assert.equal(status?.status, 'warn_and_continue');

    // The pass continues: the surviving reviewer's finding is present.
    assert.equal(res.findings.length, 1);
    assert.equal(res.findings[0].source, SOURCE.CODE_REVIEW);
  });

  it('a reviewer that recovers on the repair re-prompt is marked repaired', async () => {
    let calls = 0;
    const flaky: ReviewerRunner = {
      source: SOURCE.EDGE_CASE,
      run: async () => {
        calls += 1;
        if (calls === 1) throw new Error('transient garbage');
        return { findings: [finding(SOURCE.EDGE_CASE, 'low')] };
      },
    };
    const res = await runReviewPass(INPUT, { ...CTX, reviewers: [flaky] });
    assert.equal(calls, 2);
    assert.equal(res.per_reviewer_status[0].status, 'repaired');
    assert.equal(res.findings.length, 1);
  });
});

describe('runReviewPass — backstop behavior (AC6)', () => {
  it('CodeReviewAgent findings still drive the pass when both ported reviewers self-fail', async () => {
    const counter = { calls: 0 };
    const audit = collector();
    const res = await runReviewPass(INPUT, {
      ...CTX,
      audit,
      reviewers: [
        reviewer(SOURCE.CODE_REVIEW, [finding(SOURCE.CODE_REVIEW, 'blocker', { description: 'NPE on empty input' })]),
        malformedReviewer(SOURCE.ADVERSARIAL, counter),
        {
          source: SOURCE.EDGE_CASE,
          run: async () => {
            throw new Error('edge-case-hunter crashed');
          },
        },
      ],
    });

    // The code-review blocker survives and drives the revision.
    assert.equal(res.triggers_revision, true);
    assert.equal(res.findings.length, 1);
    assert.equal(res.findings[0].source, SOURCE.CODE_REVIEW);

    const bySource = Object.fromEntries(res.per_reviewer_status.map((s) => [s.source, s.status]));
    assert.equal(bySource[SOURCE.CODE_REVIEW], 'ok');
    assert.equal(bySource[SOURCE.ADVERSARIAL], 'warn_and_continue');
    assert.equal(bySource[SOURCE.EDGE_CASE], 'warn_and_continue');
  });
});

describe('runReviewPass — audit entries', () => {
  it('writes review.findings.deduped and review.revision.triggered when a blocker survives', async () => {
    const audit = collector();
    await runReviewPass(INPUT, {
      ...CTX,
      audit,
      reviewers: [
        reviewer(SOURCE.ADVERSARIAL, [finding(SOURCE.ADVERSARIAL, 'blocker', { line: 3, description: 'dup' })]),
        reviewer(SOURCE.EDGE_CASE, [finding(SOURCE.EDGE_CASE, 'blocker', { line: 3, description: 'DUP' })]),
      ],
    });
    const actions = audit.entries.map((e) => e.action);
    assert.ok(actions.includes('review.findings.deduped'));
    assert.ok(actions.includes('review.revision.triggered'));
    const deduped = audit.entries.find((e) => e.action === 'review.findings.deduped')!;
    assert.equal(deduped.detail.union_count, 2);
    assert.equal(deduped.detail.deduped_count, 1);
  });

  it('does NOT write review.revision.triggered when nothing warrants a revision', async () => {
    const audit = collector();
    await runReviewPass(INPUT, {
      ...CTX,
      audit,
      reviewers: [reviewer(SOURCE.ADVERSARIAL, [finding(SOURCE.ADVERSARIAL, 'medium')])],
    });
    const actions = audit.entries.map((e) => e.action);
    assert.ok(actions.includes('review.findings.deduped'));
    assert.ok(!actions.includes('review.revision.triggered'));
  });
});

describe('runReviewLoop — bounded by maxReviewRevisions (AC4)', () => {
  function passWith(triggers: boolean): ReviewPassResult {
    return { findings: [], triggers_revision: triggers, per_reviewer_status: [] };
  }

  it('terminates at the existing maxReviewRevisions cap when blockers persist', async () => {
    let passes = 0;
    let revises = 0;
    const hooks: ReviewLoopHooks = {
      maxRevisions: 2,
      blockAndRevise: true,
      runPass: async () => {
        passes += 1;
        return passWith(true); // never resolves the blocker
      },
      revise: async () => {
        revises += 1;
        return true;
      },
    };
    const res = await runReviewLoop(hooks);
    assert.equal(res.revisions, 2, 'stops exactly at the cap');
    assert.equal(revises, 2, 'one re-prompt per revision, no more');
    assert.equal(passes, 3, 'initial pass + one re-review per revision');
  });

  it('honors the caller-supplied cap with no hard-coded ceiling', async () => {
    for (const cap of [0, 1, 4, 7]) {
      let revises = 0;
      const res = await runReviewLoop({
        maxRevisions: cap,
        blockAndRevise: true,
        runPass: async () => passWith(true),
        revise: async () => {
          revises += 1;
          return true;
        },
      });
      assert.equal(res.revisions, cap, `cap ${cap} drives exactly ${cap} revisions`);
      assert.equal(revises, cap);
    }
  });

  it('stops early when a pass no longer warrants a revision', async () => {
    let passes = 0;
    const res = await runReviewLoop({
      maxRevisions: 5,
      blockAndRevise: true,
      runPass: async () => {
        passes += 1;
        return passWith(passes < 2); // first pass triggers, second is clean
      },
      revise: async () => true,
    });
    assert.equal(res.revisions, 1);
    assert.equal(passes, 2);
  });

  it('comment mode reviews once and never revises', async () => {
    let revises = 0;
    const res = await runReviewLoop({
      maxRevisions: 5,
      blockAndRevise: false,
      runPass: async () => passWith(true),
      revise: async () => {
        revises += 1;
        return true;
      },
    });
    assert.equal(res.revisions, 0);
    assert.equal(revises, 0);
  });

  it('aborts the loop when a re-prompt fails (spawn error)', async () => {
    let passes = 0;
    const res = await runReviewLoop({
      maxRevisions: 5,
      blockAndRevise: true,
      runPass: async () => {
        passes += 1;
        return passWith(true);
      },
      revise: async () => false, // spawn error
    });
    assert.equal(res.revisions, 1, 'counts the attempted revision');
    assert.equal(passes, 1, 'no re-review after a failed re-prompt');
  });
});
