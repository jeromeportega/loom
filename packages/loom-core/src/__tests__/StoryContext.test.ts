import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { StoryContext, type ContextInputs } from '../orchestrator/StoryContext.js';
import type { DecisionTrace } from '../state/DecisionTraceStore.js';

function trace(over: Partial<DecisionTrace> = {}): DecisionTrace {
  return {
    id: 1,
    agent_id: 'a1',
    epic_id: 'epic-001',
    story_id: 'story-001-001',
    kind: 'plan_rationale',
    subject: 'src/auth.ts',
    rationale: 'Centralized token signing here so dependents reuse it.',
    metadata: null,
    timestamp: '2026-06-05T00:00:00Z',
    ...over,
  } as DecisionTrace;
}

function inputs(over: Partial<ContextInputs> = {}): ContextInputs {
  return {
    storyId: 'story-001-001',
    epicId: 'epic-001',
    title: 'Token signer',
    summary: 'Added a signed-JWT issuer in src/auth.ts.',
    branchName: 'story/story-001-001',
    commits: [{ sha: 'aaa111', subject: 'feat: add token signer' }],
    diffStat: ' src/auth.ts | 40 ++++',
    traces: [trace()],
    generatedAt: '2026-06-05T12:00:00Z',
    ...over,
  };
}

describe('StoryContext.render', () => {
  it('renders the "what I built" framing for dependents', () => {
    const md = StoryContext.render(inputs());
    assert.ok(md.startsWith('# Context — story-001-001'));
    assert.ok(md.includes('build ON this work'));
    assert.ok(md.includes('do not reimplement it'));
    assert.ok(md.includes('## Outcome'));
    assert.ok(md.includes('Added a signed-JWT issuer'));
  });

  it('lists commits and the touched-files diffstat', () => {
    const md = StoryContext.render(inputs());
    assert.ok(md.includes('## What was built'));
    assert.ok(md.includes('`aaa111` feat: add token signer'));
    assert.ok(md.includes('src/auth.ts | 40'));
  });

  it('surfaces decision-bearing traces and skips raw thinking', () => {
    const md = StoryContext.render(
      inputs({
        traces: [
          trace({ kind: 'thinking', rationale: 'hmm let me think' }),
          trace({ kind: 'pivot', subject: 'approach', rationale: 'switched to RS256' }),
        ],
      })
    );
    assert.ok(md.includes('## Key decisions'));
    assert.ok(md.includes('switched to RS256'));
    assert.ok(!md.includes('hmm let me think'));
  });

  it('omits optional sections gracefully', () => {
    const md = StoryContext.render(
      inputs({ summary: undefined, diffStat: undefined, traces: [], commits: [] })
    );
    assert.ok(!md.includes('## Outcome'));
    assert.ok(!md.includes('## Key decisions'));
    assert.ok(md.includes('No commits — the upstream worker completed without code changes'));
  });
});

describe('StoryContext disk I/O', () => {
  let repo: string;
  beforeEach(() => {
    repo = fs.mkdtempSync(path.join(os.tmpdir(), 'loom-storyctx-'));
  });
  afterEach(() => {
    fs.rmSync(repo, { recursive: true, force: true });
  });

  it('uses a path separate from the handoff dir', () => {
    const p = StoryContext.pathFor(repo, 'story-001-001');
    assert.ok(p.endsWith(path.join('.loom', 'context', 'story-001-001.md')));
    assert.ok(!p.includes(`${path.sep}handoff${path.sep}`));
  });

  it('write then read round-trips and creates the dir', () => {
    assert.equal(StoryContext.read(repo, 'story-001-001'), null);
    const content = StoryContext.render(inputs());
    const file = StoryContext.write(repo, 'story-001-001', content);
    assert.ok(fs.existsSync(file));
    assert.equal(StoryContext.read(repo, 'story-001-001'), content);
  });
});
