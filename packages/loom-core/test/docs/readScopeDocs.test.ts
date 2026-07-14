import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

function findRepoRoot(): string {
  let dir = __dirname;
  for (let i = 0; i < 12; i++) {
    if (
      fs.existsSync(path.join(dir, 'packages', 'loom-core')) &&
      fs.existsSync(path.join(dir, 'packages', 'loom-cli'))
    ) {
      return dir;
    }
    dir = path.dirname(dir);
  }
  throw new Error('could not locate monorepo root');
}

// ── docs/capabilities.md ─────────────────────────────────────────────────────

describe('docs/capabilities.md — read-scope enforcement (story-067-005)', () => {
  let body: string;

  before(() => {
    const p = path.join(findRepoRoot(), 'docs/capabilities.md');
    body = fs.readFileSync(p, 'utf8');
  });

  it('contains an allowed_read_root row in the Safety table', () => {
    assert.ok(
      body.includes('allowed_read_root'),
      'docs/capabilities.md must include an allowed_read_root row'
    );
  });

  it('documents read-scoping section with two-zone semantics', () => {
    assert.ok(
      /read.scope/i.test(body),
      'must include a read-scope section or row'
    );
  });

  it('states that allowed_read_root defaults to "." (repo root)', () => {
    assert.ok(
      /allowed_read_root.*default.*"\."|\.\s*=\s*repo root/i.test(body) ||
      /default.*repo root.*allowed_read_root|allowed_read_root.*repo root/i.test(body),
      'must document that default "." means repo root'
    );
  });

  it('states the scope is on by default', () => {
    const nearAllowedReadRoot = body.slice(
      Math.max(0, body.indexOf('allowed_read_root') - 200),
      body.indexOf('allowed_read_root') + 1000
    );
    assert.ok(
      /on by default|On by default/i.test(nearAllowedReadRoot),
      'must state read-scope enforcement is on by default'
    );
  });

  it('states it is independent of cross-repo retrieval', () => {
    // cross_repo.enabled was baked-removed (knob-hardening); the doc now states
    // read-scoping applies "regardless of cross-repo retrieval".
    assert.ok(
      /(independent of|regardless of).{0,25}cross[- _]?repo/i.test(body),
      'must state read-scope is independent of cross-repo retrieval'
    );
  });

  it('mentions the two-zone model (worktree and readRoot)', () => {
    assert.ok(
      /worktree.*allowed_read_root|worktree.*read.*root|two.*zone/i.test(body),
      'must document the two-zone model: worktree + allowed_read_root'
    );
  });

  it('documents read_scope_denied audit action', () => {
    assert.ok(
      body.includes('read_scope_denied'),
      'must mention the read_scope_denied audit action'
    );
  });

  it('mirrors allowed_write_root mental model', () => {
    assert.ok(
      /mirrors.*allowed_write_root|allowed_write_root.*mirror/i.test(body),
      'must state that allowed_read_root mirrors allowed_write_root'
    );
  });

  it('documents that Read, Grep, Glob, and Bash searches are intercepted', () => {
    assert.ok(
      /Read.*Grep.*Glob|Grep.*Glob.*Bash/i.test(body),
      'must mention Read, Grep, Glob tools as intercepted'
    );
  });

  it('policy.filesystem.allowed_read_root appears in the coverage:knob block', () => {
    assert.ok(
      body.includes('`policy.filesystem.allowed_read_root`'),
      'must list policy.filesystem.allowed_read_root in the knob coverage block'
    );
  });
});

// ── README.md ────────────────────────────────────────────────────────────────

describe('README.md — read-scope enforcement (story-067-005)', () => {
  let body: string;

  before(() => {
    const p = path.join(findRepoRoot(), 'README.md');
    body = fs.readFileSync(p, 'utf8');
  });

  it('mentions allowed_read_root', () => {
    assert.ok(
      body.includes('allowed_read_root'),
      'README.md must mention allowed_read_root'
    );
  });

  it('documents read-scoping behavior', () => {
    assert.ok(
      /read.scope|read.*scope/i.test(body),
      'README.md must mention read-scoping'
    );
  });

  it('states the default "." resolves relative to the worktree at hook time (not at init)', () => {
    const idx = body.indexOf('allowed_read_root');
    const window = body.slice(Math.max(0, idx - 100), idx + 400);
    assert.ok(
      /worktree/i.test(window) && /hook time|relative to the worktree/i.test(window),
      'README.md must state the default resolves relative to the worktree at hook time'
    );
  });

  it('states read-scope is on by default', () => {
    const idx = body.indexOf('allowed_read_root');
    const nearReadScope = body.slice(Math.max(0, idx - 100), idx + 500);
    assert.ok(
      /on by default/i.test(nearReadScope),
      'README.md must state read-scope is on by default'
    );
  });

  it('states it is independent of cross-repo retrieval', () => {
    // cross_repo.enabled was baked-removed (knob-hardening).
    assert.ok(
      /(independent of|regardless of).{0,25}cross[- _]?repo/i.test(body),
      'README.md must state read-scope is independent of cross-repo retrieval'
    );
  });
});

// ── docs/architecture/index.md (policy reference) ────────────────────────────

describe('docs/architecture/index.md — allowed_read_root policy reference (story-067-005)', () => {
  let body: string;

  before(() => {
    const p = path.join(findRepoRoot(), 'docs/architecture/index.md');
    body = fs.readFileSync(p, 'utf8');
  });

  it('documents allowed_read_root in the Policy YAML Schema', () => {
    assert.ok(
      body.includes('allowed_read_root'),
      'policy reference must document allowed_read_root'
    );
  });

  it('shows default "." in the schema', () => {
    assert.ok(
      /allowed_read_root.*default\s*\('\.'\)|\.default\('\.'\).*allowed_read_root|allowed_read_root.*z\.string\(\)\.default/i.test(body) ||
      (body.includes('allowed_read_root') && body.includes(".default('.')")),
      'must show default "." for allowed_read_root in the schema'
    );
  });

  it('states allowed_read_root resolves relative to the worktree at hook time', () => {
    const nearAllowedReadRoot = body.slice(
      Math.max(0, body.indexOf('allowed_read_root') - 50),
      body.indexOf('allowed_read_root') + 300
    );
    assert.ok(
      /hook time|relative to the worktree/i.test(nearAllowedReadRoot),
      'policy reference must state allowed_read_root resolves relative to the worktree at hook time'
    );
  });

  it('states allowed_read_root is on-by-default', () => {
    const nearAllowedReadRoot = body.slice(
      Math.max(0, body.indexOf('allowed_read_root') - 50),
      body.indexOf('allowed_read_root') + 300
    );
    assert.ok(
      /on.by.default/i.test(nearAllowedReadRoot),
      'policy reference must state that allowed_read_root is on-by-default'
    );
  });

  it('states allowed_read_root is independent of cross_repo.enabled', () => {
    const nearAllowedReadRoot = body.slice(
      Math.max(0, body.indexOf('allowed_read_root') - 50),
      body.indexOf('allowed_read_root') + 300
    );
    assert.ok(
      /independent of cross_repo\.enabled/i.test(nearAllowedReadRoot),
      'policy reference must state allowed_read_root is independent of cross_repo.enabled'
    );
  });

  it('includes allowed_read_root in the Threat Model', () => {
    const threatModelIdx = body.indexOf('### Threat Model');
    assert.ok(threatModelIdx !== -1, 'Threat Model section must exist');
    const threatSection = body.slice(threatModelIdx, threatModelIdx + 2000);
    assert.ok(
      threatSection.includes('allowed_read_root'),
      'Threat Model must mention allowed_read_root'
    );
  });

  it('documents read_scope_denied in the Threat Model', () => {
    assert.ok(
      body.includes('read_scope_denied'),
      'policy reference must mention read_scope_denied audit action'
    );
  });
});

// ── docs/operations/known-limitations.md ─────────────────────────────────────

describe('docs/operations/known-limitations.md — read-scope enforcement (story-067-005)', () => {
  let body: string;

  before(() => {
    const p = path.join(findRepoRoot(), 'docs/operations/known-limitations.md');
    body = fs.readFileSync(p, 'utf8');
  });

  it('mentions allowed_read_root', () => {
    assert.ok(
      body.includes('allowed_read_root'),
      'known-limitations.md must document allowed_read_root'
    );
  });

  it('notes the read-scope hook applies to Claude Code only (not Cursor CLI)', () => {
    assert.ok(
      /cursor.cli.*read.scope|read.scope.*cursor.cli|cursor-cli.*read|read.*cursor-cli/i.test(body),
      'must note that read-scope hook applies to Claude Code only, not cursor-cli'
    );
  });

  it('states the default resolves relative to the worktree at hook time (not at init)', () => {
    const nearAllowedReadRoot = body.slice(
      Math.max(0, body.indexOf('allowed_read_root') - 50),
      body.indexOf('allowed_read_root') + 400
    );
    assert.ok(
      /relative to the worktree|hook time/i.test(nearAllowedReadRoot),
      'must state the default resolves relative to the worktree at hook time'
    );
  });

  it('states read-scope is on by default', () => {
    const nearAllowedReadRoot = body.slice(
      Math.max(0, body.indexOf('allowed_read_root') - 50),
      body.indexOf('allowed_read_root') + 400
    );
    assert.ok(
      /on by default/i.test(nearAllowedReadRoot),
      'must state read-scope is on by default'
    );
  });

  it('states read-scope is independent of cross_repo.enabled', () => {
    const nearAllowedReadRoot = body.slice(
      Math.max(0, body.indexOf('allowed_read_root') - 50),
      body.indexOf('allowed_read_root') + 400
    );
    assert.ok(
      /independent of.*cross_repo\.enabled/i.test(nearAllowedReadRoot),
      'must state read-scope is independent of cross_repo.enabled'
    );
  });
});
