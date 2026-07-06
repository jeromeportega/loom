import type { CommandDescription } from '../describe/schema.js';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { PolicyEngine, AuditLog, type ReadScopeContext } from '@loom-ai/core';
import { openProjectDatabase } from '../dbHelper.js';

const LOOM_DIR = '.loom';

const LOOM_WORKER_CONTEXT_KEY = 'LOOM_WORKER_CONTEXT';
const LOOM_WORKER_CONTEXT_VALUE = '1';

/**
 * Returns true when the current process is running in a loom worker context:
 * either (1) the process cwd resolves to a path under the loom worktrees
 * directory (primary check), or (2) the LOOM_WORKER_CONTEXT env marker is '1'
 * (defense-in-depth for env-marker-based worker detection).
 *
 * Exported for unit testing; not part of the public CLI API.
 */
export function isWorkerContext(worktreesDir: string): boolean {
  try {
    const cwd = fs.realpathSync(process.cwd());
    const wt  = fs.realpathSync(worktreesDir);
    if (cwd.startsWith(wt + path.sep) || cwd === wt) return true;
  } catch { /* worktreesDir may not exist in operator sessions */ }
  return process.env[LOOM_WORKER_CONTEXT_KEY] === LOOM_WORKER_CONTEXT_VALUE;
}

// Exit codes:
//   0 — allowed
//   1 — blocked (generic)
//   2 — blocked, feedback shown to Claude (Claude Code hook protocol)
const EXIT_ALLOW = 0;
const EXIT_BLOCK = 1;
const EXIT_BLOCK_WITH_FEEDBACK = 2;

/** Native Claude Code tools whose path args are enforced by checkReadScope. */
const READ_TOOLS = new Set(['Read', 'Grep', 'Glob']);

export function runGuardCheck(command: string): void {
  const result = evaluateCommand(command);
  if (result.blockExitCode !== EXIT_ALLOW) {
    process.stderr.write(JSON.stringify(result.message) + '\n');
    process.exit(result.blockExitCode);
  }
  process.exit(EXIT_ALLOW);
}

/**
 * Reads Claude Code's PreToolUse JSON from stdin and runs the policy check.
 * Claude Code hook input shape:
 *   { hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: "..." }, ... }
 * On block: exit code 2 prints stderr to Claude and aborts the tool call.
 *
 * Dispatch:
 *  - Read/Grep/Glob → checkReadScope on the path arg (worker sessions only)
 *  - Bash → write/git checks for all sessions, then checkReadScopeCommand for workers
 *  - All other tools → allowed
 */
export async function runGuardHook(): Promise<void> {
  const raw = await readStdin();
  let payload: { tool_name?: string; tool_input?: Record<string, unknown> } = {};
  try {
    payload = JSON.parse(raw) as typeof payload;
  } catch {
    // Not JSON — allow (we only enforce on parseable payloads)
    process.exit(EXIT_ALLOW);
  }

  const toolName = payload.tool_name ?? '';
  const projectRoot = process.cwd();
  const loomDir = path.join(projectRoot, LOOM_DIR);

  // ── Native read-tool dispatch (Read / Grep / Glob) ────────────────────────
  if (READ_TOOLS.has(toolName)) {
    const toolInput = payload.tool_input ?? {};
    const targetPath =
      (toolInput.file_path as string | undefined) ??
      (toolInput.path as string | undefined) ??
      '';

    // Empty path → resolves to cwd → in-scope by definition
    if (!targetPath) {
      process.exit(EXIT_ALLOW);
    }

    // Read-scope is only enforced in worker sessions. Operator sessions pass
    // through unrestricted so they are never blocked by containment policy.
    const mainRepoRoot = resolveMainRepoRoot(projectRoot);
    const worktreesDir = path.join(mainRepoRoot, LOOM_DIR, 'worktrees');
    if (!isWorkerContext(worktreesDir)) {
      process.exit(EXIT_ALLOW);
    }

    let engine: PolicyEngine;
    try {
      engine = PolicyEngine.load(loomDir);
    } catch {
      // Policy unavailable (pre-loom-init, worktree without .loom/) — allow
      process.exit(EXIT_ALLOW);
    }
    const ctx = buildReadScopeCtx(engine, projectRoot);
    const result = engine.checkReadScope(targetPath, ctx);
    if (!result.allowed) {
      process.stderr.write(
        JSON.stringify({ loom_guard: 'blocked', rule: result.rule, reason: result.reason }) + '\n',
      );
      process.exit(EXIT_BLOCK_WITH_FEEDBACK);
    }
    process.exit(EXIT_ALLOW);
  }

  // ── Bash dispatch ─────────────────────────────────────────────────────────
  if (toolName === 'Bash') {
    const command = (payload.tool_input?.command as string | undefined) ?? '';
    if (!command) {
      process.exit(EXIT_ALLOW);
    }

    // Write/git checks run for ALL sessions (operators and workers alike).
    const evalResult = evaluateCommand(command);
    if (evalResult.blockExitCode !== EXIT_ALLOW) {
      process.stderr.write(
        `loom blocked this command: ${evalResult.message.reason}\n` +
          `Rule: ${evalResult.message.rule}\n` +
          `Command: ${evalResult.message.command}\n`,
      );
      process.exit(EXIT_BLOCK_WITH_FEEDBACK);
    }

    // Read-scope check: only enforced in worker sessions.
    const mainRepoRoot = resolveMainRepoRoot(projectRoot);
    const worktreesDir = path.join(mainRepoRoot, LOOM_DIR, 'worktrees');
    if (!isWorkerContext(worktreesDir)) {
      process.exit(EXIT_ALLOW);
    }

    let engine: PolicyEngine;
    try {
      engine = PolicyEngine.load(loomDir);
    } catch {
      // Policy unavailable (pre-loom-init, worktree without .loom/) — allow
      process.exit(EXIT_ALLOW);
    }
    const ctx = buildReadScopeCtx(engine, projectRoot);
    const readResult = engine.checkReadScopeCommand(command, ctx);
    if (!readResult.allowed) {
      process.stderr.write(
        JSON.stringify({ loom_guard: 'blocked', rule: readResult.rule, reason: readResult.reason }) + '\n',
      );
      process.exit(EXIT_BLOCK_WITH_FEEDBACK);
    }
    process.exit(EXIT_ALLOW);
  }

  // All other tools — not intercepted
  process.exit(EXIT_ALLOW);
}

/** Builds a ReadScopeContext from the engine's policy, resolving readRoot against projectRoot. */
function buildReadScopeCtx(engine: PolicyEngine, projectRoot: string): ReadScopeContext {
  const worktreeRoot = projectRoot;
  const readRoot = path.resolve(
    projectRoot,
    engine.policyData?.filesystem?.allowed_read_root ?? '.',
  );

  // In a git worktree, the DB lives in the main repo (not the worktree directory).
  // Resolve the main repo root via git so DB open finds the right path.
  const mainRepoRoot = resolveMainRepoRoot(projectRoot);

  let audit: AuditLog | undefined;
  try {
    const db = openProjectDatabase(mainRepoRoot);
    audit = new AuditLog(db);
  } catch {
    // No DB yet (loom init hasn't run) — still enforce policy
  }

  return {
    worktreeRoot,
    readRoot,
    audit: audit ?? makeNoopAudit(),
  };
}

/**
 * Returns the main repo root from any directory inside a git repo or worktree.
 * In a linked worktree `git rev-parse --git-common-dir` returns the path to the
 * main .git directory, whose parent is the main repo root.
 */
function resolveMainRepoRoot(cwd: string): string {
  try {
    const gitCommonDir = execFileSync('git', ['rev-parse', '--git-common-dir'], {
      cwd,
      encoding: 'utf8',
    }).trim();
    const absGitDir = path.isAbsolute(gitCommonDir)
      ? gitCommonDir
      : path.resolve(cwd, gitCommonDir);
    return path.dirname(absGitDir);
  } catch {
    return cwd;
  }
}

/**
 * No-op audit used when the DB is unavailable (pre-loom-init).
 * Uses a Proxy so any unexpected method call beyond `record()` throws immediately
 * rather than silently returning undefined — making interface drift visible.
 */
function makeNoopAudit(): AuditLog {
  const handler: ProxyHandler<object> = {
    get(_target, prop: string | symbol) {
      if (prop === 'record') return () => undefined;
      throw new TypeError(
        `makeNoopAudit: AuditLog.${String(prop)}() called but no database is available`,
      );
    },
  };
  return new Proxy({}, handler) as unknown as AuditLog;
}

interface EvaluatedCommand {
  blockExitCode: number;
  message: {
    loom_guard: 'blocked' | 'allowed';
    command: string;
    rule?: string;
    reason?: string;
  };
}

function evaluateCommand(command: string): EvaluatedCommand {
  const projectRoot = process.cwd();
  const loomDir = path.join(projectRoot, LOOM_DIR);

  const engine = PolicyEngine.load(loomDir);
  const result = engine.check(command);

  // Log to audit_log if DB is available
  try {
    const db = openProjectDatabase(projectRoot);
    const audit = new AuditLog(db);
    audit.record({
      action: 'bash_command',
      command,
      allowed: result.allowed,
      policy_rule: result.rule,
      detail: result.reason ? { reason: result.reason } : undefined,
    });
  } catch {
    // No DB yet (loom init hasn't run) — still enforce policy
  }

  if (!result.allowed) {
    return {
      blockExitCode: EXIT_BLOCK,
      message: {
        loom_guard: 'blocked',
        command,
        rule: result.rule,
        reason: result.reason,
      },
    };
  }

  return {
    blockExitCode: EXIT_ALLOW,
    message: { loom_guard: 'allowed', command },
  };
}

function readStdin(): Promise<string> {
  return new Promise((resolve) => {
    let data = '';
    if (process.stdin.isTTY) {
      resolve('');
      return;
    }
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => (data += chunk));
    process.stdin.on('end', () => resolve(data));
    process.stdin.on('error', () => resolve(''));
  });
}

export const specCheck: CommandDescription = {
  name: 'guard check',
  summary: 'Check whether a command is allowed by policy',
  whenToUse: 'Use manually to test whether a specific shell command would be blocked by loom policy before running it.',
  arguments: [],
  options: [
    { name: '--command', type: 'string', description: 'The shell command to validate against policy', changesOutputShape: false },
  ],
  output: { text: 'Exit 0 if allowed; non-zero with JSON reason if blocked' },
  examples: [
    { command: 'loom guard check --command "git push --force"', description: 'Check whether force-push is allowed' },
    { command: 'loom guard check --command "rm -rf /"', description: 'Check a destructive command' },
  ],
  exitCodes: [
    { code: 0, meaning: 'Command is allowed by policy' },
    { code: 1, meaning: 'Command is blocked (generic)' },
    { code: 2, meaning: 'Command is blocked; feedback shown to Claude Code' },
  ],
  errors: ['loom policy file not found — run `loom init` first'],
  relationships: { prerequisites: ['init'], nextSteps: [] },
};

export const specHook: CommandDescription = {
  name: 'guard hook',
  audience: 'internal',
  summary: 'Enforce policy on PreToolUse events from Claude Code hooks',
  whenToUse: 'Used automatically by the .claude/settings.json PreToolUse hook; not for direct human use.',
  arguments: [],
  options: [],
  output: { text: 'Exit 0 to allow; exit 2 with stderr message to block and show feedback to Claude' },
  examples: [
    { command: 'echo \'{"hook_event_name":"PreToolUse","tool_name":"Bash","tool_input":{"command":"rm -rf /"}}\' | loom guard hook', description: 'Simulate a hook event (internal use)' },
  ],
  exitCodes: [
    { code: 0, meaning: 'Tool call allowed by policy' },
    { code: 2, meaning: 'Tool call blocked; reason shown to Claude Code' },
  ],
  errors: ['Malformed JSON input — non-JSON input is allowed through'],
  relationships: { prerequisites: ['init'], nextSteps: [] },
};
