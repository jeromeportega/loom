import fs from 'node:fs';
import path from 'node:path';
import { openDatabase, AgentStore } from '@loom-ai/core';

export interface ReviewOptions {
  json?: boolean;
}

/**
 * `loom review <story-id>` — the block-and-revise reviewer's verdict for a story:
 * `review_status` (pending/approved/blocked/errored) and the markdown summary.
 */
export function runReview(storyId: string, opts: ReviewOptions = {}): void {
  const loomDir = path.join(process.cwd(), '.loom');
  if (!fs.existsSync(path.join(loomDir, 'policy.yaml'))) {
    console.error('loom is not initialized in this directory. Run `loom init` first.');
    process.exit(1);
  }

  const db = openDatabase(loomDir);
  const agent = new AgentStore(db).getByStory(storyId);
  if (!agent) {
    console.error(`No agent for story "${storyId}".`);
    process.exit(1);
    return;
  }

  if (!agent.review_status && !agent.review_summary) {
    if (opts.json) {
      console.log(JSON.stringify({ story_id: storyId, review_status: null, review_summary: null }, null, 2));
      return;
    }
    console.log(`No review recorded for ${storyId} — review_strategy may be off or the worker has not finished.`);
    return;
  }

  if (opts.json) {
    console.log(
      JSON.stringify(
        { story_id: storyId, review_status: agent.review_status ?? null, review_summary: agent.review_summary ?? null },
        null,
        2
      )
    );
    return;
  }

  console.log(`  ${storyId} — review: ${agent.review_status ?? '(none)'}`);
  if (agent.review_summary) {
    console.log('');
    console.log(agent.review_summary);
  }
}
