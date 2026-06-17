import { BaseCliWorker, type CliWorkerOptions } from './BaseCliWorker.js';
import type { WorkerAssignment, WorkerUsage } from './WorkerRunner.js';

export interface CursorAgentWorkerOptions extends CliWorkerOptions {
  /** Binary to invoke. Default: "cursor-agent". */
  cursorBin?: string;
  /** Cursor model id (e.g. "sonnet-4"). Always passed explicitly; never MAX. */
  model?: string;
}

/**
 * Runs a story by invoking Cursor's `cursor-agent` CLI headless inside the
 * story's worktree, using the developer's Cursor session (no API key).
 *
 * `--force` runs tools without prompting (the autonomous-worker equivalent of
 * Claude Code's bypassPermissions); `--trust` accepts the worktree headlessly;
 * `--model` always targets a specific model and MAX mode is never enabled.
 * Run flow, commit counting, and PR handling are inherited from BaseCliWorker.
 */
export class CursorAgentWorker extends BaseCliWorker {
  private bin: string;
  private model: string;

  constructor(opts: CursorAgentWorkerOptions = {}) {
    super(opts);
    this.bin = opts.cursorBin ?? 'cursor-agent';
    this.model = opts.model ?? 'sonnet-4';
  }

  protected binary(): string {
    return this.bin;
  }

  // cursor-agent reads its MCP config from the worktree project config via
  // cwd (enforced separately by CursorMcpEnforcer), so the assignment is
  // unused here — the signature matches the BaseCliWorker seam.
  protected agentArgs(_assignment: WorkerAssignment): string[] {
    return [
      '-p',
      '--model',
      this.model,
      '--force',
      '--trust',
      '--output-format',
      'stream-json',
      '--stream-partial-output',
    ];
  }

  /**
   * cursor-agent has no `--input-format stream-json` equivalent, so
   * mid-spawn stdin injection isn't possible. We add a prompt block
   * telling the agent to check for operator guidance via the CLI command
   * `loom pull-guidance <story-id>` or by reading `.loom/guidance/<story-id>.md`
   * directly between major tool calls. This routes the read path through
   * the CLI/file system rather than MCP (story-002-005, NFR-1).
   *
   * Note: this changes the cursor-cli worker prompt — bench discipline
   * applies. The claude-cli baseline is unaffected (the default in
   * BaseCliWorker returns false).
   */
  protected pullGuidanceHint(): boolean {
    return true;
  }

  /**
   * Parses one JSON-line event from `cursor-agent --output-format stream-json
   * --stream-partial-output`. Mirrors ClaudeCodeWorker.parseStreamLine:
   * defensive per-line JSON.parse over the CursorStreamEvent union
   * (system/user/assistant/tool_call/result).
   *
   *  - `assistant` text content → `humanText` (the dashboard SSE live-output
   *    surface). With --stream-partial-output these arrive as incremental
   *    chunks, so every event also feeds the stall timer via stdout activity.
   *  - `result` (the terminal event) → usage harvest via the readNum key
   *    lists, with the `requestCount: 1` per-session fallback when the event
   *    carries no usage fields (the cursor-cli backend bills per request, so
   *    a zero would be misleading).
   *  - `system` / `user` / `tool_call` → silent (no humanText, no usage).
   *
   * Unknown event shapes fall through to `{ humanText: line }` (non-JSON) or
   * `{}` (unrecognized JSON) and never throw, so cursor-agent version drift
   * degrades to noise rather than a crashed worker.
   */
  protected parseStreamLine(line: string): {
    humanText?: string;
    assistantText?: string;
    usage?: WorkerUsage;
    traces?: Array<{ kind: string; subject?: string; rationale: string }>;
  } {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      // Non-JSON line (stderr leak, plain text) — pass through as output.
      return { humanText: line };
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { humanText: line };
    }
    const obj = parsed as Record<string, unknown>;
    const type = typeof obj.type === 'string' ? obj.type : '';

    if (type === 'result') {
      return { usage: this.harvestUsage(obj) };
    }

    if (type === 'assistant') {
      const message = obj.message as Record<string, unknown> | undefined;
      const content = Array.isArray(message?.content) ? (message?.content as unknown[]) : [];
      const textParts: string[] = [];
      for (const c of content) {
        if (!c || typeof c !== 'object') continue;
        const block = c as Record<string, unknown>;
        if (block.type === 'text' && typeof block.text === 'string') {
          textParts.push(block.text);
        }
      }
      const text = textParts.join(' ');
      return text ? { humanText: text, assistantText: text } : {};
    }

    // system, user, tool_call, and anything cursor-agent grows later —
    // intentionally silent. Their arrival still resets the stall timer
    // (stdout activity), which is the signal we actually need from them.
    return {};
  }

  /**
   * Harvest WorkerUsage from the terminal `type:'result'` event. Key lists
   * preserved verbatim from the pre-stream-json parser so the usage fold is
   * byte-identical to the old single-JSON format's semantics.
   */
  private harvestUsage(obj: Record<string, unknown>): WorkerUsage {
    const u = obj.usage as Record<string, unknown> | undefined;

    const inputTokens = readNum(u, ['input_tokens', 'inputTokens', 'prompt_tokens']) ?? 0;
    const outputTokens = readNum(u, ['output_tokens', 'outputTokens', 'completion_tokens']) ?? 0;
    const cacheReadTokens = readNum(u, [
      'cache_read_input_tokens',
      'cacheReadInputTokens',
      'cached_tokens',
    ]) ?? 0;
    const cacheCreationTokens = readNum(u, [
      'cache_creation_input_tokens',
      'cacheCreationInputTokens',
    ]) ?? 0;
    const requestCount =
      readNum(obj, ['request_count', 'requestCount', 'requests']) ??
      readNum(u, ['request_count', 'requestCount', 'requests']) ??
      1;
    const costUsd = readNum(obj, ['total_cost_usd', 'totalCostUsd', 'cost_usd']) ?? 0;

    return {
      inputTokens,
      outputTokens,
      cacheReadTokens,
      cacheCreationTokens,
      totalTokens: inputTokens + outputTokens + cacheReadTokens + cacheCreationTokens,
      requestCount,
      costUsd,
    };
  }
}

function readNum(
  obj: Record<string, unknown> | undefined,
  keys: string[]
): number | undefined {
  if (!obj) return undefined;
  for (const k of keys) {
    const v = obj[k];
    if (typeof v === 'number' && Number.isFinite(v)) return v;
  }
  return undefined;
}
