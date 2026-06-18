import type { CommandDescription } from '../describe/schema.js';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { ZodError } from 'zod';
import {
  loadMachineConfig,
  defaultMachineConfigPath,
  loomHome,
  PolicyEngine,
  PolicyValidationError,
  describePolicyIssues,
  formatPolicyError,
  validateCursorModels,
} from '@loom-ai/core';
import { gateCommandCheck } from './doctorGateCheck.js';
import { reportPolicyDrift } from './init.js';

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
export function runDoctor(): void {
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
  whenToUse: 'Run after installing loom to verify Node, git, claude CLI, and gh are present and correctly configured. Use --dry-run-gate or --cross-epic-gate for deeper validation.',
  arguments: [],
  options: [
    { name: '--dry-run-gate', type: 'boolean', description: 'Execute the integration gate once in a throwaway worktree and report the outcome', changesOutputShape: false },
    { name: '--cross-epic-gate', type: 'boolean', description: 'Merge every open epic branch into a throwaway union worktree and run the suite once', changesOutputShape: false },
    { name: '--epics', type: 'string', description: 'Comma-separated epic ids to restrict --cross-epic-gate to (default: every epic/* branch)', changesOutputShape: false },
  ],
  output: { text: 'Checklist of prerequisites with pass/fail/warn status' },
  examples: [
    { command: 'loom doctor', description: 'Check all prerequisites' },
    { command: 'loom doctor --dry-run-gate', description: 'Also run the integration gate in a throwaway worktree' },
    { command: 'loom doctor --cross-epic-gate --epics epic-001,epic-002', description: 'Check for cross-epic merge conflicts' },
  ],
  exitCodes: [
    { code: 0, meaning: 'All checks passed or warnings only' },
    { code: 1, meaning: 'One or more required checks failed' },
  ],
  errors: ['Required tool not found — install it before running `loom run`'],
  relationships: { prerequisites: [], nextSteps: ['init', 'run'] },
};
