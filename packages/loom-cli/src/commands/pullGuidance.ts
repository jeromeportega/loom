import { OperatorGuidance } from '@loom-ai/core';

export interface PullGuidanceOptions {
  json?: boolean;
}

/**
 * `loom pull-guidance <story-id>` — worker-side read of new operator
 * guidance since the last pull. Mirrors the `loom_pull_guidance` MCP tool
 * (ADR-002) but outputs raw text by default; `--json` emits the same
 * `{ content, has_more }` payload the MCP tool returned.
 */
export function runPullGuidance(storyId: string, opts: PullGuidanceOptions = {}): void {
  try {
    const guidance = new OperatorGuidance({ projectRoot: process.cwd() });
    const result = guidance.pullSince(storyId);

    if (opts.json) {
      console.log(JSON.stringify({ content: result.content, has_more: result.has_more }));
      return;
    }

    if (result.content === null) {
      console.log('no new guidance');
      return;
    }

    console.log(result.content);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`loom pull-guidance: ${msg}`);
    process.exitCode = 1;
  }
}
