/**
 * Observe-only verification test (story-063-006 — NFR-1 / ADR-4 enforcement)
 *
 * EXISTING FLOW UNDER TEST
 * Planner.run() on the standalone-story path (EffectiveRouting.size='story').
 * This path exercises both instrumentation seams that are currently active:
 *   • instrumentLLMClient (wraps the LLM client, story-063-002)
 *   • startPhase/endPhase timing markers in AnalystAgent and StandaloneStoryAgent
 *     (story-063-003)
 *
 * COMPARISON SURFACE (documented here — this is the authoritative definition
 * of "observe-only" for NFR-1 and ADR-4):
 *
 *  1. STDOUT — bytes written to process.stdout during Planner.run(), captured
 *     via process.stdout.write interception for the duration of the call.
 *     Normalized: none. The standalone Planner path writes nothing to stdout;
 *     capturing it defensively ensures future instrumentation cannot introduce
 *     stdout leakage without the test catching it.
 *
 *  2. AUDIT_LOG — columns: action, command, allowed, policy_rule, detail.
 *     Excluded: id (autoincrement — nondeterministic), timestamp (wall-clock).
 *     Row count AND content on the listed columns must be identical between
 *     baseline and instrumented runs. Note: the standalone Planner path writes
 *     0 audit_log rows; the empty-vs-empty assertion is still load-bearing —
 *     it catches any instrumentation that accidentally inserts into audit_log.
 *
 *  3. WORKTREE ARTIFACTS — all regular files under <projectRoot>/.loom/planning/,
 *     read byte-for-byte and keyed by relative path. For the standalone path the
 *     two files written are:
 *       story-001/project-brief.md          — analyst brief (AnalystAgent output)
 *       story-001/epics/story-001.yaml      — story YAML (Planner.runStandalone)
 *     Normalized: none. MockLLMClient returns fixed strings; serializeEpic emits
 *     deterministic YAML with no embedded wall-clock values.
 *     Path determinism: runId is derived by Planner.nextEpicId(), which scans
 *     all existing epics rows and returns max(idNumber)+1. Each runPlannerFlow()
 *     call receives a fresh ':memory:' database with no rows, so max=0 and
 *     nextEpicId returns epic-001, which the standalone path converts to
 *     story-001. Both baseline and instrumented runs therefore produce the same
 *     path prefix. If this invariant breaks, the bPaths.length assertion below
 *     fires with the actual paths, giving an actionable error message.
 *
 * ASSERTION DIRECTION (one-way — encoding the fail-open trade-off):
 *   Extra rows in run_metrics / run_metrics_phase  →  PASS (acceptable)
 *   Any change to stdout / audit_log / artifacts   →  FAIL (violation)
 *
 * A metrics row dropped because recordRun throws is acceptable; a perturbed
 * run output is not.  This test IS the enforcement mechanism for NFR-1/ADR-4.
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { RunMetricsCollector } from '../RunMetricsCollector.js';
import { bindActiveCollector, clearActiveCollector } from '../activeCollector.js';
import { instrumentLLMClient } from '../instrumentLLMClient.js';
import { MetricsStore } from '../../state/MetricsStore.js';
import { createDatabase } from '../../state/Database.js';
import { Planner } from '../../planner/Planner.js';
import { MockLLMClient } from '../../llm/MockLLMClient.js';
import type { LLMClient, LLMRequest } from '../../llm/LLMClient.js';
import type { EffectiveRouting } from '../../intake/routing.js';

// ─── SQL injection guard ──────────────────────────────────────────────────────
// countRows() interpolates the table name directly into SQL. Restrict to the
// known tables used in this test so a future caller cannot pass a computed
// or user-derived string and accidentally introduce an injection vector.
const ALLOWED_TABLES = new Set<string>(['run_metrics', 'run_metrics_phase', 'audit_log']);

// ─── Deterministic LLM fixture responses ─────────────────────────────────────
// Fixed strings — no embedded wall-clock values — so artifact files are
// byte-identical across runs regardless of when they execute.

const ANALYST_BRIEF_TEXT = '# Login Form\n\nA simple email-and-password login form.';

const STORY_TEMPLATE = {
  title: 'Add login form',
  description: 'Build a minimal login form with email and password fields.',
  acceptance_criteria: ['The form submits credentials to /api/login'],
  estimated_complexity: 'small' as const,
  dependencies: [] as string[],
  tech_notes: 'Use the existing AuthService for validation.',
};

function makeResponder(): (req: LLMRequest) => string {
  return (req: LLMRequest): string => {
    // content is typed string; cast through unknown to guard against unexpected
    // runtime ContentBlock[] variants from SDK version drift.
    const raw: unknown = req.messages[req.messages.length - 1].content;
    const last = typeof raw === 'string' ? raw : JSON.stringify(raw);
    // Analyst phase: produce the project brief document
    if (
      last.includes('brief to analyze') ||
      last.includes('Produce the project brief document')
    ) {
      return ANALYST_BRIEF_TEXT;
    }
    // StandaloneStoryAgent phase: produce a single story JSON
    if (last.includes('Produce a single story definition in JSON')) {
      const match = /Story id: "([^"]+)"/.exec(last);
      const storyId = match?.[1] ?? 'story-001';
      return '```json\n' + JSON.stringify({ ...STORY_TEMPLATE, id: storyId }) + '\n```';
    }
    throw new Error(`Unexpected planning message (${last.length}B): ${last.slice(0, 200)}`);
  };
}

// Routes to the standalone path so only analyst + standalone_plan phases run.
const STANDALONE_ROUTING: EffectiveRouting = {
  type: 'feature',
  size: 'story',
  confidence: 'high',
  source: 'classifier',
};

// ─── process.stdout capture ───────────────────────────────────────────────────
// Intercepts process.stdout.write for the duration of `fn()` and returns all
// bytes written as a Buffer. Passes through to the real stdout (non-suppressing).
// Serial only — not safe for concurrent calls. Throws immediately if called
// while another captureStdout is active.

let _captureStdoutActive = false;

async function captureStdout(fn: () => Promise<unknown>): Promise<Buffer> {
  if (_captureStdoutActive) {
    throw new Error('captureStdout: concurrent call detected — not re-entrant-safe');
  }
  _captureStdoutActive = true;

  const chunks: Buffer[] = [];
  const origWrite = process.stdout.write;

  // Double-cast required: process.stdout.write is an overloaded interface
  // that cannot be reassigned to a simpler signature without explicit assertions.
  process.stdout.write = ((chunk: string | Uint8Array, ...rest: unknown[]): boolean => {
    chunks.push(
      typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : Buffer.from(chunk),
    );
    return (origWrite as unknown as (c: string | Uint8Array, ...r: unknown[]) => boolean)
      .call(process.stdout, chunk, ...rest);
  }) as unknown as typeof process.stdout.write;

  try {
    await fn();
  } finally {
    process.stdout.write = origWrite;
    _captureStdoutActive = false;
  }

  return Buffer.concat(chunks);
}

// ─── Comparison-surface readers ───────────────────────────────────────────────

// AUDIT_LOG surface: stable columns only (id/timestamp excluded).
interface AuditRow {
  action: string;
  command: string | null;
  allowed: number | null;
  policy_rule: string | null;
  detail: string | null;
}

function readAuditRows(db: Database.Database): AuditRow[] {
  return db
    .prepare(
      'SELECT action, command, allowed, policy_rule, detail FROM audit_log ORDER BY id ASC',
    )
    .all() as AuditRow[];
}

// WORKTREE ARTIFACTS surface: all regular files under planningRoot, keyed by
// relative path (POSIX separators for cross-platform stability), sorted.
function readArtifacts(planningRoot: string): Map<string, Buffer> {
  const result = new Map<string, Buffer>();
  if (!fs.existsSync(planningRoot)) return result;

  function walk(dir: string, prefix: string): void {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        walk(full, rel);
      } else if (entry.isFile()) {
        result.set(rel, fs.readFileSync(full));
      }
    }
  }

  walk(planningRoot, '');
  return result;
}

function countRows(db: Database.Database, table: string): number {
  if (!ALLOWED_TABLES.has(table)) {
    throw new Error(`countRows: table '${table}' is not in the allowed list`);
  }
  return (db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
}

// ─── Flow runner ──────────────────────────────────────────────────────────────

interface FlowResult {
  stdout: Buffer;
  auditRows: AuditRow[];
  artifacts: Map<string, Buffer>;
  db: Database.Database;
  projectRoot: string;
}

async function runPlannerFlow(opts: {
  withCollector: boolean;
  // When true and withCollector is true, the metrics write step is skipped.
  // This is equivalent to recordRun throwing and being swallowed in the
  // caller's try/catch — the fail-open arm. The option name "skipMetricsWrite"
  // reflects that we omit the recordRun call; a dropped row is acceptable under
  // NFR-1, a perturbed run is not.
  skipMetricsWrite?: boolean;
  // tmpDirs receives projectRoot immediately after mkdtempSync so the directory
  // is cleaned up even if the function throws later in its body.
  tmpDirs: string[];
}): Promise<FlowResult> {
  clearActiveCollector();

  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'loom-obs-'));
  // Push immediately — ensures cleanup even on a mid-function throw.
  opts.tmpDirs.push(projectRoot);

  const db = createDatabase(':memory:');

  const rawLlm = new MockLLMClient(makeResponder());
  // The LLM client is wrapped with the instrumented decorator on the
  // instrumented path, raw on the baseline path. The responses are identical.
  const llm: LLMClient = opts.withCollector ? instrumentLLMClient(rawLlm) : rawLlm;

  let collector: RunMetricsCollector | undefined;
  if (opts.withCollector) {
    collector = new RunMetricsCollector();
    // scope must be set before build(); 'standalone_story' matches the routing.
    collector.setAttribution({ scope: 'standalone_story' });
    bindActiveCollector(collector);
  }

  const planner = new Planner({
    projectRoot,
    llm,
    model: 'mock-model',
    db,
    routing: STANDALONE_ROUTING,
  });

  const stdout = await captureStdout(() => planner.run('Build a login form.'));
  clearActiveCollector();

  if (opts.withCollector && collector && !opts.skipMetricsWrite) {
    // Persist metrics — this is what story-063-004 does at run end.
    // In production code this is wrapped in try/catch; in the fail-open arm
    // it is intentionally omitted (skipMetricsWrite=true), leaving 0 rows.
    new MetricsStore(db).recordRun(collector.build());
  }

  const planningRoot = path.join(projectRoot, '.loom', 'planning');

  return {
    stdout,
    auditRows: readAuditRows(db),
    artifacts: readArtifacts(planningRoot),
    db,
    projectRoot,
  };
}

// ─── Test suite ───────────────────────────────────────────────────────────────

describe('observe-only verification (NFR-1 / ADR-4)', () => {
  let tmpDirs: string[] = [];
  let baseline: FlowResult;
  let instrumented: FlowResult;
  let failOpen: FlowResult;

  before(async () => {
    // Run 1 — BASELINE: no collector bound, raw MockLLMClient.
    // tmpDirs receives projectRoot inside runPlannerFlow, so no push needed here.
    baseline = await runPlannerFlow({ withCollector: false, tmpDirs });

    // Run 2 — INSTRUMENTED: collector bound + instrumentLLMClient + recordRun
    // persists the metrics row (simulates what story-063-004 does at run end).
    instrumented = await runPlannerFlow({ withCollector: true, tmpDirs });

    // Run 3 — FAIL-OPEN: collector bound + instrumentLLMClient, but the metrics
    // write is intentionally skipped (skipMetricsWrite=true). This simulates
    // recordRun throwing and being swallowed. The three surfaces must still be
    // byte-identical to baseline even when the metrics row is never written.
    failOpen = await runPlannerFlow({ withCollector: true, skipMetricsWrite: true, tmpDirs });
  });

  after(() => {
    clearActiveCollector();
    // Close DB handles before removing temp dirs to avoid WAL/SHM leaks.
    baseline?.db.close();
    instrumented?.db.close();
    failOpen?.db.close();
    for (const d of tmpDirs) {
      fs.rmSync(d, { recursive: true, force: true });
    }
    tmpDirs = [];
  });

  // ─── AC1 + AC3: instrumented run vs baseline ───────────────────────────────

  it('stdout [AC1, AC3]: byte-identical between baseline and instrumented run', () => {
    // SURFACE 1 — stdout (see file-level JSDoc for normalization contract).
    // The standalone Planner path writes nothing to stdout; both buffers are
    // empty. The assertion is still present to catch future regressions.
    assert.ok(
      baseline.stdout.equals(instrumented.stdout),
      `stdout differs: baseline=${baseline.stdout.length}B instrumented=${instrumented.stdout.length}B`,
    );
  });

  it('audit_log [AC1, AC3]: byte-identical on action/command/allowed/policy_rule/detail', () => {
    // SURFACE 2 — audit_log (columns listed; id and timestamp excluded).
    // The standalone path writes 0 audit_log rows in both runs.
    assert.deepEqual(
      instrumented.auditRows,
      baseline.auditRows,
      'audit_log content differs between baseline and instrumented run',
    );
  });

  it('worktree artifacts [AC1, AC3]: same paths and byte-identical content', () => {
    // SURFACE 3 — worktree artifacts (all files under planningRoot).
    // Expected files: story-001/project-brief.md and story-001/epics/story-001.yaml
    // (see file-level JSDoc for the runId determinism argument).
    const bPaths = [...baseline.artifacts.keys()].sort();
    const iPaths = [...instrumented.artifacts.keys()].sort();

    assert.deepEqual(
      iPaths,
      bPaths,
      'artifact file paths differ between baseline and instrumented run',
    );
    assert.ok(
      bPaths.length >= 2,
      `expected ≥2 artifacts (story-001/project-brief.md, story-001/epics/story-001.yaml) but got: ${JSON.stringify(bPaths)}`,
    );

    for (const rel of bPaths) {
      const bBuf = baseline.artifacts.get(rel)!;
      const iBuf = instrumented.artifacts.get(rel)!;
      assert.ok(
        bBuf.equals(iBuf),
        `artifact '${rel}' content differs: baseline=${bBuf.length}B instrumented=${iBuf.length}B`,
      );
    }
  });

  // ─── AC2: metrics delta ────────────────────────────────────────────────────

  it('run_metrics [AC2]: 0 rows in baseline, ≥1 row in instrumented run', () => {
    assert.equal(
      countRows(baseline.db, 'run_metrics'),
      0,
      'baseline must have 0 run_metrics rows',
    );
    assert.ok(
      countRows(instrumented.db, 'run_metrics') >= 1,
      'instrumented must have ≥1 run_metrics row after recordRun',
    );
  });

  it('run_metrics_phase [AC2]: 0 rows in baseline, ≥1 row in instrumented run', () => {
    assert.equal(
      countRows(baseline.db, 'run_metrics_phase'),
      0,
      'baseline must have 0 run_metrics_phase rows',
    );
    assert.ok(
      countRows(instrumented.db, 'run_metrics_phase') >= 1,
      'instrumented must have ≥1 run_metrics_phase row after recordRun',
    );
  });

  // One-way assertion: extra metrics rows are the ONLY delta and must not be
  // treated as a violation. The surface assertions above already prove the
  // negative side (any surface change fails). This test proves the positive
  // side: instrumented has MORE run_metrics rows than baseline, confirming
  // the "extra metrics rows PASS" direction of the one-way contract.
  it('one-way [AC1, AC2]: instrumented has more run_metrics rows than baseline; surfaces unchanged', () => {
    const baseMetrics = countRows(baseline.db, 'run_metrics');
    const instrMetrics = countRows(instrumented.db, 'run_metrics');
    assert.ok(
      instrMetrics > baseMetrics,
      `instrumented (${instrMetrics}) must have more run_metrics rows than baseline (${baseMetrics})`,
    );
    // The surface assertions in the tests above have already confirmed that
    // stdout, audit_log, and artifacts are byte-identical. We re-assert
    // audit_log row count here explicitly to make the "sole delta" claim
    // concrete and unambiguous.
    assert.equal(
      countRows(instrumented.db, 'audit_log'),
      countRows(baseline.db, 'audit_log'),
      'audit_log row count must be identical (instrumentation must not insert into audit_log)',
    );
  });

  // ─── AC1 + AC2: fail-open arm ─────────────────────────────────────────────
  // When recordRun throws (simulated by skipMetricsWrite=true), the three
  // surfaces must remain byte-identical to baseline. A dropped metrics row is
  // acceptable; a perturbed run is not.

  it('stdout [AC1, AC2, fail-open]: byte-identical to baseline when recordRun is dropped', () => {
    assert.ok(
      baseline.stdout.equals(failOpen.stdout),
      `stdout differs in fail-open arm: baseline=${baseline.stdout.length}B failOpen=${failOpen.stdout.length}B`,
    );
  });

  it('audit_log [AC1, AC2, fail-open]: byte-identical to baseline when recordRun is dropped', () => {
    assert.deepEqual(
      failOpen.auditRows,
      baseline.auditRows,
      'audit_log content differs in fail-open arm',
    );
  });

  it('worktree artifacts [AC1, AC2, fail-open]: byte-identical to baseline when recordRun is dropped', () => {
    const bPaths = [...baseline.artifacts.keys()].sort();
    const fPaths = [...failOpen.artifacts.keys()].sort();

    assert.deepEqual(fPaths, bPaths, 'artifact paths differ in fail-open arm');

    for (const rel of bPaths) {
      const bBuf = baseline.artifacts.get(rel)!;
      const fBuf = failOpen.artifacts.get(rel)!;
      assert.ok(
        bBuf.equals(fBuf),
        `artifact '${rel}' differs in fail-open arm: baseline=${bBuf.length}B failOpen=${fBuf.length}B`,
      );
    }
  });

  it('run_metrics [AC2, fail-open]: 0 rows when recordRun is dropped (dropped row is acceptable)', () => {
    // A dropped metrics row is acceptable under the fail-open contract.
    // The run output is unperturbed; only the metrics row is missing.
    assert.equal(
      countRows(failOpen.db, 'run_metrics'),
      0,
      'fail-open run must have 0 run_metrics rows (metrics write was not persisted)',
    );
    assert.equal(
      countRows(failOpen.db, 'run_metrics_phase'),
      0,
      'fail-open run must have 0 run_metrics_phase rows',
    );
  });
});
