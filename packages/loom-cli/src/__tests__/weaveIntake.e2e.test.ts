/**
 * Singleton-robust e2e test (story-023-003).
 *
 * Verifies that a real loom weave invocation (via runEpic) calls the classifier
 * before planning and persists the verdict. All assertions use the same
 * database handle the write used (`openDatabase` singleton) — never a fresh
 * read-only connection — so there is no visibility skew between writer and
 * reader (ADR-003).
 */
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  MockLLMClient,
  resetDatabaseForTest,
  EpicStore,
  AuditLog,
  openDatabase,
  INTAKE_AUDIT_ACTION,
} from '@loom-ai/core';
import type { LLMRequest } from '@loom-ai/core';
import { runEpic } from '../commands/epic.js';
import { runInProcess, jsonBlock } from './testUtils.js';

const LOOM_CLI = path.resolve(__dirname, '../index.js');

/**
 * Handles both the planning pipeline AND the intake classifier call.
 * The classifier sends an assistant prefill '{' as the last message — that is
 * the key distinguishing it from planning messages.
 */
function fullPipelineResponder(req: LLMRequest): string {
  const last = req.messages[req.messages.length - 1];

  // Intake classifier: assistant prefill '{' is the last message.
  if (last.role === 'assistant' && last.content === '{') {
    return '"type":"feature","size":"story","confidence":"high","rationale":"E2E test classification"}';
  }

  const content = last.content as string;
  if (content.includes('Apply the discipline above')) {
    return jsonBlock({
      ready: true,
      quality_score: 9,
      refined_brief: '# Brief\n\n## Goal\nVerify e2e intake wiring.',
      critique: {
        strong_points: ['clear'],
        ambiguities: [],
        missing_scope: [],
        untestable_claims: [],
        hidden_complexity: [],
      },
      questions: [],
      delta: { added_sections: [], clarifications: [], flagged_assumptions: [] },
    });
  }
  if (content.includes('Produce the project brief')) return '# Brief\n\n## The Problem\nA gap.';
  if (content.includes('Headless task A: produce the PRD')) return '# PRD\n\n## Goals\nShip it.';
  if (content.includes('Headless task B: produce the epic')) {
    const m = content.match(/starting at "(epic-\d+)"/);
    const eid = m ? m[1] : 'epic-001';
    const num = eid.slice(5);
    return jsonBlock({
      epics: [
        {
          epic_id: eid,
          title: 'E2E intake test epic',
          priority: 'must-have',
          prd_ref: 'x',
          requirements: ['FR-1'],
          stories: [
            {
              id: `story-${num}-001`,
              title: 'The single story',
              description: 'do it',
              acceptance_criteria: ['works'],
              estimated_complexity: 'small',
              dependencies: [],
            },
          ],
        },
      ],
    });
  }
  if (content.includes('Headless task A: produce the architecture'))
    return '# Architecture\n\n## Architecture Philosophy\nBoring tech.';
  if (content.includes('Headless task B: produce per-story')) return '```json\n{"tech_notes":{}}\n```';
  throw new Error('unexpected planning message: ' + content.slice(0, 60));
}

// ── Fixtures ──────────────────────────────────────────────────────────────────

let tmpDir: string;
let prevCwd: string;
let prevLoomHome: string | undefined;
let loomHomeDir: string;

const BRIEF = 'Build a minimal feature to verify the end-to-end intake wiring delivers a persisted verdict.';

beforeEach(() => {
  prevLoomHome = process.env.LOOM_HOME;
  loomHomeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'loom-cli-home-'));
  process.env.LOOM_HOME = loomHomeDir;

  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'loom-weave-intake-e2e-'));
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: tmpDir });
  execFileSync('git', ['config', 'user.email', 'test@loom.dev'], { cwd: tmpDir });
  execFileSync('git', ['config', 'user.name', 'Loom Test'], { cwd: tmpDir });
  execFileSync('git', ['config', 'commit.gpgsign', 'false'], { cwd: tmpDir });
  fs.writeFileSync(path.join(tmpDir, 'README.md'), '# test\n');
  execFileSync('git', ['add', '.'], { cwd: tmpDir });
  execFileSync('git', ['commit', '-q', '-m', 'initial'], { cwd: tmpDir });
  execFileSync('node', [LOOM_CLI, 'init'], { cwd: tmpDir, stdio: 'ignore' });

  prevCwd = process.cwd();
  process.chdir(tmpDir);
  // Discipline: resetDatabaseForTest() before each test so openDatabase()
  // creates a fresh singleton handle tied to this test's tmpDir (ADR-003).
  resetDatabaseForTest();
});

afterEach(() => {
  process.chdir(prevCwd);
  // Discipline: resetDatabaseForTest() after each test so the singleton is
  // released before the tmpDir is removed.
  resetDatabaseForTest();
  fs.rmSync(tmpDir, { recursive: true, force: true });
  fs.rmSync(loomHomeDir, { recursive: true, force: true });
  if (prevLoomHome === undefined) delete process.env.LOOM_HOME;
  else process.env.LOOM_HOME = prevLoomHome;
});

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('weave intake e2e — verdict persisted through the real runEpic path', () => {
  it('happy path: runEpic persists a non-null intake verdict to the database', async () => {
    const llm = new MockLLMClient(fullPipelineResponder);
    const { exitCode } = await runInProcess(() => runEpic(BRIEF, { llm, force: true }));
    assert.ok(exitCode === null || exitCode === 0, 'runEpic must exit cleanly');

    // Read back via the SAME singleton handle the write used (ADR-003).
    // Do NOT call resetDatabaseForTest() before this read — that would
    // release the singleton and the next openDatabase() call would open
    // a fresh connection that risks missing an uncommitted write.
    const db = openDatabase(path.join(tmpDir, '.loom'));
    const store = new EpicStore(db);
    const verdict = store.getIntakeVerdict('epic-001');

    assert.ok(verdict !== null, 'intake verdict must be persisted (non-null)');
    assert.equal(verdict!.type, 'feature');
    assert.equal(verdict!.size, 'story');
    assert.equal(verdict!.confidence, 'high');
    assert.ok(verdict!.rationale.length > 0, 'rationale must be non-empty');
  });

  it('verdict is also written to the audit log with action=intake_classified', async () => {
    const llm = new MockLLMClient(fullPipelineResponder);
    await runInProcess(() => runEpic(BRIEF, { llm, force: true }));

    const db = openDatabase(path.join(tmpDir, '.loom'));
    const auditLog = new AuditLog(db);
    const rows = auditLog.recent(50).filter((r) => r.action === INTAKE_AUDIT_ACTION);

    assert.equal(rows.length, 1, 'exactly one intake_classified audit row must be written');
    const row = rows[0];
    assert.equal(row.allowed, 1, 'allowed must be 1 on a successful classification');
    assert.equal(row.command, BRIEF.slice(0, 120), 'command must be the brief (truncated to 120 chars)');
    const detail = JSON.parse(row.detail!);
    assert.equal(detail.type, 'feature');
    assert.equal(detail.size, 'story');
  });

  it('epic is planned (verdict does not block the planner)', async () => {
    const llm = new MockLLMClient(fullPipelineResponder);
    const { exitCode } = await runInProcess(() => runEpic(BRIEF, { llm, force: true }));
    assert.ok(exitCode === null || exitCode === 0, 'must exit cleanly');

    const db = openDatabase(path.join(tmpDir, '.loom'));
    const epic = new EpicStore(db).get('epic-001');
    assert.equal(epic?.status, 'planned', 'planner must complete regardless of verdict');
  });

  it('classifier failure does not block planning — epic is planned even when the LLM rejects the classifier call', async () => {
    // A mock that handles planning but throws on classifier (assistant prefill) calls.
    function planningOnlyResponder(req: LLMRequest): string {
      const last = req.messages[req.messages.length - 1];
      if (last.role === 'assistant' && (last.content as string).startsWith('{'))
        throw new Error('classifier call rejected by test');
      return fullPipelineResponder(req);
    }

    const llm = new MockLLMClient(planningOnlyResponder);
    const { exitCode } = await runInProcess(() => runEpic(BRIEF, { llm, force: true }));
    assert.ok(exitCode === null || exitCode === 0, 'must exit cleanly even when classifier fails');

    const db = openDatabase(path.join(tmpDir, '.loom'));
    assert.equal(new EpicStore(db).get('epic-001')?.status, 'planned', 'epic is planned despite classifier failure');

    // Audit log must have an intake_classified row with allowed=false.
    const rows = new AuditLog(db).recent(50).filter((r) => r.action === INTAKE_AUDIT_ACTION);
    assert.equal(rows.length, 1, 'intake_classified audit row must be written even on failure');
    assert.equal(rows[0].allowed, 0, 'allowed must be 0 on classifier failure');
  });

  it('audit log command is truncated at 120 chars for a long brief', async () => {
    // BRIEF is 95 chars; this brief is ≥121 chars to exercise the .slice(0, 120) truncation.
    const LONG_BRIEF =
      'Build a comprehensive feature covering authentication, authorization, auditing, and access-control policies across the entire stack end-to-end.';
    assert.ok(LONG_BRIEF.length > 120, 'test setup: long brief must exceed 120 chars');

    const llm = new MockLLMClient(fullPipelineResponder);
    await runInProcess(() => runEpic(LONG_BRIEF, { llm, force: true }));

    const db = openDatabase(path.join(tmpDir, '.loom'));
    const rows = new AuditLog(db).recent(50).filter((r) => r.action === INTAKE_AUDIT_ACTION);
    assert.equal(rows.length, 1, 'exactly one intake_classified row must be written');
    assert.equal(
      rows[0].command,
      LONG_BRIEF.slice(0, 120),
      'command must be truncated to 120 chars'
    );
    assert.ok(rows[0].command!.length === 120, 'truncated command must be exactly 120 chars');
  });
});
