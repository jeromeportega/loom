import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

function findCapabilitiesMd(): string {
  let dir = __dirname;
  for (let i = 0; i < 12; i++) {
    const candidate = path.join(dir, 'docs', 'capabilities.md');
    if (fs.existsSync(candidate)) return candidate;
    dir = path.dirname(dir);
  }
  throw new Error('could not locate docs/capabilities.md');
}

describe('docs/capabilities.md — signal ledger (story-010-004)', () => {
  let content: string;

  it('loads docs/capabilities.md', () => {
    const p = findCapabilitiesMd();
    content = fs.readFileSync(p, 'utf8');
    assert.ok(content.length > 0, 'capabilities.md must not be empty');
  });

  it('documents .loom/signals/<story-id>.md ledger files', () => {
    assert.ok(
      content.includes('.loom/signals/'),
      'must mention .loom/signals/ path'
    );
  });

  it('describes the ledger files as observe-only', () => {
    assert.ok(
      /observe.only/i.test(content),
      'must describe the ledger as observe-only'
    );
  });

  it('explicitly states the ledger does NOT influence execution (NFR-1)', () => {
    assert.ok(
      /does NOT influence execution/i.test(content),
      'must state the ledger does NOT influence execution'
    );
  });

  it('documents the Build signal analysis section appended to the epic PR body', () => {
    assert.ok(
      content.includes('Build signal analysis'),
      'must mention "Build signal analysis"'
    );
  });

  it('mentions the PR body in context with Build signal analysis', () => {
    // The PR body context and Build signal analysis should appear close together.
    const idx = content.indexOf('Build signal analysis');
    assert.ok(idx !== -1, '"Build signal analysis" must be present');
    const surrounding = content.slice(Math.max(0, idx - 300), idx + 300);
    assert.ok(
      /PR body|epic PR/i.test(surrounding),
      '"Build signal analysis" entry must mention the PR body or epic PR'
    );
  });
});
