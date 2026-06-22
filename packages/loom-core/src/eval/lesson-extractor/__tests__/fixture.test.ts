import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import yaml from 'js-yaml';

// ── Inline types matching the contract schema (caseSchema.ts, story-041-002) ──
// These mirror LessonExtractorCaseSchema / EpicTelemetry shapes so the fixture
// can be structurally validated without importing the not-yet-built schema module.

interface RawDecisionTrace {
  id: unknown;
  agent_id: unknown;
  epic_id: unknown;
  story_id: unknown;
  kind: unknown;
  subject: unknown;
  rationale: unknown;
  metadata: unknown;
  timestamp: unknown;
}

interface RawAgent {
  story_id: unknown;
  review_summary: unknown;
  log_tail: unknown;
}

interface RawAuditRow {
  id: unknown;
  agent_id: unknown;
  action: unknown;
  command: unknown;
  allowed: unknown;
  policy_rule: unknown;
  detail: unknown;
  timestamp: unknown;
}

interface RawTelemetry {
  epic_id: unknown;
  final_status: unknown;
  decision_traces: unknown;
  agents: unknown;
  audit_tail: unknown;
}

interface RawRubric {
  expected_themes: unknown;
  over_extraction_traps: unknown;
}

interface RawCase {
  id: unknown;
  source: unknown;
  telemetry: RawTelemetry;
  rubric: RawRubric;
  rationale: unknown;
}

interface RawFixture {
  cases: RawCase[];
}

// ── Fixture path resolution ────────────────────────────────────────────────────

function resolveFixturePath(): string {
  const candidates = [
    // Compiled path: dist/eval/lesson-extractor/__tests__/ → packages/loom-core/
    path.resolve(__dirname, '../../../../eval-cases/lesson-extractor.yaml'),
    // Fallback from repo root (monorepo CI invocation)
    path.resolve(process.cwd(), 'packages/loom-core/eval-cases/lesson-extractor.yaml'),
    // Fallback from within packages/loom-core/
    path.resolve(process.cwd(), 'eval-cases/lesson-extractor.yaml'),
  ];
  for (const p of candidates) {
    if (fs.existsSync(p)) return p;
  }
  throw new Error(
    `lesson-extractor.yaml not found. Looked in:\n  ${candidates.join('\n  ')}`,
  );
}

function loadFixture(): RawFixture {
  const fixturePath = resolveFixturePath();
  const raw = yaml.load(fs.readFileSync(fixturePath, 'utf8'));
  assert.ok(raw !== null && typeof raw === 'object', 'fixture must parse to an object');
  const fixture = raw as Record<string, unknown>;
  assert.ok(Array.isArray(fixture['cases']), 'fixture must have a "cases" array');
  return raw as RawFixture;
}

// ── Module-level fixture — populated once in before() to avoid repeated disk I/O ─

let fixture!: RawFixture;

before(() => {
  fixture = loadFixture();
});

// ── Top-level structure ────────────────────────────────────────────────────────

describe('lesson-extractor fixture — top-level structure', () => {
  it('parses as YAML without error', () => {
    assert.doesNotThrow(() => loadFixture());
  });

  it('contains at least 2 cases', () => {
    const cases = fixture.cases;
    assert.ok(cases.length >= 2, `expected ≥2 cases, got ${cases.length}`);
  });

  it('every case has a non-empty string id', () => {
    const cases = fixture.cases;
    for (const c of cases) {
      assert.equal(typeof c.id, 'string', `id must be a string in case ${JSON.stringify(c.id)}`);
      assert.ok((c.id as string).length > 0, 'id must be non-empty');
    }
  });

  it('all case ids are unique', () => {
    const cases = fixture.cases;
    const ids = cases.map((c) => c.id);
    const unique = new Set(ids);
    assert.equal(
      unique.size,
      ids.length,
      `case ids must be unique; found duplicates among: ${JSON.stringify(ids)}`,
    );
  });

  it('every case has a non-empty string rationale', () => {
    const cases = fixture.cases;
    for (const c of cases) {
      assert.equal(typeof c.rationale, 'string', `rationale must be a string in case ${c.id}`);
      assert.ok((c.rationale as string).trim().length > 0, `rationale must be non-empty in case ${c.id}`);
    }
  });
});

// ── Required profiles ─────────────────────────────────────────────────────────

describe('lesson-extractor fixture — required source profiles', () => {
  it('contains exactly the source values "rich" and "thin"', () => {
    const cases = fixture.cases;
    const sources = new Set(cases.map((c) => c.source));
    assert.ok(sources.has('rich'), 'fixture must contain at least one "rich" case');
    assert.ok(sources.has('thin'), 'fixture must contain at least one "thin" case');
  });

  it('source is one of "rich" | "thin" for every case', () => {
    const cases = fixture.cases;
    const valid = new Set(['rich', 'thin']);
    for (const c of cases) {
      assert.ok(
        valid.has(c.source as string),
        `case ${c.id} has unexpected source: ${JSON.stringify(c.source)}`,
      );
    }
  });
});

// ── Telemetry — decision_traces ────────────────────────────────────────────────

describe('lesson-extractor fixture — telemetry.decision_traces', () => {
  it('every case has at least 1 decision trace', () => {
    const cases = fixture.cases;
    for (const c of cases) {
      const traces = c.telemetry.decision_traces;
      assert.ok(Array.isArray(traces), `decision_traces must be an array in case ${c.id}`);
      assert.ok(
        (traces as unknown[]).length >= 1,
        `case ${c.id} must have ≥1 decision trace; got ${(traces as unknown[]).length}`,
      );
    }
  });

  it('every decision trace has required fields populated', () => {
    const cases = fixture.cases;
    for (const c of cases) {
      const traces = c.telemetry.decision_traces as RawDecisionTrace[];
      for (const [i, tr] of traces.entries()) {
        assert.equal(typeof tr.id, 'number', `trace[${i}] in case ${c.id}: id must be a number`);
        assert.equal(
          typeof tr.agent_id,
          'string',
          `trace[${i}] in case ${c.id}: agent_id must be a string`,
        );
        assert.ok(
          (tr.agent_id as string).length > 0,
          `trace[${i}] in case ${c.id}: agent_id must be non-empty`,
        );
        assert.equal(
          typeof tr.story_id,
          'string',
          `trace[${i}] in case ${c.id}: story_id must be a string`,
        );
        assert.ok(
          (tr.story_id as string).length > 0,
          `trace[${i}] in case ${c.id}: story_id must be non-empty`,
        );
        assert.equal(
          typeof tr.epic_id,
          'string',
          `trace[${i}] in case ${c.id}: epic_id must be a string`,
        );
        assert.ok(
          (tr.epic_id as string).length > 0,
          `trace[${i}] in case ${c.id}: epic_id must be non-empty`,
        );
        assert.equal(typeof tr.kind, 'string', `trace[${i}] in case ${c.id}: kind must be a string`);
        assert.ok((tr.kind as string).length > 0, `trace[${i}] in case ${c.id}: kind must be non-empty`);
        assert.equal(
          typeof tr.rationale,
          'string',
          `trace[${i}] in case ${c.id}: rationale must be a string`,
        );
        assert.ok(
          (tr.rationale as string).trim().length > 0,
          `trace[${i}] in case ${c.id}: rationale must be non-empty`,
        );
        assert.equal(
          typeof tr.timestamp,
          'string',
          `trace[${i}] in case ${c.id}: timestamp must be a string`,
        );
        assert.ok(
          (tr.timestamp as string).length > 0,
          `trace[${i}] in case ${c.id}: timestamp must be non-empty`,
        );
      }
    }
  });

  it('every decision trace with non-null metadata contains parseable JSON', () => {
    const cases = fixture.cases;
    for (const c of cases) {
      const traces = c.telemetry.decision_traces as RawDecisionTrace[];
      for (const [i, tr] of traces.entries()) {
        if (tr.metadata !== null && tr.metadata !== undefined) {
          assert.equal(
            typeof tr.metadata,
            'string',
            `trace[${i}] in case ${c.id}: non-null metadata must be a string`,
          );
          assert.doesNotThrow(
            () => JSON.parse(tr.metadata as string),
            `trace[${i}] in case ${c.id}: metadata must be valid JSON; got ${JSON.stringify(tr.metadata)}`,
          );
        }
      }
    }
  });
});

// ── Telemetry — agents ─────────────────────────────────────────────────────────

describe('lesson-extractor fixture — telemetry.agents', () => {
  it('every case has at least 1 agent entry', () => {
    const cases = fixture.cases;
    for (const c of cases) {
      const agents = c.telemetry.agents;
      assert.ok(Array.isArray(agents), `agents must be an array in case ${c.id}`);
      assert.ok(
        (agents as unknown[]).length >= 1,
        `case ${c.id} must have ≥1 agent; got ${(agents as unknown[]).length}`,
      );
    }
  });

  it('every agent has a non-empty story_id', () => {
    const cases = fixture.cases;
    for (const c of cases) {
      const agents = c.telemetry.agents as RawAgent[];
      for (const [i, ag] of agents.entries()) {
        assert.equal(
          typeof ag.story_id,
          'string',
          `agent[${i}] in case ${c.id}: story_id must be a string`,
        );
        assert.ok(
          (ag.story_id as string).length > 0,
          `agent[${i}] in case ${c.id}: story_id must be non-empty`,
        );
      }
    }
  });

  it('every agent has non-null review_summary and log_tail', () => {
    const cases = fixture.cases;
    for (const c of cases) {
      const agents = c.telemetry.agents as RawAgent[];
      for (const [i, ag] of agents.entries()) {
        assert.ok(
          ag.review_summary !== null && ag.review_summary !== undefined,
          `agent[${i}] in case ${c.id}: review_summary must not be null`,
        );
        assert.equal(
          typeof ag.review_summary,
          'string',
          `agent[${i}] in case ${c.id}: review_summary must be a string`,
        );
        assert.ok(
          ag.log_tail !== null && ag.log_tail !== undefined,
          `agent[${i}] in case ${c.id}: log_tail must not be null`,
        );
        assert.equal(
          typeof ag.log_tail,
          'string',
          `agent[${i}] in case ${c.id}: log_tail must be a string`,
        );
      }
    }
  });
});

// ── Telemetry — audit_tail ─────────────────────────────────────────────────────

describe('lesson-extractor fixture — telemetry.audit_tail', () => {
  it('every case has at least 1 audit row', () => {
    const cases = fixture.cases;
    for (const c of cases) {
      const tail = c.telemetry.audit_tail;
      assert.ok(Array.isArray(tail), `audit_tail must be an array in case ${c.id}`);
      assert.ok(
        (tail as unknown[]).length >= 1,
        `case ${c.id} must have ≥1 audit row; got ${(tail as unknown[]).length}`,
      );
    }
  });

  it('every audit row has required fields populated', () => {
    const cases = fixture.cases;
    for (const c of cases) {
      const tail = c.telemetry.audit_tail as RawAuditRow[];
      for (const [i, row] of tail.entries()) {
        assert.equal(typeof row.id, 'number', `audit_tail[${i}] in case ${c.id}: id must be a number`);
        assert.equal(
          typeof row.action,
          'string',
          `audit_tail[${i}] in case ${c.id}: action must be a string`,
        );
        assert.ok(
          (row.action as string).length > 0,
          `audit_tail[${i}] in case ${c.id}: action must be non-empty`,
        );
        assert.equal(
          typeof row.timestamp,
          'string',
          `audit_tail[${i}] in case ${c.id}: timestamp must be a string`,
        );
      }
    }
  });
});

// ── Rubric expectations ────────────────────────────────────────────────────────
// expected_themes holds theme CATEGORIES (not exact lessons). Rich cases must
// have ≥1 theme. Thin cases may have an empty array — the correct outcome for a
// thin epic is zero extracted lessons, so no themes are expected to appear.

describe('lesson-extractor fixture — rubric', () => {
  it('every case has expected_themes as an array; rich cases must have ≥1 theme', () => {
    const cases = fixture.cases;
    for (const c of cases) {
      const themes = c.rubric.expected_themes;
      assert.ok(Array.isArray(themes), `expected_themes must be an array in case ${c.id}`);
      if (c.source === 'rich') {
        assert.ok(
          (themes as unknown[]).length >= 1,
          `rich case ${c.id} must have ≥1 expected_theme`,
        );
      }
      for (const [i, t] of (themes as unknown[]).entries()) {
        assert.equal(typeof t, 'string', `expected_themes[${i}] in case ${c.id} must be a string`);
        assert.ok(
          (t as string).trim().length > 0,
          `expected_themes[${i}] in case ${c.id} must be non-empty`,
        );
      }
    }
  });

  it('every case has at least 1 over_extraction_trap', () => {
    const cases = fixture.cases;
    for (const c of cases) {
      const traps = c.rubric.over_extraction_traps;
      assert.ok(Array.isArray(traps), `over_extraction_traps must be an array in case ${c.id}`);
      assert.ok(
        (traps as unknown[]).length >= 1,
        `case ${c.id} must have ≥1 over_extraction_trap; got ${(traps as unknown[]).length}`,
      );
      for (const [i, tr] of (traps as unknown[]).entries()) {
        assert.equal(
          typeof tr,
          'string',
          `over_extraction_traps[${i}] in case ${c.id} must be a string`,
        );
        assert.ok(
          (tr as string).trim().length > 0,
          `over_extraction_traps[${i}] in case ${c.id} must be non-empty`,
        );
      }
    }
  });
});

// ── CRITICAL: thin case non-emptiness ─────────────────────────────────────────
// LessonExtractor.extract() short-circuits to [] when decision_traces, agents,
// AND audit_tail are all empty (FR-5). The thin case must carry at least one
// entry in EACH source so the extractor evaluates it and over-extraction is
// exercisable. Checking any-nonempty is insufficient — each source must be ≥1.

describe('lesson-extractor fixture — thin case non-emptiness (CRITICAL)', () => {
  it('thin case has ≥1 entry in each of decision_traces, agents, and audit_tail', () => {
    const cases = fixture.cases;
    const thin = cases.find((c) => c.source === 'thin');
    assert.ok(thin !== undefined, 'must have a thin case');

    const traces = thin.telemetry.decision_traces as unknown[];
    const agents = thin.telemetry.agents as unknown[];
    const tail = thin.telemetry.audit_tail as unknown[];

    assert.ok(
      traces.length >= 1 && agents.length >= 1 && tail.length >= 1,
      'thin case must have ≥1 entry in EACH of decision_traces, agents, and audit_tail ' +
        '— LessonExtractor.extract() short-circuits on fully empty input, so over-extraction ' +
        `would never be exercised. Got: decision_traces=${traces.length}, agents=${agents.length}, audit_tail=${tail.length}`,
    );
  });

  it('thin case is meaningfully sparse: combined source entries ≤ 10', () => {
    const cases = fixture.cases;
    const thin = cases.find((c) => c.source === 'thin');
    assert.ok(thin !== undefined, 'must have a thin case');

    const total =
      (thin.telemetry.decision_traces as unknown[]).length +
      (thin.telemetry.agents as unknown[]).length +
      (thin.telemetry.audit_tail as unknown[]).length;

    assert.ok(
      total <= 10,
      `thin case should be sparse (≤10 combined entries); got ${total}. ` +
        'If this case has grown, it belongs in the rich category.',
    );
  });
});

// ── Synthetic data integrity ───────────────────────────────────────────────────
// Fixture must use synthetic IDs only — no real-epic content, no anonymization
// markers (REDACTED, ANON, etc.) that would indicate real data was smuggled in.

describe('lesson-extractor fixture — synthetic data only', () => {
  const FORBIDDEN_PATTERNS = [/\bREDACTED\b/i, /\bANON(YMIZED)?\b/i, /\bPII\b/i];

  function textFields(obj: unknown): string[] {
    if (typeof obj === 'string') return [obj];
    if (Array.isArray(obj)) return obj.flatMap(textFields);
    if (obj !== null && typeof obj === 'object') {
      return Object.values(obj as Record<string, unknown>).flatMap(textFields);
    }
    return [];
  }

  it('no field contains anonymization markers (REDACTED, ANON, PII)', () => {
    const allText = textFields(fixture).join(' ');
    for (const pat of FORBIDDEN_PATTERNS) {
      assert.ok(
        !pat.test(allText),
        `fixture must not contain ${pat} — use synthetic names, not anonymized real data`,
      );
    }
  });

  it('telemetry.epic_id values follow the synthetic "epic-NNN" pattern', () => {
    const cases = fixture.cases;
    const syntheticEpicId = /^epic-\d+$/;
    for (const c of cases) {
      const epicId = c.telemetry.epic_id;
      assert.equal(typeof epicId, 'string', `telemetry.epic_id must be a string in case ${c.id}`);
      assert.match(
        epicId as string,
        syntheticEpicId,
        `case ${c.id}: epic_id "${epicId}" must match synthetic pattern "epic-NNN"`,
      );
    }
  });

  it('decision trace epic_id values follow the synthetic "epic-NNN" pattern', () => {
    const cases = fixture.cases;
    const syntheticEpicId = /^epic-\d+$/;
    for (const c of cases) {
      const traces = c.telemetry.decision_traces as RawDecisionTrace[];
      for (const [i, tr] of traces.entries()) {
        assert.equal(
          typeof tr.epic_id,
          'string',
          `trace[${i}] in case ${c.id}: epic_id must be a string`,
        );
        assert.match(
          tr.epic_id as string,
          syntheticEpicId,
          `trace[${i}] in case ${c.id}: epic_id "${tr.epic_id}" must match synthetic pattern "epic-NNN"`,
        );
      }
    }
  });
});
