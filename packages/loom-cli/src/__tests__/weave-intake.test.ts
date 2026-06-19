/**
 * End-to-end tests for intake classification wired into loom weave.
 *
 * AC coverage:
 *   - loom weave invokes the classifier before the epic planner runs.
 *   - Verdict is persisted to: database column, audit log, and status surface.
 *   - A classifier failure does not block or abort weave.
 *   - The observe-only diff: planning output is byte-identical with/without verdict.
 */
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import {
  MockLLMClient,
  resetDatabaseForTest,
  EpicStore,
  AuditLog,
  INTAKE_AUDIT_ACTION,
} from '@loom-ai/core';
import type { LLMRequest, ClassifyResult, IntakeVerdict } from '@loom-ai/core';
import { runWeave } from '../commands/weave.js';

const LOOM_CLI = path.resolve(__dirname, '../index.js');

// ── Helpers ────────────────────────────────────────────────────────────────────

function jsonBlock(obj: unknown): string {
  return '```json\n' + JSON.stringify(obj) + '\n```';
}

const VALID_VERDICT: IntakeVerdict = {
  type: 'feature',
  size: 'epic',
  confidence: 'high',
  rationale: 'Clear feature request with bounded scope.',
};

/** Responds to the planning pipeline AND the classifier (if the real LLM is used). */
function pipelineResponder(req: LLMRequest): string {
  const last = req.messages[req.messages.length - 1].content;
  // Classifier call: system prompt mentions "software-brief classifier"
  if (req.system.some((b) => b.text.includes('software-brief classifier'))) {
    return JSON.stringify(VALID_VERDICT);
  }
  if (last.includes('Apply the discipline above')) {
    return jsonBlock({
      ready: true,
      quality_score: 9,
      refined_brief: '# Brief\n\n## Goal\nVerify intake classification.',
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
  if (last.includes('Produce the project brief')) return '# Brief\n\n## The Problem\nA gap.';
  if (last.includes('Headless task A: produce the PRD')) return '# PRD\n\n## Goals\nShip it.';
  if (last.includes('Headless task B: produce the epic')) {
    const m = last.match(/starting at "(epic-\d+)"/);
    const eid = m ? m[1] : 'epic-001';
    const num = eid.slice(5);
    return jsonBlock({
      epics: [
        {
          epic_id: eid,
          title: 'Intake classification epic',
          priority: 'must-have',
          prd_ref: 'x',
          requirements: ['FR-1'],
          stories: [
            {
              id: `story-${num}-001`,
              title: 'Verify intake wiring',
              description: 'check it',
              acceptance_criteria: ['verdict present'],
              estimated_complexity: 'small',
              dependencies: [],
            },
          ],
        },
      ],
    });
  }
  if (last.includes('Headless task A: produce the architecture'))
    return '# Architecture\n\n## Architecture Philosophy\nBoring tech.';
  if (last.includes('Headless task B: produce per-story')) return '```json\n{"tech_notes":{}}\n```';
  throw new Error('unexpected message: ' + last.slice(0, 80));
}

async function runWeaveCapture(
  brief: string,
  opts: {
    force?: boolean;
    llm: MockLLMClient;
    _classifyIntake?: (brief: string, o: { llm: MockLLMClient; model: string; timeoutMs?: number }) => Promise<ClassifyResult>;
  }
): Promise<number | null> {
  const origExit = process.exit;
  const origLog = console.log;
  const origErr = console.error;
  let exitCode: number | null = null;
  class ExitSignal extends Error {}
  (process as unknown as { exit: (c?: number) => never }).exit = (c?: number) => {
    exitCode = c ?? 0;
    throw new ExitSignal();
  };
  console.log = () => {};
  console.error = () => {};
  try {
    await runWeave(brief, opts as Parameters<typeof runWeave>[1]);
  } catch (err) {
    if (!(err instanceof ExitSignal)) throw err;
  } finally {
    process.exit = origExit;
    console.log = origLog;
    console.error = origErr;
  }
  return exitCode;
}

// ── Fixtures ──────────────────────────────────────────────────────────────────

let tmpDir: string;
let prevCwd: string;
let prevLoomHome: string | undefined;
let loomHomeDir: string;

const BRIEF = 'Build a feature to verify that intake classification is wired into loom weave end to end.';

beforeEach(() => {
  resetDatabaseForTest();
  prevLoomHome = process.env.LOOM_HOME;
  loomHomeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'loom-cli-home-'));
  process.env.LOOM_HOME = loomHomeDir;

  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'loom-intake-'));
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
  resetDatabaseForTest();
});

afterEach(() => {
  process.chdir(prevCwd);
  resetDatabaseForTest();
  fs.rmSync(tmpDir, { recursive: true, force: true });
  fs.rmSync(loomHomeDir, { recursive: true, force: true });
  if (prevLoomHome === undefined) delete process.env.LOOM_HOME;
  else process.env.LOOM_HOME = prevLoomHome;
});

// ── AC: classifier fires before planner, verdict persisted to all three sinks ─

describe('loom weave intake classification — end-to-end', () => {
  it('runs the classifier before the planner and persists verdict to DB, audit log, and status surface', async () => {
    const llm = new MockLLMClient(pipelineResponder);
    const exitCode = await runWeaveCapture(BRIEF, { llm, force: true });

    assert.equal(exitCode, null, 'weave must exit cleanly when classifier succeeds');

    // Open a fresh DB connection — no module singleton interference.
    resetDatabaseForTest();
    const db = new Database(path.join(tmpDir, '.loom', 'loom.db'), { readonly: true });
    try {
      const store = new EpicStore(db);
      const auditLog = new AuditLog(db);

      // Sink 1: database column (intake_verdict on the epic row).
      const dbVerdict = store.getIntakeVerdict('epic-001');
      assert.ok(dbVerdict !== null, 'DB sink: intake_verdict must be non-null');
      assert.equal(dbVerdict!.type, VALID_VERDICT.type, 'DB verdict type must match');
      assert.equal(dbVerdict!.size, VALID_VERDICT.size, 'DB verdict size must match');
      assert.equal(dbVerdict!.confidence, VALID_VERDICT.confidence, 'DB verdict confidence must match');

      // Sink 2: audit log (intake_classified action).
      const rows = auditLog.recent(20);
      const intakeRow = rows.find((r) => r.action === INTAKE_AUDIT_ACTION);
      assert.ok(intakeRow, `Audit sink: must have a "${INTAKE_AUDIT_ACTION}" row`);
      const detail = JSON.parse(intakeRow!.detail ?? '{}') as Record<string, unknown>;
      assert.equal(detail.epicId, 'epic-001', 'Audit detail must carry epicId');
      assert.equal(detail.ok, true, 'Audit detail must indicate success');
      assert.ok(detail.verdict, 'Audit detail must carry the verdict object');

      // Sink 3: status surface — reads the same DB column; verify it is readable.
      const verdicts = store.getIntakeVerdicts(['epic-001']);
      const statusVerdict = verdicts.get('epic-001');
      assert.ok(statusVerdict !== null && statusVerdict !== undefined,
        'Status sink: getIntakeVerdicts must return a non-null verdict for epic-001');
      assert.equal(statusVerdict!.type, VALID_VERDICT.type, 'Status verdict must match the stored value');
    } finally {
      db.close();
    }
  });

  it('classifier is invoked before the planner (MockLLMClient records call order)', async () => {
    const llm = new MockLLMClient(pipelineResponder);
    await runWeaveCapture(BRIEF, { llm, force: true });

    // The classifier call has the "software-brief classifier" system block.
    const classifierCallIdx = llm.requests.findIndex(
      (r) => r.system.some((b) => b.text.includes('software-brief classifier'))
    );
    // The planner calls mention "Headless task" or the brief refiner prompt.
    const plannerCallIdx = llm.requests.findIndex(
      (r) => r.messages.some((m) => m.content.includes('Headless task'))
    );

    assert.ok(classifierCallIdx >= 0, 'classifier must have been called');
    assert.ok(plannerCallIdx >= 0, 'planner must have been called');
    assert.ok(
      classifierCallIdx < plannerCallIdx,
      `classifier call (idx ${classifierCallIdx}) must precede planner call (idx ${plannerCallIdx})`
    );
  });
});

// ── AC: classifier failure does not block or abort weave ──────────────────────

type ClassifyFailure = Extract<ClassifyResult, { ok: false }>;

describe('loom weave intake classification — classifier failure is non-blocking', () => {
  const FAILURE_SCENARIOS: Array<{ label: string; result: ClassifyFailure }> = [
    { label: 'llm_error', result: { ok: false, reason: 'llm_error', detail: 'simulated LLM error' } },
    { label: 'timeout', result: { ok: false, reason: 'timeout', detail: 'simulated timeout' } },
    { label: 'invalid_output', result: { ok: false, reason: 'invalid_output', detail: 'bad JSON' } },
  ];

  for (const { label, result } of FAILURE_SCENARIOS) {
    it(`classifier ${label} does not abort weave — epic is still planned`, async () => {
      const llm = new MockLLMClient(pipelineResponder);
      const exitCode = await runWeaveCapture(BRIEF, {
        llm,
        force: true,
        _classifyIntake: async () => result,
      });

      assert.equal(exitCode, null, `weave must exit cleanly when classifier returns ${label}`);

      resetDatabaseForTest();
      const db = new Database(path.join(tmpDir, '.loom', 'loom.db'), { readonly: true });
      try {
        const store = new EpicStore(db);
        const auditLog = new AuditLog(db);

        // Epic must still be planned.
        const epic = store.get('epic-001');
        assert.equal(epic?.status, 'planned', `epic must be planned despite ${label} classifier failure`);

        // DB verdict must be null (no verdict stored on failure).
        const dbVerdict = store.getIntakeVerdict('epic-001');
        assert.equal(dbVerdict, null, `DB verdict must be null on classifier ${label}`);

        // Audit log must still have an intake_classified row recording the failure.
        const rows = auditLog.recent(20);
        const intakeRow = rows.find((r) => r.action === INTAKE_AUDIT_ACTION);
        assert.ok(intakeRow, `Audit log must record ${label} failure as "${INTAKE_AUDIT_ACTION}"`);
        const detail = JSON.parse(intakeRow!.detail ?? '{}') as Record<string, unknown>;
        assert.equal(detail.ok, false, 'Audit detail must indicate failure');
        assert.equal(detail.reason, result.reason, 'Audit detail must carry the failure reason');
      } finally {
        db.close();
      }
    });
  }
});

// ── AC: observe-only diff — planning output identical with/without verdict ────

describe('loom weave intake — planning output unchanged by classifier result', () => {
  it('epic artifact is byte-identical whether verdict is present or absent', async () => {
    // Helper: run weave and return the planned epic's YAML artifact.
    async function runAndReadYaml(
      classifyResult: ClassifyResult
    ): Promise<{ title: string; status: string; yamlContent: string }> {
      resetDatabaseForTest();
      // Wipe the DB so each run starts at epic-001.
      for (const ext of ['', '-wal', '-shm']) {
        fs.rmSync(path.join(tmpDir, '.loom', `loom.db${ext}`), { force: true });
      }

      const llm = new MockLLMClient(pipelineResponder);
      const exitCode = await runWeaveCapture(BRIEF, {
        llm,
        force: true,
        _classifyIntake: async () => classifyResult,
      });
      assert.equal(exitCode, null, 'weave must exit cleanly');

      resetDatabaseForTest();
      const db = new Database(path.join(tmpDir, '.loom', 'loom.db'), { readonly: true });
      try {
        const epic = new EpicStore(db).get('epic-001');
        assert.ok(epic, 'epic-001 must exist');
        const yamlPath = epic!.yaml_path ? path.join(tmpDir, epic!.yaml_path) : null;
        const yamlContent = yamlPath && fs.existsSync(yamlPath) ? fs.readFileSync(yamlPath, 'utf8') : '';
        return { title: epic!.title, status: epic!.status, yamlContent };
      } finally {
        db.close();
      }
    }

    // Baseline: no verdict (classifier failure).
    const baseline = await runAndReadYaml({ ok: false, reason: 'llm_error', detail: 'baseline' });
    assert.equal(baseline.status, 'planned', 'baseline must be planned');

    // With verdict: planning output must be identical.
    const withVerdict = await runAndReadYaml({
      ok: true,
      verdict: { type: 'feature', size: 'story', confidence: 'high', rationale: 'diff test' },
    });

    assert.equal(withVerdict.title, baseline.title, 'epic title must be identical with and without verdict');
    assert.equal(withVerdict.status, baseline.status, 'epic status must be identical');
    assert.equal(withVerdict.yamlContent, baseline.yamlContent, 'YAML artifact must be byte-identical with and without verdict');
  });
});
