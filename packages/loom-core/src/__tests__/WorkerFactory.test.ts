import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildReviewOrchestrator, createWorker } from '../orchestrator/workerFactory.js';
import { MockLLMClient } from '../llm/MockLLMClient.js';
import { openDatabase, resetDatabaseForTest } from '../state/Database.js';
import { CodeReviewAgent } from '../review/CodeReviewAgent.js';
import { SOURCE } from '../findings/sources.js';
import type Database from 'better-sqlite3';
import type { WorkerAssignment } from '../orchestrator/WorkerRunner.js';
import type { Story } from '../types.js';

// ─── shared fixtures ──────────────────────────────────────────────────────────

const STORY: Story = {
  id: 'story-002-002',
  title: 'Wire reviewOrchestrator',
  description: 'Thread db and LLMClient through workerFactory.',
  acceptance_criteria: ['reviewOrchestrator is set when block-and-revise'],
  estimated_complexity: 'medium',
  dependencies: [],
};

function makeAssignment(): WorkerAssignment {
  return {
    storyId: STORY.id,
    epicId: 'epic-002',
    story: STORY,
    worktreePath: '/tmp/worktree',
    branchName: 'story/story-002-002',
    baseSha: 'abc123',
    projectRoot: '/tmp/project',
    skills: [],
  };
}

let tmp: string;
let db: Database.Database;
let llm: MockLLMClient;
let reviewAgent: CodeReviewAgent;

beforeEach(() => {
  resetDatabaseForTest();
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'loom-wf-'));
  const loomDir = path.join(tmp, '.loom');
  fs.mkdirSync(loomDir, { recursive: true });
  db = openDatabase(loomDir);
  llm = new MockLLMClient([]);
  reviewAgent = new CodeReviewAgent({ projectRoot: tmp, llm, model: 'test-model' });
});

afterEach(() => {
  resetDatabaseForTest();
  fs.rmSync(tmp, { recursive: true, force: true });
});

// ─── GATE TRUTH TABLE (FR-5, FR-7) ───────────────────────────────────────────

describe('buildReviewOrchestrator — gate truth table', () => {
  it('(1) returns a function when block-and-revise + db + llm + reviewAgent all present', () => {
    const result = buildReviewOrchestrator({ reviewStrategy: 'block-and-revise', db, llm, reviewAgent });
    assert.equal(typeof result, 'function');
  });

  it('(2) returns undefined when reviewStrategy is comment', () => {
    const result = buildReviewOrchestrator({ reviewStrategy: 'comment', db, llm, reviewAgent });
    assert.equal(result, undefined);
  });

  it('(3) returns undefined when reviewStrategy is off', () => {
    const result = buildReviewOrchestrator({ reviewStrategy: 'off', db, llm, reviewAgent });
    assert.equal(result, undefined);
  });

  it('(4) returns undefined when block-and-revise but db missing', () => {
    const result = buildReviewOrchestrator({
      reviewStrategy: 'block-and-revise',
      db: undefined,
      llm,
      reviewAgent,
    });
    assert.equal(result, undefined);
  });

  it('(5) returns undefined when block-and-revise but llm missing', () => {
    const result = buildReviewOrchestrator({
      reviewStrategy: 'block-and-revise',
      db,
      llm: undefined,
      reviewAgent,
    });
    assert.equal(result, undefined);
  });

  it('(6) returns undefined when block-and-revise but reviewAgent missing', () => {
    const result = buildReviewOrchestrator({
      reviewStrategy: 'block-and-revise',
      db,
      llm,
      reviewAgent: undefined,
    });
    assert.equal(result, undefined);
  });
});

// ─── SHAPE (FR-5) ────────────────────────────────────────────────────────────

describe('buildReviewOrchestrator — ReviewPassDeps shape', () => {
  it('(7) returns exactly 3 reviewers with correct sources', () => {
    const orchestrator = buildReviewOrchestrator({
      reviewStrategy: 'block-and-revise',
      db,
      llm,
      reviewAgent,
    })!;

    const deps = orchestrator(makeAssignment());

    assert.equal(deps.reviewers.length, 3, 'exactly 3 reviewers');
    assert.equal(deps.reviewers[0].source, SOURCE.CODE_REVIEW, 'first reviewer: code-review-agent');
    assert.equal(deps.reviewers[1].source, SOURCE.ADVERSARIAL, 'second reviewer: adversarial-review');
    assert.equal(deps.reviewers[2].source, SOURCE.EDGE_CASE, 'third reviewer: edge-case-hunter');
  });

  it('(7) audit.record writes to the db via AuditLog', () => {
    const orchestrator = buildReviewOrchestrator({
      reviewStrategy: 'block-and-revise',
      db,
      llm,
      reviewAgent,
    })!;

    const deps = orchestrator(makeAssignment());
    assert.ok(deps.audit, 'audit sink must be present');
    deps.audit!.record('review.test.action', { storyId: STORY.id });

    const row = db
      .prepare("SELECT * FROM audit_log WHERE action = ?")
      .get('review.test.action') as { action: string } | undefined;
    assert.ok(row, 'AuditLog row must be persisted');
    assert.equal(row!.action, 'review.test.action');
  });

  it('(7) warn is a callable function', () => {
    const orchestrator = buildReviewOrchestrator({
      reviewStrategy: 'block-and-revise',
      db,
      llm,
      reviewAgent,
    })!;

    const deps = orchestrator(makeAssignment());
    assert.equal(typeof deps.warn, 'function', 'warn logger must be a function');
    assert.doesNotThrow(() => deps.warn!('test warning', { detail: 1 }));
  });
});

// ─── WIRING (FR-6) ───────────────────────────────────────────────────────────

describe('createWorker — wiring of reviewOrchestrator hook', () => {
  it('(8) sets reviewOrchestrator when block-and-revise + all deps present', () => {
    const worker = createWorker({
      backend: 'claude-code',
      allowedRemotes: [],
      reviewStrategy: 'block-and-revise',
      db,
      llm,
      reviewAgent,
    });
    assert.equal(typeof (worker as any).reviewOrchestrator, 'function');
  });

  it('(8) reviewOrchestrator is undefined under comment strategy', () => {
    const worker = createWorker({
      backend: 'claude-code',
      allowedRemotes: [],
      reviewStrategy: 'comment',
      db,
      llm,
      reviewAgent,
    });
    assert.equal((worker as any).reviewOrchestrator, undefined);
  });

  it('(8) reviewOrchestrator is undefined under off strategy', () => {
    const worker = createWorker({
      backend: 'claude-code',
      allowedRemotes: [],
      reviewStrategy: 'off',
      db,
      llm,
      reviewAgent,
    });
    assert.equal((worker as any).reviewOrchestrator, undefined);
  });

  it('(8) reviewOrchestrator is undefined when db is missing (block-and-revise)', () => {
    const worker = createWorker({
      backend: 'claude-code',
      allowedRemotes: [],
      reviewStrategy: 'block-and-revise',
      db: undefined,
      llm,
      reviewAgent,
    });
    assert.equal((worker as any).reviewOrchestrator, undefined);
  });

  it('(8) reviewOrchestrator is undefined when llm is missing (block-and-revise)', () => {
    const worker = createWorker({
      backend: 'claude-code',
      allowedRemotes: [],
      reviewStrategy: 'block-and-revise',
      db,
      llm: undefined,
      reviewAgent,
    });
    assert.equal((worker as any).reviewOrchestrator, undefined);
  });

  it('(8) reviewOrchestrator is undefined when reviewAgent is missing (block-and-revise)', () => {
    const worker = createWorker({
      backend: 'claude-code',
      allowedRemotes: [],
      reviewStrategy: 'block-and-revise',
      db,
      llm,
      reviewAgent: undefined,
    });
    assert.equal((worker as any).reviewOrchestrator, undefined);
  });

  it('(8) cursor-cli backend also receives reviewOrchestrator when all deps present', () => {
    const worker = createWorker({
      backend: 'cursor-cli',
      allowedRemotes: [],
      reviewStrategy: 'block-and-revise',
      db,
      llm,
      reviewAgent,
    });
    assert.equal(typeof (worker as any).reviewOrchestrator, 'function');
  });
});

// ─── FALLBACK (FR-7) — gate centralized in one place ────────────────────────

describe('legacy fallback — gate lives in buildReviewOrchestrator only', () => {
  it('(9) worker constructed with comment strategy has no reviewOrchestrator — legacy path guaranteed', () => {
    // The availability check is in buildReviewOrchestrator exclusively.
    // When it returns undefined, BaseCliWorker falls through to the legacy
    // single-CodeReviewAgent pass (or skips entirely) without any duplicated
    // guard at the call site.
    const worker = createWorker({
      backend: 'claude-code',
      allowedRemotes: [],
      reviewStrategy: 'comment',
      reviewAgent,
      db,
      llm,
    });
    assert.equal((worker as any).reviewOrchestrator, undefined);
  });

  it('(9) worker constructed with off strategy has no reviewOrchestrator', () => {
    const worker = createWorker({
      backend: 'claude-code',
      allowedRemotes: [],
      reviewStrategy: 'off',
      reviewAgent,
      db,
      llm,
    });
    assert.equal((worker as any).reviewOrchestrator, undefined);
  });

  it('(9) missing any single dep leaves reviewOrchestrator undefined — no partial wiring', () => {
    const withoutDb = createWorker({
      backend: 'claude-code',
      allowedRemotes: [],
      reviewStrategy: 'block-and-revise',
      reviewAgent,
      llm,
    });
    const withoutLlm = createWorker({
      backend: 'claude-code',
      allowedRemotes: [],
      reviewStrategy: 'block-and-revise',
      reviewAgent,
      db,
    });
    const withoutAgent = createWorker({
      backend: 'claude-code',
      allowedRemotes: [],
      reviewStrategy: 'block-and-revise',
      db,
      llm,
    });
    assert.equal((withoutDb as any).reviewOrchestrator, undefined);
    assert.equal((withoutLlm as any).reviewOrchestrator, undefined);
    assert.equal((withoutAgent as any).reviewOrchestrator, undefined);
  });
});
