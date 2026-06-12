/**
 * Shared classification types for resilient story execution (epic-006).
 *
 * An attempt is classified as `infra_failure` (a transient/environmental fault
 * worth an automatic retry) or `work_failure` (the agent ran and produced a
 * real, non-retryable outcome). This is a separate axis from agent `status`
 * (ADR-1): the lifecycle enum is unchanged — classification lives in its own
 * `attempt_class` column and audit detail, owned by the resilience subsystem.
 */
export type AttemptClass = 'infra_failure' | 'work_failure';

/** The specific infra fault that fired, present only on `infra_failure`. */
export type InfraSignature =
  | 'connection_loss'
  | 'spawn_enoent'
  | 'cli_config_rename'
  | 'exit_before_output';

export interface Classification {
  class: AttemptClass;
  signature?: InfraSignature; // present ONLY when class === 'infra_failure'
}
