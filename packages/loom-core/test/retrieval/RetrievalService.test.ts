/**
 * Integration tests for RetrievalService (story-057-005).
 *
 * Tests run against real temp git repos — no mocks for the fs or git layer —
 * so the full chain (ManifestResolver → RepoReader/RepoSearcher → AuditLog)
 * is exercised end-to-end. The AuditLog is a spy (no real SQLite) per the
 * pattern established in test/guardrails/crossRepoAccess.test.ts.
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { PolicySchema } from '../../src/types.js';
import { registerRepo } from '../../src/home/workspaceManifest.js';
import { gitSafe } from '../../src/orchestrator/git.js';
import { RetrievalService } from '../../src/retrieval/RetrievalService.js';
import { RetrievalRefused, CROSS_REPO_RULES } from '../../src/retrieval/types.js';
import type { AuditLog } from '../../src/state/AuditLog.js';

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeTmp(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `loom-svc-${prefix}-`));
  try { return fs.realpathSync(dir); } catch { return dir; }
}

function gitInit(dir: string): void {
  const res = gitSafe(dir, ['init']);
  if (!res.ok) throw new Error(`git init failed: ${res.output}`);
  gitSafe(dir, ['config', 'user.email', 'test@loom.test']);
  gitSafe(dir, ['config', 'user.name', 'Loom Test']);
}

function writeFile(dir: string, relPath: string, content: string): void {
  const abs = path.join(dir, relPath);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content, 'utf8');
}

function writeAndCommit(dir: string, relPath: string, content: string): void {
  writeFile(dir, relPath, content);
  gitSafe(dir, ['add', relPath]);
  gitSafe(dir, ['commit', '-m', `add ${relPath}`]);
}

/** Lightweight audit spy — no SQLite database needed. */
function makeAuditSpy(): { audit: AuditLog; calls: Parameters<AuditLog['record']>[0][] } {
  const calls: Parameters<AuditLog['record']>[0][] = [];
  const audit = {
    record: (e: Parameters<AuditLog['record']>[0]) => { calls.push(e); },
  } as unknown as AuditLog;
  return { audit, calls };
}

/** Policy with cross_repo.enabled=true and default bounds. */
function enabledPolicy() {
  return PolicySchema.parse({ cross_repo: { enabled: true } });
}

/** Policy with cross_repo.enabled=false (default). */
function disabledPolicy() {
  return PolicySchema.parse({});
}

// ── Fixture: two repos registered in one loomHome ────────────────────────────

interface TwoRepoFixture {
  loomHome: string;
  repo1Dir: string;
  repo1Slug: string;
  repo2Dir: string;
  repo2Slug: string;
  cleanup: () => void;
}

function makeTwoRepoFixture(): TwoRepoFixture {
  const loomHome = makeTmp('home');
  const repo1Dir = makeTmp('repo1');
  const repo2Dir = makeTmp('repo2');
  fs.mkdirSync(loomHome, { recursive: true });
  gitInit(repo1Dir);
  gitInit(repo2Dir);
  const entry1 = registerRepo(loomHome, repo1Dir);
  const entry2 = registerRepo(loomHome, repo2Dir);
  return {
    loomHome,
    repo1Dir,
    repo1Slug: entry1.slug,
    repo2Dir,
    repo2Slug: entry2.slug,
    cleanup: () => {
      fs.rmSync(loomHome, { recursive: true, force: true });
      fs.rmSync(repo1Dir, { recursive: true, force: true });
      fs.rmSync(repo2Dir, { recursive: true, force: true });
    },
  };
}

// ── AC-1: Explicit search and read ───────────────────────────────────────────

describe('RetrievalService.search — AC-1: explicit search returns bounded SearchResult', () => {
  let fixture: TwoRepoFixture;
  let spy: ReturnType<typeof makeAuditSpy>;

  before(() => {
    fixture = makeTwoRepoFixture();
    spy = makeAuditSpy();
    writeAndCommit(fixture.repo1Dir, 'src/api.ts',
      'export interface ApiClient {\n  fetch(url: string): Promise<Response>;\n}\n');
  });

  after(() => { fixture.cleanup(); });

  it('finds a committed symbol via search()', () => {
    const svc = new RetrievalService(fixture.loomHome, enabledPolicy(), spy.audit);
    const result = svc.search({ kind: 'search', slug: fixture.repo1Slug, query: 'ApiClient' });
    assert.equal(result.slug, fixture.repo1Slug);
    assert.ok(result.matches.length > 0, 'expected at least one match');
    assert.ok(result.matches.some(m => m.excerpt.includes('ApiClient')), 'match should include ApiClient');
    assert.equal(result.truncated, false);
  });

  it('search() with pathGlob narrows results to matching files', () => {
    const svc = new RetrievalService(fixture.loomHome, enabledPolicy(), spy.audit);
    const result = svc.search({ kind: 'search', slug: fixture.repo1Slug, query: 'ApiClient', pathGlob: '*.ts' });
    assert.ok(result.matches.length > 0);
    for (const m of result.matches) {
      assert.match(m.path, /\.ts$/, 'all matches should be in .ts files');
    }
  });

  it('search() returns empty matches for a non-existent string', () => {
    const svc = new RetrievalService(fixture.loomHome, enabledPolicy(), spy.audit);
    const result = svc.search({ kind: 'search', slug: fixture.repo1Slug, query: 'DEFINITELY_NOT_PRESENT_XYZ' });
    assert.equal(result.matches.length, 0);
    assert.equal(result.truncated, false);
  });
});

describe('RetrievalService.read — AC-1: explicit read returns bounded ReadResult', () => {
  let fixture: TwoRepoFixture;
  let spy: ReturnType<typeof makeAuditSpy>;

  before(() => {
    fixture = makeTwoRepoFixture();
    spy = makeAuditSpy();
    writeAndCommit(fixture.repo1Dir, 'config.ts',
      'export const DB_URL = "postgres://localhost/app";\nexport const MAX_CONNS = 10;\n');
  });

  after(() => { fixture.cleanup(); });

  it('read() returns the full file content', () => {
    const svc = new RetrievalService(fixture.loomHome, enabledPolicy(), spy.audit);
    const result = svc.read({ kind: 'read', slug: fixture.repo1Slug, path: 'config.ts' });
    assert.equal(result.slug, fixture.repo1Slug);
    assert.equal(result.path, 'config.ts');
    assert.ok(result.content.includes('DB_URL'), 'content should include DB_URL');
    assert.ok(result.content.includes('MAX_CONNS'), 'content should include MAX_CONNS');
    assert.equal(result.truncated, false);
  });

  it('read() with lines=[1,1] returns only the first line', () => {
    const svc = new RetrievalService(fixture.loomHome, enabledPolicy(), spy.audit);
    const result = svc.read({ kind: 'read', slug: fixture.repo1Slug, path: 'config.ts', lines: [1, 1] });
    assert.equal(result.window[0], 1);
    assert.equal(result.window[1], 1);
    assert.ok(result.content.includes('DB_URL'));
    assert.ok(!result.content.includes('MAX_CONNS'));
  });
});

// ── AC-3: Second-repo symbol retrieval ────────────────────────────────────────
// This is the PRD success metric: pull a real definition from a second registered repo.

describe('RetrievalService — AC-3: second-repo symbol/type retrieval', () => {
  let fixture: TwoRepoFixture;
  let spy: ReturnType<typeof makeAuditSpy>;

  // A TypeScript interface definition in the SECOND repo, simulating a shared
  // type that an agent in a different repo wants to import as context.
  const INTERFACE_CONTENT = [
    'export interface PaymentGateway {',
    '  charge(amount: number, currency: string): Promise<ChargeResult>;',
    '  refund(chargeId: string): Promise<RefundResult>;',
    '}',
    '',
    'export interface ChargeResult {',
    '  id: string;',
    '  status: "success" | "failed";',
    '}',
  ].join('\n');

  before(() => {
    fixture = makeTwoRepoFixture();
    spy = makeAuditSpy();
    // Only the SECOND repo has the interface — the first repo has nothing relevant.
    writeAndCommit(fixture.repo1Dir, 'unrelated.ts', 'export const x = 1;\n');
    writeAndCommit(fixture.repo2Dir, 'src/payments/gateway.ts', INTERFACE_CONTENT + '\n');
  });

  after(() => { fixture.cleanup(); });

  it('search() finds the interface definition in the second repo', () => {
    const svc = new RetrievalService(fixture.loomHome, enabledPolicy(), spy.audit);
    const result = svc.search({
      kind: 'search',
      slug: fixture.repo2Slug,
      query: 'PaymentGateway',
    });
    assert.equal(result.slug, fixture.repo2Slug);
    assert.ok(result.matches.length > 0, 'should find PaymentGateway in second repo');
    assert.ok(result.matches.some(m => m.excerpt.includes('PaymentGateway')));
    // The first match tells us which file it's in.
    const firstMatch = result.matches[0];
    assert.ok(firstMatch.path.includes('gateway.ts'), 'match should be in gateway.ts');
  });

  it('read() retrieves the full interface definition from the second repo', () => {
    const svc = new RetrievalService(fixture.loomHome, enabledPolicy(), spy.audit);
    // First search to locate the file.
    const searchResult = svc.search({
      kind: 'search',
      slug: fixture.repo2Slug,
      query: 'PaymentGateway',
    });
    assert.ok(searchResult.matches.length > 0);
    const filePath = searchResult.matches[0].path;

    // Then read the full definition.
    const readResult = svc.read({
      kind: 'read',
      slug: fixture.repo2Slug,
      path: filePath,
    });
    assert.equal(readResult.slug, fixture.repo2Slug);
    assert.ok(readResult.content.includes('PaymentGateway'), 'content includes interface name');
    assert.ok(readResult.content.includes('charge('), 'content includes charge method');
    assert.ok(readResult.content.includes('refund('), 'content includes refund method');
    assert.ok(readResult.content.includes('ChargeResult'), 'content includes ChargeResult type');
  });

  it('search() for PaymentGateway in first repo returns no matches (not in first repo)', () => {
    const svc = new RetrievalService(fixture.loomHome, enabledPolicy(), spy.audit);
    const result = svc.search({
      kind: 'search',
      slug: fixture.repo1Slug,
      query: 'PaymentGateway',
    });
    assert.equal(result.matches.length, 0, 'first repo should not contain PaymentGateway');
  });
});

// ── AC-2: Pull-not-push — no ambient injection ────────────────────────────────

describe('RetrievalService — AC-2: pull-not-push (no ambient injection)', () => {
  let fixture: TwoRepoFixture;
  let spy: ReturnType<typeof makeAuditSpy>;

  before(() => {
    fixture = makeTwoRepoFixture();
    spy = makeAuditSpy();
    writeAndCommit(fixture.repo2Dir, 'ambient.ts', 'export const secret = "ambient_value";\n');
  });

  after(() => { fixture.cleanup(); });

  it('constructing RetrievalService alone produces no audit entries and no retrieval', () => {
    // Creating the service does NOT automatically retrieve anything from sibling repos.
    // This asserts there is no ambient injection path.
    const prevCallCount = spy.calls.length;
    new RetrievalService(fixture.loomHome, enabledPolicy(), spy.audit);
    assert.equal(spy.calls.length, prevCallCount, 'constructor must not trigger any retrieval or audit');
  });

  it('no retrieval occurs without an explicit .search() or .read() call', () => {
    // Even after construction with cross_repo.enabled, no sibling content appears
    // without an explicit request.
    const spy2 = makeAuditSpy();
    new RetrievalService(fixture.loomHome, enabledPolicy(), spy2.audit);
    // No search/read called — audit must be empty, no sibling repo accessed.
    assert.equal(spy2.calls.length, 0, 'no audit entries without an explicit request');
  });
});

// ── AC-4: Single-repo unchanged (cross_repo.enabled=false) ───────────────────

describe('RetrievalService — AC-4: single-repo unchanged when cross_repo disabled', () => {
  let fixture: TwoRepoFixture;
  let spy: ReturnType<typeof makeAuditSpy>;

  before(() => {
    fixture = makeTwoRepoFixture();
    spy = makeAuditSpy();
    writeAndCommit(fixture.repo1Dir, 'module.ts', 'export const value = 42;\n');
  });

  after(() => { fixture.cleanup(); });

  it('search() throws RetrievalRefused when cross_repo.enabled=false', () => {
    const svc = new RetrievalService(fixture.loomHome, disabledPolicy(), spy.audit);
    assert.throws(
      () => svc.search({ kind: 'search', slug: fixture.repo1Slug, query: 'value' }),
      (err: unknown) => {
        assert.ok(err instanceof RetrievalRefused, 'should throw RetrievalRefused');
        assert.equal((err as RetrievalRefused).rule, 'cross_repo.disabled');
        return true;
      },
    );
  });

  it('read() throws RetrievalRefused when cross_repo.enabled=false', () => {
    const svc = new RetrievalService(fixture.loomHome, disabledPolicy(), spy.audit);
    assert.throws(
      () => svc.read({ kind: 'read', slug: fixture.repo1Slug, path: 'module.ts' }),
      (err: unknown) => {
        assert.ok(err instanceof RetrievalRefused, 'should throw RetrievalRefused');
        assert.equal((err as RetrievalRefused).rule, 'cross_repo.disabled');
        return true;
      },
    );
  });

  it('disabled service leaves existing single-repo behavior completely unchanged', () => {
    // Regression: the new code path must not affect anything when enabled=false.
    // Simulate "normal single-repo flows touch none of the new code path":
    // creating a disabled service and calling no retrieval methods has zero side effects.
    const spy2 = makeAuditSpy();
    new RetrievalService(fixture.loomHome, disabledPolicy(), spy2.audit);
    assert.equal(spy2.calls.length, 0, 'no side effects from creating a disabled service');
  });
});

// ── Refusal propagation — rule/reason intact ──────────────────────────────────

describe('RetrievalService — refusal propagation', () => {
  let fixture: TwoRepoFixture;
  let spy: ReturnType<typeof makeAuditSpy>;

  before(() => {
    fixture = makeTwoRepoFixture();
    spy = makeAuditSpy();
  });

  after(() => { fixture.cleanup(); });

  it('search() with unregistered slug surfaces UNREGISTERED refusal intact', () => {
    const svc = new RetrievalService(fixture.loomHome, enabledPolicy(), spy.audit);
    assert.throws(
      () => svc.search({ kind: 'search', slug: 'not-a-real-repo', query: 'anything' }),
      (err: unknown) => {
        assert.ok(err instanceof RetrievalRefused);
        assert.equal((err as RetrievalRefused).rule, CROSS_REPO_RULES.UNREGISTERED);
        assert.ok((err as RetrievalRefused).reason.includes('not-a-real-repo'));
        return true;
      },
    );
  });

  it('read() with unregistered slug surfaces UNREGISTERED refusal intact', () => {
    const svc = new RetrievalService(fixture.loomHome, enabledPolicy(), spy.audit);
    assert.throws(
      () => svc.read({ kind: 'read', slug: 'not-a-real-repo', path: 'any.ts' }),
      (err: unknown) => {
        assert.ok(err instanceof RetrievalRefused);
        assert.equal((err as RetrievalRefused).rule, CROSS_REPO_RULES.UNREGISTERED);
        return true;
      },
    );
  });

  it('read() with secret path surfaces SECRET_EXCLUDED refusal', () => {
    writeAndCommit(fixture.repo1Dir, '.env', 'SECRET=hunter2\n');
    const svc = new RetrievalService(fixture.loomHome, enabledPolicy(), spy.audit);
    assert.throws(
      () => svc.read({ kind: 'read', slug: fixture.repo1Slug, path: '.env' }),
      (err: unknown) => {
        assert.ok(err instanceof RetrievalRefused);
        assert.equal((err as RetrievalRefused).rule, CROSS_REPO_RULES.SECRET_EXCLUDED);
        return true;
      },
    );
  });
});

// ── Invariant #5: audit on every call ─────────────────────────────────────────

describe('RetrievalService — invariant #5: audit.record() on every call', () => {
  let fixture: TwoRepoFixture;

  before(() => {
    fixture = makeTwoRepoFixture();
    writeAndCommit(fixture.repo1Dir, 'auditable.ts', 'export const hello = "world";\n');
  });

  after(() => { fixture.cleanup(); });

  it('search() success records an allowed=true audit entry', () => {
    const spy = makeAuditSpy();
    const svc = new RetrievalService(fixture.loomHome, enabledPolicy(), spy.audit);
    svc.search({ kind: 'search', slug: fixture.repo1Slug, query: 'hello' });
    const entry = spy.calls.find(c => c.action === 'cross_repo_search');
    assert.ok(entry, 'should have a cross_repo_search audit entry');
    assert.equal(entry.allowed, true);
    assert.equal(entry.command, fixture.repo1Slug);
  });

  it('search() refusal records an allowed=false audit entry before throwing', () => {
    const spy = makeAuditSpy();
    const svc = new RetrievalService(fixture.loomHome, enabledPolicy(), spy.audit);
    assert.throws(() => svc.search({ kind: 'search', slug: 'no-such-repo', query: 'x' }));
    const entry = spy.calls.find(c => c.action === 'cross_repo_search');
    assert.ok(entry, 'should have a cross_repo_search audit entry even on refusal');
    assert.equal(entry.allowed, false);
    assert.ok(entry.policy_rule, 'refusal entry must include policy_rule');
  });

  it('read() success records an allowed=true audit entry', () => {
    const spy = makeAuditSpy();
    const svc = new RetrievalService(fixture.loomHome, enabledPolicy(), spy.audit);
    svc.read({ kind: 'read', slug: fixture.repo1Slug, path: 'auditable.ts' });
    const entry = spy.calls.find(c => c.action === 'cross_repo_read');
    assert.ok(entry, 'should have a cross_repo_read audit entry');
    assert.equal(entry.allowed, true);
    assert.equal(entry.command, fixture.repo1Slug);
  });

  it('read() refusal records an allowed=false audit entry before throwing', () => {
    const spy = makeAuditSpy();
    const svc = new RetrievalService(fixture.loomHome, enabledPolicy(), spy.audit);
    assert.throws(() => svc.read({ kind: 'read', slug: 'no-such-repo', path: 'any.ts' }));
    const entry = spy.calls.find(c => c.action === 'cross_repo_read');
    assert.ok(entry, 'should have a cross_repo_read audit entry even on refusal');
    assert.equal(entry.allowed, false);
    assert.ok(entry.policy_rule, 'refusal entry must include policy_rule');
  });

  it('disabled-policy refusal is audited before throwing', () => {
    const spy = makeAuditSpy();
    const svc = new RetrievalService(fixture.loomHome, disabledPolicy(), spy.audit);
    assert.throws(() => svc.search({ kind: 'search', slug: fixture.repo1Slug, query: 'hello' }));
    const entry = spy.calls.find(c => c.action === 'cross_repo_search');
    assert.ok(entry, 'disabled refusal should also be audited');
    assert.equal(entry.allowed, false);
    assert.equal(entry.policy_rule, 'cross_repo.disabled');
  });
});
