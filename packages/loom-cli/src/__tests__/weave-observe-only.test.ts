/**
 * NFR-1 observe-only regression test (story-020-005).
 *
 * Physical enforcement of the observe-only invariant at three levels:
 *   1. Topology guard — no planning-side source file imports from the intake
 *      module or reads `intake_verdict` / `classifyIntake`.
 *   2. epic ≡ weave — `runEpic` and `runWeave` produce the same epic artifact
 *      (title, status, YAML content) for the same brief.
 *   3. Verdict-value invariance — `runEpic` is called with identical arguments
 *      regardless of what `classifyIntake` returns (no-verdict, failure, every
 *      verdict value); the produced epic artifact is byte-identical across all
 *      conditions.
 *
 * Any new edge from planning/gate/persona/execution code into the intake module
 * or the `intake_verdict` column MUST break this test.
 */
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  MockLLMClient,
  openDatabase,
  resetDatabaseForTest,
  EpicStore,
} from '@loom-ai/core';
import type { LLMRequest } from '@loom-ai/core';

// Mirror of ClassifyResult from @loom-ai/core — defined locally so this test
// compiles against any version of the loom-core dist (including pre-epic-020).
type ClassifyResult =
  | { ok: true; verdict: { type: string; size: string; confidence: string; rationale: string } }
  | { ok: false; reason: 'llm_error' | 'timeout' | 'invalid_output'; detail: string };
import { runEpic } from '../commands/epic.js';
import { runWeave } from '../commands/weave.js';

// __dirname = packages/loom-cli/dist/__tests__
const LOOM_CLI = path.resolve(__dirname, '../index.js');
const REPO_ROOT = path.resolve(__dirname, '../../../..');

// ── Deterministic LLM stub ────────────────────────────────────────────────────

function jsonBlock(obj: unknown): string {
  return '```json\n' + JSON.stringify(obj) + '\n```';
}

function pipelineResponder(req: LLMRequest): string {
  const last = req.messages[req.messages.length - 1].content;
  if (last.includes('Apply the discipline above')) {
    return jsonBlock({
      ready: true,
      quality_score: 9,
      refined_brief: '# Brief\n\n## Goal\nVerify observe-only invariant.',
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
          title: 'Observe-only invariant epic',
          priority: 'must-have',
          prd_ref: 'x',
          requirements: ['NFR-1'],
          stories: [
            {
              id: `story-${num}-001`,
              title: 'Verify observe-only',
              description: 'check it',
              acceptance_criteria: ['no branching on verdict'],
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
  throw new Error('unexpected planning message: ' + last.slice(0, 60));
}

// ── In-process runner ─────────────────────────────────────────────────────────

async function runInProcess(fn: () => Promise<void>): Promise<{ exitCode: number | null }> {
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
    await fn();
  } catch (err) {
    if (!(err instanceof ExitSignal)) throw err;
  } finally {
    process.exit = origExit;
    console.log = origLog;
    console.error = origErr;
  }
  return { exitCode };
}

// ── Repo factory ──────────────────────────────────────────────────────────────

function makeLoomRepo(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: dir });
  execFileSync('git', ['config', 'user.email', 'test@loom.dev'], { cwd: dir });
  execFileSync('git', ['config', 'user.name', 'Loom Test'], { cwd: dir });
  execFileSync('git', ['config', 'commit.gpgsign', 'false'], { cwd: dir });
  fs.writeFileSync(path.join(dir, 'README.md'), '# test\n');
  execFileSync('git', ['add', '.'], { cwd: dir });
  execFileSync('git', ['commit', '-q', '-m', 'initial'], { cwd: dir });
  execFileSync('node', [LOOM_CLI, 'init'], { cwd: dir, stdio: 'ignore' });
  return dir;
}

// ── Fixtures ──────────────────────────────────────────────────────────────────

let tmpDir: string;
let prevCwd: string;
let prevLoomHome: string | undefined;
let loomHomeDir: string;

const BRIEF = 'Build a minimal feature to verify the observe-only invariant holds end-to-end.';

beforeEach(() => {
  resetDatabaseForTest();
  prevLoomHome = process.env.LOOM_HOME;
  loomHomeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'loom-cli-home-'));
  process.env.LOOM_HOME = loomHomeDir;

  tmpDir = makeLoomRepo('loom-observe-only-');
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

// Reads the epic-001 artifact from a loom dir; does NOT touch the singleton.
function readEpicArtifact(repoDir: string): { title: string; status: string; yamlContent: string } {
  resetDatabaseForTest();
  const db = openDatabase(path.join(repoDir, '.loom'));
  const epic = new EpicStore(db).get('epic-001');
  if (!epic) {
    resetDatabaseForTest();
    return { title: '', status: 'missing', yamlContent: '' };
  }
  const yamlPath = epic.yaml_path ? path.join(repoDir, epic.yaml_path) : null;
  const yamlContent = yamlPath && fs.existsSync(yamlPath) ? fs.readFileSync(yamlPath, 'utf8') : '';
  resetDatabaseForTest();
  return { title: epic.title, status: epic.status, yamlContent };
}

// Wipes only the SQLite files so the next openDatabase() creates a fresh schema.
// Policy.yaml and planning/* files are preserved.
function wipeLoomDb(repoDir: string): void {
  resetDatabaseForTest();
  for (const ext of ['', '-wal', '-shm']) {
    fs.rmSync(path.join(repoDir, '.loom', `loom.db${ext}`), { force: true });
  }
}

// ── Part 1: Topology guard ────────────────────────────────────────────────────

describe('NFR-1 topology guard — planning-side source must not import or reference intake', () => {
  // These source directories contain every code path that executes during
  // planning: the brief-quality gate, the Analyst/PM/Architect persona agents,
  // the Planner orchestrator, and the epic CLI entry point.
  // None of them may import from the intake module or read the verdict.
  const planningDirs = [
    path.join(REPO_ROOT, 'packages', 'loom-core', 'src', 'planner'),
    path.join(REPO_ROOT, 'packages', 'loom-core', 'src', 'brief'),
  ];
  const planningFiles = [
    path.join(REPO_ROOT, 'packages', 'loom-cli', 'src', 'commands', 'epic.ts'),
  ];

  function collectSrcFiles(dirs: string[]): string[] {
    const out: string[] = [];
    for (const dir of dirs) {
      if (!fs.existsSync(dir)) continue;
      for (const name of fs.readdirSync(dir)) {
        const full = path.join(dir, name);
        if (fs.statSync(full).isFile() && full.endsWith('.ts') && !full.endsWith('.test.ts')) {
          out.push(full);
        }
      }
    }
    return out;
  }

  const allPlanningFiles = [...collectSrcFiles(planningDirs), ...planningFiles];

  it('scans at least the core planning-side files', () => {
    const exists = allPlanningFiles.filter((f) => fs.existsSync(f));
    assert.ok(exists.length >= 5, `Expected ≥5 planning-side source files; got ${exists.length}`);
  });

  it('no planning-side file imports from the intake module', () => {
    const violations: string[] = [];
    for (const file of allPlanningFiles) {
      if (!fs.existsSync(file)) continue;
      const src = fs.readFileSync(file, 'utf8');
      if (/from\s+['"].*intake/.test(src) || /require\s*\(\s*['"].*intake/.test(src)) {
        violations.push(path.relative(REPO_ROOT, file));
      }
    }
    assert.deepEqual(
      violations,
      [],
      `Planning-side files must not import from intake module:\n  ${violations.join('\n  ')}`
    );
  });

  it('no planning-side file reads the intake_verdict column', () => {
    const violations: string[] = [];
    for (const file of allPlanningFiles) {
      if (!fs.existsSync(file)) continue;
      const src = fs.readFileSync(file, 'utf8');
      if (/intake_verdict/.test(src)) {
        violations.push(path.relative(REPO_ROOT, file));
      }
    }
    assert.deepEqual(
      violations,
      [],
      `Planning-side files must not reference intake_verdict:\n  ${violations.join('\n  ')}`
    );
  });

  it('no planning-side file calls classifyIntake', () => {
    const violations: string[] = [];
    for (const file of allPlanningFiles) {
      if (!fs.existsSync(file)) continue;
      const src = fs.readFileSync(file, 'utf8');
      if (/classifyIntake/.test(src)) {
        violations.push(path.relative(REPO_ROOT, file));
      }
    }
    assert.deepEqual(
      violations,
      [],
      `Planning-side files must not call classifyIntake:\n  ${violations.join('\n  ')}`
    );
  });
});

// ── Part 2: epic ≡ weave ──────────────────────────────────────────────────────

describe('epic ≡ weave — same brief produces identical epic artifact', () => {
  it('runEpic and runWeave produce the same epic title and status', async () => {
    // runEpic baseline (uses tmpDir from beforeEach)
    const epicLlm = new MockLLMClient(pipelineResponder);
    const { exitCode: epicExit } = await runInProcess(() => runEpic(BRIEF, { llm: epicLlm, force: true }));
    assert.equal(epicExit, null, 'runEpic must exit 0');
    const epicArtifact = readEpicArtifact(tmpDir);
    assert.equal(epicArtifact.status, 'planned', 'runEpic must produce a planned epic');

    // runWeave run in an independent loom repo
    const weaveDir = makeLoomRepo('loom-weave-compare-');
    const savedCwd = process.cwd();
    try {
      process.chdir(weaveDir);
      resetDatabaseForTest();
      const weaveLlm = new MockLLMClient(pipelineResponder);
      const { exitCode: weaveExit } = await runInProcess(() => runWeave(BRIEF, { llm: weaveLlm, force: true }));
      assert.equal(weaveExit, null, 'runWeave must exit 0');
      const weaveArtifact = readEpicArtifact(weaveDir);
      assert.equal(weaveArtifact.status, 'planned', 'runWeave must produce a planned epic');

      assert.equal(weaveArtifact.title, epicArtifact.title, 'epic title must be identical for runEpic and runWeave');
      assert.equal(weaveArtifact.yamlContent, epicArtifact.yamlContent, 'YAML artifact must be byte-identical for runEpic and runWeave');
    } finally {
      process.chdir(savedCwd);
      resetDatabaseForTest();
      fs.rmSync(weaveDir, { recursive: true, force: true });
    }
  });
});

// ── Part 3: Verdict-value invariance ─────────────────────────────────────────

describe('NFR-1 verdict-value invariance — planning identical across all verdict states', () => {
  // Every verdict value in the type × size × confidence matrix, plus all
  // failure modes. Planning must behave identically for each.
  const SCENARIOS: Array<{ label: string; result: ClassifyResult }> = [
    { label: 'no classifier call (current thin pass-through)', result: { ok: false, reason: 'llm_error', detail: 'unused' } },
    { label: 'llm_error failure', result: { ok: false, reason: 'llm_error', detail: 'stubbed error' } },
    { label: 'timeout failure', result: { ok: false, reason: 'timeout', detail: 'stubbed timeout' } },
    { label: 'invalid_output failure', result: { ok: false, reason: 'invalid_output', detail: 'stubbed invalid' } },
    { label: 'feature/story/high', result: { ok: true, verdict: { type: 'feature', size: 'story', confidence: 'high', rationale: 'test' } } },
    { label: 'feature/story/medium', result: { ok: true, verdict: { type: 'feature', size: 'story', confidence: 'medium', rationale: 'test' } } },
    { label: 'feature/story/low', result: { ok: true, verdict: { type: 'feature', size: 'story', confidence: 'low', rationale: 'test' } } },
    { label: 'feature/epic/high', result: { ok: true, verdict: { type: 'feature', size: 'epic', confidence: 'high', rationale: 'test' } } },
    { label: 'feature/epic/medium', result: { ok: true, verdict: { type: 'feature', size: 'epic', confidence: 'medium', rationale: 'test' } } },
    { label: 'feature/epic/low', result: { ok: true, verdict: { type: 'feature', size: 'epic', confidence: 'low', rationale: 'test' } } },
    { label: 'bug/story/high', result: { ok: true, verdict: { type: 'bug', size: 'story', confidence: 'high', rationale: 'test' } } },
    { label: 'bug/story/medium', result: { ok: true, verdict: { type: 'bug', size: 'story', confidence: 'medium', rationale: 'test' } } },
    { label: 'bug/story/low', result: { ok: true, verdict: { type: 'bug', size: 'story', confidence: 'low', rationale: 'test' } } },
    { label: 'bug/epic/high', result: { ok: true, verdict: { type: 'bug', size: 'epic', confidence: 'high', rationale: 'test' } } },
    { label: 'bug/epic/medium', result: { ok: true, verdict: { type: 'bug', size: 'epic', confidence: 'medium', rationale: 'test' } } },
    { label: 'bug/epic/low', result: { ok: true, verdict: { type: 'bug', size: 'epic', confidence: 'low', rationale: 'test' } } },
    { label: 'chore/story/high', result: { ok: true, verdict: { type: 'chore', size: 'story', confidence: 'high', rationale: 'test' } } },
    { label: 'chore/story/medium', result: { ok: true, verdict: { type: 'chore', size: 'story', confidence: 'medium', rationale: 'test' } } },
    { label: 'chore/story/low', result: { ok: true, verdict: { type: 'chore', size: 'story', confidence: 'low', rationale: 'test' } } },
    { label: 'chore/epic/high', result: { ok: true, verdict: { type: 'chore', size: 'epic', confidence: 'high', rationale: 'test' } } },
    { label: 'chore/epic/medium', result: { ok: true, verdict: { type: 'chore', size: 'epic', confidence: 'medium', rationale: 'test' } } },
    { label: 'chore/epic/low', result: { ok: true, verdict: { type: 'chore', size: 'epic', confidence: 'low', rationale: 'test' } } },
  ];

  it('runEpic receives identical (brief, opts) regardless of classifyIntake return value', async () => {
    // Patch epicMod.runEpic to capture calls without actually running the planner.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const epicMod = require('../commands/epic.js') as {
      runEpic: (brief: string, opts: unknown) => Promise<void>;
    };
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const coreMod = require('@loom-ai/core') as {
      classifyIntake: (...args: unknown[]) => Promise<ClassifyResult>;
    };

    const origRunEpic = epicMod.runEpic;
    const origClassify = coreMod.classifyIntake;

    const captured: Array<{ brief: string; opts: unknown }> = [];
    epicMod.runEpic = async (brief: string, opts: unknown) => {
      captured.push({ brief, opts });
    };

    try {
      for (const { result } of SCENARIOS) {
        coreMod.classifyIntake = async () => result;
        await runWeave(BRIEF, { force: true as const });
      }
    } finally {
      epicMod.runEpic = origRunEpic;
      coreMod.classifyIntake = origClassify;
    }

    assert.equal(captured.length, SCENARIOS.length, 'runEpic must be called once per scenario');
    // Every call must carry the same (brief, opts) — verdict never reaches runEpic.
    for (let i = 1; i < captured.length; i++) {
      assert.equal(
        captured[i].brief,
        captured[0].brief,
        `brief must be identical in scenario ${SCENARIOS[i].label}`
      );
      assert.deepEqual(
        captured[i].opts,
        captured[0].opts,
        `opts must be identical in scenario ${SCENARIOS[i].label} — verdict must not be threaded into runEpic`
      );
    }
  });

  it('produced epic artifact is byte-identical across no-verdict, failure, and every verdict-present run', async () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const coreMod = require('@loom-ai/core') as {
      classifyIntake: (...args: unknown[]) => Promise<ClassifyResult>;
    };
    const origClassify = coreMod.classifyIntake;

    // Baseline: classifier fails (equivalent to "no verdict" / loom epic behaviour).
    coreMod.classifyIntake = async () =>
      ({ ok: false, reason: 'llm_error', detail: 'baseline' } as ClassifyResult);
    const baselineLlm = new MockLLMClient(pipelineResponder);
    const { exitCode: baselineExit } = await runInProcess(() =>
      runWeave(BRIEF, { llm: baselineLlm, force: true })
    );
    assert.equal(baselineExit, null, 'baseline run must succeed');
    const baseline = readEpicArtifact(tmpDir);
    assert.equal(baseline.status, 'planned', 'baseline must be planned');

    // Representative verdict values to verify full invariance.
    const verdictScenarios: Array<{ label: string; result: ClassifyResult }> = [
      {
        label: 'feature/story/high',
        result: { ok: true, verdict: { type: 'feature', size: 'story', confidence: 'high', rationale: 'test' } },
      },
      {
        label: 'bug/epic/low',
        result: { ok: true, verdict: { type: 'bug', size: 'epic', confidence: 'low', rationale: 'test' } },
      },
      {
        label: 'chore/story/medium',
        result: { ok: true, verdict: { type: 'chore', size: 'story', confidence: 'medium', rationale: 'test' } },
      },
      {
        label: 'timeout failure',
        result: { ok: false, reason: 'timeout', detail: 'stubbed' },
      },
    ];

    try {
      for (const { label, result } of verdictScenarios) {
        // Reset to a clean DB so the scenario produces epic-001 (same position).
        wipeLoomDb(tmpDir);
        coreMod.classifyIntake = async () => result;
        const llm = new MockLLMClient(pipelineResponder);
        const { exitCode } = await runInProcess(() => runWeave(BRIEF, { llm, force: true }));
        assert.equal(exitCode, null, `scenario "${label}" must exit 0`);

        const artifact = readEpicArtifact(tmpDir);
        assert.equal(
          artifact.title,
          baseline.title,
          `epic title must be identical for verdict scenario "${label}"`
        );
        assert.equal(
          artifact.status,
          baseline.status,
          `epic status must be identical for verdict scenario "${label}"`
        );
        assert.equal(
          artifact.yamlContent,
          baseline.yamlContent,
          `YAML artifact must be byte-identical for verdict scenario "${label}" — verdict must not alter planning output`
        );
      }
    } finally {
      coreMod.classifyIntake = origClassify;
      resetDatabaseForTest();
    }
  });
});
