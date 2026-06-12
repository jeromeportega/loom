import path from 'node:path';
import {
  openDatabase,
  EpicStore,
  loadOwnershipMap,
  computeOverlaps,
  renderOverlapAdvisory,
  type OwnershipMap,
} from '@loom-ai/core';

/**
 * Epics whose contracts are "in flight" relative to a target — anything that
 * has a settled or active plan an operator might collide with. A `rejected` /
 * `failed` / `done` / `archived` epic is not a live claim on files, so its
 * contract is excluded from the comparison.
 */
const IN_FLIGHT_STATUSES = ['planned', 'approved', 'in_progress'] as const;

/**
 * Injectable seams so the advisory can be unit-tested without a real DB or
 * real contract files. Production wiring leaves these undefined and the printer
 * falls back to the DB + on-disk contract loaders.
 */
export interface OverlapAdvisoryDeps {
  /** Returns the ids of every planned/approved/in-progress epic on record. */
  listInFlightEpicIds?: (projectRoot: string) => string[];
  /** Loads one epic's ownership map, or null when its contract is absent. */
  loadMap?: (projectRoot: string, epicId: string) => OwnershipMap | null;
  /** Sink for the rendered lines; defaults to console.log. */
  print?: (line: string) => void;
}

/**
 * Cross-epic overlap advisory printer (FR-7).
 *
 * Compares the target epic's parsed ownership map against every OTHER
 * planned/approved/in-progress epic's map by EXACT lexical path equality and
 * prints an advisory naming each shared file and its owners. It WARNS — it
 * never blocks, never throws, never exits.
 *
 * A missing contract for any compared epic (including the target itself, the
 * shared_contract=off case) is silently skipped: `loadOwnershipMap` returns
 * null and that epic simply drops out of the comparison; the others still run.
 *
 * Called from `runApprove` (gate.ts) and at `runRun` dispatch start (run.ts)
 * before `supervisor.run()`. Suppression of the duplicate print on a chained
 * approve→run is the caller's decision (it just doesn't call this); the printer
 * itself has no opinion.
 */
export function printOverlapAdvisory(
  projectRoot: string,
  targetEpicId: string,
  deps: OverlapAdvisoryDeps = {}
): void {
  const print = deps.print ?? ((line: string) => console.log(line));
  const loadMap = deps.loadMap ?? loadOwnershipMap;
  const listInFlight = deps.listInFlightEpicIds ?? defaultListInFlightEpicIds;

  // Loading or DB access must never break approve/dispatch — the advisory is
  // observability, the command's job is to approve/run. Any failure degrades
  // to "no advisory", same as a missing contract.
  let target: OwnershipMap | null;
  let otherIds: string[];
  try {
    target = loadMap(projectRoot, targetEpicId);
    otherIds = listInFlight(projectRoot);
  } catch {
    return;
  }

  // Target has no contract (shared_contract=off) -> nothing to compare against.
  if (target === null) return;

  const others = new Map<string, OwnershipMap>();
  for (const id of otherIds) {
    if (id === targetEpicId) continue; // never compare an epic with itself
    let map: OwnershipMap | null;
    try {
      map = loadMap(projectRoot, id);
    } catch {
      continue; // a single bad load skips that epic, not the whole advisory
    }
    if (map === null) continue; // missing contract -> silently skipped
    others.set(id, map);
  }

  const overlaps = computeOverlaps(target, others);
  for (const line of renderOverlapAdvisory(overlaps)) {
    print(line);
  }
}

/** Default in-flight epic lookup: read the loom DB under `<projectRoot>/.loom`. */
function defaultListInFlightEpicIds(projectRoot: string): string[] {
  const db = openDatabase(path.join(projectRoot, '.loom'));
  const store = new EpicStore(db);
  const ids: string[] = [];
  for (const status of IN_FLIGHT_STATUSES) {
    for (const epic of store.listByStatus(status)) ids.push(epic.id);
  }
  return ids;
}
