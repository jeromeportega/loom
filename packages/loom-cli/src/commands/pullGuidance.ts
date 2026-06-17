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
