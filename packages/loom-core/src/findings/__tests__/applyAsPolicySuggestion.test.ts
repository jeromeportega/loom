import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { createDatabase } from '../../state/Database.js';
import { LessonStore } from '../../state/LessonStore.js';
import { AuditLog } from '../../state/AuditLog.js';
import { applyAsPolicySuggestion } from '../applyAsPolicySuggestion.js';
import type { LessonRow } from '../lesson.js';

const FIXED_TIME = '2026-06-12T00:00:00.000Z';

function makeDb(): Database.Database {
  return createDatabase(':memory:');
}

function makeDeps(db: Database.Database) {
  return {
    lessonStore: new LessonStore(db),
    audit: new AuditLog(db),
  };
}

function seedLesson(lessonStore: LessonStore): LessonRow {
  const [row] = lessonStore.insert([{
    epic_id: 'epic-001',
    category: 'schema-migration',
    observation: 'Additive migrations prevented downtime',
    general_rule: 'Use CREATE TABLE IF NOT EXISTS for additive schema changes',
    applied_as: null,
    applied_ref: null,
    created_at: FIXED_TIME,
  }]);
  return row;
}

describe('applyAsPolicySuggestion — suggestion recorded', () => {
  it('returns a non-empty auditRef and writes an audit row with action:policy_suggestion', () => {
    const db = makeDb();
    const deps = makeDeps(db);
    const row = seedLesson(deps.lessonStore);

    const suggestion = 'Always use additive-only migrations';
    const { auditRef } = applyAsPolicySuggestion(deps, row.id, suggestion);

    assert.ok(auditRef, 'must return a non-empty auditRef');

    const recent = deps.audit.recent(10);
    const found = recent.find((r) => r.action === 'policy_suggestion');
    assert.ok(found, 'audit row with action:policy_suggestion must exist');

    const detail = JSON.parse(found!.detail!) as {
      lessonId: number;
      suggestion: string;
      auditRef: string;
    };
    assert.equal(detail.lessonId, row.id, 'detail.lessonId must equal the lessonId argument');
    assert.equal(detail.suggestion, suggestion, 'detail.suggestion must equal the suggestion argument');
    assert.equal(detail.auditRef, auditRef, 'detail.auditRef must equal the returned auditRef');
  });
});

describe('applyAsPolicySuggestion — row marked', () => {
  it('lesson row applied_as===policy_suggestion and applied_ref===auditRef after call', () => {
    const db = makeDb();
    const deps = makeDeps(db);
    const row = seedLesson(deps.lessonStore);

    const { auditRef } = applyAsPolicySuggestion(deps, row.id, 'Some suggestion');

    const [updated] = deps.lessonStore.getByEpic('epic-001');
    assert.equal(updated.applied_as, 'policy_suggestion');
    assert.equal(updated.applied_ref, auditRef);
  });
});

describe('applyAsPolicySuggestion — auditable', () => {
  it('audit row is retrievable and contains the suggestion text', () => {
    const db = makeDb();
    const deps = makeDeps(db);
    const row = seedLesson(deps.lessonStore);

    const suggestion = 'Enforce additive migrations via policy';
    applyAsPolicySuggestion(deps, row.id, suggestion);

    const recent = deps.audit.recent(10);
    const found = recent.find((r) => r.action === 'policy_suggestion');
    assert.ok(found, 'audit row must be retrievable');
    assert.ok(
      found!.detail!.includes(suggestion),
      'audit row detail must contain the suggestion text',
    );
  });
});

describe('applyAsPolicySuggestion — no policy mutation (T-3/NFR-3)', () => {
  it('a policy file on disk is byte-for-byte unchanged after the call', () => {
    const db = makeDb();
    const deps = makeDeps(db);
    const row = seedLesson(deps.lessonStore);

    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'loom-policy-test-'));
    try {
      const policyPath = path.join(tmpDir, 'policy.yaml');
      const policyContent = 'version: 1\nrules: []\n';
      fs.writeFileSync(policyPath, policyContent, 'utf8');

      // deps deliberately has NO policy file / PolicyEngine handle
      applyAsPolicySuggestion(deps, row.id, 'Some suggestion');

      const after = fs.readFileSync(policyPath, 'utf8');
      assert.equal(after, policyContent, 'policy file must be byte-for-byte unchanged');
    } finally {
      fs.rmSync(tmpDir, { recursive: true });
    }
  });

  it('applyAsPolicySuggestion source has no reference to PolicyEngine or policy file path', () => {
    const srcPath = path.resolve(
      __dirname, '..', '..', '..', 'src', 'findings', 'applyAsPolicySuggestion.ts',
    );
    const src = fs.readFileSync(srcPath, 'utf8');
    assert.ok(
      !src.includes('PolicyEngine'),
      'applyAsPolicySuggestion must not reference PolicyEngine',
    );
    assert.ok(
      !src.includes('policy.yaml'),
      'applyAsPolicySuggestion must not reference a policy file path',
    );
  });
});

describe('applyAsPolicySuggestion — latest-write semantics (ADR-005)', () => {
  it('lesson row shows only the latest applied_as; both calls produce separate audit rows', () => {
    const db = makeDb();
    const deps = makeDeps(db);
    const row = seedLesson(deps.lessonStore);

    // First: simulate worker_guidance application (as story-005-004 would do)
    deps.lessonStore.markApplied(row.id, 'worker_guidance', 'story-x');

    // Second: apply as policy_suggestion via this story's function
    const { auditRef } = applyAsPolicySuggestion(deps, row.id, 'Enforce migration policy');

    // Lesson row shows only the latest applied_as
    const [updated] = deps.lessonStore.getByEpic('epic-001');
    assert.equal(updated.applied_as, 'policy_suggestion', 'latest applied_as must win');
    assert.equal(updated.applied_ref, auditRef, 'latest applied_ref must win');

    // The policy_suggestion audit row is in the audit log (auditable history)
    const auditRows = deps.audit.recent(10);
    const policySuggRow = auditRows.find((r) => r.action === 'policy_suggestion');
    assert.ok(policySuggRow, 'policy_suggestion audit row must exist in the audit log');

    // Multiple policy_suggestion calls each produce a separate audit row
    const { auditRef: auditRef2 } = applyAsPolicySuggestion(
      deps, row.id, 'Second policy suggestion',
    );
    const allRows = deps.audit.recent(10);
    const allSuggRows = allRows.filter((r) => r.action === 'policy_suggestion');
    assert.equal(allSuggRows.length, 2, 'each call must produce a separate audit row');
    assert.notEqual(auditRef, auditRef2, 'each call must produce a distinct auditRef');
  });
});
