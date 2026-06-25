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

  constructor(edges: CrossRepoEdgeError[], epicId: string) {
    const repos = [...new Set(edges.flatMap(e => [e.consumerSlug, e.producerSlug]))];
    const edgeList = edges.map(e => `"${e.consumerSlug}" → "${e.producerSlug}"`).join(', ');
    super(
      `Cannot approve epic "${epicId}": cross-repo dependency cycle detected ` +
      `involving repos ${repos.map(r => `"${r}"`).join(', ')}. ` +
      `Cyclic edges: ${edgeList}. ` +
      `Resolve the cycle before re-submitting.`,
    );
    this.name = 'CyclicRepoDependencyError';
    this.cyclicRepos = repos;
    this.edges = edges;
  }
}

// ─── Approve path ─────────────────────────────────────────────────────────────

/**
 * The single approve path — used by both human approvals (web/MCP) and
 * full-auto self-approval. Captures the policy snapshot, transitions
 * planned→approved, and writes the epic_approved audit row. The actor field
 * distinguishes who triggered the approval.
 *
 * Approval-time seam (ADR-002, fail-closed): when `opts.stories`,
 * `opts.manifest`, and `opts.primarySlug` are provided, the cross-repo
 * dependency DAG is validated for cycles BEFORE any state is mutated.
 * A cyclic graph throws {@link CyclicRepoDependencyError} — the epic stays
 * in 'planned' status and therefore no worker is ever dispatched.
 *
 * Callers are responsible for firing dispatch (supervisor.run([epicId])) after
 * this returns; this function only handles the durable state transitions.
 */
export async function approveAndDispatch(
  deps: { epicStore: EpicStore; auditLog: AuditLog; policy: Policy },
  epicId: string,
  opts: {
    actor: 'human' | 'full-auto';
    /**
     * When provided (along with manifest + primarySlug), the cross-repo
     * dependency graph is validated for cycles before any state mutation.
     * Omit for backward-compatible callers that do not have stories loaded.
     */
    stories?: Story[];
    manifest?: WorkspaceManifest;
    primarySlug?: string;
  },
): Promise<{ status: 'dispatching' }> {
  // ── Approval-time cycle check (ADR-002, fail-closed seam) ─────────────────
  // This is the last human checkpoint before dispatch. If the repo dependency
  // graph contains a cycle, the epic is rejected here — no status transition
  // occurs and no worker can be dispatched for this epic.
  if (opts.stories && opts.manifest && opts.primarySlug !== undefined) {
    const errs = validateCrossRepoEdges(opts.stories, opts.manifest, opts.primarySlug);
    if (errs.length > 0) {
      throw new CyclicRepoDependencyError(errs, epicId);
    }
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
