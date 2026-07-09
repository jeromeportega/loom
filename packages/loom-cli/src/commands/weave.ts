import type { CommandDescription } from '../describe/schema.js';
import type { LLMClient } from '@loom-ai/core';
import { runEpic } from './epic.js';

type RunEpicOpts = NonNullable<Parameters<typeof runEpic>[1]>;
type RunEpicFn = (brief: string, opts?: RunEpicOpts) => Promise<void>;

/**
 * Thin pass-through to runEpic. Runs the identical brief-quality gate,
 * Analyst → PM → Architect planner, and execution path. The intake
 * classification side-effect is wired inside runEpic (ADR-002).
 *
 * @param opts._runEpic  Test seam — inject a spy for runEpic without ESM
 *   module-binding issues. Production callers omit this.
 */
export async function runWeave(
  brief: string,
  opts?: {
    force?: boolean;
    verbose?: boolean;
    llm?: LLMClient;
    _runEpic?: RunEpicFn;
  }
): Promise<void> {
  const { _runEpic, ...epicOpts } = opts ?? {};
  const epicRunner: RunEpicFn = _runEpic ?? runEpic;
  await epicRunner(brief, epicOpts);
}

export const spec: CommandDescription = {
  name: 'weave',
  summary: 'Plan an epic from a brief using the Analyst→PM→Architect pipeline',
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
