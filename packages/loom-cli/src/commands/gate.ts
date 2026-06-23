import type { CommandDescription } from '../describe/schema.js';
import fs from 'node:fs';
import path from 'node:path';
import { EpicStore, PolicyEngine, STANDALONE_KIND } from '@loom-ai/core';
import { openProjectDatabase } from '../dbHelper.js';
import { printOverlapAdvisory as defaultPrintOverlapAdvisory } from '../crossEpicOverlap.js';
import { runRun as defaultRunRun, type RunOptions } from './run.js';

/**
 * Resolves a user-provided id to the internal epic-NNN container id.
 *
 * When the operator types `story-049`, the DB stores the container as
 * `epic-049` (kind='standalone'). This helper translates the user-facing
 * story-NNN id to the internal epic-NNN id so gate lookups and updates use
 * the correct primary key. A plain `epic-NNN` id passes through unchanged.
 * Returns `undefined` when the translated `epic-NNN` does not exist as a
 * standalone container — the caller treats this as not-found.
 */
function resolveToInternalEpicId(
  store: EpicStore,
  id: string
): { internalId: string; displayId: string } | undefined {
  if (/^story-\d+$/.test(id)) {
    const containerEpicId = id.replace(/^story-/, 'epic-');
    if (!store.isStandalone(containerEpicId)) return undefined;
    return { internalId: containerEpicId, displayId: id };
  }
  // Plain epic-NNN: display as story-NNN if the row is standalone.
  if (store.isStandalone(id)) {
    return { internalId: id, displayId: id.replace(/^epic-/, 'story-') };
  }
  return { internalId: id, displayId: id };
}

/**
 * Persists the live policy snapshot on the epic row. Best-effort: a
 * snapshot failure (corrupt YAML, IO error) must never block approval.
 * Mirrors the MCP `loom_approve_plan` handler so CLI-approved epics get
 * the same `epics.policy_snapshot` forensic record + `epic_policy_rebound`
 * diffing later, instead of running blind.
 */
function persistPolicySnapshot(
  store: EpicStore,
  loomDir: string,
  epicId: string
): void {
  try {
    const policy = PolicyEngine.load(loomDir).policyData;
    store.setPolicySnapshot(epicId, JSON.stringify(policy));
  } catch {
    // Snapshot persistence is observability — never block approve on it.
  }
}

/**
 * Options for {@link runApprove}.
 *
 * `run` chains an explicit-id approve straight into the `loom run` dispatch
 * path (story-007-004) so 'dispatching now' is only ever printed by a path
 * that actually dispatches. The `runRun` / `printOverlapAdvisory` seams are
 * injectable for tests — production wiring omits them and the real functions
 * are used.
 */
export interface ApproveOptions {
  /** When true with an explicit id, chain into `loom run` after approving. */
  run?: boolean;
  /** Test seam — inject a stub dispatcher so no real supervisor spawns. */
  runRun?: (epicIds: string[], opts?: RunOptions) => Promise<void>;
  /** Test seam — inject a stub overlap printer so the call count is assertable. */
  printOverlapAdvisory?: (projectRoot: string, targetEpicId: string) => void;
}

/**
 * The human approval gate. `loom approve` with no id approves every epic
 * still in `planned` status; with an id, approves just that epic.
 *
 * With `--run` and an explicit id, approve chains into the SAME `runRun`
 * dispatch path (one function call — the seam is kept thin so approve and run
 * never drift). The cross-epic overlap advisory runs ONCE here at approve time;
 * the chained `runRun` is told to suppress it so it is not printed twice. Bare
 * `loom approve --run` (no id) is a usage error: it exits non-zero with a
 * one-line hint and never dispatches.
 */
export async function runApprove(
  epicId: string | undefined,
  opts: ApproveOptions = {}
): Promise<void> {
  const runRun = opts.runRun ?? defaultRunRun;
  const printOverlapAdvisory = opts.printOverlapAdvisory ?? defaultPrintOverlapAdvisory;

  // `--run` is only meaningful with an explicit id — it is the seam that
  // chains into the run path. With no id there is nothing for the chained run
  // to pick up, so a bare `--run` is a usage error rather than a silent
  // bulk-approve-then-nothing.
  if (opts.run && !epicId) {
    console.error('usage: loom approve <epic-id> --run (an explicit epic id is required with --run)');
    process.exit(1);
  }

  const { db, loomDir } = openLoom();
  const store = new EpicStore(db);

  if (epicId) {
    // Resolve story-NNN (user-facing) to epic-NNN (internal) for standalone stories.
    // Plain epic-NNN ids pass through unchanged. If story-NNN does not resolve to a
    // known standalone container the caller gets a "not found" error below.
    const resolved = resolveToInternalEpicId(store, epicId);
    const internalId = resolved?.internalId ?? epicId;
    const displayId = resolved?.displayId ?? epicId;

    const epic = store.get(internalId);
    if (!epic) {
      const label = epicId.startsWith('story-') ? 'Story' : 'Epic';
      console.error(`${label} "${epicId}" not found.`);
      // If the operator passed story-NNN but a regular (non-standalone) epic-NNN
      // exists, surface a hint so they know to try the epic-NNN id instead.
      if (epicId.startsWith('story-')) {
        const correspondingEpicId = epicId.replace(/^story-/, 'epic-');
        const regularEpic = store.get(correspondingEpicId);
        if (regularEpic && !store.isStandalone(correspondingEpicId)) {
          console.error(
            `  Hint: a regular epic with id ${correspondingEpicId} exists; try \`loom approve ${correspondingEpicId}\`.`
          );
        }
      }
      process.exit(1);
    }
    if (epic.status !== 'planned') {
      console.error(`Epic "${displayId}" is "${epic.status}", not "planned" — nothing to approve.`);
      process.exit(1);
    }
    persistPolicySnapshot(store, loomDir, internalId);
    store.updateStatus(internalId, 'approved');
    console.log(`  approved  ${displayId}: ${epic.title}`);
    // Advisory only — warns about files this epic shares with another in-flight
    // epic's contract; it never blocks the approval above. Runs ONCE here; on
    // the chained `--run` path the dispatch is told to suppress its own copy.
    printOverlapAdvisory(path.dirname(loomDir), internalId);

    if (opts.run) {
      // Chain into the SAME dispatch path `loom run` uses — only a path that
      // truly dispatches prints 'dispatching now'. suppressOverlap=true so the
      // advisory printed just above is not printed a second time at dispatch.
      await runRun([internalId], { suppressOverlap: true });
      return;
    }

    // Approve only flips status to `approved`; it does NOT dispatch workers.
    // The success copy must end with the run-hint so operators know the next
    // step is `loom run`, not assume dispatch already happened.
    console.log(`\n  Next: run \`loom run ${displayId}\` to dispatch.`);
    return;
  }

  const planned = store.listByStatus('planned');
  if (planned.length === 0) {
    console.log('  No epics in "planned" status to approve.');
    return;
  }
  const projectRoot = path.dirname(loomDir);
  for (const epic of planned) {
    persistPolicySnapshot(store, loomDir, epic.id);
    store.updateStatus(epic.id, 'approved');
    // Show story-NNN for standalone containers in the per-item approval line.
    const itemDisplayId =
      epic.kind === STANDALONE_KIND ? epic.id.replace(/^epic-/, 'story-') : epic.id;
    console.log(`  approved  ${itemDisplayId}: ${epic.title}`);
    // Advisory only — never blocks the bulk approval.
    printOverlapAdvisory(projectRoot, epic.id);
  }
  console.log(
    `\n  ${planned.length} epic(s) approved. Next: run \`loom run <epic-id>\` to dispatch.`
  );
}

export function runReject(epicId: string, reason: string | undefined): void {
  const { db } = openLoom();
  const store = new EpicStore(db);

  const resolved = resolveToInternalEpicId(store, epicId);
  const internalId = resolved?.internalId ?? epicId;
  const displayId = resolved?.displayId ?? epicId;

  const epic = store.get(internalId);
  if (!epic) {
    const label = epicId.startsWith('story-') ? 'Story' : 'Epic';
    console.error(`${label} "${epicId}" not found.`);
    process.exit(1);
  }
  if (epic.status !== 'planned') {
    console.error(`Epic "${displayId}" is "${epic.status}", not "planned" — cannot reject.`);
    process.exit(1);
  }
  store.updateStatus(internalId, 'rejected', reason);
  console.log(`  rejected  ${displayId}: ${epic.title}`);
  if (reason) console.log(`  reason    ${reason}`);
}

function openLoom(): { db: ReturnType<typeof openProjectDatabase>; loomDir: string } {
  const projectRoot = process.cwd();
  const loomDir = path.join(projectRoot, '.loom');
  if (!fs.existsSync(path.join(loomDir, 'policy.yaml'))) {
    console.error('loom is not initialized in this directory. Run `loom init` first.');
    process.exit(1);
  }
  return { db: openProjectDatabase(projectRoot), loomDir };
}

export const spec: CommandDescription = {
  name: 'approve',
  summary: 'Approve planned epic(s) and release them for execution',
  whenToUse: 'Use after reviewing the planning artifacts to release an epic for worker dispatch. Pass no id to approve all planned epics.',
  arguments: [
    { name: 'epic-id', type: 'string', required: false, description: 'Epic to approve; omit to approve all planned epics' },
  ],
  options: [
    { name: '--run', type: 'boolean', description: 'After approving, immediately dispatch workers (requires an explicit epic id)', changesOutputShape: false },
  ],
  output: { text: 'Confirmation of which epics were approved and next steps' },
  examples: [
    { command: 'loom approve epic-001', description: 'Approve epic-001 for execution' },
    { command: 'loom approve', description: 'Approve all planned epics' },
    { command: 'loom approve epic-001 --run', description: 'Approve and immediately start workers' },
  ],
  exitCodes: [
    { code: 0, meaning: 'Epic(s) approved successfully' },
    { code: 1, meaning: 'Epic not found, wrong status, or --run without explicit id' },
  ],
  errors: ['Epic not found', 'Epic is not in planned status', '--run requires an explicit epic-id argument', 'loom is not initialized — run `loom init` first'],
  relationships: { prerequisites: ['epic'], nextSteps: ['run', 'status'] },
};

export const specReject: CommandDescription = {
  name: 'reject',
  summary: 'Reject a planned epic',
  whenToUse: 'Use when a planned epic should not proceed. Records the rejection in the audit log.',
  arguments: [
    { name: 'epic-id', type: 'string', required: true, description: 'Epic to reject' },
  ],
  options: [
    { name: '--reason', type: 'string', description: 'Why the epic is being rejected', changesOutputShape: false },
  ],
  output: { text: 'Confirmation that the epic was rejected' },
  examples: [
    { command: 'loom reject epic-001', description: 'Reject epic-001' },
    { command: 'loom reject epic-001 --reason "Scope too large"', description: 'Reject with an explanation' },
  ],
  exitCodes: [
    { code: 0, meaning: 'Epic rejected successfully' },
    { code: 1, meaning: 'Epic not found or loom not initialized' },
  ],
  errors: ['Epic not found', 'loom is not initialized — run `loom init` first'],
  relationships: { prerequisites: ['epic'], nextSteps: ['epic', 'status'] },
};
