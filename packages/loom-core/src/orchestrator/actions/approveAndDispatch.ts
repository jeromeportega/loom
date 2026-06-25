import fs from 'node:fs';
import path from 'node:path';
import yaml from 'js-yaml';
import type { EpicStore } from '../../state/EpicStore.js';
import type { AuditLog } from '../../state/AuditLog.js';
import { type Policy, type Story, EpicYamlSchema } from '../../types.js';
import { readManifest, type WorkspaceManifest } from '../../home/workspaceManifest.js';
import { resolvePrimaryRepo } from '../../home/primaryRepo.js';
import { loomHome } from '../../state/paths.js';
import { validateCrossRepoEdges, type CrossRepoEdgeError } from '../crossRepoReadiness.js';
import { activeCollector } from '../../metrics/activeCollector.js';

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
 * if the repo dependency graph contains any cycle. Callers get a typed error with
 * structured fields ({@link CyclicRepoDependencyError.cyclicRepos},
 * {@link CyclicRepoDependencyError.edges}, {@link CyclicRepoDependencyError.cycleDescription})
 * rather than re-implementing the validation or the error formatting.
 *
 * This function has two call sites: file-based callers should prefer
 * {@link detectCyclesInEpicYaml} which reads and validates the YAML before calling
 * here. In-memory callers (tests, `approveAndDispatch`) call this directly.
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

// ─── File-based cycle detection ───────────────────────────────────────────────

/**
 * Loads an epic YAML from disk and checks its cross-repo dependency graph for
 * cycles. Returns an operator-readable error string if a cycle is found, or
 * `null` when the graph is acyclic or the check cannot run.
 *
 * Failure modes:
 * - Path-traversal: returns null (no warning — structural guard, not data error).
 * - File not found: returns null — single-repo / missing file is not a cycle.
 * - YAML parse / schema error: logs to stderr and returns null — operator can
 *   see the skip but the approve is not blocked on a transient YAML edit.
 * - No manifest / no multi-repo setup: returns null — cycles impossible.
 *
 * This is the canonical file-based cycle detection seam; both the CLI approve
 * path and the web approve route call it so the logic stays in one place.
 */
export function detectCyclesInEpicYaml(
  yamlPath: string,
  projectRoot: string,
): string | null {
  // Path-traversal guard — reject paths that escape the project root.
  const resolvedRoot = path.resolve(projectRoot);
  const abs = path.resolve(projectRoot, yamlPath);
  if (!abs.startsWith(resolvedRoot + path.sep) && abs !== resolvedRoot) return null;

  if (!fs.existsSync(abs)) return null;

  let parsed: ReturnType<typeof EpicYamlSchema.parse>;
  try {
    parsed = EpicYamlSchema.parse(yaml.load(fs.readFileSync(abs, 'utf8'), { schema: yaml.JSON_SCHEMA }));
  } catch (e) {
    console.error(`  warn: cycle check skipped — epic YAML could not be parsed (${(e as Error).message})`);
    return null;
  }

  let manifest: WorkspaceManifest;
  try {
    manifest = readManifest(loomHome());
  } catch {
    return null; // No manifest — single-repo setup, cycles impossible.
  }

  let primarySlug: string;
  try {
    primarySlug = resolvePrimaryRepo(manifest);
  } catch {
    return null; // Ambiguous or absent primary repo.
  }

  try {
    assertNoCycles(parsed.stories, manifest, primarySlug, '(approval-check)');
    return null;
  } catch (e) {
    if (e instanceof CyclicRepoDependencyError) {
      return e.cycleDescription;
    }
    return null;
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
  try { activeCollector()?.markApproved(); } catch { /* timing is observability */ }
  deps.auditLog.record({
    action: 'epic_approved',
    command: epicId,
    detail: { actor: opts.actor },
  });
  return { status: 'dispatching' };
}
