import { spawn } from 'node:child_process';
import { EMPTY_USAGE } from './LLMClient.js';
import { flattenMessages } from './ClaudeCliClient.js';
import type { LLMClient, LLMRequest, LLMResponse } from './LLMClient.js';

export interface CursorCliClientOptions {
  /** Binary to invoke. Default: "cursor-agent". */
  cursorBin?: string;
  /** Kill a call after this long. Default: 10 minutes. */
  timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;

/**
 * Upper bound on the cursor-agent output surfaced in a non-zero-exit Error.
 * Large enough to hold the complete valid-model list cursor-agent prints on a
 * bad `--model` (the one message an operator needs to fix their config), while
 * still capping memory and log spam on pathological output (ADR-6).
 */
export const MAX_ERROR_OUTPUT_CHARS = 64_000;

/**
 * Session-based LLM client backed by Cursor's `cursor-agent` CLI. With no
 * `--api-key` (and no CURSOR_API_KEY), cursor-agent uses the developer's Cursor
 * login — no API key, no API billing. Planning runs read-only (`--mode ask`).
 *
 * The model is always passed explicitly and MAX mode is never enabled — loom
 * targets a specific model (a Claude model id, mirroring the claude-cli path).
 * The subprocess call is an integration seam; output parsing is unit-tested.
 */
export class CursorCliClient implements LLMClient {
  private bin: string;
  private timeoutMs: number;

  constructor(opts: CursorCliClientOptions = {}) {
    this.bin = opts.cursorBin ?? 'cursor-agent';
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  async complete(req: LLMRequest): Promise<LLMResponse> {
    const systemText = req.system.map((b) => b.text).join('\n\n');
    // cursor-agent has no separate system-prompt flag — prepend it to the prompt.
    const prompt = systemText
      ? `${systemText}\n\n---\n\n${flattenMessages(req.messages)}`
      : flattenMessages(req.messages);

    // --mode ask keeps planning read-only; --trust avoids the headless trust
    // prompt; an explicit --model targets a specific model (never MAX).
    const args = [
      '-p',
      '--output-format',
      'json',
      '--model',
      req.model,
      '--mode',
      'ask',
      '--trust',
    ];

    const proc = await this.spawn(args, prompt);
    if (proc.spawnError) {
      throw new Error(
        `Could not run the "${this.bin}" CLI: ${proc.spawnError}. ` +
          'Install Cursor and run `cursor-agent` once to log in, or switch ' +
          'policy.agents.llm_backend to "claude-cli".'
      );
    }
    if (proc.timedOut) {
      throw new Error(`cursor-agent timed out after ${this.timeoutMs}ms`);
    }
    if (proc.code !== 0) {
      throw new Error(
        `cursor-agent exited ${proc.code}: ${proc.output.slice(0, MAX_ERROR_OUTPUT_CHARS)}`
      );
    }

    return parseCursorJson(proc.output, req.model);
  }

  private spawn(
    args: string[],
    prompt: string
  ): Promise<{ code: number | null; output: string; timedOut: boolean; spawnError?: string }> {
    return new Promise((resolve) => {
      let stdout = '';
      let stderr = '';
      let timedOut = false;
      let settled = false;

      const child = spawn(this.bin, args, { stdio: ['pipe', 'pipe', 'pipe'] });
      const timer = setTimeout(() => {
        timedOut = true;
        child.kill('SIGTERM');
      }, this.timeoutMs);

      child.stdout.on('data', (d) => (stdout += d.toString()));
      child.stderr.on('data', (d) => (stderr += d.toString()));

      child.on('error', (err) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve({ code: null, output: stdout + stderr, timedOut, spawnError: err.message });
      });
      child.on('close', (code) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve({ code, output: stdout || stderr, timedOut });
      });

      child.stdin.write(prompt);
      child.stdin.end();
    });
  }
}

/**
 * Parses `cursor-agent --output-format json` stdout into an LLMResponse.
 * Defensive — the exact field names vary, so several are tried before falling
 * back to the raw stdout.
 *
 * Usage harvesting: cursor-agent's JSON output may include any subset of
 * `usage`, `total_cost_usd`, `request_count`, or per-tool-use records. We
 * extract whatever's present; if the CLI reports nothing, we still attribute
 * `requestCount: 1` for the single `complete()` call so per-request billing
 * — the org pricing model under cursor-cli — has a defensible minimum value
 * instead of a misleading zero.
 */
export function parseCursorJson(stdout: string, model: string): LLMResponse {
  let text = stdout.trim();
  let usage = { ...EMPTY_USAGE, requestCount: 1 };

  try {
    const json = JSON.parse(stdout) as Record<string, unknown>;
    for (const key of ['result', 'text', 'response', 'content', 'message']) {
      if (typeof json[key] === 'string') {
        text = json[key] as string;
        break;
      }
    }

    // Harvest any usage / cost / request-count fields cursor-agent reports
    // — names vary across CLI versions, so check several. Falls through
    // silently on every miss; usage stays at the `requestCount: 1` baseline.
    const u = json.usage as Record<string, unknown> | undefined;
    const inputTokens = readNumber(u, ['input_tokens', 'inputTokens', 'prompt_tokens']);
    const outputTokens = readNumber(u, ['output_tokens', 'outputTokens', 'completion_tokens']);
    const cacheReadTokens = readNumber(u, [
      'cache_read_input_tokens',
      'cacheReadInputTokens',
      'cached_tokens',
    ]);
    const cacheCreationTokens = readNumber(u, [
      'cache_creation_input_tokens',
      'cacheCreationInputTokens',
    ]);
    const requestCount =
      readNumber(json, ['request_count', 'requestCount', 'requests']) ??
      readNumber(u, ['request_count', 'requestCount', 'requests']) ??
      1;
    const costUsd =
      readNumber(json, ['total_cost_usd', 'totalCostUsd', 'cost_usd']) ?? 0;

    if (
      inputTokens !== undefined ||
      outputTokens !== undefined ||
      requestCount !== undefined ||
      costUsd !== undefined
    ) {
      usage = {
        inputTokens: inputTokens ?? 0,
        outputTokens: outputTokens ?? 0,
        cacheReadTokens: cacheReadTokens ?? 0,
        cacheCreationTokens: cacheCreationTokens ?? 0,
        requestCount: requestCount ?? 1,
        costUsd: costUsd ?? 0,
      };
    }
  } catch {
    // Not a single JSON object — treat the raw stdout as the response text.
  }

  return { text, model, stopReason: 'end_turn', usage };
}

function readNumber(
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
