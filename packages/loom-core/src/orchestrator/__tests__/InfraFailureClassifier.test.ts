import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import type { ChildProcessWithoutNullStreams, SpawnOptions } from 'node:child_process';
import { BaseCliWorker } from '../BaseCliWorker.js';
import {
  classifyAttempt,
  persistClassification,
  INFRA_SIGNATURES,
  type SpawnOutcome,
} from '../InfraFailureClassifier.js';
import {
  WorkerTimeoutGuard,
  type WorkerTimeoutGuardOptions,
} from '../WorkerTimeoutGuard.js';
import type { WorkerAssignment } from '../WorkerRunner.js';
import type { Story } from '../../types.js';
import type { InfraSignature } from '../resilience/types.js';
import { openDatabase, resetDatabaseForTest } from '../../state/Database.js';
import { AgentStore } from '../../state/AgentStore.js';
import { AuditLog } from '../../state/AuditLog.js';
import { EpicStore } from '../../state/EpicStore.js';

// ─── Deterministic fakes: no real CLI, no real timers, no sleeps ────────────

/**
 * A controllable child process exposing exactly the surface `spawnAgent`
 * touches. The test drives stdout/stderr/error/close manually; stdin writes
 * are captured. Mirrors the FakeChild used by CursorAgentWorkerStream.test.ts.
 */
class FakeChild extends EventEmitter {
  pid = 4242;
  stdout = new EventEmitter();
  stderr = new EventEmitter();
  stdinEnded = false;
  stdin: { write(s: string): boolean; end(): void; readonly writableEnded: boolean };

  constructor() {
    super();
    const child = this;
    this.stdin = {
      write(): boolean {
        return true;
      },
      end(): void {
        child.stdinEnded = true;
      },
      get writableEnded(): boolean {
        return child.stdinEnded;
      },
    };
  }

  emitStdout(s: string): void {
    this.stdout.emit('data', Buffer.from(s));
  }
  emitStderr(s: string): void {
    this.stderr.emit('data', Buffer.from(s));
  }
  /** Mirror a `child_process` spawn failure: the 'error' event, never a close. */
  emitSpawnError(message: string): void {
    this.emit('error', new Error(message));
  }
  close(code: number | null): void {
    this.emit('close', code);
  }
}

/**
 * The guard never fires in these tests — every signal we exercise is driven by
 * the spawn lifecycle, not a wall-clock kill. A null clock keeps it inert.
 */
class InertClock {
  now = (): number => 0;
  setInterval = (): unknown => 'poll';
  clearInterval = (): void => undefined;
  setTimeout = (): unknown => 'grace';
  clearTimeout = (): void => undefined;
}

/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * Minimal concrete BaseCliWorker whose subprocess is a FakeChild handed in via
 * the `spawnChild` seam. `runSpawn` returns the spawnAgent promise so the test
 * can grab `lastChild` and drive its events, exactly the way a real
 * cursor-agent death would arrive through the OS.
 */
class SeamWorker extends BaseCliWorker {
  lastChild?: FakeChild;
  private clock = new InertClock();

  protected binary(): string {
    return 'cursor-agent';
  }
  protected agentArgs(): string[] {
    return [];
  }
  protected spawnChild(
    _bin: string,
    _args: string[],
    _opts: SpawnOptions
  ): ChildProcessWithoutNullStreams {
    const c = new FakeChild();
    this.lastChild = c;
    return c as unknown as ChildProcessWithoutNullStreams;
  }
  protected createGuard(opts: WorkerTimeoutGuardOptions): WorkerTimeoutGuard {
    return new WorkerTimeoutGuard({
      ...opts,
      warnMs: 0,
      now: this.clock.now,
      setInterval: this.clock.setInterval,
      clearInterval: this.clock.clearInterval,
      setTimeout: this.clock.setTimeout,
      clearTimeout: this.clock.clearTimeout,
      killProcess: () => undefined,
    });
  }
  runSpawn(a: WorkerAssignment): Promise<SpawnOutcome> {
    return (this as any).spawnAgent(a, 'ignored') as Promise<SpawnOutcome>;
  }
}
/* eslint-enable @typescript-eslint/no-explicit-any */

const STORY: Story = {
  id: 'story-006-002',
  title: 'infra classifier',
  description: 'noop',
  acceptance_criteria: ['n/a'],
  estimated_complexity: 'medium',
  dependencies: [],
};

function assignment(over: Partial<WorkerAssignment> = {}): WorkerAssignment {
  return {
    storyId: STORY.id,
    epicId: 'epic-006',
    story: STORY,
    worktreePath: '/tmp/loom-fake-worktree',
    branchName: 'story/story-006-002',
    baseSha: '',
    projectRoot: '/tmp/loom-fake-worktree',
    skills: [],
    stallMs: 1000,
    absoluteCapMs: 100_000,
    ...over,
  };
}

// ─── The four infra signatures, each driven through the spawnChild seam ──────
//
// AC1: each of the four infra signatures is classified `infra_failure`, driven
// via the spawnChild seam in BaseCliWorker, each as its own asserted test.

describe('Infra signature (1/4): connection_loss — sourced from parseStreamLine output', () => {
  it('a cursor-agent connection drop in the streamed output classifies infra_failure', async () => {
    const w = new SeamWorker({ openPr: false });
    const p = w.runSpawn(assignment());
    const child = w.lastChild!;
    // The agent streamed real progress (loudness would NOT fire because it
    // exits 0 here) then the session dropped — the connection-loss line is the
    // evidence parseStreamLine surfaced into the accumulated output.
    child.emitStdout('Lost connection to cursor-agent: ECONNRESET\n');
    child.close(0);
    const outcome = await p;

    assert.equal(outcome.producedOutput, true, 'the child emitted output');
    const c = classifyAttempt(outcome);
    assert.equal(c.class, 'infra_failure');
    assert.equal(c.signature, 'connection_loss');
  });
});

describe('Infra signature (2/4): spawn_enoent — sourced from the child error event', () => {
  it('a spawn ENOENT (agent binary not on PATH) classifies infra_failure', async () => {
    const w = new SeamWorker({ openPr: false });
    const p = w.runSpawn(assignment());
    const child = w.lastChild!;
    // No output ever arrived — the binary could not even start.
    child.emitSpawnError('spawn cursor-agent ENOENT');
    const outcome = await p;

    assert.equal(outcome.code, null, 'a spawn error yields a null exit code');
    assert.equal(outcome.producedOutput, false);
    const c = classifyAttempt(outcome);
    assert.equal(c.class, 'infra_failure');
    assert.equal(c.signature, 'spawn_enoent');
  });
});

describe('Infra signature (3/4): cli_config_rename — sourced from the child error event', () => {
  it('an ENOENT on cli-config.json (rename race) classifies infra_failure', async () => {
    const w = new SeamWorker({ openPr: false });
    const p = w.runSpawn(assignment());
    const child = w.lastChild!;
    // cursor-agent rewrites cli-config.json atomically; reading it mid-rename
    // surfaces a transient ENOENT on THAT path — distinct from a missing binary.
    child.emitSpawnError(
      "ENOENT: no such file or directory, open '/home/u/.config/cursor/cli-config.json'"
    );
    const outcome = await p;

    const c = classifyAttempt(outcome);
    assert.equal(c.class, 'infra_failure');
    assert.equal(
      c.signature,
      'cli_config_rename',
      'a config-path ENOENT is the rename race, not a missing binary'
    );
  });
});

describe('Infra signature (4/4): exit_before_output — exit code + no output', () => {
  it('a non-zero exit having emitted nothing classifies infra_failure', async () => {
    const w = new SeamWorker({ openPr: false });
    const p = w.runSpawn(assignment());
    const child = w.lastChild!;
    // The process started, produced not a single byte, then died non-zero.
    child.close(1);
    const outcome = await p;

    assert.equal(outcome.producedOutput, false, 'no byte was ever emitted');
    assert.equal(outcome.code, 1);
    const c = classifyAttempt(outcome);
    assert.equal(c.class, 'infra_failure');
    assert.equal(c.signature, 'exit_before_output');
  });
});

// ─── The loudness invariant (AC2 / ADR-2 / FR-4) ─────────────────────────────

describe('Loudness invariant: output + non-zero exit is work_failure, never infra', () => {
  it('a worker that produced output then exited non-zero classifies work_failure', async () => {
    const w = new SeamWorker({ openPr: false });
    const p = w.runSpawn(assignment());
    const child = w.lastChild!;
    child.emitStdout('Running the test suite...\n');
    child.close(1);
    const outcome = await p;

    assert.equal(outcome.producedOutput, true);
    assert.equal(outcome.code, 1);
    const c = classifyAttempt(outcome);
    assert.equal(c.class, 'work_failure', 'a loud non-zero exit is a real work failure');
    assert.equal(c.signature, undefined, 'work_failure carries no infra signature');
  });

  it('the loudness gate WINS even when an infra signature is also present in the output', () => {
    // A connection-loss line is present AND the worker produced output AND
    // exited non-zero. The loudness gate must run BEFORE the signature table,
    // so this is work_failure — the matcher never gets the chance to fire.
    const outcome: SpawnOutcome = {
      code: 1,
      output: 'progress...\nLost connection to the agent\n',
      timedOut: false,
      producedOutput: true,
    };
    // The matcher itself WOULD fire in isolation — prove the gate overrides it.
    assert.equal(INFRA_SIGNATURES.map((m) => m(outcome)).find(Boolean), 'connection_loss');
    const c = classifyAttempt(outcome);
    assert.equal(c.class, 'work_failure', 'loudness gate beats a matching signature');
    assert.equal(c.signature, undefined);
  });
});

// ─── classifier structure: ordered table, extensibility, residual cases ──────
//
// AC3: the classifier consumes existing streaming signals and exposes a
// structure that accepts new signatures without rewiring.

describe('classifyAttempt — structure and residual behaviour', () => {
  it('a clean exit (code 0, no signature) is work_failure', () => {
    const c = classifyAttempt({
      code: 0,
      output: 'all good\n',
      timedOut: false,
      producedOutput: true,
    });
    assert.equal(c.class, 'work_failure');
    assert.equal(c.signature, undefined);
  });

  it('a zero-exit silent worker is work_failure, not exit_before_output', () => {
    // exit_before_output requires a NON-ZERO code; a clean silent exit is real.
    const c = classifyAttempt({
      code: 0,
      output: '',
      timedOut: false,
      producedOutput: false,
    });
    assert.equal(c.class, 'work_failure');
  });

  it('cli_config_rename is matched before the generic spawn_enoent (ordering)', () => {
    // A config-path ENOENT matches BOTH the rename predicate and the bare
    // ENOENT text. The table order guarantees the more specific one wins.
    const outcome: SpawnOutcome = {
      code: null,
      output: '',
      spawnError: "ENOENT: open '/x/cli-config.json'",
      timedOut: false,
      producedOutput: false,
    };
    assert.equal(classifyAttempt(outcome).signature, 'cli_config_rename');
  });

  it('INFRA_SIGNATURES is an ordered, append-extensible list of pure matchers', () => {
    assert.ok(Array.isArray(INFRA_SIGNATURES));
    assert.equal(INFRA_SIGNATURES.length, 4, 'exactly the four shipped signatures');
    for (const m of INFRA_SIGNATURES) assert.equal(typeof m, 'function');

    // Extensibility proof: a fifth matcher composes by ordinary first-match
    // semantics over the same SpawnOutcome — no classifier change required.
    const extended = [
      ...INFRA_SIGNATURES,
      (o: SpawnOutcome): InfraSignature | null =>
        /rate.?limit/i.test(o.output) ? 'connection_loss' : null,
    ];
    const o: SpawnOutcome = {
      code: 1,
      output: 'rate limit exceeded',
      timedOut: false,
      producedOutput: false,
    };
    const hit = extended.map((m) => m(o)).find(Boolean);
    assert.equal(hit, 'exit_before_output', 'existing matchers still take priority by order');
  });

  it('a spawn error that matches no pattern falls through to work_failure', () => {
    const c = classifyAttempt({
      code: null,
      output: '',
      spawnError: 'EACCES: permission denied',
      timedOut: false,
      producedOutput: false,
    });
    assert.equal(c.class, 'work_failure', 'an unrecognised fault is not blindly retried');
  });
});

// ─── persistence to story-006-001's column + audit detail (AC4) ──────────────

describe('persistClassification — writes the attempt_class column and audit row', () => {
  let loomDir: string;

  beforeEach(() => {
    resetDatabaseForTest();
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'loom-infra-'));
    loomDir = path.join(tmp, '.loom');
    fs.mkdirSync(loomDir, { recursive: true });
  });
  afterEach(() => {
    resetDatabaseForTest();
  });

  it('persists an infra_failure classification to the column and audit detail', () => {
    const db = openDatabase(loomDir);
    new EpicStore(db).create('epic-006', 'Epic 6');
    const agents = new AgentStore(db);
    const audit = new AuditLog(db);
    const agent = agents.create('epic-006', 'story-006-002');

    persistClassification(
      { agents, audit },
      agent.id,
      'story-006-002',
      { class: 'infra_failure', signature: 'spawn_enoent' },
      { producedOutput: false },
      1
    );

    // Column (story-006-001) — orthogonal to status (ADR-1).
    const row = agents.get(agent.id)!;
    assert.equal(row.attempt_class, 'infra_failure');

    // Audit detail carries the signature + loudness evidence.
    const auditRow = audit
      .getByStory('story-006-002')
      .find((r) => r.action === 'attempt_classified');
    assert.ok(auditRow, 'an attempt_classified audit row was written');
    const detail = JSON.parse(auditRow!.detail!) as Record<string, unknown>;
    assert.deepEqual(detail, {
      attempt_class: 'infra_failure',
      signature: 'spawn_enoent',
      retry_attempt: 1,
      produced_output: false,
    });
  });

  it('persists a work_failure with no signature and the loudness evidence', () => {
    const db = openDatabase(loomDir);
    new EpicStore(db).create('epic-006', 'Epic 6');
    const agents = new AgentStore(db);
    const audit = new AuditLog(db);
    const agent = agents.create('epic-006', 'story-006-002');

    persistClassification(
      { agents, audit },
      agent.id,
      'story-006-002',
      { class: 'work_failure' },
      { producedOutput: true }
    );

    assert.equal(agents.get(agent.id)!.attempt_class, 'work_failure');
    const detail = JSON.parse(
      audit.getByStory('story-006-002').find((r) => r.action === 'attempt_classified')!.detail!
    ) as Record<string, unknown>;
    assert.deepEqual(detail, {
      attempt_class: 'work_failure',
      produced_output: true,
    });
    assert.ok(!('signature' in detail), 'no signature on a work_failure');
    assert.ok(!('retry_attempt' in detail), 'no retry_attempt when unset');
  });

  it('end-to-end: a seam-driven spawn_enoent death is classified and persisted', async () => {
    const db = openDatabase(loomDir);
    new EpicStore(db).create('epic-006', 'Epic 6');
    const agents = new AgentStore(db);
    const audit = new AuditLog(db);
    const agent = agents.create('epic-006', 'story-006-002');

    const w = new SeamWorker({ openPr: false });
    const p = w.runSpawn(assignment());
    w.lastChild!.emitSpawnError('spawn cursor-agent ENOENT');
    const outcome = await p;

    const classification = classifyAttempt(outcome);
    persistClassification(
      { agents, audit },
      agent.id,
      'story-006-002',
      classification,
      outcome,
      0
    );

    assert.equal(agents.get(agent.id)!.attempt_class, 'infra_failure');
    const detail = JSON.parse(
      audit.getByStory('story-006-002').find((r) => r.action === 'attempt_classified')!.detail!
    ) as Record<string, unknown>;
    assert.equal(detail.signature, 'spawn_enoent');
    assert.equal(detail.produced_output, false);
    assert.equal(detail.retry_attempt, 0);
  });
});
