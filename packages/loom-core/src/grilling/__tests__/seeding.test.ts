import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { seedDecisionTree } from '../seeding.js';
import type { BriefRefinement } from '../../brief/types.js';

// ── helpers ────────────────────────────────────────────────────────────────────

function makeRefinement(overrides: Partial<{
  blocking_gaps: string[];
  flagged_assumptions: string[];
  questions: string[];
}>): BriefRefinement {
  return {
    ready: false,
    original: 'test brief',
    quality_score: 5,
    blocking_gaps: overrides.blocking_gaps ?? [],
    questions: overrides.questions ?? [],
    critique: {
      strong_points: [],
      ambiguities: [],
      missing_scope: [],
      untestable_claims: [],
      hidden_complexity: [],
    },
    delta: {
      added_sections: [],
      clarifications: [],
      flagged_assumptions: overrides.flagged_assumptions ?? [],
    },
  };
}

// ── happy path ────────────────────────────────────────────────────────────────

describe('seedDecisionTree — happy path', () => {
  it('assigns blast_radius high to blocking_gaps', () => {
    const input = makeRefinement({ blocking_gaps: ['Must define auth model'] });
    const result = seedDecisionTree(input);
    const gap = result.find(d => d.id === 'gap-0');
    assert.ok(gap, 'gap-0 should be present');
    assert.equal(gap.blast_radius, 'high');
  });

  it('assigns blast_radius low to flagged_assumptions', () => {
    const input = makeRefinement({ flagged_assumptions: ['Users have email addresses'] });
    const result = seedDecisionTree(input);
    const assumption = result.find(d => d.id === 'assumption-0');
    assert.ok(assumption, 'assumption-0 should be present');
    assert.equal(assumption.blast_radius, 'low');
  });

  it('assigns blast_radius low to questions not referencing any gap id', () => {
    const input = makeRefinement({ questions: ['What is the expected latency?'] });
    const result = seedDecisionTree(input);
    const question = result.find(d => d.id === 'question-0');
    assert.ok(question, 'question-0 should be present');
    assert.equal(question.blast_radius, 'low');
    assert.deepEqual(question.prerequisites, []);
  });

  it('all three fields produce all three categories', () => {
    const input = makeRefinement({
      blocking_gaps: ['Gap A'],
      flagged_assumptions: ['Assumption B'],
      questions: ['Question C'],
    });
    const result = seedDecisionTree(input);
    assert.equal(result.length, 3);
    assert.ok(result.some(d => d.id === 'gap-0'));
    assert.ok(result.some(d => d.id === 'assumption-0'));
    assert.ok(result.some(d => d.id === 'question-0'));
  });
});

// ── gap-referencing question ───────────────────────────────────────────────────

describe('seedDecisionTree — gap-referencing question', () => {
  it('assigns blast_radius high when question text contains a gap id', () => {
    const input = makeRefinement({
      blocking_gaps: ['Define the auth model'],
      questions: ['Please clarify gap-0 before we proceed'],
    });
    const result = seedDecisionTree(input);
    const question = result.find(d => d.id === 'question-0');
    assert.ok(question);
    assert.equal(question.blast_radius, 'high');
    assert.deepEqual(question.prerequisites, ['gap-0']);
  });

  it('assigns blast_radius low when question text does not contain a gap id', () => {
    const input = makeRefinement({
      blocking_gaps: ['Define the auth model'],
      questions: ['What latency is acceptable?'],
    });
    const result = seedDecisionTree(input);
    const question = result.find(d => d.id === 'question-0');
    assert.ok(question);
    assert.equal(question.blast_radius, 'low');
    assert.deepEqual(question.prerequisites, []);
  });

  it('does not treat gap-1 as a substring match inside gap-10', () => {
    const input = makeRefinement({
      blocking_gaps: Array.from({ length: 11 }, (_, i) => `Gap ${i}`), // gap-0 … gap-10
      questions: ['Referencing gap-10 only'],
    });
    const result = seedDecisionTree(input);
    const question = result.find(d => d.id === 'question-0');
    assert.ok(question);
    assert.deepEqual(question.prerequisites, ['gap-10'], 'gap-1 must NOT be included as a prerequisite');
    assert.equal(question.blast_radius, 'high');
  });

  it('collects multiple gap references from a single question', () => {
    const input = makeRefinement({
      blocking_gaps: ['Define auth', 'Define data model'],
      questions: ['gap-0 and gap-1 need resolution'],
    });
    const result = seedDecisionTree(input);
    const question = result.find(d => d.id === 'question-0');
    assert.ok(question);
    assert.equal(question.blast_radius, 'high');
    assert.deepEqual(question.prerequisites.sort(), ['gap-0', 'gap-1'].sort());
  });
});

// ── topological ordering ──────────────────────────────────────────────────────

describe('seedDecisionTree — topological ordering', () => {
  it('prerequisites appear before their dependents in the output array', () => {
    const input = makeRefinement({
      blocking_gaps: ['Define scope'],
      questions: ['Clarify gap-0 timeline'],
    });
    const result = seedDecisionTree(input);
    const gapIndex = result.findIndex(d => d.id === 'gap-0');
    const questionIndex = result.findIndex(d => d.id === 'question-0');
    assert.ok(gapIndex !== -1, 'gap-0 should be present');
    assert.ok(questionIndex !== -1, 'question-0 should be present');
    assert.ok(gapIndex < questionIndex, 'gap-0 must precede question-0');
  });

  it('independent nodes all precede their dependents', () => {
    const input = makeRefinement({
      blocking_gaps: ['Gap A', 'Gap B'],
      questions: ['Referencing gap-0', 'Referencing gap-1'],
    });
    const result = seedDecisionTree(input);
    for (const d of result) {
      const dIndex = result.findIndex(x => x.id === d.id);
      for (const prereqId of d.prerequisites) {
        const prereqIndex = result.findIndex(x => x.id === prereqId);
        assert.ok(prereqIndex < dIndex, `${prereqId} must appear before ${d.id}`);
      }
    }
  });
});

// ── edge cases ────────────────────────────────────────────────────────────────

describe('seedDecisionTree — edge cases', () => {
  it('returns [] for empty input', () => {
    const result = seedDecisionTree(makeRefinement({}));
    assert.deepEqual(result, []);
  });

  it('only blocking_gaps → all decisions are blast_radius high', () => {
    const input = makeRefinement({ blocking_gaps: ['Gap 1', 'Gap 2', 'Gap 3'] });
    const result = seedDecisionTree(input);
    assert.equal(result.length, 3);
    for (const d of result) {
      assert.equal(d.blast_radius, 'high', `expected high for ${d.id}`);
    }
  });

  it('only flagged_assumptions → all decisions are blast_radius low', () => {
    const input = makeRefinement({ flagged_assumptions: ['A1', 'A2'] });
    const result = seedDecisionTree(input);
    assert.equal(result.length, 2);
    for (const d of result) {
      assert.equal(d.blast_radius, 'low', `expected low for ${d.id}`);
    }
  });
});

// ── determinism ───────────────────────────────────────────────────────────────

describe('seedDecisionTree — determinism', () => {
  it('identical input produces identical output across two calls', () => {
    const input = makeRefinement({
      blocking_gaps: ['Gap A', 'Gap B'],
      flagged_assumptions: ['Assume X'],
      questions: ['gap-0 needs clarity', 'What about latency?'],
    });
    const result1 = seedDecisionTree(input);
    const result2 = seedDecisionTree(input);
    assert.equal(JSON.stringify(result1), JSON.stringify(result2));
  });
});

// ── unique ids ────────────────────────────────────────────────────────────────

describe('seedDecisionTree — unique ids', () => {
  it('all returned ids are distinct across gap/assumption/question namespaces', () => {
    const input = makeRefinement({
      blocking_gaps: ['G0', 'G1'],
      flagged_assumptions: ['A0', 'A1'],
      questions: ['Q0', 'Q1'],
    });
    const result = seedDecisionTree(input);
    const ids = result.map(d => d.id);
    const uniqueIds = new Set(ids);
    assert.equal(uniqueIds.size, ids.length, 'all ids must be unique');
  });
});

// ── structural requirements ───────────────────────────────────────────────────

describe('seedDecisionTree — structural requirements', () => {
  it('every decision has non-empty text', () => {
    const input = makeRefinement({
      blocking_gaps: ['Has text'],
      flagged_assumptions: ['Also has text'],
      questions: ['And this too'],
    });
    const result = seedDecisionTree(input);
    for (const d of result) {
      assert.ok(d.text.length > 0, `${d.id} must have non-empty text`);
    }
  });

  it('every decision has non-empty recommendation', () => {
    const input = makeRefinement({
      blocking_gaps: ['Has text'],
      flagged_assumptions: ['Also has text'],
      questions: ['And this too'],
    });
    const result = seedDecisionTree(input);
    for (const d of result) {
      assert.ok(d.recommendation.length > 0, `${d.id} must have non-empty recommendation`);
    }
  });

  it('every decision has at least two alternatives', () => {
    const input = makeRefinement({
      blocking_gaps: ['Has text'],
      flagged_assumptions: ['Also has text'],
      questions: ['And this too'],
    });
    const result = seedDecisionTree(input);
    for (const d of result) {
      assert.ok(d.alternatives.length >= 2, `${d.id} must have at least two alternatives`);
    }
  });
});

// ── no LLM or TTY imports ─────────────────────────────────────────────────────

describe('seedDecisionTree — isolation', () => {
  it('seeding.ts source imports no LLM or readline symbols', async () => {
    const fs = await import('node:fs');
    const path = await import('node:path');
    // Read the TypeScript source (build-independent: no stale-artifact false-positive).
    // __dirname for the compiled test is dist/grilling/__tests__; source is 3 levels up in src/.
    const seedingPath = path.join(__dirname, '..', '..', '..', 'src', 'grilling', 'seeding.ts');
    const content = fs.readFileSync(seedingPath, 'utf8');
    assert.ok(!content.includes('LLMClient'), 'must not import LLMClient');
    assert.ok(!content.includes('readline'), 'must not import readline');
    assert.ok(!content.includes('process.stdin'), 'must not reference process.stdin');
    assert.ok(!content.includes('process.stdout'), 'must not reference process.stdout');
  });
});
