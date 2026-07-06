import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

/**
 * Gate-command preflight (ADR-2): resolves the exact command the
 * IntegrationGate would run — configured `policy.agents.test_command` or
 * auto-detected — and checks it against bare-worktree structural
 * prerequisites (lockfile for `npm test`, a `test:` target for `make test`,
 * a pytest config for `pytest`).
 *
 * This module owns the gate's command-detection logic; IntegrationGate
 * delegates to `resolveGateCommand()` so resolution is identical by
 * construction. The preflight result is advisory data only — it never
 * blocks, never throws on non-viable, and never calls `process.exit`.
 *
 * Trade-off: viability is structural-only. A command reported viable can
 * still fail at runtime (missing env, flaky suite); a command reported
 * non-viable is one that cannot work in a bare worktree as configured.
 */

// ── Core plan & outcome types (shared contract — stories 002/003 import these) ──

export type GateStepKind = 'unit' | 'typecheck' | 'build';

export interface GateStep {
  /** Canonical id — e.g. 'unit' | 'typecheck:tsc' | 'build:next' */
  name: string;
  kind: GateStepKind;
  /** Exact shell string, binary already resolved. */
  command: string;
  /** unit → changed-subdir scope; toolchain → ResolvedGatePlan.cwd */
  cwd: string;
}

export interface ResolvedGatePlan {
  /** Ordered steps; see composition-order contract (§5). */
  steps: GateStep[];
  source: 'configured' | 'auto-detected' | 'none';
  /** Detected project root. */
  cwd: string;
}

// ── Legacy single-command interface (retained for out-of-epic callers) ──

export interface ResolvedGateCommand {
  /** undefined => no command resolvable (amputation-only gate). */
  command?: string;
  /** projectRoot, or the monorepo-scoped subdirectory the command runs in. */
  cwd: string;
  source: 'configured' | 'auto-detected' | 'none';
}

export interface GatePreflightResult {
  resolved: ResolvedGateCommand;
  viable: boolean;
  /** Empty when viable. */
  reasons: string[];
  /**
   * Exact `policy.agents.test_command` value to set; ALWAYS present when
   * `!viable`, e.g. "npm ci && npm test".
   */
  recommendation?: string;
}

/** Injectable probes mirroring IntegrationGateOptions, so tests need no disk. */
export interface GatePreflightOptions {
  testCommand?: string;
  fileExists?: (p: string) => boolean;
  fileReader?: (p: string) => string | null;
}

interface Probes {
  exists: (p: string) => boolean;
  read: (p: string) => string | null;
}

function probesFrom(opts: GatePreflightOptions): Probes {
  return {
    exists: opts.fileExists ?? ((p) => fs.existsSync(p)),
    read:
      opts.fileReader ??
      ((p) => {
        try {
          return fs.readFileSync(p, 'utf8');
        } catch {
          return null;
        }
      }),
  };
}

// ── SIGNAL TABLES — stories 002/003 append new const arrays in this region ──

const NPM_LOCKFILES = ['package-lock.json', 'npm-shrinkwrap.json'];
const PYTEST_CONFIG_FILES = ['pyproject.toml', 'setup.cfg', 'tox.ini'];

// ── END SIGNAL TABLES ──

/**
 * Resolve the gate plan: ordered steps the integration gate would run.
 *
 * Composition order (§5):
 *   - opts.testCommand set → source:'configured', steps=[unit(testCommand)], detection NEVER runs.
 *   - no signals → source:'none', steps=[].
 *   - auto-detect → source:'auto-detected', steps=[ unit ] ++ toolchain steps (002/003).
 */
export function resolveGatePlan(projectRoot: string, opts: GatePreflightOptions): ResolvedGatePlan {
  const explicit = opts.testCommand?.trim();

  // Hard override branch (FR-12/NFR-3): configured test_command suppresses ALL detection.
  // This is a top-of-function short-circuit — no probes, no detection calls below.
  if (explicit) {
    return {
      steps: [{ name: 'unit', kind: 'unit', command: explicit, cwd: projectRoot }],
      source: 'configured',
      cwd: projectRoot,
    };
  }

  const probes = probesFrom(opts);
  const detected = detectUnitCommand(projectRoot, probes);

  if (!detected) {
    return { steps: [], source: 'none', cwd: projectRoot };
  }

  const unitStep: GateStep = {
    name: 'unit',
    kind: 'unit',
    command: detected.command,
    cwd: detected.cwd,
  };

  // ── TOOLCHAIN DETECTORS — stories 002/003 append new detector branches in this region ──
  const toolchainSteps = detectToolchainSteps(projectRoot, detected.cwd, probes);
  // ── END TOOLCHAIN DETECTORS ──

  return {
    steps: [unitStep, ...toolchainSteps],
    source: 'auto-detected',
    cwd: detected.cwd,
  };
}

// ── TOOLCHAIN DETECTORS (stories 002/003 replace this stub) ──

/**
 * Detect toolchain steps (typecheck, build) to append after the unit step.
 * Stories 002 and 003 extend this region — do not modify the unit step or
 * override branch above.
 */
function detectToolchainSteps(
  _projectRoot: string,
  _cwd: string,
  _probes: Probes
): GateStep[] {
  // Story 002 appends: typecheck:tsc, build:next, build:go, build:cargo detectors.
  // Story 003 appends: uv unit-step variant rewrite.
  return [];
}

// ── END TOOLCHAIN DETECTORS ──

/**
 * Thin adapter for out-of-epic callers (e.g. gatePreflightWarning). Returns
 * only the unit step so existing callers keep compiling without modification.
 * New code should call resolveGatePlan() directly.
 */
export function resolveGateCommand(
  projectRoot: string,
  opts: GatePreflightOptions
): ResolvedGateCommand {
  const plan = resolveGatePlan(projectRoot, opts);
  const unitStep = plan.steps.find((s) => s.kind === 'unit');
  return {
    command: unitStep?.command,
    cwd: plan.cwd,
    source: plan.source,
  };
}

/**
 * Check the resolved gate command against bare-worktree structural
 * prerequisites. Pure data: non-viable is a state, not an error.
 */
export function preflightGateCommand(
  projectRoot: string,
  opts: GatePreflightOptions
): GatePreflightResult {
  const resolved = resolveGateCommand(projectRoot, opts);
  const probes = probesFrom(opts);

  if (resolved.source === 'none') {
    // Informational only: the gate degrades gracefully to the (free)
    // amputation check, so nothing is structurally broken.
    return {
      resolved,
      viable: true,
      reasons: [],
      recommendation:
        'If this repository has a test suite, set policy.agents.test_command so the ' +
        'integration gate can run it, e.g. test_command: "npm ci && npm test".',
    };
  }

  const command = resolved.command as string;
  const cwd = resolved.cwd;

  // Viability table. Configured commands are checked only when they begin
  // with a detectable form; anything else is the operator's word — viable.
  if (/^npm test(\s|$)/.test(command)) {
    if (NPM_LOCKFILES.some((f) => probes.exists(path.join(cwd, f)))) {
      return { resolved, viable: true, reasons: [] };
    }
    return {
      resolved,
      viable: false,
      reasons: [
        `No package-lock.json or npm-shrinkwrap.json at ${cwd} — a bare integration ` +
          `worktree has no node_modules, so \`${command}\` will fail before any test runs.`,
        'Set policy.agents.test_command, e.g. test_command: "npm ci && npm test".',
      ],
      recommendation: 'npm ci && npm test',
    };
  }

  if (/^make test(\s|$)/.test(command)) {
    const makePath = path.join(cwd, 'Makefile');
    const raw = probes.exists(makePath) ? probes.read(makePath) : null;
    if (raw !== null && /^test:/m.test(raw)) {
      return { resolved, viable: true, reasons: [] };
    }
    return {
      resolved,
      viable: false,
      reasons: [
        raw !== null
          ? `Makefile at ${cwd} has no \`test:\` target, so \`${command}\` will fail.`
          : `No readable Makefile at ${cwd}, so \`${command}\` cannot run.`,
        'Set policy.agents.test_command to the command that runs this repo\'s tests, ' +
          'e.g. test_command: "make <your-test-target>".',
      ],
      recommendation: 'make <your-test-target>',
    };
  }

  if (/^pytest(\s|$)/.test(command)) {
    if (hasPytestConfig(cwd, probes)) {
      return { resolved, viable: true, reasons: [] };
    }
    return {
      resolved,
      viable: false,
      reasons: [
        `No pytest configuration (pytest.ini, or pytest referenced in pyproject.toml / ` +
          `setup.cfg / tox.ini) at ${cwd}, so \`${command}\` is not anchored to this repo.`,
        'Set policy.agents.test_command to the command that runs this repo\'s tests, ' +
          'e.g. test_command: "pytest <path-to-tests>".',
      ],
      recommendation: 'pytest <path-to-tests>',
    };
  }

  return { resolved, viable: true, reasons: [] };
}

function hasPytestConfig(cwd: string, probes: Probes): boolean {
  if (probes.exists(path.join(cwd, 'pytest.ini'))) return true;
  for (const f of PYTEST_CONFIG_FILES) {
    const p = path.join(cwd, f);
    if (probes.exists(p)) {
      const raw = probes.read(p);
      if (raw && /pytest/i.test(raw)) return true;
    }
  }
  return false;
}

/**
 * Best-effort unit test-command discovery. Conservative on purpose: an
 * undetectable suite yields no command (amputation-only) rather than a wrong
 * command that fails falsely.
 *
 * Monorepo scoping: walk the changed files relative to the integration tree
 * and find the smallest enclosing directory that has its own test config —
 * that's where the suite should run.
 */
function detectUnitCommand(
  projectRoot: string,
  probes: Probes
): { command: string; cwd: string } | undefined {
  const detectAt = (dir: string): string | undefined => {
    // 1) Node: package.json with a real (non-placeholder) test script.
    const pkgPath = path.join(dir, 'package.json');
    if (probes.exists(pkgPath)) {
      const raw = probes.read(pkgPath);
      if (raw) {
        try {
          const pkg = JSON.parse(raw) as { scripts?: Record<string, string> };
          const test = pkg.scripts?.test;
          if (typeof test === 'string' && test.trim() && !/no test specified/i.test(test)) {
            return 'npm test';
          }
        } catch {
          // Unparseable — fall through.
        }
      }
    }
    // 2) Make: a Makefile with a `test:` target.
    const makePath = path.join(dir, 'Makefile');
    if (probes.exists(makePath)) {
      const raw = probes.read(makePath);
      if (raw && /^test:/m.test(raw)) return 'make test';
    }
    // 3) Python: an explicit pytest config, or pytest referenced in config.
    if (probes.exists(path.join(dir, 'pytest.ini'))) return 'pytest';
    for (const f of PYTEST_CONFIG_FILES) {
      const p = path.join(dir, f);
      if (probes.exists(p)) {
        const raw = probes.read(p);
        if (raw && /pytest/i.test(raw)) return 'pytest';
      }
    }
    return undefined;
  };

  // Try to scope to the smallest enclosing changed-files directory that
  // has its own test config. Falls back to projectRoot on any error
  // (non-git tree, no merge base resolvable, etc.).
  const scoped = findScopedTestDir(projectRoot, detectAt);
  if (scoped) return scoped;

  // Repo-root fallback — if this still picks up a too-broad command, the
  // operator should set policy.agents.test_command explicitly.
  const root = detectAt(projectRoot);
  return root ? { command: root, cwd: projectRoot } : undefined;
}

/**
 * Walk the changed-files set to find the smallest enclosing directory with
 * its own test config. Returns undefined when not in a git tree, when no
 * scope can be established, or when the scope is just projectRoot anyway.
 */
function findScopedTestDir(
  projectRoot: string,
  detectAt: (dir: string) => string | undefined
): { command: string; cwd: string } | undefined {
  let changed: string[];
  try {
    const headRange = resolveDiffRange(projectRoot);
    if (!headRange) return undefined;
    const out = execFileSync(
      'git',
      ['diff', '--name-only', headRange],
      { cwd: projectRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }
    );
    changed = out.trim().split('\n').filter(Boolean);
  } catch {
    return undefined;
  }
  if (changed.length === 0) return undefined;

  // Find the deepest common ancestor of every changed file. Walk upward
  // from there, returning the first dir that has its own test config.
  let common = path.dirname(changed[0]);
  for (let i = 1; i < changed.length; i++) {
    common = commonAncestor(common, path.dirname(changed[i]));
    if (common === '.' || common === '') break;
  }
  let cur = common;
  while (cur && cur !== '.' && cur !== path.sep) {
    const abs = path.join(projectRoot, cur);
    const cmd = detectAt(abs);
    if (cmd) return { command: cmd, cwd: abs };
    const parent = path.dirname(cur);
    if (parent === cur) break;
    cur = parent;
  }
  return undefined;
}

/** Resolves a `<base>..HEAD` range for `git diff` against main/master. */
function resolveDiffRange(projectRoot: string): string | undefined {
  for (const base of ['origin/main', 'origin/master', 'main', 'master']) {
    try {
      execFileSync('git', ['rev-parse', '--verify', base], {
        cwd: projectRoot,
        stdio: ['ignore', 'pipe', 'ignore'],
      });
      return `${base}...HEAD`;
    } catch {
      // try next
    }
  }
  return undefined;
}

/** Longest path prefix common to two POSIX-style directories. */
function commonAncestor(a: string, b: string): string {
  const sa = a.split(path.sep);
  const sb = b.split(path.sep);
  const out: string[] = [];
  for (let i = 0; i < Math.min(sa.length, sb.length); i++) {
    if (sa[i] !== sb[i]) break;
    out.push(sa[i]);
  }
  return out.join(path.sep) || '.';
}
