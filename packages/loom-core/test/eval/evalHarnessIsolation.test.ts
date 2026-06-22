import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { loadIntakeEvalSet } from '../../src/eval/intake/loadIntakeEvalSet.js';
import { runIntakeEval } from '../../src/eval/intake/runIntakeEval.js';
import { scoreIntakeEval } from '../../src/eval/intake/scoreIntakeEval.js';

// ── Helpers ───────────────────────────────────────────────────────────────────

function findDir(target: string): string {
  let dir = __dirname;
  for (let i = 0; i < 12; i++) {
    const candidate = path.join(dir, target);
    if (fs.existsSync(candidate)) return candidate;
    dir = path.dirname(dir);
  }
  throw new Error(`could not locate ${target} walking up from ${__dirname}`);
}

function findFixturePath(): string {
  return findDir(path.join('eval-cases', 'intake-classification.yaml'));
}

function gatherTsFiles(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  const results: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory() && entry.name !== '__tests__') {
      results.push(...gatherTsFiles(full));
    } else if (entry.isFile() && entry.name.endsWith('.ts') && !entry.name.endsWith('.d.ts')) {
      results.push(full);
    }
  }
  return results;
}

// ── Worker-path isolation (AC1, NFR-4) ───────────────────────────────────────
//
// The eval runner must never be reachable from the worker execution path.
// No production module under src/orchestrator/ or src/worker/ may import
// runIntakeEval, scoreIntakeEval, or reference eval-intake.

describe('evalHarnessIsolation — worker-path isolation (AC1, NFR-4)', () => {
  const BANNED_PATTERNS = ['runIntakeEval', 'scoreIntakeEval', 'eval-intake'];

  function scanForBannedImports(sourceDir: string): string[] {
    const violations: string[] = [];
    for (const file of gatherTsFiles(sourceDir)) {
      const content = fs.readFileSync(file, 'utf8');
      for (const pattern of BANNED_PATTERNS) {
        if (content.includes(pattern)) {
          violations.push(`${file}: contains '${pattern}'`);
        }
      }
    }
    return violations;
  }

  it('src/orchestrator/ does not import runIntakeEval, scoreIntakeEval, or eval-intake', () => {
    const srcRoot = findDir(path.join('packages', 'loom-core', 'src'));
    const orchestratorDir = path.join(srcRoot, 'orchestrator');
    const violations = scanForBannedImports(orchestratorDir);
    assert.deepEqual(
      violations,
      [],
      `eval runner leaked into orchestrator path:\n  ${violations.join('\n  ')}`,
    );
  });

  it('src/worker/ does not import runIntakeEval, scoreIntakeEval, or eval-intake', () => {
    const srcRoot = findDir(path.join('packages', 'loom-core', 'src'));
    const workerDir = path.join(srcRoot, 'worker');
    const violations = scanForBannedImports(workerDir);
    assert.deepEqual(
      violations,
      [],
      `eval runner leaked into worker path:\n  ${violations.join('\n  ')}`,
    );
  });
});

// ── Harness smoke check — prepared, not executed (AC1, AC2) ──────────────────
//
// Verifies that the three harness functions import cleanly and that
// loadIntakeEvalSet can load the cleaned YAML fixture without any LLM call.
// runIntakeEval and scoreIntakeEval are NOT invoked (no model calls made here).

describe('evalHarnessIsolation — harness smoke check (AC1, AC2)', () => {
  it('loadIntakeEvalSet, runIntakeEval, scoreIntakeEval are importable as functions', () => {
    assert.equal(typeof loadIntakeEvalSet, 'function', 'loadIntakeEvalSet must be a function');
    assert.equal(typeof runIntakeEval, 'function', 'runIntakeEval must be a function');
    assert.equal(typeof scoreIntakeEval, 'function', 'scoreIntakeEval must be a function');
  });

  it('loadIntakeEvalSet loads the cleaned intake-classification.yaml without a model call', () => {
    const fixturePath = findFixturePath();
    const cases = loadIntakeEvalSet(fixturePath);
    assert.ok(Array.isArray(cases), 'loadIntakeEvalSet must return an array');
    assert.ok(cases.length > 0, 'intake-classification.yaml must contain at least one case');
    // All 22 cases expected from epic-023 + 026-002 rewrites (non-fatal if count shifts)
    assert.ok(cases.length >= 22, `expected at least 22 cases, got ${cases.length}`);
  });

  it('each loaded case has id, brief, and valid label fields', () => {
    const fixturePath = findFixturePath();
    const cases = loadIntakeEvalSet(fixturePath);
    for (const c of cases) {
      assert.ok(typeof c.id === 'string' && c.id.length > 0, `case.id must be non-empty`);
      assert.ok(typeof c.brief === 'string' && c.brief.trim().length > 0, `case ${c.id} brief must be non-empty`);
      assert.ok(
        ['feature', 'bug', 'chore'].includes(c.label.type),
        `case ${c.id} has invalid label.type: ${c.label.type}`,
      );
      assert.ok(
        ['story', 'epic'].includes(c.label.size),
        `case ${c.id} has invalid label.size: ${c.label.size}`,
      );
    }
  });
});
