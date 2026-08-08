import type { Story } from '../types.js';
import { detectCycles, type StoryGraph } from '../orchestrator/storyGraph.js';

/**
 * Plan-time provides/requires reconciliation (Slice 1 of the canonical-contract
 * epic). A deterministic static mirror of the runtime `checkRequires`
 * (Supervisor.ts): for each story `requires: { key → sourceStoryId }`, the source
 * story must exist and its declared `provides` must contain `key`. A violation of
 * that closure is a GUARANTEED runtime stall (the requiring story soft-skips every
 * tick, then is swept to `blocked`), so catching it at plan time — before the epic
 * is offered for execution — is strictly better than discovering it mid-run.
 *
 * The runtime enforces the static contract in the direction that matters: a
 * successful source story is itself blocked unless its worker emits every declared
 * `provides` key, so a source that the gate says provides `key` is runtime-
 * guaranteed to deliver it. That makes this check sound, not merely heuristic.
 */

export type ClosureViolationKind =
  | 'missing-source' // requires a story that is not in the run
  | 'missing-provide' // source exists but does not declare the required key
  | 'self-require' // requires an output from itself — can never resolve
  | 'deadlock-cycle' // a cycle across dependency+requires edges — no valid order
  | 'unordered'; // source provides the key but is not an ordering ancestor (WARN)

/** Kinds that make a plan non-runnable. `unordered` is advisory (WARN) only. */
const FAILURE_KINDS: ReadonlySet<ClosureViolationKind> = new Set([
  'missing-source',
  'missing-provide',
  'self-require',
  'deadlock-cycle',
]);

export interface ClosureViolation {
  kind: ClosureViolationKind;
  /** The story that owns the offending `requires` entry (or a cycle member). */
  storyId: string;
  /** The requires key. Absent for `requires-cycle`. */
  key?: string;
  /** The referenced source story. Absent for `requires-cycle`. */
  sourceStoryId?: string;
  /** For `requires-cycle`: the cycle path (first id repeated at the end). */
  cyclePath?: string[];
}

export interface ClosureResult {
  /** True when there are no FAILURE-kind violations (WARN-only still passes). */
  ok: boolean;
  violations: ClosureViolation[];
}

/** A violation that makes the plan non-runnable (vs an advisory warning). */
export function isClosureFailure(v: ClosureViolation): boolean {
  return FAILURE_KINDS.has(v.kind);
}

/**
 * Reconcile the provides/requires closure across the FULL set of stories in a
 * planning run (union of every epic and repo — `requires` resolves by global
 * story id, so the universe must not be scoped to a single epic). Pure and
 * deterministic. A run with no `requires` anywhere returns `{ ok: true, [] }`
 * and the caller's gate is a no-op, byte-identical to the pre-feature baseline.
 */
export function reconcileProvidesRequires(stories: Story[]): ClosureResult {
  const byId = new Map<string, Story>();
  for (const s of stories) byId.set(s.id, s);

  const violations: ClosureViolation[] = [];

  // Deadlock cycle over the UNION of dependency and requires edges (both encode
  // "source must finish before the requirer"). A cycle here means no valid
  // execution order exists — mutual requires (A↔B), a mixed dependency+requires
  // loop (A depends B, B requires A), or a serializer-injected same-file edge
  // that opposes a requires. The pure-dependency case is also caught at approve,
  // but catching every deadlock class at plan time is strictly better. Self-edges
  // are excluded (reported as `self-require`). Computed first so the per-entry
  // ordering check can suppress the redundant `unordered` note for cycle members.
  const cyclePath = detectDeadlockCycle(stories);
  const inCycle = new Set(cyclePath);

  for (const s of stories) {
    if (!s.requires) continue;
    for (const [key, sourceStoryId] of Object.entries(s.requires)) {
      if (sourceStoryId === s.id) {
        violations.push({ kind: 'self-require', storyId: s.id, key, sourceStoryId });
        continue;
      }
      const source = byId.get(sourceStoryId);
      if (!source) {
        violations.push({ kind: 'missing-source', storyId: s.id, key, sourceStoryId });
        continue;
      }
      if (!source.provides || !(key in source.provides)) {
        violations.push({ kind: 'missing-provide', storyId: s.id, key, sourceStoryId });
        continue;
      }
      // Source exists and provides the key. If the requirer (transitively)
      // depends on the source, the dispatch DAG guarantees the ordering — OK.
      // If the pair is part of a deadlock cycle, that failure is reported below;
      // suppress the redundant note. Otherwise the pair is genuinely unordered:
      // the runtime still resolves it by soft-skip re-evaluation within a single
      // run, so this is advisory (WARN), not a hard failure.
      const cyclePair = inCycle.has(s.id) && inCycle.has(sourceStoryId);
      if (!dependsOn(s.id, sourceStoryId, byId) && !cyclePair) {
        violations.push({ kind: 'unordered', storyId: s.id, key, sourceStoryId });
      }
    }
  }

  if (cyclePath.length > 0) {
    violations.push({ kind: 'deadlock-cycle', storyId: cyclePath[0], cyclePath });
  }

  return { ok: !violations.some(isClosureFailure), violations };
}

/** True when `from` transitively depends on `target` via `dependencies` edges. */
function dependsOn(from: string, target: string, byId: Map<string, Story>): boolean {
  const seen = new Set<string>();
  const stack = [from];
  while (stack.length > 0) {
    const id = stack.pop()!;
    if (seen.has(id)) continue;
    seen.add(id);
    const deps = byId.get(id)?.dependencies ?? [];
    for (const d of deps) {
      if (d === target) return true;
      if (!seen.has(d)) stack.push(d);
    }
  }
  return false;
}

/**
 * Detect a cycle over the UNION of a story's dependency edges and its requires
 * edges (both point from a story to a predecessor that must finish first). A
 * cycle means no valid execution order — pure-requires, pure-dependency, or a
 * mixed cross-channel loop. Self-edges are excluded (reported as `self-require`).
 * Reuses the acyclic-graph detector from storyGraph via a synthetic graph.
 *
 * detectCycles returns only the FIRST back-edge, so a plan with two independent
 * deadlock cycles labels only one `deadlock-cycle` per pass (the plan is still
 * correctly rejected; the second surfaces once the first is fixed). Enumerating
 * every cycle (SCC decomposition) would make the diagnostics complete in one
 * pass — a possible follow-up; soundness (never admitting a deadlock) holds now.
 */
function detectDeadlockCycle(stories: Story[]): string[] {
  const nodes = new Map<string, Story>();
  const edges = new Map<string, string[]>();
  for (const s of stories) {
    nodes.set(s.id, s);
    const requiresSources = s.requires ? Object.values(s.requires) : [];
    const preds = [...new Set([...s.dependencies, ...requiresSources])].filter(
      (p) => p !== s.id
    );
    edges.set(s.id, preds);
  }
  const graph: StoryGraph = { nodes, edges };
  // No manifest → detectCycles runs only the DFS over `edges` (the combined
  // precedence links), returning the cycle path (or []). Cross-repo repo-cycle
  // logic is not engaged because requires/dependencies resolve by global id.
  return detectCycles(graph);
}

/** One-line human description of a violation (for stderr + the reject reason). */
export function describeClosureViolation(v: ClosureViolation): string {
  switch (v.kind) {
    case 'missing-source':
      return `${v.storyId} requires "${v.key}" from ${v.sourceStoryId}, which is not a story in this plan`;
    case 'missing-provide':
      return `${v.storyId} requires "${v.key}" from ${v.sourceStoryId}, which does not declare that output in its provides`;
    case 'self-require':
      return `${v.storyId} requires "${v.key}" from itself — a story's outputs are only available after it completes`;
    case 'deadlock-cycle':
      return `deadlock cycle (no valid execution order across dependency/requires edges): ${(v.cyclePath ?? []).join(' → ')}`;
    case 'unordered':
      return `${v.storyId} requires "${v.key}" from ${v.sourceStoryId} but does not depend on it (ordering not guaranteed across waves)`;
  }
}

/** Compact single-line reason for the rejected epic's `error` column. */
export function summarizeClosureFailures(result: ClosureResult): string {
  const fails = result.violations.filter(isClosureFailure);
  const head = `reconciliation: ${fails.length} unsatisfiable story dependenc${fails.length === 1 ? 'y' : 'ies'}`;
  const detail = fails.slice(0, 3).map(describeClosureViolation).join('; ');
  const more = fails.length > 3 ? `; +${fails.length - 3} more` : '';
  return `${head} — ${detail}${more}`;
}
