export const RUN_METRICS_SCHEMA_VERSION = 1;

export type RunScope   = 'epic' | 'standalone_story' | 'epic_story';
export type RunPhase   =
  | 'analyst' | 'pm' | 'architect' | 'standalone_plan'
  | 'dispatch' | 'worker' | 'gate' | 'finalize';
export type RunOutcome = 'done' | 'failed' | 'gate_passed' | 'gate_failed';

export interface PhaseMetrics {
  phase: RunPhase;
  model?: string;
  tokensInput: number;          // <- LLMUsage.inputTokens
  tokensOutput: number;         // <- LLMUsage.outputTokens
  tokensCached: number;         // <- LLMUsage.cacheReadTokens
  tokensCacheCreation: number;  // <- LLMUsage.cacheCreationTokens
  billedTokens: number;         // raw volume sum: input+output+cached+cacheCreation (NOT billing-weighted; see costUsd)
  costUsd?: number;             // <- LLMUsage.costUsd (0/undefined on cursor-cli path)
  requestCount: number;         // <- LLMUsage.requestCount
  wallMs: number;
}

export interface RunMetricsInput {
  scope: RunScope;
  epicId?: string;
  storyId?: string;
  agentId?: string;
  intakeVerdict?: 'story' | 'epic';
  intakeKind?: string;
  storyCount?: number;
  retryCount: number;
  cleanRetryCount: number;
  autoRecoveryCount: number;
  outcome?: RunOutcome;
  dispatchLatencyMs?: number;
  startedAt?: string;           // ISO 8601
  endedAt?: string;
  phases: PhaseMetrics[];
}

export interface RunMetricsRecord extends RunMetricsInput {
  id: number;
  createdAt: string;
  totalWallMs?: number;
  billedTokensTotal?: number;
  costUsd?: number;
}

export interface PhaseMetricsRecord extends PhaseMetrics {
  id: number;
  runId: number;
}
