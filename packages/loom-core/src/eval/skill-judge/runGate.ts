import { SkillJudge, type JudgeResult, type SkillJudgeOptions } from '../../skills/SkillJudge.js';
import type { SkillManifest } from '../../skills/SkillStore.js';
import type { GateOutcome, GateDeps } from '../framework/types.js';
import type { SkillJudgeEvalCase } from './caseSchema.js';

export const DEFAULT_GATE_MODEL = 'claude-haiku-4-5-20251001';

const FAIL_OPEN_SCORE = 999;

const defaultFactory = (opts: SkillJudgeOptions): SkillJudge => new SkillJudge(opts);

/**
 * Drives the production SkillJudge over one eval case, observe-only.
 * Maps the fail-open sentinel (score===999) to {status:'failed',detail:'fail-open'}
 * so a broken gate cannot masquerade as a genuine accept (ADR-005).
 *
 * _judgeFactory is a TEST-ONLY seam; the production path uses the default ctor.
 */
export async function runSkillJudgeGate(
  c: SkillJudgeEvalCase,
  deps: GateDeps,
  _judgeFactory: (o: SkillJudgeOptions) => SkillJudge = defaultFactory,
): Promise<GateOutcome<JudgeResult>> {
  try {
    const judge = _judgeFactory({ llm: deps.llm, model: deps.gateModel });
    const result = await judge.judge(
      c.skill_md,
      // SkillJudge.judge uses only name+description from manifests; eval cases carry that subset
      c.existing_skills as unknown as SkillManifest[],
    );
    if (result.score === FAIL_OPEN_SCORE) {
      return { status: 'failed', detail: 'fail-open' };
    }
    return { status: 'ok', output: result };
  } catch (err) {
    return {
      status: 'failed',
      detail: err instanceof Error ? err.message : String(err),
    };
  }
}
