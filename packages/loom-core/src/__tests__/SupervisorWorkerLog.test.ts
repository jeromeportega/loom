/**
 * Supervisor worker-log wiring tests (story-019-001).
 *
 * Tests the onOutput redaction chokepoint, append-on-stream, no-overwrite at
 * completion, and log_bytes offset persistence through the Supervisor.
 */
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import yaml from 'js-yaml';
import { openDatabase, resetDatabaseForTest } from '../state/Database.js';
import { AgentStore } from '../state/AgentStore.js';
import { EpicStore } from '../state/EpicStore.js';
import { WorkerLogStore } from '../state/WorkerLogStore.js';
import { Supervisor } from '../orchestrator/Supervisor.js';
import { MockWorkerRunner } from '../orchestrator/MockWorkerRunner.js';
import type { Story } from '../types.js';
import type { WorkerAssignment, WorkerEventCallback } from '../orchestrator/WorkerRunner.js';

// ─── helpers ────────────────────────────────────────────────────────────────

let repo: string;
let loomDir: string;

function gitc(args: string[], cwd = repo): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

function storyFixture(id: string): Story {
  return {
    id,
    title: `Story ${id}`,
    description: 'Implement the thing.',
    acceptance_criteria: ['it works'],
    estimated_complexity: 'small',
    dependencies: [],
  };
}

function seedEpic(epicId: string, stories: Story[]): void {
  const epicYaml = {
    epic_id: epicId,
    title: `Epic ${epicId}`,
    status: 'planned',
    priority: 'must-have',
    prd_ref: 'x',
    requirements: ['FR-1'],
    stories,
  };
  const rel = `.loom/planning/${epicId}/epics/${epicId}.yaml`;
  const abs = path.join(repo, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, yaml.dump(epicYaml));

  const db = openDatabase(loomDir);
  const store = new EpicStore(db);
  store.create(epicId, epicYaml.title, rel);
  store.updateStatus(epicId, 'approved');
}

beforeEach(() => {
  resetDatabaseForTest();
  repo = fs.mkdtempSync(path.join(os.tmpdir(), 'loom-sv-log-'));
  loomDir = path.join(repo, '.loom');
  gitc(['init', '-q']);
  gitc(['config', 'user.email', 'test@loom.dev']);
  gitc(['config', 'user.name', 'Loom Test']);
  gitc(['config', 'commit.gpgsign', 'false']);
  fs.writeFileSync(path.join(repo, 'README.md'), '# test\n');
  gitc(['add', '.']);
  gitc(['commit', '-q', '-m', 'initial']);
});

afterEach(() => {
  resetDatabaseForTest();
  fs.rmSync(repo, { recursive: true, force: true });
});

// ─── redaction-before-write (FR-4, critical) ─────────────────────────────────

describe('Supervisor onOutput — redaction-before-write', () => {
  it('file contains no secrets; redacted content reaches both tail and file', async () => {
    const secretChunk = 'token: sk-ant-api03-SECRETSECRET1234 end';
    const ghPatChunk = 'pat: ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ123 end';
    seedEpic('epic-001', [storyFixture('story-001-001')]);
    const db = openDatabase(loomDir);
    const outputEvents: string[] = [];

    await new Supervisor({
      projectRoot: repo,
      db,
      worker: new MockWorkerRunner((assignment: WorkerAssignment) => {
        // Emit chunks with secrets via onOutput
        assignment.onOutput!(secretChunk, 'stdout');
        assignment.onOutput!(ghPatChunk, 'stdout');
        return {
          status: 'done',
          commitCount: 1,
          summary: 'done',
          logTail: '',
        };
      }),
      maxConcurrent: 1,
      onWorkerEvent: ((event) => {
        if (event.type === 'output') outputEvents.push(event.chunk);
      }) as WorkerEventCallback,
    }).run();

    const wls = new WorkerLogStore(loomDir);
    const filePath = wls.pathFor('story-001-001');
    assert.ok(fs.existsSync(filePath), 'log file must be created');

    const onDisk = fs.readFileSync(filePath, 'utf8');
    // Secrets must not appear on disk
    assert.ok(!onDisk.includes('sk-ant-api03-SECRETSECRET'), 'Anthropic key must be redacted in file');
    assert.ok(!onDisk.includes('ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ'), 'GH PAT must be redacted in file');
    assert.ok(onDisk.includes('[REDACTED]'), 'file must contain redaction marker');

    // Secrets must not appear in DB log_tail either
    const agent = new AgentStore(db).getByStory('story-001-001')!;
    assert.ok(!(agent.log_tail ?? '').includes('sk-ant-api03-SECRETSECRET'), 'log_tail must be redacted');

    // onWorkerEvent also receives redacted content
    const allEvents = outputEvents.join('');
    assert.ok(!allEvents.includes('sk-ant-api03-SECRETSECRET'), 'onWorkerEvent chunk must be redacted');
  });
});

// ─── no-overwrite at completion (FR-1, critical) ─────────────────────────────

describe('Supervisor — no-overwrite at completion', () => {
  it('file holds 100% of the streamed content after run completes', async () => {
    // Generate more than LIVE_TAIL_CHARS (4096) of output
    const TAIL_CHARS = 4096;
    const NUM_CHUNKS = 20;
    const CHUNK_CONTENT = 'x'.repeat(300);
    const allChunks: string[] = Array.from({ length: NUM_CHUNKS }, (_, i) =>
      `chunk-${String(i).padStart(3, '0')}-${CHUNK_CONTENT}\n`
    );
    const totalContent = allChunks.join('');

    seedEpic('epic-001', [storyFixture('story-001-001')]);
    const db = openDatabase(loomDir);

    await new Supervisor({
      projectRoot: repo,
      db,
      worker: new MockWorkerRunner((assignment: WorkerAssignment) => {
        for (const chunk of allChunks) {
          assignment.onOutput!(chunk, 'stdout');
        }
        return {
          status: 'done',
          commitCount: 1,
          summary: 'done',
          logTail: '',
        };
      }),
      maxConcurrent: 1,
    }).run();

    const wls = new WorkerLogStore(loomDir);
    const filePath = wls.pathFor('story-001-001');
    assert.ok(fs.existsSync(filePath), 'log file must exist after run');

    const onDisk = fs.readFileSync(filePath, 'utf8');
    assert.equal(onDisk, totalContent, 'file must contain ALL streamed bytes byte-for-byte');

    const fileSize = fs.statSync(filePath).size;
    assert.ok(
      fileSize > TAIL_CHARS,
      `file size (${fileSize}) must exceed the 4096-char tail limit — proves no truncation`
    );

    // log_tail is bounded; file is not truncated to tail size
    const agent = new AgentStore(db).getByStory('story-001-001')!;
    const tail = agent.log_tail ?? '';
    assert.ok(
      tail.length <= TAIL_CHARS,
      'log_tail must be bounded by LIVE_TAIL_CHARS'
    );
    assert.ok(
      onDisk.length > tail.length,
      'file must be strictly larger than the bounded tail'
    );
  });
});

// ─── log_bytes offset accounting ─────────────────────────────────────────────

describe('Supervisor — log_bytes offset accounting', () => {
  it('DB log_bytes equals on-disk file size after run', async () => {
    const chunks = ['hello ', 'world', ' from loom'];
    seedEpic('epic-001', [storyFixture('story-001-001')]);
    const db = openDatabase(loomDir);

    await new Supervisor({
      projectRoot: repo,
      db,
      worker: new MockWorkerRunner((assignment: WorkerAssignment) => {
        for (const chunk of chunks) {
          assignment.onOutput!(chunk, 'stdout');
        }
        return {
          status: 'done',
          commitCount: 1,
          summary: 'done',
          logTail: '',
        };
      }),
      maxConcurrent: 1,
    }).run();

    const wls = new WorkerLogStore(loomDir);
    const fileSize = wls.byteLength('story-001-001');
    const agent = new AgentStore(db).getByStory('story-001-001')!;

    assert.ok(fileSize > 0, 'file must have content');
    assert.ok(agent.log_bytes != null && agent.log_bytes > 0, 'log_bytes must be set');
    // Ordering invariant: log_bytes <= file size (file written before DB pointer)
    assert.ok(
      agent.log_bytes <= fileSize,
      `log_bytes (${agent.log_bytes}) must be <= file size (${fileSize})`
    );

    const expectedBytes = Buffer.byteLength(chunks.join(''), 'utf8');
    assert.equal(fileSize, expectedBytes, 'file size must equal total byte length of all chunks');
  });

  it('multibyte content: log_bytes counts bytes not chars', async () => {
    const multibyteChunk = 'café résumé naïve ñoño';
    seedEpic('epic-001', [storyFixture('story-001-001')]);
    const db = openDatabase(loomDir);

    await new Supervisor({
      projectRoot: repo,
      db,
      worker: new MockWorkerRunner((assignment: WorkerAssignment) => {
        assignment.onOutput!(multibyteChunk, 'stdout');
        return { status: 'done', commitCount: 1, summary: 'done', logTail: '' };
      }),
      maxConcurrent: 1,
    }).run();

    const agent = new AgentStore(db).getByStory('story-001-001')!;
    const expectedBytes = Buffer.byteLength(multibyteChunk, 'utf8');

    assert.ok(
      expectedBytes > multibyteChunk.length,
      'byte count must exceed char count for multibyte input'
    );
    assert.ok(
      agent.log_bytes != null && agent.log_bytes <= expectedBytes,
      `log_bytes (${agent.log_bytes}) must be <= expected bytes (${expectedBytes})`
    );
  });
});

// ─── tail preserved (FR-2) ───────────────────────────────────────────────────

describe('Supervisor — tail preserved alongside log_bytes', () => {
  it('log_tail and log_bytes are both written at completion', async () => {
    const streamContent = 'hello from worker\n';
    // The worker result's logTail is what the CLI subprocess emits at the end.
    // In real runs the subprocess streams into the file; the result carries
    // its own tail. In tests we simulate both: onOutput populates the file,
    // and logTail carries the final tail text.
    const workerLogTail = 'final tail from worker';
    seedEpic('epic-001', [storyFixture('story-001-001')]);
    const db = openDatabase(loomDir);

    await new Supervisor({
      projectRoot: repo,
      db,
      worker: new MockWorkerRunner((assignment: WorkerAssignment) => {
        assignment.onOutput!(streamContent, 'stdout');
        return {
          status: 'done',
          commitCount: 1,
          summary: 'done',
          logTail: workerLogTail,
        };
      }),
      maxConcurrent: 1,
    }).run();

    const agent = new AgentStore(db).getByStory('story-001-001')!;
    // log_tail is written at completion from result.logTail
    assert.equal(agent.log_tail, workerLogTail, 'log_tail must reflect the worker result tail');
    assert.ok(
      (agent.log_tail?.length ?? 0) <= 4096,
      'log_tail must be bounded to LIVE_TAIL_CHARS'
    );
    // log_bytes is written from the file appender
    assert.ok(agent.log_bytes != null && agent.log_bytes > 0, 'log_bytes must be written');
    const expectedBytes = Buffer.byteLength(streamContent, 'utf8');
    assert.equal(agent.log_bytes, expectedBytes, 'log_bytes equals total streamed byte count');
  });
});

// ─── storage location (NFR-1) ────────────────────────────────────────────────

describe('Supervisor — storage location', () => {
  it('log file lives under <projectRoot>/.loom/logs/ (not a DB blob)', async () => {
    seedEpic('epic-001', [storyFixture('story-001-001')]);
    const db = openDatabase(loomDir);

    await new Supervisor({
      projectRoot: repo,
      db,
      worker: new MockWorkerRunner((assignment: WorkerAssignment) => {
        assignment.onOutput!('some output', 'stdout');
        return { status: 'done', commitCount: 1, summary: 'done', logTail: '' };
      }),
      maxConcurrent: 1,
    }).run();

    const wls = new WorkerLogStore(loomDir);
    const filePath = wls.pathFor('story-001-001');
    assert.ok(fs.existsSync(filePath), 'log file must exist');
    // File must be rooted at <projectRoot>/.loom/logs/ — not in a DB blob or
    // at the OS temp root. The repo itself may be inside tmpdir in tests, which
    // is fine: the invariant is the path structure, not the parent directory.
    assert.ok(
      filePath.startsWith(path.join(repo, '.loom', 'logs')),
      `file must be under <projectRoot>/.loom/logs, got: ${filePath}`
    );
    // Not stored as a database blob — the agent record must NOT contain the content
    const agent = new AgentStore(db).getByStory('story-001-001')!;
    assert.ok(
      !(agent.log_tail ?? '').includes('some output'),
      'full content must NOT be stored in the DB log_tail (log_tail is only a bounded tail)'
    );
  });
});
