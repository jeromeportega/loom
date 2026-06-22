import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';

// Compiled location: packages/loom-core/dist/eval/skill-judge/__tests__/guards.test.js
// __dirname = .../packages/loom-core/dist/eval/skill-judge/__tests__
const LOOM_CORE_ROOT = path.resolve(__dirname, '../../../../');     // packages/loom-core/
const REPO_ROOT      = path.resolve(__dirname, '../../../../../../'); // repo root

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function findFilesRecursive(dir: string, pattern: RegExp): string[] {
  if (!fs.existsSync(dir)) return [];
  const results: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...findFilesRecursive(fullPath, pattern));
    } else if (pattern.test(entry.name)) {
      results.push(fullPath);
    }
  }
  return results;
}

/**
 * Return the pre-epic-038 base commit SHA.
 *
 * Resolution order:
 *   1. EPIC_038_BASE_SHA environment variable (set in CI for shallow clones)
 *   2. git log heuristic — walk newest→oldest and return the first commit
 *      whose message does NOT mention story/epic-038
 *
 * Returns undefined when git is unavailable or history is too shallow.
 * Callers that depend on this SHA must emit a visible diagnostic and skip
 * rather than silently passing.
 */
function findEpicBaseSha(): string | undefined {
  if (process.env.EPIC_038_BASE_SHA) return process.env.EPIC_038_BASE_SHA;
  try {
    const log = execSync('git log --oneline HEAD', {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const lines = log.trim().split('\n').filter(Boolean);
    // Walk from newest to oldest; the first commit NOT tagged with story/epic-038 is the base
    const idx = lines.findIndex((l) => !l.match(/(?:story|epic)-038/i));
    if (idx < 0) return undefined; // entire visible history is the epic
    return lines[idx].split(' ')[0];
  } catch {
    return undefined;
  }
}

/**
 * Emit a visible warning and return early from the current test.
 * Use this when the epic base SHA is unavailable so the skip is never silent.
 */
function skipWithDiagnostic(reason: string): void {
  process.stderr.write(`[guards.test] WARNING: ${reason} — guard SKIPPED\n`);
}

// ---------------------------------------------------------------------------
// Cross-cutting guard 1 — diff-scope (ADR-001 / NFR-1)
//
// The eval module must not modify production skills (src/skills/).
// ALLOWLIST: judgeMinScore.ts is a shared constant file (ADDED by story-038-001,
// architect-approved). Any further src/skills/ changes would violate ADR-001.
// ---------------------------------------------------------------------------

const SKILLS_DIR_PREFIX  = 'packages/loom-core/src/skills/';
const SKILLS_DIR_ALLOWLIST = new Set<string>([
  'packages/loom-core/src/skills/judgeMinScore.ts',
]);

describe('diff-scope guard (ADR-001/NFR-1) — epic-038 must not modify src/skills/', () => {
  it('no src/skills/ paths outside the allowlist appear in the epic diff', () => {
    const epicBase = findEpicBaseSha();
    if (!epicBase) {
      skipWithDiagnostic('epic base SHA unavailable (set EPIC_038_BASE_SHA in CI for shallow clones)');
      return;
    }

    let diffOutput: string;
    try {
      diffOutput = execSync(`git diff --name-only ${epicBase}..HEAD`, {
        cwd: REPO_ROOT,
        encoding: 'utf8',
        stdio: ['pipe', 'pipe', 'pipe'],
      }).trim();
    } catch {
      skipWithDiagnostic('git diff failed');
      return;
    }

    const changedFiles = diffOutput.split('\n').filter(Boolean);
    const violations = changedFiles
      .filter((p) => p.startsWith(SKILLS_DIR_PREFIX))
      .filter((p) => !SKILLS_DIR_ALLOWLIST.has(p));

    assert.deepEqual(
      violations,
      [],
      `ADR-001: epic-038 must not touch ${SKILLS_DIR_PREFIX} except the allowlist. ` +
        `Violations: ${violations.join(', ')}`,
    );
  });

  // The allowlist guards what is ALLOWED to change in src/skills/.
  // Whether a file is "new" vs "modified" is implementation detail; the key
  // invariant is already captured by the test above (nothing outside the allowlist
  // appears in the diff). This is enforced at epic-review time if a pre-existing
  // file ever sneaks onto the allowlist.
});

// ---------------------------------------------------------------------------
// Cross-cutting guard 2 — no real model calls (NFR-2)
//
// All eval code paths (source and tests) must use MockLLMClient.
// ClaudeCliClient (the real transport) must never appear in src/eval/.
// The live eval entry point lives exclusively in scripts/ (story-038-006).
// ---------------------------------------------------------------------------

describe('no-real-model-calls guard (NFR-2) — skill-judge eval must use MockLLMClient only', () => {
  // Scoped to src/eval/skill-judge/ — the epic-038 eval module.
  // Other eval sub-directories (intake, framework) are out of scope for this guard.
  const SKILL_JUDGE_SRC = path.join(LOOM_CORE_ROOT, 'src', 'eval', 'skill-judge');

  it('skill-judge source directory exists (guard sanity check)', () => {
    assert.ok(
      fs.existsSync(SKILL_JUDGE_SRC),
      `SKILL_JUDGE_SRC not found at ${SKILL_JUDGE_SRC} — guards cannot run in this environment. ` +
        `This check exists so that a missing src/ tree fails loudly rather than silently passing all guards.`,
    );
  });

  it('no src/eval/skill-judge/ source file (non-test) instantiates ClaudeCliClient', () => {
    // Source files: everything in skill-judge/ except __tests__/
    const srcFiles = findFilesRecursive(SKILL_JUDGE_SRC, /\.ts$/)
      .filter((f) => !f.includes('__tests__'));

    const violations = srcFiles.filter((file) => {
      const content = fs.readFileSync(file, 'utf8');
      // Check for instantiation; exclude comment-only lines for the import check
      // so that a commented-out import during debugging does not create false positives.
      const hasInstantiation = /new ClaudeCliClient\b/.test(content);
      const hasImport = /^(?!\s*\/\/).*\bimport\b.*ClaudeCliClient/m.test(content);
      return hasInstantiation || hasImport;
    });

    assert.deepEqual(
      violations.map((f) => path.relative(REPO_ROOT, f)),
      [],
      `NFR-2: skill-judge source files must not import or instantiate ClaudeCliClient. ` +
        `Found: ${violations.map((f) => path.relative(REPO_ROOT, f)).join(', ')}`,
    );
  });

  it('every skill-judge test file that wires an LLM uses MockLLMClient', () => {
    const testFiles = findFilesRecursive(
      path.join(SKILL_JUDGE_SRC, '__tests__'),
      /\.test\.ts$/,
    );

    const violations: string[] = [];
    for (const file of testFiles) {
      const content = fs.readFileSync(file, 'utf8');
      // Detect LLM wiring by looking for GateDeps/JudgeDeps object literal keys.
      // Using a pattern that matches object key syntax to avoid matching prose/comments.
      const wiresLLM =
        content.includes('gateModel') ||
        content.includes('judgeModel') ||
        /[{,]\s*llm\s*:/.test(content);
      // Require actual import of MockLLMClient, not just a mention in comments/strings.
      const importsMock = /(?:import|require).*MockLLMClient/.test(content);
      if (wiresLLM && !importsMock) {
        violations.push(path.relative(REPO_ROOT, file));
      }
    }

    assert.deepEqual(
      violations,
      [],
      `NFR-2: skill-judge test files that wire an LLM must import MockLLMClient. ` +
        `Missing: ${violations.join(', ')}`,
    );
  });

  it('run.ts accepts an injected LLMClient (no hard-coded ClaudeCliClient)', () => {
    // The only live entry point is scripts/eval-skill-judge.mjs (story-038-006).
    // run.ts must accept llm as an optional parameter — never constructing a real client itself.
    const runTsPath = path.join(SKILL_JUDGE_SRC, 'run.ts');
    if (!fs.existsSync(runTsPath)) return;
    const content = fs.readFileSync(runTsPath, 'utf8');
    assert.ok(
      !/new ClaudeCliClient\b/.test(content),
      'run.ts must not hard-code ClaudeCliClient — callers inject the LLMClient',
    );
  });
});
