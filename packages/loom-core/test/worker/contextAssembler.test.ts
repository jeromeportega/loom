import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import type Database from 'better-sqlite3';
import { createDatabase } from '../../src/state/Database.js';
import { EpicStore } from '../../src/state/EpicStore.js';
import { AgentStore } from '../../src/state/AgentStore.js';
import {
  assembleWorkerContext,
  extractAcceptanceCriteria,
  formatArtifacts,
  defaultDistill,
  COMPRESSION_TARGET_RATIO,
  type PlanningArtifacts,
} from '../../src/worker/contextAssembler.js';
import { countTokens } from '../../src/worker/tokenCount.js';

/** Walk up from this compiled test file until repo-root skills/ is found. */
function docDistillerSkillPath(): string {
  let dir = __dirname;
  for (let i = 0; i < 10; i++) {
    const candidate = path.join(dir, 'skills', 'doc-distiller', 'SKILL.md');
    if (fs.existsSync(candidate)) return candidate;
    dir = path.dirname(dir);
  }
  throw new Error('could not locate skills/doc-distiller/SKILL.md');
}

const ACCEPTANCE_CRITERIA = [
  'doc-distiller SKILL.md contains no WAIT-FOR-USER directives, interactive halts, or _bmad/ path reads',
  'Distilled output on a sample story is <=55% of the input token count',
  'Every acceptance-criterion string from input artifacts appears verbatim in the distilled output (string-match assertion)',
  'Missing the compression target is logged but does not fail the run; dropping an acceptance criterion DOES fail the run',
  'Worker-context assembly invokes the skill exactly once per story and writes the usual skill_usage + audit_log rows',
];

/**
 * A deliberately verbose, cross-artifact-redundant set of planning artifacts —
 * the realistic shape (PRD, epic, architecture, and story all restate the same
 * project context). The redundancy is what the distiller compresses away.
 */
function sampleArtifacts(): PlanningArtifacts {
  const shared = [
    'Review Forge runs five review skills over every worker diff before a PR opens.',
    'The orchestrator dedupes findings by file, line, and normalized description.',
    'A blocker or high-severity finding triggers a single block-and-revise pass.',
    'Every skill writes a skill_usage row and an audit_log row before returning.',
    'Skills follow the agentskills.io format with lowercase-hyphen names.',
    'The policy engine is structural and blocks forbidden commands regardless of model output.',
    'Agents never push to protected branches; worktree isolation enforces this.',
    'Prompt caching is applied to persona system prompts and shared skill context.',
    'The findings schema is a shared zod contract owned by the first story of the epic.',
    'The adversarial reviewer and the edge-case hunter both emit the ReviewerOutput shape.',
    'The failure investigator grades evidence as strong, weak, or contradictory.',
    'A strong grade must carry a non-empty hint that routes the retry.',
    'The doc-distiller compresses planning artifacts to roughly half their token count.',
    'All five skills must load and run headless with the vendored runtime hidden.',
    'The supervisor injects worker-time skills at dispatch, not at planning time.',
    'State lives in better-sqlite3 tables: agents, audit_log, skill_usage.',
  ].join('\n\n');

  const prd = [
    '# Product Requirements',
    '',
    'It is worth noting that Review Forge is the headline capability of this epic.',
    '',
    shared,
    '',
    'The downstream consumer of these artifacts is the worker agent that implements each story.',
    'We believe the worker context is too large and should be compressed before dispatch.',
  ].join('\n');

  const epic = [
    '# Epic epic-001 — Review Forge',
    '',
    'As mentioned earlier, Review Forge runs five review skills over every worker diff.',
    '',
    shared,
    '',
    'This epic decomposes into seven stories, one of which ports the doc-distiller.',
  ].join('\n');

  const architecture = [
    '# Architecture',
    '',
    shared,
    '',
    'Decision: token counts reuse the cache-telemetry tokenizer. Reason: one consistent measure.',
    'Rejected: pulling a heavyweight BPE dependency. Reason: offline determinism and cost.',
    'The context assembler throws if any acceptance criterion is missing from the distilled output.',
  ].join('\n');

  const story = [
    '# Story story-001-005 — Port doc-distiller',
    '',
    'Port the distillator as a headless skill targeting ~50% token reduction.',
    '',
    shared,
    '',
    '## Acceptance criteria',
    ...ACCEPTANCE_CRITERIA.map((ac) => `- [ ] ${ac}`),
  ].join('\n');

  return { prd, epic, architecture, story };
}

let db: Database.Database;
let agentId: string;

function countRows(table: string, where: string, ...params: unknown[]): number {
  const row = db
    .prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE ${where}`)
    .get(...params) as { n: number };
  return row.n;
}

beforeEach(() => {
  db = createDatabase(':memory:');
  new EpicStore(db).create('epic-001', 'Review Forge');
  agentId = new AgentStore(db).create('epic-001', 'story-001-005').id;
});

afterEach(() => {
  db.close();
});

describe('doc-distiller SKILL.md headless purity (AC #1)', () => {
  const content = fs.readFileSync(docDistillerSkillPath(), 'utf8');

  it('contains no WAIT-FOR-USER directive', () => {
    assert.ok(!/wait[\s-]?for[\s-]?user/i.test(content));
  });

  it('contains no all-caps HALT interactive-halt directive', () => {
    assert.ok(!/\bHALT\b/.test(content));
  });

  it('reads no _bmad/ runtime path', () => {
    assert.ok(!content.includes('_bmad'));
  });

  it('documents acceptance-criterion preservation and the compression target', () => {
    assert.match(content, /acceptance criteri/i);
    assert.match(content, /0\.55|55%/);
  });
});

describe('assembleWorkerContext (AC #2, #3)', () => {
  it('compresses a sample story to <=55% of the source token count', async () => {
    const artifacts = sampleArtifacts();
    const ctx = await assembleWorkerContext('story-001-005', artifacts);
    const source = countTokens(ctx.raw);
    const distilled = countTokens(ctx.distilled);
    assert.ok(source > 0);
    assert.ok(
      distilled <= COMPRESSION_TARGET_RATIO * source,
      `expected distilled (${distilled}) <= ${COMPRESSION_TARGET_RATIO} * source (${source})`,
    );
  });

  it('carries every acceptance criterion through verbatim', async () => {
    const ctx = await assembleWorkerContext('story-001-005', sampleArtifacts());
    for (const ac of ACCEPTANCE_CRITERIA) {
      assert.ok(
        ctx.distilled.includes(ac),
        `distilled output is missing acceptance criterion verbatim: ${ac}`,
      );
    }
    assert.deepEqual(ctx.acceptance_criteria_preserved, ACCEPTANCE_CRITERIA);
  });
});

describe('assembleWorkerContext compression-target vs AC-drop (AC #4)', () => {
  it('logs a warning but does NOT throw when the compression target is missed', async () => {
    const artifacts = sampleArtifacts();
    const warnings: string[] = [];
    // A no-op "distiller" that returns the raw text → ratio ~1.0 (> 0.55) but
    // still contains every acceptance criterion, so only the soft target fails.
    const ctx = await assembleWorkerContext('story-001-005', artifacts, {
      distill: (a) => formatArtifacts(a),
      warn: (m) => warnings.push(m),
    });
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /compression target/i);
    assert.ok(ctx.distilled.length > 0);
  });

  it('throws when the distiller drops an acceptance criterion', async () => {
    const artifacts = sampleArtifacts();
    await assert.rejects(
      assembleWorkerContext('story-001-005', artifacts, {
        // Drop the first acceptance criterion.
        distill: (a) => extractAcceptanceCriteria(a).slice(1).join('\n'),
      }),
      /dropped 1 acceptance criterion/,
    );
  });

  it('does not throw for a harmlessly paraphrased AC only because it is missing verbatim', async () => {
    // Documents the accepted trade-off: a paraphrase fails the verbatim check.
    const artifacts = sampleArtifacts();
    await assert.rejects(
      assembleWorkerContext('story-001-005', artifacts, {
        distill: (a) =>
          extractAcceptanceCriteria(a)
            .map((ac) => ac.replace('verbatim', 'word-for-word'))
            .join('\n'),
      }),
      /dropped .* acceptance criterion/,
    );
  });
});

describe('assembleWorkerContext provenance (AC #5)', () => {
  it('invokes the distiller exactly once', async () => {
    let calls = 0;
    await assembleWorkerContext('story-001-005', sampleArtifacts(), {
      db,
      agent_id: agentId,
      epic_id: 'epic-001',
      distill: (a) => {
        calls += 1;
        return defaultDistill(a);
      },
    });
    assert.equal(calls, 1);
  });

  it('writes exactly one skill_usage row and one context.distilled audit_log row', async () => {
    await assembleWorkerContext('story-001-005', sampleArtifacts(), {
      db,
      agent_id: agentId,
      epic_id: 'epic-001',
    });
    assert.equal(
      countRows('skill_usage', 'skill_name = ? AND story_id = ?', 'doc-distiller', 'story-001-005'),
      1,
    );
    assert.equal(
      countRows('audit_log', "action = 'context.distilled' AND command = ?", 'story-001-005'),
      1,
    );
  });

  it('records the token accounting in the audit detail', async () => {
    await assembleWorkerContext('story-001-005', sampleArtifacts(), {
      db,
      agent_id: agentId,
      epic_id: 'epic-001',
    });
    const row = db
      .prepare("SELECT detail FROM audit_log WHERE action = 'context.distilled' LIMIT 1")
      .get() as { detail: string };
    const detail = JSON.parse(row.detail) as {
      source_token_count: number;
      distilled_token_count: number;
      epic_id: string;
    };
    assert.equal(detail.epic_id, 'epic-001');
    assert.ok(detail.source_token_count > 0);
    assert.ok(detail.distilled_token_count > 0);
    assert.ok(detail.distilled_token_count < detail.source_token_count);
  });

  it('writes no provenance and still returns when no db is supplied', async () => {
    const ctx = await assembleWorkerContext('story-001-005', sampleArtifacts());
    assert.ok(ctx.distilled.length > 0);
  });
});

describe('extractAcceptanceCriteria', () => {
  it('extracts checkbox-style acceptance criteria', () => {
    const acs = extractAcceptanceCriteria({
      prd: '',
      epic: '',
      architecture: '',
      story: '## Acceptance criteria\n- [ ] first thing\n- [x] second thing',
    });
    assert.deepEqual(acs, ['first thing', 'second thing']);
  });

  it('extracts plain bullets under an "acceptance criteria" heading', () => {
    const acs = extractAcceptanceCriteria({
      prd: '',
      epic: '### Acceptance Criteria\n- alpha\n- beta\n\n### Other\n- not an ac',
      architecture: '',
      story: '',
    });
    assert.deepEqual(acs, ['alpha', 'beta']);
  });

  it('deduplicates criteria repeated across artifacts', () => {
    const acs = extractAcceptanceCriteria({
      prd: '- [ ] shared criterion',
      epic: '',
      architecture: '',
      story: '## Acceptance criteria\n- [ ] shared criterion\n- [ ] unique one',
    });
    assert.deepEqual(acs, ['shared criterion', 'unique one']);
  });

  it('returns an empty list when there are no acceptance criteria', () => {
    assert.deepEqual(
      extractAcceptanceCriteria({ prd: 'no acs here', epic: '', architecture: '', story: '' }),
      [],
    );
  });
});
