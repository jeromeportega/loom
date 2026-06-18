import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import yaml from 'js-yaml';
import { openDatabase, resetDatabaseForTest } from '../state/Database.js';
import { EpicStore } from '../state/EpicStore.js';
import { MockLLMClient } from '../llm/MockLLMClient.js';
import type { MockResponder } from '../llm/MockLLMClient.js';
import type { LLMClient, LLMUsage } from '../llm/index.js';
import { AnalystAgent } from '../planner/AnalystAgent.js';
import { PMAgent, validateEpicSet } from '../planner/PMAgent.js';
import { ArchitectAgent } from '../planner/ArchitectAgent.js';
import { QAAgent } from '../planner/QAAgent.js';
import { Planner } from '../planner/Planner.js';
import type { PlannerContext } from '../planner/context.js';
import type { PlanningEvent } from '../planner/PlanningEvent.js';
import { extractJsonBlock, trimToFirstHeading } from '../planner/util.js';
import { planningPaths } from '../planner/paths.js';
import { EpicYamlSchema } from '../types.js';

// ─── Scripted persona outputs ──────────────────────────────────────────────

const ANALYST_BRIEF = '# Demo Project\n\n## The Problem\nThere is a gap to fill.';
const PM_PRD = '# Demo PRD\n\n## Goals\nShip the demo.\n\n## Functional Requirements\nFR-1: it works.';
const ARCH_DOC = '# Demo Architecture\n\n## Architecture Philosophy\nFavor boring technology.';

function pmEpicsJson(userMsg: string): string {
  const m = userMsg.match(/starting at "(epic-\d+)"/);
  const eid = m ? m[1] : 'epic-001';
  const num = eid.slice(5);
  return (
    'Here is the breakdown:\n```json\n' +
    JSON.stringify({
      epics: [
        {
          epic_id: eid,
          title: 'Test epic for the planner pipeline',
          priority: 'must-have',
          prd_ref: 'placeholder-to-be-overwritten',
          requirements: ['FR-1'],
          stories: [
            {
              id: `story-${num}-001`,
              title: 'First test story',
              description: 'Build the first thing.',
              acceptance_criteria: ['it works'],
              estimated_complexity: 'small',
              dependencies: [],
            },
            {
              id: `story-${num}-002`,
              title: 'Second test story',
              description: 'Build the second thing.',
              acceptance_criteria: ['it also works'],
              estimated_complexity: 'medium',
              dependencies: [`story-${num}-001`],
            },
          ],
        },
      ],
    }) +
    '\n```'
  );
}

function archTechNotesJson(userMsg: string): string {
  const ids = [...userMsg.matchAll(/"id":\s*"(story-[\d-]+)"/g)].map((m) => m[1]);
  const notes: Record<string, string> = {};
  for (const id of ids) notes[id] = `Tech guidance for ${id}: use the relevant module.`;
  return '```json\n' + JSON.stringify({ tech_notes: notes }) + '\n```';
}

function qaTestPlanJson(userMsg: string): string {
  const ids = [...userMsg.matchAll(/"id":\s*"(story-[\d-]+)"/g)].map((m) => m[1]);
  const plans: Record<string, string> = {};
  for (const id of ids) {
    plans[id] = `Test plan for ${id}: unit-test the happy path plus one error case.`;
  }
  return '```json\n' + JSON.stringify({ test_plan: plans }) + '\n```';
}

/** A responder that drives the full Analyst→PM→Architect pipeline. */
const fullPipelineResponder: MockResponder = (req) => {
  const last = req.messages[req.messages.length - 1].content;
  if (last.includes('Produce the project brief')) return ANALYST_BRIEF;
  if (last.includes('Headless task A: produce the PRD')) return PM_PRD;
  if (last.includes('Headless task B: produce the epic')) return pmEpicsJson(last);
  if (last.includes('Headless task A: produce the architecture')) return ARCH_DOC;
  if (last.includes('Headless task B: produce per-story')) return archTechNotesJson(last);
  if (last.includes('Headless task C: produce the shared')) return SHARED_CONTRACT_DOC;
  if (last.includes('produce a per-story test_plan')) return qaTestPlanJson(last);
  throw new Error(`MockLLMClient: unexpected message: ${last.slice(0, 100)}`);
};

const SHARED_CONTRACT_DOC =
  '# Shared implementation contract\n\n' +
  '## Shared interfaces & types\n`createUser(input: UserInput): User`\n\n' +
  '## File & module ownership map\n| Story | Owns |\n| --- | --- |\n| story-001-001 | src/auth/ |\n';

// ─── Test harness ───────────────────────────────────────────────────────────

let tmpDir: string;

beforeEach(() => {
  resetDatabaseForTest();
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'loom-planner-'));
});

afterEach(() => {
  resetDatabaseForTest();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function ctx(llm: MockLLMClient): PlannerContext {
  return { projectRoot: tmpDir, llm, model: 'mock-model', runId: 'epic-001' };
}

// ─── util ───────────────────────────────────────────────────────────────────

describe('planner/util', () => {
  it('extractJsonBlock parses a fenced json block', () => {
    const obj = extractJsonBlock('prose\n```json\n{"a":1}\n```\nmore') as { a: number };
    assert.equal(obj.a, 1);
  });

  it('extractJsonBlock parses bare json', () => {
    const obj = extractJsonBlock('{"b":2}') as { b: number };
    assert.equal(obj.b, 2);
  });

  it('extractJsonBlock throws a descriptive error on garbage', () => {
    assert.throws(() => extractJsonBlock('not json'), /could not parse/);
  });

  it('trimToFirstHeading strips a conversational preamble', () => {
    assert.equal(trimToFirstHeading('Sure!\n\n# Title\n\nbody'), '# Title\n\nbody');
  });

  it('trimToFirstHeading is a no-op when text already starts at a heading', () => {
    assert.equal(trimToFirstHeading('# Title\nbody'), '# Title\nbody');
  });
});

// ─── AnalystAgent ───────────────────────────────────────────────────────────

describe('AnalystAgent', () => {
  it('writes project-brief.md and returns the content', async () => {
    const llm = new MockLLMClient([ANALYST_BRIEF]);
    const result = await new AnalystAgent(ctx(llm)).run('Build a demo.');
    assert.ok(fs.existsSync(result.briefPath));
    assert.ok(result.briefContent.includes('Demo Project'));
    assert.ok(fs.readFileSync(result.briefPath, 'utf8').startsWith('# Demo Project'));
  });

  it('marks the persona system block as cacheable', async () => {
    const llm = new MockLLMClient([ANALYST_BRIEF]);
    await new AnalystAgent(ctx(llm)).run('Build a demo.');
    assert.equal(llm.requests[0].system[0].cache, true);
  });
});

// ─── PMAgent ────────────────────────────────────────────────────────────────

describe('PMAgent', () => {
  it('writes prd.md and a schema-valid epic YAML', async () => {
    const llm = new MockLLMClient(fullPipelineResponder);
    const result = await new PMAgent(ctx(llm)).run(ANALYST_BRIEF, 1);

    assert.ok(fs.existsSync(result.prdPath));
    assert.equal(result.epics.length, 1);
    assert.equal(result.epics[0].epic_id, 'epic-001');
    assert.equal(result.epics[0].stories.length, 2);

    // The written YAML round-trips through the schema
    const raw = fs.readFileSync(result.epicPaths[0], 'utf8');
    const parsed = EpicYamlSchema.parse(yaml.load(raw));
    assert.equal(parsed.status, 'planned');
  });

  it('forces prd_ref to the real run-relative path', async () => {
    const llm = new MockLLMClient(fullPipelineResponder);
    const result = await new PMAgent(ctx(llm)).run(ANALYST_BRIEF, 1);
    assert.equal(result.epics[0].prd_ref, '.loom/planning/epic-001/prd.md');
  });

  it('numbers epics from the given start number', async () => {
    const llm = new MockLLMClient(fullPipelineResponder);
    const c = { ...ctx(llm), runId: 'epic-005' };
    const result = await new PMAgent(c).run(ANALYST_BRIEF, 5);
    assert.equal(result.epics[0].epic_id, 'epic-005');
    assert.equal(result.epics[0].stories[0].id, 'story-005-001');
  });

  it('retries once when the first epic JSON fails validation', async () => {
    // PRD call, then a bad epic JSON, then a valid one.
    const llm = new MockLLMClient([
      PM_PRD,
      '```json\n{"epics":[]}\n```', // fails: needs >=1 epic
      pmEpicsJson('starting at "epic-001"'),
    ]);
    const result = await new PMAgent(ctx(llm)).run(ANALYST_BRIEF, 1);
    assert.equal(result.epics.length, 1);
    // 1 PRD call + 2 epic-generation attempts
    assert.equal(llm.requests.length, 3);
  });

  it('throws a clear error when both epic attempts fail', async () => {
    const llm = new MockLLMClient([PM_PRD, 'garbage', 'still garbage']);
    await assert.rejects(
      () => new PMAgent(ctx(llm)).run(ANALYST_BRIEF, 1),
      /failed to produce a valid epic breakdown after 2 attempts/
    );
  });

  it('retries when the PM mis-numbers the epic, then accepts the corrected output', async () => {
    // Told to start at epic-002 but first emits epic-001; second attempt fixes it.
    const llm = new MockLLMClient([
      PM_PRD,
      pmEpicsJson('starting at "epic-001"'),
      pmEpicsJson('starting at "epic-002"'),
    ]);
    const c = { ...ctx(llm), runId: 'epic-002' };
    const result = await new PMAgent(c).run(ANALYST_BRIEF, 2);
    assert.equal(result.epics[0].epic_id, 'epic-002');
    assert.equal(llm.requests.length, 3);
  });
});

// ─── validateEpicSet ────────────────────────────────────────────────────────

function makeEpic(
  id: string,
  storyIds: string[],
  deps: Record<string, string[]> = {}
): import('../types.js').EpicYaml {
  return {
    epic_id: id,
    title: 'A valid epic title for tests',
    status: 'planned',
    priority: 'must-have',
    prd_ref: 'x',
    requirements: ['FR-1'],
    stories: storyIds.map((sid) => ({
      id: sid,
      title: 'A valid story title',
      description: 'build the thing',
      acceptance_criteria: ['works'],
      estimated_complexity: 'small' as const,
      dependencies: deps[sid] ?? [],
    })),
  };
}

describe('validateEpicSet', () => {
  it('accepts a correctly-numbered set with sound dependencies', () => {
    const epics = [
      makeEpic('epic-001', ['story-001-001', 'story-001-002'], {
        'story-001-002': ['story-001-001'],
      }),
    ];
    assert.equal(validateEpicSet(epics, 1), null);
  });

  it('rejects epics not numbered from the start number', () => {
    const epics = [makeEpic('epic-001', ['story-001-001'])];
    const err = validateEpicSet(epics, 3);
    assert.ok(err);
    assert.ok(err.includes('must be "epic-003"'));
  });

  it('rejects a dependency that references a non-existent story', () => {
    const epics = [
      makeEpic('epic-001', ['story-001-001'], {
        'story-001-001': ['story-001-099'],
      }),
    ];
    const err = validateEpicSet(epics, 1);
    assert.ok(err);
    assert.ok(err.includes('story-001-099'));
  });

  it('rejects a story that depends on itself', () => {
    const epics = [
      makeEpic('epic-001', ['story-001-001'], {
        'story-001-001': ['story-001-001'],
      }),
    ];
    const err = validateEpicSet(epics, 1);
    assert.ok(err);
    assert.ok(err.includes('itself'));
  });

  it('accepts a cross-epic dependency within the same plan', () => {
    const epics = [
      makeEpic('epic-001', ['story-001-001']),
      makeEpic('epic-002', ['story-002-001'], {
        'story-002-001': ['story-001-001'],
      }),
    ];
    assert.equal(validateEpicSet(epics, 1), null);
  });

  it('rejects a direct dependency cycle', () => {
    const epics = [
      makeEpic('epic-001', ['story-001-001', 'story-001-002'], {
        'story-001-001': ['story-001-002'],
        'story-001-002': ['story-001-001'],
      }),
    ];
    const err = validateEpicSet(epics, 1);
    assert.ok(err);
    assert.ok(err.includes('cycle'));
  });

  it('rejects a longer dependency cycle', () => {
    const epics = [
      makeEpic('epic-001', ['story-001-001', 'story-001-002', 'story-001-003'], {
        'story-001-001': ['story-001-003'],
        'story-001-002': ['story-001-001'],
        'story-001-003': ['story-001-002'],
      }),
    ];
    const err = validateEpicSet(epics, 1);
    assert.ok(err);
    assert.ok(err.includes('cycle'));
  });

  it('accepts a deep acyclic dependency chain', () => {
    const epics = [
      makeEpic('epic-001', ['story-001-001', 'story-001-002', 'story-001-003'], {
        'story-001-002': ['story-001-001'],
        'story-001-003': ['story-001-002'],
      }),
    ];
    assert.equal(validateEpicSet(epics, 1), null);
  });
});

// ─── ArchitectAgent ─────────────────────────────────────────────────────────

describe('ArchitectAgent', () => {
  it('writes architecture.md and merges tech_notes into every story', async () => {
    const llm = new MockLLMClient(fullPipelineResponder);
    const pm = await new PMAgent(ctx(llm)).run(ANALYST_BRIEF, 1);
    const arch = await new ArchitectAgent(ctx(llm)).run(PM_PRD, pm.epics);

    assert.ok(fs.existsSync(arch.architecturePath));
    assert.equal(arch.storiesEnriched, 2);
    assert.equal(arch.storiesMissingNotes.length, 0);
    assert.ok(arch.epics[0].stories[0].tech_notes!.length > 0);
  });

  it('does not abort when tech_notes JSON is unparseable', async () => {
    const llm = new MockLLMClient((req) => {
      const last = req.messages[req.messages.length - 1].content;
      if (last.includes('architecture')) return ARCH_DOC;
      return 'this is not json'; // tech_notes call returns garbage
    });
    const pmLlm = new MockLLMClient(fullPipelineResponder);
    const pm = await new PMAgent(ctx(pmLlm)).run(ANALYST_BRIEF, 1);
    const arch = await new ArchitectAgent(ctx(llm)).run(PM_PRD, pm.epics);
    // architecture still written; stories simply carry no notes
    assert.ok(fs.existsSync(arch.architecturePath));
    assert.equal(arch.storiesEnriched, 0);
    assert.equal(arch.storiesMissingNotes.length, 2);
  });

  it('emits the shared contract only when ctx.sharedContract is on', async () => {
    const pmLlm = new MockLLMClient(fullPipelineResponder);
    const pm = await new PMAgent(ctx(pmLlm)).run(ANALYST_BRIEF, 1);

    // Off (default): Task C never runs, no contract returned.
    const off = await new ArchitectAgent(ctx(new MockLLMClient(fullPipelineResponder))).run(
      PM_PRD,
      pm.epics
    );
    assert.equal(off.sharedContract, undefined);

    // On: Task C runs and the contract document comes back.
    const on = await new ArchitectAgent({
      ...ctx(new MockLLMClient(fullPipelineResponder)),
      sharedContract: true,
    }).run(PM_PRD, pm.epics);
    assert.ok(on.sharedContract);
    assert.ok(on.sharedContract!.includes('createUser'));
    assert.ok(on.sharedContract!.includes('ownership map'));
  });

  it('does not abort the run when the shared-contract LLM call errors', async () => {
    const pmLlm = new MockLLMClient(fullPipelineResponder);
    const pm = await new PMAgent(ctx(pmLlm)).run(ANALYST_BRIEF, 1);

    // Tasks A and B succeed; Task C throws (e.g. rate limit / network).
    const llm = new MockLLMClient((req) => {
      const last = req.messages[req.messages.length - 1].content;
      if (last.includes('Headless task A: produce the architecture')) return ARCH_DOC;
      if (last.includes('Headless task B: produce per-story')) return archTechNotesJson(last);
      if (last.includes('Headless task C: produce the shared')) {
        throw new Error('provider rate limit');
      }
      throw new Error(`unexpected: ${last.slice(0, 60)}`);
    });

    const arch = await new ArchitectAgent({ ...ctx(llm), sharedContract: true }).run(
      PM_PRD,
      pm.epics
    );
    // The architecture + tech_notes from Tasks A/B are preserved; the contract
    // is simply absent (no file will be written by the Planner).
    assert.ok(fs.existsSync(arch.architecturePath));
    assert.equal(arch.storiesEnriched, 2);
    assert.ok(!arch.sharedContract);
  });
});

// ─── QAAgent ────────────────────────────────────────────────────────────────

describe('QAAgent', () => {
  async function plannedEpics() {
    const llm = new MockLLMClient(fullPipelineResponder);
    const pm = await new PMAgent(ctx(llm)).run(ANALYST_BRIEF, 1);
    const arch = await new ArchitectAgent(ctx(llm)).run(PM_PRD, pm.epics);
    return arch;
  }

  it('writes a test_plan onto every story and rewrites the epic YAML', async () => {
    const arch = await plannedEpics();
    const llm = new MockLLMClient(fullPipelineResponder);
    const qa = await new QAAgent(ctx(llm)).run(PM_PRD, arch.architectureContent, arch.epics);

    assert.equal(qa.storiesPlanned, 2);
    assert.equal(qa.storiesMissingPlan.length, 0);
    assert.ok(qa.epics[0].stories[0].test_plan!.includes('Test plan for story-001-001'));

    // Persisted to the epic YAML so the loaded story carries the plan at dispatch.
    const file = planningPaths(tmpDir, 'epic-001').epicFile('epic-001');
    const onDisk = EpicYamlSchema.parse(yaml.load(fs.readFileSync(file, 'utf8')));
    assert.ok(onDisk.stories[0].test_plan && onDisk.stories[0].test_plan.length > 0);
    assert.ok(onDisk.stories[1].test_plan && onDisk.stories[1].test_plan.length > 0);
  });

  it('soft-fails (no plans, no throw, YAML untouched) when the LLM call errors', async () => {
    const arch = await plannedEpics();
    const before = fs.readFileSync(planningPaths(tmpDir, 'epic-001').epicFile('epic-001'), 'utf8');

    const llm = new MockLLMClient(() => {
      throw new Error('provider rate limit');
    });
    const qa = await new QAAgent(ctx(llm)).run(PM_PRD, arch.architectureContent, arch.epics);

    assert.equal(qa.storiesPlanned, 0);
    assert.equal(qa.storiesMissingPlan.length, 2);
    assert.ok(qa.epics.every((e) => e.stories.every((s) => s.test_plan === undefined)));
    // The architect's YAML is left byte-for-byte intact on a soft failure.
    const after = fs.readFileSync(planningPaths(tmpDir, 'epic-001').epicFile('epic-001'), 'utf8');
    assert.equal(after, before);
  });

  it('soft-fails when the test_plan JSON is unparseable but still reports tokens', async () => {
    const arch = await plannedEpics();
    // The call SUCCEEDS (tokens consumed) but returns unparseable text. The
    // soft-fail path must still report usage so cost tracking isn't undercounted.
    const consumed: LLMUsage = {
      inputTokens: 1234,
      outputTokens: 56,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      requestCount: 1,
      costUsd: 0,
    };
    const llm: LLMClient = {
      async complete(req) {
        return { text: 'this is not json', usage: consumed, model: req.model, stopReason: 'end_turn' };
      },
    };
    const qa = await new QAAgent({
      projectRoot: tmpDir,
      llm,
      model: 'mock-model',
      runId: 'epic-001',
    }).run(PM_PRD, arch.architectureContent, arch.epics);

    assert.equal(qa.storiesPlanned, 0);
    assert.equal(qa.storiesMissingPlan.length, 2);
    assert.deepEqual(qa.usage, consumed, 'tokens from a parse-failing call must be reported');
  });
});

// ─── Planner ────────────────────────────────────────────────────────────────

describe('Planner', () => {
  it('runs the full pipeline and persists epics to the DB', async () => {
    const db = openDatabase(path.join(tmpDir, '.loom'));
    const llm = new MockLLMClient(fullPipelineResponder);
    const result = await new Planner({
      projectRoot: tmpDir,
      llm,
      model: 'mock-model',
      db,
    }).run('Build something worth planning.');

    assert.equal(result.runId, 'epic-001');
    assert.deepEqual(result.epicIds, ['epic-001']);
    assert.equal(result.storyCount, 2);
    assert.equal(result.storiesEnriched, 2);

    const epic = new EpicStore(db).get('epic-001');
    assert.ok(epic);
    assert.equal(epic.status, 'planned');
    assert.equal(epic.brief_path, '.loom/planning/epic-001/project-brief.md');
  });

  it('materializes .loom/contract/<epic-id>.md only when shared_contract is on', async () => {
    const db = openDatabase(path.join(tmpDir, '.loom'));
    await new Planner({
      projectRoot: tmpDir,
      llm: new MockLLMClient(fullPipelineResponder),
      model: 'm',
      db,
      sharedContract: true,
    }).run('Build something worth planning.');

    const contractPath = path.join(tmpDir, '.loom', 'contract', 'epic-001.md');
    assert.ok(fs.existsSync(contractPath), 'contract file should be written when on');
    assert.ok(fs.readFileSync(contractPath, 'utf8').includes('ownership map'));
  });

  it('writes no contract file when shared_contract is off (default)', async () => {
    const db = openDatabase(path.join(tmpDir, '.loom'));
    await new Planner({
      projectRoot: tmpDir,
      llm: new MockLLMClient(fullPipelineResponder),
      model: 'm',
      db,
    }).run('Build something worth planning.');
    assert.ok(!fs.existsSync(path.join(tmpDir, '.loom', 'contract', 'epic-001.md')));
  });

  it('enriches stories with a test_plan only when qa_planning is on', async () => {
    const db = openDatabase(path.join(tmpDir, '.loom'));
    await new Planner({
      projectRoot: tmpDir,
      llm: new MockLLMClient(fullPipelineResponder),
      model: 'm',
      db,
      qaPlanning: true,
    }).run('Build something worth planning.');

    const file = planningPaths(tmpDir, 'epic-001').epicFile('epic-001');
    const epic = EpicYamlSchema.parse(yaml.load(fs.readFileSync(file, 'utf8')));
    assert.ok(epic.stories.every((s) => s.test_plan && s.test_plan.length > 0));
  });

  it('writes no test_plan when qa_planning is off (default)', async () => {
    const db = openDatabase(path.join(tmpDir, '.loom'));
    await new Planner({
      projectRoot: tmpDir,
      llm: new MockLLMClient(fullPipelineResponder),
      model: 'm',
      db,
    }).run('Build something worth planning.');

    const file = planningPaths(tmpDir, 'epic-001').epicFile('epic-001');
    const epic = EpicYamlSchema.parse(yaml.load(fs.readFileSync(file, 'utf8')));
    assert.ok(epic.stories.every((s) => s.test_plan === undefined));
  });

  it('writes all four artifact files under the run directory', async () => {
    const db = openDatabase(path.join(tmpDir, '.loom'));
    const llm = new MockLLMClient(fullPipelineResponder);
    await new Planner({ projectRoot: tmpDir, llm, model: 'm', db }).run(
      'Build something worth planning.'
    );
    const runDir = path.join(tmpDir, '.loom', 'planning', 'epic-001');
    assert.ok(fs.existsSync(path.join(runDir, 'project-brief.md')));
    assert.ok(fs.existsSync(path.join(runDir, 'prd.md')));
    assert.ok(fs.existsSync(path.join(runDir, 'architecture.md')));
    assert.ok(fs.existsSync(path.join(runDir, 'epics', 'epic-001.yaml')));
  });

  it('numbers a second planning run after the first (no ID collision)', async () => {
    const db = openDatabase(path.join(tmpDir, '.loom'));
    const opts = { projectRoot: tmpDir, llm: new MockLLMClient(fullPipelineResponder), model: 'm', db };

    const run1 = await new Planner(opts).run('First feature to build.');
    assert.equal(run1.runId, 'epic-001');

    const run2 = await new Planner({
      ...opts,
      llm: new MockLLMClient(fullPipelineResponder),
    }).run('Second feature to build.');
    assert.equal(run2.runId, 'epic-002');
    assert.deepEqual(run2.epicIds, ['epic-002']);

    // Both runs persisted independently
    const epics = new EpicStore(db).list();
    assert.equal(epics.length, 2);
    // Second run's artifacts live in their own directory
    assert.ok(
      fs.existsSync(path.join(tmpDir, '.loom', 'planning', 'epic-002', 'prd.md'))
    );
  });

  it('caches the persona system block on every LLM call', async () => {
    const db = openDatabase(path.join(tmpDir, '.loom'));
    const llm = new MockLLMClient(fullPipelineResponder);
    await new Planner({ projectRoot: tmpDir, llm, model: 'm', db }).run(
      'Build something worth planning.'
    );
    assert.ok(llm.requests.length >= 5);
    assert.ok(llm.allCacheableBlocksMarked());
  });

  it('Planner.nextEpicId reflects existing epics', async () => {
    const db = openDatabase(path.join(tmpDir, '.loom'));
    assert.equal(Planner.nextEpicId(db), 'epic-001');
    new EpicStore(db).create('epic-001', 'An existing epic');
    assert.equal(Planner.nextEpicId(db), 'epic-002');
  });

  it('Planner.nextEpicId skips past an ARCHIVED highest-numbered epic (PR #55 P2)', async () => {
    // The bug pre-fix: nextEpicId used `list()` which excludes archived
    // rows, so the highest archived epic id would be re-used by the next
    // `loom epic` run — hitting the SQLite PRIMARY KEY UNIQUE constraint
    // because the row still exists. The fix calls `list({ includeArchived:
    // true })` so archived epics are counted in the max.
    const db = openDatabase(path.join(tmpDir, '.loom'));
    const store = new EpicStore(db);
    store.create('epic-001', 'first');
    store.create('epic-002', 'second');
    // Archive the highest-numbered one. The DEFAULT list() now hides it.
    store.archive('epic-002');
    assert.ok(!store.list().some((e) => e.id === 'epic-002'), 'archived row hidden by default');

    // nextEpicId must STILL return epic-003 — not epic-002 — even though
    // the default list view doesn't include epic-002.
    assert.equal(
      Planner.nextEpicId(db),
      'epic-003',
      'archived epics must be counted so a new run never reuses an id'
    );
  });

  it('writes planner token usage + wall time to each epic of the run', async () => {
    const db = openDatabase(path.join(tmpDir, '.loom'));
    const llm = new MockLLMClient(fullPipelineResponder);
    await new Planner({ projectRoot: tmpDir, llm, model: 'm', db }).run(
      'Build something cost-tracked.'
    );
    const epic = new EpicStore(db).list()[0];
    // The mock LLM emits zero-token usage, but the columns must be populated
    // (non-null) so cost tracking is real, not optional.
    assert.notEqual(epic.planner_tokens_input, null);
    assert.notEqual(epic.planner_tokens_output, null);
    assert.notEqual(epic.planner_tokens_cached, null);
    assert.notEqual(epic.planner_ms, null);
    assert.ok(typeof epic.planner_ms === 'number' && epic.planner_ms >= 0);
  });

  it('[AC3] populates planning_log_tail with phase markers after a full run', async () => {
    // MockLLMClient ignores onText (no streaming), but setPhase() writes markers
    // directly — so the tail always carries attribution markers even when the LLM
    // backend doesn't support streaming.
    const db = openDatabase(path.join(tmpDir, '.loom'));
    const llm = new MockLLMClient(fullPipelineResponder);
    await new Planner({ projectRoot: tmpDir, llm, model: 'm', db }).run(
      'Build something observable.'
    );

    const epic = new EpicStore(db).get('epic-001');
    assert.ok(epic, 'epic row must exist');
    assert.ok(
      typeof epic!.planning_log_tail === 'string',
      'planning_log_tail must be a string after a Planner run'
    );
    const tail = epic!.planning_log_tail!;
    // Each persona transition writes a marker — verify all three are present and ordered.
    assert.ok(tail.includes('\n── analyst ──\n'), 'analyst marker must appear in planning_log_tail');
    assert.ok(tail.includes('\n── pm ──\n'), 'pm marker must appear in planning_log_tail');
    assert.ok(tail.includes('\n── architect ──\n'), 'architect marker must appear in planning_log_tail');
    assert.ok(
      tail.indexOf('\n── analyst ──\n') < tail.indexOf('\n── pm ──\n'),
      'analyst marker must precede pm marker'
    );
    assert.ok(
      tail.indexOf('\n── pm ──\n') < tail.indexOf('\n── architect ──\n'),
      'pm marker must precede architect marker'
    );
  });

  it('[AC2] fires onPlanningEvent for each phase transition during a run', async () => {
    const db = openDatabase(path.join(tmpDir, '.loom'));
    const llm = new MockLLMClient(fullPipelineResponder);
    const events: PlanningEvent[] = [];

    await new Planner({
      projectRoot: tmpDir,
      llm,
      model: 'm',
      db,
      onPlanningEvent: (e) => events.push(e),
    }).run('Build something with events.');

    const phaseEvents = events.filter((e) => e.type === 'phase');
    assert.ok(phaseEvents.length >= 3, `at least 3 phase events expected; got ${phaseEvents.length}`);

    const phases = phaseEvents.map((e) => (e as Extract<PlanningEvent, { type: 'phase' }>).phase);
    assert.ok(phases.includes('analyst'), 'analyst phase event must fire');
    assert.ok(phases.includes('pm'), 'pm phase event must fire');
    assert.ok(phases.includes('architect'), 'architect phase event must fire');

    // Ordering: analyst fires before pm, pm fires before architect
    assert.ok(
      phases.indexOf('analyst') < phases.indexOf('pm'),
      'analyst phase must precede pm phase'
    );
    assert.ok(
      phases.indexOf('pm') < phases.indexOf('architect'),
      'pm phase must precede architect phase'
    );
  });
});
