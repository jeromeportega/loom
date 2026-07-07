import path from 'node:path';
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import jsYaml from 'js-yaml';
import { PolicyEngine, preflightGateCommand, resolveGatePlan } from '@loom-ai/core';

/** Matches TestCommandEntry from @loom-ai/core (story-078-001). */
interface TestCommandEntry {
  name: string;
  command: string;
  paths: string[];
}

/**
 * Read test_commands from the raw policy YAML, bypassing Zod validation so the
 * field is not stripped when the resolved @loom-ai/core dist predates story-078-001.
 */
function loadTestCommandsFromYaml(loomDir: string): TestCommandEntry[] {
  try {
    const raw = jsYaml.load(
      fs.readFileSync(path.join(loomDir, 'policy.yaml'), 'utf8')
    ) as Record<string, unknown> | null;
    const entries = (raw?.agents as Record<string, unknown> | undefined)?.test_commands;
    if (!Array.isArray(entries)) return [];
    return entries.filter(
      (e): e is TestCommandEntry =>
        e != null &&
        typeof e === 'object' &&
        typeof (e as { name?: unknown }).name === 'string' &&
        typeof (e as { command?: unknown }).command === 'string'
    );
  } catch {
    return [];
  }
}

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
    let testCommandEntries: TestCommandEntry[] = [];
    const loomDir = path.join(projectRoot, '.loom');
    try {
      const policy = PolicyEngine.load(loomDir).policyData;
      testCommand = policy.agents.test_command;
    } catch {
      // No .loom directory or unreadable policy — proceed with no override.
    }
    // loadTestCommandsFromYaml has its own error handling; always run it so
    // test_commands binaries are checked even when PolicyEngine.load() fails.
    testCommandEntries = loadTestCommandsFromYaml(loomDir);

    const resolveGatePlanFn = deps?.resolve ?? resolveGatePlan;
    // The gate inherits process.env.PATH exactly (spawn with shell:true, no env),
    // so the meaningful check is "does each lead binary resolve on THAT PATH".
    const gatePath = process.env.PATH ?? '/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin';
    const binaryResolvesFn = deps?.binaryResolves ?? ((b: string) => binaryOnPath(b, gatePath));

    // Pass testCommands so the resolved plan mirrors what the REAL gate will run:
    // when test_commands is configured, resolveGatePlan returns source
    // 'test_commands' with no auto-detected steps, so we don't flag auto-detected
    // binaries (tsc/next/…) the gate will never invoke. The test_commands entries'
    // own binaries are still verified by the dedicated loop below.
    const plan = resolveGatePlanFn(projectRoot, { testCommand, testCommands: testCommandEntries });

    if (plan.steps.length === 0 && testCommandEntries.length === 0) {
      return {
        name,
        ok: true,
        detail: 'no gate steps to run; gate runs amputation check only',
        required: false,
      };
    }

    // Verify each unique lead binary from auto-detected/configured steps resolves on PATH.
    const missing: string[] = [];
    const seen = new Set<string>();
    for (const step of plan.steps) {
      const binary = getLeadBinary(step.command);
      if (!binary || seen.has(binary)) continue;
      seen.add(binary);
      if (!binaryResolvesFn(binary)) missing.push(binary);
    }

    // Verify lead binary for each test_commands entry.
    // Re-use `seen` for cross-loop dedup: a binary already checked for gate steps
    // gives the same PATH result and does not need a separate TC entry report.
    const stepsCheckedCount = seen.size;
    const missingEntries: Array<{ entryName: string; binary: string }> = [];
    for (const entry of testCommandEntries) {
      const binary = getLeadBinary(entry.command);
      if (!binary || seen.has(binary)) continue;
      seen.add(binary);
      if (!binaryResolvesFn(binary)) {
        missingEntries.push({ entryName: entry.name, binary });
      }
    }

    if (missing.length > 0 || missingEntries.length > 0) {
      const parts: string[] = [];
      if (missing.length > 0) {
        const bins = missing.map((b) => `"${b}"`).join(', ');
        parts.push(
          `${bins} not found on the gate's PATH — the integration gate will fail with ` +
          `"command not found". Install the tool and add it to PATH, or set ` +
          `policy.agents.test_command to a fully-qualified command`
        );
      }
      for (const { entryName, binary } of missingEntries) {
        parts.push(`test_commands entry "${entryName}": "${binary}" not found on PATH`);
      }
      return {
        name,
        ok: false,
        detail: parts.join('\n'),
        required: false,
      };
    }

    return {
      name,
      ok: true,
      detail:
        `${stepsCheckedCount} gate step(s), ${testCommandEntries.length} test_commands entr${testCommandEntries.length === 1 ? 'y' : 'ies'} checked; every lead binary resolves on the gate's PATH ` +
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
