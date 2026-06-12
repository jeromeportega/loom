import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { registerReviewerSkills } from '../skills/reviewerSkills.js';
import { buildReviewOrchestrator } from '../orchestrator/workerFactory.js';
import { runReviewPass, runReviewLoop } from '../review/orchestrator.js';
import { MockLLMClient } from '../llm/MockLLMClient.js';
import { openDatabase, resetDatabaseForTest } from '../state/Database.js';
import { SOURCE } from '../findings/sources.js';
import { CodeReviewAgent } from '../review/CodeReviewAgent.js';
import type Database from 'better-sqlite3';
import type { WorkerAssignment } from '../orchestrator/WorkerRunner.js';
import type { Story } from '../types.js';

// ─── helpers ─────────────────────────────────────────────────────────────────

function writeSkill(projectRoot: string, name: string, body: string): void {
  const dir = path.join(projectRoot, '.loom', 'skills', name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'SKILL.md'),
    `---\nname: ${name}\ndescription: ${name} skill\n---\n\n${body}\n`,
  );
}

const SKILL_BODY_ADVERSARIAL = 'Adversarial review instructions.';
const SKILL_BODY_EDGE_CASE = 'Edge-case hunter instructions.';

/** Returns a canned adversarial-review response containing a blocker finding.
 *  When withDuplicate is true, also includes the shared duplicate finding. */
function adversarialResponse(withDuplicate = false): string {
  const findings: object[] = [
    {
      severity: 'blocker',
      category: 'security',
      location: { file: 'src/auth.ts', line: 10 },
      description: 'Missing authorization check on sensitive endpoint',
      source: SOURCE.ADVERSARIAL,
    },
  ];
  if (withDuplicate) {
    findings.push({
      severity: 'high',
      category: 'logic',
      location: { file: 'src/shared.ts', line: 5 },
      description: 'Shared duplicate finding from both reviewers',
      source: SOURCE.ADVERSARIAL,
    });
  }
  return '```json\n' + JSON.stringify({ findings }) + '\n```';
}

/** Returns a canned edge-case-hunter response with a benign unique finding.
 *  When withDuplicate is true, also includes the shared duplicate finding
 *  (lower severity than adversarial's copy, so dedup keeps adversarial's). */
function edgeCaseResponse(withDuplicate = false): string {
  const findings: object[] = [
    {
      severity: 'low',
      category: 'robustness',
      location: { file: 'src/util.ts', line: 20 },
      description: 'No null check on optional parameter',
      source: SOURCE.EDGE_CASE,
    },
  ];
  if (withDuplicate) {
    findings.push({
      severity: 'medium',
      category: 'logic',
      location: { file: 'src/shared.ts', line: 5 },
      description: 'Shared duplicate finding from both reviewers',
      source: SOURCE.EDGE_CASE,
    });
  }
  return '```json\n' + JSON.stringify({ findings }) + '\n```';
}

/** Returns an empty (benign) code-review response in the CodeReviewAgent format. */
function codeReviewBenignResponse(): string {
  return '```json\n' + JSON.stringify({ findings: [], summary: 'No issues found.' }) + '\n```';
}

const STORY_ID = 'story-002-003-inttest';
const EPIC_ID = 'epic-002';

const STORY: Story = {
  id: STORY_ID,
  title: 'Integration test story',
  description: 'A story used for the orchestrated review pass integration test.',
  acceptance_criteria: ['Passes all tests'],
  estimated_complexity: 'small',
  dependencies: [],
};

const REVIEWER_INPUT = {
  diff: '+ console.log("integration test")',
  changed_files: ['src/test.ts'],
  story_context: 'Add an integration test.',
};

function makeAssignment(): WorkerAssignment {
  return {
    storyId: STORY_ID,
    epicId: EPIC_ID,
    story: STORY,
    worktreePath: '/tmp/worktree',
    branchName: 'story/story-002-003',
    baseSha: 'abc123',
    projectRoot: '/tmp/project',
    skills: [],
  };
}

// ─── per-test state ───────────────────────────────────────────────────────────

let tmp: string;
let projectRoot: string;
let db: Database.Database;

beforeEach(() => {
  resetDatabaseForTest();
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'loom-orp-'));
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

// ─── AC-1: NO LIVE MODEL (FR-8, NFR-3) ───────────────────────────────────────

describe('no live model — all LLM calls use injected MockLLMClient', () => {
  it('all reviewer and code-review requests go through mock clients; no live client constructed', async () => {
    const reviewerLlm = new MockLLMClient((req) =>
      req.system[0]?.text.includes(SKILL_BODY_ADVERSARIAL)
        ? adversarialResponse()
        : edgeCaseResponse(),
    );
    const codeReviewLlm = new MockLLMClient(() => codeReviewBenignResponse());

    registerReviewerSkills({ llm: reviewerLlm, model: 'test-model', projectRoot });
    const reviewAgent = new CodeReviewAgent({ projectRoot, llm: codeReviewLlm, model: 'test-model' });
    const orchestrator = buildReviewOrchestrator({
      db,
      llm: reviewerLlm,
      reviewAgent,
      reviewStrategy: 'block-and-revise',
    })!;

    const deps = orchestrator(makeAssignment());
    await runReviewPass(REVIEWER_INPUT, {
      story_id: STORY_ID,
      epic_id: EPIC_ID,
      revision_index: 0,
      ...deps,
    });

    assert.ok(reviewerLlm.requests.length >= 2, 'both skill reviewers must have used the mock');
    assert.ok(
      reviewerLlm.requests.every((r) => r.model === 'test-model'),
      'every skill reviewer request must carry the injected model id',
    );
    assert.ok(codeReviewLlm.requests.length >= 1, 'code-review agent must have used its mock');
    assert.ok(
      codeReviewLlm.requests.every((r) => r.model === 'test-model'),
      'every code-review request must carry the injected model id',
    );
  });
});

// ─── AC-2: DEDUPED UNION ─────────────────────────────────────────────────────

describe('deduped union — overlapping findings from two reviewers collapse to one', () => {
  it('union of 4 raw findings dedupes to 3, keeping the higher-severity copy; audit row written', async () => {
    // adversarial: [blocker, shared-high]  edge-case: [unique-low, shared-medium]
    // shared finding has same file/line/description → deduped; high wins over medium
    const reviewerLlm = new MockLLMClient((req) =>
      req.system[0]?.text.includes(SKILL_BODY_ADVERSARIAL)
        ? adversarialResponse(true)
        : edgeCaseResponse(true),
    );
    const codeReviewLlm = new MockLLMClient(() => codeReviewBenignResponse());

    registerReviewerSkills({ llm: reviewerLlm, model: 'test-model', projectRoot });
    const reviewAgent = new CodeReviewAgent({ projectRoot, llm: codeReviewLlm, model: 'test-model' });
    const orchestrator = buildReviewOrchestrator({
      db, llm: reviewerLlm, reviewAgent, reviewStrategy: 'block-and-revise',
    })!;

    const deps = orchestrator(makeAssignment());
    const result = await runReviewPass(REVIEWER_INPUT, {
      story_id: STORY_ID,
      epic_id: EPIC_ID,
      revision_index: 0,
      ...deps,
    });

    // raw: 2 (adversarial) + 2 (edge-case) + 0 (code-review) = 4 → deduped: 3
    assert.equal(result.findings.length, 3, 'duplicate finding must collapse to one');
    assert.ok(result.triggers_revision, 'blocker finding must set triggers_revision');

    const shared = result.findings.find(
      (f) => f.description === 'Shared duplicate finding from both reviewers',
    );
    assert.ok(shared, 'shared finding must appear exactly once after dedup');
    assert.equal(shared!.severity, 'high', 'dedup must keep the higher-severity (high) copy over medium');

    // review.findings.deduped audit row records the counts
    const dedupeRow = db
      .prepare("SELECT detail FROM audit_log WHERE action = 'review.findings.deduped'")
      .get() as { detail: string } | undefined;
    assert.ok(dedupeRow, 'review.findings.deduped audit row must be written');
    const detail = JSON.parse(dedupeRow!.detail) as Record<string, unknown>;
    assert.equal(detail.union_count, 4, 'union_count must be 4 (pre-dedup raw total)');
    assert.equal(detail.deduped_count, 3, 'deduped_count must be 3 (post-dedup total)');
  });
});

// ─── AC-3: BOUNDED REVISION ──────────────────────────────────────────────────

describe('bounded revision — blocker triggers revision; loop caps at maxRevisions', () => {
  it('revise callback invoked exactly maxRevisions times when blocker persists; audit row written', async () => {
    // adversarial always returns a blocker → each pass triggers_revision=true
    // loop must stop after maxRevisions revisions regardless
    const reviewerLlm = new MockLLMClient((req) =>
      req.system[0]?.text.includes(SKILL_BODY_ADVERSARIAL)
        ? adversarialResponse()
        : edgeCaseResponse(),
    );
    const codeReviewLlm = new MockLLMClient(() => codeReviewBenignResponse());

    registerReviewerSkills({ llm: reviewerLlm, model: 'test-model', projectRoot });
    const reviewAgent = new CodeReviewAgent({ projectRoot, llm: codeReviewLlm, model: 'test-model' });
    const orchestrator = buildReviewOrchestrator({
      db, llm: reviewerLlm, reviewAgent, reviewStrategy: 'block-and-revise',
    })!;

    const deps = orchestrator(makeAssignment());
    const MAX_REVISIONS = 1;
    let reviseCallCount = 0;

    const loopResult = await runReviewLoop({
      maxRevisions: MAX_REVISIONS,
      blockAndRevise: true,
      runPass: async (revisionIndex) =>
        runReviewPass(REVIEWER_INPUT, {
          story_id: STORY_ID,
          epic_id: EPIC_ID,
          revision_index: revisionIndex,
          ...deps,
        }),
      revise: async (_pass, _idx) => {
        reviseCallCount += 1;
        return true;
      },
    });

    assert.equal(reviseCallCount, MAX_REVISIONS, 'revise must be invoked exactly maxRevisions times');
    assert.equal(loopResult.revisions, MAX_REVISIONS, 'loop result must report the capped revision count');

    // review.revision.triggered audit row must exist from the initial pass
    const triggerRow = db
      .prepare("SELECT * FROM audit_log WHERE action = 'review.revision.triggered'")
      .get() as { action: string } | undefined;
    assert.ok(triggerRow, 'review.revision.triggered audit row must be written when blocker present');
  });
});

// ─── AC-4: PROVENANCE FOR BOTH SKILL REVIEWERS (FR-8) ────────────────────────

describe('provenance — skill_usage and audit_log rows for both ported reviewers', () => {
  it('skill_usage has a row for adversarial-review and edge-case-hunter after one pass', async () => {
    const reviewerLlm = new MockLLMClient((req) =>
      req.system[0]?.text.includes(SKILL_BODY_ADVERSARIAL)
        ? adversarialResponse()
        : edgeCaseResponse(),
    );
    const codeReviewLlm = new MockLLMClient(() => codeReviewBenignResponse());

    registerReviewerSkills({ llm: reviewerLlm, model: 'test-model', projectRoot });
    const reviewAgent = new CodeReviewAgent({ projectRoot, llm: codeReviewLlm, model: 'test-model' });
    const orchestrator = buildReviewOrchestrator({
      db, llm: reviewerLlm, reviewAgent, reviewStrategy: 'block-and-revise',
    })!;

    const deps = orchestrator(makeAssignment());
    await runReviewPass(REVIEWER_INPUT, {
      story_id: STORY_ID,
      epic_id: EPIC_ID,
      revision_index: 0,
      ...deps,
    });

    const usageRows = db
      .prepare('SELECT skill_name FROM skill_usage WHERE story_id = ?')
      .all(STORY_ID) as Array<{ skill_name: string }>;
    const usedNames = new Set(usageRows.map((r) => r.skill_name));
    assert.ok(usedNames.has(SOURCE.ADVERSARIAL), 'skill_usage must have a row for adversarial-review');
    assert.ok(usedNames.has(SOURCE.EDGE_CASE), 'skill_usage must have a row for edge-case-hunter');
  });

  it('audit_log has a skill_invoked row for adversarial-review and edge-case-hunter after one pass', async () => {
    const reviewerLlm = new MockLLMClient((req) =>
      req.system[0]?.text.includes(SKILL_BODY_ADVERSARIAL)
        ? adversarialResponse()
        : edgeCaseResponse(),
    );
    const codeReviewLlm = new MockLLMClient(() => codeReviewBenignResponse());

    registerReviewerSkills({ llm: reviewerLlm, model: 'test-model', projectRoot });
    const reviewAgent = new CodeReviewAgent({ projectRoot, llm: codeReviewLlm, model: 'test-model' });
    const orchestrator = buildReviewOrchestrator({
      db, llm: reviewerLlm, reviewAgent, reviewStrategy: 'block-and-revise',
    })!;

    const deps = orchestrator(makeAssignment());
    await runReviewPass(REVIEWER_INPUT, {
      story_id: STORY_ID,
      epic_id: EPIC_ID,
      revision_index: 0,
      ...deps,
    });

    const auditRows = db
      .prepare("SELECT command FROM audit_log WHERE action = 'skill_invoked'")
      .all() as Array<{ command: string }>;
    const auditedCommands = new Set(auditRows.map((r) => r.command));
    assert.ok(auditedCommands.has(SOURCE.ADVERSARIAL), 'audit_log must have skill_invoked row for adversarial-review');
    assert.ok(auditedCommands.has(SOURCE.EDGE_CASE), 'audit_log must have skill_invoked row for edge-case-hunter');
  });
});
