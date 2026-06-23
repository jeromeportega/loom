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

/** Project-root-relative path strings, for storing in the DB and JSON output. */
export function planningRelPaths(runId: string) {
  const base = `.loom/planning/${runId}`;
  return {
    brief: `${base}/project-brief.md`,
    prd: `${base}/prd.md`,
    architecture: `${base}/architecture.md`,
    epicFile: (epicId: string) => `${base}/epics/${epicId}.yaml`,
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
