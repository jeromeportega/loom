import type { EpicStore } from '../../state/EpicStore.js';
import type { AuditLog } from '../../state/AuditLog.js';
import type { Policy, Story } from '../../types.js';
import type { WorkspaceManifest } from '../../home/workspaceManifest.js';
import { validateCrossRepoEdges, type CrossRepoEdgeError } from '../crossRepoReadiness.js';

// ─── Cycle rejection ──────────────────────────────────────────────────────────

/**
 * Thrown at approval time when the epic's repository dependency graph contains
 * a cycle. This is the fail-closed seam (ADR-002): no state is mutated and no
 * worker is dispatched when this error is thrown.
 */
export class CyclicRepoDependencyError extends Error {
  /** Repo slugs that participate in the cycle(s). */
  public readonly cyclicRepos: string[];
  /** The raw edge errors from validateCrossRepoEdges. */
  public readonly edges: CrossRepoEdgeError[];
  /**
   * The cycle description without the "Cannot approve…" prefix, so CLI callers
   * can prepend the display epic id themselves. This is the canonical
   * operator-readable string — format it here, read it everywhere.
   */
  public readonly cycleDescription: string;

  constructor(edges: CrossRepoEdgeError[], epicId: string) {
    const repos = [...new Set(edges.flatMap(e => [e.consumerSlug, e.producerSlug]))];
    const edgeList = edges.map(e => `"${e.consumerSlug}" → "${e.producerSlug}"`).join(', ');
    const cycleDescription =
      `cross-repo dependency cycle detected: repos ${repos.map(r => `"${r}"`).join(', ')} ` +
      `form a cycle (${edgeList}). Resolve the cycle before approving.`;
    super(`Cannot approve epic "${epicId}": ${cycleDescription}`);
    this.name = 'CyclicRepoDependencyError';
    this.cyclicRepos = repos;
    this.edges = edges;
    this.cycleDescription = cycleDescription;
  }
}

// ─── Shared cycle-assertion helper ───────────────────────────────────────────

/**
 * Calls {@link validateCrossRepoEdges} and throws {@link CyclicRepoDependencyError}
 * if the repo dependency graph contains any cycle. This is the single location
 * that calls the validator — callers get a typed error with structured fields
 * ({@link CyclicRepoDependencyError.cyclicRepos}, {@link CyclicRepoDependencyError.edges},
 * {@link CyclicRepoDependencyError.cycleDescription}) rather than re-implementing
 * the validation or the error formatting.
 */
export function assertNoCycles(
  stories: Story[],
  manifest: WorkspaceManifest,
  primarySlug: string,
  epicId: string,
): void {
  const errs = validateCrossRepoEdges(stories, manifest, primarySlug);
  if (errs.length > 0) {
    throw new CyclicRepoDependencyError(errs, epicId);
  }
}

// ─── Approve path ─────────────────────────────────────────────────────────────

/**
 * The single approve path — used by both human approvals (web/MCP) and
 * full-auto self-approval. Captures the policy snapshot, transitions
 * planned→approved, and writes the epic_approved audit row. The actor field
 * distinguishes who triggered the approval.
 *
 * Approval-time seam (ADR-002, fail-closed): human approvals MUST supply
 * `stories`, `manifest`, and `primarySlug` — the cross-repo dependency DAG is
 * validated for cycles BEFORE any state is mutated. A cyclic graph throws
 * {@link CyclicRepoDependencyError} — the epic stays in 'planned' status and
 * therefore no worker is ever dispatched. The discriminated union enforces this
 * at the type level so a future `actor:'human'` caller cannot accidentally omit
 * the graph context and silently skip the guard.
 *
 * `actor:'full-auto'` (supervisor self-approval) omits graph context —
 * `findDependencyCycle` in PMAgent.ts is the planning-time guard for that path
 * and `topoSortRepos` in CrossRepoCoordinator.ts is the last-line backstop.
 *
 * Callers are responsible for firing dispatch (supervisor.run([epicId])) after
 * this returns; this function only handles the durable state transitions.
 */
export async function approveAndDispatch(
  deps: { epicStore: EpicStore; auditLog: AuditLog; policy: Policy },
  epicId: string,
  opts:
    | {
        actor: 'human';
        /** Required for the approval-time cycle check (ADR-002, fail-closed seam). */
        stories: Story[];
        manifest: WorkspaceManifest;
        primarySlug: string;
      }
    | { actor: 'full-auto' },
): Promise<{ status: 'dispatching' }> {
  // ── Approval-time cycle check (ADR-002, fail-closed seam) ─────────────────
  // This is the last human checkpoint before dispatch. If the repo dependency
  // graph contains a cycle, the epic is rejected here — no status transition
  // occurs and no worker can be dispatched for this epic.
  if (opts.actor === 'human') {
    assertNoCycles(opts.stories, opts.manifest, opts.primarySlug, epicId);
  }

  try {
    deps.epicStore.setPolicySnapshot(epicId, JSON.stringify(deps.policy));
  } catch {
    // Snapshot persistence is observability — never block approve on it.
  }
  deps.epicStore.updateStatus(epicId, 'approved');
  deps.auditLog.record({
    action: 'epic_approved',
    command: epicId,
    detail: { actor: opts.actor },
  });
  return { status: 'dispatching' };
}
