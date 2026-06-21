export interface SkillJudgeJudgment {
  decision_correct:    boolean;
  band_in_range:       boolean;
  independent_verdict: 'accept' | 'reject';
  band_defensible:     boolean;
  reason:              string;
}
