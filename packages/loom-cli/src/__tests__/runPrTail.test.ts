import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { renderPrTail } from '../commands/run.js';

describe('loom run — PR-URL tail (renderPrTail)', () => {
  it('prints the actual epic PR URL for a PR-producing run, NOT the fallback', () => {
    // This is the value run.ts reads off the persisted epic row via
    // EpicStore.get().epic_pr_url after supervisor.run() returns.
    const lines = renderPrTail([
      { id: 'epic-001', epic_pr_url: 'https://example.com/pr/7' },
    ]);
    const joined = lines.join('\n');
    assert.match(joined, /https:\/\/example\.com\/pr\/7/);
    assert.doesNotMatch(
      joined,
      /run `loom status`/i,
      'a PR-producing run must not fall back to the status pointer'
    );
  });

  it('falls back to the status pointer when no epic produced a PR', () => {
    const lines = renderPrTail([{ id: 'epic-001', epic_pr_url: null }]);
    const joined = lines.join('\n');
    assert.match(joined, /Run `loom status`/);
    assert.doesNotMatch(joined, /https?:\/\//, 'no URL when none was recorded');
  });

  it('lists one line per epic when several epics produced PRs', () => {
    const lines = renderPrTail([
      { id: 'epic-001', epic_pr_url: 'https://example.com/pr/1' },
      { id: 'epic-002', epic_pr_url: 'https://example.com/pr/2' },
    ]);
    const joined = lines.join('\n');
    assert.match(joined, /epic-001: https:\/\/example\.com\/pr\/1/);
    assert.match(joined, /epic-002: https:\/\/example\.com\/pr\/2/);
    assert.doesNotMatch(joined, /run `loom status`/i);
  });

  it('skips epics with no PR URL when others have one (mixed run)', () => {
    const lines = renderPrTail([
      { id: 'epic-001', epic_pr_url: 'https://example.com/pr/1' },
      { id: 'epic-002', epic_pr_url: null },
    ]);
    const joined = lines.join('\n');
    assert.match(joined, /https:\/\/example\.com\/pr\/1/);
    assert.doesNotMatch(joined, /epic-002/, 'a PR-less epic adds no URL line');
  });
});
