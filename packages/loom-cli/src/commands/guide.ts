import type { CommandDescription } from '../describe/schema.js';
import fs from 'node:fs';
import path from 'node:path';
import { OperatorGuidance } from '@loom-ai/core';
import { openProjectDatabase } from '../dbHelper.js';

export interface GuideOptions {
  clear?: boolean;
  author?: string;
}

/**
 * `loom guide <story-id> "<message>"` — append a guidance message for a
 * worker. Worker reads it on the next dispatch / revision (gated by
 * policy.agents.operator_guidance=on).
 *
 * `loom guide <story-id> --clear` wipes the file.
 */
export function runGuide(storyId: string, message: string | undefined, opts: GuideOptions = {}): void {
  const projectRoot = process.cwd();
  const loomDir = path.join(projectRoot, '.loom');
  if (!fs.existsSync(path.join(loomDir, 'policy.yaml'))) {
    console.error('loom is not initialized in this directory. Run `loom init` first.');
    process.exit(1);
  }

  const db = openProjectDatabase(projectRoot);
  const guidance = new OperatorGuidance({ projectRoot, db });

  if (opts.clear) {
    guidance.clear(storyId);
    console.log(`  Cleared guidance for ${storyId}.`);
    return;
  }

  if (!message || !message.trim()) {
    console.error('  Provide a message argument or pass --clear.');
    console.error('  Examples:');
    console.error('    loom guide story-001-003 "focus on the auth middleware, skip the docs"');
    console.error('    loom guide story-001-003 --clear');
    process.exit(1);
  }

  const entry = guidance.add(storyId, message, { author: opts.author });
  console.log(`  ${entry.timestamp}  guidance added for ${storyId}`);
  console.log(`  ${guidance.fileFor(storyId)}`);
  console.log('');
  console.log('  The worker reads this file at story-start AND on every revision');
  console.log('  when policy.agents.operator_guidance=on. Set the flag in your');
  console.log("  project's .loom/policy.yaml to wire it up.");
}

export const spec: CommandDescription = {
  name: 'guide',
  summary: 'Append operator guidance for a running worker',
  whenToUse: 'Use to send steering messages to a running worker story. The worker reads the guidance at story-start and on each revision when policy.agents.operator_guidance=on.',
  arguments: [
    { name: 'story-id', type: 'string', required: true, description: 'Story id (e.g. story-001-003)' },
    { name: 'message', type: 'string', required: false, description: 'Free-form guidance text (omit when using --clear)' },
  ],
  options: [
    { name: '--clear', type: 'boolean', description: 'Remove the guidance file for this story', changesOutputShape: false },
    { name: '--author', type: 'string', description: 'Tag the entry with an author label (defaults to "operator")', changesOutputShape: false },
  ],
  output: { text: 'Confirmation that guidance was written or cleared' },
  examples: [
    { command: 'loom guide story-001-003 "Focus on the API layer first"', description: 'Send guidance to a running worker' },
    { command: 'loom guide story-001-003 --clear', description: 'Clear all guidance for the story' },
    { command: 'loom guide story-001-003 "Add more tests" --author alice', description: 'Send guidance tagged with author' },
  ],
  exitCodes: [
    { code: 0, meaning: 'Guidance written or cleared successfully' },
    { code: 1, meaning: 'Story not found or loom not initialized' },
  ],
  errors: ['Story not found', 'loom is not initialized — run `loom init` first'],
  relationships: { prerequisites: ['run'], nextSteps: ['status', 'pull-guidance'] },
};
