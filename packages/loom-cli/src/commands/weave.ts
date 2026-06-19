import type { CommandDescription } from '../describe/schema.js';
import path from 'node:path';
import type { LLMClient, ClassifyResult } from '@loom-ai/core';
import { PolicyEngine } from '@loom-ai/core';
import { runEpic } from './epic.js';
import type { IntakeStage } from './epic.js';

type RunEpicOpts = NonNullable<Parameters<typeof runEpic>[1]>;
type RunEpicFn = (brief: string, opts?: RunEpicOpts) => Promise<void>;
type ClassifyFn = (
  brief: string,
  opts: { llm: LLMClient; model: string; timeoutMs?: number }
) => Promise<ClassifyResult>;

/**
 * Phase 0.5: wire intake classification before the epic planner.
 *
 * Reads policy from the current loom directory to build the intake stage
 * (model + timeout), then calls runEpic with that stage so classifyIntake
 * fires right after epic-id reservation. Classification is best-effort and
 * observe-only — failure never blocks or aborts the weave (ADR-009/010).
 *
 * @param opts._runEpic      Test seam — inject a spy for runEpic without ESM
 *   module-binding issues. Production callers omit this.
 * @param opts._classifyIntake  Test seam — inject a stub for classifyIntake;
 *   forwarded into runEpic's opts so the real call can be replaced in tests.
 */
export async function runWeave(
  brief: string,
  opts?: {
    force?: boolean;
    verbose?: boolean;
    llm?: LLMClient;
    _runEpic?: RunEpicFn;
    _classifyIntake?: ClassifyFn;
  }
): Promise<void> {
  const { _runEpic, _classifyIntake, ...epicOpts } = opts ?? {};
  const epicRunner: RunEpicFn = _runEpic ?? runEpic;

  // Build the intake stage from policy. PolicyEngine.load returns defaults
  // when policy.yaml is absent, so this never throws for a missing file.
  // runEpic exits cleanly if loom is not initialized.
  // timeoutMs will be resolveIntakeTimeoutMs(policy) after story-022-002 merges.
  const loomDir = path.join(process.cwd(), '.loom');
  const policy = PolicyEngine.load(loomDir).policyData;
  const intake: IntakeStage = {
    model: policy.agents.triage_model,
    timeoutMs: 180_000,
  };

  const epicArgs: RunEpicOpts = { ...epicOpts, intake };
  if (_classifyIntake !== undefined) epicArgs._classifyIntake = _classifyIntake;
  await epicRunner(brief, epicArgs);
}

export const spec: CommandDescription = {
  name: 'weave',
  summary: 'Plan an epic from a brief using the same Analyst→PM→Architect pipeline as `loom epic`',
  whenToUse: 'Use when you have a clear feature idea to plan via the weave intake path. Pass a one-paragraph brief; loom runs the planning pipeline and outputs a structured epic YAML.',
  arguments: [
    { name: 'brief', type: 'string', required: true, description: 'One paragraph describing what to build' },
  ],
  options: [
    { name: '--force', type: 'boolean', description: 'Skip the brief-quality gate for this invocation (critique still produced and audit-logged)', changesOutputShape: false },
    { name: '--verbose', type: 'boolean', description: 'Stream live persona output to the terminal', changesOutputShape: true },
  ],
  output: { text: 'Epic id and summary of planned stories after the planning pipeline completes' },
  examples: [
    { command: 'loom weave "Add OAuth2 login with GitHub"', description: 'Plan a new epic from a brief' },
    { command: 'loom weave "Refactor auth module" --force', description: 'Plan without the brief quality gate' },
    { command: 'loom weave "Add OAuth2 login with GitHub" --verbose', description: 'Stream live persona output while planning' },
  ],
  exitCodes: [
    { code: 0, meaning: 'Epic planned successfully' },
    { code: 1, meaning: 'loom not initialized, brief quality gate failed, or LLM error' },
    { code: 3, meaning: 'Brief passed with optional clarifications — re-run with --force to plan as-is' },
  ],
  errors: ['loom is not initialized — run `loom init` first', 'Brief quality score too low — revise or use --force', 'ANTHROPIC_API_KEY not set'],
  relationships: { prerequisites: ['init'], nextSteps: ['approve', 'artifacts', 'status'] },
};
