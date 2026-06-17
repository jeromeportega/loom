import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildWorkerPrompt } from '../orchestrator/workerPrompt.js';
import { SharedContract } from '../orchestrator/SharedContract.js';
import { StoryContext } from '../orchestrator/StoryContext.js';
import type { WorkerAssignment } from '../orchestrator/WorkerRunner.js';

function assignment(overrides: Partial<WorkerAssignment> = {}): WorkerAssignment {
  return {
    storyId: 'story-001-002',
    epicId: 'epic-001',
    branchName: 'story/story-001-002',
    baseSha: 'abc123',
    worktreePath: '/tmp/wt',
    projectRoot: '/tmp/repo',
    skills: [],
    story: {
      id: 'story-001-002',
      title: 'Add the JWT login endpoint',
      description: 'Implement POST /login returning a signed JWT.',
      acceptance_criteria: ['returns 200 with a token', 'rejects bad credentials'],
      estimated_complexity: 'medium',
      dependencies: ['story-001-001'],
      tech_notes: 'Use the existing auth middleware in src/auth.',
    },
    ...overrides,
  };
}

describe('buildWorkerPrompt', () => {
  it('includes the behavioral protocol and the story spec', () => {
    const prompt = buildWorkerPrompt(assignment());
    assert.ok(prompt.includes('loom worker agent'));
    assert.ok(prompt.includes('Add the JWT login endpoint'));
    assert.ok(prompt.includes('story/story-001-002'));
  });

  it('renders every acceptance criterion as a checklist item', () => {
    const prompt = buildWorkerPrompt(assignment());
    assert.ok(prompt.includes('- [ ] returns 200 with a token'));
    assert.ok(prompt.includes('- [ ] rejects bad credentials'));
  });

  it('includes architect tech notes when present', () => {
    const prompt = buildWorkerPrompt(assignment());
    assert.ok(prompt.includes('Technical guidance'));
    assert.ok(prompt.includes('existing auth middleware'));
  });

  it('includes the QA test plan when present', () => {
    const a = assignment();
    a.story.test_plan = 'Unit-test token issuance; cover the bad-credentials path.';
    const prompt = buildWorkerPrompt(a);
    assert.ok(prompt.includes('### Test plan (from QA)'));
    assert.ok(prompt.includes('definition of "verified"'));
    assert.ok(prompt.includes('cover the bad-credentials path'));
  });

  it('omits the QA test plan section when absent (byte-identical baseline)', () => {
    const baseline = buildWorkerPrompt(assignment());
    assert.ok(!baseline.includes('Test plan (from QA)'));
    const a = assignment();
    a.story.test_plan = undefined;
    assert.equal(buildWorkerPrompt(a), baseline, 'absent test_plan must not alter the prompt');
  });

  it('lists dependencies when the story has them', () => {
    const prompt = buildWorkerPrompt(assignment());
    assert.ok(prompt.includes('story-001-001'));
    assert.ok(prompt.includes('Dependencies'));
  });

  it('keeps the single-dependency wording byte-identical (bench baseline)', () => {
    const prompt = buildWorkerPrompt(assignment());
    assert.ok(
      prompt.includes(
        'This story builds on: story-001-001. Their work is already committed on the base branch.'
      )
    );
  });

  it('does not claim non-first dependencies are present when there are several', () => {
    const a = assignment();
    a.story.dependencies = ['story-001-001', 'story-001-003'];
    const prompt = buildWorkerPrompt(a);
    // The worktree only branches from the first dependency, so the prompt must
    // not promise that every dependency's work is on the base branch.
    assert.ok(!prompt.includes('Their work is already committed on the base branch.'));
    assert.ok(prompt.includes('Your worktree branches from story-001-001'));
    assert.ok(prompt.includes('story-001-003'));
    assert.ok(prompt.includes('NOT in your'));
  });

  it('uses rolling-aware dependency wording when integrationBranch is rolling', () => {
    const a = assignment({ integrationBranch: 'rolling' });
    a.story.dependencies = ['story-001-001', 'story-001-003'];
    const prompt = buildWorkerPrompt(a);
    // Rolling: the worktree branched from the live epic tip, which already has
    // every completed story — not just the first dependency.
    assert.ok(prompt.includes('the live epic branch `epic/epic-001`'));
    assert.ok(prompt.includes('every story completed before you were dispatched'));
    assert.ok(prompt.includes('still in flight'));
    // The misleading legacy phrasing must not appear in rolling mode.
    assert.ok(!prompt.includes('Their work is already committed on the base branch.'));
  });

  it('keeps the dependency wording byte-identical when integrationBranch is off', () => {
    const baseline = buildWorkerPrompt(assignment());
    const off = buildWorkerPrompt(assignment({ integrationBranch: 'off' }));
    assert.equal(off, baseline, 'off must not alter the bench baseline prompt');
  });

  it('omits the tech-notes and dependency sections when absent', () => {
    const a = assignment();
    a.story.tech_notes = undefined;
    a.story.dependencies = [];
    const prompt = buildWorkerPrompt(a);
    assert.ok(!prompt.includes('Technical guidance'));
    assert.ok(!prompt.includes('### Dependencies'));
  });

  it('injects skill bodies when provided', () => {
    const prompt = buildWorkerPrompt(
      assignment({ skills: ['## Skill: testing\nWrite property-based tests.'] })
    );
    assert.ok(prompt.includes('Relevant skills'));
    assert.ok(prompt.includes('property-based tests'));
  });

  it('lists reference images when story.images is set (Epic 15 story-015-002)', () => {
    const a = assignment();
    a.story.images = ['/tmp/loom/planning/epic-001/images/mockup.png'];
    const prompt = buildWorkerPrompt(a);
    assert.ok(prompt.includes('Reference images'));
    assert.ok(prompt.includes('/tmp/loom/planning/epic-001/images/mockup.png'));
  });

  it('omits the reference images section when story.images is undefined', () => {
    const prompt = buildWorkerPrompt(assignment());
    assert.ok(!prompt.includes('Reference images'));
  });

  it('appends the revision block when revisionContext is supplied', () => {
    const prompt = buildWorkerPrompt(assignment(), '- [blocker] src/x.ts — Missing null check');
    assert.ok(prompt.includes('Revision request'));
    assert.ok(prompt.includes('Missing null check'));
  });

  it('includes the scratch/probes/investigation guidance', () => {
    const prompt = buildWorkerPrompt(assignment());
    assert.ok(prompt.includes('Scratch, probes, and investigation notes'));
    assert.ok(prompt.includes('.loom/scratch/'));
    // The specific anti-patterns observed in Run 6 are named:
    assert.ok(prompt.includes('ROOT_CAUSE.md'));
  });

  it('appends the self-assessment instruction when requestSelfAssessment is on', () => {
    const prompt = buildWorkerPrompt(assignment(), { requestSelfAssessment: true });
    assert.ok(prompt.includes('self-assessment (required)'));
    assert.ok(prompt.includes('LOOM_SELF_ASSESSMENT'));
  });

  it('is byte-identical to the baseline when requestSelfAssessment is off (bench discipline)', () => {
    const baseline = buildWorkerPrompt(assignment());
    const off = buildWorkerPrompt(assignment(), { requestSelfAssessment: false });
    assert.equal(off, baseline);
    assert.ok(!off.includes('LOOM_SELF_ASSESSMENT'));
  });

  it('does NOT request self-assessment on the verify phase even when on', () => {
    const prompt = buildWorkerPrompt(assignment(), {
      requestSelfAssessment: true,
      phase: 'verify',
    });
    assert.ok(!prompt.includes('LOOM_SELF_ASSESSMENT'));
  });

  it('cursor pull-guidance hint instructs CLI usage, not MCP tool (story-002-005 AC#1)', () => {
    const a = assignment();
    const prompt = buildWorkerPrompt(a, { pullGuidanceHint: true });
    // Must mention the CLI command with the story id.
    assert.ok(
      prompt.includes(`loom pull-guidance ${a.storyId}`),
      'prompt must contain `loom pull-guidance <story-id>`'
    );
    // Must mention the on-disk guidance file path.
    assert.ok(
      prompt.includes(`.loom/guidance/${a.storyId}.md`),
      'prompt must contain `.loom/guidance/<story-id>.md`'
    );
    // Must NOT instruct the worker to call the MCP tool.
    assert.ok(
      !prompt.includes('loom_pull_guidance'),
      'prompt must NOT reference the MCP tool loom_pull_guidance'
    );
  });

  it('cursor pull-guidance hint is absent when pullGuidanceHint is false (bench discipline)', () => {
    const baseline = buildWorkerPrompt(assignment());
    const withHint = buildWorkerPrompt(assignment(), { pullGuidanceHint: true });
    // Baseline (cursor off) must not contain the hint section.
    assert.ok(!baseline.includes('loom pull-guidance'), 'baseline must not contain hint');
    // With hint enabled, the prompt differs.
    assert.notEqual(withHint, baseline);
  });
});

describe('buildWorkerPrompt — shared contract injection', () => {
  let repo: string;
  const CONTRACT = '# Shared contract\n\n## Shared interfaces & types\n`getToken(): string`\n';

  beforeEach(() => {
    repo = fs.mkdtempSync(path.join(os.tmpdir(), 'loom-contract-'));
  });
  afterEach(() => {
    fs.rmSync(repo, { recursive: true, force: true });
  });

  it('prepends the epic contract when includeSharedContract is on and the file exists', () => {
    SharedContract.write(repo, 'epic-001', CONTRACT);
    const prompt = buildWorkerPrompt(assignment({ projectRoot: repo }), {
      includeSharedContract: true,
    });
    assert.ok(prompt.includes('Shared contract (epic-wide — read first)'));
    assert.ok(prompt.includes('getToken(): string'));
    assert.ok(prompt.includes('only the files this story owns'));
  });

  it('is byte-identical to the baseline when the flag is off (bench discipline)', () => {
    SharedContract.write(repo, 'epic-001', CONTRACT);
    const a = assignment({ projectRoot: repo });
    const off = buildWorkerPrompt(a);
    const baseline = buildWorkerPrompt(assignment({ projectRoot: repo }));
    assert.equal(off, baseline);
    assert.ok(!off.includes('Shared contract (epic-wide'));
  });

  it('injects nothing when the flag is on but no contract file exists', () => {
    const prompt = buildWorkerPrompt(assignment({ projectRoot: repo }), {
      includeSharedContract: true,
    });
    assert.ok(!prompt.includes('Shared contract (epic-wide'));
    // Identical to the no-option prompt — presence of the flag alone changes nothing.
    assert.equal(prompt, buildWorkerPrompt(assignment({ projectRoot: repo })));
  });
});

describe('buildWorkerPrompt — upstream context notes injection', () => {
  let repo: string;

  beforeEach(() => {
    repo = fs.mkdtempSync(path.join(os.tmpdir(), 'loom-ctx-'));
  });
  afterEach(() => {
    fs.rmSync(repo, { recursive: true, force: true });
  });

  it("appends a dependency's context note when includeUpstreamContext is on", () => {
    StoryContext.write(repo, 'story-001-001', '# Context — story-001-001\nBuilt the token signer.\n');
    const prompt = buildWorkerPrompt(assignment({ projectRoot: repo }), {
      includeUpstreamContext: true,
    });
    assert.ok(prompt.includes('Upstream context (what your dependencies built)'));
    assert.ok(prompt.includes('Built the token signer.'));
    assert.ok(prompt.includes('Build ON this'));
  });

  it('joins multiple dependency notes with a separator', () => {
    const a = assignment({ projectRoot: repo });
    a.story.dependencies = ['story-001-001', 'story-001-003'];
    StoryContext.write(repo, 'story-001-001', '# Context — story-001-001\nFirst note.\n');
    StoryContext.write(repo, 'story-001-003', '# Context — story-001-003\nThird note.\n');
    const prompt = buildWorkerPrompt(a, { includeUpstreamContext: true });
    assert.ok(prompt.includes('First note.'));
    assert.ok(prompt.includes('Third note.'));
    assert.ok(prompt.includes('\n---\n'));
  });

  it('is byte-identical to the baseline when the flag is off (bench discipline)', () => {
    StoryContext.write(repo, 'story-001-001', '# Context — story-001-001\nNote.\n');
    const off = buildWorkerPrompt(assignment({ projectRoot: repo }));
    const baseline = buildWorkerPrompt(assignment({ projectRoot: repo }));
    assert.equal(off, baseline);
    assert.ok(!off.includes('Upstream context (what your dependencies built)'));
  });

  it('injects nothing when the flag is on but no notes exist', () => {
    const prompt = buildWorkerPrompt(assignment({ projectRoot: repo }), {
      includeUpstreamContext: true,
    });
    assert.ok(!prompt.includes('Upstream context (what your dependencies built)'));
    assert.equal(prompt, buildWorkerPrompt(assignment({ projectRoot: repo })));
  });

  it('injects nothing for a story with no dependencies even when on', () => {
    const a = assignment({ projectRoot: repo });
    a.story.dependencies = [];
    StoryContext.write(repo, 'story-001-001', '# Context\nNote.\n');
    const prompt = buildWorkerPrompt(a, { includeUpstreamContext: true });
    assert.ok(!prompt.includes('Upstream context (what your dependencies built)'));
  });
});
