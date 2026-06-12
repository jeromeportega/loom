import { spawn } from 'node:child_process';
import { EMPTY_USAGE } from './LLMClient.js';
import type { LLMClient, LLMRequest, LLMResponse, LLMMessage } from './LLMClient.js';

export interface ClaudeCliClientOptions {
  /** Binary to invoke. Default: "claude". */
  claudeBin?: string;
  /** Kill a call after this long. Default: 10 minutes. */
  timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;

/**
 * HTTP status codes the Anthropic API returns when the request is *not* the
 * caller's fault — server overload, rate limiting, transient infra hiccups.
 * A second attempt has a real chance to succeed. NOT included: 4xx codes
 * that mean "your input was wrong" (400/401/403/404/422) — retrying those
 * just burns the same call twice.
 */
const TRANSIENT_API_STATUSES = new Set([408, 429, 500, 502, 503, 504, 529]);
const MAX_RETRIES = 3;
const BACKOFF_BASE_MS = 1000;

/**
 * Session-based LLM client: runs `claude -p` (headless print mode) using the
 * developer's Claude Code subscription login. No API key, no API billing —
 * the path for environments that do not permit API expenditure.
 *
 * The `claude` CLI is single-shot, so a multi-turn LLMRequest is flattened
 * into one prompt. The subprocess invocation is an integration seam (it needs
 * a configured `claude` CLI); the prompt flattening is unit-tested.
 */
export class ClaudeCliClient implements LLMClient {
  private bin: string;
  private timeoutMs: number;

  constructor(opts: ClaudeCliClientOptions = {}) {
    this.bin = opts.claudeBin ?? 'claude';
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  async complete(req: LLMRequest): Promise<LLMResponse> {
    const systemText = req.system.map((b) => b.text).join('\n\n');
    const prompt = flattenMessages(req.messages);

    const args = ['-p', '--model', req.model, '--output-format', 'json'];
    if (systemText.length > 0) {
      args.push('--append-system-prompt', systemText);
    }

    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      const proc = await this.spawnClaude(args, prompt);
      if (proc.spawnError) {
        // A spawn error means the binary isn't there / can't run — retrying
        // doesn't help; surface the install guidance immediately.
        throw new Error(
          `Could not run the "${this.bin}" CLI: ${proc.spawnError}. ` +
            'Install Claude Code and run `claude` once to log in, or switch ' +
            'policy.agents.llm_backend to "cursor-cli".'
        );
      }
      if (proc.timedOut) {
        throw new Error(`claude CLI timed out after ${this.timeoutMs}ms`);
      }
      if (proc.code !== 0) {
        const status = extractApiErrorStatus(proc.output);
        if (status !== undefined && TRANSIENT_API_STATUSES.has(status) && attempt < MAX_RETRIES) {
          const delayMs = BACKOFF_BASE_MS * Math.pow(2, attempt);
          await new Promise((r) => setTimeout(r, delayMs));
          continue;
        }
        throw new Error(`claude CLI exited ${proc.code}: ${proc.output.slice(0, 500)}`);
      }
      return parseClaudeJson(proc.output, req.model);
    }

    // Loop exit only on retry-exhaustion (every iteration either returns or
    // throws); this line is here to satisfy the compiler.
    throw new Error('claude CLI: retries exhausted');
  }

  private spawnClaude(
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

/** Flattens a (possibly multi-turn) message list into one single-shot prompt. */
export function flattenMessages(messages: LLMMessage[]): string {
  if (messages.length === 1) return messages[0].content;
  return messages
    .map((m) =>
      m.role === 'user'
        ? m.content
        : `--- your previous response ---\n${m.content}\n--- end ---`
    )
    .join('\n\n');
}

/**
 * When `claude` exits non-zero, the stdout still contains the result JSON with
 * `is_error: true` and an `api_error_status` field for HTTP-shaped failures.
 * Returns the status code if present, or undefined for non-HTTP failures
 * (auth error, malformed input, internal claude-cli bug).
 */
export function extractApiErrorStatus(output: string): number | undefined {
  try {
    const json = JSON.parse(output) as { api_error_status?: unknown };
    return typeof json.api_error_status === 'number' ? json.api_error_status : undefined;
  } catch {
    return undefined;
  }
}

/** Parses `claude -p --output-format json` stdout into an LLMResponse. */
export function parseClaudeJson(stdout: string, model: string): LLMResponse {
  let text = stdout.trim();
  // One `complete()` call is one logical request from the caller's
  // perspective; `claude --output-format json` does not expose an internal
  // request count, so we attribute the call as `requestCount: 1`. The actual
  // dollar cost is reported by Claude in `total_cost_usd` and is the real
  // API-billed amount (not a token-rate estimate).
  let usage = { ...EMPTY_USAGE, requestCount: 1 };

  try {
    const json = JSON.parse(stdout) as {
      result?: unknown;
      text?: unknown;
      total_cost_usd?: unknown;
      usage?: {
        input_tokens?: number;
        output_tokens?: number;
        cache_read_input_tokens?: number;
        cache_creation_input_tokens?: number;
      };
    };
    if (typeof json.result === 'string') text = json.result;
    else if (typeof json.text === 'string') text = json.text;
    if (json.usage) {
      usage = {
        inputTokens: json.usage.input_tokens ?? 0,
        outputTokens: json.usage.output_tokens ?? 0,
        cacheReadTokens: json.usage.cache_read_input_tokens ?? 0,
        cacheCreationTokens: json.usage.cache_creation_input_tokens ?? 0,
        requestCount: 1,
        costUsd:
          typeof json.total_cost_usd === 'number' ? json.total_cost_usd : 0,
      };
    }
  } catch {
    // Not JSON — treat the raw stdout as the response text.
  }

  return { text, model, stopReason: 'end_turn', usage };
}
