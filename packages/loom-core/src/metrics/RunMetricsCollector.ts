import type { LLMUsage } from '../llm/LLMClient.js';
import type {
  PhaseMetrics,
  RunMetricsInput,
  RunPhase,
  RunScope,
} from './types.js';

interface PhaseState {
  phase: RunPhase;
  model?: string;
  tokensInput: number;
  tokensOutput: number;
  tokensCached: number;
  tokensCacheCreation: number;
  billedTokens: number;
  costUsd: number;
  requestCount: number;
  wallMs: number;
  startTime?: number;
}

export class RunMetricsCollector {
  private phases = new Map<RunPhase, PhaseState>();
  private _currentPhase: RunPhase | undefined;
  private attribution: Partial<RunMetricsInput> = {};
  private approvedAt: number | undefined;
  private firstTokenAt: number | undefined;

  startPhase(phase: RunPhase): void {
    this._currentPhase = phase;
    const existing = this.phases.get(phase);
    if (existing) {
      // If the phase is already in-flight, accrue elapsed time before restarting.
      if (existing.startTime !== undefined) {
        existing.wallMs += Date.now() - existing.startTime;
      }
      existing.startTime = Date.now();
    } else {
      this.phases.set(phase, {
        phase,
        tokensInput: 0,
        tokensOutput: 0,
        tokensCached: 0,
        tokensCacheCreation: 0,
        billedTokens: 0,
        costUsd: 0,
        requestCount: 0,
        wallMs: 0,
        startTime: Date.now(),
      });
    }
  }

  endPhase(phase: RunPhase): void {
    const s = this.phases.get(phase);
    if (!s || s.startTime === undefined) return;
    s.wallMs += Date.now() - s.startTime;
    s.startTime = undefined;
  }

  currentPhase(): RunPhase | undefined {
    return this._currentPhase;
  }

  addUsage(u: LLMUsage, model?: string, phase?: RunPhase): void {
    const p = phase ?? this._currentPhase;
    if (!p) return;
    let s = this.phases.get(p);
    if (!s) {
      s = {
        phase: p,
        tokensInput: 0,
        tokensOutput: 0,
        tokensCached: 0,
        tokensCacheCreation: 0,
        billedTokens: 0,
        costUsd: 0,
        requestCount: 0,
        wallMs: 0,
      };
      this.phases.set(p, s);
    }
    if (model) s.model = model;
    s.tokensInput += u.inputTokens;
    s.tokensOutput += u.outputTokens;
    s.tokensCached += u.cacheReadTokens;
    s.tokensCacheCreation += u.cacheCreationTokens;
    s.billedTokens += u.inputTokens + u.outputTokens + u.cacheReadTokens + u.cacheCreationTokens;
    s.costUsd += u.costUsd;
    s.requestCount += u.requestCount;
  }

  markApproved(): void {
    this.approvedAt = Date.now();
  }

  markFirstToken(): void {
    this.firstTokenAt = Date.now();
  }

  setAttribution(a: Partial<RunMetricsInput>): void {
    this.attribution = { ...this.attribution, ...a };
  }

  build(): RunMetricsInput {
    const dispatchLatencyMs =
      this.approvedAt !== undefined && this.firstTokenAt !== undefined
        ? this.firstTokenAt - this.approvedAt
        : this.attribution.dispatchLatencyMs;

    const phases: PhaseMetrics[] = Array.from(this.phases.values()).map((s) => {
      const pm: PhaseMetrics = {
        phase: s.phase,
        tokensInput: s.tokensInput,
        tokensOutput: s.tokensOutput,
        tokensCached: s.tokensCached,
        tokensCacheCreation: s.tokensCacheCreation,
        billedTokens: s.billedTokens,
        requestCount: s.requestCount,
        wallMs: s.wallMs,
      };
      if (s.model !== undefined) pm.model = s.model;
      if (s.costUsd > 0) pm.costUsd = s.costUsd;
      return pm;
    });

    const result: RunMetricsInput = {
      scope: (this.attribution.scope ?? 'epic') as RunScope,
      retryCount: this.attribution.retryCount ?? 0,
      cleanRetryCount: this.attribution.cleanRetryCount ?? 0,
      autoRecoveryCount: this.attribution.autoRecoveryCount ?? 0,
      phases,
    };

    if (this.attribution.epicId !== undefined) result.epicId = this.attribution.epicId;
    if (this.attribution.storyId !== undefined) result.storyId = this.attribution.storyId;
    if (this.attribution.agentId !== undefined) result.agentId = this.attribution.agentId;
    if (this.attribution.intakeVerdict !== undefined) result.intakeVerdict = this.attribution.intakeVerdict;
    if (this.attribution.intakeKind !== undefined) result.intakeKind = this.attribution.intakeKind;
    if (this.attribution.storyCount !== undefined) result.storyCount = this.attribution.storyCount;
    if (this.attribution.outcome !== undefined) result.outcome = this.attribution.outcome;
    if (dispatchLatencyMs !== undefined) result.dispatchLatencyMs = dispatchLatencyMs;
    if (this.attribution.startedAt !== undefined) result.startedAt = this.attribution.startedAt;
    if (this.attribution.endedAt !== undefined) result.endedAt = this.attribution.endedAt;

    return result;
  }
}
