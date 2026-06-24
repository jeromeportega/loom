/**
 * Routing decision table and standalone path tests (story-047-002).
 *
 * Covers:
 *  - isStandalone predicate table (FR-1/FR-2/FR-3 guard)
 *  - standaloneStoryId / standaloneBranch identity helpers (§5)
 *  - Planner.run routing: standalone path skips PM + Architect; epic path runs them
 *  - Override directions: story→epic (epic pipeline); epic→story (standalone path)
 *  - off-path / classification-failure: routing=undefined → epic pipeline
 *  - Single story emitted with required fields on standalone path (AC4)
 *  - Analyst runs on BOTH paths (AC5)
 *  - run(brief, reservedId) signature is unchanged (compile-time)
 *
 * LLM is fully stubbed — no real calls. PMAgent/ArchitectAgent/StandaloneStoryAgent
 * dispatching is verified by inspecting the mock LLM request messages.
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDatabase, resetDatabaseForTest } from '../../state/Database.js';
import { EpicStore } from '../../state/EpicStore.js';
import { AgentStore } from '../../state/AgentStore.js';
import { MockLLMClient } from '../../llm/MockLLMClient.js';
import type { LLMRequest } from '../../llm/LLMClient.js';
import { Planner } from '../Planner.js';
import {
  isStandalone,
  standaloneStoryId,
  standaloneBranch,
} from '../../intake/routing.js';
import type { EffectiveRouting } from '../../intake/routing.js';

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const BASE_ROUTING: EffectiveRouting = {
  type: 'feature',
  size: 'story',
  confidence: 'high',
  source: 'classifier',
};

const STORY_ROUTING: EffectiveRouting = { ...BASE_ROUTING, size: 'story' };
const EPIC_ROUTING: EffectiveRouting = { ...BASE_ROUTING, size: 'epic' };
const STORY_ROUTING_CONFIRM: EffectiveRouting = {
  ...BASE_ROUTING,
  size: 'story',
  source: 'operator-override',
};
const EPIC_ROUTING_OVERRIDE: EffectiveRouting = {
  ...BASE_ROUTING,
  size: 'epic',
  source: 'operator-override',
};

const ANALYST_BRIEF = '# Login Form\n\nAdd a simple email + password login form.';
const PM_PRD = '# Login PRD\n\n## Goals\nShip the login form.';
const ARCH_DOC = '# Architecture\n\n## Philosophy\nKeep it boring.';
const STANDALONE_STORY_JSON = JSON.stringify({
  id: 'story-001',
  title: 'Add email and password login form',
  description: 'Build a minimal login form with email and password fields.',
  acceptance_criteria: ['The form submits credentials', 'Invalid credentials show an error'],
  estimated_complexity: 'small',
  dependencies: [],
  tech_notes: 'Use the existing AuthService. Edit src/components/LoginForm.tsx.',
});

function makeEpicsJson(epicId: string): string {
  const num = epicId.slice(5);
  return JSON.stringify({
    epics: [
      {
        epic_id: epicId,
        title: 'Epic title',
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

/** Returns true if the request has a user message containing all the given keywords. */
function hasMsg(req: LLMRequest, ...keywords: string[]): boolean {
  return req.messages.some((m) =>
    keywords.every((k) => m.content.includes(k))
  );
}

/**
 * Identifies which agent sent this LLM request by its trigger text.
 * Checks ALL messages (not just the last) so retry attempts are correctly
 * classified — on retry, the last message is the correction prompt, not the
 * identifying task text.
 */
function whichAgent(req: LLMRequest): string {
  const allContent = req.messages.map((m) => m.content).join('\n');
  if (allContent.includes('Produce a single story definition in JSON')) return 'standalone';
  if (allContent.includes('Headless task A: produce the PRD')) return 'pm-task-a';
  if (allContent.includes('Headless task B: produce the epic')) return 'pm-task-b';
  if (allContent.includes('Headless task A: produce the architecture')) return 'arch-task-a';
  if (allContent.includes('Headless task B: produce per-story')) return 'arch-task-b';
  if (
    allContent.includes('Produce the project brief document') ||
    allContent.includes('brief to analyze')
  )
    return 'analyst';
  return 'unknown';
}

/** Scripted responder for the full epic pipeline (Analyst → PM → Architect). */
function epicPipelineResponder(req: LLMRequest): string {
  const last = req.messages[req.messages.length - 1].content;
  if (last.includes('brief to analyze') || last.includes('Produce the project brief document')) return ANALYST_BRIEF;
  if (last.includes('Headless task A: produce the PRD')) return PM_PRD;
  if (last.includes('Headless task B: produce the epic'))
    return '```json\n' + makeEpicsJson('epic-001') + '\n```';
  if (last.includes('Headless task A: produce the architecture')) return ARCH_DOC;
  if (last.includes('Headless task B: produce per-story')) return '```json\n{"tech_notes":{}}\n```';
  throw new Error(`Unexpected planning message: ${last.slice(0, 80)}`);
}

/** Scripted responder for the standalone path (Analyst → StandaloneStoryAgent). */
function standalonePipelineResponder(req: LLMRequest): string {
  const last = req.messages[req.messages.length - 1].content;
  if (last.includes('brief to analyze') || last.includes('Produce the project brief document')) return ANALYST_BRIEF;
  if (last.includes('Produce a single story definition in JSON')) {
    // Parse the story id from the prompt so the fixture matches the actual
    // derived storyId (standaloneStoryId(runId)) rather than hard-coding 'story-001'.
    // StandaloneStoryAgent overwrites the id anyway, but injecting the correct id
    // here keeps the mock consistent and avoids silent divergence in YAML assertions.
    const match = /Story id: "([^"]+)"/.exec(last);
    const storyId = match?.[1] ?? 'story-001';
    const json = { ...JSON.parse(STANDALONE_STORY_JSON), id: storyId };
    return '```json\n' + JSON.stringify(json) + '\n```';
  }
  throw new Error(`Unexpected standalone planning message: ${last.slice(0, 80)}`);
}

function makePlanner(
  llm: MockLLMClient,
  tmpDir: string,
  routing?: EffectiveRouting
): Planner {
  const db = openDatabase(path.join(tmpDir, '.loom'));
  return new Planner({ projectRoot: tmpDir, llm, model: 'mock-model', db, routing });
}

// ─── Suite 1: isStandalone predicate table ────────────────────────────────────

describe('isStandalone — predicate table (FR-1 / FR-2 / FR-3 guard)', () => {
  it('isStandalone(undefined) === false (off-path guard)', () => {
    assert.equal(isStandalone(undefined), false);
  });

  it('isStandalone({size:"story",...}) === true', () => {
    assert.equal(isStandalone({ ...BASE_ROUTING, size: 'story' }), true);
  });

  it('isStandalone({size:"epic",...}) === false', () => {
    assert.equal(isStandalone({ ...BASE_ROUTING, size: 'epic' }), false);
  });

  it('source does not affect the predicate — classifier vs operator-override both work', () => {
    assert.equal(isStandalone({ ...BASE_ROUTING, size: 'story', source: 'classifier' }), true);
    assert.equal(isStandalone({ ...BASE_ROUTING, size: 'story', source: 'operator-override' }), true);
  });

  it('type and confidence do not affect the predicate', () => {
    assert.equal(isStandalone({ type: 'bug', size: 'story', confidence: 'low', source: 'classifier' }), true);
    assert.equal(isStandalone({ type: 'chore', size: 'epic', confidence: 'high', source: 'classifier' }), false);
  });
});

// ─── Suite 2: identity helpers ────────────────────────────────────────────────

describe('standaloneStoryId / standaloneBranch — identity helpers (§5)', () => {
  it('standaloneStoryId: epic-047 → story-047', () => {
    assert.equal(standaloneStoryId('epic-047'), 'story-047');
  });

  it('standaloneStoryId: epic-001 → story-001', () => {
    assert.equal(standaloneStoryId('epic-001'), 'story-001');
  });

  it('standaloneBranch: story-047 → story/story-047', () => {
    assert.equal(standaloneBranch('story-047'), 'story/story-047');
  });

  it('standaloneBranch: story-001 → story/story-001', () => {
    assert.equal(standaloneBranch('story-001'), 'story/story-001');
  });

  it('round-trip: standaloneStoryId → standaloneBranch is consistent', () => {
    const sid = standaloneStoryId('epic-042');
    assert.equal(sid, 'story-042');
    assert.equal(standaloneBranch(sid), 'story/story-042');
  });
});

// ─── Suite 3: route to standalone (advisory, size=story) ─────────────────────

describe('Planner.run — standalone path (advisory, size=story)', () => {
  let tmpDir: string;
  let llm: MockLLMClient;
  let result: Awaited<ReturnType<Planner['run']>>;
  let agentNames: string[];

  before(async () => {
    resetDatabaseForTest();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'loom-standalone-advisory-'));
    llm = new MockLLMClient(standalonePipelineResponder);
    const planner = makePlanner(llm, tmpDir, STORY_ROUTING);
    result = await planner.run('Add a login form with email and password fields.');
    agentNames = llm.requests.map(whichAgent);
  });

  after(() => {
    resetDatabaseForTest();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('all LLM requests are from a recognised agent (no unknown classifications)', () => {
    const unknowns = agentNames.filter((n) => n === 'unknown');
    assert.equal(unknowns.length, 0, `Unclassified LLM requests detected — whichAgent() missed ${unknowns.length} call(s)`);
  });

  it('StandaloneStoryAgent is called exactly once (AC3)', () => {
    const standaloneCount = agentNames.filter((n) => n === 'standalone').length;
    assert.equal(standaloneCount, 1, 'StandaloneStoryAgent must be called exactly once');
  });

  it('PMAgent is NOT called (AC3 — no PRD, no decomposition)', () => {
    const pmCalls = agentNames.filter((n) => n.startsWith('pm-'));
    assert.equal(pmCalls.length, 0, `PMAgent must not be called on standalone path; got: ${pmCalls.join(', ')}`);
  });

  it('ArchitectAgent is NOT called (AC3 — no decomposition pass)', () => {
    const archCalls = agentNames.filter((n) => n.startsWith('arch-'));
    assert.equal(archCalls.length, 0, `ArchitectAgent must not be called on standalone path; got: ${archCalls.join(', ')}`);
  });

  it('AnalystAgent runs on the standalone path (AC5)', () => {
    const analystCount = agentNames.filter((n) => n === 'analyst').length;
    assert.ok(analystCount >= 1, 'AnalystAgent must run on the standalone path');
  });

  it('result.storyCount === 1 (AC4)', () => {
    assert.equal(result.storyCount, 1);
  });

  it('result has no PRD path (standalone emits no PRD)', () => {
    assert.equal(result.prdPath, '', 'standalone path must not produce a PRD');
  });

  it('result has no architecture path (standalone has no decomposition)', () => {
    assert.equal(result.architecturePath, '', 'standalone path must not produce an architecture doc');
  });

  it('result.epicIds contains the standalone story id (story-NNN, not epic-NNN)', () => {
    assert.equal(result.epicIds.length, 1);
    assert.ok(result.epicIds[0].startsWith('story-'), `epicIds[0] must be story-NNN, got: ${result.epicIds[0]}`);
    assert.equal(result.epicIds[0], result.runId, 'epicIds[0] must equal runId');
  });

  it('the YAML file exists and contains exactly one story (AC4)', () => {
    assert.equal(result.epicPaths.length, 1);
    const yamlPath = result.epicPaths[0];
    assert.ok(fs.existsSync(yamlPath), `YAML file must exist at ${yamlPath}`);
    const content = fs.readFileSync(yamlPath, 'utf8');
    const expectedStoryId = standaloneStoryId(result.runId);
    assert.ok(content.includes(expectedStoryId), `YAML must contain the standalone story id (${expectedStoryId})`);
    assert.ok(content.includes('Add email and password login form'), 'YAML must contain the story title');
    assert.ok(content.includes('acceptance_criteria'), 'YAML must contain acceptance_criteria');
    assert.ok(content.includes('tech_notes'), 'YAML must contain tech_notes');
  });

  it('DB container epic row has kind=standalone', () => {
    const db = openDatabase(path.join(tmpDir, '.loom'));
    const epicStore = new EpicStore(db);
    assert.ok(epicStore.isStandalone(result.runId), 'container epic row must have kind=standalone');
  });

  it('DB has exactly one agents row for the standalone story', () => {
    const db = openDatabase(path.join(tmpDir, '.loom'));
    const agentStore = new AgentStore(db);
    const agents = agentStore.listByEpic(result.runId);
    assert.equal(agents.length, 1, 'exactly one agent row must be created');
    const agent = agents[0];
    assert.equal(agent.story_id, standaloneStoryId(result.runId));
    assert.equal(agent.branch_name, standaloneBranch(standaloneStoryId(result.runId)));
  });

  it('the standalone story has title, description, acceptance_criteria>=1, and tech_notes (AC4)', () => {
    const db = openDatabase(path.join(tmpDir, '.loom'));
    const agentStore = new AgentStore(db);
    const agent = agentStore.listByEpic(result.runId)[0];
    assert.ok(agent.story_title && agent.story_title.length >= 5, 'story title must be non-empty');
    // Verify the YAML content for other required fields
    const yamlContent = fs.readFileSync(result.epicPaths[0], 'utf8');
    assert.ok(yamlContent.includes('description'), 'story must have description');
    assert.ok(yamlContent.includes('acceptance_criteria'), 'story must have acceptance_criteria');
    assert.ok(yamlContent.includes('tech_notes'), 'story must have tech_notes');
  });
});

// ─── Suite 4: confirm-mode story→epic override ────────────────────────────────

describe('Planner.run — confirm-mode story→epic override routes to epic pipeline (AC2)', () => {
  let tmpDir: string;
  let llm: MockLLMClient;
  let agentNames: string[];

  before(async () => {
    resetDatabaseForTest();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'loom-story-epic-override-'));
    llm = new MockLLMClient(epicPipelineResponder);
    // confirm-mode story→epic override: source='operator-override', size='epic'
    const planner = makePlanner(llm, tmpDir, EPIC_ROUTING_OVERRIDE);
    await planner.run('Build the login form.');
    agentNames = llm.requests.map(whichAgent);
  });

  after(() => {
    resetDatabaseForTest();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('all LLM requests are from a recognised agent (no unknown classifications)', () => {
    const unknowns = agentNames.filter((n) => n === 'unknown');
    assert.equal(unknowns.length, 0, `Unclassified LLM requests detected — whichAgent() missed ${unknowns.length} call(s)`);
  });

  it('PM is called (epic pipeline, not standalone)', () => {
    const pmCalls = agentNames.filter((n) => n.startsWith('pm-'));
    assert.ok(pmCalls.length > 0, 'PMAgent must be called when story→epic override lands as size=epic');
  });

  it('StandaloneStoryAgent is NOT called', () => {
    assert.equal(
      agentNames.filter((n) => n === 'standalone').length,
      0,
      'standalone path must NOT run when size=epic (operator-override)'
    );
  });
});

// ─── Suite 5: epic→story operator-override ────────────────────────────────────

describe('Planner.run — epic→story override routes to standalone path (AC2)', () => {
  let tmpDir: string;
  let llm: MockLLMClient;
  let agentNames: string[];
  let result: Awaited<ReturnType<Planner['run']>>;

  before(async () => {
    resetDatabaseForTest();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'loom-epic-story-override-'));
    llm = new MockLLMClient(standalonePipelineResponder);
    // epic→story override: source='operator-override', size='story'
    const planner = makePlanner(llm, tmpDir, STORY_ROUTING_CONFIRM);
    result = await planner.run('Add login form.');
    agentNames = llm.requests.map(whichAgent);
  });

  after(() => {
    resetDatabaseForTest();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('all LLM requests are from a recognised agent (no unknown classifications)', () => {
    const unknowns = agentNames.filter((n) => n === 'unknown');
    assert.equal(unknowns.length, 0, `Unclassified LLM requests detected — whichAgent() missed ${unknowns.length} call(s)`);
  });

  it('standalone path is taken (AC2)', () => {
    assert.equal(
      agentNames.filter((n) => n === 'standalone').length,
      1,
      'StandaloneStoryAgent must run for epic→story override'
    );
  });

  it('PMAgent is NOT called (AC2)', () => {
    assert.equal(agentNames.filter((n) => n.startsWith('pm-')).length, 0);
  });

  it('result.storyCount === 1 (AC2)', () => {
    assert.equal(result.storyCount, 1);
  });
});

// ─── Suite 6: routing=undefined → epic pipeline (off-path / classification failure) ─

describe('Planner.run — routing=undefined routes to epic pipeline (AC1, NFR-1)', () => {
  let tmpDir: string;
  let llm: MockLLMClient;
  let agentNames: string[];

  before(async () => {
    resetDatabaseForTest();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'loom-no-routing-'));
    llm = new MockLLMClient(epicPipelineResponder);
    const planner = makePlanner(llm, tmpDir, undefined);
    await planner.run('Add login form.');
    agentNames = llm.requests.map(whichAgent);
  });

  after(() => {
    resetDatabaseForTest();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('all LLM requests are from a recognised agent (no unknown classifications)', () => {
    const unknowns = agentNames.filter((n) => n === 'unknown');
    assert.equal(unknowns.length, 0, `Unclassified LLM requests detected — whichAgent() missed ${unknowns.length} call(s)`);
  });

  it('epic pipeline runs (PM called)', () => {
    assert.ok(
      agentNames.some((n) => n.startsWith('pm-')),
      'PMAgent must run on the off-path (routing=undefined)'
    );
  });

  it('standalone path is never entered', () => {
    assert.equal(
      agentNames.filter((n) => n === 'standalone').length,
      0,
      'routing=undefined must NEVER enter the standalone branch'
    );
  });
});

// ─── Suite 7: Analyst runs on BOTH paths (AC5) ───────────────────────────────
// Each test gets its own tmpDir + DB reset to avoid the singleton DB collision
// (openDatabase() returns the same _db for any path if not reset between calls).

describe('Planner.run — AnalystAgent runs on both paths (AC5)', () => {
  it('Analyst runs on the standalone path', async () => {
    resetDatabaseForTest();
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'loom-analyst-standalone-'));
    try {
      const llm = new MockLLMClient(standalonePipelineResponder);
      await makePlanner(llm, tmpDir, STORY_ROUTING).run('A brief.');
      const names = llm.requests.map(whichAgent);
      assert.ok(names.includes('analyst'), 'AnalystAgent must run on standalone path');
    } finally {
      resetDatabaseForTest();
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('Analyst runs on the epic path', async () => {
    resetDatabaseForTest();
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'loom-analyst-epic-'));
    try {
      const llm = new MockLLMClient(epicPipelineResponder);
      await makePlanner(llm, tmpDir, EPIC_ROUTING).run('A brief.');
      const names = llm.requests.map(whichAgent);
      assert.ok(names.includes('analyst'), 'AnalystAgent must run on epic path');
    } finally {
      resetDatabaseForTest();
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

// ─── Suite 8: nextEpicId includes standalone containers (correctness guard) ──

describe('Planner.nextEpicId — includes standalone containers to prevent PK conflicts', () => {
  it('standalone container id is included in the max numbering', () => {
    resetDatabaseForTest();
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'loom-nextepic-'));
    try {
      const db = openDatabase(path.join(tmpDir, '.loom'));
      const epicStore = new EpicStore(db);
      epicStore.createStandalone('epic-003', 'standalone container');
      const nextId = Planner.nextEpicId(db);
      // With epic-003 as the only row, next must be epic-004 (not epic-001)
      assert.equal(nextId, 'epic-004', 'nextEpicId must count standalone containers');
    } finally {
      resetDatabaseForTest();
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
