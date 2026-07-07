import type { CommandDescription } from '../describe/schema.js';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { ZodError } from 'zod';
import type { Command } from 'commander';
import {
  loadMachineConfig,
  defaultMachineConfigPath,
  loomHome,
  PolicyEngine,
  PolicyValidationError,
  describePolicyIssues,
  formatPolicyError,
  validateCursorModels,
  resolveSmokeCommand,
} from '@loom-ai/core';
import type { Policy } from '@loom-ai/core';
import { gateCommandCheck, gateRunnableCheck, getLeadBinary } from './doctorGateCheck.js';
import { reportPolicyDrift } from './init.js';
import { checkCapabilitiesCoverage } from '../describe/coverage-check.js';

interface Check {
  name: string;
  ok: boolean;
  detail: string;
  required: boolean;
}

/**
 * `loom doctor` check for `policy.agents.cursor_model` (epic-007 FR-1/FR-2).
 * Returns `undefined` when no cursor-cli backend is configured (nothing to
 * validate), otherwise renders the shared {@link validateCursorModels} result
 * into a Check with NO per-site special-casing:
 *
 *   - `invalid`              → FAIL (required:true) so doctor exits non-zero.
 *   - `unavailable` | alias  → warn (required:false) carrying the message;
 *     the boundary-prefix alias advisory (`m.advisory`) folds into the same
 *     warn branch as a degraded probe — both stay exit 0.
 *   - exact `ok`             → pass, silent (the "valid Cursor model" detail).
 *
 * Loads policy itself so the wiring into {@link runDoctor} stays a single
 * `checks.push(...)`. The injectable `cursorBin` parameter exists for tests
 * only (point the probe at a stub `cursor-agent --list-models`); production
 * callers pass `projectRoot` alone and the real CLI is used.
 */
export function cursorModelCheck(
  projectRoot: string,
  cursorBin?: string
): Check | undefined {
  const policy = PolicyEngine.load(path.join(projectRoot, '.loom')).policyData;
  const m = validateCursorModels(policy, cursorBin);
  if (!m) return undefined;
  const invalid = m.status === 'invalid';
  const warn = m.status === 'unavailable' || m.advisory === true;
  return {
    name: 'cursor_model',
    ok: !invalid && !warn,
    detail:
      invalid || warn
        ? m.message
        : `"${policy.agents.cursor_model}" is a valid Cursor model`,
    required: invalid,
  };
}

// Validates .loom/policy.yaml; required:true so doctor's existing exit fires on failure.
export function policyValidationCheck(projectRoot: string): Check {
  try {
    PolicyEngine.load(path.join(projectRoot, '.loom'));
    return { name: 'policy', ok: true, required: true, detail: 'policy.yaml is valid' };
  } catch (e) {
    if (e instanceof PolicyValidationError) {
      return {
        name: 'policy',
        ok: false,
        required: true,
        detail: formatPolicyError(e.policyPath, e.issues),
      };
    }
    if (e instanceof ZodError) {
      // PolicyEngine throws raw ZodError until story-011-002 lands; remove this branch after.
      const policyPath = path.join(projectRoot, '.loom', 'policy.yaml');
      const issues = describePolicyIssues(e);
      return {
        name: 'policy',
        ok: false,
        required: true,
        detail: formatPolicyError(policyPath, issues),
      };
    }
    throw e;
  }
}

/**
 * `loom doctor --capabilities` — best-effort drift check for docs/capabilities.md.
 * Delegates entirely to checkCapabilitiesCoverage and emits the result as a single
 * doctor check. Best-effort: required is always false; the FR-5 test suite is the
 * binding requirement (ADR-2).
 */
export function runCapabilitiesMode(opts?: { program?: Command; root?: string }): void {
  console.log('\n  loom doctor --capabilities\n');
  try {
    const report = checkCapabilitiesCoverage(opts);
    const mark = report.ok ? 'ok  ' : 'warn';
    console.log(
      `  [${mark}] capabilities coverage: ${report.ok ? 'all operator commands and knobs are documented' : 'drift detected'}`
    );
    for (const msg of report.messages) {
      console.log(`         ${msg}`);
    }
    console.log('');
    if (report.ok) {
      console.log('  Capabilities page is current.\n');
    } else {
      console.log('  Capabilities page may be out of date — update docs/capabilities.md.\n');
    }
  } catch (err) {
    console.log(`  [warn] capabilities coverage: check skipped (${(err as Error).message})`);
    console.log('');
  }
}

/** Check whether `bin` resolves under the current process PATH using /bin/sh. */
function isOnPath(bin: string): boolean {
  try {
    execFileSync('/bin/sh', ['-c', 'command -v "$1"', '--', bin], {
      env: { ...process.env, PATH: process.env.PATH ?? '/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin' },
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    return true;
  } catch {
    return false;
  }
}

export interface SmokeDoctorDeps {
  resolveFn?: (root: string, policy: Policy) => Promise<string | null>;
  isOnPathFn?: (bin: string) => boolean;
}

/**
 * `loom doctor` smoke-command check: resolves the effective smoke command and
 * reports whether the lead binary is on PATH. Advisory (required: false) — a
 * missing smoke binary is a warn, never a hard doctor failure.
 */
export async function smokeDoctorCheck(
  projectRoot: string,
  deps?: SmokeDoctorDeps,
): Promise<Check> {
  const name = 'smoke-command';
  try {
    let policy: Policy;
    try {
      policy = PolicyEngine.load(path.join(projectRoot, '.loom')).policyData;
    } catch {
      policy = PolicyEngine.defaultPolicy();
    }

    const resolveFn = deps?.resolveFn ?? resolveSmokeCommand;
    const isOnPathFn = deps?.isOnPathFn ?? isOnPath;

    const cmd = await resolveFn(projectRoot, policy);
    if (cmd === null) {
      return { name, ok: true, detail: 'none resolved', required: false };
    }

    const bin = getLeadBinary(cmd);
    if (bin === null) {
      // Absolute or relative path — check existence rather than PATH lookup.
      const firstToken = cmd.trim().split(/\s+/)[0];
      const found = fs.existsSync(firstToken);
      return {
        name,
        ok: found,
        detail: found
          ? `${cmd} — found at path`
          : `${cmd} — NOT found at path`,
        required: false,
      };
    }

    const found = isOnPathFn(bin);
    return {
      name,
      ok: found,
      detail: found
        ? `${cmd} — binary '${bin}' found on PATH`
        : `${cmd} — binary '${bin}' NOT found on PATH`,
      required: false,
    };
  } catch (err) {
    return { name, ok: true, detail: `check skipped (${(err as Error).message})`, required: false };
  }
}

/** Returns the first line of `<bin> <args>` output, or null if the binary is absent. */
function probe(bin: string, args: string[]): string | null {
  try {
    return execFileSync(bin, args, {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    })
      .trim()
      .split('\n')[0];
  } catch {
    return null;
  }
}

/**
 * `loom doctor` — checks the light prerequisites for running loom and reports
 * exactly what is missing. Exits non-zero if a required prerequisite is absent.
 */
export async function runDoctor(): Promise<void> {
  const checks: Check[] = [];

  const nodeMajor = parseInt(process.versions.node.split('.')[0], 10);
  checks.push({
    name: 'Node.js >= 20',
    ok: nodeMajor >= 20,
    detail: nodeMajor >= 20 ? `v${process.versions.node}` : `v${process.versions.node} — upgrade to Node 20+`,
    required: true,
  });

  const git = probe('git', ['--version']);
  checks.push({
    name: 'git',
    ok: git !== null,
    detail: git ?? 'not found — install git (2.5+ for worktrees)',
    required: true,
  });

  const claude = probe('claude', ['--version']);
  checks.push({
    name: 'claude CLI',
    ok: claude !== null,
    detail: claude ?? 'not found — needed for session-based planning and workers; install Claude Code',
    required: false,
  });

  const gh = probe('gh', ['--version']);
  checks.push({
    name: 'gh CLI',
    ok: gh !== null,
    detail: gh ?? 'not found — needed for workers to open PRs; install the GitHub CLI',
    required: false,
  });

  const cursor = probe('cursor-agent', ['--version']);
  checks.push({
    name: 'cursor-agent CLI',
    ok: cursor !== null,
    detail: cursor ?? 'not found — needed only for the cursor-cli backend; install Cursor',
    required: false,
  });

  checks.push(gateCommandCheck(process.cwd()));
  checks.push(await gateRunnableCheck(process.cwd()));
  checks.push(await smokeDoctorCheck(process.cwd()));

  const loomDir = path.join(process.cwd(), '.loom');
  const initialized = fs.existsSync(path.join(loomDir, 'policy.yaml'));

  // Validate cursor_model against `cursor-agent --list-models` when a cursor-cli
  // backend is configured. FAILs doctor only on a confirmed-invalid model;
  // degrades to a warn when the probe can't run (offline/unauthenticated) OR
  // when the configured id is a boundary-prefix alias (FR-1(b)) — both stay
  // exit 0. See {@link cursorModelCheck} for the render.
  if (initialized) {
    try {
      checks.push(policyValidationCheck(process.cwd()));
    } catch (e) {
      checks.push({ name: 'policy', ok: false, required: true, detail: e instanceof Error ? e.message : String(e) });
    }

    try {
      const check = cursorModelCheck(process.cwd());
      if (check) checks.push(check);
    } catch {
      /* policy parse errors are surfaced by `loom init` / run, not here */
    }
  }

  console.log('\n  loom doctor\n');
  for (const c of checks) {
    const mark = c.ok ? 'ok  ' : c.required ? 'FAIL' : 'warn';
    console.log(`  [${mark}] ${c.name}: ${c.detail}`);
  }
  console.log(
    `  [${initialized ? 'ok  ' : 'warn'}] loom: ` +
      (initialized ? 'initialized in this directory' : 'not initialized — run `loom init`')
  );

  // Machine-level config — the global worker cap is set per machine here.
  const machineConfig = loadMachineConfig();
  const cap = machineConfig.maxGlobalWorkers;
  console.log(
    `  [ok  ] machine config (${defaultMachineConfigPath()}): ` +
      (cap
        ? `global worker cap = ${cap}`
        : 'no global worker cap set (each run bounded only by its own max_concurrent)')
  );
  if (process.env.LOOM_HOME) {
    console.log(`  [ok  ] LOOM_HOME override active: ${loomHome()}`);
  }

  // Surface policy knobs added since this repo's policy.yaml was written (same
  // notice `loom init` prints, since a user may re-run either after an upgrade).
  if (initialized) reportPolicyDrift(loomDir);

  console.log('');

  if (checks.some((c) => c.required && !c.ok)) {
    console.log('  A required prerequisite is missing. Install it, then re-run `loom doctor`.\n');
    process.exit(1);
  }
  if (checks.some((c) => !c.required && !c.ok)) {
    console.log('  Ready for `loom init`. Install the warned tools before a real `loom run`.\n');
  } else {
    console.log('  All checks passed — you are ready to go.\n');
  }
}

export const spec: CommandDescription = {
  name: 'doctor',
  summary: 'Check prerequisites and report what is missing',
  whenToUse: 'Run after installing loom to verify Node, git, claude CLI, and gh are present and correctly configured. Use --dry-run-gate or --cross-epic-gate for deeper validation. Use --capabilities to check whether docs/capabilities.md is current.',
  arguments: [],
  options: [
    { name: '--dry-run-gate', type: 'boolean', description: 'Execute the integration gate once in a throwaway worktree and report the outcome', changesOutputShape: false },
    { name: '--cross-epic-gate', type: 'boolean', description: 'Merge every open epic branch into a throwaway union worktree and run the suite once', changesOutputShape: false },
    { name: '--epics', type: 'string', description: 'Comma-separated epic ids to restrict --cross-epic-gate to (default: every epic/* branch)', changesOutputShape: false },
    { name: '--capabilities', type: 'boolean', description: 'Check whether docs/capabilities.md covers all live CLI commands and policy knobs', changesOutputShape: false },
  ],
  output: { text: 'Checklist of prerequisites with pass/fail/warn status' },
  examples: [
    { command: 'loom doctor', description: 'Check all prerequisites' },
    { command: 'loom doctor --dry-run-gate', description: 'Also run the integration gate in a throwaway worktree' },
    { command: 'loom doctor --cross-epic-gate --epics epic-001,epic-002', description: 'Check for cross-epic merge conflicts' },
    { command: 'loom doctor --capabilities', description: 'Check whether docs/capabilities.md covers the live CLI surface' },
  ],
  exitCodes: [
    { code: 0, meaning: 'All checks passed or warnings only' },
    { code: 1, meaning: 'One or more required checks failed' },
  ],
  errors: ['Required tool not found — install it before running `loom run`'],
  relationships: { prerequisites: [], nextSteps: ['init', 'run'] },
};
