import type { CoreMetrics, RunRecord } from './types.js';

export function coreMetrics(records: RunRecord<any, any>[]): CoreMetrics {
  const totalCases = records.length;
  const gateFailures = records.filter((r) => r.gate.status === 'failed').length;
  const gateFailureRate = totalCases === 0 ? 0 : gateFailures / totalCases;

  // judgeInconclusive only counts cases where the judge actually ran (gate ok) and was inconclusive.
  // Gate-failed cases produce judge.status='skipped', not 'inconclusive', so they never appear here.
  const judgeInconclusive = records.filter((r) => r.judge.status === 'inconclusive').length;
  const judgeInconclusiveDenominator = totalCases - gateFailures;
  const judgeInconclusiveRate =
    judgeInconclusiveDenominator === 0 ? 0 : judgeInconclusive / judgeInconclusiveDenominator;

  const scoredCases = records.filter(
    (r) => r.gate.status === 'ok' && r.judge.status === 'ok',
  ).length;

  return {
    totalCases,
    scoredCases,
    gateFailures,
    gateFailureRate,
    judgeInconclusive,
    judgeInconclusiveRate,
  };
}
