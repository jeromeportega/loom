import type {
  GateEvalCase,
  GateEvalConsumer,
  GateDeps,
  JudgeDeps,
  GateOutcome,
  JudgeOutcome,
  RunRecord,
} from './types.js';

export async function runGateEval<TCase extends GateEvalCase, TOut, TJudg>(
  cases: TCase[],
  consumer: Pick<GateEvalConsumer<TCase, TOut, TJudg, any>, 'runGate' | 'judge'>,
  deps: GateDeps & JudgeDeps,
): Promise<RunRecord<TOut, TJudg>[]> {
  const records: RunRecord<TOut, TJudg>[] = [];

  for (const c of cases) {
    let gate: GateOutcome<TOut>;
    try {
      gate = await consumer.runGate(c, deps);
    } catch (err) {
      gate = { status: 'failed', detail: err instanceof Error ? err.message : String(err) };
    }

    let judge: JudgeOutcome<TJudg>;
    if (gate.status === 'ok') {
      try {
        judge = await consumer.judge(c, gate.output, deps);
      } catch (err) {
        judge = {
          status: 'inconclusive',
          detail: err instanceof Error ? err.message : String(err),
        };
      }
    } else {
      judge = { status: 'skipped' };
    }

    records.push({ caseId: c.id, gate, judge });
  }

  return records;
}
