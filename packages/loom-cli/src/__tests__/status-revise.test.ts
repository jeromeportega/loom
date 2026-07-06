/**
 * Unit tests for revise_round tag in `loom status` (story-076-004).
 *
 * AC: revise_round = 0 → no tag; revise_round = 2 → "(revise 2)" tag
 *     after "(recovered N)" and before "[model]"; elapsed tag unaffected;
 *     missing revise_round (older rows) treated as 0, no error.
 */
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createDatabase, EpicStore, AgentStore, RecoveryStore } from '@loom-ai/core';
import { runStatus } from '../commands/status.js';

let repo: string;
let prevCwd: string;

beforeEach(() => {
  repo = fs.mkdtempSync(path.join(os.tmpdir(), 'loom-status-revise-'));
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

// ─── revise_round = 0: no tag ─────────────────────────────────────────────────

describe('loom status — revise_round = 0 (no tag)', () => {
  it('does not emit "(revise" tag when revise_round is 0', () => {
    const db = createDatabase(path.join(repo, '.loom', 'loom.db'));
    new EpicStore(db).create('epic-076', 'Revise test epic');
    const agents = new AgentStore(db);
    const agent = agents.create('epic-076', 'story-076-004', 'No revise story');
    agents.setModel(agent.id, 'claude-sonnet-4-6');
    // revise_round defaults to 0 — no increment needed
    db.close();

    const out = captureText({});
    assert.ok(
      !out.includes('(revise'),
      `Must NOT include '(revise' tag when revise_round is 0:\n${out}`
    );
  });
});

// ─── revise_round = 2: tag present ───────────────────────────────────────────

describe('loom status — revise_round = 2 (tag present)', () => {
  it('emits "(revise 2)" tag when revise_round is 2', () => {
    const db = createDatabase(path.join(repo, '.loom', 'loom.db'));
    new EpicStore(db).create('epic-076', 'Revise test epic');
    const agents = new AgentStore(db);
    const agent = agents.create('epic-076', 'story-076-004', 'Two-round revise story');
    agents.setModel(agent.id, 'claude-sonnet-4-6');
    agents.incrementReviseRound(agent.id);
    agents.incrementReviseRound(agent.id);
    db.close();

    const out = captureText({});
    assert.ok(
      out.includes('(revise 2)'),
      `Expected '(revise 2)' tag in text output:\n${out}`
    );
  });
});

// ─── Tag position: after (retry N) and (recovered N), before [model] ─────────

describe('loom status — revise tag position', () => {
  it('(revise 2) appears after (retry 1) and (recovered 1), before [model]', () => {
    const db = createDatabase(path.join(repo, '.loom', 'loom.db'));
    new EpicStore(db).create('epic-076', 'Position test epic');
    const agents = new AgentStore(db);

    // Insert the "old" attempt with a definitively past timestamp via raw SQL so
    // listLatestByEpic always prefers the newer agent below (same-millisecond
    // tie-breaks on MAX(id) are non-deterministic with crypto random suffixes).
    db.prepare(
      `INSERT INTO agents (id, epic_id, story_id, story_title, status, updated_at, revise_round)
       VALUES ('agent-story-076-004-old000', 'epic-076', 'story-076-004', 'Position story', 'blocked', '2020-01-01T00:00:00.000Z', 0)`
    ).run();

    // Current attempt — created now, so updated_at is definitely newer.
    const a2 = agents.create('epic-076', 'story-076-004', 'Position story');
    agents.setModel(a2.id, 'claude-sonnet-4-6');
    agents.updateStatus(a2.id, 'running', { started_at: new Date().toISOString() });
    agents.incrementReviseRound(a2.id);
    agents.incrementReviseRound(a2.id);

    new RecoveryStore(db).incrementRecoveryCount('story-076-004');
    db.close();

    const out = captureText({});

    // All three tags must be present
    assert.ok(out.includes('(retry 1)'),    `Expected '(retry 1)' in output:\n${out}`);
    assert.ok(out.includes('(recovered 1)'), `Expected '(recovered 1)' in output:\n${out}`);
    assert.ok(out.includes('(revise 2)'),    `Expected '(revise 2)' in output:\n${out}`);

    // Check ordering on the story's line
    const storyLine = out.split('\n').find((l) => l.includes('story-076-004'));
    assert.ok(storyLine, `Story line must be present:\n${out}`);

    const posRecovered = storyLine.indexOf('(recovered 1)');
    const posRevise    = storyLine.indexOf('(revise 2)');
    const posModel     = storyLine.indexOf('[');

    assert.ok(posRecovered < posRevise, `'(recovered 1)' must appear before '(revise 2)' — positions: ${posRecovered}, ${posRevise}`);
    assert.ok(posRevise < posModel,     `'(revise 2)' must appear before '[model]' — positions: ${posRevise}, ${posModel}`);
  });
});

// ─── Elapsed-time tag unaffected ─────────────────────────────────────────────

describe('loom status — elapsed tag unaffected by revise tag', () => {
  it('elapsed-time token is still present alongside the revise tag', () => {
    const db = createDatabase(path.join(repo, '.loom', 'loom.db'));
    new EpicStore(db).create('epic-076', 'Elapsed test epic');
    const agents = new AgentStore(db);
    const agent = agents.create('epic-076', 'story-076-004', 'Elapsed story');
    agents.setModel(agent.id, 'claude-sonnet-4-6');
    agents.updateStatus(agent.id, 'running', { started_at: new Date().toISOString() });
    agents.incrementReviseRound(agent.id);
    agents.incrementReviseRound(agent.id);
    db.close();

    const out = captureText({});
    // Elapsed is formatted as "(Ns)" or "(Nm Ns)" or "(Nh Nm)"
    assert.ok(
      /\(\d+[smh]/.test(out),
      `Expected elapsed-time token (e.g. "(0s)") in output:\n${out}`
    );
    assert.ok(out.includes('(revise 2)'), `Expected '(revise 2)' tag alongside elapsed:\n${out}`);
  });
});

// ─── revise_round = 0 defensiveness (no tag, no error) ───────────────────────
//
// The schema column has NOT NULL DEFAULT 0, so real rows never carry NULL.
// The formatter uses `(agent.revise_round ?? 0)` to guard against any future
// nullable or pre-migration row. Verify the zero path emits no tag and does not
// throw (implicitly tested by the revise_round=0 suite above, but also confirmed
// here with an explicit assertion).

describe('loom status — revise_round 0 is silent (no throw, no tag)', () => {
  it('no error and no revise tag when revise_round is 0', () => {
    const db = createDatabase(path.join(repo, '.loom', 'loom.db'));
    new EpicStore(db).create('epic-076', 'Zero-revise test epic');
    const agents = new AgentStore(db);
    const agent = agents.create('epic-076', 'story-076-004b', 'Zero revise story');
    agents.setModel(agent.id, 'claude-sonnet-4-6');
    db.close();

    let out = '';
    assert.doesNotThrow(() => {
      out = captureText({});
    }, 'runStatus must not throw when revise_round is 0');

    assert.ok(
      !out.includes('(revise'),
      `Must NOT include '(revise' tag when revise_round is 0:\n${out}`
    );
  });
});
