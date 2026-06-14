import type { ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { BaseCliWorker, type CliWorkerOptions } from './BaseCliWorker.js';
import type { WorkerAssignment, WorkerUsage } from './WorkerRunner.js';
import {
  type WorkerInputChannel,
  MAX_GUIDANCE_BYTES,
} from './WorkerInputChannel.js';

export interface ClaudeCodeWorkerOptions extends CliWorkerOptions {
  /** Binary to invoke. Default: "claude". */
  claudeBin?: string;
  /** Args passed to the binary. The prompt is supplied on stdin. */
  claudeArgs?: string[];
  /**
   * policy.agents.model — appended as `--model <id>` to the default args so the
   * worker runs on the configured model. Without it the `claude` CLI falls back
   * to the operator's ambient default (e.g. Opus), silently ignoring the policy.
   * Ignored when `claudeArgs` is supplied explicitly (the caller owns the args).
   */
  model?: string;
}

/**
 * Default claude args. `stream-json` on both --output-format and --input-format
 * gives us a held-open conversation: live event parsing on the way out, JSONL
 * `user` messages on the way in (used by the operator-guidance channel).
 * `--include-partial-messages` surfaces incremental deltas as `stream_event`
 * lines — we silently ignore them in `parseStreamLine`'s default branch.
 * `--replay-user-messages` echoes every user message we push back on stdout
 * as `type:"user"` events; we record those as `guidance_received` traces so
 * the operator gets confirmation the worker actually saw the steer.
 */
const DEFAULT_ARGS = [
  '-p',
  '--permission-mode', 'bypassPermissions',
  '--output-format', 'stream-json',
  '--input-format', 'stream-json',
  '--include-partial-messages',
  '--replay-user-messages',
  '--verbose',
];

/**
 * Runs a story by invoking the `claude` CLI headless inside the story's
 * worktree. The loom guard hook in `.claude/settings.json` (shipped by
 * `loom init`) is the structural safety net — that is why this can run with
 * `bypassPermissions`. Run flow, commit counting, and PR handling are inherited
 * from BaseCliWorker; only the binary, args, and stream parsing differ.
 */
export class ClaudeCodeWorker extends BaseCliWorker {
  private bin: string;
  private args: string[];

  constructor(opts: ClaudeCodeWorkerOptions = {}) {
    super(opts);
    this.bin = opts.claudeBin ?? 'claude';
    this.args =
      opts.claudeArgs ??
      (opts.model ? [...DEFAULT_ARGS, '--model', opts.model] : DEFAULT_ARGS);
  }

  protected binary(): string {
    return this.bin;
  }

  /**
   * Base claude args, plus — iff the materializer wrote a worktree MCP config
   * at `<worktreePath>/.cursor/mcp.json` — the strict-MCP flags that pin the
   * worker to exactly that allowlist:
   *   `--strict-mcp-config --mcp-config <worktree>/.cursor/mcp.json`
   *
   * `--strict-mcp-config` is the strongest guarantee claude-code offers: it
   * ignores any ambient project/user MCP config and uses ONLY the file we
   * pass. Per ADR-3 that generated config excludes the loom server entry —
   * claude-code workers receive operator guidance over stdin via
   * `WorkerInputChannel`, so they need no MCP dependency. When the file is
   * absent (no `policy.mcp.registry`, or the materializer didn't run) the
   * flags are omitted and the baseline args are byte-identical.
   */
  protected agentArgs(assignment: WorkerAssignment): string[] {
    const configPath = mcpConfigPath(assignment.worktreePath);
    if (!fs.existsSync(configPath)) {
      return this.args;
    }
    return [...this.args, '--strict-mcp-config', '--mcp-config', configPath];
  }

  /**
   * `claude --input-format stream-json` keeps stdin open for follow-on user
   * messages until EOF. We use this for mid-spawn operator guidance.
   */
  protected streamingInput(): boolean {
    return true;
  }

  /**
   * Wrap the initial prompt as a JSONL `user` event — that's the wire
   * format `--input-format stream-json` expects. Confirmed by the spike
   * recorded in docs/research/live-agent-guidance.md (2026-06-02).
   */
  protected formatInitialPrompt(prompt: string): string {
    return (
      JSON.stringify({
        type: 'user',
        message: { role: 'user', content: prompt },
      }) + '\n'
    );
  }

  /**
   * Recognise claude's terminal completion event. When this fires,
   * `BaseCliWorker.spawnAgent` closes stdin so the held-open session
   * shuts down. Cheap parse — avoids polluting `parseStreamLine`'s
   * return shape (per the architect/engineer review).
   */
  protected isTerminalLine(rawLine: string): boolean {
    try {
      const obj = JSON.parse(rawLine);
      return obj?.type === 'result';
    } catch {
      return false;
    }
  }

  /**
   * Build the per-spawn input channel from the child's stdin. The
   * supervisor receives this via `WorkerAssignment.onChannel` and pushes
   * `loom_guide_agent` deltas through it. Backpressure is handled by
   * awaiting `'drain'`; oversized messages are rejected outright
   * (the supervisor will audit-log the rejection separately).
   */
  protected buildInputChannel(child: ChildProcess): WorkerInputChannel {
    let closed = false;
    const stdin = child.stdin;
    return {
      available: () => !closed && !!stdin && !stdin.writableEnded,
      close: () => {
        closed = true;
      },
      push: async (text: string): Promise<boolean> => {
        if (closed || !stdin || stdin.writableEnded) return false;
        if (Buffer.byteLength(text, 'utf8') > MAX_GUIDANCE_BYTES) {
          return false;
        }
        const line =
          JSON.stringify({
            type: 'user',
            message: { role: 'user', content: text },
          }) + '\n';
        const ok = stdin.write(line);
        if (!ok) {
          // Kernel pipe buffer is full; wait for the consumer to catch up
          // before reporting success.
          await new Promise<void>((resolve) => stdin.once('drain', resolve));
        }
        return true;
      },
    };
  }

  /**
   * Parses one JSON-line event from `claude --output-format stream-json`.
   * Returns a human-readable summary for live output AND, when the line is
   * the final `type:'result'` event, the cumulative usage snapshot.
   *
   * Event types we handle: `result`, `assistant`, `system/init`, and
   * `user` (the `--replay-user-messages` echo of operator-guidance pushes).
   * `--include-partial-messages` adds `stream_event` (wrapping
   * `message_start` / `content_block_*` deltas) and `system/status` /
   * `rate_limit_event` — all correctly fall through to `return {}` (the
   * spike on 2026-06-02 verified that these add no signal we want to
   * surface).
   */
  protected parseStreamLine(line: string): {
    humanText?: string;
    usage?: WorkerUsage;
    traces?: Array<{ kind: string; subject?: string; rationale: string }>;
  } {
    let event: unknown;
    try {
      event = JSON.parse(line);
    } catch {
      // Non-JSON line (e.g., a stderr message that leaked into stdout, or
      // text mode) — pass through as a normal output line.
      return { humanText: line };
    }
    if (!event || typeof event !== 'object') return { humanText: line };
    const obj = event as Record<string, unknown>;
    const type = typeof obj.type === 'string' ? obj.type : '';

    if (type === 'result') {
      const usage = parseUsage(obj.usage);
      const cost = typeof obj.total_cost_usd === 'number' ? obj.total_cost_usd : undefined;
      const resultText = typeof obj.result === 'string' ? obj.result.trim() : '';
      const human = resultText ? `(result) ${truncate(resultText, 200)}` : undefined;
      // Attribute 1 LLM session/request to this worker spawn. Claude
      // stream-json doesn't expose an internal request count, so this is the
      // session-level estimate; it's still the right grain for budgeting and
      // a per-request-billed cursor backend would override with the real
      // count from its JSON output.
      const usageWithCount = usage
        ? {
            ...usage,
            requestCount: 1,
            ...(cost !== undefined ? { costUsd: cost } : {}),
          }
        : undefined;
      return {
        ...(human ? { humanText: human } : {}),
        ...(usageWithCount ? { usage: usageWithCount } : {}),
      };
    }

    if (type === 'assistant') {
      const message = obj.message as Record<string, unknown> | undefined;
      const content = Array.isArray(message?.content) ? (message?.content as unknown[]) : [];

      // Decision-trace capture: pull thinking and tool-use blocks. The
      // thinking text leads the action (claude emits it before the tool
      // call), so it answers WHY this tool / response was chosen.
      const traces: Array<{ kind: string; subject?: string; rationale: string }> = [];
      const textParts: string[] = [];
      for (const c of content) {
        if (!c || typeof c !== 'object') continue;
        const block = c as Record<string, unknown>;
        if (block.type === 'thinking' && typeof block.thinking === 'string') {
          traces.push({ kind: 'thinking', rationale: block.thinking });
        } else if (block.type === 'text' && typeof block.text === 'string') {
          textParts.push(block.text);
        } else if (block.type === 'tool_use' && typeof block.name === 'string') {
          textParts.push(renderToolCall(block.name, block.input));
          // Tool intent = the most recent thinking block's substance + this
          // tool. Recorded so a later analysis can answer "why did the
          // agent call Bash here?" Subject stays as the tool name for
          // queryability — the human-readable summary lives in humanText.
          traces.push({
            kind: 'tool_intent',
            subject: String(block.name),
            rationale:
              traces.length > 0 && traces[traces.length - 1].kind === 'thinking'
                ? truncate(String(traces[traces.length - 1].rationale), 1200)
                : '(no preceding thinking block)',
          });
        }
      }
      const text = textParts.join(' ');
      const usage = parseUsage(message?.usage);
      return {
        ...(text ? { humanText: truncate(text, 400) } : {}),
        // Untruncated text for self-assessment marker parsing (B1) — humanText
        // is capped at 400 chars and could cut the trailing marker.
        ...(text ? { assistantText: text } : {}),
        ...(usage ? { usage } : {}),
        ...(traces.length > 0 ? { traces } : {}),
      };
    }

    if (type === 'system' && obj.subtype === 'init') {
      return { humanText: `(starting ${typeof obj.model === 'string' ? obj.model : 'claude'})` };
    }

    if (type === 'user') {
      // `--replay-user-messages` echoes back every JSONL `user` message we
      // push on stdin (initial prompt + each operator-guidance push). We
      // record those as `guidance_received` traces so the operator gets
      // proof the worker actually saw the message mid-spawn — surfaces in
      // loom_get_decision_traces.
      const message = obj.message as Record<string, unknown> | undefined;
      const content = message?.content;
      let text = '';
      if (typeof content === 'string') {
        // Spike confirmed this is the primary shape (2026-06-02).
        text = content;
      } else if (Array.isArray(content)) {
        // Defensive: handle content-block array shape if it ever appears.
        const parts: string[] = [];
        for (const c of content as unknown[]) {
          if (c && typeof c === 'object') {
            const block = c as Record<string, unknown>;
            if (block.type === 'text' && typeof block.text === 'string') {
              parts.push(block.text);
            }
          }
        }
        text = parts.join(' ');
      }
      if (!text) return {};
      return {
        traces: [
          { kind: 'guidance_received', rationale: truncate(text, 1200) },
        ],
      };
    }

    // Other event types (stream_event partial deltas, system/status,
    // rate_limit_event, etc.) are intentionally silent — they add noise
    // without signal for the decision-trace surface.
    return {};
  }
}

/**
 * The single place the worktree MCP-config path convention is derived. The
 * materializer (story-002-001) writes `<worktreePath>/.cursor/mcp.json`; keep
 * this join in one spot so the spawn-arg coupling to that convention has a
 * single point of change. Exported for unit testing.
 */
export function mcpConfigPath(worktreePath: string): string {
  return path.join(worktreePath, '.cursor', 'mcp.json');
}

function parseUsage(raw: unknown): WorkerUsage | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const u = raw as Record<string, unknown>;
  const inputTokens = numOr(u.input_tokens, 0);
  const outputTokens = numOr(u.output_tokens, 0);
  const cacheReadTokens = numOr(u.cache_read_input_tokens, 0);
  const cacheCreationTokens = numOr(u.cache_creation_input_tokens, 0);
  if (
    inputTokens === 0 &&
    outputTokens === 0 &&
    cacheReadTokens === 0 &&
    cacheCreationTokens === 0
  ) {
    return undefined;
  }
  return {
    inputTokens,
    outputTokens,
    cacheReadTokens,
    cacheCreationTokens,
    totalTokens: inputTokens + outputTokens + cacheReadTokens + cacheCreationTokens,
  };
}

function numOr(v: unknown, fallback: number): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback;
}

function truncate(s: string, n: number): string {
  return s.length <= n ? s : s.slice(0, n - 1) + '…';
}

/**
 * One-line human-readable summary of a tool_use block. The `input` is
 * shape-checked per tool — anything missing falls through to the bare
 * `[tool: name]` so a previously-unseen tool still renders something.
 *
 * Output is intentionally bounded per tool: a Write of a 500-line file
 * surfaces as `[Write] foo.ts (500 lines)`, not 500 lines of pasted
 * content. The full input is recoverable from the audit log if needed;
 * this rendering is for the realtime dashboard's live-output pane where
 * the size constraint matters.
 *
 * Exported for unit testing.
 */
export function renderToolCall(name: string, input: unknown): string {
  const inp =
    input && typeof input === 'object' ? (input as Record<string, unknown>) : {};
  const str = (v: unknown): string | undefined =>
    typeof v === 'string' ? v : undefined;
  const num = (v: unknown): number | undefined =>
    typeof v === 'number' && Number.isFinite(v) ? v : undefined;

  switch (name) {
    case 'Bash': {
      const cmd = str(inp.command) ?? '';
      const desc = str(inp.description);
      if (desc) return `[Bash] ${desc}: ${truncate(cmd, 80)}`;
      return `[Bash] ${truncate(cmd, 120)}`;
    }
    case 'Read': {
      const file = str(inp.file_path) ?? '?';
      const offset = num(inp.offset);
      const limit = num(inp.limit);
      if (offset != null && limit != null) {
        return `[Read] ${file}:${offset}-${offset + limit}`;
      }
      return `[Read] ${file}`;
    }
    case 'Edit': {
      const file = str(inp.file_path) ?? '?';
      const replaceAll = inp.replace_all === true ? ' (replace_all)' : '';
      return `[Edit] ${file}${replaceAll}`;
    }
    case 'MultiEdit': {
      const file = str(inp.file_path) ?? '?';
      const edits = Array.isArray(inp.edits) ? inp.edits.length : 0;
      return `[MultiEdit] ${file} (${edits} edit${edits === 1 ? '' : 's'})`;
    }
    case 'Write': {
      const file = str(inp.file_path) ?? '?';
      const content = str(inp.content) ?? '';
      const lines = content.length === 0 ? 0 : content.split('\n').length;
      return lines > 0 ? `[Write] ${file} (${lines} line${lines === 1 ? '' : 's'})` : `[Write] ${file}`;
    }
    case 'Grep': {
      const pattern = str(inp.pattern) ?? '?';
      const p = str(inp.path);
      const out = str(inp.output_mode);
      const mode = out && out !== 'files_with_matches' ? ` [${out}]` : '';
      return p
        ? `[Grep] '${truncate(pattern, 60)}' in ${p}${mode}`
        : `[Grep] '${truncate(pattern, 60)}'${mode}`;
    }
    case 'Glob': {
      const pattern = str(inp.pattern) ?? '?';
      const p = str(inp.path);
      return p ? `[Glob] ${truncate(pattern, 80)} in ${p}` : `[Glob] ${truncate(pattern, 100)}`;
    }
    case 'WebFetch': {
      const url = str(inp.url) ?? '?';
      return `[WebFetch] ${truncate(url, 100)}`;
    }
    case 'WebSearch': {
      const query = str(inp.query) ?? '?';
      return `[WebSearch] ${truncate(query, 100)}`;
    }
    case 'Task': {
      const desc = str(inp.description) ?? '';
      const subagent = str(inp.subagent_type);
      return subagent
        ? `[Task ${subagent}] ${truncate(desc, 100)}`
        : `[Task] ${truncate(desc, 100)}`;
    }
    case 'TodoWrite': {
      const todos = Array.isArray(inp.todos) ? inp.todos.length : 0;
      return `[TodoWrite] ${todos} todo${todos === 1 ? '' : 's'}`;
    }
    case 'NotebookEdit': {
      const path = str(inp.notebook_path) ?? '?';
      return `[NotebookEdit] ${path}`;
    }
    case 'Skill': {
      const skill = str(inp.skill) ?? '?';
      return `[Skill] ${skill}`;
    }
    case 'SlashCommand': {
      const cmd = str(inp.command) ?? '?';
      return `[SlashCommand] ${truncate(cmd, 100)}`;
    }
    default: {
      // MCP tools — claude-cli registers them as mcp__<server>__<tool>.
      // Render with a short label + any obvious scalar input value.
      if (name.startsWith('mcp__')) {
        const shortName = name.slice(5).replace('__', '/');
        const hint = firstScalarInputHint(inp);
        return hint ? `[mcp ${shortName}] ${truncate(hint, 80)}` : `[mcp ${shortName}]`;
      }
      // Unknown tool — fall back to the previous bare-name rendering so
      // nothing visually breaks; the unit test for unknown tools pins this.
      return `[tool: ${name}]`;
    }
  }
}

/** Best-effort first string value of the input object, for unknown-tool hint. */
function firstScalarInputHint(inp: Record<string, unknown>): string | undefined {
  for (const v of Object.values(inp)) {
    if (typeof v === 'string' && v.length > 0) return v;
  }
  return undefined;
}
