import path from 'node:path';
import { PolicyEngine, openDatabase, AuditLog } from '@loom-ai/core';

const LOOM_DIR = '.loom';

// Exit codes:
//   0 — allowed
//   1 — blocked (generic)
//   2 — blocked, feedback shown to Claude (Claude Code hook protocol)
const EXIT_ALLOW = 0;
const EXIT_BLOCK = 1;
const EXIT_BLOCK_WITH_FEEDBACK = 2;

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
 */
export async function runGuardHook(): Promise<void> {
  const raw = await readStdin();
  let payload: { tool_name?: string; tool_input?: { command?: string } } = {};
  try {
    payload = JSON.parse(raw) as typeof payload;
  } catch {
    // Not JSON — allow (we only enforce on parseable Bash payloads)
    process.exit(EXIT_ALLOW);
  }

  // Only act on Bash tool calls
  if (payload.tool_name !== 'Bash') {
    process.exit(EXIT_ALLOW);
  }

  const command = payload.tool_input?.command ?? '';
  if (!command) {
    process.exit(EXIT_ALLOW);
  }

  const result = evaluateCommand(command);
  if (result.blockExitCode !== EXIT_ALLOW) {
    // Use exit code 2 so Claude Code displays the reason
    process.stderr.write(
      `loom blocked this command: ${result.message.reason}\n` +
        `Rule: ${result.message.rule}\n` +
        `Command: ${result.message.command}\n`
    );
    process.exit(EXIT_BLOCK_WITH_FEEDBACK);
  }
  process.exit(EXIT_ALLOW);
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
    const db = openDatabase(loomDir);
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
