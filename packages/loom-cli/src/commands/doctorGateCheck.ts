import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { PolicyEngine, preflightGateCommand, resolveGatePlan, runGateSteps } from '@loom-ai/core';
import type { GateStep } from '@loom-ai/core';

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
function getLeadBinary(command: string): string | null {
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
      env: { PATH: envPath, HOME: process.env.HOME ?? os.homedir() },
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * Get the PATH that /bin/sh sees in a non-interactive (non-login) invocation —
 * the same shell environment the gate runner uses via spawn(cmd, { shell: true }).
 */
function getShNonInteractivePath(): string {
  try {
    return execFileSync('/bin/sh', ['-c', 'echo $PATH'], {
      env: { HOME: process.env.HOME ?? os.homedir() },
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return '/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin';
  }
}

export interface PathDivergenceProbe {
  binary: string;
  onLogin: boolean;
  onSh: boolean;
}

function defaultProbePathDivergence(steps: GateStep[]): PathDivergenceProbe[] {
  const loginPath = process.env.PATH ?? '';
  const shPath = getShNonInteractivePath();
  const results: PathDivergenceProbe[] = [];
  for (const step of steps) {
    const binary = getLeadBinary(step.command);
    if (!binary) continue;
    results.push({
      binary,
      onLogin: binaryOnPath(binary, loginPath),
      onSh: binaryOnPath(binary, shPath),
    });
  }
  return results;
}

export interface GateRunnableDeps {
  resolve?: typeof resolveGatePlan;
  run?: typeof runGateSteps;
  /**
   * Injectable for PATH-divergence tests. Returns per-step binary probe results.
   * Production implementation uses execFileSync; test stubs return controlled data.
   */
  probePathDivergence?: (steps: GateStep[]) => PathDivergenceProbe[];
}

/**
 * `loom doctor` gate-runnable check: executes the resolved gate plan through
 * the same executor the real integration gate uses (/bin/sh via shell:true)
 * and reports whether it passes. Advisory — required is always false.
 *
 * FR-11: when a step's lead binary is on the login-shell PATH but not on the
 * gate's non-interactive /bin/sh PATH, returns ok:false with an explicit warning.
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
    const runGateStepsFn = deps?.run ?? runGateSteps;
    const probePathDivergenceFn = deps?.probePathDivergence ?? defaultProbePathDivergence;

    const plan = resolveGatePlanFn(projectRoot, { testCommand });

    if (plan.steps.length === 0) {
      return {
        name,
        ok: true,
        detail: 'no gate steps to run; gate runs amputation check only',
        required: false,
      };
    }

    // FR-11: PATH-divergence probe — warn if a lead binary is available on the
    // login-shell PATH but not on the gate's non-interactive /bin/sh PATH.
    const probes = probePathDivergenceFn(plan.steps);
    const diverged = probes.filter((p) => p.onLogin && !p.onSh);

    if (diverged.length > 0) {
      const binaries = diverged.map((p) => `"${p.binary}"`).join(', ');
      return {
        name,
        ok: false,
        detail:
          `PATH divergence: ${binaries} resolve on your login PATH but not on the gate's ` +
          `non-interactive /bin/sh PATH — add them to /etc/paths or /etc/profile, ` +
          `or set policy.agents.test_command to a fully-qualified command`,
        required: false,
      };
    }

    // FR-9/NFR-2: execute through the same runner the real gate uses.
    const stepOutcomes = await runGateStepsFn(plan.steps, {});
    const allPassed = stepOutcomes.every((s) => s.ok);

    if (allPassed) {
      const totalMs = stepOutcomes.reduce((sum, s) => sum + s.durationMs, 0);
      return {
        name,
        ok: true,
        detail: `gate ran and passed (${stepOutcomes.length} step(s) in ${Math.round(totalMs / 1000)}s)`,
        required: false,
      };
    }

    const failed = stepOutcomes.filter((s) => !s.ok);
    return {
      name,
      ok: false,
      detail: `gate failed: ${failed
        .map((s) => (s.timedOut ? `${s.name} (timed out)` : `${s.name} (exit ${s.exitCode})`))
        .join(', ')}`,
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
