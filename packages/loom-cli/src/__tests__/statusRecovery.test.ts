/**
 * Tests for per-story auto-recovery count surfacing in `loom status` (story-061-004).
 *
 * AC1 — `loom status` shows the per-story auto-recovery count for stories that have
 *        been auto-recovered (text: "(recovered N)" tag; JSON: recovery_count field).
 * AC2 — The displayed count reflects the persisted RecoveryStore value (matches DB).
 * AC3 — Stories with zero auto-recoveries display byte-identically to today (no tag).
 * AC4 — After a simulated auto-recovery (seeded increment), re-running status reflects
 *        the new count in both JSON and text.
 */
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createDatabase, EpicStore, AgentStore, RecoveryStore, prepareRepoState } from '@loom-ai/core';
import { runStatus } from '../commands/status.js';

let repo: string;
let prevCwd: string;

beforeEach(() => {
  repo = fs.mkdtempSync(path.join(os.tmpdir(), 'loom-status-recovery-'));
  fs.mkdirSync(path.join(repo, '.loom'), { recursive: true });
  fs.writeFileSync(path.join(repo, '.loom', 'policy.yaml'), 'version: 1\n');
  prevCwd = process.cwd();
  process.chdir(repo);
});

afterEach(() => {
  process.chdir(prevCwd);
  fs.rmSync(repo, { recursive: true, force: true });
});

function captureText(options: Parameters<typeof runStatus>[0]): string {
  const lines: string[] = [];
  const orig = console.log;
  console.log = (...args: unknown[]): void => {
    lines.push(args.map(String).join(' '));
  };
  try {
    runStatus(options);
  } finally {
    console.log = orig;
  }
  return lines.join('\n');
}

function captureJson(options: Parameters<typeof runStatus>[0]): Record<string, unknown> {
  const lines: string[] = [];
  const orig = console.log;
  console.log = (...args: unknown[]): void => {
    lines.push(args.map(String).join(' '));
  };
  try {
    runStatus({ ...options, json: true });
  } finally {
    console.log = orig;
  }
  return JSON.parse(lines.join('\n')) as Record<string, unknown>;
}

// ─── AC1 + AC2: count present for recovered stories ───────────────────────────

describe('loom status — recovery count display (AC1, AC2)', () => {
  it('[text] shows "(recovered N)" tag when recovery_count > 0', () => {
    const db = createDatabase(path.join(repo, '.loom', 'loom.db'));
    new EpicStore(db).create('epic-061', 'Recovery epic');
    const agents = new AgentStore(db);
    const agent = agents.create('epic-061', 'story-061-001', 'Recovered story');
    agents.setModel(agent.id, 'claude-sonnet-4-6');
    const recoveryStore = new RecoveryStore(db);
    recoveryStore.incrementRecoveryCount('story-061-001');
    db.close();

    const out = captureText({});
    assert.ok(
      out.includes('(recovered 1)'),
      `Expected '(recovered 1)' tag in text output:\n${out}`
    );
  });

  it('[text] shows correct count after multiple recoveries', () => {
    const db = createDatabase(path.join(repo, '.loom', 'loom.db'));
    new EpicStore(db).create('epic-061', 'Recovery epic');
    const agents = new AgentStore(db);
    const agent = agents.create('epic-061', 'story-061-001', 'Multi-recovered story');
    agents.setModel(agent.id, 'claude-sonnet-4-6');
    const recoveryStore = new RecoveryStore(db);
    recoveryStore.incrementRecoveryCount('story-061-001');
    recoveryStore.incrementRecoveryCount('story-061-001');
    recoveryStore.incrementRecoveryCount('story-061-001');
    db.close();

    const out = captureText({});
    assert.ok(
      out.includes('(recovered 3)'),
      `Expected '(recovered 3)' tag in text output:\n${out}`
    );
  });

  it('[JSON] recovery_count is present with correct value when > 0', () => {
    const db = createDatabase(path.join(repo, '.loom', 'loom.db'));
    new EpicStore(db).create('epic-061', 'Recovery epic');
    const agents = new AgentStore(db);
    const agent = agents.create('epic-061', 'story-061-001', 'Recovered story');
    agents.setModel(agent.id, 'claude-sonnet-4-6');
    const recoveryStore = new RecoveryStore(db);
    recoveryStore.incrementRecoveryCount('story-061-001');
    recoveryStore.incrementRecoveryCount('story-061-001');
    db.close();

    const payload = captureJson({}) as { epics: Array<{ stories: Array<{ id: string; recovery_count?: number }> }> };
    const story = payload.epics[0]?.stories.find((s) => s.id === 'story-061-001');
    assert.ok(story, 'story-061-001 must appear in JSON output');
    assert.equal(story.recovery_count, 2, 'recovery_count must equal the persisted DB value');
  });

  it('[AC2] JSON recovery_count equals RecoveryStore.getRecoveryCount (DB is source of truth)', () => {
    const db = createDatabase(path.join(repo, '.loom', 'loom.db'));
    new EpicStore(db).create('epic-061', 'Recovery epic');
    const agents = new AgentStore(db);
    const agent = agents.create('epic-061', 'story-061-001', 'Source-of-truth story');
    agents.setModel(agent.id, 'claude-sonnet-4-6');
    const recoveryStore = new RecoveryStore(db);
    recoveryStore.incrementRecoveryCount('story-061-001');
    recoveryStore.incrementRecoveryCount('story-061-001');
    const persistedCount = recoveryStore.getRecoveryCount('story-061-001');
    db.close();

    const payload = captureJson({}) as { epics: Array<{ stories: Array<{ id: string; recovery_count?: number }> }> };
    const story = payload.epics[0]?.stories.find((s) => s.id === 'story-061-001');
    assert.ok(story, 'story-061-001 must appear in JSON output');
    assert.equal(
      story.recovery_count,
      persistedCount,
      `JSON recovery_count (${story.recovery_count}) must equal persisted DB value (${persistedCount})`
    );
  });
});

// ─── AC3: zero recoveries — byte-identical output ─────────────────────────────

describe('loom status — zero recoveries unchanged (AC3)', () => {
  it('[text] no "(recovered" tag when recovery_count is 0', () => {
    const db = createDatabase(path.join(repo, '.loom', 'loom.db'));
    new EpicStore(db).create('epic-061', 'Normal epic');
    const agents = new AgentStore(db);
    const agent = agents.create('epic-061', 'story-061-001', 'Normal story');
    agents.setModel(agent.id, 'claude-sonnet-4-6');
    // No recovery increments — count stays at 0.
    db.close();

    const out = captureText({});
    assert.ok(
      !out.includes('(recovered'),
      `Must NOT include '(recovered' tag when recovery_count is 0:\n${out}`
    );
  });

  it('[JSON] recovery_count omitted from JSON when 0', () => {
    const db = createDatabase(path.join(repo, '.loom', 'loom.db'));
    new EpicStore(db).create('epic-061', 'Normal epic');
    const agents = new AgentStore(db);
    const agent = agents.create('epic-061', 'story-061-001', 'Normal story');
    agents.setModel(agent.id, 'claude-sonnet-4-6');
    db.close();

    const payload = captureJson({}) as { epics: Array<{ stories: Array<{ id: string; recovery_count?: number }> }> };
    const story = payload.epics[0]?.stories.find((s) => s.id === 'story-061-001');
    assert.ok(story, 'story-061-001 must appear in JSON output');
    assert.equal(
      story.recovery_count,
      undefined,
      'recovery_count must be absent (undefined) when 0'
    );
    assert.ok(
      !Object.prototype.hasOwnProperty.call(story, 'recovery_count'),
      'recovery_count key must be absent entirely from JSON when 0'
    );
  });
});

// ─── AC4: re-running status after simulated recovery reflects new count ────────
//
// prepareRepoState may migrate the DB from .loom/loom.db to a loom-home path on
// the first status run. After migration, writes must go to the migrated path.
// We resolve it via prepareRepoState (same logic as resolveDbPath in status.ts)
// so both status reads and between-run writes hit the same file.

describe('loom status — after simulated recovery (AC4)', () => {
  it('[text] re-run after incrementing recovery count shows updated tag', () => {
    const db = createDatabase(path.join(repo, '.loom', 'loom.db'));
    new EpicStore(db).create('epic-061', 'Recovery epic');
    const agents = new AgentStore(db);
    const agent = agents.create('epic-061', 'story-061-001', 'Auto-recovered story');
    agents.setModel(agent.id, 'claude-sonnet-4-6');
    // Seed recovery_count=1 before the first status run so migration includes it.
    new RecoveryStore(db).incrementRecoveryCount('story-061-001');
    db.close();

    // First run: recovery already seeded; must show "(recovered 1)"
    const first = captureText({});
    assert.ok(
      first.includes('(recovered 1)'),
      `First run: must include '(recovered 1)' tag:\n${first}`
    );

    // Simulate a second auto-recovery. After the first status run, the DB may
    // have been migrated to loom-home. Use prepareRepoState to resolve the real path.
    const { dbPath } = prepareRepoState(repo, {});
    const db2 = createDatabase(dbPath);
    new RecoveryStore(db2).incrementRecoveryCount('story-061-001');
    db2.close();

    // Second run: should reflect the incremented count
    const second = captureText({});
    assert.ok(
      second.includes('(recovered 2)'),
      `Second run: must include '(recovered 2)' tag:\n${second}`
    );
  });

  it('[JSON] re-run after incrementing recovery count reflects new count in JSON', () => {
    const db = createDatabase(path.join(repo, '.loom', 'loom.db'));
    new EpicStore(db).create('epic-061', 'Recovery epic');
    const agents = new AgentStore(db);
    const agent = agents.create('epic-061', 'story-061-001', 'Auto-recovered story');
    agents.setModel(agent.id, 'claude-sonnet-4-6');
    // Seed recovery_count=1 before the first status run.
    new RecoveryStore(db).incrementRecoveryCount('story-061-001');
    db.close();

    // First run: recovery_count=1
    const first = captureJson({}) as { epics: Array<{ stories: Array<{ id: string; recovery_count?: number }> }> };
    const storyFirst = first.epics[0]?.stories.find((s) => s.id === 'story-061-001');
    assert.equal(storyFirst?.recovery_count, 1, 'First run: recovery_count must be 1');

    // Simulate a second recovery via the migrated DB path.
    const { dbPath } = prepareRepoState(repo, {});
    const db2 = createDatabase(dbPath);
    new RecoveryStore(db2).incrementRecoveryCount('story-061-001');
    db2.close();

    // Second run: recovery_count=2
    const second = captureJson({}) as { epics: Array<{ stories: Array<{ id: string; recovery_count?: number }> }> };
    const storySecond = second.epics[0]?.stories.find((s) => s.id === 'story-061-001');
    assert.equal(storySecond?.recovery_count, 2, 'Second run: recovery_count must be 2 after simulated re-recovery');
  });
});

// ─── Standalone stories also show recovery count ──────────────────────────────

describe('loom status — standalone story recovery count', () => {
  it('[text] standalone story shows "(recovered N)" tag when auto-recovered', () => {
    const db = createDatabase(path.join(repo, '.loom', 'loom.db'));
    new EpicStore(db).createStandalone('story-061', 'Standalone task');
    const agents = new AgentStore(db);
    const agent = agents.create('story-061', 'story-061', 'Standalone task');
    agents.setModel(agent.id, 'claude-sonnet-4-6');
    new RecoveryStore(db).incrementRecoveryCount('story-061');
    db.close();

    const out = captureText({});
    assert.ok(
      out.includes('(recovered 1)'),
      `Expected '(recovered 1)' tag in standalone text output:\n${out}`
    );
  });

  it('[JSON] standalone story recovery_count present in stories array when > 0', () => {
    const db = createDatabase(path.join(repo, '.loom', 'loom.db'));
    new EpicStore(db).createStandalone('story-061', 'Standalone task');
    const agents = new AgentStore(db);
    const agent = agents.create('story-061', 'story-061', 'Standalone task');
    agents.setModel(agent.id, 'claude-sonnet-4-6');
    new RecoveryStore(db).incrementRecoveryCount('story-061');
    db.close();

    const payload = captureJson({}) as {
      epics: Array<{ kind?: string; stories: Array<{ id: string; recovery_count?: number }> }>;
    };
    const entry = payload.epics.find((e) => e.kind === 'standalone');
    assert.ok(entry, 'Standalone entry must appear with kind=standalone');
    const story = entry.stories.find((s) => s.id === 'story-061');
    assert.ok(story, 'story-061 must appear in stories array');
    assert.equal(story.recovery_count, 1, 'recovery_count must be 1 for standalone story');
  });

  it('[AC3] standalone story with zero recoveries has no recovery_count in JSON', () => {
    const db = createDatabase(path.join(repo, '.loom', 'loom.db'));
    new EpicStore(db).createStandalone('story-062', 'Zero-recovery standalone');
    const agents = new AgentStore(db);
    const agent = agents.create('story-062', 'story-062', 'Zero-recovery standalone');
    agents.setModel(agent.id, 'claude-sonnet-4-6');
    db.close();

    const payload = captureJson({}) as {
      epics: Array<{ kind?: string; stories: Array<{ id: string; recovery_count?: number }> }>;
    };
    const entry = payload.epics.find((e) => e.kind === 'standalone');
    assert.ok(entry, 'Standalone entry must appear');
    const story = entry.stories.find((s) => s.id === 'story-062');
    assert.ok(story, 'story-062 must appear in stories array');
    assert.ok(
      !Object.prototype.hasOwnProperty.call(story, 'recovery_count'),
      'recovery_count key must be absent from JSON when 0'
    );
  });
});
