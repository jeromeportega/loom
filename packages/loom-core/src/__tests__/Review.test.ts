import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  CodeReviewAgent,
  parseReviewReport,
  PrDescriptionAgent,
} from '../review/index.js';
import { MockLLMClient } from '../llm/MockLLMClient.js';

function tmpProject(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'loom-review-'));
}

describe('parseReviewReport', () => {
  it('extracts findings from a fenced JSON block', () => {
    const body =
      'Sure, here is the review:\n\n```json\n' +
      JSON.stringify({
        findings: [
          {
            severity: 'blocker',
            file: 'src/app.ts',
            line: 42,
            issue: 'Missing null check on payload',
            suggestion: 'Validate payload before access',
          },
          { severity: 'nit', file: 'src/util.ts', issue: 'Inconsistent quotes' },
        ],
        summary: 'One blocker, one nit.',
      }) +
      '\n```';
    const report = parseReviewReport(body);
    assert.equal(report.findings.length, 2);
    assert.equal(report.findings[0].severity, 'blocker');
    assert.equal(report.findings[0].line, 42);
    assert.equal(report.findings[1].suggestion, undefined);
    assert.match(report.summary, /blocker/);
  });

  it('degrades gracefully when the response is not JSON', () => {
    const report = parseReviewReport('I cannot review this without more context.');
    assert.equal(report.findings.length, 1);
    assert.equal(report.findings[0].severity, 'should-fix');
    assert.match(report.findings[0].issue, /JSON/);
  });

  it('filters out malformed finding entries without throwing', () => {
    const body =
      '```json\n' +
      JSON.stringify({
        findings: [
          { severity: 'INVALID', file: 'a.ts', issue: 'bogus' },
          { severity: 'should-fix', file: 'b.ts' }, // missing issue
          { severity: 'nit', file: 'c.ts', issue: 'valid' },
        ],
        summary: 'mixed',
      }) +
      '\n```';
    const report = parseReviewReport(body);
    assert.equal(report.findings.length, 1);
    assert.equal(report.findings[0].file, 'c.ts');
  });
});

describe('CodeReviewAgent.review', () => {
  it('returns a structured report from a scripted LLM response', async () => {
    const root = tmpProject();
    try {
      const scripted =
        '```json\n' +
        JSON.stringify({
          findings: [
            { severity: 'should-fix', file: 'src/x.ts', issue: 'No error handling' },
          ],
          summary: 'Needs error handling.',
        }) +
        '\n```';
      const llm = new MockLLMClient([scripted]);
      const result = await new CodeReviewAgent({
        projectRoot: root,
        llm,
        model: 'm',
      }).review({
        story: {
          storyId: 'story-001-001',
          title: 'Add /health',
          description: 'returns 200',
          acceptanceCriteria: ['returns 200'],
        },
        diff: '+ console.log("hi")',
      });
      assert.equal(result.report.findings.length, 1);
      assert.equal(result.report.findings[0].file, 'src/x.ts');
      assert.match(result.report.summary, /error handling/);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('PrDescriptionAgent.generate', () => {
  it('returns the LLM body verbatim (trimmed) as the PR description', async () => {
    const root = tmpProject();
    try {
      const body =
        '# Add /health endpoint\n\n## What this PR does\nAdds the route.';
      const llm = new MockLLMClient([body]);
      const result = await new PrDescriptionAgent({
        projectRoot: root,
        llm,
        model: 'm',
      }).generate({
        title: 'Health checks',
        stories: [
          {
            storyId: 'story-001-001',
            title: 'Add /health',
            description: 'A liveness endpoint.',
            acceptanceCriteria: ['returns 200'],
          },
        ],
        diffStat: 'src/app.ts | 5 +++++',
        commitLog: 'abc1234 add /health',
      });
      assert.equal(result.description.startsWith('# Add /health endpoint'), true);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
