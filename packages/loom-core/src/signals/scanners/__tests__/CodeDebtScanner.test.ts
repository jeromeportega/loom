import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { createDatabase } from '../../../state/Database.js';
import { AuditLog } from '../../../state/AuditLog.js';
import { SignalStore } from '../../SignalStore.js';
import { CodeDebtScanner, CODE_DEBT_CAP } from '../CodeDebtScanner.js';
import type { ScanContext } from '../../SignalScanner.js';

const PROJECT_ROOT = '/Users/jeromeortega/Repos/loom/.loom/worktrees/story-004-003';

function makeCtx(db = createDatabase(':memory:')): ScanContext {
  return { db, projectRoot: PROJECT_ROOT, auditLog: new AuditLog(db) };
}

// ─── CodeDebtScanner: happy path (real repo) ─────────────────────────────────

describe('CodeDebtScanner — happy path with real repo', () => {
  it('runs git ls-files on the real repo without throwing', async () => {
    const scanner = new CodeDebtScanner();
    const ctx = makeCtx();
    const signals = await scanner.scan(ctx);

    // The repo may or may not have TODOs — either outcome is valid.
    assert.ok(Array.isArray(signals), 'scan must return an array');
    // Every returned signal must follow the key convention
    for (const s of signals) {
      assert.match(
        s.key,
        /^code-debt:[^:]+:\d+:(TODO|FIXME|HACK)$/,
        `key must match code-debt:<path>:<line>:<TOKEN> — got: ${s.key}`
      );
      assert.equal(s.source, 'code-debt');
      assert.equal(s.kind, 'todo');
      assert.ok(s.evidenceUrl, 'evidenceUrl must be set');
    }
  });

  it('signals are ordered by path then line when multiple are present', async () => {
    // Use a stub that injects known content with TODOs
    const files = ['alpha.ts', 'beta.ts'];
    const content: Record<string, string> = {
      [`${PROJECT_ROOT}/alpha.ts`]: 'const x = 1; // TODO: remove\n// FIXME: broken\n// HACK: workaround\n',
      [`${PROJECT_ROOT}/beta.ts`]: '// TODO: first\n// TODO: second\n',
    };
    const scanner = new CodeDebtScanner(
      () => files,
      (p) => content[p] ?? ''
    );
    const ctx = makeCtx();
    const signals = await scanner.scan(ctx);

    assert.equal(signals.length, 5, 'alpha.ts has 3 matches, beta.ts has 2');

    // All alpha.ts signals before beta.ts signals
    const alphaIdx = signals.findIndex((s) => s.key.startsWith('code-debt:alpha.ts:'));
    const betaIdx = signals.findIndex((s) => s.key.startsWith('code-debt:beta.ts:'));
    assert.ok(alphaIdx < betaIdx, 'alpha.ts signals must come before beta.ts');

    // Within alpha.ts, ordered by line
    const alpha = signals.filter((s) => s.key.startsWith('code-debt:alpha.ts:'));
    const lines = alpha.map((s) => (s.metadata as Record<string, unknown>).line as number);
    for (let i = 1; i < lines.length; i++) {
      assert.ok(lines[i] >= lines[i - 1], 'alpha.ts signals must be ordered by line');
    }
  });

  it('key format matches code-debt:<relativePath>:<line>:<TOKEN>', async () => {
    const content: Record<string, string> = {
      [`${PROJECT_ROOT}/src/foo.ts`]: 'function a() {} // TODO: implement\n',
    };
    const scanner = new CodeDebtScanner(
      () => ['src/foo.ts'],
      (p) => content[p] ?? ''
    );
    const ctx = makeCtx();
    const signals = await scanner.scan(ctx);

    assert.equal(signals.length, 1);
    assert.equal(signals[0].key, 'code-debt:src/foo.ts:1:TODO');
    assert.equal(signals[0].evidenceUrl, 'src/foo.ts:1');
  });
});

// ─── CodeDebtScanner: cap enforcement (FR-4) ─────────────────────────────────

describe('CodeDebtScanner — cap at 200 (FR-4)', () => {
  it('emits exactly 200 signals when >200 matches exist and logs the dropped count', async () => {
    // 5 files × 50 matches each = 250 total > 200
    const FILES = Array.from({ length: 5 }, (_, i) => `file${String(i).padStart(2, '0')}.ts`);
    const contentPerFile = Array.from({ length: 50 }, (_, i) => `const x${i} = 1; // TODO: fix ${i}`).join('\n') + '\n';

    const scanner = new CodeDebtScanner(
      () => FILES,
      (p) => {
        const rel = p.replace(`${PROJECT_ROOT}/`, '');
        return FILES.includes(rel) ? contentPerFile : '';
      }
    );

    const db = createDatabase(':memory:');
    const ctx: ScanContext = { db, projectRoot: PROJECT_ROOT, auditLog: new AuditLog(db) };

    const signals = await scanner.scan(ctx);

    assert.equal(signals.length, CODE_DEBT_CAP, `must emit exactly ${CODE_DEBT_CAP} signals`);

    // Verify deterministic ordering: file00 before file01, etc.
    assert.match(signals[0].key, /^code-debt:file00\.ts:/, 'first signal must be from file00.ts');
    assert.match(signals[CODE_DEBT_CAP - 1].key, /^code-debt:file03\.ts:/, 'last signal before cap must be from file03.ts');

    // Verify audit note about dropped count
    const auditRows = db
      .prepare("SELECT detail FROM audit_log WHERE action = 'signal_scan' ORDER BY id DESC LIMIT 1")
      .get() as { detail: string } | undefined;
    assert.ok(auditRows, 'audit row must be written for the cap event');

    const detail = JSON.parse(auditRows!.detail) as Record<string, unknown>;
    assert.equal(detail.scanner, 'code-debt');
    assert.equal(detail.dropped, 50, 'dropped count must be 50 (250 - 200)');
    assert.equal(detail.total, 250);
    assert.ok((detail.note as string).includes('dropped'), 'note must mention dropped');
  });

  it('does NOT write a cap audit note when total is at or below 200', async () => {
    const FILES = ['only.ts'];
    const contentPerFile = Array.from({ length: 10 }, (_, i) => `// TODO: ${i}`).join('\n');

    const scanner = new CodeDebtScanner(
      () => FILES,
      (p) => (p.endsWith('only.ts') ? contentPerFile : '')
    );

    const db = createDatabase(':memory:');
    const ctx: ScanContext = { db, projectRoot: PROJECT_ROOT, auditLog: new AuditLog(db) };

    await scanner.scan(ctx);

    const capRows = db
      .prepare(
        "SELECT id FROM audit_log WHERE action = 'signal_scan' AND detail LIKE '%\"dropped\"%'"
      )
      .all();
    assert.equal(capRows.length, 0, 'no cap audit row when under the limit');
  });
});

// ─── CodeDebtScanner: persistence + dedup ────────────────────────────────────

describe('CodeDebtScanner — persistence + dedup', () => {
  it('UPSERT-deduplicates on re-run, advances last_seen, and stale-marks removed matches', async () => {
    const db = createDatabase(':memory:');
    const store = new SignalStore(db);
    const auditLog = new AuditLog(db);

    let fileContent = 'const a = 1; // TODO: fix a\nconst b = 2; // TODO: fix b\n';

    const scanner = new CodeDebtScanner(
      () => ['src/module.ts'],
      (p) => (p.endsWith('module.ts') ? fileContent : '')
    );
    const ctx: ScanContext = { db, projectRoot: PROJECT_ROOT, auditLog };

    // First scan
    const signals1 = await scanner.scan(ctx);
    const { inserted: ins1, refreshed: ref1 } = store.upsertMany(signals1);
    store.reconcile(signals1.map((s) => s.key));
    assert.equal(ins1, 2);
    assert.equal(ref1, 0);

    // Pin last_seen on the first key to verify it gets advanced
    const key1 = signals1[0].key;
    db.prepare("UPDATE signals SET last_seen = '2000-01-01' WHERE key = ?").run(key1);

    // Second scan — same content
    const signals2 = await scanner.scan(ctx);
    const { inserted: ins2, refreshed: ref2 } = store.upsertMany(signals2);
    store.reconcile(signals2.map((s) => s.key));
    assert.equal(ins2, 0, 'no new inserts on re-run');
    assert.equal(ref2, 2, 'both signals refreshed');

    const [refreshed] = store.getByKeys([key1]);
    assert.ok(refreshed.last_seen > '2000-01-01', 'last_seen must advance past pinned value');
    assert.equal(refreshed.status, 'open');

    // Remove the second TODO from content — scanner emits only 1 signal now
    fileContent = 'const a = 1; // TODO: fix a\n';

    const signals3 = await scanner.scan(ctx);
    store.upsertMany(signals3);
    const staled = store.reconcile(signals3.map((s) => s.key));
    assert.equal(staled, 1, 'one signal stale-marked after second TODO removed');

    const key2 = signals1[1].key;
    const [staleRecord] = store.getByKeys([key2]);
    assert.equal(staleRecord.status, 'stale', 'removed TODO must be stale');
  });
});

// ─── CodeDebtScanner: ignores non-source files ───────────────────────────────

describe('CodeDebtScanner — file extension filter', () => {
  it('skips non-source files and does not emit signals for them', async () => {
    const content: Record<string, string> = {
      [`${PROJECT_ROOT}/README.md`]: '# TODO: write docs\n',
      [`${PROJECT_ROOT}/src/app.ts`]: '// TODO: implement\n',
    };
    const scanner = new CodeDebtScanner(
      () => ['README.md', 'src/app.ts'],
      (p) => content[p] ?? ''
    );
    const ctx = makeCtx();
    const signals = await scanner.scan(ctx);

    assert.equal(signals.length, 1, 'only the .ts file matches');
    assert.match(signals[0].key, /^code-debt:src\/app\.ts:/);
  });

  it('handles files with read errors gracefully by treating content as empty', async () => {
    const scanner = new CodeDebtScanner(
      () => ['missing.ts'],
      () => { throw new Error('ENOENT: no such file'); }
    );
    const ctx = makeCtx();
    // Should not throw — returns empty
    const signals = await scanner.scan(ctx);
    assert.deepEqual(signals, []);
  });
});
