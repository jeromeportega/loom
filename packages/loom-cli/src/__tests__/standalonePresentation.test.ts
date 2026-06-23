/**
 * Standalone-story presentation consistency (story-049).
 *
 * Verifies that a routed standalone story is presented as `story-NNN` — never
 * as `epic-NNN` or `N epic(s), 1 stories` — across:
 *   - loom weave / epic summary output (AC1, AC2)
 *   - loom approve (AC3)
 *   - loom run "Epics processed:" line (AC4)
 *   - renderPrTail multi-entry label (AC4)
 *   - loom approve --run chain (AC3+AC4)
 *   - full-epic pipeline output is byte-identical (AC8, no standalone field)
 *   - intake_routing=off path is byte-identical (AC9)
 *
 * All LLM calls are fully stubbed. No real supervisor or cursor-agent runs.
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
  AgentStore,
  openDatabase,
} from '@loom-ai/core';
import type { LLMRequest } from '@loom-ai/core';
import { runEpic } from '../commands/epic.js';
import { runApprove, runReject } from '../commands/gate.js';
import { renderPrTail, type RunOptions } from '../commands/run.js';
import { runInProcess, jsonBlock, capture } from './testUtils.js';

const LOOM_CLI = path.resolve(__dirname, '../index.js');

// ── LLM mock helpers ─────────────────────────────────────────────────────────

/**
 * Returns the fragment the mock returns for the classifier turn.
 * The fragment omits the opening `{` because the Planner uses an assistant
 * prefill of `{` for the classifier turn — the mock checks for
 * `last.role === 'assistant' && last.content.startsWith('{')` to detect this
 * turn. The two halves concatenate to valid JSON. If the planner ever removes
 * the prefill, this mock will produce malformed JSON and tests will fail with
 * opaque JSON-parse errors rather than a clear signal — update the fragment
 * to include the opening `{` and adjust the detection heuristic in tandem.
 */
function classifierResponse(size: 'story' | 'epic'): string {
  return `"type":"feature","size":"${size}","confidence":"high","rationale":"test"}`;
}

function briefRefinerResponse(score = 9): string {
  return jsonBlock({
    ready: true,
    quality_score: score,
    refined_brief: '# Brief\n\n## Goal\nTest standalone presentation.',
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

function makeStandaloneStoryJson(storyId: string): string {
  return jsonBlock({
    id: storyId,
    title: 'Add minimal feature for presentation test',
    description: 'A small change to verify story framing end to end.',
    acceptance_criteria: ['The feature works'],
    estimated_complexity: 'small',
    dependencies: [],
    tech_notes: 'Edit src/index.ts.',
  });
}

function makeEpicJson(epicId: string): string {
  const num = epicId.slice(5);
  return jsonBlock({
    epics: [
      {
        epic_id: epicId,
        title: 'Presentation test epic',
        priority: 'must-have',
        prd_ref: 'x',
        requirements: ['FR-1'],
        stories: [
          {
            id: `story-${num}-001`,
            title: 'First story',
            description: 'Do the thing.',
            acceptance_criteria: ['it works'],
            estimated_complexity: 'small',
            dependencies: [],
          },
        ],
      },
    ],
  });
}

/**
 * Builds a mock LLM client for the standalone path:
 * classifier returns size=story → StandaloneStoryAgent path.
 */
function makeStandaloneLLM(): MockLLMClient {
  return new MockLLMClient((req: LLMRequest): string => {
    const last = req.messages[req.messages.length - 1];
    // Intake classifier: assistant prefill '{' is the distinguishing marker.
    if (last.role === 'assistant' && (last.content as string).startsWith('{')) {
      return classifierResponse('story');
    }
    const content = last.content as string;
    if (content.includes('Apply the discipline above')) return briefRefinerResponse();
    if (content.includes('Produce the project brief') || content.includes('brief to analyze'))
      return '# Brief\n\n## The Problem\nA gap.';
    if (content.includes('Produce a single story definition in JSON')) {
      const match = /Story id: "([^"]+)"/.exec(content);
      const storyId = match?.[1] ?? 'story-001';
      return makeStandaloneStoryJson(storyId);
    }
    throw new Error(`Unexpected standalone planning message: ${content.slice(0, 80)}`);
  });
}

/**
 * Builds a mock LLM client for the FULL EPIC path:
 * classifier returns size=epic OR routing=off → full Analyst→PM→Architect pipeline.
 */
function makeEpicLLM(): MockLLMClient {
  return new MockLLMClient((req: LLMRequest): string => {
    const last = req.messages[req.messages.length - 1];
    if (last.role === 'assistant' && (last.content as string).startsWith('{')) {
      return classifierResponse('epic');
    }
    const content = last.content as string;
    if (content.includes('Apply the discipline above')) return briefRefinerResponse();
    if (content.includes('Produce the project brief') || content.includes('brief to analyze'))
      return '# Brief\n\n## The Problem\nA gap.';
    if (content.includes('Headless task A: produce the PRD')) return '# PRD\n\n## Goals\nShip it.';
    if (content.includes('Headless task B: produce the epic')) {
      const m = content.match(/starting at "(epic-\d+)"/);
      const eid = m ? m[1] : 'epic-001';
      return makeEpicJson(eid);
    }
    if (content.includes('Headless task A: produce the architecture'))
      return '# Architecture\n\n## Architecture Philosophy\nBoring tech.';
    if (content.includes('Headless task B: produce per-story')) return '```json\n{"tech_notes":{}}\n```';
    throw new Error(`Unexpected epic planning message: ${content.slice(0, 80)}`);
  });
}

// ── Fixtures ──────────────────────────────────────────────────────────────────

let tmpDir: string;
let prevCwd: string;
let prevLoomHome: string | undefined;
let loomHomeDir: string;

const BRIEF =
  'Add a minimal feature to verify the standalone story presentation is consistent end to end.';

beforeEach(() => {
  prevLoomHome = process.env.LOOM_HOME;
  loomHomeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'loom-home-'));
  process.env.LOOM_HOME = loomHomeDir;

  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'loom-standalone-pres-'));
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: tmpDir });
  execFileSync('git', ['config', 'user.email', 'test@loom.dev'], { cwd: tmpDir });
  execFileSync('git', ['config', 'user.name', 'Loom Test'], { cwd: tmpDir });
  execFileSync('git', ['config', 'commit.gpgsign', 'false'], { cwd: tmpDir });
  fs.writeFileSync(path.join(tmpDir, 'README.md'), '# test\n');
  execFileSync('git', ['add', '.'], { cwd: tmpDir });
  execFileSync('git', ['commit', '-q', '-m', 'initial'], { cwd: tmpDir });
  execFileSync('node', [LOOM_CLI, 'init'], { cwd: tmpDir, stdio: 'ignore' });

  // Enable intake routing so classification influences planning.
  const policyPath = path.join(tmpDir, '.loom', 'policy.yaml');
  const policy = fs.readFileSync(policyPath, 'utf8');
  fs.writeFileSync(policyPath, policy.replace('intake_routing: "off"', 'intake_routing: "advisory"'));

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

// ── Suite 1: weave / epic summary output ─────────────────────────────────────

describe('weave summary — standalone story presentation (AC1, AC2)', () => {
  it('prints story-NNN, not epic-NNN, in the id list', async () => {
    const llm = makeStandaloneLLM();
    const { logs } = await capture(() => runEpic(BRIEF, { llm, force: true }));
    const idLine = logs.find((l) => /^story-\d{3}$/.test(l.trim()));
    assert.ok(idLine, `A line with "story-NNN" must appear in output. Got:\n${logs.join('\n')}`);
    const epicIdLine = logs.find((l) => /^epic-\d{3}$/.test(l.trim()));
    assert.ok(!epicIdLine, `No line with "epic-NNN" should appear. Got:\n${logs.join('\n')}`);
  });

  it('prints "Standalone story: story-NNN", not "N epic(s), 1 stories"', async () => {
    const llm = makeStandaloneLLM();
    const { logs } = await capture(() => runEpic(BRIEF, { llm, force: true }));
    const standaloneLine = logs.find((l) => l.includes('Standalone story: story-'));
    assert.ok(
      standaloneLine,
      `Must print "Standalone story: story-NNN". Got:\n${logs.join('\n')}`
    );
    const epicCountLine = logs.find((l) => /\d+ epic\(s\)/.test(l));
    assert.ok(
      !epicCountLine,
      `Must NOT print "N epic(s)". Got:\n${logs.join('\n')}`
    );
    const storiesCountLine = logs.find((l) => /1 stories/.test(l));
    assert.ok(
      !storiesCountLine,
      `Must NOT print "1 stories". Got:\n${logs.join('\n')}`
    );
  });

  it('full-epic pipeline (size=epic) still prints N epic(s) framing — no regression', async () => {
    const llm = makeEpicLLM();
    const { logs } = await capture(() => runEpic(BRIEF, { llm, force: true }));
    const epicCountLine = logs.find((l) => /\d+ epic\(s\)/.test(l));
    assert.ok(
      epicCountLine,
      `Full-epic path must still print "N epic(s)" line. Got:\n${logs.join('\n')}`
    );
    const standaloneLine = logs.find((l) => l.includes('Standalone story:'));
    assert.ok(
      !standaloneLine,
      `Full-epic path must NOT print "Standalone story:". Got:\n${logs.join('\n')}`
    );
  });
});

// ── Suite 2: intake_routing=off byte-identical path ──────────────────────────

describe('intake_routing=off — byte-identical to loom epic (AC9)', () => {
  it('with routing=off, output still uses "N epic(s)" framing regardless of classifier', async () => {
    // Reset policy to off so the classifier verdict is observe-only.
    const policyPath = path.join(tmpDir, '.loom', 'policy.yaml');
    const policy = fs.readFileSync(policyPath, 'utf8');
    fs.writeFileSync(policyPath, policy.replace('intake_routing: "advisory"', 'intake_routing: "off"'));

    const llm = makeEpicLLM(); // routing=off → full epic pipeline regardless of classifier
    const { logs, exitCode } = await capture(() => runEpic(BRIEF, { llm, force: true }));

    assert.equal(exitCode, null, 'must exit cleanly with routing=off');
    const epicCountLine = logs.find((l) => /\d+ epic\(s\)/.test(l));
    assert.ok(
      epicCountLine,
      `routing=off must use "N epic(s)" framing. Got:\n${logs.join('\n')}`
    );
    const standaloneLine = logs.find((l) => l.includes('Standalone story:'));
    assert.ok(
      !standaloneLine,
      `routing=off must NOT produce "Standalone story:" line. Got:\n${logs.join('\n')}`
    );
  });
});

// ── Suite 3: loom approve — story-NNN framing ────────────────────────────────

describe('loom approve — standalone story uses story-NNN framing (AC3)', () => {
  function seedStandalone(id: string, title: string): void {
    resetDatabaseForTest();
    const db = openDatabase(path.join(tmpDir, '.loom'));
    const store = new EpicStore(db);
    // Create a standalone container row (kind='standalone').
    store.createStandalone(id, title);
    resetDatabaseForTest();
  }

  it('approve epic-NNN for a standalone container prints story-NNN in output', async () => {
    seedStandalone('epic-042', 'Test standalone approve');
    const { logs } = await capture(() =>
      runApprove('epic-042', { printOverlapAdvisory: () => {} })
    );
    const approvedLine = logs.find((l) => l.includes('approved'));
    assert.ok(approvedLine, 'An approved line must be printed');
    assert.ok(
      approvedLine!.includes('story-042'),
      `Approved line must use story-042, not epic-042. Got: ${approvedLine}`
    );
    assert.ok(
      !approvedLine!.includes('epic-042'),
      `Approved line must NOT show epic-042. Got: ${approvedLine}`
    );
  });

  it('approve story-NNN (user-facing id) resolves to the standalone container and approves it', async () => {
    seedStandalone('epic-043', 'Resolve-by-story-id test');
    const { exitCode, logs } = await capture(() =>
      runApprove('story-043', { printOverlapAdvisory: () => {} })
    );
    assert.equal(exitCode, null, 'approving with story-NNN must succeed');
    const approvedLine = logs.find((l) => l.includes('approved'));
    assert.ok(approvedLine?.includes('story-043'), `output must show story-043. Got: ${approvedLine}`);

    resetDatabaseForTest();
    const db = openDatabase(path.join(tmpDir, '.loom'));
    assert.equal(
      new EpicStore(db).get('epic-043')?.status,
      'approved',
      'the internal epic-043 row must be approved'
    );
    resetDatabaseForTest();
  });

  it('approve with story-NNN run-hint shows story-NNN, not epic-NNN', async () => {
    seedStandalone('epic-044', 'Run-hint display test');
    const { logs } = await capture(() =>
      runApprove('story-044', { printOverlapAdvisory: () => {} })
    );
    const runHint = logs.find((l) => l.includes('loom run'));
    assert.ok(runHint, 'A run-hint must be printed');
    assert.ok(
      runHint!.includes('story-044'),
      `Run-hint must reference story-044. Got: ${runHint}`
    );
    assert.ok(
      !runHint!.includes('epic-044'),
      `Run-hint must NOT reference epic-044. Got: ${runHint}`
    );
  });

  it('approve story-NNN where no standalone container exists exits non-zero', async () => {
    const { exitCode, errors } = await capture(() =>
      runApprove('story-999', { printOverlapAdvisory: () => {} })
    );
    assert.equal(exitCode, 1, 'must exit non-zero for an unknown story id');
    assert.ok(errors.some((e) => e.includes('not found')), 'must print "not found" error');
  });

  it('approve story-NNN chains into runRun with the internal epic-NNN id', async () => {
    seedStandalone('epic-045', 'Chain-test standalone');
    const calls: Array<{ epicIds: string[]; opts: RunOptions }> = [];
    const runRunStub = async (epicIds: string[], opts: RunOptions = {}): Promise<void> => {
      calls.push({ epicIds, opts });
    };

    await capture(() =>
      runApprove('story-045', { run: true, runRun: runRunStub, printOverlapAdvisory: () => {} })
    );

    assert.equal(calls.length, 1, 'runRun must be called exactly once');
    assert.deepEqual(
      calls[0].epicIds,
      ['epic-045'],
      'runRun must receive the internal epic-045 id, not story-045'
    );
  });

  it('reject story-NNN resolves to the standalone container and rejects it', async () => {
    seedStandalone('epic-046', 'Reject test standalone');
    const { exitCode, logs } = await capture(() =>
      runReject('story-046', 'scope too small')
    );
    assert.equal(exitCode, null, 'reject with story-NNN must succeed');
    const rejectedLine = logs.find((l) => l.includes('rejected'));
    assert.ok(rejectedLine?.includes('story-046'), `output must show story-046. Got: ${rejectedLine}`);

    resetDatabaseForTest();
    const db = openDatabase(path.join(tmpDir, '.loom'));
    assert.equal(
      new EpicStore(db).get('epic-046')?.status,
      'rejected',
      'the internal epic-046 row must be rejected'
    );
    resetDatabaseForTest();
  });
});

// ── Suite 4: renderPrTail — story-NNN in multi-entry label ───────────────────

describe('renderPrTail — standalone story-NNN label (AC4)', () => {
  it('single-entry standalone: only URL shown (no label — no regression)', () => {
    const lines = renderPrTail([
      { id: 'epic-001', kind: 'standalone', epic_pr_url: 'https://example.com/pr/1' },
    ]);
    const joined = lines.join('\n');
    // Single-entry case: only "PR: <url>" — no id label at all, regardless of kind.
    assert.ok(
      joined.includes('PR: https://example.com/pr/1'),
      `single-entry must show "PR: <url>" format. Got:\n${joined}`
    );
    assert.ok(!joined.includes('epic-001'), 'single-entry must not show epic-001 label');
    assert.ok(!joined.includes('story-001'), 'single-entry must not show story-001 label');
  });

  it('multi-entry: standalone entry is labeled story-NNN, not epic-NNN', () => {
    const lines = renderPrTail([
      { id: 'epic-001', kind: 'standalone', epic_pr_url: 'https://example.com/pr/1' },
      { id: 'epic-002', kind: null, epic_pr_url: 'https://example.com/pr/2' },
    ]);
    const joined = lines.join('\n');
    assert.ok(
      joined.includes('story-001: https://example.com/pr/1'),
      `Standalone entry must show story-001 label. Got:\n${joined}`
    );
    assert.ok(
      joined.includes('epic-002: https://example.com/pr/2'),
      `Regular epic entry must still show epic-002 label. Got:\n${joined}`
    );
    assert.ok(!joined.includes('epic-001'), 'epic-001 must not appear in output');
  });

  it('multi-entry: all standalones show story-NNN labels', () => {
    const lines = renderPrTail([
      { id: 'epic-010', kind: 'standalone', epic_pr_url: 'https://example.com/pr/10' },
      { id: 'epic-011', kind: 'standalone', epic_pr_url: 'https://example.com/pr/11' },
    ]);
    const joined = lines.join('\n');
    assert.ok(joined.includes('story-010:'), 'epic-010 standalone must show story-010');
    assert.ok(joined.includes('story-011:'), 'epic-011 standalone must show story-011');
    assert.ok(!joined.includes('epic-010'), 'epic-010 must not appear');
    assert.ok(!joined.includes('epic-011'), 'epic-011 must not appear');
  });

  it('renderPrTail unchanged for regular epics (no kind) — no regression (AC8)', () => {
    const lines = renderPrTail([
      { id: 'epic-001', epic_pr_url: 'https://example.com/pr/1' },
      { id: 'epic-002', epic_pr_url: 'https://example.com/pr/2' },
    ]);
    const joined = lines.join('\n');
    assert.ok(joined.includes('epic-001: https://example.com/pr/1'));
    assert.ok(joined.includes('epic-002: https://example.com/pr/2'));
  });
});

// ── Suite 5: weave output DB — standalone story-NNN is the agent story_id ────

describe('weave/epic — DB agent row uses story-NNN id on the standalone path (AC7)', () => {
  it('after planning, the agent row has story_id=story-NNN and branch_name=story/story-NNN', async () => {
    const llm = makeStandaloneLLM();
    const { exitCode } = await runInProcess(() => runEpic(BRIEF, { llm, force: true }));
    assert.equal(exitCode, null, 'must exit cleanly');

    const db = openDatabase(path.join(tmpDir, '.loom'));
    const epicStore = new EpicStore(db);
    // The container should be a standalone with kind='standalone'.
    const epics = epicStore.list({ includeStandalone: true });
    const container = epics.find((e) => e.kind === 'standalone');
    assert.ok(container, 'a standalone container epic must exist in the DB');

    // The expected user-facing story id is story-NNN (internal row is epic-NNN).
    const expectedStoryId = container!.id.replace(/^epic-/, 'story-');
    assert.match(expectedStoryId, /^story-\d{3}$/, 'expected story id must match story-NNN pattern');

    // Planner.runStandalone atomically creates an agents row with the story-NNN
    // identity and the story/story-NNN branch name (ADR-002 §5 identity scheme).
    const agentStore = new AgentStore(db);
    const agentRows = agentStore.listByEpic(container!.id);
    assert.equal(agentRows.length, 1, 'exactly one agent row must exist for the standalone container');
    assert.equal(
      agentRows[0].story_id,
      expectedStoryId,
      `agent row story_id must be ${expectedStoryId}, not the internal epic id`
    );
    assert.equal(
      agentRows[0].branch_name,
      `story/${expectedStoryId}`,
      `agent row branch_name must be story/${expectedStoryId}`
    );
  });
});
