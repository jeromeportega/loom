import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import type { ChildProcess } from 'node:child_process';
import { createDatabase } from '../../../state/Database.js';
import { AuditLog } from '../../../state/AuditLog.js';
import { SignalStore } from '../../SignalStore.js';
import { GithubIssuesScanner } from '../GithubIssuesScanner.js';
import type { SpawnFn } from '../GithubIssuesScanner.js';
import type { ScanContext } from '../../SignalScanner.js';

// ─── Mock child-process factory ───────────────────────────────────────────────

interface MockSpawnCall {
  command: string;
  args: readonly string[];
  opts: { shell: false };
}

interface MockProcessOpts {
  stdout?: string;
  stderr?: string;
  /** If set, the 'error' event is emitted instead of 'close'. */
  error?: Error & { code?: string };
  /** Delay in ms before emitting events (default: 0 = setImmediate). */
  delayMs?: number;
}

function makeMockSpawn(opts: MockProcessOpts): {
  fn: SpawnFn;
  calls: MockSpawnCall[];
} {
  const calls: MockSpawnCall[] = [];

  const fn: SpawnFn = (command, args, spawnOpts) => {
    calls.push({ command, args, opts: spawnOpts });

    const stdoutEE = new EventEmitter();
    const stderrEE = new EventEmitter();
    const proc = new EventEmitter();

    // Attach stream-like emitters and a no-op kill
    const mockProc = Object.assign(proc, {
      stdout: stdoutEE,
      stderr: stderrEE,
      kill: () => true as boolean,
    }) as unknown as ChildProcess;

    const emit = () => {
      if (opts.error) {
        proc.emit('error', opts.error);
      } else {
        if (opts.stdout) stdoutEE.emit('data', Buffer.from(opts.stdout));
        if (opts.stderr) stderrEE.emit('data', Buffer.from(opts.stderr));
        proc.emit('close', 0);
      }
    };

    if (opts.delayMs) {
      setTimeout(emit, opts.delayMs);
    } else {
      setImmediate(emit);
    }

    return mockProc;
  };

  return { fn, calls };
}

function makeCtx(): ScanContext & { db: ReturnType<typeof createDatabase> } {
  const db = createDatabase(':memory:');
  return { db, projectRoot: '/tmp/repo', auditLog: new AuditLog(db) };
}

function makeIssues(n: number) {
  return Array.from({ length: n }, (_, i) => ({
    number: i + 1,
    title: `Issue ${i + 1}`,
    url: `https://github.com/org/repo/issues/${i + 1}`,
    state: 'OPEN',
    createdAt: '2024-01-01T00:00:00Z',
  }));
}

// ─── GithubIssuesScanner: happy path ─────────────────────────────────────────

describe('GithubIssuesScanner — happy path', () => {
  it('produces one signal per open issue with the issue URL as evidenceUrl', async () => {
    const issues = makeIssues(3);
    const { fn, calls } = makeMockSpawn({ stdout: JSON.stringify(issues) });
    const scanner = new GithubIssuesScanner(fn);
    const ctx = makeCtx();

    const signals = await scanner.scan(ctx);

    assert.equal(signals.length, 3, 'must produce one signal per issue');

    // Verify spawn was called correctly — arg array, shell:false, no interpolation
    assert.equal(calls.length, 1, 'spawn must be called exactly once');
    assert.equal(calls[0].command, 'gh');
    assert.ok(Array.isArray(calls[0].args), 'args must be an array');
    assert.equal(calls[0].opts.shell, false, 'shell must be false for injection control');

    // Verify signal shape
    for (let i = 0; i < signals.length; i++) {
      const issue = issues[i];
      assert.equal(signals[i].key, `github-issues:${issue.number}`);
      assert.equal(signals[i].source, 'github-issues');
      assert.equal(signals[i].kind, 'github_issue');
      assert.equal(signals[i].title, issue.title);
      assert.equal(signals[i].evidenceUrl, issue.url, 'issue URL must be the evidenceUrl');
    }
  });

  it('issue titles with shell metacharacters are passed as signal data, not executed', async () => {
    const dangerous = makeIssues(1);
    dangerous[0].title = '$(rm -rf ~) && echo pwned; cat /etc/passwd';
    dangerous[0].url = 'https://github.com/org/repo/issues/1';

    const { fn } = makeMockSpawn({ stdout: JSON.stringify(dangerous) });
    const scanner = new GithubIssuesScanner(fn);
    const ctx = makeCtx();
    const signals = await scanner.scan(ctx);

    assert.equal(signals.length, 1);
    // Title is returned verbatim as data — not executed because shell:false
    assert.equal(signals[0].title, dangerous[0].title);
  });

  it('returns empty array and writes audit note for zero issues', async () => {
    const { fn } = makeMockSpawn({ stdout: JSON.stringify([]) });
    const scanner = new GithubIssuesScanner(fn);
    const ctx = makeCtx();
    const signals = await scanner.scan(ctx);
    assert.equal(signals.length, 0);
  });
});

// ─── GithubIssuesScanner: degradation (FR-5) ─────────────────────────────────

describe('GithubIssuesScanner — degradation modes (FR-5)', () => {
  async function assertDegrades(opts: MockProcessOpts, label: string): Promise<void> {
    const { fn } = makeMockSpawn(opts);
    const scanner = new GithubIssuesScanner(fn);
    const ctx = makeCtx();

    let threw = false;
    let signals: unknown[] = [];
    try {
      signals = await scanner.scan(ctx);
    } catch {
      threw = true;
    }

    assert.equal(threw, false, `${label}: must NOT throw`);
    assert.equal(signals.length, 0, `${label}: must return []`);

    const auditRows = ctx.db
      .prepare("SELECT detail FROM audit_log WHERE action = 'signal_scan'")
      .all() as { detail: string }[];
    assert.ok(auditRows.length > 0, `${label}: must write an audit note`);

    // Verify note distinguishes 'gh unavailable' from 'no issues'
    const detail = JSON.parse(auditRows[0].detail) as Record<string, unknown>;
    assert.ok(
      typeof detail.note === 'string' && detail.note.length > 0,
      `${label}: audit note must have a non-empty 'note' field`
    );
    assert.equal(detail.scanner, 'github-issues');
  }

  it('ENOENT (missing gh binary) — returns [] and writes audit note', async () => {
    await assertDegrades(
      { error: Object.assign(new Error('spawn gh ENOENT'), { code: 'ENOENT' }) },
      'ENOENT'
    );
  });

  it('missing remote — stderr signals no remote configured — returns [] and writes audit note', async () => {
    await assertDegrades(
      { stdout: '', stderr: 'could not determine the remote for this repository: no git remote configured' },
      'missing remote'
    );
  });

  it('auth failure — stderr mentions authentication — returns [] and writes audit note', async () => {
    await assertDegrades(
      { stdout: '', stderr: 'You are not logged in to any GitHub hosts. To authenticate, please run `gh auth login`.' },
      'auth failure'
    );
  });

  it('rate limit — stderr mentions rate limit — returns [] and writes audit note', async () => {
    await assertDegrades(
      { stdout: '', stderr: 'API rate limit exceeded for 203.0.113.0. (But here\'s the good news: Authenticated requests get a higher rate limit. Check out the documentation for more details.)' },
      'rate limit'
    );
  });

  it('network timeout — process kill triggers ETIMEDOUT — returns [] and writes audit note', async () => {
    // Very short timeout so the test completes quickly
    const { fn } = makeMockSpawn({ stdout: '', delayMs: 100 });
    const scanner = new GithubIssuesScanner(fn, 5 /* 5ms timeout */);
    const ctx = makeCtx();

    let threw = false;
    let signals: unknown[] = [];
    try {
      signals = await scanner.scan(ctx);
    } catch {
      threw = true;
    }

    assert.equal(threw, false, 'timeout: must NOT throw');
    assert.equal(signals.length, 0, 'timeout: must return []');

    const auditRows = ctx.db
      .prepare("SELECT detail FROM audit_log WHERE action = 'signal_scan'")
      .all() as { detail: string }[];
    assert.ok(auditRows.length > 0, 'timeout: must write audit note');
    const note = (JSON.parse(auditRows[0].detail) as Record<string, unknown>).note as string;
    assert.ok(note.includes('timeout') || note.includes('ETIMEDOUT'), 'note must mention timeout');
  });
});

// ─── GithubIssuesScanner: persistence + dedup ────────────────────────────────

describe('GithubIssuesScanner — persistence + dedup', () => {
  it('UPSERT-deduplicates on re-run and stale-marks removed issues', async () => {
    let issueList = makeIssues(2);

    const makeSpawn = () =>
      makeMockSpawn({ stdout: JSON.stringify(issueList) }).fn;

    const db = createDatabase(':memory:');
    const store = new SignalStore(db);
    const auditLog = new AuditLog(db);
    const ctx: ScanContext = { db, projectRoot: '/tmp/repo', auditLog };

    // First scan
    const scanner1 = new GithubIssuesScanner(makeSpawn());
    const signals1 = await scanner1.scan(ctx);
    const { inserted: ins1, refreshed: ref1 } = store.upsertMany(signals1);
    store.reconcile(signals1.map((s) => s.key));
    assert.equal(ins1, 2);
    assert.equal(ref1, 0);

    // Pin last_seen on first signal to verify it gets advanced
    const key1 = signals1[0].key;
    db.prepare("UPDATE signals SET last_seen = '2000-01-01' WHERE key = ?").run(key1);

    // Second scan — same issues
    const scanner2 = new GithubIssuesScanner(makeSpawn());
    const signals2 = await scanner2.scan(ctx);
    const { inserted: ins2, refreshed: ref2 } = store.upsertMany(signals2);
    store.reconcile(signals2.map((s) => s.key));
    assert.equal(ins2, 0, 'no new inserts on re-run');
    assert.equal(ref2, 2, 'both signals refreshed');

    const [updated] = store.getByKeys([key1]);
    assert.ok(updated.last_seen > '2000-01-01', 'last_seen must advance');
    assert.equal(updated.status, 'open');

    // Remove issue #2 from the list
    issueList = makeIssues(1);

    const scanner3 = new GithubIssuesScanner(makeSpawn());
    const signals3 = await scanner3.scan(ctx);
    store.upsertMany(signals3);
    const staled = store.reconcile(signals3.map((s) => s.key));
    assert.equal(staled, 1, 'one signal stale-marked after issue removed');

    const [staleRecord] = store.getByKeys(['github-issues:2']);
    assert.equal(staleRecord.status, 'stale', 'issue #2 must be stale after removal');
  });
});
