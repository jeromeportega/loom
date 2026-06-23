import path from 'node:path';

/**
 * Resolves where loom writes planning artifacts for a single run.
 * `planningRoot` is the pre-resolved absolute planning directory
 * (e.g. `<namespaceDir>/planning`); each run gets its own `<runId>/`
 * subdirectory so repeated `loom epic` invocations never overwrite each other.
 */
export function planningPaths(planningRoot: string, runId: string) {
  const runDir = path.join(planningRoot, runId);
  const epicsDir = path.join(runDir, 'epics');
  return {
    runDir,
    epicsDir,
    brief: path.join(runDir, 'project-brief.md'),
    prd: path.join(runDir, 'prd.md'),
    architecture: path.join(runDir, 'architecture.md'),
    epicFile: (epicId: string) => path.join(epicsDir, `${epicId}.yaml`),
  };
}

/**
 * Project-root-relative path strings, for storing in the DB and JSON output.
 *
 * When `planningRoot` and `projectRoot` are both provided, paths are computed
 * relative to `projectRoot` so that `path.join(projectRoot, relPath)` resolves
 * to the actual file regardless of whether planningRoot is inside or outside
 * the project directory (e.g. in loom-home). Without both optional params,
 * falls back to the legacy `.loom/planning/<runId>/…` prefix.
 */
export function planningRelPaths(
  runId: string,
  planningRoot?: string,
  projectRoot?: string,
) {
  let base: string;
  if (planningRoot !== undefined && projectRoot !== undefined) {
    base = path.relative(projectRoot, path.join(planningRoot, runId));
  } else {
    base = `.loom/planning/${runId}`;
  }
  return {
    brief: path.join(base, 'project-brief.md'),
    prd: path.join(base, 'prd.md'),
    architecture: path.join(base, 'architecture.md'),
    epicFile: (epicId: string) => path.join(base, 'epics', `${epicId}.yaml`),
  };
}

/** Formats an epic number as a zero-padded id, e.g. 3 -> "epic-003". */
export function epicId(num: number): string {
  return `epic-${String(num).padStart(3, '0')}`;
}

/** Parses an epic id back to its number, e.g. "epic-003" -> 3. Returns 0 if unparseable. */
export function epicNumber(id: string): number {
  const m = id.match(/^epic-(\d+)$/);
  return m ? parseInt(m[1], 10) : 0;
}
