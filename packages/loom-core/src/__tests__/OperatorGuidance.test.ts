import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { OperatorGuidance } from '../orchestrator/OperatorGuidance.js';
import { buildWorkerPrompt } from '../orchestrator/workerPrompt.js';
import { openDatabase, resetDatabaseForTest } from '../state/Database.js';
import { AuditLog } from '../state/AuditLog.js';
import type { WorkerAssignment } from '../orchestrator/WorkerRunner.js';

let projectRoot: string;

function assignment(overrides: Partial<WorkerAssignment> = {}): WorkerAssignment {
  return {
    storyId: 'story-001-001',
    epicId: 'epic-001',
    branchName: 'story/story-001-001',
    baseSha: 'abc',
    worktreePath: '/tmp/wt',
    projectRoot,
    skills: [],
    story: {
      id: 'story-001-001',
      title: 'Add login',
      description: 'do it',
      acceptance_criteria: ['works'],
      estimated_complexity: 'small',
      dependencies: [],
    },
    ...overrides,
  };
}

beforeEach(() => {
  resetDatabaseForTest();
  projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'loom-guidance-'));
});

afterEach(() => {
  resetDatabaseForTest();
  fs.rmSync(projectRoot, { recursive: true, force: true });
});

describe('OperatorGuidance write/read', () => {
  it('appends a timestamped entry to .loom/guidance/<story-id>.md', () => {
    const g = new OperatorGuidance({ projectRoot });
    const entry = g.add('story-001-001', 'focus on the auth middleware');
    assert.ok(entry.timestamp);
    assert.equal(entry.message, 'focus on the auth middleware');
    const content = g.read('story-001-001') ?? '';
    assert.match(content, /focus on the auth middleware/);
    assert.match(content, /operator/);
  });

  it('layers multiple entries — earlier guidance survives', () => {
    const g = new OperatorGuidance({ projectRoot });
    g.add('story-001-001', 'first guidance');
    g.add('story-001-001', 'second guidance after revision');
    const content = g.read('story-001-001') ?? '';
    assert.match(content, /first guidance/);
    assert.match(content, /second guidance/);
  });

  it('records each add to audit_log when a db is provided', () => {
    const db = openDatabase(path.join(projectRoot, '.loom'));
    const g = new OperatorGuidance({ projectRoot, db });
    g.add('story-001-001', 'be careful with the migrations');
    const audit = new AuditLog(db).recent(5);
    const row = audit.find((r) => r.action === 'operator_guidance_add');
    assert.ok(row, 'audit row should land');
    assert.equal(row?.command, 'story-001-001');
  });

  it('clear() removes the file and audit-logs the action', () => {
    const db = openDatabase(path.join(projectRoot, '.loom'));
    const g = new OperatorGuidance({ projectRoot, db });
    g.add('story-001-001', 'before clear');
    g.clear('story-001-001');
    assert.equal(g.read('story-001-001'), null);
    const audit = new AuditLog(db).recent(5);
    assert.ok(audit.find((r) => r.action === 'operator_guidance_clear'));
  });

  it('listStories enumerates every guidance file', () => {
    const g = new OperatorGuidance({ projectRoot });
    g.add('story-001-001', 'a');
    g.add('story-001-002', 'b');
    assert.deepEqual(g.listStories().sort(), ['story-001-001', 'story-001-002']);
  });

  it('rejects empty input', () => {
    const g = new OperatorGuidance({ projectRoot });
    assert.throws(() => g.add('', 'msg'));
    assert.throws(() => g.add('story-001-001', '   '));
  });
});

describe('buildWorkerPrompt with operator guidance', () => {
  it('does NOT include guidance when the flag is off (bench baseline preservation)', () => {
    new OperatorGuidance({ projectRoot }).add('story-001-001', 'PRIORITY: skip the docs');
    // The baseline call MUST not surface the guidance content.
    const prompt = buildWorkerPrompt(assignment());
    assert.ok(!prompt.includes('PRIORITY: skip the docs'));
    assert.ok(!prompt.includes('Operator guidance'));
  });

  it('includes guidance when includeOperatorGuidance=true and a file exists', () => {
    new OperatorGuidance({ projectRoot }).add('story-001-001', 'PRIORITY: skip the docs');
    const prompt = buildWorkerPrompt(assignment(), { includeOperatorGuidance: true });
    assert.match(prompt, /Operator guidance \(PRIORITY/);
    assert.match(prompt, /PRIORITY: skip the docs/);
  });

  it('emits no Operator guidance section when flag is on but no file exists', () => {
    const prompt = buildWorkerPrompt(assignment(), { includeOperatorGuidance: true });
    assert.ok(!prompt.includes('Operator guidance'));
  });

  it('layers guidance on top of the revision block', () => {
    new OperatorGuidance({ projectRoot }).add('story-001-001', 'do not refactor the helper');
    const prompt = buildWorkerPrompt(assignment(), {
      revisionContext: '- [blocker] line 42 — null check missing',
      includeOperatorGuidance: true,
    });
    assert.match(prompt, /Revision request/);
    assert.match(prompt, /do not refactor the helper/);
  });
});
