import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { z } from 'zod';
import type Database from 'better-sqlite3';

import { createDatabase } from '../../src/state/Database.js';
import { EpicStore } from '../../src/state/EpicStore.js';
import { AgentStore } from '../../src/state/AgentStore.js';
import { AuditLog } from '../../src/state/AuditLog.js';
import { SkillStore } from '../../src/skills/SkillStore.js';
import { SourcesConfig } from '../../src/skills/SourcesConfig.js';
import {
  registerSkill,
  getSkillDefinition,
  invokeSkill,
  type SkillDefinition,
} from '../../src/skills/types.js';
import { ReviewerOutput } from '../../src/findings/schema.js';
import { Investigation } from '../../src/findings/investigation.js';
import { SOURCE } from '../../src/findings/sources.js';
import { runReviewPass, type AuditSink } from '../../src/review/orchestrator.js';
import { skillReviewer, type ReviewerRunner } from '../../src/review/reviewer.js';
import { adaptCodeReviewReport } from '../../src/review/codeReviewAdapter.js';
import type { ReviewReport } from '../../src/review/types.js';
import { investigateAndRoute } from '../../src/failure/investigateAndRoute.js';
import type { FailurePayload, RouteDecision } from '../../src/failure/router.js';
import { withHiddenBmadPaths } from '../fixtures/headlessPurity.js';

// ─── Fixture loading ────────────────────────────────────────────────────────
//
// Fixtures live in source (`test/e2e/fixtures/seedStory/`) and are NOT copied
// into dist-test by tsc, so locate them by walking up from the compiled test
// file to the package root — the same shape the skill tests use for skills/.

const FIXTURE_MARKER = path.join('test', 'e2e', 'fixtures', 'seedStory', 'seed-story.json');

function seedFixturesDir(): string {
  let dir = __dirname;
  for (let i = 0; i < 12; i++) {
    if (fs.existsSync(path.join(dir, FIXTURE_MARKER))) {
      return path.join(dir, 'test', 'e2e', 'fixtures', 'seedStory');
    }
    dir = path.dirname(dir);
  }
  throw new Error('could not locate seed-story fixtures');
}

function repoRoot(): string {
  let dir = __dirname;
  for (let i = 0; i < 12; i++) {
    if (fs.existsSync(path.join(dir, 'docs', 'capabilities.md'))) return dir;
    dir = path.dirname(dir);
  }
  throw new Error('could not locate repo root (docs/capabilities.md)');
}

interface SeedStory {
  story_id: string;
  epic_id: string;
  title: string;
  description: string;
  acceptance_criteria: string[];
  changed_files: string[];
  story_context: string;
}

function loadFixtures(): { story: SeedStory; diff: string; gateFailure: string } {
  const dir = seedFixturesDir();
  const story = JSON.parse(
    fs.readFileSync(path.join(dir, 'seed-story.json'), 'utf8'),
  ) as SeedStory;
  return {
    story,
    diff: fs.readFileSync(path.join(dir, 'diff.patch'), 'utf8'),
    gateFailure: fs.readFileSync(path.join(dir, 'gate-failure.log'), 'utf8'),
  };
}

const FIVE_SKILLS = [
  'adversarial-review',
  'edge-case-hunter',
  'failure-investigator',
  'doc-distiller',
  'lesson-extractor',
] as const;

// ─── Deterministic skill behavior for the seed run ──────────────────────────
//
// The real SKILL.md bodies are LLM-driven and cannot run headlessly, so the
// seed harness swaps in fixture-derived handlers — exactly the seam
// investigateAndRoute.test.ts uses. Every handler's output is still validated
// against the frozen findings schema, so the orchestration wiring (skill
// invocation → provenance rows → dedupe → routing) is exercised for real.

const ZERO_DIVISOR = 'divide() does not guard against a zero divisor';

function adversarialFindings(): ReviewerOutput {
  return {
    findings: [
      {
        severity: 'high',
        category: 'correctness',
        location: { file: 'src/math.ts', line: 6 },
        description: ZERO_DIVISOR,
        source: SOURCE.ADVERSARIAL,
      },
    ],
  };
}

function edgeCaseFindings(): ReviewerOutput {
  return {
    findings: [
      // Same (file, line) + normalization-equivalent description as the
      // adversarial finding — must collapse to one under dedupe.
      {
        severity: 'high',
        category: 'edge-case',
        location: { file: 'src/math.ts', line: 6 },
        description: 'Divide() does not guard against a zero divisor.',
        source: SOURCE.EDGE_CASE,
      },
      {
        severity: 'medium',
        category: 'edge-case',
        location: { file: 'src/math.ts', line: 6 },
        description: 'non-numeric inputs are not rejected',
        source: SOURCE.EDGE_CASE,
      },
    ],
  };
}

// Drives the real code-review adapter (story-003) from a fixture report so the
// seed run surfaces any latent adapter mapping bug, per the architect's note.
const CODE_REVIEW_REPORT: ReviewReport = {
  summary: 'one blocker on the new divide() helper',
  findings: [
    {
      severity: 'blocker',
      file: 'src/math.ts',
      line: 6,
      issue: 'divide returns Infinity for a zero divisor instead of throwing',
      suggestion: 'throw a RangeError when b === 0',
    },
  ],
};

const INVESTIGATION = {
  grade: 'strong' as const,
  hypothesis: 'the new divide() helper has no zero-divisor guard, so the gate test that expects a throw fails',
  hint: 'guard divide() against b === 0 (throw) before returning the quotient',
  evidence_refs: ['src/math.ts:6', 'stderr: expected divide(1, 0) to throw, but it returned Infinity'],
};

function codeReviewRunner(report: ReviewReport): ReviewerRunner {
  return {
    source: SOURCE.CODE_REVIEW,
    run: async () => ({ findings: adaptCodeReviewReport(report) }),
  };
}

interface RunContext {
  story_id: string;
  epic_id: string;
  agent_id: string;
}

interface SeedRunResult {
  reviewPass: Awaited<ReturnType<typeof runReviewPass>>;
  routeDecision: RouteDecision;
}

/**
 * Run the designated seed story end to end against a real loom database:
 *   1. the block-and-revise review fan-out (adversarial-review +
 *      edge-case-hunter via the skill seam, plus the real code-review adapter),
 *   2. the injected gate failure routed through failure-investigator.
 * The three skill handlers are overridden for the duration of the run and
 * restored before returning, so sibling tests see the registry untouched.
 */
async function runSeedStory(
  db: Database.Database,
  ctx: RunContext,
  fixtures: { story: SeedStory; diff: string; gateFailure: string },
): Promise<SeedRunResult> {
  const saved: Array<[string, SkillDefinition<unknown, unknown> | undefined]> = [
    SOURCE.ADVERSARIAL,
    SOURCE.EDGE_CASE,
    'failure-investigator',
  ].map((name) => [name, getSkillDefinition(name)]);

  try {
    registerSkill({
      name: SOURCE.ADVERSARIAL,
      inputSchema: z.unknown(),
      outputSchema: ReviewerOutput,
      handler: () => adversarialFindings(),
    });
    registerSkill({
      name: SOURCE.EDGE_CASE,
      inputSchema: z.unknown(),
      outputSchema: ReviewerOutput,
      handler: () => edgeCaseFindings(),
    });
    registerSkill({
      name: 'failure-investigator',
      inputSchema: z.unknown(),
      outputSchema: Investigation,
      handler: () => INVESTIGATION,
    });

    const skillCtx = {
      db,
      story_id: ctx.story_id,
      epic_id: ctx.epic_id,
      agent_id: ctx.agent_id,
    };
    const log = new AuditLog(db);
    const audit: AuditSink = {
      record: (action, detail) =>
        log.record({ agent_id: ctx.agent_id, action, command: ctx.story_id, detail }),
    };

    const reviewPass = await runReviewPass(
      {
        diff: fixtures.diff,
        changed_files: fixtures.story.changed_files,
        story_context: fixtures.story.story_context,
      },
      {
        story_id: ctx.story_id,
        epic_id: ctx.epic_id,
        revision_index: 0,
        reviewers: [
          skillReviewer(SOURCE.ADVERSARIAL, skillCtx),
          skillReviewer(SOURCE.EDGE_CASE, skillCtx),
          codeReviewRunner(CODE_REVIEW_REPORT),
        ],
        audit,
      },
    );

    // The review found a blocker — the worker revises, the integration gate
    // re-runs, and (the injected failure) it goes red. Route that failure.
    const payload: FailurePayload = {
      failing_test_or_gate: 'npm test',
      stderr_tail: fixtures.gateFailure,
      diff: fixtures.diff,
      story_id: ctx.story_id,
    };
    const routeDecision = await investigateAndRoute(payload, {
      db,
      epic_id: ctx.epic_id,
      agent_id: ctx.agent_id,
    });

    return { reviewPass, routeDecision };
  } finally {
    for (const [name, def] of saved) if (def) registerSkill(def);
  }
}

// ─── The seed-story end-to-end run ──────────────────────────────────────────

describe('seed-story end-to-end run (story-001-007)', () => {
  let tmp: string;
  let db: Database.Database;
  let fixtures: ReturnType<typeof loadFixtures>;
  let result: SeedRunResult;

  function count(table: string, where: string, ...params: unknown[]): number {
    const row = db
      .prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE ${where}`)
      .get(...params) as { n: number };
    return row.n;
  }

  function latestDetail(action: string): Record<string, unknown> {
    const row = db
      .prepare('SELECT detail FROM audit_log WHERE action = ? ORDER BY id DESC LIMIT 1')
      .get(action) as { detail: string | null } | undefined;
    assert.ok(row, `expected an audit row for ${action}`);
    return JSON.parse(row!.detail ?? '{}');
  }

  before(async () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'loom-seed-'));
    db = createDatabase(path.join(tmp, '.loom', 'loom.db'));
    fixtures = loadFixtures();
    const { story } = fixtures;
    new EpicStore(db).create(story.epic_id, story.title);
    const agent = new AgentStore(db).create(story.epic_id, story.story_id, story.title);
    result = await runSeedStory(
      db,
      { story_id: story.story_id, epic_id: story.epic_id, agent_id: agent.id },
      fixtures,
    );
  });

  after(() => {
    db.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('invokes the two ported reviewers and the code-review adapter, deduping the overlapping finding', () => {
    // adversarial(high) + edge-case(high, dup) + edge-case(medium) + code-review(blocker)
    // = 4 union, 3 after the two highs collapse.
    assert.equal(result.reviewPass.findings.length, 3);
    const deduped = latestDetail('review.findings.deduped');
    assert.equal(deduped.union_count, 4);
    assert.equal(deduped.deduped_count, 3);

    const statuses = Object.fromEntries(
      result.reviewPass.per_reviewer_status.map((s) => [s.source, s.status]),
    );
    assert.equal(statuses[SOURCE.ADVERSARIAL], 'ok');
    assert.equal(statuses[SOURCE.EDGE_CASE], 'ok');
    assert.equal(statuses[SOURCE.CODE_REVIEW], 'ok');
  });

  it('the surviving blocker (mapped by the real code-review adapter) triggers a revision', () => {
    assert.equal(result.reviewPass.triggers_revision, true);
    const blocker = result.reviewPass.findings.find((f) => f.severity === 'blocker');
    assert.ok(blocker, 'the code-review blocker survives dedupe');
    assert.equal(blocker!.source, SOURCE.CODE_REVIEW);
    assert.equal(count('audit_log', "action = 'review.revision.triggered' AND command = ?", 'story-seed-001'), 1);
  });

  it('writes skill_usage + audit_log rows for adversarial-review and edge-case-hunter', () => {
    for (const skill of [SOURCE.ADVERSARIAL, SOURCE.EDGE_CASE]) {
      assert.equal(
        count('skill_usage', 'skill_name = ? AND story_id = ?', skill, 'story-seed-001'),
        1,
        `${skill} should have one skill_usage row`,
      );
      assert.equal(
        count('audit_log', "action = 'skill_invoked' AND command = ?", skill),
        1,
        `${skill} should have one skill_invoked audit row`,
      );
    }
  });

  it('exercises failure-investigator on the injected failure with full provenance', () => {
    assert.equal(
      count('skill_usage', 'skill_name = ? AND story_id = ?', 'failure-investigator', 'story-seed-001'),
      1,
      'failure-investigator should have one skill_usage row',
    );
    assert.equal(
      count('audit_log', "action = 'skill_invoked' AND command = ?", 'failure-investigator'),
      1,
      'failure-investigator should have one skill_invoked audit row',
    );
    // The investigation grade and the routed decision both land in audit_log.
    assert.equal(count('audit_log', "action = 'failure.investigation.graded' AND command = ?", 'story-seed-001'), 1);
    assert.equal(latestDetail('failure.investigation.graded').grade, 'strong');
    assert.equal(count('audit_log', "action = 'failure.routed.retry_with_hint' AND command = ?", 'story-seed-001'), 1);
  });

  it('routes the strong-graded failure to retry-with-hint and threads the hint through', () => {
    assert.equal(result.routeDecision.kind, 'retry-with-hint');
    assert.equal(
      (result.routeDecision as { hint: string }).hint,
      INVESTIGATION.hint,
    );
    assert.equal(latestDetail('failure.routed.retry_with_hint').hint, INVESTIGATION.hint);
  });

  it('attributes every provenance row to the seed story (reachable via getByStory)', () => {
    const rows = new AuditLog(db).getByStory('story-seed-001', 200);
    const actions = new Set(rows.map((r) => r.action));
    for (const action of [
      'skill_invoked',
      'review.findings.deduped',
      'review.revision.triggered',
      'failure.investigation.graded',
      'failure.routed.retry_with_hint',
    ]) {
      assert.ok(actions.has(action), `getByStory should surface ${action}`);
    }
  });
});

// ─── Headless purity across all five ported skill bodies ────────────────────

describe('headless purity across all five ported skills (story-001-007)', () => {
  let tmp: string;
  let db: Database.Database;
  let agentId: string;

  function isolatedStore(): SkillStore {
    let dir = __dirname;
    let skillsDir = '';
    for (let i = 0; i < 12; i++) {
      const candidate = path.join(dir, 'skills');
      if (fs.existsSync(path.join(candidate, 'adversarial-review', 'SKILL.md'))) {
        skillsDir = candidate;
        break;
      }
      dir = path.dirname(dir);
    }
    assert.ok(skillsDir, 'could not locate repo-root skills/ directory');
    return new SkillStore({
      projectRoot: path.join(tmp, 'project'),
      globalSkillsDir: path.join(tmp, 'no-global'),
      bundledSkillsDir: skillsDir,
      sharedMirrorRoot: path.join(tmp, 'no-shared'),
      sourcesConfig: new SourcesConfig([], path.join(tmp, 'no-sources.yaml')),
    });
  }

  before(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'loom-purity-'));
    fs.mkdirSync(path.join(tmp, 'project'), { recursive: true });
    db = createDatabase(':memory:');
    new EpicStore(db).create('epic-seed', 'Review Forge');
    agentId = new AgentStore(db).create('epic-seed', 'story-seed-001').id;
  });

  after(() => {
    db.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('loads and invokes every filled SKILL.md body with the bmad runtime hidden', async () => {
    await withHiddenBmadPaths(async () => {
      const store = isolatedStore();
      for (const skill of FIVE_SKILLS) {
        const body = store.load(skill);
        assert.ok(body, `${skill} body must load with _bmad hidden`);
        // The bodies are filled (not bare scaffolds) by stories 002/004/005/006.
        assert.ok(body!.length > 200, `${skill} body should be a filled body, not a stub`);
        assert.ok(!body!.includes('_bmad'), `${skill} body must not reference _bmad`);

        const result = await invokeSkill(
          { name: skill, input: {}, story_id: 'story-seed-001', epic_id: 'epic-seed' },
          { db, agent_id: agentId },
        );
        assert.ok(result.output, `${skill} should produce schema-valid output headlessly`);
      }
    });
  });
});

// ─── Capabilities-page invariant (AC1) ──────────────────────────────────────

describe('docs/capabilities.md lists every ported skill (story-001-007)', () => {
  it('names all five Review Forge skills', () => {
    const body = fs.readFileSync(path.join(repoRoot(), 'docs', 'capabilities.md'), 'utf8');
    for (const skill of FIVE_SKILLS) {
      assert.ok(body.includes(`\`${skill}\``), `capabilities.md must document \`${skill}\``);
    }
  });
});

// ─── Capabilities-page invariant (epic-003) ─────────────────────────────────

describe('docs/capabilities.md documents all epic-003 surfaces (story-003-007)', () => {
  let body: string;
  before(() => {
    body = fs.readFileSync(path.join(repoRoot(), 'docs', 'capabilities.md'), 'utf8');
  });

  const requiredStrings: Array<[string, string]> = [
    ['/api/inbox', 'cross-epic inbox route'],
    ['/api/fleet', 'fleet board route'],
    ['POST /api/epics/:id/autonomy', 'autonomy-setting web route'],
    ['loom_set_autonomy', 'loom_set_autonomy MCP tool'],
    ['loom web --read-only', 'read-only CLI flag'],
    ['LOOM_WEB_READONLY', 'LOOM_WEB_READONLY env var'],
    ['log_tail', 'operator sensitivity note about SSE log_tail data'],
  ];

  for (const [needle, label] of requiredStrings) {
    it(`contains ${label}`, () => {
      assert.ok(body.includes(needle), `capabilities.md must contain "${needle}" (${label})`);
    });
  }
});
