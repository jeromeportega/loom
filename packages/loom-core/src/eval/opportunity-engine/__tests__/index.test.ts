import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

// __dirname resolves to dist/eval/opportunity-engine/__tests__/ at runtime.
// Workspace root is 6 levels up: dist/eval/opportunity-engine/__tests__ → … → worktree root.
const WORKTREE_ROOT = path.resolve(__dirname, '../../../../../../');

// ── Top-barrel discipline — ADR-001 (AC2) ─────────────────────────────────────

describe('top-barrel discipline — ADR-001 (AC2)', () => {
  it('src/eval/index.ts gains ZERO opportunity-engine re-export lines (compiled JS check)', () => {
    // Per ADR-001: the opportunity-engine consumer is reached via deep import only.
    // The compiled top barrel must never reference opportunity-engine.
    const topBarrelPath = path.resolve(__dirname, '../../index.js');
    const source = fs.readFileSync(topBarrelPath, 'utf8');

    const opportunityLines = source
      .split('\n')
      .filter((line) => line.includes('opportunity-engine'));

    assert.equal(
      opportunityLines.length,
      0,
      `Expected zero opportunity-engine lines in dist/eval/index.js, found:\n${opportunityLines.join('\n')}`,
    );
  });

  it('consumer is reachable via deep import — createOpportunityEngineConsumer is exported from sub-barrel', async () => {
    // The consumer is reached via direct deep import, not through the top barrel.
    // Verify the sub-barrel (index.ts in this directory) exports the factory function.
    const subBarrel = await import('../index.js');

    assert.equal(
      typeof (subBarrel as Record<string, unknown>).createOpportunityEngineConsumer,
      'function',
      'createOpportunityEngineConsumer must be exported from the sub-barrel',
    );
  });
});

// ── Sub-barrel surface — src/eval/opportunity-engine/index.ts (AC1) ──────────

describe('sub-barrel surface — opportunity-engine/index.ts (AC1)', () => {
  it('re-exports key symbols from caseSchema', async () => {
    const m = await import('../index.js') as Record<string, unknown>;
    assert.ok('OpportunityEngineCaseSchema' in m, 'must export OpportunityEngineCaseSchema');
  });

  it('re-exports key symbols from loadCases', async () => {
    const m = await import('../index.js') as Record<string, unknown>;
    assert.equal(typeof m.loadOpportunityEngineCases, 'function');
    assert.equal(typeof m.defaultFixturePath, 'function');
  });

  it('re-exports key symbols from models', async () => {
    const m = await import('../index.js') as Record<string, unknown>;
    assert.equal(typeof m.resolveOpportunityEngineModels, 'function');
    assert.ok('DEFAULT_GATE_MODEL' in m);
  });

  it('re-exports key symbols from judgeTypes', async () => {
    const m = await import('../index.js') as Record<string, unknown>;
    assert.ok('OpportunityEngineJudgmentSchema' in m);
  });

  it('re-exports key symbols from runGate', async () => {
    const m = await import('../index.js') as Record<string, unknown>;
    assert.equal(typeof m.runOpportunityEngineGate, 'function');
  });

  it('re-exports key symbols from judge', async () => {
    const m = await import('../index.js') as Record<string, unknown>;
    assert.equal(typeof m.judgeOpportunityClusters, 'function');
  });

  it('re-exports key symbols from score', async () => {
    const m = await import('../index.js') as Record<string, unknown>;
    assert.equal(typeof m.scoreOpportunityEngine, 'function');
    assert.equal(typeof m.opportunityEngineVerdict, 'function');
    assert.ok('OPPORTUNITY_ENGINE_THRESHOLDS' in m);
    assert.ok('DEFAULT_QUALITY_BAR' in m);
  });

  it('re-exports createOpportunityEngineConsumer from consumer', async () => {
    const m = await import('../index.js') as Record<string, unknown>;
    assert.equal(typeof m.createOpportunityEngineConsumer, 'function');
  });

  it('does NOT export GateOutcome or JudgeOutcome (ADR-001 collision guard)', async () => {
    // These are generic framework types; re-exporting them from a consumer sub-barrel
    // causes wildcard-collision failure at the top barrel.
    const m = await import('../index.js') as Record<string, unknown>;
    assert.ok(!('GateOutcome' in m), 'must not export GateOutcome from sub-barrel');
    assert.ok(!('JudgeOutcome' in m), 'must not export JudgeOutcome from sub-barrel');
  });
});

// ── Runner script structure (AC3) ────────────────────────────────────────────

describe('runner script — eval-opportunity-engine.mjs (AC3)', () => {
  const scriptPath = path.join(WORKTREE_ROOT, 'scripts', 'eval-opportunity-engine.mjs');

  it('eval-opportunity-engine.mjs exists', () => {
    assert.ok(fs.existsSync(scriptPath), `expected ${scriptPath} to exist`);
  });

  it('imports main from the deep dist path (not from a barrel)', () => {
    const source = fs.readFileSync(scriptPath, 'utf8');
    assert.ok(
      source.includes('opportunity-engine/run.js'),
      'script must import from the deep path .../opportunity-engine/run.js',
    );
    assert.ok(
      !source.includes("eval/index"),
      'script must not import from any barrel — use the deep path only',
    );
  });

  it('references LOOM_EVAL_GATE_MODEL env var', () => {
    const source = fs.readFileSync(scriptPath, 'utf8');
    assert.ok(source.includes('LOOM_EVAL_GATE_MODEL'), 'must reference LOOM_EVAL_GATE_MODEL');
  });

  it('references LOOM_EVAL_JUDGE_MODEL env var', () => {
    const source = fs.readFileSync(scriptPath, 'utf8');
    assert.ok(source.includes('LOOM_EVAL_JUDGE_MODEL'), 'must reference LOOM_EVAL_JUDGE_MODEL');
  });

  it('matches sibling eval-lesson-extractor.mjs structure', () => {
    const scriptsDir = path.dirname(scriptPath);
    const lessonScript = path.join(scriptsDir, 'eval-lesson-extractor.mjs');
    const lessonSource = fs.readFileSync(lessonScript, 'utf8');
    const oeSource     = fs.readFileSync(scriptPath, 'utf8');

    // Both scripts import main from their respective deep dist paths
    assert.ok(lessonSource.includes('lesson-extractor/run.js'));
    assert.ok(oeSource.includes('opportunity-engine/run.js'));

    // Both resolve projectRoot to workspace root
    assert.ok(lessonSource.includes("path.resolve('.')"));
    assert.ok(oeSource.includes("path.resolve('.')"));

    // Both print decision and metrics
    assert.ok(oeSource.includes('report.decision.verdict'));
    assert.ok(oeSource.includes('report.metrics'));
  });
});

// ── package.json script entry (AC3) ──────────────────────────────────────────

describe('package.json eval:opportunity-engine script (AC3)', () => {
  it('root package.json contains the eval:opportunity-engine script', () => {
    const pkgPath = path.join(WORKTREE_ROOT, 'package.json');
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8')) as {
      scripts?: Record<string, string>;
    };

    assert.ok(
      pkg.scripts && 'eval:opportunity-engine' in pkg.scripts,
      'package.json must have eval:opportunity-engine script',
    );

    const script = pkg.scripts['eval:opportunity-engine'];
    assert.ok(
      script.includes('eval-opportunity-engine.mjs'),
      'script must invoke eval-opportunity-engine.mjs',
    );
    assert.ok(
      script.includes('npm run build'),
      'script must build loom-core before running the eval',
    );
  });
});

// ── Docs — eval runbook (AC4) ─────────────────────────────────────────────────

describe('eval docs — opportunity-engine-eval.md (AC4)', () => {
  const runbookPath = path.join(WORKTREE_ROOT, 'docs', 'runbooks', 'opportunity-engine-eval.md');

  it('docs/runbooks/opportunity-engine-eval.md exists', () => {
    assert.ok(fs.existsSync(runbookPath), `expected ${runbookPath} to exist`);
  });

  it('describes how to run the eval', () => {
    const content = fs.readFileSync(runbookPath, 'utf8');
    assert.ok(
      content.includes('npm run eval:opportunity-engine'),
      'runbook must document the npm script',
    );
  });

  it('documents LOOM_EVAL_GATE_MODEL env var', () => {
    const content = fs.readFileSync(runbookPath, 'utf8');
    assert.ok(content.includes('LOOM_EVAL_GATE_MODEL'));
  });

  it('documents LOOM_EVAL_JUDGE_MODEL env var', () => {
    const content = fs.readFileSync(runbookPath, 'utf8');
    assert.ok(content.includes('LOOM_EVAL_JUDGE_MODEL'));
  });
});

// ── Capabilities drift check (AC5) ───────────────────────────────────────────

describe('capabilities drift check (AC5)', () => {
  it('docs/capabilities.md contains opportunity-engine eval row', () => {
    const capPath = path.join(WORKTREE_ROOT, 'docs', 'capabilities.md');
    const content = fs.readFileSync(capPath, 'utf8');
    assert.ok(
      content.includes('eval:opportunity-engine'),
      'docs/capabilities.md must contain the eval:opportunity-engine row',
    );
    assert.ok(
      content.includes('opportunity-engine-report'),
      'docs/capabilities.md must mention the report output path',
    );
  });
});
