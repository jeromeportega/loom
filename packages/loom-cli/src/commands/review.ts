import type { CommandDescription } from '../describe/schema.js';
import fs from 'node:fs';
import path from 'node:path';
import { AgentStore, FindingStore } from '@loom-ai/core';
import type { StoredFinding } from '@loom-ai/core';
import { openProjectDatabase } from '../dbHelper.js';

export interface ReviewOptions {
  json?: boolean;
}

export interface FindingJsonEntry {
  severity: StoredFinding['severity'];
  file: string;
  line: number | null;
  message: string;
  suggestion?: string;
}

const SEVERITY_ORDER: StoredFinding['severity'][] = ['blocking', 'medium', 'low', 'info'];

/**
 * Renders the FINDINGS block for text output.
 * Returns an empty string when there are no findings (block is omitted).
 * Grouped by severity: blocking → medium → low → info.
 */
export function renderFindingsBlock(findings: StoredFinding[]): string {
  if (findings.length === 0) return '';

  const lines: string[] = ['  FINDINGS', '  ────────'];

  for (const sev of SEVERITY_ORDER) {
    const group = findings.filter((f) => f.severity === sev);
    if (group.length === 0) continue;

    lines.push(`  [${sev}]`);
    for (const f of group) {
      const loc = f.line !== null ? `${f.file}:${f.line}` : f.file;
      lines.push(`    ${loc} — ${f.message}`);
      if (f.suggestion !== null && f.suggestion !== undefined) {
        lines.push(`      suggestion: ${f.suggestion}`);
      }
    }
    lines.push('');
  }

  if (lines[lines.length - 1] === '') lines.pop();

  return lines.join('\n');
}

/**
 * Converts a StoredFinding to its JSON output shape.
 * `suggestion` key is omitted entirely when null (not set to null).
 */
export function findingToJson(f: StoredFinding): FindingJsonEntry {
  const entry: FindingJsonEntry = {
    severity: f.severity,
    file: f.file,
    line: f.line,
    message: f.message,
  };
  if (f.suggestion !== null && f.suggestion !== undefined) {
    entry.suggestion = f.suggestion;
  }
  return entry;
}

/**
 * `loom review <story-id>` — the block-and-revise reviewer's verdict for a story:
 * `review_status` (pending/approved/blocked/errored) and the markdown summary.
 */
export function runReview(storyId: string, opts: ReviewOptions = {}): void {
  const projectRoot = process.cwd();
  const loomDir = path.join(projectRoot, '.loom');
  if (!fs.existsSync(path.join(loomDir, 'policy.yaml'))) {
    console.error('loom is not initialized in this directory. Run `loom init` first.');
    process.exit(1);
  }

  const db = openProjectDatabase(projectRoot);
  const agent = new AgentStore(db).getByStory(storyId);
  if (!agent) {
    console.error(`No agent for story "${storyId}".`);
    process.exit(1);
    return;
  }

  const findings = new FindingStore(db).getByStory(storyId);

  if (!agent.review_status && !agent.review_summary) {
    if (opts.json) {
      console.log(
        JSON.stringify(
          { story_id: storyId, review_status: null, review_summary: null, findings: [] },
          null,
          2
        )
      );
      return;
    }
    console.log(`No review recorded for ${storyId} — review_strategy may be off or the worker has not finished.`);
    return;
  }

  if (opts.json) {
    console.log(
      JSON.stringify(
        {
          story_id: storyId,
          review_status: agent.review_status ?? null,
          review_summary: agent.review_summary ?? null,
          findings: findings.map(findingToJson),
        },
        null,
        2
      )
    );
    return;
  }

  console.log(`  ${storyId} — review: ${agent.review_status ?? '(none)'}`);

  const findingsBlock = renderFindingsBlock(findings);
  if (findingsBlock) {
    console.log('');
    console.log(findingsBlock);
  }

  if (agent.review_summary) {
    console.log('');
    console.log(agent.review_summary);
  }
}

export const spec: CommandDescription = {
  name: 'review',
  summary: "Show a story's block-and-revise review verdict",
  whenToUse: "Use to inspect the review outcome for a completed story before merging. Shows whether the story passed review and the reviewer's summary.",
  arguments: [
    { name: 'story-id', type: 'string', required: true, description: 'Story id (e.g. story-001-003)' },
  ],
  options: [
    { name: '--json', type: 'boolean', description: 'Emit JSON: { story_id, review_status, review_summary, findings }', changesOutputShape: true },
  ],
  output: {
    text: 'Review status, findings grouped by severity, and summary for the story',
    json: { supported: true, shape: '{ story_id: string, review_status: string, review_summary: string, findings: Array<{ severity, file, line, message, suggestion? }> }' },
  },
  examples: [
    { command: 'loom review story-001-003', description: "Show the review verdict for story-001-003" },
    { command: 'loom review story-001-003 --json', description: 'Emit review data as JSON' },
  ],
  exitCodes: [
    { code: 0, meaning: 'Review data shown' },
    { code: 1, meaning: 'Story not found or loom not initialized' },
  ],
  errors: ['Story not found', 'loom is not initialized — run `loom init` first'],
  relationships: { prerequisites: ['run'], nextSteps: ['diff', 'status'] },
};
