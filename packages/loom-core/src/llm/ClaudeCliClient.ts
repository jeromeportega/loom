import { spawn } from 'node:child_process';
import { EMPTY_USAGE } from './LLMClient.js';
import type { LLMClient, LLMRequest, LLMResponse, LLMMessage, LLMUsage } from './LLMClient.js';
import { redactSecrets } from '../util/redact.js';

export interface ClaudeCliClientOptions {
  /** Binary to invoke. Default: "claude". */
  claudeBin?: string;
  /** Kill a call after this long. Default: 10 minutes. */
  timeoutMs?: number;
  /**
   * When true, strips ANTHROPIC_API_KEY and ANTHROPIC_AUTH_TOKEN from the
   * subprocess environment so the CLI falls back to the operator's `claude
   * login` session rather than billing an inherited API key. Mirrors
   * BaseCliWorker.workerAuth='session' for the planner subprocess (ADR-006).
   */
  sessionAuth?: boolean;
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
 *
 * When `req.onText` is present, switches to `--output-format stream-json` and
 * calls `onText` per assistant text delta while accumulating the full response.
 * When absent, uses the original `--output-format json` buffered path.
 */
export class ClaudeCliClient implements LLMClient {
  private bin: string;
  private timeoutMs: number;
  private sessionAuth: boolean;

  constructor(opts: ClaudeCliClientOptions = {}) {
    this.bin = opts.claudeBin ?? 'claude';
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.sessionAuth = opts.sessionAuth ?? false;
  }

  async complete(req: LLMRequest): Promise<LLMResponse> {
    if (req.onText) {
      return this.completeStreaming(req);
    }
    return this.completeBuffered(req);
  }

  // ─── Buffered (original) path ─────────────────────────────────────────────

  private async completeBuffered(req: LLMRequest): Promise<LLMResponse> {
    const systemText = req.system.map((b) => b.text).join('\n\n');
    const prompt = flattenMessages(req.messages);

    const args = ['-p', '--model', req.model, '--output-format', 'json'];
    if (systemText.length > 0) {
      args.push('--append-system-prompt', systemText);
    }

    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      const proc = await this.spawnClaude(args, prompt);
      if (proc.spawnError) {
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

    throw new Error('claude CLI: retries exhausted');
  }

  // ─── Streaming path (onText present) ─────────────────────────────────────

  private async completeStreaming(req: LLMRequest): Promise<LLMResponse> {
    const onText = req.onText!;
    const systemText = req.system.map((b) => b.text).join('\n\n');
    const prompt = flattenMessages(req.messages);

    const args = ['-p', '--model', req.model, '--output-format', 'stream-json'];
    if (systemText.length > 0) {
      args.push('--append-system-prompt', systemText);
    }

    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      const proc = await this.spawnClaudeStream(args, prompt, req.model, onText);
      if (proc.spawnError) {
        throw new Error(
          `Could not run the "${this.bin}" CLI: ${proc.spawnError}. ` +
            'Install Claude Code and run `claude` once to log in, or switch ' +
            'policy.agents.llm_backend to "cursor-cli".'
        );
      }
      if (proc.timedOut) {
        throw new Error(`claude CLI timed out after ${this.timeoutMs}ms`);
      }
      if (!proc.success && proc.code !== 0) {
        const status = extractApiErrorStatus(proc.lastLine ?? '');
        if (status !== undefined && TRANSIENT_API_STATUSES.has(status) && attempt < MAX_RETRIES) {
          const delayMs = BACKOFF_BASE_MS * Math.pow(2, attempt);
          await new Promise((r) => setTimeout(r, delayMs));
          continue;
        }
        throw new Error(
          `claude CLI exited ${proc.code}: ${redactSecrets((proc.lastLine ?? '').slice(0, 500))}`
        );
      }
      return proc.response;
    }

    throw new Error('claude CLI: retries exhausted');
  }

  // ─── Subprocess helpers ───────────────────────────────────────────────────

  /** Returns the env to pass to the subprocess. Strips API keys when sessionAuth=true. */
  private spawnEnv(): NodeJS.ProcessEnv {
    if (!this.sessionAuth) return { ...process.env };
    const env = { ...process.env };
    delete env.ANTHROPIC_API_KEY;
    delete env.ANTHROPIC_AUTH_TOKEN;
    return env;
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

      const child = spawn(this.bin, args, { stdio: ['pipe', 'pipe', 'pipe'], env: this.spawnEnv() });
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

  /**
   * Streams `claude -p --output-format stream-json`. Parses line-delimited
   * events and calls `onText` once per assistant text delta. The returned
   * `response.text` equals the concatenation of all deltas.
   */
  private spawnClaudeStream(
    args: string[],
    prompt: string,
    model: string,
    onText: (delta: string) => void
  ): Promise<{
    code: number | null;
    response: LLMResponse;
    success: boolean;
    timedOut: boolean;
    spawnError?: string;
    lastLine?: string;
  }> {
    return new Promise((resolve) => {
      let accText = '';
      let usage: LLMUsage = { ...EMPTY_USAGE, requestCount: 1 };
      let success = false;
      let timedOut = false;
      let settled = false;
      let stderrBuf = '';
      let stdoutBuf = '';
      let lastLine = '';

      const child = spawn(this.bin, args, { stdio: ['pipe', 'pipe', 'pipe'], env: this.spawnEnv() });
      const timer = setTimeout(() => {
        timedOut = true;
        child.kill('SIGTERM');
      }, this.timeoutMs);

      const processLine = (line: string): void => {
        if (!line.trim()) return;
        lastLine = line;
        try {
          const event = JSON.parse(line) as {
            type?: string;
            text?: unknown;
            result?: unknown;
            is_error?: boolean;
            total_cost_usd?: unknown;
            usage?: {
              input_tokens?: number;
              output_tokens?: number;
              cache_read_input_tokens?: number;
              cache_creation_input_tokens?: number;
            };
            // assistant message format
            message?: {
              content?: Array<{ type: string; text?: string }>;
              usage?: {
                input_tokens?: number;
                output_tokens?: number;
                cache_read_input_tokens?: number;
                cache_creation_input_tokens?: number;
              };
            };
          };

          if (event.type === 'text' && typeof event.text === 'string') {
            // Simple text-delta format: {"type":"text","text":"..."}
            onText(event.text);
            accText += event.text;
          } else if (event.type === 'assistant' && event.message?.content) {
            // Assistant message format: content blocks with type='text'
            for (const block of event.message.content) {
              if (block.type === 'text' && typeof block.text === 'string') {
                onText(block.text);
                accText += block.text;
              }
            }
          } else if (event.type === 'result') {
            success = !event.is_error;
            if (typeof event.result === 'string' && !accText) {
              // Fallback: no deltas were emitted, use result text
              accText = event.result;
            }
            if (event.usage) {
              usage = {
                inputTokens: event.usage.input_tokens ?? 0,
                outputTokens: event.usage.output_tokens ?? 0,
                cacheReadTokens: event.usage.cache_read_input_tokens ?? 0,
                cacheCreationTokens: event.usage.cache_creation_input_tokens ?? 0,
                requestCount: 1,
                costUsd:
                  typeof event.total_cost_usd === 'number' ? event.total_cost_usd : 0,
              };
            }
          }
        } catch {
          // Non-JSON line — ignore; keep processing
        }
      };

      child.stdout.on('data', (d) => {
        stdoutBuf += d.toString();
        const lines = stdoutBuf.split('\n');
        stdoutBuf = lines.pop()!;
        for (const line of lines) processLine(line);
      });

      child.stderr.on('data', (d) => (stderrBuf += d.toString()));

      child.on('error', (err) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve({
          code: null,
          response: { text: accText || redactSecrets(stderrBuf), usage, model, stopReason: 'end_turn' },
          success: false,
          timedOut,
          spawnError: err.message,
          lastLine,
        });
      });

      child.on('close', (code) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        // Flush any remaining partial line
        if (stdoutBuf.trim()) processLine(stdoutBuf);
        resolve({
          code,
          response: { text: accText || redactSecrets(stderrBuf), usage, model, stopReason: 'end_turn' },
          success,
          timedOut,
          lastLine: lastLine || stderrBuf,
        });
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
