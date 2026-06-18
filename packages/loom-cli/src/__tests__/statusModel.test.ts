/**
 * Tests for per-story model rendering in `loom status` (epic-013, story-013-003).
 *
 * AC1 — agent line shows the per-story model id when populated.
 * AC2 — agent line shows literal 'unknown' when model is NULL.
 * AC3 — rendered output contains only the model id string, no credentials.
 */
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createDatabase, EpicStore, AgentStore } from '@loom-ai/core';
import { runStatus } from '../commands/status.js';

let repo: string;
let prevCwd: string;

beforeEach(() => {
  repo = fs.mkdtempSync(path.join(os.tmpdir(), 'loom-status-model-'));
  fs.mkdirSync(path.join(repo, '.loom'), { recursive: true });
  prevCwd = process.cwd();
  process.chdir(repo);
});

afterEach(() => {
  process.chdir(prevCwd);
  fs.rmSync(repo, { recursive: true, force: true });
});

function captureStatus(options: Parameters<typeof runStatus>[0]): string {
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

describe('loom status — per-story model rendering', () => {
  it('[AC1] shows the model id on the agent line when the agent has a populated model', () => {
    const db = createDatabase(path.join(repo, '.loom', 'loom.db'));
    new EpicStore(db).create('epic-001', 'My Epic');
    const agents = new AgentStore(db);
    const agent = agents.create('epic-001', 'story-001-001', 'Do the thing');
    agents.setModel(agent.id, 'claude-opus-4-8');
    db.close();

    const out = captureStatus({});
    assert.ok(
      out.includes('claude-opus-4-8'),
      `Expected model id 'claude-opus-4-8' in status output:\n${out}`
    );
  });

  it('[AC2] shows literal "unknown" on the agent line when model is NULL (pre-migration row)', () => {
    const db = createDatabase(path.join(repo, '.loom', 'loom.db'));
    new EpicStore(db).create('epic-001', 'My Epic');
    const agents = new AgentStore(db);
    // Create agent without calling setModel → model stays NULL
    agents.create('epic-001', 'story-001-001', 'Do the thing');
    db.close();

    const out = captureStatus({});
    assert.ok(
      out.includes('[unknown]'),
      `Expected '[unknown]' in status output for NULL model:\n${out}`
    );
    // Must never render a guessed model id in place of NULL
    assert.ok(
      !out.includes('claude-opus'),
      `Output must not contain a guessed model id:\n${out}`
    );
  });

  it('[AC3] rendered output contains only the model id — no API key, endpoint, or auth fields', () => {
    const db = createDatabase(path.join(repo, '.loom', 'loom.db'));
    new EpicStore(db).create('epic-001', 'My Epic');
    const agents = new AgentStore(db);
    const agent = agents.create('epic-001', 'story-001-001', 'Do the thing');
    agents.setModel(agent.id, 'claude-sonnet-4-6');
    db.close();

    const out = captureStatus({});
    // Model id appears
    assert.ok(out.includes('claude-sonnet-4-6'), `Model id must appear:\n${out}`);
    // No credential or endpoint patterns
    assert.ok(!/sk-ant-/i.test(out), 'Output must not contain API key patterns');
    assert.ok(!/api\.anthropic\.com/i.test(out), 'Output must not contain endpoint URLs');
    assert.ok(!/Authorization/i.test(out), 'Output must not contain auth headers');
  });
});
