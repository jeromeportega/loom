import type { CommandDescription } from '../describe/schema.js';
import fs from 'node:fs';
import path from 'node:path';
import yaml from 'js-yaml';
import {
  EpicStore,
  PolicyEngine,
  EpicYamlSchema,
  readManifest,
  resolvePrimaryRepo,
  validateCrossRepoEdges,
  loomHome,
} from '@loom-ai/core';
import { openProjectDatabase } from '../dbHelper.js';
import { printOverlapAdvisory as defaultPrintOverlapAdvisory } from '../crossEpicOverlap.js';
import { runRun as defaultRunRun, type RunOptions } from './run.js';

/**
 * Resolves a user-provided id to its DB primary key and display form.
 *
 * After story-059-002, standalone stories are stored with id='story-NNN'
 * (PK = story-NNN, no epic-NNN container). Both story-NNN and epic-NNN ids
 * resolve via direct DB lookup — no prefix translation is needed.
 * Returns `undefined` when the id does not exist in the DB.
 */
function resolveToInternalEpicId(
  store: EpicStore,
  id: string
): { internalId: string; displayId: string } | undefined {
  if (!store.get(id)) return undefined;
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
 * Approval-time cycle check (ADR-002, fail-closed seam).
 *
 * Loads the epic's stories from its YAML plan and the workspace manifest from
 * loom-home, then validates the cross-repo dependency graph for cycles.
 * Returns an operator-readable error string if a cycle is found, or null when
 * the graph is acyclic or the check cannot run (no yaml_path, YAML missing,
 * single-repo setup, etc.).  Never throws — failures are fail-open (best-effort)
 * so a broken manifest never prevents approving a single-repo epic.
 *
 * This is the WIRED CLI seam — called before any `store.updateStatus('approved')`
 * write so that a cyclic epic is rejected before its status can change and before
 * any worker can be dispatched.
 */
function detectRepoCycles(yamlPath: string, projectRoot: string): string | null {
  try {
    const file = path.join(projectRoot, yamlPath);
    if (!fs.existsSync(file)) return null;
    const parsed = EpicYamlSchema.parse(yaml.load(fs.readFileSync(file, 'utf8')));
    const manifest = readManifest(loomHome());
    let primarySlug: string;
    try {
      primarySlug = resolvePrimaryRepo(manifest);
    } catch {
      // No multi-repo setup (or ambiguous manifest) — cross-repo cycles are impossible.
      return null;
    }
    const errs = validateCrossRepoEdges(parsed.stories, manifest, primarySlug);
    if (errs.length === 0) return null;
    const repos = [...new Set(errs.flatMap(e => [e.consumerSlug, e.producerSlug]))];
    const edgeList = errs.map(e => `"${e.consumerSlug}" → "${e.producerSlug}"`).join(', ');
    return (
      `cross-repo dependency cycle detected: repos ${repos.map(r => `"${r}"`).join(', ')} ` +
      `form a cycle (${edgeList}). Resolve the cycle before approving.`
    );
  } catch {
    return null; // Best-effort — never block approve on check failure.
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
    // After story-059-002, standalone rows have id='story-NNN' directly — direct lookup.
    // Plain epic-NNN ids also pass through unchanged. If the id does not exist in the
    // DB, resolved is undefined and the caller gets a "not found" error below.
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
    // Approval-time cycle check (ADR-002, fail-closed seam) — runs before any
    // state mutation so a cyclic epic is never transitioned to 'approved' and
    // therefore never dispatched.
    if (epic.yaml_path) {
      const projectRoot = path.dirname(loomDir);
      const cycleErr = detectRepoCycles(epic.yaml_path, projectRoot);
      if (cycleErr) {
        console.error(`Cannot approve "${displayId}": ${cycleErr}`);
        process.exit(1);
      }
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
  let approvedCount = 0;
  for (const epic of planned) {
    // Cycle check before each individual bulk approval.
    if (epic.yaml_path) {
      const cycleErr = detectRepoCycles(epic.yaml_path, projectRoot);
      if (cycleErr) {
        console.error(`  skipped   ${epic.id}: ${cycleErr}`);
        continue;
      }
    }
    persistPolicySnapshot(store, loomDir, epic.id);
    store.updateStatus(epic.id, 'approved');
    // After story-059-002, standalone rows have id='story-NNN' directly.
    console.log(`  approved  ${epic.id}: ${epic.title}`);
    // Advisory only — never blocks the bulk approval.
    printOverlapAdvisory(projectRoot, epic.id);
    approvedCount += 1;
  }
  if (approvedCount === 0 && planned.length > 0) {
    console.log(`\n  0 of ${planned.length} epic(s) approved (all had cycle errors). Resolve cycles and retry.`);
  } else {
    console.log(
      `\n  ${approvedCount} epic(s) approved. Next: run \`loom run <epic-id>\` to dispatch.`
    );
  }
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
