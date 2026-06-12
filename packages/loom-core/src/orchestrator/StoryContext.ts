import fs from 'node:fs';
import path from 'node:path';
import type { DecisionTrace } from '../state/DecisionTraceStore.js';
import { oneLine } from './renderUtils.js';

/**
 * Inputs for a cross-story context note. Like a handoff it is rendered purely
 * from durable telemetry (git log + decision traces + the completion summary),
 * but the SEMANTIC is the opposite: a handoff says "this story has unfinished
 * work to resume", a context note says "this story is DONE — here is what it
 * built so a dependent story can build on it without re-reading the whole diff".
 */
export interface ContextInputs {
  storyId: string;
  epicId: string;
  title: string;
  /** Final worker-result summary for the completed story. */
  summary?: string;
  branchName: string;
  /** Commits the story added on its branch, oldest first. */
  commits: Array<{ sha: string; subject: string }>;
  /** `git diff --stat` for the branch — the surface area a dependent inherits. */
  diffStat?: string;
  /** Reasoning timeline for the story (claude backend only). */
  traces: DecisionTrace[];
  /** ISO timestamp the note was generated. Defaults to now. */
  generatedAt?: string;
}

/** Keep the note compact — a dependent reads several of these. */
const MAX_TRACES = 8;
const MAX_COMMITS = 20;

/**
 * Assembles and materializes `.loom/context/<story-id>.md` — a short "what I
 * built" note written when a story SUCCEEDS, so that a dependent story's worker
 * can be primed with the decisions and surface area of its upstream stories.
 *
 * Deliberately a SEPARATE path and class from {@link StoryHandoff}: the handoff
 * invariant ("a `.loom/handoff/<id>.md` exists ⇒ unfinished work to resume") must
 * not be muddied by a success artifact. This note is enrichment, not a resume
 * signal, and references work by path rather than copying it.
 */
export class StoryContext {
  /** Path where a story's context note is materialized (sibling of handoff/). */
  static pathFor(projectRoot: string, storyId: string): string {
    return path.join(projectRoot, '.loom', 'context', `${storyId}.md`);
  }

  /** Reads the materialized context note, or null when none exists. */
  static read(projectRoot: string, storyId: string): string | null {
    try {
      return fs.readFileSync(StoryContext.pathFor(projectRoot, storyId), 'utf8');
    } catch {
      return null;
    }
  }

  /** Writes the context note to disk, creating `.loom/context/` as needed. */
  static write(projectRoot: string, storyId: string, content: string): string {
    const file = StoryContext.pathFor(projectRoot, storyId);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content, 'utf8');
    return file;
  }

  /** Pure telemetry render — markdown from durable sources, no LLM. */
  static render(inputs: ContextInputs): string {
    const generatedAt = inputs.generatedAt ?? new Date().toISOString();
    const lines: string[] = [];

    lines.push(`# Context — ${inputs.storyId}`);
    lines.push('');
    lines.push(`Generated: ${generatedAt}`);
    lines.push(
      `> Completed upstream story \`${inputs.storyId}\` ("${inputs.title}", epic ` +
        `${inputs.epicId}). This is a "what I built" note for dependent stories — ` +
        'build ON this work; do not reimplement it.'
    );

    if (inputs.summary && inputs.summary.trim()) {
      lines.push('');
      lines.push('## Outcome');
      lines.push(inputs.summary.trim());
    }

    lines.push('');
    lines.push('## What was built');
    if (inputs.commits.length > 0) {
      lines.push(`On \`${inputs.branchName}\` (${inputs.commits.length} commit(s)):`);
      const shown = inputs.commits.slice(-MAX_COMMITS);
      for (const c of shown) lines.push(`- \`${c.sha}\` ${c.subject}`);
      if (inputs.commits.length > shown.length) {
        lines.push(`- … and ${inputs.commits.length - shown.length} earlier commit(s)`);
      }
    } else {
      // A done-with-no-commits upstream is intentional: an audit/investigation
      // story (see BaseCliWorker.run). Point readers at the summary above
      // rather than implying the upstream silently dropped work.
      lines.push('No commits — the upstream worker completed without code changes (see Summary above).');
    }
    if (inputs.diffStat && inputs.diffStat.trim()) {
      lines.push('');
      lines.push('Files touched (build on these, do not duplicate them):');
      lines.push('```');
      lines.push(inputs.diffStat.trim());
      lines.push('```');
    }

    const decisions = inputs.traces.filter(
      (t) => t.kind === 'tool_intent' || t.kind === 'pivot' || t.kind === 'plan_rationale'
    );
    if (decisions.length > 0) {
      lines.push('');
      lines.push('## Key decisions');
      for (const t of decisions.slice(-MAX_TRACES)) {
        const subject = t.subject ? `\`${t.subject}\` — ` : '';
        lines.push(`- ${subject}${oneLine(t.rationale, 200)}`);
      }
    }

    return lines.join('\n') + '\n';
  }
}
