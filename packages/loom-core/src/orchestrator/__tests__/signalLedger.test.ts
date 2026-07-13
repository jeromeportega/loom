import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { computeHeuristics, buildStorySignals } from '../signalLedger.js';
import { resolveCostTier, tierSteps } from '../tier.js';
import type { HeuristicSignals } from '../../types.js';

// ------------------------------------------------------------------
// Temp git repo helpers
// ------------------------------------------------------------------

function makeTempRepo(): { dir: string; baseSha: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'loom-signals-'));
  const git = (args: string[]) =>
    execFileSync('git', args, { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  git(['init']);
  git(['config', 'user.email', 'test@loom.test']);
  git(['config', 'user.name', 'Loom Test']);
  writeFileSync(join(dir, 'README.md'), 'base\n');
  git(['add', '.']);
  git(['commit', '-m', 'initial']);
  const baseSha = git(['rev-parse', 'HEAD']).trim();
  return { dir, baseSha, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

function addCommit(dir: string, files: Record<string, string | Buffer>): void {
  const git = (args: string[]) =>
    execFileSync('git', args, { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  for (const [name, content] of Object.entries(files)) {
    const fullPath = join(dir, name);
    mkdirSync(dirname(fullPath), { recursive: true });
    writeFileSync(fullPath, content);
  }
  git(['add', '.']);
  git(['commit', '-m', 'changes']);
}

// ------------------------------------------------------------------
// computeHeuristics — diff counts
// ------------------------------------------------------------------

describe('computeHeuristics – diff counts', () => {
  it('diff_lines = sum(added+deleted), diff_files = count of changed files', () => {
    const { dir, baseSha, cleanup } = makeTempRepo();
    try {
      addCommit(dir, { 'a.ts': 'line1\nline2\nline3\n', 'b.ts': 'hello\n' });
      const result = computeHeuristics({ worktreePath: dir, baseSha,  testsGreenFirstTry: null });
      assert.equal(result.diff_files, 2);
      assert.equal(result.diff_lines, 4); // 3 added in a.ts, 1 added in b.ts
    } finally {
      cleanup();
    }
  });

  it('counts both added and deleted lines from a modified existing file', () => {
    const { dir, baseSha, cleanup } = makeTempRepo();
    try {
      // README.md exists at baseSha with 1 line; replace with 3 lines → 3 added, 1 deleted
      addCommit(dir, { 'README.md': 'line1\nline2\nline3\n' });
      const result = computeHeuristics({ worktreePath: dir, baseSha,  testsGreenFirstTry: null });
      assert.equal(result.diff_files, 1);
      assert.equal(result.diff_lines, 4); // 3 added + 1 deleted
    } finally {
      cleanup();
    }
  });

  it('empty diff → diff_lines=0, diff_files=0, no crash', () => {
    const { dir, baseSha, cleanup } = makeTempRepo();
    try {
      const result = computeHeuristics({ worktreePath: dir, baseSha,  testsGreenFirstTry: null });
      assert.equal(result.diff_lines, 0);
      assert.equal(result.diff_files, 0);
    } finally {
      cleanup();
    }
  });

  it('binary file rows (-\\t-\\t<file>) contribute 0 lines but count in diff_files', () => {
    const { dir, baseSha, cleanup } = makeTempRepo();
    try {
      // Null bytes in content force git to treat the file as binary
      const binary = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00]);
      addCommit(dir, { 'image.png': binary });
      const result = computeHeuristics({ worktreePath: dir, baseSha,  testsGreenFirstTry: null });
      assert.equal(result.diff_files, 1);
      assert.equal(result.diff_lines, 0); // binary rows show as "-\t-\t" — not NaN-summed
    } finally {
      cleanup();
    }
  });
});

// ------------------------------------------------------------------
// computeHeuristics — tests_green_first_try passthrough
// ------------------------------------------------------------------

describe('computeHeuristics – tests_green_first_try', () => {
  it('null is passed through — the release behavior (ADR-3, no first-try source)', () => {
    const { dir, baseSha, cleanup } = makeTempRepo();
    try {
      const result = computeHeuristics({ worktreePath: dir, baseSha,  testsGreenFirstTry: null });
      assert.equal(result.tests_green_first_try, null);
    } finally {
      cleanup();
    }
  });

  it('true passes through HeuristicInput to the field', () => {
    const { dir, baseSha, cleanup } = makeTempRepo();
    try {
      const result = computeHeuristics({ worktreePath: dir, baseSha,  testsGreenFirstTry: true });
      assert.equal(result.tests_green_first_try, true);
    } finally {
      cleanup();
    }
  });

  it('false passes through HeuristicInput to the field', () => {
    const { dir, baseSha, cleanup } = makeTempRepo();
    try {
      const result = computeHeuristics({ worktreePath: dir, baseSha,  testsGreenFirstTry: false });
      assert.equal(result.tests_green_first_try, false);
    } finally {
      cleanup();
    }
  });
});

// ------------------------------------------------------------------
// buildStorySignals — tier and steps equal live resolveCostTier/tierSteps
// ------------------------------------------------------------------

const CLEAN_HEURISTICS: HeuristicSignals = {
  diff_lines: 50,
  diff_files: 2,
  tests_green_first_try: null,
};

const TIER_CASES: Array<{
  label: string;
  heuristics: HeuristicSignals;
  opts?: Parameters<typeof buildStorySignals>[1];
}> = [
  { label: 'no self-assessment → heavy (fail-safe)', heuristics: CLEAN_HEURISTICS },
  {
    label: 'first-try test failure → heavy',
    heuristics: { ...CLEAN_HEURISTICS, tests_green_first_try: false },
  },
  {
    label: 'large diff → heavy',
    heuristics: { ...CLEAN_HEURISTICS, diff_lines: 500 },
  },
  {
    label: 'all-positive signals → light',
    heuristics: { diff_lines: 20, diff_files: 2, tests_green_first_try: true },
    opts: {
      triage: { risk: 'low', predicted_complexity: 'low', rationale: 'trivial' },
      selfAssessment: { confidence: 'high', complexity: 'low' },
    },
  },
  {
    label: 'medium confidence → standard',
    heuristics: { diff_lines: 100, diff_files: 5, tests_green_first_try: null },
    opts: { selfAssessment: { confidence: 'medium', complexity: 'medium' } },
  },
];

describe('buildStorySignals – tier equals resolveCostTier for same inputs (FR-2)', () => {
  for (const { label, heuristics, opts } of TIER_CASES) {
    it(`tier: ${label}`, () => {
      const signals = buildStorySignals(heuristics, opts);
      const expected = resolveCostTier({
        triage: opts?.triage,
        selfAssessment: opts?.selfAssessment,
        heuristics,
      });
      assert.equal(signals.tier, expected);
    });

    it(`steps: ${label}`, () => {
      const signals = buildStorySignals(heuristics, opts);
      const tier = resolveCostTier({
        triage: opts?.triage,
        selfAssessment: opts?.selfAssessment,
        heuristics,
      });
      const raw = tierSteps(tier);
      assert.equal(signals.steps.reviewers, raw.reviewers);
      assert.equal(signals.steps.verify_phase, raw.verifyPhase);
      assert.equal(signals.steps.skill_gen, raw.skillGen);
    });
  }
});

// ------------------------------------------------------------------
// buildStorySignals — camelCase → snake_case mapping (ADR-5)
// ------------------------------------------------------------------

describe('buildStorySignals – snake_case steps mapping (ADR-5)', () => {
  it('steps carries verify_phase and skill_gen — not verifyPhase or skillGen', () => {
    const signals = buildStorySignals(CLEAN_HEURISTICS);
    const steps = signals.steps as Record<string, unknown>;
    assert.ok('verify_phase' in steps, 'verify_phase key must exist');
    assert.ok('skill_gen' in steps, 'skill_gen key must exist');
    assert.ok(!('verifyPhase' in steps), 'verifyPhase must NOT exist — rename only in buildStorySignals');
    assert.ok(!('skillGen' in steps), 'skillGen must NOT exist — rename only in buildStorySignals');
  });

  it('standard tier: verify_phase=true, skill_gen=true', () => {
    const heuristics: HeuristicSignals = {
      diff_lines: 100,
      diff_files: 5,
      tests_green_first_try: null,
    };
    const signals = buildStorySignals(heuristics, {
      selfAssessment: { confidence: 'medium', complexity: 'medium' },
    });
    assert.equal(signals.tier, 'standard');
    assert.equal(signals.steps.verify_phase, true);
    assert.equal(signals.steps.skill_gen, true);
  });

  it('light tier: verify_phase=false, skill_gen=false', () => {
    const heuristics: HeuristicSignals = {
      diff_lines: 20,
      diff_files: 2,
      tests_green_first_try: true,
    };
    const signals = buildStorySignals(heuristics, {
      triage: { risk: 'low', predicted_complexity: 'low', rationale: 'trivial' },
      selfAssessment: { confidence: 'high', complexity: 'low' },
    });
    assert.equal(signals.tier, 'light');
    assert.equal(signals.steps.verify_phase, false);
    assert.equal(signals.steps.skill_gen, false);
  });

  it('heavy tier: reviewers=3, verify_phase=true, skill_gen=true', () => {
    const signals = buildStorySignals(CLEAN_HEURISTICS);
    assert.equal(signals.tier, 'heavy');
    assert.equal(signals.steps.reviewers, 3);
    assert.equal(signals.steps.verify_phase, true);
    assert.equal(signals.steps.skill_gen, true);
  });
});

// ------------------------------------------------------------------
// buildStorySignals — heavy bias when self_assessment absent
// ------------------------------------------------------------------

describe('buildStorySignals – heavy bias (expected measurement, not a bug)', () => {
  it('absent self_assessment → confidence=low → tier=heavy', () => {
    const signals = buildStorySignals(CLEAN_HEURISTICS);
    assert.equal(signals.tier, 'heavy');
  });

  it('small diff + null tests but no self_assessment still resolves heavy', () => {
    const heuristics: HeuristicSignals = {
      diff_lines: 5,
      diff_files: 1,
      tests_green_first_try: null,
    };
    assert.equal(buildStorySignals(heuristics).tier, 'heavy');
  });

  it('tests_green_first_try=null with high-confidence self_assessment is standard (pins under-confidence)', () => {
    const heuristics: HeuristicSignals = {
      diff_lines: 20,
      diff_files: 2,
      tests_green_first_try: null, // unknown → not light
    };
    const signals = buildStorySignals(heuristics, {
      triage: { risk: 'low', predicted_complexity: 'low', rationale: 'x' },
      selfAssessment: { confidence: 'high', complexity: 'low' },
    });
    assert.equal(signals.tier, 'standard'); // not light because tests unknown
  });
});

// ------------------------------------------------------------------
// adaptive_cost independence
// ------------------------------------------------------------------

describe('computeHeuristics and buildStorySignals – adaptive_cost independence', () => {
  it('buildStorySignals produces identical output regardless of any external policy knob', () => {
    // Neither function accepts a policy parameter — adaptive_cost is never read.
    // Verify by calling twice with identical inputs and asserting deep equality.
    const s1 = buildStorySignals(CLEAN_HEURISTICS);
    const s2 = buildStorySignals(CLEAN_HEURISTICS);
    assert.deepEqual(s1, s2);
  });

  it('computeHeuristics takes no policy parameter — adaptive_cost cannot influence output', () => {
    const { dir, baseSha, cleanup } = makeTempRepo();
    try {
      addCommit(dir, { 'src/a.ts': 'x\n' });
      const r1 = computeHeuristics({ worktreePath: dir, baseSha,  testsGreenFirstTry: null });
      const r2 = computeHeuristics({ worktreePath: dir, baseSha,  testsGreenFirstTry: null });
      assert.deepEqual(r1, r2);
    } finally {
      cleanup();
    }
  });
});
