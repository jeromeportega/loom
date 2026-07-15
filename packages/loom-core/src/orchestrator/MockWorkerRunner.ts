import type {
  WorkerRunner,
  WorkerAssignment,
  WorkerResult,
  ConflictResolution,
  ConflictResolutionResult,
} from './WorkerRunner.js';

export type MockWorkerResponder = (
  assignment: WorkerAssignment
) => WorkerResult | Promise<WorkerResult>;

/**
 * Scripted integrator behavior for tests. Receives the conflict task (so it can
 * edit the conflicted files in `task.cwd`) and returns the agent outcome. When
 * omitted, the worker has no resolveConflicts capability — the Supervisor then
 * treats a merge conflict the 3a way (loud block).
 */
export type MockConflictResolver = (
  task: ConflictResolution
) => ConflictResolutionResult | Promise<ConflictResolutionResult>;

/**
 * Deterministic WorkerRunner for tests. Construct with either a responder
 * function or a fixed result applied to every story. Records every assignment.
 */
export class MockWorkerRunner implements WorkerRunner {
  readonly assignments: WorkerAssignment[] = [];
  readonly conflictTasks: ConflictResolution[] = [];
  private responder: MockWorkerResponder;
  private conflictResolver?: MockConflictResolver;

  constructor(responder?: MockWorkerResponder | Partial<WorkerResult>) {
    if (typeof responder === 'function') {
      this.responder = responder;
    } else {
      const fixed = responder ?? {};
      this.responder = (a) => ({
        status: fixed.status ?? 'done',
        commitCount: fixed.commitCount ?? 1,
        prUrl: fixed.prUrl,
        summary: fixed.summary ?? `mock implemented ${a.storyId}`,
        logTail: fixed.logTail ?? '',
        ...(fixed.review ? { review: fixed.review } : {}),
        ...(fixed.usage ? { usage: fixed.usage } : {}),
        ...(fixed.budgetExhausted ? { budgetExhausted: fixed.budgetExhausted } : {}),
        ...(fixed.model ? { model: fixed.model } : {}),
      });
    }
  }

  /**
   * Opt this mock into the integrator capability. Without it `resolveConflicts`
   * is undefined, so `integratorEnabled` is false and the Supervisor keeps the
   * 3a loud-block path — matching a real backend that can't run the integrator.
   */
  withConflictResolver(resolver: MockConflictResolver): this {
    this.conflictResolver = resolver;
    this.resolveConflicts = async (task: ConflictResolution): Promise<ConflictResolutionResult> => {
      this.conflictTasks.push(task);
      return resolver(task);
    };
    return this;
  }

  resolveConflicts?: (task: ConflictResolution) => Promise<ConflictResolutionResult>;

  async run(assignment: WorkerAssignment): Promise<WorkerResult> {
    this.assignments.push(assignment);
    return this.responder(assignment);
  }
}
