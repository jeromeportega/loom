import fs from 'node:fs';
import path from 'node:path';
import { ProjectRegistry, defaultMachineConfigPath } from '@loom-ai/core';

/**
 * Resolves which loom project a directory-independent command should bootstrap
 * from. Shared by `loom web` (which project to serve) and `loom retrieve`
 * (which project's policy + loom-home governs a cross-repo lookup).
 *
 * The whole point is that these commands are NOT tied to the CWD: an operator
 * can run them from anywhere and loom finds a project via the machine registry.
 */

/**
 * Reads `project_root` from the machine-level config JSON, if present.
 * Returns null when the file is absent, unreadable, or has no valid entry.
 */
export function readMachineConfigProjectRoot(configPath: string): string | null {
  if (!fs.existsSync(configPath)) return null;
  try {
    const parsed = JSON.parse(fs.readFileSync(configPath, 'utf8')) as Record<string, unknown>;
    const root = parsed.project_root;
    if (typeof root === 'string' && root.length > 0) return root;
    return null;
  } catch {
    return null;
  }
}

/**
 * Resolves which loom project root a directory-independent command should use.
 *
 * Resolution order (first match wins):
 *   1. Nearest ENCLOSING project — walk up from CWD to the filesystem root and
 *      use the first ancestor (CWD included) that has `.loom/policy.yaml`.
 *   2. ProjectRegistry has at least one still-initialized entry → use the first.
 *   3. Machine config has `project_root` pointing to an initialized repo → use it.
 *   4. Return null — the caller decides how to degrade (serve no-project, or exit).
 *
 * The ancestor walk (step 1) matters for correctness AND for the trust boundary:
 * a worker running inside a subdirectory — e.g. a worktree under
 * `<repo>/.loom/worktrees/<story>/` — resolves to its OWN repo's policy rather
 * than falling through to an arbitrary registry entry whose `cross_repo` policy
 * could be more permissive. "CWD is the project" is just the first iteration.
 *
 * Never throws; never calls process.exit. Returns null when no project resolves.
 * Optional parameters are for dependency injection in tests.
 */
export function resolveActiveProject(
  cwd: string,
  registry?: ProjectRegistry,
  machineConfigPath?: string
): { projectRoot: string; loomDir: string } | null {
  let dir = path.resolve(cwd);
  for (;;) {
    const loomDir = path.join(dir, '.loom');
    if (fs.existsSync(path.join(loomDir, 'policy.yaml'))) {
      return { projectRoot: dir, loomDir };
    }
    const parent = path.dirname(dir);
    if (parent === dir) break; // reached the filesystem root
    dir = parent;
  }

  const reg = registry ?? new ProjectRegistry();
  // Pick the first REGISTERED project that is still initialized. A registered
  // root whose `.loom/` was removed (or whose directory was recreated) would
  // otherwise be bootstrapped with a freshly-minted empty DB — a silently blank
  // result. Skip such entries and fall through to machine config / null.
  for (const project of reg.list()) {
    const projLoomDir = path.join(project.root, '.loom');
    if (fs.existsSync(path.join(projLoomDir, 'policy.yaml'))) {
      return { projectRoot: project.root, loomDir: projLoomDir };
    }
  }

  const cfgPath = machineConfigPath ?? defaultMachineConfigPath();
  const machineRoot = readMachineConfigProjectRoot(cfgPath);
  if (machineRoot) {
    const machineRootLoomDir = path.join(machineRoot, '.loom');
    if (fs.existsSync(path.join(machineRootLoomDir, 'policy.yaml'))) {
      return { projectRoot: machineRoot, loomDir: machineRootLoomDir };
    }
  }

  return null;
}
