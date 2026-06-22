import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { MockLLMClient } from '../../../llm/MockLLMClient.js';
import type { LLMClient, LLMRequest } from '../../../llm/LLMClient.js';
import { main } from '../run.js';

// ── Helpers ───────────────────────────────────────────────────────────────────

const VALID_SKILL_MD = `---
name: test-eval-skill
description: A test skill for eval integration tests
metadata:
  source: generated
  category: testing
---

# Test Eval Skill

When writing eval harnesses, isolate each run to a dedicated temp dir
to prevent test pollution between cases.
`;

function judgeJson(): string {
  return JSON.stringify({
    well_formed:           0.90,
    reusable:              0.85,
    faithfulness:          0.88,
    scope_appropriateness: 0.80,
    spurious:              false,
    low_quality:           false,
    reason:                'Mock judgment for integration test.',
  });
}

function isJudgeRequest(req: LLMRequest): boolean {
  return req.messages.some(
    (m) => typeof m.content === 'string' && m.content.includes('<skill_md>'),
  );
}

function mockResponder(req: LLMRequest): string {
  return isJudgeRequest(req) ? judgeJson() : VALID_SKILL_MD;
}

// ── Case 1: main() wires the full eval pipeline (AC1) ─────────────────────────

describe('main() — end-to-end with MockLLMClient', () => {
  let tmpDir: string;
  let reportMd: string;
  let reportJson: string;

  before(() => {
    tmpDir     = fs.mkdtempSync(path.join(os.tmpdir(), 'loom-sg-run-test-'));
    reportMd   = path.join(tmpDir, '.loom', 'eval', 'skill-generator-report.md');
    reportJson = path.join(tmpDir, '.loom', 'eval', 'skill-generator-report.json');
  });

  after(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('returns an EvalReport with all required fields', async () => {
    const llm = new MockLLMClient(mockResponder);

    const report = await main({
      llm:         llm as LLMClient,
      projectRoot: tmpDir,
      gateModel:   'test-gate-model',
      judgeModel:  'test-judge-model',
    });

    assert.ok(report.metrics  != null, 'metrics must be present');
    assert.ok(report.decision != null, 'decision must be present');
    assert.ok(Array.isArray(report.perCase), 'perCase must be an array');
    assert.equal(typeof report.markdown, 'string', 'markdown must be a string');
  });

  it('metrics include all skill-generator-specific fields', async () => {
    const llm = new MockLLMClient(mockResponder);

    const report = await main({
      llm:         llm as LLMClient,
      projectRoot: tmpDir,
      gateModel:   'test-gate-model',
      judgeModel:  'test-judge-model',
    });

    const m = report.metrics;
    assert.equal(typeof m.totalCases,             'number');
    assert.equal(typeof m.scoredCases,            'number');
    assert.equal(typeof m.gateFailures,           'number');
    assert.equal(typeof m.gateFailureRate,        'number');
    assert.equal(typeof m.judgeInconclusive,      'number');
    assert.equal(typeof m.judgeInconclusiveRate,  'number');
    assert.equal(typeof m.decisionCorrectness,    'number');
    assert.equal(typeof m.spuriousGenerationRate, 'number');
    assert.equal(typeof m.skillQuality,           'number');
    assert.equal(typeof m.faithfulness,           'number');
    assert.equal(typeof m.lowQualityRate,         'number');
  });

  it('decision has a valid verdict and a reasons array', async () => {
    const llm = new MockLLMClient(mockResponder);

    const report = await main({
      llm:         llm as LLMClient,
      projectRoot: tmpDir,
      gateModel:   'test-gate-model',
      judgeModel:  'test-judge-model',
    });

    const d = report.decision;
    assert.ok(
      d.verdict === 'proceed' || d.verdict === 'do-not-proceed' || d.verdict === 'inconclusive',
      `unexpected verdict: ${d.verdict}`,
    );
    assert.ok(Array.isArray(d.reasons));
  });

  it('writes skill-generator-report.md with expected title', async () => {
    const llm = new MockLLMClient(mockResponder);

    await main({
      llm:         llm as LLMClient,
      projectRoot: tmpDir,
      gateModel:   'test-gate-model',
      judgeModel:  'test-judge-model',
    });

    assert.ok(fs.existsSync(reportMd), `expected ${reportMd} to exist`);
    const content = fs.readFileSync(reportMd, 'utf8');
    assert.ok(content.includes('# Skill-Generator Eval Report'), 'markdown must include report title');
    assert.ok(content.includes('Decision:'), 'markdown must include Decision field');
  });

  it('writes skill-generator-report.json with all top-level keys', async () => {
    const llm = new MockLLMClient(mockResponder);

    await main({
      llm:         llm as LLMClient,
      projectRoot: tmpDir,
      gateModel:   'test-gate-model',
      judgeModel:  'test-judge-model',
    });

    assert.ok(fs.existsSync(reportJson), `expected ${reportJson} to exist`);
    const parsed = JSON.parse(fs.readFileSync(reportJson, 'utf8'));
    assert.ok(parsed.metrics  != null, 'JSON must have metrics');
    assert.ok(parsed.decision != null, 'JSON must have decision');
    assert.ok(Array.isArray(parsed.perCase), 'JSON must have perCase array');
  });

  it('perCase.length matches metrics.totalCases', async () => {
    const llm = new MockLLMClient(mockResponder);

    const report = await main({
      llm:         llm as LLMClient,
      projectRoot: tmpDir,
      gateModel:   'test-gate-model',
      judgeModel:  'test-judge-model',
    });

    assert.ok(report.perCase.length > 0, 'perCase must have at least one record');
    assert.equal(report.perCase.length, report.metrics.totalCases);
  });
});

// ── Case 2: fail-closed on degenerate fixture (too few → inconclusive) ─────────

describe('main() — fail-closed on degenerate fixture', () => {
  let tmpDir: string;
  let fixturePath: string;

  before(() => {
    tmpDir      = fs.mkdtempSync(path.join(os.tmpdir(), 'loom-sg-degen-test-'));
    fixturePath = path.join(tmpDir, 'degen.yaml');
    fs.writeFileSync(fixturePath, [
      'cases:',
      '  - id: degen-001',
      '    source: trivial',
      '    work:',
      '      story:',
      '        id: story-degen-001',
      '        title: Trivial fix',
      '        description: A one-line typo fix.',
      '        acceptance_criteria:',
      '          - Fix typo',
      '      summary: Fixed a typo.',
      '      diff_context: "-  seting\\n+  setting"',
      '      existing_skills: []',
      '    rubric:',
      '      expected_decision: none',
      '      expected_themes: []',
      '      spurious_traps: []',
      '    rationale: Trivial change no skill expected.',
    ].join('\n'), 'utf8');
  });

  after(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('decision is inconclusive when scoredCases < minScoredCases', async () => {
    // Gate returns "NONE" → decision='none' → judge skipped → scoredCases=0 < 2 → inconclusive
    const llm = new MockLLMClient(() => 'NONE');

    const report = await main({
      llm:         llm as LLMClient,
      projectRoot: tmpDir,
      fixturePath,
      gateModel:   'test-gate-model',
      judgeModel:  'test-judge-model',
    });

    assert.equal(report.decision.verdict, 'inconclusive');
    assert.ok(
      report.decision.reasons.some((r) => r.includes('scoredCases')),
      `expected a reason about scoredCases, got: ${JSON.stringify(report.decision.reasons)}`,
    );
  });
});

// ── Case 3: script existence and structure ─────────────────────────────────────

describe('scripts/eval-skill-generator.mjs — structural checks', () => {
  // dist/eval/skill-generator/__tests__/ → 6 levels up → repo root
  const repoRoot   = path.resolve(__dirname, '../../../../../..');
  const scriptPath = path.join(repoRoot, 'scripts', 'eval-skill-generator.mjs');

  it('script file exists', () => {
    assert.ok(fs.existsSync(scriptPath), `expected ${scriptPath} to exist`);
  });

  it('script imports main from skill-generator/run.js', () => {
    const content = fs.readFileSync(scriptPath, 'utf8');
    assert.ok(
      content.includes('skill-generator/run.js'),
      'script must import from skill-generator/run.js',
    );
  });

  it('script calls main()', () => {
    const content = fs.readFileSync(scriptPath, 'utf8');
    assert.ok(content.includes('main('), 'script must call main()');
  });
});

// ── Case 4: eval docs existence and content ────────────────────────────────────

describe('docs/runbooks/skill-generator-eval.md — content checks', () => {
  const repoRoot = path.resolve(__dirname, '../../../../../..');
  const docPath  = path.join(repoRoot, 'docs', 'runbooks', 'skill-generator-eval.md');

  it('runbook file exists', () => {
    assert.ok(fs.existsSync(docPath), `expected ${docPath} to exist`);
  });

  it('runbook explains decisionCorrectness', () => {
    const content = fs.readFileSync(docPath, 'utf8');
    assert.ok(content.includes('decisionCorrectness'), 'must explain decisionCorrectness');
  });

  it('runbook explains spuriousGenerationRate', () => {
    const content = fs.readFileSync(docPath, 'utf8');
    assert.ok(content.includes('spuriousGenerationRate'), 'must explain spuriousGenerationRate');
  });

  it('runbook explains skillQuality', () => {
    const content = fs.readFileSync(docPath, 'utf8');
    assert.ok(content.includes('skillQuality'), 'must explain skillQuality');
  });

  it('runbook states the eval is operator-run, never CI or worker', () => {
    const content = fs.readFileSync(docPath, 'utf8');
    assert.ok(
      content.toLowerCase().includes('operator') && content.toLowerCase().includes('never'),
      'runbook must state operator-run and never CI/worker',
    );
  });
});

// ── Case 5: guard — no real-model imports in this test file ────────────────────

describe('guard — test file uses only mock LLM clients', () => {
  it('run.test.ts source does not import the real LLM client factory', () => {
    // Read the TypeScript source (not the compiled JS) to avoid the self-referential
    // problem of searching a string that appears in assertion messages.
    // __dirname is dist/eval/skill-generator/__tests__; source is 4 levels up at src/...
    const srcPath = path.resolve(__dirname, '../../../../src/eval/skill-generator/__tests__/run.test.ts');
    if (!fs.existsSync(srcPath)) return; // skip if source not available
    const src = fs.readFileSync(srcPath, 'utf8');
    // Build the forbidden import path at runtime to avoid it appearing as a literal.
    const forbidden = ['llm', 'factory'].join('/');
    assert.ok(
      !src.includes(forbidden),
      `test source must not import from ${forbidden} — use MockLLMClient only`,
    );
  });
});
