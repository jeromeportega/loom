import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { MockLLMClient } from '../../../llm/MockLLMClient.js';
import type { LLMClient, LLMRequest } from '../../../llm/LLMClient.js';
import { main } from '../run.js';

// ── Helpers ───────────────────────────────────────────────────────────────────

function judgeJson() {
  return JSON.stringify({
    coherence:              0.85,
    score_reasonableness:   0.75,
    grounding:              0.90,
    forced_clusters:        0,
    invented_opportunities: 0,
    reason:                 'Mock judgment for test.',
  });
}

function isJudgeRequest(req: LLMRequest): boolean {
  return req.messages.some(
    (m) => typeof m.content === 'string' && m.content.includes('<opportunity_clusters>'),
  );
}

/**
 * Responder: gate calls return '[]' (empty clusters); judge calls return judgment JSON.
 * Distinguishes the two by the presence of '<opportunity_clusters>' in the user message.
 */
function mockResponder(req: LLMRequest): string {
  return isJudgeRequest(req) ? judgeJson() : '[]';
}

// ── Main e2e test (AC1) ───────────────────────────────────────────────────────

describe('main() — end-to-end with MockLLMClient (AC1)', () => {
  let tmpDir: string;
  let reportMd: string;
  let reportJson: string;

  before(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'loom-oe-run-test-'));
    reportMd   = path.join(tmpDir, '.loom', 'eval', 'opportunity-engine-report.md');
    reportJson = path.join(tmpDir, '.loom', 'eval', 'opportunity-engine-report.json');
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

    // EvalReport shape
    assert.ok(report.metrics != null, 'metrics must be present');
    assert.ok(report.decision != null, 'decision must be present');
    assert.ok(Array.isArray(report.perCase), 'perCase must be an array');
    assert.equal(typeof report.markdown, 'string', 'markdown must be a string');
  });

  it('metrics include all required fields', async () => {
    const llm = new MockLLMClient(mockResponder);

    const report = await main({
      llm:         llm as LLMClient,
      projectRoot: tmpDir,
      gateModel:   'test-gate-model',
      judgeModel:  'test-judge-model',
    });

    const m = report.metrics;
    assert.equal(typeof m.totalCases, 'number');
    assert.equal(typeof m.scoredCases, 'number');
    assert.equal(typeof m.gateFailures, 'number');
    assert.equal(typeof m.gateFailureRate, 'number');
    assert.equal(typeof m.judgeInconclusive, 'number');
    assert.equal(typeof m.judgeInconclusiveRate, 'number');
    assert.equal(typeof m.coherence, 'number');
    assert.equal(typeof m.scoreReasonableness, 'number');
    assert.equal(typeof m.grounding, 'number');
    assert.equal(typeof m.forcedClusteringRate, 'number');
    assert.equal(typeof m.hallucinationRate, 'number');
  });

  it('decision includes verdict and reasons', async () => {
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

  it('writes opportunity-engine-report.md (markdown file)', async () => {
    const llm = new MockLLMClient(mockResponder);

    await main({
      llm:         llm as LLMClient,
      projectRoot: tmpDir,
      gateModel:   'test-gate-model',
      judgeModel:  'test-judge-model',
    });

    assert.ok(fs.existsSync(reportMd), `expected ${reportMd} to be created`);
    const content = fs.readFileSync(reportMd, 'utf8');
    assert.ok(content.includes('# Opportunity-Engine Eval Report'), 'markdown must include title');
    assert.ok(content.includes('Decision:'), 'markdown must include Decision field');
  });

  it('writes opportunity-engine-report.json (valid JSON)', async () => {
    const llm = new MockLLMClient(mockResponder);

    await main({
      llm:         llm as LLMClient,
      projectRoot: tmpDir,
      gateModel:   'test-gate-model',
      judgeModel:  'test-judge-model',
    });

    assert.ok(fs.existsSync(reportJson), `expected ${reportJson} to be created`);
    const content = fs.readFileSync(reportJson, 'utf8');
    const parsed = JSON.parse(content);
    assert.ok(parsed.metrics != null, 'JSON must have metrics');
    assert.ok(parsed.decision != null, 'JSON must have decision');
    assert.ok(Array.isArray(parsed.perCase), 'JSON must have perCase array');
  });

  it('perCase length matches the number of cases loaded from the fixture', async () => {
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
