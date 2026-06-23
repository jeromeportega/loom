/**
 * FR-4 observe-only regression test (story-023-003).
 *
 * Asserts that planner + execution output is byte-identical whether the
 * intake classifier succeeds (verdict persisted) or fails (no verdict). The
 * verdict is a side-effect with no downstream influence on planning decisions.
 *
 * Scenarios compared:
 *   A. Classifier succeeds with a valid verdict
 *   B. Classifier fails  — mock LLM throws on the classifier call
 *   C. Parameterised verdict-value invariance — multiple verdict types/sizes/
 *      confidences all produce identical planning output (the verdict value
 *      itself must not influence the planner).
 *
 * The produced epic artifact (title, status, parsed YAML) must be identical
 * across all scenarios.
 */
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import yaml from 'js-yaml';
import {
  MockLLMClient,
  resetDatabaseForTest,
  EpicStore,
} from '@loom-ai/core';
import { openProjectDatabase } from '../dbHelper.js';
import type { LLMRequest } from '@loom-ai/core';
import { runEpic } from '../commands/epic.js';
import { runInProcess, jsonBlock } from './testUtils.js';

const LOOM_CLI = path.resolve(__dirname, '../index.js');

// ── LLM stubs ─────────────────────────────────────────────────────────────────

function makePlanningResponder(epicTitle: string) {
  return (req: LLMRequest): string => {
    const last = req.messages[req.messages.length - 1];

    // Intake classifier: assistant prefill '{' is the distinguishing signal.
    // Throw to simulate a classifier failure (swallowed by recordIntakeClassification).
    if (last.role === 'assistant' && last.content === '{') {
      throw new Error('classifier call — planning-only stub rejects it');
    }

    const content = last.content as string;
    if (content.includes('Apply the discipline above')) {
      return jsonBlock({
        ready: true,
        quality_score: 9,
        refined_brief: '# Brief\n\n## Goal\nVerify observe-only.',
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
    if (content.includes('Produce the project brief')) return '# Brief\n\n## The Problem\nA gap.';
    if (content.includes('Headless task A: produce the PRD')) return '# PRD\n\n## Goals\nShip it.';
    if (content.includes('Headless task B: produce the epic')) {
      const m = content.match(/starting at "(epic-\d+)"/);
      const eid = m ? m[1] : 'epic-001';
      const num = eid.slice(5);
      return jsonBlock({
        epics: [
          {
            epic_id: eid,
            title: epicTitle,
            priority: 'must-have',
            prd_ref: 'x',
            requirements: ['FR-1'],
            stories: [
              {
                id: `story-${num}-001`,
                title: 'Observe-only story',
                description: 'do it',
                acceptance_criteria: ['verdict does not alter output'],
                estimated_complexity: 'small',
                dependencies: [],
              },
            ],
          },
        ],
      });
    }
    if (content.includes('Headless task A: produce the architecture'))
      return '# Architecture\n\n## Architecture Philosophy\nBoring tech.';
    if (content.includes('Headless task B: produce per-story')) return '```json\n{"tech_notes":{}}\n```';
    throw new Error('unexpected planning message: ' + content.slice(0, 60));
  };
}

/** Handles both planning pipeline AND classifier (returns a verdict with specific values). */
function makeVerdictResponder(
  type: string,
  size: string,
  confidence: string,
  epicTitle: string,
) {
  return (req: LLMRequest): string => {
    const last = req.messages[req.messages.length - 1];

    // Intake classifier: assistant prefill '{' is the last message.
    if (last.role === 'assistant' && last.content === '{') {
      return `"type":"${type}","size":"${size}","confidence":"${confidence}","rationale":"observe-only regression"}`;
    }

    return makePlanningResponder(epicTitle)(req);
  };
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

// Reads the epic-001 artifact using the same loom-home DB path that runEpic
// writes to (via openProjectDatabase) — both use the same singleton handle.
function readEpicArtifact(repoDir: string): {
  title: string;
  status: string;
  parsedEpic: unknown;
} {
  const db = openProjectDatabase(repoDir);
  const epic = new EpicStore(db).get('epic-001');
  if (!epic) return { title: '', status: 'missing', parsedEpic: null };
  const yamlPath = epic.yaml_path ? path.join(repoDir, epic.yaml_path) : null;
  const yamlContent = yamlPath && fs.existsSync(yamlPath) ? fs.readFileSync(yamlPath, 'utf8') : '';
  const parsedEpic = yamlContent ? yaml.load(yamlContent) : null;
  return { title: epic.title, status: epic.status, parsedEpic };
}

// ── Fixtures ──────────────────────────────────────────────────────────────────

let prevCwd: string;
let prevLoomHome: string | undefined;
let loomHomeDir: string;

const BRIEF = 'Build a minimal feature to verify the observe-only invariant holds end-to-end (FR-4).';
const EPIC_TITLE = 'FR-4 observe-only regression epic';

beforeEach(() => {
  prevLoomHome = process.env.LOOM_HOME;
  loomHomeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'loom-cli-home-'));
  process.env.LOOM_HOME = loomHomeDir;
  prevCwd = process.cwd();
});

afterEach(() => {
  process.chdir(prevCwd);
  resetDatabaseForTest();
  fs.rmSync(loomHomeDir, { recursive: true, force: true });
  if (prevLoomHome === undefined) delete process.env.LOOM_HOME;
  else process.env.LOOM_HOME = prevLoomHome;
});

// ── FR-4 regression tests ─────────────────────────────────────────────────────

describe('FR-4 observe-only invariant — planner output identical with vs without verdict', { concurrency: false }, () => {
  it('planning output is byte-identical whether the classifier succeeds or fails', async () => {
    // Scenario A: classifier SUCCEEDS — mock returns a valid verdict.
    const dirA = makeLoomRepo('loom-observe-only-a-');
    let artifactA: ReturnType<typeof readEpicArtifact> | null = null;
    try {
      process.chdir(dirA);
      resetDatabaseForTest();
      const llmA = new MockLLMClient(makeVerdictResponder('feature', 'story', 'high', EPIC_TITLE));
      const { exitCode: exitA } = await runInProcess(() => runEpic(BRIEF, { llm: llmA, force: true }));
      assert.ok(exitA === null || exitA === 0, 'scenario A (verdict present) must exit cleanly');
      artifactA = readEpicArtifact(dirA);
      assert.equal(artifactA.status, 'planned', 'scenario A must produce a planned epic');
    } finally {
      resetDatabaseForTest();
      process.chdir(prevCwd);
      fs.rmSync(dirA, { recursive: true, force: true });
    }

    // Scenario B: classifier FAILS — mock throws on classifier call; verdict absent.
    const dirB = makeLoomRepo('loom-observe-only-b-');
    let artifactB: ReturnType<typeof readEpicArtifact> | null = null;
    try {
      process.chdir(dirB);
      resetDatabaseForTest();
      const llmB = new MockLLMClient(makePlanningResponder(EPIC_TITLE));
      const { exitCode: exitB } = await runInProcess(() => runEpic(BRIEF, { llm: llmB, force: true }));
      assert.ok(exitB === null || exitB === 0, 'scenario B (no verdict) must exit cleanly');
      artifactB = readEpicArtifact(dirB);
      assert.equal(artifactB.status, 'planned', 'scenario B must produce a planned epic');
    } finally {
      resetDatabaseForTest();
      process.chdir(prevCwd);
      fs.rmSync(dirB, { recursive: true, force: true });
    }

    // The artifact must be identical regardless of whether the verdict was stored.
    assert.ok(artifactA !== null && artifactB !== null, 'both scenarios must produce artifacts');
    assert.equal(artifactA.title, artifactB.title, 'epic title must be identical with and without verdict');
    assert.equal(artifactA.status, artifactB.status, 'epic status must be identical');
    assert.deepEqual(
      artifactA.parsedEpic,
      artifactB.parsedEpic,
      'YAML planning content must be identical — verdict must not alter planner output (observe-only invariant)'
    );
  });

  it('planning output is identical across canonical verdict-value variants (FR-4 full matrix)', async () => {
    // Canonical verdict combinations to test. These cover the three types, both
    // sizes, and both confidence extremes — enough to confirm no verdict value
    // influences planning output.
    const variants: Array<{ type: string; size: string; confidence: string }> = [
      { type: 'feature', size: 'story', confidence: 'high' },
      { type: 'bug',     size: 'epic',  confidence: 'low'  },
      { type: 'chore',   size: 'story', confidence: 'medium' },
    ];

    // Capture baseline from a classifier-failure run.
    const dirBase = makeLoomRepo('loom-observe-only-base-');
    let baseline: ReturnType<typeof readEpicArtifact> | null = null;
    try {
      process.chdir(dirBase);
      resetDatabaseForTest();
      const llmBase = new MockLLMClient(makePlanningResponder(EPIC_TITLE));
      const { exitCode } = await runInProcess(() => runEpic(BRIEF, { llm: llmBase, force: true }));
      assert.ok(exitCode === null || exitCode === 0, 'baseline run must exit cleanly');
      baseline = readEpicArtifact(dirBase);
      assert.equal(baseline.status, 'planned', 'baseline must produce a planned epic');
    } finally {
      resetDatabaseForTest();
      process.chdir(prevCwd);
      fs.rmSync(dirBase, { recursive: true, force: true });
    }

    for (const v of variants) {
      const dir = makeLoomRepo(`loom-observe-only-${v.type}-${v.size}-`);
      try {
        process.chdir(dir);
        resetDatabaseForTest();
        const llm = new MockLLMClient(makeVerdictResponder(v.type, v.size, v.confidence, EPIC_TITLE));
        const { exitCode } = await runInProcess(() => runEpic(BRIEF, { llm, force: true }));
        assert.ok(
          exitCode === null || exitCode === 0,
          `verdict variant ${v.type}/${v.size}/${v.confidence} must exit cleanly`
        );
        const artifact = readEpicArtifact(dir);
        assert.equal(artifact.status, 'planned', `variant ${v.type}/${v.size} must produce a planned epic`);
        assert.equal(
          artifact.title,
          baseline!.title,
          `epic title must match baseline for verdict ${v.type}/${v.size}/${v.confidence}`
        );
        assert.deepEqual(
          artifact.parsedEpic,
          baseline!.parsedEpic,
          `YAML planning content must match baseline — verdict value ${v.type}/${v.size}/${v.confidence} must not affect planner output`
        );
      } finally {
        resetDatabaseForTest();
        process.chdir(prevCwd);
        fs.rmSync(dir, { recursive: true, force: true });
      }
    }
  });

  // The intake eval's refined-brief variant showed classifying the REFINED brief
  // eliminates epic→story under-sizing (raw: 2 → refined: 0). Production must feed
  // the classifier the refined brief (when the refiner produced one), not the raw.
  it('classifies the REFINED brief (not the raw brief) when the refiner produces one', async () => {
    const REFINED = '# Refined Brief\n\n## Goal\nA fully-scoped, refiner-produced brief surfacing hidden scope.';
    let classifiedBrief: string | null = null;

    const responder = (req: LLMRequest): string => {
      const last = req.messages[req.messages.length - 1];
      // Intake classifier: assistant prefill '{' — capture the brief it received
      // (the preceding user message), then return a verdict.
      if (last.role === 'assistant' && last.content === '{') {
        classifiedBrief = req.messages[req.messages.length - 2].content as string;
        return `"type":"feature","size":"epic","confidence":"high","rationale":"refined-brief flow"}`;
      }
      // Brief refiner: return a DISTINCTIVE refined_brief.
      if ((last.content as string).includes('Apply the discipline above')) {
        return jsonBlock({
          ready: true,
          quality_score: 9,
          refined_brief: REFINED,
          critique: { strong_points: ['clear'], ambiguities: [], missing_scope: [], untestable_claims: [], hidden_complexity: [] },
          blocking_gaps: [],
          questions: [],
          delta: { added_sections: [], clarifications: [], flagged_assumptions: [] },
        });
      }
      return makePlanningResponder(EPIC_TITLE)(req);
    };

    const dir = makeLoomRepo('loom-observe-only-refined-');
    try {
      process.chdir(dir);
      resetDatabaseForTest();
      const { exitCode } = await runInProcess(() => runEpic(BRIEF, { llm: new MockLLMClient(responder), force: true }));
      assert.ok(exitCode === null || exitCode === 0, 'run must exit cleanly');
      assert.ok(classifiedBrief !== null, 'classifier must have been called');
      assert.equal(classifiedBrief, REFINED, 'classifier must receive the refined brief');
      assert.notEqual(classifiedBrief, BRIEF, 'classifier must NOT receive the raw brief when a refined brief exists');
    } finally {
      resetDatabaseForTest();
      process.chdir(prevCwd);
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
