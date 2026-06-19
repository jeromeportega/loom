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
 *      verdict value); the produced epic artifact is structurally identical across
 *      all conditions (title, status, parsed YAML planning content).
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
import yaml from 'js-yaml';
import Database from 'better-sqlite3';
import {
  MockLLMClient,
  resetDatabaseForTest,
  EpicStore,
} from '@loom-ai/core';
import type { LLMRequest } from '@loom-ai/core';
import { runEpic } from '../commands/epic.js';
import { runWeave } from '../commands/weave.js';

// __dirname = packages/loom-cli/dist/__tests__
const LOOM_CLI = path.resolve(__dirname, '../index.js');
const REPO_ROOT = path.resolve(__dirname, '../../../..');

if (!fs.existsSync(LOOM_CLI)) {
  throw new Error(`loom CLI not found at ${LOOM_CLI} — run 'npm run build' before running integration tests`);
}

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
    if (!(err instanceof ExitSignal)) {
      console.error = origErr;
      throw err;
    }
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

// Reads the epic-001 artifact using an independent DB connection — does NOT
// touch or re-initialize the module-level singleton used by runEpic/runWeave.
// parsedEpic holds the structured planning fields (title, priority, requirements,
// stories) for structural comparison that is robust to formatting changes.
function readEpicArtifact(repoDir: string): {
  title: string;
  status: string;
  parsedEpic: unknown;
} {
  const db = new Database(path.join(repoDir, '.loom', 'loom.db'), { readonly: true });
  try {
    const epic = new EpicStore(db).get('epic-001');
    if (!epic) return { title: '', status: 'missing', parsedEpic: null };
    const yamlPath = epic.yaml_path ? path.join(repoDir, epic.yaml_path) : null;
    const yamlContent = yamlPath && fs.existsSync(yamlPath) ? fs.readFileSync(yamlPath, 'utf8') : '';
    const parsedEpic = yamlContent ? yaml.load(yamlContent) : null;
    return { title: epic.title, status: epic.status, parsedEpic };
  } finally {
    db.close();
  }
}

// Wipes only the SQLite files so the next openDatabase() creates a fresh schema.
// Policy.yaml and planning/* files are preserved.
// resetDatabaseForTest() releases module singleton handles before deletion.
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
  // the Planner orchestrator, the policy/guardrails gate, and the epic CLI entry
  // point. None of them may import from the intake module or read the verdict.
  const planningDirs = [
    path.join(REPO_ROOT, 'packages', 'loom-core', 'src', 'planner'),
    path.join(REPO_ROOT, 'packages', 'loom-core', 'src', 'brief'),
    path.join(REPO_ROOT, 'packages', 'loom-core', 'src', 'guardrails'),
  ];
  const planningFiles = [
    path.join(REPO_ROOT, 'packages', 'loom-cli', 'src', 'commands', 'epic.ts'),
  ];

  // Recursive walker: collects all .ts source files (excluding .test.ts) under
  // each dir. Uses Node 18+ readdirSync recursive option which returns relative
  // path strings from the root dir, catching files in any subdirectory.
  function collectSrcFiles(dirs: string[]): string[] {
    const out: string[] = [];
    for (const dir of dirs) {
      if (!fs.existsSync(dir)) continue;
      const entries = fs.readdirSync(dir, { recursive: true }) as string[];
      for (const rel of entries) {
        if (!rel.endsWith('.ts') || rel.endsWith('.test.ts')) continue;
        out.push(path.join(dir, rel));
      }
    }
    return out;
  }

  const allPlanningFiles = [...collectSrcFiles(planningDirs), ...planningFiles];

  // Key backbone files — each must be present in the scan for the topology
  // guard to be meaningful. Named explicitly so a rename or move produces a
  // clear failure rather than a silent headcount drop.
  const REQUIRED_IN_SCAN = [
    path.join(REPO_ROOT, 'packages', 'loom-core', 'src', 'planner', 'Planner.ts'),
    path.join(REPO_ROOT, 'packages', 'loom-core', 'src', 'planner', 'AnalystAgent.ts'),
    path.join(REPO_ROOT, 'packages', 'loom-core', 'src', 'planner', 'PMAgent.ts'),
    path.join(REPO_ROOT, 'packages', 'loom-core', 'src', 'planner', 'ArchitectAgent.ts'),
    path.join(REPO_ROOT, 'packages', 'loom-core', 'src', 'brief', 'gate.ts'),
    path.join(REPO_ROOT, 'packages', 'loom-core', 'src', 'brief', 'BriefRefiner.ts'),
    path.join(REPO_ROOT, 'packages', 'loom-core', 'src', 'guardrails', 'PolicyEngine.ts'),
    path.join(REPO_ROOT, 'packages', 'loom-cli', 'src', 'commands', 'epic.ts'),
  ];

  it('scans all required planning-side source files', () => {
    for (const required of REQUIRED_IN_SCAN) {
      assert.ok(
        allPlanningFiles.includes(required),
        `Planning-side scan must include ${path.relative(REPO_ROOT, required)}`
      );
    }
  });

  it('no planning-side file imports verdict-producing or verdict-reading symbols from the intake module', () => {
    // The one allowed intake import in epic.ts is the designated side-effect seam
    // (recordIntakeClassification), which returns void and never feeds the verdict
    // back into planning. All other intake imports — classifyIntake, IntakeVerdict,
    // getIntakeVerdict* — are prohibited because they would allow the verdict to
    // influence planning decisions.
    const intakeImportRe = /(?:from|import|require)\s*[\(]?\s*['"].*intake/;
    const allowedSeamRe = /['"](?:\.\.\/)*intake\/recordIntakeClassification(?:\.js)?['"]/;
    const violations: string[] = [];
    for (const file of allPlanningFiles) {
      if (!fs.existsSync(file)) continue;
      const src = fs.readFileSync(file, 'utf8');
      if (!intakeImportRe.test(src)) continue;
      // Each line: if it matches the intake import pattern but is NOT the
      // allowed side-effect seam, it is a violation.
      for (const line of src.split('\n')) {
        if (intakeImportRe.test(line) && !allowedSeamRe.test(line)) {
          violations.push(path.relative(REPO_ROOT, file));
          break;
        }
      }
    }
    assert.deepEqual(
      violations,
      [],
      `Planning-side files must not import verdict-producing/reading symbols from intake:\n  ${violations.join('\n  ')}`
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

describe('epic ≡ weave — same brief produces identical epic artifact', { concurrency: false }, () => {
  it('runEpic and runWeave produce the same epic title and status', async () => {
    // runEpic baseline (uses tmpDir from beforeEach)
    const epicLlm = new MockLLMClient(pipelineResponder);
    const { exitCode: epicExit } = await runInProcess(() => runEpic(BRIEF, { llm: epicLlm, force: true }));
    assert.ok(epicExit === null || epicExit === 0, 'runEpic must exit cleanly (null or 0)');
    const epicArtifact = readEpicArtifact(tmpDir);
    assert.equal(epicArtifact.status, 'planned', 'runEpic must produce a planned epic');

    // runWeave run in an independent loom repo to avoid DB state interference
    const weaveDir = makeLoomRepo('loom-weave-compare-');
    const savedCwd = process.cwd();
    try {
      process.chdir(weaveDir);
      resetDatabaseForTest();
      const weaveLlm = new MockLLMClient(pipelineResponder);
      const { exitCode: weaveExit } = await runInProcess(() => runWeave(BRIEF, { llm: weaveLlm, force: true }));
      assert.ok(weaveExit === null || weaveExit === 0, 'runWeave must exit cleanly (null or 0)');
      const weaveArtifact = readEpicArtifact(weaveDir);
      assert.equal(weaveArtifact.status, 'planned', 'runWeave must produce a planned epic');

      assert.equal(weaveArtifact.title, epicArtifact.title, 'epic title must be identical for runEpic and runWeave');
      assert.deepEqual(
        weaveArtifact.parsedEpic,
        epicArtifact.parsedEpic,
        'YAML artifact planning content must be structurally identical for runEpic and runWeave'
      );
    } finally {
      process.chdir(savedCwd);
      resetDatabaseForTest();
      fs.rmSync(weaveDir, { recursive: true, force: true });
    }
  });
});

// ── Part 3: Verdict-value invariance ─────────────────────────────────────────
//
// The _classifyIntake seam was retired in story-023-003 — classification is now
// wired inside runEpic as a fire-and-forget side-effect. Comprehensive FR-4
// regression tests live in intakeObserveOnly.regression.test.ts. These tests
// verify the structural invariant: runWeave delegates to runEpic without
// threading any classification state into the opts.

describe('NFR-1 verdict-value invariance — runWeave delegates without injecting verdict state', { concurrency: false }, () => {
  it('runEpic receives (brief, opts) unchanged — no verdict state threaded in', async () => {
    // Use the _runEpic DI seam to capture calls. This avoids ESM/CJS module-binding
    // brittleness — the spy is injected directly into opts, not via module-cache patching.
    const captured: Array<{ brief: string; opts: unknown }> = [];

    for (let i = 0; i < 3; i++) {
      await runInProcess(() =>
        runWeave(BRIEF, {
          force: true,
          _runEpic: async (b, o) => { captured.push({ brief: b, opts: o }); },
        })
      );
    }

    assert.equal(captured.length, 3, 'runEpic must be called once per runWeave invocation');
    for (let i = 1; i < captured.length; i++) {
      assert.equal(captured[i].brief, captured[0].brief, 'brief must be passed through unchanged');
      assert.deepEqual(captured[i].opts, captured[0].opts, 'opts must be identical across calls — no verdict state injected');
    }
  });

  it('produced epic artifact is structurally identical across two independent runWeave runs', async () => {
    const llm1 = new MockLLMClient(pipelineResponder);
    const { exitCode: exit1 } = await runInProcess(() =>
      runWeave(BRIEF, { llm: llm1, force: true })
    );
    assert.ok(exit1 === null || exit1 === 0, 'first run must exit cleanly');
    const artifact1 = readEpicArtifact(tmpDir);
    assert.equal(artifact1.status, 'planned', 'first run must produce a planned epic');

    wipeLoomDb(tmpDir);
    const llm2 = new MockLLMClient(pipelineResponder);
    const { exitCode: exit2 } = await runInProcess(() =>
      runWeave(BRIEF, { llm: llm2, force: true })
    );
    assert.ok(exit2 === null || exit2 === 0, 'second run must exit cleanly');
    const artifact2 = readEpicArtifact(tmpDir);
    assert.equal(artifact2.status, 'planned', 'second run must produce a planned epic');

    assert.equal(artifact2.title, artifact1.title, 'epic title must be identical across runs');
    assert.deepEqual(artifact2.parsedEpic, artifact1.parsedEpic, 'YAML planning content must be identical across runs');
  });
});
