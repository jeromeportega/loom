import { runGateEval } from './framework/runGateEval.js';
import type { GateOutcome, JudgeOutcome as FrameworkJudgeOutcome } from './framework/types.js';
import type { LLMClient } from '../llm/LLMClient.js';
import type { IntakeVerdict, ClassifyResult } from '../intake/IntakeClassifier.js';
import type {
  IntakeEvalCase,
  IntakeJudgeLike,
  IntakeRunRecord,
  JudgeOutcome as LegacyJudgeOutcome,
  IntakeJudgeResult,
} from './intakeEvalTypes.js';
import { createIntakeConsumer } from './intakeConsumer.js';

export interface RunIntakeEvalDeps {
  llm: LLMClient;
  classifierModel: string;
  judgeModel: string; // reserved: story-021-003 will forward this to the real IntakeJudge constructor
  judge: IntakeJudgeLike;
}

// ── Translation helpers ────────────────────────────────────────────────────────

/**
 * Translates a framework GateOutcome<IntakeVerdict> back to a legacy ClassifyResult.
 * The reason code is encoded in the detail string as "<reason>:<detail>" by runGate.
 */
function gateToClassifier(gate: GateOutcome<IntakeVerdict>): ClassifyResult {
  if (gate.status === 'ok') return { ok: true, verdict: gate.output };
  const colonIdx = gate.detail.indexOf(':');
  const rawReason = colonIdx >= 0 ? gate.detail.slice(0, colonIdx) : 'llm_error';
  const detail = colonIdx >= 0 ? gate.detail.slice(colonIdx + 1) : gate.detail;
  const validReasons = ['llm_error', 'timeout', 'invalid_output'] as const;
  const reason = (validReasons as readonly string[]).includes(rawReason)
    ? (rawReason as (typeof validReasons)[number])
    : 'llm_error';
  return { ok: false, reason, detail };
}

/**
 * Translates a framework JudgeOutcome<IntakeJudgeResult> to the legacy JudgeOutcome.
 * Framework 'skipped' (gate failed → judge not called) maps to legacy 'inconclusive'
 * with a detail that includes the classifier reason, matching legacy runIntakeEval behaviour.
 */
function judgeToLegacy(
  judge: FrameworkJudgeOutcome<IntakeJudgeResult>,
  classifier: ClassifyResult,
): LegacyJudgeOutcome {
  if (judge.status === 'ok') return { status: 'ok', result: judge.judgment };
  if (judge.status === 'inconclusive') return { status: 'inconclusive', detail: judge.detail };
  // skipped — gate failed, so classifier.ok is always false here
  return { status: 'inconclusive', detail: `classifier_failure: ${classifier.ok ? 'unknown' : classifier.reason}` };
}

// ── Public API ─────────────────────────────────────────────────────────────────

/**
 * Runs the Phase 0 IntakeClassifier on every case, injecting the judge for
 * per-case grading. Exactly one classifier call and one judge call per case
 * (NFR-1, FR-4, FR-6). When the classifier fails, the judge field is set to
 * inconclusive without calling the judge (no verdict to grade).
 *
 * The per-case loop is delegated to the framework's runGateEval; this function
 * adapts the injected deps into framework consumer plug-points and translates
 * the result back to IntakeRunRecord[] for backward compat (FR-5).
 */
export async function runIntakeEval(
  cases: IntakeEvalCase[],
  deps: RunIntakeEvalDeps,
): Promise<IntakeRunRecord[]> {
  const consumer = createIntakeConsumer();
  const caseById = new Map(cases.map(c => [c.id, c]));

  const frameRecords = await runGateEval(
    cases,
    {
      runGate: (c, gateDeps) => consumer.runGate(c, gateDeps),

      async judge(c, output, _judgeDeps): Promise<FrameworkJudgeOutcome<IntakeJudgeResult>> {
        const outcome = await deps.judge.judge(c.brief, output);
        if (outcome.status === 'ok') return { status: 'ok', judgment: outcome.result };
        return { status: 'inconclusive', detail: outcome.detail };
      },
    },
    { llm: deps.llm, gateModel: deps.classifierModel, judgeModel: deps.judgeModel },
  );

  return frameRecords.map(r => {
    const evalCase = caseById.get(r.caseId);
    if (!evalCase) throw new Error(`runIntakeEval: no case found for caseId "${r.caseId}"`);
    const classifier = gateToClassifier(r.gate);
    const judge = judgeToLegacy(r.judge, classifier);
    return { case: evalCase, classifier, judge };
  });
}

/**
 * Computes per-axis exact-match accuracy of classifier verdicts vs human labels.
 * Classifier failures are excluded from the scored count and never credited as
 * correct (FR-5).
 */
export function computeAxisAccuracy(
  records: IntakeRunRecord[],
  axis: 'type' | 'size',
): { correct: number; scored: number } {
  let correct = 0;
  let scored = 0;
  for (const rec of records) {
    if (!rec.classifier.ok) continue; // classifier failure: excluded (FR-5)
    const predicted = rec.classifier.verdict[axis];
    const labeled = rec.case.label[axis];
    scored++;
    if (predicted === labeled) correct++;
  }
  return { correct, scored };
}
