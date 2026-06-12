import fs from 'node:fs';
import path from 'node:path';
import type { WorkerAssignment, ConflictResolution } from './WorkerRunner.js';
import { OperatorGuidance } from './OperatorGuidance.js';
import { StoryHandoff } from './StoryHandoff.js';
import { StoryContext } from './StoryContext.js';
import { SharedContract } from './SharedContract.js';

/** Resolves the bundled worker prompt template, shipped at the package root. */
export function workerTemplatePath(): string {
  const candidates = [
    path.resolve(__dirname, '../../personas/worker.md'),
    path.resolve(__dirname, '../personas/worker.md'),
    path.resolve(process.cwd(), 'packages/loom-core/personas/worker.md'),
  ];
  for (const p of candidates) {
    if (fs.existsSync(p)) return p;
  }
  throw new Error(`worker prompt template not found. Looked in:\n  ${candidates.join('\n  ')}`);
}

export interface BuildWorkerPromptOptions {
  /** Block-and-revise review findings, appended as the revision request. */
  revisionContext?: string;
  /**
   * When true, reads `<projectRoot>/.loom/guidance/<story-id>.md` and
   * appends it as a priority-instruction block. Off by default — the
   * worker prompt is identical to the bench baseline when this is
   * unset. Operators turn it on via policy.agents.operator_guidance.
   */
  includeOperatorGuidance?: boolean;
  /**
   * When set, the prompt gains a single sentence telling the worker to
   * poll `loom_pull_guidance` between major tool calls. Used for
   * `cursor-cli` (which has no streaming-input surface — see
   * docs/research/live-agent-guidance.md). The default is unset so the
   * `claude-cli` prompt stays byte-identical to the bench baseline.
   */
  pullGuidanceHint?: boolean;
  /**
   * When true, reads `<projectRoot>/.loom/handoff/<story-id>.md` (written by a
   * prior failed/timed-out attempt) and appends it as a "you are resuming"
   * block so the worker continues from the existing commits instead of
   * starting over. Off by default — set by a non-clean retry. When off (or the
   * file is absent) the prompt is unchanged.
   */
  includeHandoff?: boolean;
  /**
   * When true, reads `<projectRoot>/.loom/contract/<epic-id>.md` (the architect's
   * epic-wide shared contract — interfaces + file-ownership map) and prepends it
   * so every parallel worker agrees on the same seams and stays in its lane. Off
   * by default — set from policy.agents.shared_contract. When off (or the file is
   * absent) the prompt is byte-identical to the bench baseline.
   */
  includeSharedContract?: boolean;
  /**
   * Which phase of the phased pipeline (policy.agents.phases='on') this spawn
   * is. `undefined` / 'implement' = the baseline implement prompt (byte-
   * identical to single-spawn). 'verify' appends a block telling the agent the
   * implementation is already committed and to run the full build/test suite,
   * fixing failures only — not to re-architect.
   */
  phase?: 'implement' | 'verify';
  /**
   * When true, reads each dependency's `<projectRoot>/.loom/context/<dep-id>.md`
   * (a "what I built" note written when that upstream story succeeded) and
   * appends them so this worker knows the decisions + surface area it builds on.
   * Off by default — set from policy.agents.context_notes. When off (or no notes
   * exist) the prompt is byte-identical to the bench baseline.
   */
  includeUpstreamContext?: boolean;
}

/**
 * Builds the full prompt for a worker agent: the bundled behavioral protocol
 * with the story spec, acceptance criteria, tech notes, and any selected skills
 * substituted in. When `revisionContext` is set (Epic 18 block-and-revise),
 * the prompt asks the worker to address review findings on top of the original
 * story spec, in the existing branch.
 *
 * Backward-compatible: the second positional argument still accepts a
 * revision-context string for legacy callers; new code should pass the
 * options object.
 */
export function buildWorkerPrompt(
  assignment: WorkerAssignment,
  revisionOrOpts?: string | BuildWorkerPromptOptions
): string {
  const opts: BuildWorkerPromptOptions =
    typeof revisionOrOpts === 'string'
      ? { revisionContext: revisionOrOpts }
      : revisionOrOpts ?? {};

  const template = fs.readFileSync(workerTemplatePath(), 'utf8');
  let block = renderStoryBlock(assignment);

  // Architect shared-contract side-channel (policy.agents.shared_contract=on).
  // Epic-wide interfaces + file-ownership map injected into every parallel
  // worker so they agree on the seams and don't edit each other's files. Gated
  // on the option AND the file's presence so an off run (or no contract) keeps
  // the byte-identical baseline prompt.
  if (opts.includeSharedContract) {
    const contract = SharedContract.read(assignment.projectRoot, assignment.epicId);
    if (contract) {
      block +=
        '\n\n### Shared contract (epic-wide — read first)\n' +
        'The architect produced the contract below for EVERY story in epic ' +
        `${assignment.epicId}. Other stories are being implemented in parallel ` +
        'against it. Conform to the shared interfaces/types EXACTLY — do not invent ' +
        'your own — and edit only the files this story owns per the ownership map; ' +
        "you may import from other stories' files but must not modify them.\n\n" +
        contract;
    }
  }

  // Cross-story context side-channel (policy.agents.context_notes=on). Each
  // dependency that already succeeded left a "what I built" note; injecting them
  // gives this worker the upstream decisions + surface area in narrative form
  // (complementary to the rolling branch, which carries the code itself). Gated
  // on the option AND at least one note existing so an off run keeps the
  // byte-identical baseline prompt.
  if (opts.includeUpstreamContext && assignment.story.dependencies.length > 0) {
    const notes: string[] = [];
    for (const depId of assignment.story.dependencies) {
      const note = StoryContext.read(assignment.projectRoot, depId);
      if (note) notes.push(note.trim());
    }
    if (notes.length > 0) {
      block +=
        '\n\n### Upstream context (what your dependencies built)\n' +
        'The stories you depend on are already complete. The notes below summarize ' +
        'what each built — its decisions and the files it touched. Build ON this ' +
        'work: reuse the interfaces and modules they created instead of ' +
        'reimplementing or duplicating them.\n\n' +
        notes.join('\n\n---\n\n');
    }
  }

  if (opts.revisionContext && opts.revisionContext.trim().length > 0) {
    block +=
      '\n\n### Revision request (code review findings)\n' +
      'Your previous commits on this branch are reviewable but a code-review pass ' +
      'flagged the items below. Address every BLOCKER and as many should-fix items ' +
      'as you can. Commit fixes to the same branch — do not start over.\n\n' +
      opts.revisionContext;
  }

  // Operator guidance side-channel (policy.agents.operator_guidance=on).
  // The flag gates the READ — when off, the prompt is byte-identical to
  // the bench baseline. When on AND the guidance file has content, the
  // worker sees a priority block with the operator's most recent
  // instructions. Soft-lock recovery / mid-run steering happens here.
  if (opts.includeOperatorGuidance) {
    const guidance = new OperatorGuidance({
      projectRoot: assignment.projectRoot,
    }).read(assignment.storyId);
    if (guidance) {
      block +=
        '\n\n### Operator guidance (PRIORITY — read first)\n' +
        'The operator overseeing this run left the following instructions ' +
        'specifically for this story. Treat them as higher priority than the ' +
        'rest of the spec when they conflict. Each entry is timestamped; the ' +
        'most recent is at the bottom.\n\n' +
        guidance;
    }
  }

  // Resume side-channel (non-clean retry). When a prior attempt failed/timed
  // out, loom wrote a handoff doc summarizing the committed work + reasoning.
  // Injecting it tells the worker to continue, not restart. Gated so a fresh
  // (first-attempt or clean) dispatch keeps the byte-identical baseline prompt.
  if (opts.includeHandoff) {
    const handoff = StoryHandoff.read(assignment.projectRoot, assignment.storyId);
    if (handoff) {
      block +=
        '\n\n### Resuming a prior attempt (PRIORITY — read first)\n' +
        'A previous attempt at this story did not finish. The handoff below was ' +
        'auto-generated from its committed work and reasoning trace. CONTINUE ' +
        'from those commits — do not start over or revert them. Pick up where it ' +
        'left off and finish the acceptance criteria.\n\n' +
        handoff;
    }
  }

  // Verify phase (policy.agents.phases='on'). A fresh agent spawn whose job
  // is narrow: the implementation is already committed on this branch; run the
  // full build + test suite for the touched services and make it pass. This is
  // gated on phase==='verify' so the implement spawn stays byte-identical to
  // the single-spawn baseline.
  if (opts.phase === 'verify') {
    block +=
      '\n\n### Verification phase (PRIORITY — read first)\n' +
      'The implementation for this story is ALREADY committed on this branch ' +
      '(see the commits and acceptance criteria above). Your job in this phase ' +
      'is verification, not re-implementation:\n' +
      '1. Run the full build and test suite for every service this story ' +
      'touched (not just a targeted subset).\n' +
      '2. If anything fails, fix it and commit the fix to this same branch.\n' +
      '3. Do NOT re-architect, rename, or revert the existing work — make the ' +
      'committed implementation build and pass cleanly.\n' +
      'If the suite already passes, confirm it and make no further changes.';
  }

  // Backend-conditional: `cursor-cli` workers have no stdin streaming
  // surface for the supervisor to push operator guidance into mid-spawn.
  // Instead we instruct cursor workers to poll the MCP tool between
  // major tool calls. This addition is gated so the `claude-cli`
  // prompt stays byte-identical for bench discipline.
  if (opts.pullGuidanceHint) {
    block +=
      '\n\n### Live operator steering (cursor backend)\n' +
      'Between major tool calls (after each meaningful Edit / Write / ' +
      'Bash block), consider calling the MCP tool `loom_pull_guidance` ' +
      `with story_id "${assignment.storyId}". It returns any operator ` +
      'guidance issued since you last called it, or an empty result. ' +
      'Treat any returned text as priority instructions.';
  }

  return template.replace('{{STORY_BLOCK}}', block);
}

/**
 * Prompt for the integrator agent (PR 3b). Deliberately narrow and standalone
 * (not the worker.md story template): the agent is dropped into the integration
 * worktree where a story merge has been LEFT mid-conflict, and its only job is
 * to resolve the conflict markers so the merge can be committed by loom. It must
 * not run git, commit, or wander beyond the conflicted files. A `previousFailure`
 * (markers left, gate red) is fed back on a retry, mirroring block-and-revise.
 */
export function buildIntegratorPrompt(task: ConflictResolution): string {
  const lines: string[] = [];
  lines.push(
    `You are loom's integrator. Story \`${task.storyId}\` ("${task.storyTitle}") ` +
      `was merged into the epic integration branch \`epic/${task.epicId}\` and git ` +
      'reported a MERGE CONFLICT. The merge is paused in your working directory with ' +
      'conflict markers in place. Resolve it.'
  );
  lines.push('');
  lines.push('### Conflicted files');
  for (const f of task.conflictedFiles) {
    lines.push(`- ${f}`);
  }
  lines.push('');
  lines.push('### What to do');
  lines.push(
    '1. Open each conflicted file and resolve every conflict so it reflects the ' +
      'COMBINED intent of both sides — keep the incoming story\'s feature AND the ' +
      'work already on the epic branch. Do not discard either side to make the ' +
      'conflict disappear.'
  );
  lines.push('2. Remove ALL conflict markers (`<<<<<<<`, `=======`, `>>>>>>>`).');
  lines.push(
    '3. Make sure the result is internally consistent (imports, types, call sites) ' +
      'so the integrated code builds.'
  );
  lines.push('');
  lines.push('### Hard rules');
  lines.push(
    '- Do NOT run any `git` command — no `add`, `commit`, `merge`, `rebase`, ' +
      '`checkout`, or `merge --abort`. loom commits the merge for you once you finish.'
  );
  lines.push('- Edit ONLY the conflicted files listed above; do not start new work.');
  lines.push('- Leaving any conflict marker behind fails the integration.');
  if (task.previousFailure && task.previousFailure.trim().length > 0) {
    lines.push('');
    lines.push('### Your previous attempt was rejected');
    lines.push(
      `${task.previousFailure} Fix it this time — re-open the files and correct the ` +
        'resolution.'
    );
  }
  return lines.join('\n');
}

function renderStoryBlock(assignment: WorkerAssignment): string {
  const { story, epicId, branchName, skills } = assignment;
  const lines: string[] = [];

  lines.push(`**Story ${story.id}** (epic ${epicId}) — ${story.title}`);
  lines.push(`Branch: ${branchName}`);
  lines.push(`Estimated complexity: ${story.estimated_complexity}`);
  lines.push('');
  lines.push('### Description');
  lines.push(story.description);
  lines.push('');
  lines.push('### Acceptance criteria');
  for (const ac of story.acceptance_criteria) {
    lines.push(`- [ ] ${ac}`);
  }

  if (story.tech_notes && story.tech_notes.trim().length > 0) {
    lines.push('');
    lines.push('### Technical guidance (from the architect)');
    lines.push(story.tech_notes);
  }

  if (story.test_plan && story.test_plan.trim().length > 0) {
    lines.push('');
    lines.push('### Test plan (from QA)');
    lines.push(
      'Treat this as the definition of "verified" for this story. Write or ' +
        'extend tests to cover these cases (tests-first where practical) and ' +
        'make them pass before you consider the story done.'
    );
    lines.push('');
    lines.push(story.test_plan);
  }

  if (story.dependencies.length > 0) {
    lines.push('');
    lines.push('### Dependencies');
    if (assignment.integrationBranch === 'rolling') {
      // Rolling integration: the worktree was branched from the live epic/<id>
      // tip, so every story completed before this one (its dependencies and any
      // unrelated siblings) is already present — only in-flight siblings are not.
      lines.push(
        `This story builds on: ${story.dependencies.join(', ')}. ` +
          `Your worktree branches from the live epic branch \`epic/${epicId}\`, which ` +
          'already contains every story completed before you were dispatched — including ' +
          'those dependencies. Build on that code directly. Stories still in flight ' +
          'alongside you are NOT present yet; do not assume their work exists.'
      );
    } else if (story.dependencies.length === 1) {
      lines.push(
        `This story builds on: ${story.dependencies.join(', ')}. ` +
          'Their work is already committed on the base branch.'
      );
    } else {
      // The worktree branches from the FIRST dependency only (see
      // Supervisor.dispatch), so claiming every dependency's work is present
      // would be false. Be explicit about which code the worker can actually
      // see versus which prerequisites merely finished first.
      const [primary, ...rest] = story.dependencies;
      lines.push(
        `This story builds on: ${story.dependencies.join(', ')}. ` +
          `Your worktree branches from ${primary}, so only ${primary}'s work is ` +
          `committed on your base branch. The other prerequisite(s) — ` +
          `${rest.join(', ')} — are complete, but their changes are NOT in your ` +
          'worktree; do not assume their code is importable here. Verify before ' +
          'depending on it.'
      );
    }
  }

  if (story.images && story.images.length > 0) {
    lines.push('');
    lines.push('### Reference images');
    lines.push(
      'The operator supplied these mockups/screenshots when planning this epic. ' +
        'If your story touches the UI, Read them and match the visual intent — ' +
        'layout, components, colors, spacing, text content. If your story has ' +
        'nothing to do with the UI, ignore them.'
    );
    for (const img of story.images) {
      lines.push(`- ${img}`);
    }
  }

  if (skills.length > 0) {
    lines.push('');
    lines.push('### Relevant skills');
    for (const skill of skills) {
      lines.push('');
      lines.push(skill);
    }
  }

  return lines.join('\n');
}
