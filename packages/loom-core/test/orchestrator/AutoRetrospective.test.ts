import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execSync } from 'node:child_process';
import Database from 'better-sqlite3';
import { createDatabase } from '../../src/state/Database.js';
import { AgentStore } from '../../src/state/AgentStore.js';
import { AuditLog } from '../../src/state/AuditLog.js';
import { DecisionTraceStore } from '../../src/state/DecisionTraceStore.js';
import { LessonStore } from '../../src/state/LessonStore.js';
import { MockLLMClient } from '../../src/llm/MockLLMClient.js';
import { LessonExtractor } from '../../src/findings/LessonExtractor.js';
import type { EpicTelemetry } from '../../src/findings/LessonExtractor.js';
import { AutoRetrospective, gatherEpicTelemetry } from '../../src/orchestrator/AutoRetrospective.js';
import { EpicFinalizer } from '../../src/orchestrator/EpicFinalizer.js';

// ── Locate SKILL.md ────────────────────────────────────────────────────────

function findSkillMdPath(): string {
  let dir = __dirname;
  for (let i = 0; i < 12; i++) {
    const candidate = path.join(dir, 'skills', 'lesson-extractor', 'SKILL.md');
    if (fs.existsSync(candidate)) return candidate;
    dir = path.dirname(dir);
  }
  throw new Error('could not locate skills/lesson-extractor/SKILL.md');
}

const SKILL_MD_PATH = findSkillMdPath();
const MODEL = 'claude-test';

// ── Helpers ────────────────────────────────────────────────────────────────

function makeDb(): Database.Database {
  return createDatabase(':memory:');
}

function validLessonResponse(n = 1): string {
  const lessons = Array.from({ length: n }, (_, i) => ({
    category: `test-category-${i}`,
    observation: `Test observation ${i}`,
    general_rule: `Test rule ${i}`,
  }));
  return '```json\n' + JSON.stringify({ lessons }) + '\n```';
}

function makeExtractor(llm: MockLLMClient): LessonExtractor {
  return new LessonExtractor({ llm, model: MODEL, skillMdPath: SKILL_MD_PATH });
}

function makeAutoRetro(
  db: Database.Database,
  llm: MockLLMClient
): AutoRetrospective {
  return new AutoRetrospective({
    extractor: makeExtractor(llm),
    lessonStore: new LessonStore(db),
    audit: new AuditLog(db),
    traces: new DecisionTraceStore(db),
    agents: new AgentStore(db),
  });
}

function seedEpic(db: Database.Database, epicId: string): void {
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO epics (id, title, status, created_at, updated_at)
     VALUES (?, 'Test Epic', 'approved', ?, ?)`
  ).run(epicId, now, now);
}

function seedAgent(
  db: Database.Database,
  epicId: string,
  storyId: string,
  opts: { review_summary?: string; log_tail?: string } = {}
): string {
  const agentId = `agent-${storyId}-abcd0001`;
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO agents (id, epic_id, story_id, story_title, status, review_summary, log_tail, updated_at)
     VALUES (?, ?, ?, 'Test Story', 'done', ?, ?, ?)`
  ).run(agentId, epicId, storyId, opts.review_summary ?? null, opts.log_tail ?? null, now);
  return agentId;
}

function seedAuditRow(db: Database.Database, epicId: string, action: string): void {
  db.prepare(
    `INSERT INTO audit_log (action, command, allowed, timestamp)
     VALUES (?, ?, 1, CURRENT_TIMESTAMP)`
  ).run(action, epicId);
}

function seedDecisionTrace(db: Database.Database, epicId: string, storyId: string): void {
  db.prepare(
    `INSERT INTO decision_traces (epic_id, story_id, kind, rationale, timestamp)
     VALUES (?, ?, 'thinking', 'test rationale', CURRENT_TIMESTAMP)`
  ).run(epicId, storyId);
}

// ── Git repo helpers (for EpicFinalizer integration tests) ─────────────────

interface TestRepo {
  root: string;
  baseSha: string;
  cleanup: () => void;
}

function makeTestRepo(): TestRepo {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'loom-retro-test-'));
  const exec = (cmd: string) =>
    execSync(cmd, { cwd: root, stdio: 'pipe', encoding: 'utf8' });

  exec('git init -b main');
  exec('git config user.email "test@test.com"');
  exec('git config user.name "Test"');
  exec('git config commit.gpgsign false');

  fs.writeFileSync(path.join(root, 'README.md'), 'test');
  exec('git add README.md');
  exec('git commit -m "initial"');
  const baseSha = exec('git rev-parse HEAD').trim();

  return {
    root,
    baseSha,
    cleanup: () => {
      try { fs.rmSync(root, { recursive: true }); } catch { /* best-effort */ }
    },
  };
}

function makeTestRepoWithStoryBranch(storyId: string): TestRepo & { storyBranch: string } {
  const repo = makeTestRepo();
  const exec = (cmd: string) =>
    execSync(cmd, { cwd: repo.root, stdio: 'pipe', encoding: 'utf8' });
  const branch = `story/${storyId}`;
  exec(`git checkout -b ${branch}`);
  fs.writeFileSync(path.join(repo.root, `${storyId}.ts`), 'export {};\n');
  exec(`git add ${storyId}.ts`);
  exec(`git commit -m "story: ${storyId}"`);
  exec('git checkout main');
  return { ...repo, storyBranch: branch };
}

function seedEpicForFinalizer(
  db: Database.Database,
  epicId: string,
  repoRoot: string,
  baseSha: string,
  yamlRelPath: string
): void {
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO epics (id, title, status, yaml_path, base_sha, created_at, updated_at)
     VALUES (?, 'Test Epic', 'approved', ?, ?, ?, ?)`
  ).run(epicId, yamlRelPath, baseSha, now, now);
  void repoRoot;
}

function writeEpicYaml(root: string, epicId: string, storyId: string): string {
  const yamlContent = [
    `epic_id: ${epicId}`,
    'title: Test Epic Title',
    'priority: must-have',
    'prd_ref: prd.md',
    'requirements:',
    '  - test requirement',
    'stories:',
    `  - id: ${storyId}`,
    '    title: Test Story Title',
    '    description: A test story for the epic',
    '    acceptance_criteria:',
    '      - The story works',
    '    estimated_complexity: small',
    '    dependencies: []',
  ].join('\n');
  const yamlPath = path.join(root, 'epic.yaml');
  fs.writeFileSync(yamlPath, yamlContent);
  return 'epic.yaml';
}

// ── Tests: gatherEpicTelemetry ─────────────────────────────────────────────

describe('gatherEpicTelemetry — unit', () => {
  it('gathers from all three sources when data is seeded', async () => {
    const db = makeDb();
    const epicId = 'epic-001';
    const storyId = 'story-001-001';
    seedEpic(db, epicId);
    seedAgent(db, epicId, storyId, { review_summary: 'LGTM', log_tail: 'tests passed' });
    seedDecisionTrace(db, epicId, storyId);
    seedAuditRow(db, epicId, 'epic_dispatch');

    const telemetry = await gatherEpicTelemetry(epicId, 'done', {
      traces: new DecisionTraceStore(db),
      agents: new AgentStore(db),
      audit: new AuditLog(db),
    });

    assert.equal(telemetry.epic_id, epicId);
    assert.equal(telemetry.final_status, 'done');
    assert.equal(telemetry.decision_traces.length, 1, 'decision traces gathered');
    assert.equal(telemetry.agents.length, 1, 'agents gathered');
    assert.equal(telemetry.agents[0].review_summary, 'LGTM');
    assert.equal(telemetry.agents[0].log_tail, 'tests passed');
    assert.equal(telemetry.audit_tail.length, 1, 'audit rows gathered');
    assert.equal(telemetry.audit_tail[0].action, 'epic_dispatch');
  });

  it('returns empty arrays when nothing is seeded', async () => {
    const db = makeDb();
    const telemetry = await gatherEpicTelemetry('epic-empty', 'failed', {
      traces: new DecisionTraceStore(db),
      agents: new AgentStore(db),
      audit: new AuditLog(db),
    });

    assert.equal(telemetry.decision_traces.length, 0);
    assert.equal(telemetry.agents.length, 0);
    assert.equal(telemetry.audit_tail.length, 0);
  });

  it('propagates finalStatus into the telemetry object', async () => {
    const db = makeDb();
    const t1 = await gatherEpicTelemetry('e', 'done', {
      traces: new DecisionTraceStore(db),
      agents: new AgentStore(db),
      audit: new AuditLog(db),
    });
    const t2 = await gatherEpicTelemetry('e', 'failed', {
      traces: new DecisionTraceStore(db),
      agents: new AgentStore(db),
      audit: new AuditLog(db),
    });
    assert.equal(t1.final_status, 'done');
    assert.equal(t2.final_status, 'failed');
  });
});

// ── Tests: AutoRetrospective.run() — happy path ────────────────────────────

describe('AutoRetrospective.run() — happy retro on done', () => {
  it('persists >=1 lesson and calls extractor exactly once on the done path', async () => {
    const db = makeDb();
    const epicId = 'epic-001';
    const storyId = 'story-001-001';
    seedEpic(db, epicId);
    seedAgent(db, epicId, storyId, { review_summary: 'LGTM', log_tail: 'tests passed' });
    seedDecisionTrace(db, epicId, storyId);
    seedAuditRow(db, epicId, 'epic_dispatch');

    const llm = new MockLLMClient([validLessonResponse(2)]);
    const retro = makeAutoRetro(db, llm);

    await retro.run(epicId, 'done');

    assert.equal(llm.requests.length, 1, 'exactly one LLM call');
    const lessons = new LessonStore(db).getByEpic(epicId);
    assert.ok(lessons.length >= 1, `expected >=1 lesson, got ${lessons.length}`);
    assert.equal(lessons[0].epic_id, epicId);
  });

  it('passes done finalStatus through to the extractor telemetry', async () => {
    const db = makeDb();
    const epicId = 'epic-002';
    seedEpic(db, epicId);
    seedAgent(db, epicId, 'story-002-001');

    const llm = new MockLLMClient(['```json\n{"lessons":[]}\n```']);
    const retro = makeAutoRetro(db, llm);
    await retro.run(epicId, 'done');

    const req = llm.requests[0];
    const telemetry = JSON.parse(req.messages[0].content) as EpicTelemetry;
    assert.equal(telemetry.final_status, 'done');
  });
});

describe('AutoRetrospective.run() — happy retro on failed', () => {
  it('persists >=1 lesson and calls extractor exactly once on the failed path', async () => {
    const db = makeDb();
    const epicId = 'epic-003';
    const storyId = 'story-003-001';
    seedEpic(db, epicId);
    seedAgent(db, epicId, storyId, { review_summary: 'blocked', log_tail: 'error in step 3' });
    seedDecisionTrace(db, epicId, storyId);

    const llm = new MockLLMClient([validLessonResponse(1)]);
    const retro = makeAutoRetro(db, llm);

    await retro.run(epicId, 'failed');

    assert.equal(llm.requests.length, 1, 'exactly one LLM call for the failed path');
    const lessons = new LessonStore(db).getByEpic(epicId);
    assert.ok(lessons.length >= 1, `expected >=1 lesson on failed path, got ${lessons.length}`);
  });

  it('passes failed finalStatus through to the extractor telemetry', async () => {
    const db = makeDb();
    const epicId = 'epic-004';
    seedEpic(db, epicId);
    seedAgent(db, epicId, 'story-004-001');

    const llm = new MockLLMClient(['```json\n{"lessons":[]}\n```']);
    const retro = makeAutoRetro(db, llm);
    await retro.run(epicId, 'failed');

    const req = llm.requests[0];
    const telemetry = JSON.parse(req.messages[0].content) as EpicTelemetry;
    assert.equal(telemetry.final_status, 'failed');
  });
});

// ── Tests: exactly one batched LLM call ────────────────────────────────────

describe('AutoRetrospective.run() — exactly one batched call per retro', () => {
  it('calls the extractor exactly once for a non-empty telemetry', async () => {
    const db = makeDb();
    const epicId = 'epic-005';
    seedEpic(db, epicId);
    seedAgent(db, epicId, 'story-005-001');

    const llm = new MockLLMClient([validLessonResponse()]);
    const retro = makeAutoRetro(db, llm);

    await retro.run(epicId, 'done');

    assert.equal(llm.requests.length, 1, 'exactly one batched LLM call');
  });

  it('calls the extractor a second time on malformed output (one repair), but not more', async () => {
    const db = makeDb();
    const epicId = 'epic-006';
    seedEpic(db, epicId);
    seedAgent(db, epicId, 'story-006-001');

    // First response malformed → repair attempt → second valid
    const llm = new MockLLMClient(['not json at all', validLessonResponse()]);
    const retro = makeAutoRetro(db, llm);

    await retro.run(epicId, 'done');

    assert.equal(llm.requests.length, 2, 'exactly two calls: original + one repair');
  });
});

// ── Tests: finalize never blocks ───────────────────────────────────────────

describe('AutoRetrospective.run() — finalize never blocks (LLM unavailable)', () => {
  it('returns cleanly when extractor throws, records auto_retro_skipped', async () => {
    const db = makeDb();
    const epicId = 'epic-007';
    seedEpic(db, epicId);
    seedAgent(db, epicId, 'story-007-001');

    const llm = new MockLLMClient(() => {
      throw new Error('LLM unavailable');
    });
    const retro = makeAutoRetro(db, llm);

    // run() MUST NOT throw
    await assert.doesNotReject(() => retro.run(epicId, 'done'));

    const audit = new AuditLog(db);
    const rows = audit.getByCommand(epicId, ['auto_retro_skipped']);
    assert.equal(rows.length, 1, 'auto_retro_skipped recorded');
    const detail = JSON.parse(rows[0].detail ?? '{}') as { reason?: string };
    assert.ok(detail.reason?.includes('LLM unavailable'), `reason should mention LLM unavailable: ${detail.reason}`);

    const lessons = new LessonStore(db).getByEpic(epicId);
    assert.equal(lessons.length, 0, 'no lessons persisted when LLM is unavailable');
  });
});

describe('AutoRetrospective.run() — finalize never blocks (malformed output exhausts repair)', () => {
  it('returns cleanly when both attempts return malformed output, records auto_retro_skipped', async () => {
    const db = makeDb();
    const epicId = 'epic-008';
    seedEpic(db, epicId);
    seedAgent(db, epicId, 'story-008-001');

    const llm = new MockLLMClient(['bad', 'also bad']);
    const retro = makeAutoRetro(db, llm);

    await assert.doesNotReject(() => retro.run(epicId, 'done'));

    assert.equal(llm.requests.length, 2, 'exactly two attempts before giving up');

    const audit = new AuditLog(db);
    const rows = audit.getByCommand(epicId, ['auto_retro_skipped']);
    assert.equal(rows.length, 1, 'auto_retro_skipped recorded after malformed exhaustion');

    const lessons = new LessonStore(db).getByEpic(epicId);
    assert.equal(lessons.length, 0, 'no lessons on malformed exhaustion');
  });
});

// ── Tests: empty telemetry (FR-5) ──────────────────────────────────────────

describe('AutoRetrospective.run() — empty telemetry (FR-5)', () => {
  it('makes no LLM call and persists zero lessons when all telemetry is empty', async () => {
    const db = makeDb();
    const epicId = 'epic-009';
    // Do not seed any traces, agents, or audit rows
    // (epic row not even needed since gatherEpicTelemetry just queries stores)

    const llm = new MockLLMClient([]);
    const retro = makeAutoRetro(db, llm);

    await assert.doesNotReject(() => retro.run(epicId, 'done'));

    assert.equal(llm.requests.length, 0, 'no LLM call for empty telemetry (FR-5)');
    const lessons = new LessonStore(db).getByEpic(epicId);
    assert.equal(lessons.length, 0, 'zero lessons for empty telemetry');
  });
});

// ── Tests: EpicFinalizer wiring — done path ────────────────────────────────

describe('EpicFinalizer wiring — done path (pushGate=confirm)', () => {
  let repo: ReturnType<typeof makeTestRepoWithStoryBranch>;
  const epicId = 'epic-010';
  const storyId = 'story-010-001';

  before(() => {
    repo = makeTestRepoWithStoryBranch(storyId);
  });

  after(() => {
    repo.cleanup();
  });

  it('persists >=1 lesson and calls extractor once after finalize on the done path', async () => {
    const db = makeDb();
    const yamlRelPath = writeEpicYaml(repo.root, epicId, storyId);
    seedEpicForFinalizer(db, epicId, repo.root, repo.baseSha, yamlRelPath);

    const agentId = seedAgent(db, epicId, storyId, { review_summary: 'LGTM', log_tail: 'ok' });
    seedDecisionTrace(db, epicId, storyId);
    seedAuditRow(db, epicId, 'epic_dispatch');
    void agentId;

    const llm = new MockLLMClient([validLessonResponse(1)]);
    const autoRetro = new AutoRetrospective({
      extractor: makeExtractor(llm),
      lessonStore: new LessonStore(db),
      audit: new AuditLog(db),
      traces: new DecisionTraceStore(db),
      agents: new AgentStore(db),
    });

    const finalizer = new EpicFinalizer({
      projectRoot: repo.root,
      db,
      allowedRemotes: ['*'],
      prStrategy: 'per-epic',
      pushGate: 'confirm',
      autoRetro,
    });

    const result = await finalizer.finalize(epicId);

    assert.ok(
      result.status === 'merged' || result.status === 'partial',
      `expected merged/partial, got ${result.status}`
    );
    assert.equal(llm.requests.length, 1, 'exactly one LLM call');
    const lessons = new LessonStore(db).getByEpic(epicId);
    assert.ok(lessons.length >= 1, `expected >=1 lesson, got ${lessons.length}`);
  });
});

// ── Tests: EpicFinalizer wiring — failed path ──────────────────────────────

describe('EpicFinalizer wiring — failed path (missing story branch)', () => {
  let repo: TestRepo;
  const epicId = 'epic-011';
  const storyId = 'story-011-001';

  before(() => {
    // Create repo but deliberately DO NOT create the story branch —
    // the merge will fail, driving the merged.length===0 failed path.
    repo = makeTestRepo();
  });

  after(() => {
    repo.cleanup();
  });

  it('calls retro with failed status and persists lessons when finalize enters the failed path', async () => {
    const db = makeDb();
    const yamlRelPath = writeEpicYaml(repo.root, epicId, storyId);
    seedEpicForFinalizer(db, epicId, repo.root, repo.baseSha, yamlRelPath);
    // Agent is 'done' in DB but story branch doesn't exist → merge fails
    seedAgent(db, epicId, storyId);

    const llm = new MockLLMClient([validLessonResponse(1)]);
    const autoRetro = new AutoRetrospective({
      extractor: makeExtractor(llm),
      lessonStore: new LessonStore(db),
      audit: new AuditLog(db),
      traces: new DecisionTraceStore(db),
      agents: new AgentStore(db),
    });

    const finalizer = new EpicFinalizer({
      projectRoot: repo.root,
      db,
      allowedRemotes: [],
      prStrategy: 'per-epic',
      autoRetro,
    });

    const result = await finalizer.finalize(epicId);

    assert.equal(result.status, 'failed', 'finalize returns failed when no story merges');
    assert.equal(llm.requests.length, 1, 'retro called once on failed path');
    const lessons = new LessonStore(db).getByEpic(epicId);
    assert.ok(lessons.length >= 1, `expected >=1 lesson on failed path, got ${lessons.length}`);
  });
});

// ── Tests: ordering and finalize-never-blocks (EpicFinalizer) ─────────────

describe('EpicFinalizer wiring — ordering: epic_finalize written before retro', () => {
  let repo: ReturnType<typeof makeTestRepoWithStoryBranch>;
  const epicId = 'epic-012';
  const storyId = 'story-012-001';

  before(() => {
    repo = makeTestRepoWithStoryBranch(storyId);
  });

  after(() => {
    repo.cleanup();
  });

  it('epic_finalize audit row exists in DB when the retro runs (verified via spy)', async () => {
    const db = makeDb();
    const yamlRelPath = writeEpicYaml(repo.root, epicId, storyId);
    seedEpicForFinalizer(db, epicId, repo.root, repo.baseSha, yamlRelPath);
    seedAgent(db, epicId, storyId);

    let epicFinalizeExistedAtRetroTime = false;

    // Spy retro: checks audit log state at run() invocation time.
    const spyRetro: AutoRetrospective = {
      run: async (eid: string): Promise<void> => {
        const audit = new AuditLog(db);
        const rows = audit.getByCommand(eid, ['epic_finalize']);
        epicFinalizeExistedAtRetroTime = rows.length > 0;
      },
    } as unknown as AutoRetrospective;

    const finalizer = new EpicFinalizer({
      projectRoot: repo.root,
      db,
      allowedRemotes: ['*'],
      prStrategy: 'per-epic',
      pushGate: 'confirm',
      autoRetro: spyRetro,
    });

    await finalizer.finalize(epicId);

    assert.equal(
      epicFinalizeExistedAtRetroTime,
      true,
      'epic_finalize audit row must exist before the retro runs (ADR-001)'
    );
  });
});

describe('EpicFinalizer wiring — finalize never blocks when retro throws', () => {
  let repo: ReturnType<typeof makeTestRepoWithStoryBranch>;
  const epicId = 'epic-013';
  const storyId = 'story-013-001';

  before(() => {
    repo = makeTestRepoWithStoryBranch(storyId);
  });

  after(() => {
    repo.cleanup();
  });

  it('finalize() returns success and records auto_retro_skipped when extractor throws', async () => {
    const db = makeDb();
    const yamlRelPath = writeEpicYaml(repo.root, epicId, storyId);
    seedEpicForFinalizer(db, epicId, repo.root, repo.baseSha, yamlRelPath);
    seedAgent(db, epicId, storyId);

    const llm = new MockLLMClient(() => {
      throw new Error('LLM service unavailable');
    });
    const autoRetro = new AutoRetrospective({
      extractor: makeExtractor(llm),
      lessonStore: new LessonStore(db),
      audit: new AuditLog(db),
      traces: new DecisionTraceStore(db),
      agents: new AgentStore(db),
    });

    const finalizer = new EpicFinalizer({
      projectRoot: repo.root,
      db,
      allowedRemotes: ['*'],
      prStrategy: 'per-epic',
      pushGate: 'confirm',
      autoRetro,
    });

    // finalize() must return (not throw) even when the retro fails
    let result: Awaited<ReturnType<EpicFinalizer['finalize']>> | undefined;
    await assert.doesNotReject(async () => {
      result = await finalizer.finalize(epicId);
    });

    assert.ok(result, 'finalize() returned a result');
    assert.ok(
      result!.status === 'merged' || result!.status === 'partial',
      `finalize should succeed; got ${result!.status}`
    );

    const audit = new AuditLog(db);
    const epicFinalizeRows = audit.getByCommand(epicId, ['epic_finalize']);
    assert.ok(epicFinalizeRows.length >= 1, 'epic_finalize was recorded despite retro failure');

    const skipRows = audit.getByCommand(epicId, ['auto_retro_skipped']);
    assert.equal(skipRows.length, 1, 'auto_retro_skipped recorded exactly once');

    const lessons = new LessonStore(db).getByEpic(epicId);
    assert.equal(lessons.length, 0, 'no lessons persisted when LLM is unavailable');
  });
});
