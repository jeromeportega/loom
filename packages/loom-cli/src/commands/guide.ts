import fs from 'node:fs';
import path from 'node:path';
import { OperatorGuidance, openDatabase } from '@loom-ai/core';

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
  const loomDir = path.join(process.cwd(), '.loom');
  if (!fs.existsSync(path.join(loomDir, 'policy.yaml'))) {
    console.error('loom is not initialized in this directory. Run `loom init` first.');
    process.exit(1);
  }

  const db = openDatabase(loomDir);
  const guidance = new OperatorGuidance({ projectRoot: process.cwd(), db });

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
