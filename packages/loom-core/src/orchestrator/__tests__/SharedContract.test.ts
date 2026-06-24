import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SharedContract } from '../SharedContract.js';

// ---------------------------------------------------------------------------
// SharedContract — repo column passthrough (story-058-004) [AC4]
//
// SharedContract is injected verbatim into every worker prompt, so a contract
// that contains a `| Repo |` column for cross-repo epics must round-trip
// unchanged. Producer and consumer stories both read the same file and must
// receive identical content including the repo-identity column.
// ---------------------------------------------------------------------------

describe('SharedContract — repo column passthrough [AC4]', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'loom-sc-repo-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  const CONTRACT_WITH_REPO_COL =
    '# Cross-Repo Execution — Shared Contract\n\n' +
    '## File & module ownership map\n\n' +
    '| Story | Repo | Owns |\n' +
    '|---|---|---|\n' +
    '| story-058-004 | producer-svc | `packages/loom-core/src/orchestrator/ContractOwnership.ts` |\n' +
    '| story-058-005 | consumer-svc | `packages/loom-core/src/orchestrator/CrossRepoCoordinator.ts` |\n';

  it('SharedContract.write then read round-trips a contract containing a repo column verbatim', () => {
    SharedContract.write(tmpDir, 'epic-058', CONTRACT_WITH_REPO_COL);
    const body = SharedContract.read(tmpDir, 'epic-058');
    assert.equal(body, CONTRACT_WITH_REPO_COL, 'repo-column contract must round-trip unchanged');
  });

  it('producer and consumer stories receive the same contract content (same file, same content)', () => {
    SharedContract.write(tmpDir, 'epic-058', CONTRACT_WITH_REPO_COL);
    // Both producer (story-058-004) and consumer (story-058-005) read the same file.
    const producerView = SharedContract.read(tmpDir, 'epic-058');
    const consumerView = SharedContract.read(tmpDir, 'epic-058');
    assert.equal(producerView, consumerView, 'contract content must be identical for producer and consumer');
    assert.ok(producerView !== null, 'contract must be non-null');
    assert.ok(
      (producerView as string).includes('producer-svc'),
      'producer repo identity must appear in the contract'
    );
    assert.ok(
      (producerView as string).includes('consumer-svc'),
      'consumer repo identity must appear in the contract'
    );
  });

  it('repo column content is present in the contract body (both repo slugs and story ids)', () => {
    SharedContract.write(tmpDir, 'epic-058', CONTRACT_WITH_REPO_COL);
    const body = SharedContract.read(tmpDir, 'epic-058');
    assert.ok(body !== null);
    assert.ok((body as string).includes('producer-svc'), 'contract body must contain producer repo slug');
    assert.ok((body as string).includes('consumer-svc'), 'contract body must contain consumer repo slug');
    assert.ok((body as string).includes('story-058-004'), 'contract body must contain producer story');
    assert.ok((body as string).includes('story-058-005'), 'contract body must contain consumer story');
  });

  it('returns null when no contract exists', () => {
    assert.equal(SharedContract.read(tmpDir, 'epic-058'), null);
  });

  it('pathFor returns the expected .loom/contract/<epicId>.md path', () => {
    const expected = path.join(tmpDir, '.loom', 'contract', 'epic-058.md');
    assert.equal(SharedContract.pathFor(tmpDir, 'epic-058'), expected);
  });
});
