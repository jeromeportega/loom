import type { BriefRefinement } from '../brief/types.js';
import type { GrillingDecision } from './types.js';

export function seedDecisionTree(refinerOutput: BriefRefinement): GrillingDecision[] {
  const decisions: GrillingDecision[] = [];

  for (let i = 0; i < refinerOutput.blocking_gaps.length; i++) {
    decisions.push({
      id: `gap-${i}`,
      text: refinerOutput.blocking_gaps[i],
      blast_radius: 'high',
      prerequisites: [],
      recommendation: 'Clarify this requirement explicitly before planning proceeds.',
      alternatives: [
        { label: 'A: Define explicitly', tradeoff: 'Adds clarity but requires stakeholder input.' },
        { label: 'B: Accept ambiguity and constrain later', tradeoff: 'Faster start but risks scope creep.' },
      ],
      is_lookup_able: false,
    });
  }

  const flaggedAssumptions = refinerOutput.delta.flagged_assumptions;
  for (let i = 0; i < flaggedAssumptions.length; i++) {
    decisions.push({
      id: `assumption-${i}`,
      text: flaggedAssumptions[i],
      blast_radius: 'low',
      prerequisites: [],
      recommendation: 'Accept this assumption as stated.',
      alternatives: [
        { label: 'A: Accept as-is', tradeoff: 'No additional work required.' },
        { label: 'B: Challenge and refine', tradeoff: 'Increases precision but adds planning time.' },
      ],
      is_lookup_able: false,
    });
  }

  // Gap ids that exist in this run, used for prerequisite inference.
  // Word-boundary regex prevents gap-1 from matching inside gap-10, gap-11, etc.
  const gapIds = refinerOutput.blocking_gaps.map((_, i) => `gap-${i}`);

  for (let i = 0; i < refinerOutput.questions.length; i++) {
    const text = refinerOutput.questions[i];
    const referencedGaps = gapIds.filter(id => new RegExp(`\\b${id}\\b`).test(text));
    const blastRadius = referencedGaps.length > 0 ? 'high' : 'low';

    decisions.push({
      id: `question-${i}`,
      text,
      blast_radius: blastRadius,
      prerequisites: referencedGaps,
      recommendation: blastRadius === 'high'
        ? 'Resolve the referenced gap before answering this question.'
        : 'Answer this question to refine the plan.',
      alternatives: [
        { label: 'A: Answer explicitly', tradeoff: 'Provides clarity for planning.' },
        { label: 'B: Defer to implementation', tradeoff: 'Allows faster planning but may require revisiting.' },
      ],
      is_lookup_able: true,
    });
  }

  return kahnsSort(decisions);
}

function kahnsSort(decisions: GrillingDecision[]): GrillingDecision[] {
  const byId = new Map(decisions.map(d => [d.id, d]));
  // inDegree tracks how many prerequisites remain unresolved
  const inDegree = new Map(decisions.map(d => [d.id, d.prerequisites.length]));
  // dependents maps each node to the list of nodes that depend on it
  const dependents = new Map<string, string[]>(decisions.map(d => [d.id, []]));

  for (const d of decisions) {
    for (const prereq of d.prerequisites) {
      dependents.get(prereq)?.push(d.id);
    }
  }

  const queue: string[] = decisions
    .filter(d => d.prerequisites.length === 0)
    .map(d => d.id);

  const result: GrillingDecision[] = [];

  while (queue.length > 0) {
    const id = queue.shift()!;
    result.push(byId.get(id)!);

    for (const dep of dependents.get(id) ?? []) {
      const remaining = (inDegree.get(dep) ?? 0) - 1;
      inDegree.set(dep, remaining);
      if (remaining === 0) {
        queue.push(dep);
      }
    }
  }

  if (result.length !== decisions.length) {
    throw new Error(`Cycle detected in decision tree: processed ${result.length}/${decisions.length} nodes`);
  }

  return result;
}
