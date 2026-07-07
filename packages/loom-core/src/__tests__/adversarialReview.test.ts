/**
 * Tests for story-082-004: adversarial review mode in CodeReviewAgent with
 * audit_log integration.
 *
 * Covers:
 *   - ADVERSARIAL_SYSTEM_PROMPT content (FR-8)
 *   - Model-selection path (FR-13 scenario f) — the critical invariant
 *   - audit_log wiring (FR-9)
 *
 * loom doctor severity mapping (FR-10) is covered in
 * packages/loom-cli/src/__tests__/adversarialDoctorCheck.test.ts.
 */
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import yaml from 'js-yaml';
import {
  openDatabase,
  resetDatabaseForTest,
  EpicFinalizer,
  EpicStore,
  AgentStore,
  AuditLog,
  IntegrationGate,
  MockLLMClient,
} from '../index.js';
import { ADVERSARIAL_SYSTEM_PROMPT } from '../review/adversarialSystemPrompt.js';
import type { AuditLog as AuditLogType } from '../state/AuditLog.js';
import type { Story } from '../types.js';

// ── ADVERSARIAL_SYSTEM_PROMPT content (FR-8) ─────────────────────────────────

describe('ADVERSARIAL_SYSTEM_PROMPT content (FR-8)', () => {
  it('exports a non-empty string constant', () => {
    assert.strictEqual(typeof ADVERSARIAL_SYSTEM_PROMPT, 'string');
    assert.ok(ADVERSARIAL_SYSTEM_PROMPT.length > 0);
  });

  it('contains "self-serving"', () => {
    assert.ok(
      ADVERSARIAL_SYSTEM_PROMPT.includes('self-serving'),
      'prompt must mention self-serving tests'
    );
  });

  it('contains "shell invocations"', () => {
    assert.ok(
      ADVERSARIAL_SYSTEM_PROMPT.includes('shell invocations'),
      'prompt must mention hunting shell invocations'
    );
  });

  it('contains "config propagation"', () => {
    assert.ok(
      ADVERSARIAL_SYSTEM_PROMPT.includes('config propagation'),
      'prompt must mention config propagation bugs'
    );
  });

  it('contains "green tests" or equivalent phrasing', () => {
    const lower = ADVERSARIAL_SYSTEM_PROMPT.toLowerCase();
    assert.ok(
      lower.includes('green tests') || lower.includes('green ci') || lower.includes('green test'),
      'prompt must reference green tests as insufficient evidence'
    );
  });
});

// ── Shared test setup ────────────────────────────────────────────────────────

function makeSetup() {
  let tmpDir: string;
  let loomDir: string;
  let db: ReturnType<typeof openDatabase>;

  return {
    before() {
      resetDatabaseForTest();
      tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'loom-adv-'));
      loomDir = path.join(tmpDir, '.loom');
      fs.mkdirSync(loomDir, { recursive: true });
      db = openDatabase(loomDir);
    },
    after() {
      resetDatabaseForTest();
      fs.rmSync(tmpDir, { recursive: true, force: true });
    },
    get tmpDir() { return tmpDir; },
    get loomDir() { return loomDir; },
    get db() { return db; },
  };
}

type RunAdvFn = (opts: {
  epicId: string;
  model: string;
  diff: string;
  audit: AuditLogType;
}) => Promise<unknown>;

// ── Model-selection path (FR-13 scenario f) ───────────────────────────────────

describe('EpicFinalizer.runAdversarialReview — model selection (FR-13 scenario f)', () => {
  const s = makeSetup();
  beforeEach(() => s.before());
  afterEach(() => s.after());

  it('uses adversarial_review_model, NOT agents.model', async () => {
    const mockResponse = '```json\n{"findings":[],"summary":"clean"}\n```';
    const mockLlm = new MockLLMClient([mockResponse]);
    const audit = new AuditLog(s.db);

    const finalizer = new EpicFinalizer({
      projectRoot: s.tmpDir,
      db: s.db,
      allowedRemotes: [],
      prStrategy: 'per-epic',
      llmClient: mockLlm,
      llmModel: 'claude-sonnet-4-6',           // agents.model — must NOT be used
      adversarialReviewModel: 'claude-opus-4-8', // adversarial_review_model — MUST be used
    });

    await (finalizer as unknown as { runAdversarialReview: RunAdvFn }).runAdversarialReview({
      epicId: 'epic-test',
      model: 'claude-opus-4-8',
      diff: '+ const x = 1;',
      audit,
    });

    assert.equal(mockLlm.requests.length, 1, 'exactly one LLM request must be made');
    assert.equal(
      mockLlm.requests[0].model,
      'claude-opus-4-8',
      'must use adversarial_review_model, not agents.model'
    );
    assert.notEqual(
      mockLlm.requests[0].model,
      'claude-sonnet-4-6',
      'must NOT use agents.model for the adversarial pass'
    );
  });

  it('passes ADVERSARIAL_SYSTEM_PROMPT as system content, not the skill prompt', async () => {
    const mockResponse = '```json\n{"findings":[],"summary":"clean"}\n```';
    const mockLlm = new MockLLMClient([mockResponse]);
    const audit = new AuditLog(s.db);

    const finalizer = new EpicFinalizer({
      projectRoot: s.tmpDir,
      db: s.db,
      allowedRemotes: [],
      prStrategy: 'per-epic',
      llmClient: mockLlm,
      adversarialReviewModel: 'claude-opus-4-8',
    });

    await (finalizer as unknown as { runAdversarialReview: RunAdvFn }).runAdversarialReview({
      epicId: 'epic-test',
      model: 'claude-opus-4-8',
      diff: '+ const x = 1;',
      audit,
    });

    assert.equal(mockLlm.requests.length, 1);
    const systemText = mockLlm.requests[0].system
      .map((b: { text: string }) => b.text)
      .join('\n');
    assert.ok(
      systemText.includes('self-serving'),
      'system prompt must contain adversarial content ("self-serving")'
    );
    assert.ok(
      systemText.includes('shell invocations'),
      'system prompt must mention shell invocations'
    );
  });

  it('does not invoke the LLM when finalize() has no adversarialReviewModel (per-story early exit)', async () => {
    // per-story prStrategy returns 'skipped' immediately — no gates, no LLM calls.
    const mockLlm = new MockLLMClient((req) => {
      throw new Error(`unexpected LLM call with model ${req.model}`);
    });

    const finalizer = new EpicFinalizer({
      projectRoot: s.tmpDir,
      db: s.db,
      allowedRemotes: [],
      prStrategy: 'per-story',
      llmClient: mockLlm,
      llmModel: 'claude-sonnet-4-6',
      // No adversarialReviewModel
    });

    const result = await finalizer.finalize('epic-test');
    assert.equal(result.status, 'skipped');
    assert.equal(mockLlm.requests.length, 0, 'no LLM calls when adversarialReviewModel absent');
  });
});

// ── audit_log wiring (FR-9) ────────────────────────────────────────────────────

describe('EpicFinalizer.runAdversarialReview — audit_log wiring (FR-9)', () => {
  const s = makeSetup();
  beforeEach(() => s.before());
  afterEach(() => s.after());

  it('writes exactly one adversarial_review row to audit_log', async () => {
    const fakeReport = { findings: [], summary: 'no adversarial findings' };
    const mockLlm = new MockLLMClient([`\`\`\`json\n${JSON.stringify(fakeReport)}\n\`\`\``]);
    const audit = new AuditLog(s.db);

    const finalizer = new EpicFinalizer({
      projectRoot: s.tmpDir,
      db: s.db,
      allowedRemotes: [],
      prStrategy: 'per-epic',
      llmClient: mockLlm,
      adversarialReviewModel: 'claude-opus-4-8',
    });

    await (finalizer as unknown as { runAdversarialReview: RunAdvFn }).runAdversarialReview({
      epicId: 'epic-audit-test',
      model: 'claude-opus-4-8',
      diff: '+ const code = true;',
      audit,
    });

    const rows = audit.recent(10).filter((r) => r.action === 'adversarial_review');
    assert.equal(rows.length, 1, 'must write exactly one adversarial_review row');
  });

  it('audit_log row has action "adversarial_review" and detail.model = adversarial_review_model', async () => {
    const fakeReport = { findings: [], summary: 'clean' };
    const mockLlm = new MockLLMClient([`\`\`\`json\n${JSON.stringify(fakeReport)}\n\`\`\``]);
    const audit = new AuditLog(s.db);

    const finalizer = new EpicFinalizer({
      projectRoot: s.tmpDir,
      db: s.db,
      allowedRemotes: [],
      prStrategy: 'per-epic',
      llmClient: mockLlm,
      adversarialReviewModel: 'claude-opus-4-8',
    });

    await (finalizer as unknown as { runAdversarialReview: RunAdvFn }).runAdversarialReview({
      epicId: 'epic-audit-test',
      model: 'claude-opus-4-8',
      diff: '+ const y = 2;',
      audit,
    });

    const rows = audit.recent(10).filter((r) => r.action === 'adversarial_review');
    assert.equal(rows.length, 1);
    const detail = JSON.parse(rows[0].detail ?? '{}') as { model?: string; findings?: unknown };
    assert.equal(detail.model, 'claude-opus-4-8', 'detail.model must be adversarial_review_model');
  });

  it('audit_log detail.findings contains the structured ReviewReport', async () => {
    const fakeReport = {
      findings: [
        { severity: 'blocker', file: 'src/auth.ts', line: 10, issue: 'missing check' },
      ],
      summary: 'found a blocker',
    };
    const mockLlm = new MockLLMClient([`\`\`\`json\n${JSON.stringify(fakeReport)}\n\`\`\``]);
    const audit = new AuditLog(s.db);

    const finalizer = new EpicFinalizer({
      projectRoot: s.tmpDir,
      db: s.db,
      allowedRemotes: [],
      prStrategy: 'per-epic',
      llmClient: mockLlm,
      adversarialReviewModel: 'claude-opus-4-8',
    });

    await (finalizer as unknown as { runAdversarialReview: RunAdvFn }).runAdversarialReview({
      epicId: 'epic-audit-test',
      model: 'claude-opus-4-8',
      diff: '- removed safety check',
      audit,
    });

    const rows = audit.recent(10).filter((r) => r.action === 'adversarial_review');
    const detail = JSON.parse(rows[0].detail ?? '{}') as {
      findings?: { findings?: Array<{ severity: string }> };
    };
    assert.ok(Array.isArray(detail.findings?.findings), 'detail.findings must be a ReviewReport');
    assert.equal(detail.findings!.findings!.length, 1);
    assert.equal(detail.findings!.findings![0].severity, 'blocker');
  });
});

// ── REAL-SEAM: finalize() actually reaches + runs the adversarial pass ────────
//
// The tests above call the private runAdversarialReview() directly, which cannot
// prove that finalize() itself invokes it (deleting the finalize→adversarial call
// site would leave them green). This drives the REAL finalize() per-epic path to
// completion with a green integration gate and asserts the adversarial LLM was
// invoked under the adversarial model — the seam that would otherwise be
// mock-hidden.

describe('EpicFinalizer.finalize() — real adversarial-review seam', () => {
  let repo: string;
  let prevLoomHome: string | undefined;
  let loomHomeDir: string;

  function gitc(args: string[], cwd = repo): string {
    return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
  }
  function greenGate(): IntegrationGate {
    return new IntegrationGate({
      testCommand: 'noop',
      runner: () => ({ exitCode: 0, output: 'ok', timedOut: false, durationMs: 1 }),
    });
  }
  function storyObj(id: string): Story {
    return {
      id, title: `Story ${id}`, description: 'Do the thing.',
      acceptance_criteria: ['it works'], estimated_complexity: 'small', dependencies: [],
    };
  }
  function seedApprovedEpic(db: ReturnType<typeof openDatabase>, epicId: string, stories: Story[]): void {
    const epicYaml = {
      epic_id: epicId, title: `Epic ${epicId}`, status: 'planned', priority: 'must-have',
      prd_ref: 'x', requirements: ['FR-1'], stories,
    };
    const rel = `.loom/planning/${epicId}/epics/${epicId}.yaml`;
    const abs = path.join(repo, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, yaml.dump(epicYaml));
    const store = new EpicStore(db);
    store.create(epicId, epicYaml.title, rel);
    store.updateStatus(epicId, 'approved');
  }

  beforeEach(() => {
    resetDatabaseForTest();
    prevLoomHome = process.env.LOOM_HOME;
    loomHomeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'loom-adv-home-'));
    process.env.LOOM_HOME = loomHomeDir;
    repo = fs.mkdtempSync(path.join(os.tmpdir(), 'loom-adv-seam-'));
    gitc(['init', '-q']);
    gitc(['config', 'user.email', 'test@loom.dev']);
    gitc(['config', 'user.name', 'Loom Test']);
    gitc(['config', 'commit.gpgsign', 'false']);
    fs.writeFileSync(path.join(repo, 'src.ts'), 'export const x = 1;\n');
    fs.mkdirSync(path.join(repo, '.loom'), { recursive: true });
    gitc(['add', '.']);
    gitc(['commit', '-q', '-m', 'initial']);
  });

  afterEach(() => {
    resetDatabaseForTest();
    fs.rmSync(repo, { recursive: true, force: true });
    fs.rmSync(loomHomeDir, { recursive: true, force: true });
    if (prevLoomHome === undefined) delete process.env.LOOM_HOME;
    else process.env.LOOM_HOME = prevLoomHome;
  });

  it('finalize() invokes the adversarial pass under adversarial_review_model (not agents.model)', async () => {
    const storyId = 'story-001-001';
    const epicId = 'epic-001';
    const db = openDatabase(path.join(repo, '.loom'));
    seedApprovedEpic(db, epicId, [storyObj(storyId)]);
    const epicStore = new EpicStore(db);
    const agentStore = new AgentStore(db);
    epicStore.updateBaseSha(epicId, gitc(['rev-parse', 'HEAD']));

    gitc(['checkout', '-b', `story/${storyId}`]);
    fs.writeFileSync(path.join(repo, 'src.ts'), 'export const x = 2;\n');
    gitc(['add', 'src.ts']);
    gitc(['commit', '-q', '-m', `${storyId}: bump`]);
    gitc(['checkout', '-']);
    const agent = agentStore.create(epicId, storyId, storyId);
    agentStore.updateStatus(agent.id, 'done');

    const mockLlm = new MockLLMClient(['```json\n{"findings":[],"summary":"clean"}\n```']);
    const audit = new AuditLog(db);

    const finalizer = new EpicFinalizer({
      projectRoot: repo,
      db,
      allowedRemotes: [],
      prStrategy: 'per-epic',
      integrationGate: 'warn',           // gates run advisory — never gate the clean epic
      gate: greenGate(),
      llmClient: mockLlm,
      llmModel: 'claude-sonnet-4-6',      // agents.model — must NOT drive the adversarial pass
      adversarialReviewModel: 'claude-opus-4-8',
      pushBranch: () => ({ ok: true, output: 'pushed' }),
      openPr: () => 'https://example.com/pull/1',
    });

    await finalizer.finalize(epicId);

    // The REAL finalize() path must have reached + run the adversarial review.
    assert.ok(mockLlm.requests.length >= 1, 'finalize() must invoke the adversarial LLM pass');
    assert.ok(
      mockLlm.requests.some(r => r.model === 'claude-opus-4-8'),
      'the adversarial pass must run under adversarial_review_model'
    );
    assert.ok(
      !mockLlm.requests.some(r => r.model === 'claude-sonnet-4-6'),
      'the adversarial pass must NOT use agents.model'
    );
    const rows = audit.recent(20).filter(r => r.action === 'adversarial_review' && r.allowed);
    assert.equal(rows.length, 1, 'finalize() must write one adversarial_review audit row');
  });
});
