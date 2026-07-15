/**
 * story-095-003 — `loom status` critical-path section.
 *
 * When an epic has a yaml_path pointing to stories with `estimated_effort`
 * and `dependencies`, the status output includes a labeled "Critical path:"
 * section. When no effort data is present, the section is labeled
 * "(no effort estimates)". Epics with no yaml_path produce no section.
 */
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import yaml from 'js-yaml';
import { createDatabase, EpicStore } from '@loom-ai/core';
import { runStatus } from '../commands/status.js';

let repo: string;
let prevCwd: string;

beforeEach(() => {
  repo = fs.mkdtempSync(path.join(os.tmpdir(), 'loom-status-cp-'));
  fs.mkdirSync(path.join(repo, '.loom'), { recursive: true });
  prevCwd = process.cwd();
  process.chdir(repo);
});

afterEach(() => {
  process.chdir(prevCwd);
  fs.rmSync(repo, { recursive: true, force: true });
});

function db(): ReturnType<typeof createDatabase> {
  return createDatabase(path.join(repo, '.loom', 'loom.db'));
}

function captureStatus(): string {
  const lines: string[] = [];
  const orig = console.log;
  console.log = (...args: unknown[]): void => {
    lines.push(args.map(String).join(' '));
  };
  try {
    runStatus({});
  } finally {
    console.log = orig;
  }
  return lines.join('\n');
}

function writeEpicYaml(epicId: string, stories: unknown[]): string {
  const rel = `.loom/epics/${epicId}.yaml`;
  const abs = path.join(repo, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, yaml.dump({
    epic_id: epicId,
    title: `Test epic ${epicId}`,
    status: 'planned',
    priority: 'must-have',
    prd_ref: 'x',
    requirements: ['FR-1'],
    stories,
  }));
  return rel;
}

describe('loom status — critical path section (story-095-003)', () => {
  it('shows Critical path section with minutes when stories have estimated_effort', () => {
    const yamlPath = writeEpicYaml('epic-401', [
      {
        id: 'story-401-001',
        title: 'Foundation story long enough',
        description: 'desc',
        acceptance_criteria: ['AC1'],
        estimated_complexity: 'small',
        dependencies: [],
        estimated_effort: 30,
      },
      {
        id: 'story-401-002',
        title: 'Feature story long enough',
        description: 'desc',
        acceptance_criteria: ['AC1'],
        estimated_complexity: 'small',
        dependencies: ['story-401-001'],
        estimated_effort: 45,
      },
    ]);

    const conn = db();
    const epics = new EpicStore(conn);
    epics.create('epic-401', 'Test epic epic-401', yamlPath);
    conn.close();

    const out = captureStatus();

    assert.match(out, /Critical path:/, 'output must contain "Critical path:" label');
    assert.match(out, /story-401-001/, 'critical path must include first story');
    assert.match(out, /story-401-002/, 'critical path must include second story');
    assert.match(out, /75 min estimated/, 'total estimated minutes must be shown (30+45=75)');
    // story-401-001 should appear before story-401-002 in the chain
    const cpIdx = out.indexOf('Critical path:');
    const idx1 = out.indexOf('story-401-001', cpIdx);
    const idx2 = out.indexOf('story-401-002', cpIdx);
    assert.ok(idx1 < idx2, 'foundation story must appear before dependent story in chain');
  });

  it('shows Critical path section labeled (no effort estimates) when no estimated_effort', () => {
    const yamlPath = writeEpicYaml('epic-402', [
      {
        id: 'story-402-001',
        title: 'Story without effort data',
        description: 'desc',
        acceptance_criteria: ['AC1'],
        estimated_complexity: 'small',
        dependencies: [],
      },
      {
        id: 'story-402-002',
        title: 'Dependent story no effort',
        description: 'desc',
        acceptance_criteria: ['AC1'],
        estimated_complexity: 'small',
        dependencies: ['story-402-001'],
      },
    ]);

    const conn = db();
    const epics = new EpicStore(conn);
    epics.create('epic-402', 'Test epic epic-402', yamlPath);
    conn.close();

    const out = captureStatus();

    assert.match(out, /Critical path:/, 'output must contain "Critical path:" label');
    assert.match(out, /no effort estimates/, 'must label the section as no-effort when estimatedMinutes=0');
    assert.doesNotMatch(out, /\d+ min estimated/, 'must not show minutes when no effort data');
  });

  it('omits Critical path section for epics with no yaml_path (pre-feature epics)', () => {
    const conn = db();
    const epics = new EpicStore(conn);
    // Create epic without yaml_path (pre-feature: no YAML, no graph data)
    epics.create('epic-403', 'Pre-feature epic no yaml');
    conn.close();

    const out = captureStatus();

    assert.doesNotMatch(out, /Critical path:/, 'pre-feature epic must not have a critical path section');
  });

  it('omits Critical path section when yaml file does not exist', () => {
    const conn = db();
    const epics = new EpicStore(conn);
    // Create epic with yaml_path pointing to a non-existent file
    epics.create('epic-404', 'Epic with missing yaml', '.loom/epics/nonexistent.yaml');
    conn.close();

    const out = captureStatus();

    assert.doesNotMatch(out, /Critical path:/, 'must not crash or show section when yaml is missing');
  });

  it('shows single-story critical path when only one story is present', () => {
    const yamlPath = writeEpicYaml('epic-405', [
      {
        id: 'story-405-001',
        title: 'Solo story long enough title',
        description: 'desc',
        acceptance_criteria: ['AC1'],
        estimated_complexity: 'small',
        dependencies: [],
        estimated_effort: 20,
      },
    ]);

    const conn = db();
    const epics = new EpicStore(conn);
    epics.create('epic-405', 'Test epic epic-405', yamlPath);
    conn.close();

    const out = captureStatus();

    assert.match(out, /Critical path:/, 'single-story epic must still show critical path');
    assert.match(out, /story-405-001/, 'single story must appear in the chain');
    assert.match(out, /20 min estimated/, 'single story effort must be shown');
  });
});
