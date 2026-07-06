import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { PolicyEngine, preflightGateCommand, resolveGatePlan } from '@loom-ai/core';

/**
 * The exact Check shape `doctor.ts` renders, with `required` pinned to the
 * literal `false`: the gate-command preflight is advisory by contract (NFR-2)
 * and must never be able to flip doctor's exit code.
 */
export interface GateCommandCheck {
  name: string;
  ok: boolean;
  detail: string;
  required: false;
}

/**
 * `loom doctor` check for the integration-gate command (ADR-4): resolves the
 * command the gate would run and reports whether it is viable in a bare
 * integration worktree. Self-contained — loads policy itself so the wiring
 * into doctor.ts stays a single `checks.push(...)` line.
 *
 * The injectable `preflight` parameter exists for tests only; production
 * callers pass `projectRoot` alone.
 */
export function gateCommandCheck(
  projectRoot: string,
  preflight: typeof preflightGateCommand = preflightGateCommand
): GateCommandCheck {
  const name = 'integration gate command';
  try {
    const policy = PolicyEngine.load(path.join(projectRoot, '.loom')).policyData;
    const result = preflight(projectRoot, { testCommand: policy.agents.test_command });
    const offSuffix =
      policy.agents.integration_gate === 'off' ? ' (integration_gate is off — informational)' : '';

    if (!result.viable) {
      const cmd = result.resolved.command ?? '(none)';
      return {
        name,
        ok: false,
        detail:
          `"${cmd}" (${result.resolved.source}) won't run in a bare integration worktree — ` +
          `set policy.agents.test_command, e.g. test_command: "${result.recommendation}"` +
          offSuffix,
        required: false,
      };
    }

    if (result.resolved.command === undefined) {
      return {
        name,
        ok: true,
        detail:
          'no test command detected — the gate runs its amputation check only; ' +
          'set policy.agents.test_command if this repo has a test suite' +
          offSuffix,
        required: false,
      };
    }

    return {
      name,
      ok: true,
      detail:
        `"${result.resolved.command}" (${result.resolved.source}) looks runnable ` +
        'in a bare integration worktree' +
        offSuffix,
      required: false,
    };
  } catch (err) {
    // Advisory check: an internal failure is reported, never propagated —
    // doctor must keep working even if the preflight itself breaks.
    return {
      name,
      ok: true,
      detail: `preflight skipped (${(err as Error).message})`,
      required: false,
    };
  }
}

// ── gate-runnable: real-execution check (FR-9, FR-10, FR-11) ─────────────────

/** Extract the lead binary name from a shell command (not an absolute/relative path). */
export function getLeadBinary(command: string): string | null {
  const parts = command.trim().split(/\s+/);
  for (const part of parts) {
    if (part.includes('=')) continue; // skip env var assignments like FOO=bar
    if (part.startsWith('/') || part.startsWith('./') || part.startsWith('../')) return null;
    return part;
  }
  return null;
}

/** Check whether a binary is resolvable under the given PATH string using /bin/sh. */
function binaryOnPath(binary: string, envPath: string): boolean {
  try {
    execFileSync('/bin/sh', ['-c', 'command -v "$1"', '--', binary], {
      // Use full process.env with the specified PATH so the probe reflects the same
      // environment that spawn({ shell: true }) sees (which inherits process.env).
      env: { ...process.env, PATH: envPath },
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    return true;
  } catch {
    return false;
  }
}

export interface GateRunnableDeps {
  resolve?: typeof resolveGatePlan;
  /**
   * Injectable binary-resolution probe (tests). Returns whether `binary`
   * resolves on the gate's PATH. Production uses `/bin/sh -c 'command -v'`.
   */
  binaryResolves?: (binary: string) => boolean;
}

/**
 * `loom doctor` gate-runnable check: resolves the gate plan and verifies each
 * step's lead binary actually resolves on the PATH the gate will inherit — the
 * gate runs `spawn(cmd, { shell: true })` with no explicit env, so it inherits
 * `process.env.PATH`. This catches the classic false-green where doctor said a
 * command "looks runnable" but the real gate failed with `command not found`
 * because the tool (e.g. `uv`) was not on the gate's PATH (FR-9/FR-10/FR-11).
 *
 * Fast and side-effect-free: it does NOT execute the suite (running a full
 * `next build`/`cargo build`/test suite in the operator's working tree on every
 * `loom doctor` would be a surprising, slow, artifact-writing regression). To
 * actually execute the gate for real — in a throwaway worktree — use
 * `loom doctor --dry-run-gate`. Advisory: `required` is always false.
 */
export async function gateRunnableCheck(
  projectRoot: string,
  deps?: GateRunnableDeps,
): Promise<GateCommandCheck> {
  const name = 'gate-runnable';

  try {
    let testCommand: string | undefined;
    try {
      const policy = PolicyEngine.load(path.join(projectRoot, '.loom')).policyData;
      testCommand = policy.agents.test_command;
    } catch {
      // No .loom directory or unreadable policy — proceed with no override.
    }

    const resolveGatePlanFn = deps?.resolve ?? resolveGatePlan;
    // The gate inherits process.env.PATH exactly (spawn with shell:true, no env),
    // so the meaningful check is "does each lead binary resolve on THAT PATH".
    const gatePath = process.env.PATH ?? '/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin';
    const binaryResolvesFn = deps?.binaryResolves ?? ((b: string) => binaryOnPath(b, gatePath));

    const plan = resolveGatePlanFn(projectRoot, { testCommand });

    if (plan.steps.length === 0) {
      return {
        name,
        ok: true,
        detail: 'no gate steps to run; gate runs amputation check only',
        required: false,
      };
    }

    // Verify each unique lead binary resolves on the PATH the gate will inherit.
    const missing: string[] = [];
    const seen = new Set<string>();
    for (const step of plan.steps) {
      const binary = getLeadBinary(step.command);
      if (!binary || seen.has(binary)) continue;
      seen.add(binary);
      if (!binaryResolvesFn(binary)) missing.push(binary);
    }

    if (missing.length > 0) {
      const bins = missing.map((b) => `"${b}"`).join(', ');
      return {
        name,
        ok: false,
        detail:
          `${bins} not found on the gate's PATH — the integration gate will fail with ` +
          `"command not found". Install the tool and add it to PATH, or set ` +
          `policy.agents.test_command to a fully-qualified command`,
        required: false,
      };
    }

    return {
      name,
      ok: true,
      detail:
        `${seen.size} gate step(s); every lead binary resolves on the gate's PATH ` +
        '(run `loom doctor --dry-run-gate` to execute the gate for real)',
      required: false,
    };
  } catch (err) {
    return {
      name,
      ok: false,
      detail: `check errored: ${(err as Error).message}`,
      required: false,
    };
  }
}
