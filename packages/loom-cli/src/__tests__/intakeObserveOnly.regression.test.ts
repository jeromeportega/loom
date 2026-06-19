/**
 * FR-4 observe-only regression test (story-023-003).
 *
 * Asserts that planner + execution output is byte-identical whether the
 * intake classifier succeeds (verdict persisted) or fails (no verdict). The
 * verdict is a side-effect with no downstream influence on planning decisions.
 *
 * Two scenarios are compared:
 *   A. Classifier succeeds   — mock LLM returns a valid verdict
 *   B. Classifier fails      — mock LLM throws on the classifier call
 *
 * The produced epic artifact (title, status, parsed YAML) must be identical
 * in both scenarios.
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

const LOOM_CLI = path.resolve(__dirname, '../index.js');

// ── LLM stubs ─────────────────────────────────────────────────────────────────

function jsonBlock(obj: unknown): string {
  return '```json\n' + JSON.stringify(obj) + '\n```';
}

function makePlanningResponder(epicTitle: string) {
  return (req: LLMRequest): string => {
    const last = req.messages[req.messages.length - 1];

    if (last.role === 'assistant') {
      // This is the intake classifier call. Throw to simulate failure.
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

/** Handles both planning pipeline AND classifier (returns a valid verdict). */
function makeFullResponder(epicTitle: string) {
  return (req: LLMRequest): string => {
    const last = req.messages[req.messages.length - 1];

    // Intake classifier: assistant prefill '{' is the last message.
    if (last.role === 'assistant' && last.content === '{') {
      return '"type":"feature","size":"story","confidence":"high","rationale":"observe-only regression"}';
    }

    return makePlanningResponder(epicTitle)(req);
  };
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
      const llmA = new MockLLMClient(makeFullResponder(EPIC_TITLE));
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
});
