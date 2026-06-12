import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDatabase, resetDatabaseForTest } from '../state/Database.js';
import { EvalRunStore } from '../state/EvalRunStore.js';
import { EvalRunner, evaluateChecks } from '../eval/EvalRunner.js';
import { loadEvalSuite } from '../eval/cases.js';
import { MockLLMClient } from '../llm/MockLLMClient.js';
import type { MockResponder } from '../llm/MockLLMClient.js';
import type { EvalCase } from '../eval/types.js';
import type { EpicYaml } from '../types.js';

let tmp: string;

beforeEach(() => {
  resetDatabaseForTest();
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'loom-eval-test-'));
});

afterEach(() => {
  resetDatabaseForTest();
  fs.rmSync(tmp, { recursive: true, force: true });
});

// A responder that drives the full planning pipeline for an eval case.
const planResponder: MockResponder = (req) => {
  const last = req.messages[req.messages.length - 1].content;
  if (last.includes('Produce the project brief')) return '# Brief\n\n## The Problem\nA gap.';
  if (last.includes('Headless task A: produce the PRD')) return '# PRD\n\n## Goals\nShip.';
  if (last.includes('Headless task B: produce the epic')) {
    const m = last.match(/starting at "(epic-\d+)"/);
    const eid = m ? m[1] : 'epic-001';
    const n = eid.slice(5);
    return (
      '```json\n' +
      JSON.stringify({
        epics: [
          {
            epic_id: eid,
            title: 'Eval pipeline epic title',
            priority: 'must-have',
            prd_ref: 'x',
            requirements: ['FR-1'],
            stories: [
              {
                id: `story-${n}-001`,
                title: 'First eval story',
                description: 'do it',
                acceptance_criteria: ['works'],
                estimated_complexity: 'small',
                dependencies: [],
              },
              {
                id: `story-${n}-002`,
                title: 'Second eval story',
                description: 'do it',
                acceptance_criteria: ['works'],
                estimated_complexity: 'small',
                dependencies: [`story-${n}-001`],
              },
            ],
          },
        ],
      }) +
      '\n```'
    );
  }
  if (last.includes('Headless task A: produce the architecture'))
    return '# Arch\n\n## Architecture Philosophy\nBoring.';
  if (last.includes('Headless task B: produce per-story')) return '```json\n{"tech_notes":{}}\n```';
  throw new Error('unexpected planning message');
};

function epic(epicId: string, storyIds: string[]): EpicYaml {
  return {
    epic_id: epicId,
    title: 'An epic for eval checks',
    status: 'planned',
    priority: 'must-have',
    prd_ref: 'x',
    requirements: ['FR-1'],
    stories: storyIds.map((id) => ({
      id,
      title: 'A story for eval checks',
      description: 'do it',
      acceptance_criteria: ['works'],
      estimated_complexity: 'small' as const,
      dependencies: [],
    })),
  };
}

// ─── loadEvalSuite ──────────────────────────────────────────────────────────

describe('loadEvalSuite', () => {
  it('loads the bundled planning suite with several cases', () => {
    const cases = loadEvalSuite('planning');
    assert.ok(cases.length >= 5);
    for (const c of cases) {
      assert.ok(c.id.length > 0);
      assert.ok(c.brief.length >= 10);
    }
  });

  it('throws for an unknown suite', () => {
    assert.throws(() => loadEvalSuite('does-not-exist'), /not found/);
  });
});

// ─── evaluateChecks ─────────────────────────────────────────────────────────

describe('evaluateChecks', () => {
  const caseFor = (expect: EvalCase['expect']): EvalCase => ({
    id: 'c1',
    description: 'd',
    brief: 'a brief long enough to pass',
    expect,
  });

  it('passes when epic and story counts are within bounds', () => {
    const checks = evaluateChecks(caseFor({ minEpics: 1, maxEpics: 1, minStories: 1, maxStories: 4 }), [
      epic('epic-001', ['story-001-001', 'story-001-002']),
    ]);
    assert.ok(checks.every((c) => c.passed));
  });

  it('fails the story-count check when there are too many stories', () => {
    const checks = evaluateChecks(caseFor({ maxStories: 1 }), [
      epic('epic-001', ['story-001-001', 'story-001-002']),
    ]);
    assert.equal(checks.find((c) => c.name === 'stories <= max')?.passed, false);
  });

  it('runs the dependency-soundness check', () => {
    const checks = evaluateChecks(caseFor({ dependenciesValid: true }), [
      epic('epic-001', ['story-001-001']),
    ]);
    assert.equal(checks.find((c) => c.name === 'dependencies_valid')?.passed, true);
  });
});

// ─── EvalRunner ─────────────────────────────────────────────────────────────

describe('EvalRunner', () => {
  it('runs a case through the planner and scores it', async () => {
    const runner = new EvalRunner({ llm: new MockLLMClient(planResponder), model: 'mock' });
    const report = await runner.run('planning', [
      {
        id: 'demo',
        description: 'a demo case',
        brief: 'Build a small demo feature for the eval runner test.',
        expect: { minEpics: 1, maxEpics: 1, minStories: 2, maxStories: 4, dependenciesValid: true },
      },
    ]);
    assert.equal(report.total, 1);
    assert.equal(report.passed, 1);
    assert.equal(report.score, 1);
  });

  it('marks a case failed when expectations are not met', async () => {
    const runner = new EvalRunner({ llm: new MockLLMClient(planResponder), model: 'mock' });
    const report = await runner.run('planning', [
      {
        id: 'too-strict',
        description: 'expects more epics than the planner makes',
        brief: 'Build a small demo feature that the planner under-delivers on.',
        expect: { minEpics: 3 },
      },
    ]);
    assert.equal(report.passed, 0);
    assert.equal(report.cases[0].passed, false);
  });

  it('does not touch the app database — eval planner runs are isolated', async () => {
    const appDb = openDatabase(path.join(tmp, '.loom'));
    const runner = new EvalRunner({ llm: new MockLLMClient(planResponder), model: 'mock' });
    await runner.run('planning', [
      {
        id: 'iso',
        description: 'isolation check',
        brief: 'Build a small demo feature to verify eval isolation.',
        expect: { minEpics: 1 },
      },
    ]);
    // The eval ran a full planner, but the app DB has no epics.
    const epics = appDb.prepare('SELECT COUNT(*) AS c FROM epics').get() as { c: number };
    assert.equal(epics.c, 0);
  });
});

// ─── EvalRunStore — drift detection ─────────────────────────────────────────

describe('EvalRunStore', () => {
  it('records a run and computes its score', () => {
    const store = new EvalRunStore(openDatabase(path.join(tmp, '.loom')));
    const record = store.record('planning', 4, 5);
    assert.equal(record.passed, 4);
    assert.equal(record.total, 5);
    assert.equal(record.score, 0.8);
  });

  it('returns the previous run for drift comparison', () => {
    const store = new EvalRunStore(openDatabase(path.join(tmp, '.loom')));
    store.record('planning', 5, 5);
    const latest = store.record('planning', 3, 5);
    const prev = store.previous('planning', latest.id);
    assert.ok(prev);
    assert.equal(prev.score, 1);
  });

  it('keeps a per-suite history', () => {
    const store = new EvalRunStore(openDatabase(path.join(tmp, '.loom')));
    store.record('planning', 1, 5);
    store.record('planning', 2, 5);
    assert.equal(store.history('planning').length, 2);
  });
});
