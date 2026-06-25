import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const MAX_ANCESTOR_DEPTH = 12;

function findRepoRoot(): string {
  let dir = __dirname;
  for (let i = 0; i < MAX_ANCESTOR_DEPTH; i++) {
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

describe('docs/operations/known-limitations.md — stale-limitation prune (story-064-002)', () => {
  let content: string;

  before(() => {
    const p = path.join(findRepoRoot(), 'docs/operations/known-limitations.md');
    content = fs.readFileSync(p, 'utf8');
  });

  // ── Retained-set sanity ───────────────────────────────────────────────────

  it('loads docs/operations/known-limitations.md and is non-empty', () => {
    assert.ok(content.length > 0, 'known-limitations.md must not be empty');
  });

  it('retains the State layer section', () => {
    assert.ok(content.includes('## State layer'), 'State layer section must remain');
  });

  it('retains the Policy engine section', () => {
    assert.ok(content.includes('## Policy engine'), 'Policy engine section must remain');
  });

  it('retains the Story dispatch section', () => {
    assert.ok(content.includes('## Story dispatch'), 'Story dispatch section must remain');
  });

  it('retains the Deferred section', () => {
    assert.ok(content.includes('## Deferred for Epic 7+'), 'Deferred section must remain');
  });

  // ── AC2: _db "would break with multiple repos" note removed ───────────────

  it('no longer contains the _db "would break with multiple repos" claim (AC2)', () => {
    assert.ok(
      !content.includes('would break if loom ever ran multiple repos in one process'),
      'must not contain the stale _db multi-repo limitation — multi-repo orchestration shipped'
    );
  });

  it('no longer contains the "Revisit when: multi-repo orchestration" trigger (AC2)', () => {
    assert.ok(
      !/Revisit when.*multi-repo orchestration/i.test(content),
      'must not contain the stale "multi-repo orchestration" revisit trigger'
    );
  });

  // ── AC1/AC3: No contradiction with shipped behavior ───────────────────────

  it('no longer claims worktrees are never cleaned up (prune_orphan_worktrees shipped as default on)', () => {
    assert.ok(
      !content.includes('Worktrees are never cleaned up automatically'),
      'must not claim worktrees are never cleaned up — policy.agents.prune_orphan_worktrees=on shipped'
    );
  });

  it('no longer claims the guard hook requires loom on PATH (absolute path shipped in loom init)', () => {
    assert.ok(
      !content.includes('Worker guardrails require `loom` on PATH'),
      'must not claim guard requires loom on PATH — loom init now writes an absolute node path'
    );
  });

  it('no longer contains loom_start_epic references (loom MCP server removed)', () => {
    assert.ok(
      !content.includes('loom_start_epic'),
      'must not reference loom_start_epic — loom no longer ships its own MCP server'
    );
  });

  it('no longer contains loom_get_status references (loom MCP server removed)', () => {
    assert.ok(
      !content.includes('loom_get_status'),
      'must not reference loom_get_status — loom no longer ships its own MCP server'
    );
  });

  it('no longer claims skill generation has no opt-out (policy.agents.skill_generation toggle shipped)', () => {
    assert.ok(
      !content.includes('No opt-out beyond unsetting'),
      'must not claim skill_generation has no opt-out — policy.agents.skill_generation: off shipped'
    );
  });

  it('no longer claims slash commands assume a loom MCP server (server removed)', () => {
    assert.ok(
      !content.includes('Slash commands assume the loom MCP server is connected'),
      'must not reference the removed loom MCP server in the slash commands limitation'
    );
  });

  it('no longer contains a "Claude Code project-MCP discovery path" entry (loom no longer writes its own .mcp.json)', () => {
    assert.ok(
      !content.includes('Claude Code project-MCP discovery path'),
      'must not contain the stale project-MCP discovery limitation'
    );
  });

  it('the MCP server (Epic 4) section has been removed in its entirety', () => {
    assert.ok(
      !content.includes('## MCP server (Epic 4)'),
      'the MCP server section must be removed — loom no longer ships an MCP server'
    );
  });

  it('no longer lists "Web UI" as deferred (local loom web dashboard shipped)', () => {
    assert.ok(
      !/Web UI \/ hosted dashboard/.test(content),
      'must not list "Web UI / hosted dashboard" — local web UI shipped; only hosted dashboard remains deferred'
    );
  });
});
