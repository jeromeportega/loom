import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { registerReviewerSkills } from '../skills/reviewerSkills.js';
import { invokeSkill } from '../skills/types.js';
import { SOURCE } from '../findings/sources.js';
import { MockLLMClient } from '../llm/MockLLMClient.js';
import { openDatabase, resetDatabaseForTest } from '../state/Database.js';
import type Database from 'better-sqlite3';

// ─── helpers ─────────────────────────────────────────────────────────────────

function writeSkill(projectRoot: string, name: string, body: string): void {
  const dir = path.join(projectRoot, '.loom', 'skills', name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'SKILL.md'),
    `---\nname: ${name}\ndescription: ${name} skill\n---\n\n${body}\n`
  );
}

/** A syntactically valid canned response containing one Finding. */
function cannedResponse(source: string): string {
  return (
    '```json\n' +
    JSON.stringify({
      findings: [
        {
          severity: 'high',
          category: 'logic',
          location: { file: 'src/x.ts', line: 12 },
          description: 'found an issue',
          source,
        },
      ],
    }) +
    '\n```'
  );
}

const SKILL_BODY_ADVERSARIAL = 'Adversarial review instructions.';
const SKILL_BODY_EDGE_CASE = 'Edge-case hunter instructions.';

const SAMPLE_INPUT = {
  diff: '+ console.log("hi")',
  changed_files: ['src/x.ts'],
  story_context: 'Add a log statement.',
};

// ─── per-test state ───────────────────────────────────────────────────────────

let tmp: string;
let projectRoot: string;
let db: Database.Database;

beforeEach(() => {
  resetDatabaseForTest();
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'loom-rs-'));
  projectRoot = tmp;
  const loomDir = path.join(tmp, '.loom');
  fs.mkdirSync(loomDir, { recursive: true });
  db = openDatabase(loomDir);
  writeSkill(projectRoot, SOURCE.ADVERSARIAL, SKILL_BODY_ADVERSARIAL);
  writeSkill(projectRoot, SOURCE.EDGE_CASE, SKILL_BODY_EDGE_CASE);
});

afterEach(() => {
  resetDatabaseForTest();
  fs.rmSync(tmp, { recursive: true, force: true });
});

// ─── HAPPY PATH ───────────────────────────────────────────────────────────────

describe('adversarial-review handler — happy path', () => {
  it('returns a parsed ReviewerOutput with source stamped as SOURCE.ADVERSARIAL', async () => {
    const llm = new MockLLMClient([cannedResponse(SOURCE.ADVERSARIAL)]);
    registerReviewerSkills({ llm, model: 'm', projectRoot });

    const result = await invokeSkill(
      {
        name: SOURCE.ADVERSARIAL,
        input: SAMPLE_INPUT,
        story_id: 'story-002-001',
        epic_id: 'epic-002',
      },
      { db }
    );

    const output = result.output as { findings: Array<{ source: string }> };
    assert.equal(output.findings.length, 1);
    assert.equal(output.findings[0].source, SOURCE.ADVERSARIAL);
  });
});

describe('edge-case-hunter handler — happy path', () => {
  it('returns a parsed ReviewerOutput with source stamped as SOURCE.EDGE_CASE', async () => {
    const llm = new MockLLMClient([cannedResponse(SOURCE.EDGE_CASE)]);
    registerReviewerSkills({ llm, model: 'm', projectRoot });

    const result = await invokeSkill(
      {
        name: SOURCE.EDGE_CASE,
        input: SAMPLE_INPUT,
        story_id: 'story-002-001',
        epic_id: 'epic-002',
      },
      { db }
    );

    const output = result.output as { findings: Array<{ source: string }> };
    assert.equal(output.findings.length, 1);
    assert.equal(output.findings[0].source, SOURCE.EDGE_CASE);
  });
});

// ─── PROMPT SHAPE (NFR-1) ─────────────────────────────────────────────────────

describe('prompt shape', () => {
  it('sends the SKILL.md body in a cached system block and ReviewerInput as user message', async () => {
    const llm = new MockLLMClient([cannedResponse(SOURCE.ADVERSARIAL)]);
    registerReviewerSkills({ llm, model: 'm', projectRoot });

    await invokeSkill(
      {
        name: SOURCE.ADVERSARIAL,
        input: SAMPLE_INPUT,
        story_id: 'story-002-001',
        epic_id: 'epic-002',
      },
      { db }
    );

    assert.equal(llm.requests.length, 1);
    const req = llm.requests[0];

    // system: exactly one block, marked cache: true, contains the SKILL.md body
    assert.equal(req.system.length, 1);
    assert.equal(req.system[0].cache, true);
    assert.ok(
      req.system[0].text.includes(SKILL_BODY_ADVERSARIAL),
      'system block must contain the SKILL.md body'
    );

    // the diff lives in the user message, NOT in the system block
    assert.ok(
      !req.system[0].text.includes('console.log'),
      'diff must not appear in the cached system block'
    );

    // user message is the JSON-serialised ReviewerInput (after the cache boundary)
    assert.equal(req.messages.length, 1);
    assert.equal(req.messages[0].role, 'user');
    assert.equal(req.messages[0].content, JSON.stringify(SAMPLE_INPUT));
  });

  it('edge-case-hunter sends its own SKILL.md body in the system block', async () => {
    const llm = new MockLLMClient([cannedResponse(SOURCE.EDGE_CASE)]);
    registerReviewerSkills({ llm, model: 'm', projectRoot });

    await invokeSkill(
      {
        name: SOURCE.EDGE_CASE,
        input: SAMPLE_INPUT,
        story_id: 'story-002-001',
        epic_id: 'epic-002',
      },
      { db }
    );

    assert.equal(llm.requests.length, 1);
    assert.ok(
      llm.requests[0].system[0].text.includes(SKILL_BODY_EDGE_CASE),
      'edge-case-hunter system block must contain its own SKILL.md body'
    );
  });
});

// ─── MALFORMED OUTPUT (FR-2 / ADR-003) ───────────────────────────────────────

describe('malformed LLM output', () => {
  it('throws when the response has no JSON block (prose response)', async () => {
    const llm = new MockLLMClient(['I cannot review this without more context.']);
    registerReviewerSkills({ llm, model: 'm', projectRoot });

    await assert.rejects(
      () =>
        invokeSkill(
          {
            name: SOURCE.ADVERSARIAL,
            input: SAMPLE_INPUT,
            story_id: 'story-002-001',
            epic_id: 'epic-002',
          },
          { db }
        ),
      'handler must throw on a response with no JSON fenced block'
    );
  });

  it('throws when the JSON block is missing required Finding fields (ZodError)', async () => {
    // findings[0] has no category / location / description — invalid schema
    const malformed =
      '```json\n' +
      JSON.stringify({ findings: [{ severity: 'high' }] }) +
      '\n```';
    const llm = new MockLLMClient([malformed]);
    registerReviewerSkills({ llm, model: 'm', projectRoot });

    await assert.rejects(
      () =>
        invokeSkill(
          {
            name: SOURCE.ADVERSARIAL,
            input: SAMPLE_INPUT,
            story_id: 'story-002-001',
            epic_id: 'epic-002',
          },
          { db }
        ),
      'handler must propagate ZodError on schema-invalid output'
    );
  });

  it('throws for edge-case-hunter on malformed output too', async () => {
    const llm = new MockLLMClient(['Not JSON at all.']);
    registerReviewerSkills({ llm, model: 'm', projectRoot });

    await assert.rejects(
      () =>
        invokeSkill(
          {
            name: SOURCE.EDGE_CASE,
            input: SAMPLE_INPUT,
            story_id: 'story-002-001',
            epic_id: 'epic-002',
          },
          { db }
        )
    );
  });
});

// ─── PROVENANCE (FR-4) ────────────────────────────────────────────────────────

describe('provenance', () => {
  it('invokeSkill writes exactly one skill_usage row per call (no handler duplication)', async () => {
    const llm = new MockLLMClient([cannedResponse(SOURCE.ADVERSARIAL)]);
    registerReviewerSkills({ llm, model: 'm', projectRoot });

    await invokeSkill(
      {
        name: SOURCE.ADVERSARIAL,
        input: SAMPLE_INPUT,
        story_id: 'story-002-001',
        epic_id: 'epic-002',
      },
      { db }
    );

    const rows = db
      .prepare('SELECT * FROM skill_usage WHERE story_id = ?')
      .all('story-002-001') as Array<{ skill_name: string }>;

    assert.equal(rows.length, 1, 'exactly one skill_usage row — handler must not write its own');
    assert.equal(rows[0].skill_name, SOURCE.ADVERSARIAL);
  });

  it('invokeSkill writes exactly one audit_log row per call (no handler duplication)', async () => {
    const llm = new MockLLMClient([cannedResponse(SOURCE.ADVERSARIAL)]);
    registerReviewerSkills({ llm, model: 'm', projectRoot });

    await invokeSkill(
      {
        name: SOURCE.ADVERSARIAL,
        input: SAMPLE_INPUT,
        story_id: 'story-002-001',
        epic_id: 'epic-002',
      },
      { db }
    );

    const rows = db
      .prepare("SELECT * FROM audit_log WHERE action = 'skill_invoked'")
      .all() as Array<{ action: string }>;

    assert.equal(rows.length, 1, 'exactly one audit_log row — handler must not write its own');
  });
});

// ─── NO LIVE MODEL (NFR-3) ───────────────────────────────────────────────────

describe('no live model', () => {
  it('all LLM calls go through the injected MockLLMClient, never a live client', async () => {
    const llm = new MockLLMClient([
      cannedResponse(SOURCE.ADVERSARIAL),
      cannedResponse(SOURCE.EDGE_CASE),
    ]);
    registerReviewerSkills({ llm, model: 'test-model', projectRoot });

    await invokeSkill(
      {
        name: SOURCE.ADVERSARIAL,
        input: SAMPLE_INPUT,
        story_id: 'story-002-001',
        epic_id: 'epic-002',
      },
      { db }
    );
    await invokeSkill(
      {
        name: SOURCE.EDGE_CASE,
        input: SAMPLE_INPUT,
        story_id: 'story-002-001',
        epic_id: 'epic-002',
      },
      { db }
    );

    // Every request used the injected model identifier, not a live endpoint
    assert.equal(llm.requests.length, 2);
    assert.ok(
      llm.requests.every((r) => r.model === 'test-model'),
      'all requests must use the injected model — no live client invoked'
    );
  });
});
