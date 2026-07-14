import { preflightGateCommand, INTEGRATION_GATE } from '@loom-ai/core';
import type { Policy } from '@loom-ai/core';

/**
 * Loud advisory warning emitted at plan time (`loom epic`) and run start
 * (`loom run`) when the integration gate will run a command that cannot work
 * in a bare integration worktree. Purely advisory by contract (NFR-2): this
 * function returns void, never calls process.exit, and swallows any internal
 * failure — preflight must never gain the power to stop a run.
 *
 * Message formatting is intentionally duplicated with doctorGateCheck (ADR-3):
 * the doctor line wants one-line terseness, this block wants loudness.
 *
 * The injectable `preflight` parameter exists for tests only.
 */
export function maybeWarnGatePreflight(
  projectRoot: string,
  policy: Policy,
  preflight: typeof preflightGateCommand = preflightGateCommand
): void {
  try {
    const result = preflight(projectRoot, { testCommand: policy.agents.test_command });
    if (result.viable) return;

    const cmd = result.resolved.command ?? '(none)';
    const lines = [
      '',
      '  ┌──────────────────────────────────────────────────────────────────┐',
      '  │ WARNING: integration gate command will fail                      │',
      '  └──────────────────────────────────────────────────────────────────┘',
      `  The gate (integration_gate: "${INTEGRATION_GATE}") would run:`,
      `      ${cmd}  [${result.resolved.source}]`,
      '  but it cannot work in a bare integration worktree:',
      ...result.reasons.map((r) => `    • ${r}`),
      '',
      '  Fix: set in .loom/policy.yaml under agents:',
      `      test_command: "${result.recommendation}"`,
      '',
      '  This warning is advisory only — the run proceeds regardless.',
      '',
    ];
    console.warn(lines.join('\n'));
  } catch {
    // Advisory only (NFR-2): an internal preflight failure must never
    // surface as an exception — silence is the correct degradation.
  }
}
