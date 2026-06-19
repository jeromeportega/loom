import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import yaml from 'js-yaml';

import { IntakeEvalCaseSchema, IntakeEvalSetSchema } from '../intakeEvalTypes.js';
import { recoverBriefText } from '../recoverBriefText.js';

// ── helpers ────────────────────────────────────────────────────────────────────

function makeTmp(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'loom-eval-test-'));
}

function writeFile(dir: string, rel: string, content: string): void {
  const full = path.join(dir, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content, 'utf8');
}

function cleanup(dir: string): void {
  fs.rmSync(dir, { recursive: true, force: true });
}

// ── IntakeEvalCaseSchema — unit ────────────────────────────────────────────────

describe('IntakeEvalCaseSchema', () => {
  const valid = {
    id: 'epic-007',
    source: 'epic' as const,
    brief: 'Eval & Safety: measuring quality and preventing self-degradation',
    brief_source: '.loom/planning/epic-007/project-brief.md',
    label: { type: 'feature' as const, size: 'epic' as const },
    rationale: 'Multi-story eval and safety system with skill lifecycle management.',
    story_count: 4,
  };

  it('accepts a fully-populated case', () => {
    const r = IntakeEvalCaseSchema.safeParse(valid);
    assert.ok(r.success, 'Should accept a fully-populated case');
  });

  it('accepts a case without optional fields', () => {
    const { brief_source, story_count, ...minimal } = valid;
    const r = IntakeEvalCaseSchema.safeParse(minimal);
    assert.ok(r.success, 'Should accept a case without brief_source and story_count');
  });

  it('rejects empty brief', () => {
    const r = IntakeEvalCaseSchema.safeParse({ ...valid, brief: '' });
    assert.ok(!r.success, 'Should reject empty brief');
  });

  it('rejects missing rationale', () => {
    const { rationale, ...noRationale } = valid;
    const r = IntakeEvalCaseSchema.safeParse(noRationale);
    assert.ok(!r.success, 'Should reject missing rationale');
  });

  it('rejects empty rationale', () => {
    const r = IntakeEvalCaseSchema.safeParse({ ...valid, rationale: '' });
    assert.ok(!r.success, 'Should reject empty rationale');
  });

  it('rejects label.type outside {feature,bug,chore}', () => {
    const r = IntakeEvalCaseSchema.safeParse({ ...valid, label: { type: 'enhancement', size: 'epic' } });
    assert.ok(!r.success, 'Should reject label.type="enhancement"');
  });

  it('rejects label.size outside {story,epic}', () => {
    const r = IntakeEvalCaseSchema.safeParse({ ...valid, label: { type: 'feature', size: 'task' } });
    assert.ok(!r.success, 'Should reject label.size="task"');
  });

  it('accepts label.type of bug', () => {
    const r = IntakeEvalCaseSchema.safeParse({ ...valid, label: { ...valid.label, type: 'bug' } });
    assert.ok(r.success, 'Should accept label.type="bug"');
  });

  it('accepts label.type of chore', () => {
    const r = IntakeEvalCaseSchema.safeParse({ ...valid, label: { ...valid.label, type: 'chore' } });
    assert.ok(r.success, 'Should accept label.type="chore"');
  });

  it('accepts label.size of story', () => {
    const r = IntakeEvalCaseSchema.safeParse({ ...valid, label: { ...valid.label, size: 'story' } });
    assert.ok(r.success, 'Should accept label.size="story"');
  });

  it('story_count is optional — schema passes when absent', () => {
    const { story_count, ...noCount } = valid;
    const r = IntakeEvalCaseSchema.safeParse(noCount);
    assert.ok(r.success, 'story_count should be optional');
    if (r.success) {
      assert.equal(r.data.story_count, undefined, 'story_count should be absent when not provided');
    }
  });

  it('label.size is present independently of story_count (ADR-004)', () => {
    const { story_count, ...noCount } = valid;
    const r = IntakeEvalCaseSchema.safeParse(noCount);
    assert.ok(r.success);
    if (r.success) {
      // size truth is the label field, not a derived count
      assert.ok(r.data.label.size === 'story' || r.data.label.size === 'epic');
    }
  });
});

// ── IntakeEvalSetSchema — unit ─────────────────────────────────────────────────

describe('IntakeEvalSetSchema', () => {
  it('rejects an empty cases array (.min(1))', () => {
    const r = IntakeEvalSetSchema.safeParse({ cases: [] });
    assert.ok(!r.success, 'Should reject empty cases array');
  });

  it('accepts a set with one valid case', () => {
    const r = IntakeEvalSetSchema.safeParse({
      cases: [
        {
          id: 'anchor-test',
          source: 'anchor',
          brief: 'Fix date picker bug',
          label: { type: 'bug', size: 'story' },
          rationale: 'Clear single-story bug fix.',
        },
      ],
    });
    assert.ok(r.success, 'Should accept a set with one valid case');
  });
});

// ── recoverBriefText — unit ────────────────────────────────────────────────────

describe('recoverBriefText — resolution order', () => {
  it('returns {ok:true} from project-brief.md when that file exists', () => {
    const tmp = makeTmp();
    try {
      const expected = '# My Brief\n\nThis is the project brief content.';
      writeFile(tmp, '.loom/planning/epic-007/project-brief.md', expected);

      const result = recoverBriefText('epic-007', tmp);
      assert.ok(result.ok === true, 'Should find the brief md file');
      if (result.ok) {
        assert.equal(result.text, expected.trim());
        assert.equal(result.source, '.loom/planning/epic-007/project-brief.md');
      }
    } finally {
      cleanup(tmp);
    }
  });

  it('falls back to epic YAML title when brief md is absent', () => {
    const tmp = makeTmp();
    try {
      const epicYaml = [
        '---',
        'epic_id: epic-007',
        'title: "Eval & Safety: measuring quality"',
        'status: approved',
        'priority: should-have',
        'prd_ref: ""',
        'requirements: []',
        'stories: []',
      ].join('\n');
      writeFile(tmp, 'epics/epic-007.yaml', epicYaml);

      const result = recoverBriefText('epic-007', tmp);
      assert.ok(result.ok === true, 'Should fall back to YAML title');
      if (result.ok) {
        assert.ok(result.text.includes('Eval & Safety'), `text should include title, got: ${result.text}`);
        assert.equal(result.source, 'epics/epic-007.yaml');
      }
    } finally {
      cleanup(tmp);
    }
  });

  it('falls back to YAML title via regex when YAML parse fails', () => {
    const tmp = makeTmp();
    try {
      // Deliberately malformed YAML (bad indentation in a nested block)
      const malformedYaml = [
        'epic_id: epic-007',
        'title: "Malformed YAML Epic"',
        'stories:',
        '  - id: story-007-001',
        '  acceptance_criteria:',   // bad indentation
        '      - criterion one',
      ].join('\n');
      writeFile(tmp, 'epics/epic-007.yaml', malformedYaml);

      const result = recoverBriefText('epic-007', tmp);
      assert.ok(result.ok === true, 'Should recover title via regex even with malformed YAML');
      if (result.ok) {
        assert.ok(result.text.includes('Malformed YAML Epic'));
        assert.equal(result.source, 'epics/epic-007.yaml');
      }
    } finally {
      cleanup(tmp);
    }
  });

  it('project-brief.md takes precedence over YAML when both exist', () => {
    const tmp = makeTmp();
    try {
      writeFile(tmp, '.loom/planning/epic-007/project-brief.md', '# Brief from planning');
      writeFile(tmp, 'epics/epic-007.yaml', 'epic_id: epic-007\ntitle: "YAML Title"\nstories: []\n');

      const result = recoverBriefText('epic-007', tmp);
      assert.ok(result.ok === true);
      if (result.ok) {
        assert.equal(result.source, '.loom/planning/epic-007/project-brief.md');
        assert.ok(result.text.includes('Brief from planning'));
      }
    } finally {
      cleanup(tmp);
    }
  });

  it('returns {ok:false} when neither path yields text (ADR-003)', () => {
    const tmp = makeTmp();
    try {
      const result = recoverBriefText('epic-999', tmp);
      assert.equal(result.ok, false, 'Should return {ok:false} when nothing is found');
      if (!result.ok) {
        assert.ok(result.reason.length > 0, 'Should include a reason string');
      }
    } finally {
      cleanup(tmp);
    }
  });
});

// ── recoverBriefText — unrecoverable exclusion (ADR-003) ──────────────────────

describe('recoverBriefText — unrecoverable epic is excluded', () => {
  it('result.ok is false when no brief source exists — case would be excluded', () => {
    const tmp = makeTmp();
    try {
      const result = recoverBriefText('epic-nonexistent', tmp);
      assert.equal(result.ok, false, 'Unrecoverable epic must return {ok:false}');
      // No text field on the result — no fabricated brief
      assert.ok(!('text' in result), 'No text should be present on {ok:false} result');
    } finally {
      cleanup(tmp);
    }
  });

  it('result.ok is false when YAML file has no extractable title', () => {
    const tmp = makeTmp();
    try {
      // A YAML file with completely broken content and no title
      writeFile(tmp, 'epics/epic-999.yaml', '!!! not yaml at all !!!');
      const result = recoverBriefText('epic-999', tmp);
      assert.equal(result.ok, false, 'Should be unrecoverable when no title can be extracted');
    } finally {
      cleanup(tmp);
    }
  });
});

// ── Data integrity — the checked-in fixture ───────────────────────────────────

describe('intake-classification.yaml — data integrity', () => {
  // Resolve the fixture path relative to this compiled test file
  // dist/eval/__tests__/... → ../../eval-cases/...
  const fixturePath = path.resolve(__dirname, '..', '..', '..', 'eval-cases', 'intake-classification.yaml');

  it('fixture file exists', () => {
    assert.ok(fs.existsSync(fixturePath), `Fixture not found at: ${fixturePath}`);
  });

  it('fixture parses and validates against IntakeEvalSetSchema', () => {
    const raw = yaml.load(fs.readFileSync(fixturePath, 'utf8'));
    const result = IntakeEvalSetSchema.safeParse(raw);
    assert.ok(result.success, `Schema validation failed: ${!result.success ? result.error.message : ''}`);
  });

  it('every case has non-empty brief (FR-2)', () => {
    const raw = yaml.load(fs.readFileSync(fixturePath, 'utf8'));
    const result = IntakeEvalSetSchema.parse(raw);
    for (const c of result.cases) {
      assert.ok(c.brief.trim().length > 0, `Case ${c.id} has empty brief`);
    }
  });

  it('every case has a brief_source provenance string (FR-2 recoverability gate)', () => {
    const raw = yaml.load(fs.readFileSync(fixturePath, 'utf8'));
    const result = IntakeEvalSetSchema.parse(raw);
    for (const c of result.cases) {
      assert.ok(
        typeof c.brief_source === 'string' && c.brief_source.trim().length > 0,
        `Case ${c.id} is missing brief_source provenance`,
      );
    }
  });

  it('the three required anchors exist with source:anchor (test plan requirement)', () => {
    const raw = yaml.load(fs.readFileSync(fixturePath, 'utf8'));
    const result = IntakeEvalSetSchema.parse(raw);
    const anchors = result.cases.filter((c) => c.source === 'anchor');
    assert.ok(anchors.length >= 3, `Expected at least 3 anchor cases, found ${anchors.length}`);

    // Anchor: obvious single-story change (size:story)
    const storyAnchor = anchors.find((c) => c.label.size === 'story' && c.label.type !== 'bug');
    assert.ok(storyAnchor, 'Missing anchor: obvious single-story change (size:story)');
    assert.ok(storyAnchor.rationale.trim().length > 0, 'Single-story anchor must have rationale');

    // Anchor: obvious bug (type:bug)
    const bugAnchor = anchors.find((c) => c.label.type === 'bug');
    assert.ok(bugAnchor, 'Missing anchor: obvious bug (type:bug)');
    assert.ok(bugAnchor.rationale.trim().length > 0, 'Bug anchor must have rationale');

    // Anchor: obviously large multi-story epic (size:epic)
    const epicAnchor = anchors.find((c) => c.source === 'anchor' && c.label.size === 'epic');
    assert.ok(epicAnchor, 'Missing anchor: obviously large multi-story epic (size:epic)');
    assert.ok(epicAnchor.rationale.trim().length > 0, 'Large-epic anchor must have rationale');
  });

  it('all 19 delivered epics are represented in the fixture', () => {
    const raw = yaml.load(fs.readFileSync(fixturePath, 'utf8'));
    const result = IntakeEvalSetSchema.parse(raw);
    const epicIds = result.cases.filter((c) => c.source === 'epic').map((c) => c.id);
    for (let i = 1; i <= 19; i++) {
      const id = `epic-${String(i).padStart(3, '0')}`;
      assert.ok(epicIds.includes(id), `Missing epic case: ${id}`);
    }
  });

  it('FR-3/ADR-004: story_count is optional and label.size is independently set on every case', () => {
    const raw = yaml.load(fs.readFileSync(fixturePath, 'utf8'));
    const result = IntakeEvalSetSchema.parse(raw);
    for (const c of result.cases) {
      // size is always present
      assert.ok(c.label.size === 'story' || c.label.size === 'epic', `Case ${c.id} has invalid size`);
      // story_count, when present, is numeric but is NOT the same as label.size resolution
      if (c.story_count !== undefined) {
        assert.equal(typeof c.story_count, 'number', `Case ${c.id} story_count should be numeric`);
      }
    }
  });

  it('schema rejects a case with story_count but no label.size — size truth is independent', () => {
    // Confirm: story_count alone cannot carry the size label (it has no semantic meaning in the schema)
    const noSizeCase = {
      id: 'test',
      source: 'epic',
      brief: 'some brief',
      label: { type: 'feature' },   // missing size
      rationale: 'test',
      story_count: 5,
    };
    const r = IntakeEvalCaseSchema.safeParse(noSizeCase);
    assert.ok(!r.success, 'Schema must reject a case with story_count but no label.size');
  });
});
