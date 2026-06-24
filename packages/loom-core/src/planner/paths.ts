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

/** Formats a story number as a zero-padded standalone id, e.g. 3 -> "story-003". */
export function storyId(num: number): string {
  return `story-${String(num).padStart(3, '0')}`;
}

/**
 * Parses either an epic id ("epic-NNN") or a standalone story id ("story-NNN")
 * back to its number. Returns 0 for any other input (never throws).
 * This is the load-bearing counter parse for the shared global sequence —
 * both prefixes must be visible so a story-NNN row can never be reused by a
 * future epic-NNN (NFR-4).
 */
export function idNumber(id: string | null | undefined): number {
  if (!id) return 0;
  const m = id.match(/^(?:epic|story)-(\d+)$/);
  return m ? parseInt(m[1], 10) : 0;
}

/**
 * Parses an epic id back to its number, e.g. "epic-003" -> 3.
 * Returns 0 if unparseable or if the id is not epic-prefixed.
 * Back-compat: delegates to idNumber() for the epic- prefix only,
 * so story-NNN ids are NOT counted here (use idNumber() directly for that).
 */
export function epicNumber(id: string): number {
  return id.startsWith('epic-') ? idNumber(id) : 0;
}
