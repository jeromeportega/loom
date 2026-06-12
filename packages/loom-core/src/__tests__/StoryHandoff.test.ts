import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { StoryHandoff, type HandoffInputs } from '../orchestrator/StoryHandoff.js';
import { buildWorkerPrompt } from '../orchestrator/workerPrompt.js';
import type { WorkerAssignment } from '../orchestrator/WorkerRunner.js';
import type { Story } from '../types.js';

function baseInputs(over: Partial<HandoffInputs> = {}): HandoffInputs {
  return {
    storyId: 'story-001-002',
    epicId: 'epic-001',
    title: 'Remove the crs_auth toggle',
    description: 'Retire the toggle and its branches.',
    branchName: 'story/story-001-002',
    worktreePath: '/tmp/wt/story-001-002',
    status: 'failed',
    summary: 'Worker timed out — stalled (no output) for 12 minutes.',
    acceptanceCriteria: ['enum member removed', 'tests pass'],
    commits: [
      { sha: 'aaa1111', subject: 'remove enum member' },
      { sha: 'bbb2222', subject: 'wip: timeout-stall checkpoint [loom]' },
    ],
    diffStat: ' 3 files changed, 40 insertions(+), 12 deletions(-)',
    dirty: false,
    traces: [
      { id: 1, agent_id: 'a', epic_id: 'epic-001', story_id: 'story-001-002', kind: 'tool_intent', subject: 'Edit', rationale: 'Removing the enum member from feature_toggles.py', metadata: null, timestamp: '2026-06-05T10:00:00Z' },
      { id: 2, agent_id: 'a', epic_id: 'epic-001', story_id: 'story-001-002', kind: 'thinking', subject: null, rationale: 'noise that should not appear as a decision', metadata: null, timestamp: '2026-06-05T10:01:00Z' },
    ],
    audit: [
      { id: 9, agent_id: 'a', action: 'worker_timeout_warn', command: 'story-001-002', allowed: true, policy_rule: null, detail: null, timestamp: '2026-06-05T10:10:00Z' },
    ],
    logTail: 'still working...\n',
    generatedAt: '2026-06-05T10:11:00Z',
    ...over,
  };
}

describe('StoryHandoff.render', () => {
  it('renders the durable telemetry into a resume-oriented doc', () => {
    const md = StoryHandoff.render(baseInputs());
    assert.match(md, /# Handoff — story-001-002/);
    assert.match(md, /Remove the crs_auth toggle/);
    assert.match(md, /CONTINUE/); // resume framing
    // Commits (the per-commit record) are listed.
    assert.match(md, /`aaa1111` remove enum member/);
    assert.match(md, /wip: timeout-stall checkpoint \[loom\]/);
    // tool_intent traces surface as "Key decisions"; thinking noise does not.
    assert.match(md, /Key decisions/);
    assert.match(md, /Removing the enum member/);
    assert.doesNotMatch(md, /noise that should not appear/);
    // Artifacts referenced, not duplicated.
    assert.match(md, /\.loom\/handoff\/story-001-002\.md/);
    assert.match(md, /Next steps/);
  });

  it('handles a story with no commits yet', () => {
    const md = StoryHandoff.render(baseInputs({ commits: [], diffStat: undefined }));
    assert.match(md, /No commits yet/);
  });

  it('flags an uncommitted worktree', () => {
    const md = StoryHandoff.render(baseInputs({ dirty: true }));
    assert.match(md, /uncommitted changes/);
  });
});

describe('StoryHandoff write/read + resume prompt injection', () => {
  let projectRoot: string;
  const STORY: Story = {
    id: 'story-001-002',
    title: 'Remove the crs_auth toggle',
    description: 'Retire it.',
    acceptance_criteria: ['done'],
    estimated_complexity: 'small',
    dependencies: [],
  };

  beforeEach(() => {
    projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'loom-handoff-'));
  });
  afterEach(() => {
    fs.rmSync(projectRoot, { recursive: true, force: true });
  });

  function assignment(): WorkerAssignment {
    return {
      storyId: STORY.id,
      epicId: 'epic-001',
      story: STORY,
      worktreePath: projectRoot,
      branchName: 'story/story-001-002',
      baseSha: 'deadbeef',
      projectRoot,
      skills: [],
    };
  }

  it('write() then read() round-trips and creates .loom/handoff/', () => {
    const file = StoryHandoff.write(projectRoot, STORY.id, '# hi\n');
    assert.ok(fs.existsSync(file));
    assert.equal(StoryHandoff.read(projectRoot, STORY.id), '# hi\n');
  });

  it('prompt is unchanged when includeHandoff is set but no handoff file exists (baseline preserved)', () => {
    const withFlag = buildWorkerPrompt(assignment(), { includeHandoff: true });
    const without = buildWorkerPrompt(assignment(), {});
    assert.equal(withFlag, without, 'no file => byte-identical baseline prompt');
  });

  it('injects the resume block when a handoff file exists and includeHandoff is set', () => {
    StoryHandoff.write(projectRoot, STORY.id, '# Handoff — story-001-002\nprior work here\n');
    const prompt = buildWorkerPrompt(assignment(), { includeHandoff: true });
    assert.match(prompt, /Resuming a prior attempt/);
    assert.match(prompt, /prior work here/);
    assert.match(prompt, /do not start over/i);
  });

  it('does NOT inject the handoff when includeHandoff is unset, even if the file exists', () => {
    StoryHandoff.write(projectRoot, STORY.id, '# Handoff\nshould not appear\n');
    const prompt = buildWorkerPrompt(assignment(), {});
    assert.doesNotMatch(prompt, /should not appear/);
  });
});
