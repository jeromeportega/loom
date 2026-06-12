import path from 'node:path';
import { PolicyEngine, preflightGateCommand } from '@loom-ai/core';

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
