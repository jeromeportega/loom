/**
 * Classifies a dead worker's spawn outcome as an infra fault (transient,
 * environmental, worth an automatic retry) or a work failure (the agent ran
 * and produced a real, non-retryable outcome). This is epic-006's resilience
 * brain: only `infra_failure` attempts feed the auto-retry controller
 * (story-006-003); `work_failure` attempts are surfaced to the operator as-is.
 *
 * The four infra signatures are sourced from the worker's EXISTING streaming
 * signals — no new instrumentation:
 *   - `connection_loss`     — cursor-agent dropped its session; surfaces as a
 *                             connection-error line in the parsed stdout
 *                             (`parseStreamLine` → `output`).
 *   - `spawn_enoent`        — the agent binary was not on PATH; the child
 *                             `'error'` event carries an ENOENT message
 *                             (`spawnError`).
 *   - `cli_config_rename`   — a concurrent rewrite of `cli-config.json` raced
 *                             the spawn; the child `'error'` event carries the
 *                             rename/ENOENT-on-config message (`spawnError`).
 *   - `exit_before_output`  — the process exited non-zero having emitted
 *                             nothing at all (`producedOutput === false`).
 *
 * ADR-2 — the loudness invariant (FR-4): a worker that produced ANY output and
 * then exited non-zero is a `work_failure` and is NEVER reclassified as infra.
 * The agent was alive and talking; its non-zero exit is a real result, not a
 * transient fault. `classifyAttempt` enforces this BEFORE consulting any
 * signature matcher, so no matcher can ever override it.
 *
 * The `INFRA_SIGNATURES` table is intentionally an ordered list of small,
 * single-responsibility matchers: adding a fifth signature is a one-line push,
 * not a rewrite of the classifier.
 */
import type { Classification, InfraSignature } from './resilience/types.js';
import type { AgentStore } from '../state/AgentStore.js';
import type { AuditLog } from '../state/AuditLog.js';

/**
 * Everything `classifyAttempt` needs to reach a verdict, assembled by
 * `BaseCliWorker.spawnAgent` from signals it already tracks. This is the exact
 * shape `spawnAgent` returns (story-006-002 adds `producedOutput`); the retry
 * controller (story-006-003) and suspend guard (story-006-005) consume it.
 */
export interface SpawnOutcome {
  /** Process exit code, or `null` when the child never produced one (spawn error / signal kill). */
  code: number | null;
  /** Everything the child wrote to stdout+stderr, concatenated. */
  output: string;
  /** Message from the child `'error'` event — carries ENOENT and the cli-config rename race. */
  spawnError?: string;
  /** The WorkerTimeoutGuard fired a wall-clock kill (stall/cap). */
  timedOut: boolean;
  /** True iff the child emitted at least one stdout/stderr byte. The loudness gate. */
  producedOutput: boolean;
}

/**
 * A single infra signature: given the outcome, return its `InfraSignature`
 * tag when it fires, else `null`. Matchers are pure, cheap, and independent —
 * the classifier consults them in `INFRA_SIGNATURES` order and takes the
 * first hit.
 */
export type SignatureMatcher = (o: SpawnOutcome) => InfraSignature | null;

/**
 * cursor-agent connection-loss phrasing as it reaches us through
 * `parseStreamLine` → the accumulated `output`. Matched case-insensitively so
 * minor wording drift between cursor-agent versions still classifies.
 */
const CONNECTION_LOSS_PATTERNS: RegExp[] = [
  /connection (?:to the agent )?(?:was )?(?:lost|closed|reset|dropped)/i,
  /lost connection to (?:the )?(?:cursor[- ]?agent|agent|server)/i,
  /agent (?:connection|session) (?:lost|closed|terminated|interrupted)/i,
  /\bECONNRESET\b/,
  /websocket (?:closed|disconnected|connection closed)/i,
  /stream (?:closed|disconnected) unexpectedly/i,
];

/** The agent binary itself wasn't found on PATH — ENOENT on the spawn. */
const matchSpawnEnoent: SignatureMatcher = (o) => {
  const err = o.spawnError;
  if (!err) return null;
  if (isCliConfigRename(err)) return null; // disambiguate from the config race
  if (/\bENOENT\b/.test(err) || /spawn\s+\S+\s+ENOENT/i.test(err)) {
    return 'spawn_enoent';
  }
  return null;
};

/**
 * A concurrent rewrite of `cli-config.json` raced the spawn — the child
 * `'error'` event names the config file. cursor-agent rewrites this file
 * atomically (write-temp-then-rename), so a spawn that reads it mid-rename
 * sees a transient ENOENT/rename error on that specific path. Distinct from a
 * missing binary: the path points at the config, not the agent executable.
 */
function isCliConfigRename(err: string): boolean {
  if (!/cli[-_]?config\.json/i.test(err)) return false;
  return (
    /\bENOENT\b/.test(err) ||
    /\brename\b/i.test(err) ||
    /no such file or directory/i.test(err)
  );
}

const matchCliConfigRename: SignatureMatcher = (o) =>
  o.spawnError && isCliConfigRename(o.spawnError) ? 'cli_config_rename' : null;

const matchConnectionLoss: SignatureMatcher = (o) =>
  o.output && CONNECTION_LOSS_PATTERNS.some((re) => re.test(o.output))
    ? 'connection_loss'
    : null;

/**
 * The process exited non-zero having emitted nothing at all. A worker that
 * dies before its first byte never started doing real work — treat it as a
 * transient infra fault. (`producedOutput` true is handled by the loudness
 * gate upstream and never reaches here.)
 */
const matchExitBeforeOutput: SignatureMatcher = (o) =>
  !o.producedOutput && o.code !== null && o.code !== 0
    ? 'exit_before_output'
    : null;

/**
 * Ordered signature table. First match wins. Ordering rationale:
 *   1. cli-config rename is checked before the generic ENOENT so a config-race
 *      ENOENT is tagged as the config race, not a missing binary.
 *   2. spawn ENOENT — a missing agent binary.
 *   3. connection loss — evidence lives in the streamed output.
 *   4. exit-before-output — the residual "died silent and non-zero" case.
 *
 * Appending a fifth matcher is a one-line push; no classifier rewiring.
 */
export const INFRA_SIGNATURES: SignatureMatcher[] = [
  matchCliConfigRename,
  matchSpawnEnoent,
  matchConnectionLoss,
  matchExitBeforeOutput,
];

/**
 * Classify a dead worker's attempt. Three ordered rules:
 *
 *   1. LOUDNESS GATE (ADR-2 / FR-4): `producedOutput && code !== 0` ⇒
 *      `work_failure`. Runs BEFORE any matcher — a worker that spoke and then
 *      failed is a real failure and can never be reclassified as infra.
 *   2. First matching `INFRA_SIGNATURES` entry ⇒
 *      `{ class: 'infra_failure', signature }`.
 *   3. Otherwise ⇒ `work_failure` (incl. a clean `code === 0` exit).
 */
export function classifyAttempt(o: SpawnOutcome): Classification {
  // Rule 1 — loudness invariant. A worker that produced output and then exited
  // non-zero is, by definition, a real work failure. This guard MUST precede
  // the signature table so no matcher can override it.
  if (o.producedOutput && o.code !== null && o.code !== 0) {
    return { class: 'work_failure' };
  }

  // Rule 2 — first infra signature to fire wins.
  for (const matcher of INFRA_SIGNATURES) {
    const signature = matcher(o);
    if (signature) {
      return { class: 'infra_failure', signature };
    }
  }

  // Rule 3 — no signature fired: a real outcome (e.g. a clean exit, or a
  // non-zero exit that doesn't match any known transient fault).
  return { class: 'work_failure' };
}

/**
 * Persists a classification to story-006-001's state surfaces: the
 * `attempt_class` column on the agent row AND the canonical
 * `attempt_classified` audit row carrying the signature/output evidence.
 *
 * The two writes are deliberately paired here so every consumer (the retry
 * controller's `spawnWithInfraRetry` seam, story-006-003) records both the
 * orthogonal column (ADR-1) and the audit detail with one call — they cannot
 * drift apart. `produced_output` is threaded through so the audit row reflects
 * the loudness evidence even on a `work_failure`.
 */
export function persistClassification(
  stores: { agents: AgentStore; audit: AuditLog },
  agentId: string,
  storyId: string,
  classification: Classification,
  outcome: Pick<SpawnOutcome, 'producedOutput'>,
  retryAttempt?: number
): void {
  stores.agents.setAttemptClass(agentId, classification.class);
  stores.audit.recordAttemptClassified(
    storyId,
    {
      attempt_class: classification.class,
      ...(classification.signature !== undefined
        ? { signature: classification.signature }
        : {}),
      ...(retryAttempt !== undefined ? { retry_attempt: retryAttempt } : {}),
      produced_output: outcome.producedOutput,
    },
    agentId
  );
}
