import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import yaml from 'js-yaml';

import { MockLLMClient } from '../../../llm/MockLLMClient.js';
import { createBriefQualityConsumer } from '../consumer.js';
import { runBriefQualityGate } from '../runGate.js';
import { main } from '../run.js';
import type { BriefQualityCase } from '../caseSchema.js';
import type { BriefRefinement } from '../../../brief/types.js';

// ── Helpers ───────────────────────────────────────────────────────────────────

function wrapJson(obj: unknown): string {
  return '```json\n' + JSON.stringify(obj) + '\n```';
}

function refinementJson(ready: boolean, quality_score: number): string {
  return wrapJson({
    ready,
    quality_score,
    refined_brief: ready ? '# Refined Brief' : undefined,
    critique: {
      strong_points: ['clear scope'],
      ambiguities: [],
      missing_scope: [],
      untestable_claims: [],
      hidden_complexity: [],
    },
    questions: [],
    delta: { added_sections: [], clarifications: [], flagged_assumptions: [] },
  });
}

function judgeJson(critique_fidelity: 'faithful' | 'partial' | 'fabricated'): string {
  return wrapJson({ critique_fidelity, reason: 'test judgment' });
}

function makeTmpFixture(cases: BriefQualityCase[]): string {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bq-eval-'));
  const file = path.join(tmpDir, 'brief-quality.yaml');
  fs.writeFileSync(file, yaml.dump({ cases }));
  return file;
}

const BASE_CASE: BriefQualityCase = {
  id:              'bq-test-001',
  source:          'anchor',
  category:        'plan-ready',
  brief:           'Add a --version flag to the CLI.',
  expected_ready:  true,
  expected_band:   'high',
  critique_themes: ['clear scope', 'testable acceptance criterion'],
  rationale:       'Classic single-concern CLI addition.',
};

// ── runGate wiring ────────────────────────────────────────────────────────────

describe('createBriefQualityConsumer — runGate', () => {
  it('invokes BriefRefiner.refine(brief) exactly once per case', async () => {
    const llm = new MockLLMClient([refinementJson(true, 8)]);
    const consumer = createBriefQualityConsumer({ projectRoot: process.cwd() });
    const result = await consumer.runGate(BASE_CASE, { llm, gateModel: 'gate-model' });

    assert.equal(result.status, 'ok', `Expected ok, got: ${JSON.stringify(result)}`);
    assert.equal(llm.requests.length, 1, 'exactly 1 gate call');
  });

  it('maps a thrown error to {status: failed} when refiner.refine() throws', async () => {
    // BriefRefiner.refine() itself never throws (it returns fallback on errors).
    // We test the catch contract via the _refinerFactory injection seam.
    const throwingFactory = () => ({
      async refine() { throw new Error('refiner internal failure'); },
    });
    const llm = new MockLLMClient([]);
    const result = await runBriefQualityGate(BASE_CASE, { llm, gateModel: 'g' }, process.cwd(), throwingFactory);

    assert.equal(result.status, 'failed');
    if (result.status === 'failed') {
      assert.ok(result.detail.includes('refiner internal failure'));
    }
  });

  it('success returns {status: ok, output: BriefRefinement}', async () => {
    const llm = new MockLLMClient([refinementJson(true, 7)]);
    const consumer = createBriefQualityConsumer({ projectRoot: process.cwd() });
    const result = await consumer.runGate(BASE_CASE, { llm, gateModel: 'g' });

    assert.equal(result.status, 'ok');
    if (result.status !== 'ok') return;
    // Verify BriefRefinement fields are present — do NOT add new required fields
    assert.equal(typeof result.output.ready, 'boolean');
    assert.equal(typeof result.output.quality_score, 'number');
    assert.ok(result.output.critique !== undefined);
    assert.ok(Array.isArray(result.output.questions));
  });
});

// ── judge wiring ──────────────────────────────────────────────────────────────

describe('createBriefQualityConsumer — judge', () => {
  const MOCK_REFINEMENT: BriefRefinement = {
    ready: true,
    original: 'Add a --version flag to the CLI.',
    quality_score: 8,
    blocking_gaps: [],
    critique: {
      strong_points: ['clear scope'],
      ambiguities: [],
      missing_scope: [],
      untestable_claims: [],
      hidden_complexity: [],
    },
    questions: [],
    delta: { added_sections: [], clarifications: [], flagged_assumptions: [] },
  };

  it('returns ok judgment with all three LLM-derived axes + computed quality_in_band', async () => {
    const llm = new MockLLMClient([judgeJson('faithful')]);
    const consumer = createBriefQualityConsumer({ projectRoot: process.cwd() });
    const result = await consumer.judge(BASE_CASE, MOCK_REFINEMENT, { llm, judgeModel: 'j' });

    assert.equal(result.status, 'ok');
    if (result.status !== 'ok') return;
    assert.equal(typeof result.judgment.readiness_correct, 'boolean');
    assert.equal(typeof result.judgment.quality_in_band, 'boolean');
    assert.ok(['faithful', 'partial', 'fabricated'].includes(result.judgment.critique_fidelity));
    assert.equal(typeof result.judgment.reason, 'string');
  });

  it('maps LLM outage to {status: inconclusive}', async () => {
    const failLLM = {
      async complete() { throw new Error('timeout'); },
    };
    const consumer = createBriefQualityConsumer({ projectRoot: process.cwd() });
    const result = await consumer.judge(BASE_CASE, MOCK_REFINEMENT, { llm: failLLM as any, judgeModel: 'j' });
    assert.equal(result.status, 'inconclusive');
  });
});

// ── decide / fail-closed ──────────────────────────────────────────────────────

describe('decide — fail-closed thresholds checked before quality bar', () => {
  it('too few scored cases → inconclusive regardless of quality metrics', async () => {
    // Only 1 case → below minScoredCases (5)
    const fixturePath = makeTmpFixture([BASE_CASE]);
    const llm = new MockLLMClient([
      refinementJson(true, 8),   // gate
      judgeJson('faithful'), // judge
    ]);
    const { decision } = await main({ llm, fixturePath, projectRoot: process.cwd(), gateModel: 'g', judgeModel: 'j' });

    assert.equal(decision.verdict, 'inconclusive');
    assert.ok(decision.reasons.some(r => r.includes('scoredCases') || r.includes('minScoredCases')));
  });
});

// ── main() end-to-end under mocks ─────────────────────────────────────────────

describe('main() — end-to-end with MockLLMClient', () => {
  it('returns EvalReport with metrics, decision, perCase, and markdown', async () => {
    const cases: BriefQualityCase[] = Array.from({ length: 6 }, (_, i) => ({
      ...BASE_CASE,
      id: `bq-test-${i}`,
    }));
    const fixturePath = makeTmpFixture(cases);

    // Interleave: 6 gate responses then 6 judge responses (sequential per case)
    const responses = cases.flatMap(() => [
      refinementJson(true, 8),
      judgeJson('faithful'),
    ]);
    const llm = new MockLLMClient(responses);

    const report = await main({ llm, fixturePath, projectRoot: process.cwd(), gateModel: 'g', judgeModel: 'j' });

    assert.ok(report.metrics !== undefined, 'metrics present');
    assert.ok(report.decision !== undefined, 'decision present');
    assert.ok(Array.isArray(report.perCase), 'perCase is array');
    assert.equal(report.perCase.length, 6);
    assert.equal(typeof report.markdown, 'string');
    assert.ok(report.markdown.includes('Brief-Quality Eval Report'), 'markdown has title');

    // Assert sequential per-case ordering: gate (model 'g') then judge (model 'j') for each case
    assert.equal(llm.requests.length, 12, '6 gate + 6 judge calls');
    for (let i = 0; i < cases.length; i++) {
      assert.equal(llm.requests[i * 2].model, 'g', `request ${i * 2} should be gate`);
      assert.equal(llm.requests[i * 2 + 1].model, 'j', `request ${i * 2 + 1} should be judge`);
    }
  });

  it('uses only the injected MockLLMClient — no real client constructed', async () => {
    // If main() ever constructed a real client, it would require env setup that
    // is not present in tests, causing it to throw. Passing llm: MockLLMClient
    // and getting a result proves no real client was constructed.
    const fixturePath = makeTmpFixture([BASE_CASE]);
    const llm = new MockLLMClient([
      refinementJson(true, 8),
      judgeJson('faithful'),
    ]);

    const report = await main({ llm, fixturePath, projectRoot: process.cwd(), gateModel: 'g', judgeModel: 'j' });

    // We got a result → no real client was constructed
    assert.ok(report !== undefined, 'report produced with mock only');
  });

  it('markdown contains decision verdict', async () => {
    const fixturePath = makeTmpFixture([BASE_CASE]);
    const llm = new MockLLMClient([
      refinementJson(true, 8),
      judgeJson('faithful'),
    ]);
    const { markdown, decision } = await main({ llm, fixturePath, projectRoot: process.cwd(), gateModel: 'g', judgeModel: 'j' });

    assert.ok(markdown.includes(decision.verdict), 'markdown contains decision verdict');
  });
});

// ── Observe-only: run.ts not registered as a loom subcommand ─────────────────

describe('observe-only (AC3) — run.ts is not a loom subcommand', () => {
  it('loom-cli command table does not reference eval/brief-quality', async () => {
    // Structurally check that run.ts is absent from the CLI command table.
    // A full import-boundary sweep is story-034-006; this test confirms the surface-level constraint.
    const cliIndex = path.resolve(process.cwd(), 'packages/loom-cli/src/index.ts');
    if (!fs.existsSync(cliIndex)) {
      // If the file doesn't exist, we can't check (e.g. fresh worktree).
      return;
    }
    const content = fs.readFileSync(cliIndex, 'utf8');
    assert.ok(
      !content.includes('brief-quality') && !content.includes('briefQuality'),
      'eval/brief-quality must not appear in the CLI command table',
    );
  });

  it('run.ts (dist) does not reference commander or register CLI commands', async () => {
    // Check the compiled dist output for evidence of commander usage.
    // The dist path is resolved relative to __dirname (dist/eval/brief-quality/__tests__/).
    const runDist = path.resolve(__dirname, '../run.js');
    if (!fs.existsSync(runDist)) {
      // Skip in environments without a prior tsc build (e.g. direct tsx invocations, fresh CI).
      return;
    }
    const content = fs.readFileSync(runDist, 'utf8');
    assert.ok(!content.includes('commander'), 'run.ts must not import commander');
    assert.ok(!content.includes('.command('), 'run.ts must not register CLI commands');
  });
});
