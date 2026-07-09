import type { CommandDescription } from '../describe/schema.js';
import { OperatorGuidance } from '@loom-ai/core';

export interface PullGuidanceOptions {
  json?: boolean;
}

export function runPullGuidance(storyId: string, opts: PullGuidanceOptions = {}): void {
  try {
    const guidance = new OperatorGuidance({ projectRoot: process.cwd() });
    const result = guidance.pullSince(storyId);

    if (opts.json) {
      console.log(JSON.stringify({ content: result.content, has_more: result.has_more ?? false }));
      return;
    }

    if (result.content === null) {
      console.log('no new guidance');
      return;
    }

    console.log(result.content);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (opts.json) {
      console.log(JSON.stringify({ content: null, has_more: false, error: msg }));
    } else {
      console.error(`loom pull-guidance: ${msg}`);
    }
    process.exitCode = 1;
  }
}

export const spec: CommandDescription = {
  name: 'pull-guidance',
  audience: 'internal',
  summary: 'Print new operator guidance for a story since last pull',
  whenToUse: 'Used by worker agents to read operator guidance messages written via `loom guide`. Returns only new content since the last pull.',
  arguments: [
    { name: 'story-id', type: 'string', required: true, description: 'Story id (e.g. story-001-003)' },
  ],
  options: [
    { name: '--json', type: 'boolean', description: 'Emit JSON: { content, has_more }', changesOutputShape: true },
  ],
  output: {
    text: 'New guidance content since the last pull, or "no new guidance"',
    json: { supported: true, shape: '{ content: string | null, has_more: boolean }' },
  },
  examples: [
    { command: 'loom pull-guidance story-001-003', description: 'Print any new guidance for story-001-003' },
    { command: 'loom pull-guidance story-001-003 --json', description: 'Emit guidance as JSON' },
  ],
  exitCodes: [
    { code: 0, meaning: 'Guidance printed or "no new guidance" shown' },
    { code: 1, meaning: 'Error reading guidance' },
  ],
  errors: ['Error reading guidance file'],
  relationships: { prerequisites: ['guide'], nextSteps: [] },
};
