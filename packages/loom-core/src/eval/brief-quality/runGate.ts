import { BriefRefiner } from '../../brief/BriefRefiner.js';
import type { BriefRefinement } from '../../brief/types.js';
import type { LLMClient } from '../../llm/LLMClient.js';
import type { GateOutcome, GateDeps } from '../framework/types.js';
import type { BriefQualityCase } from './caseSchema.js';

interface RefinerLike {
  refine(brief: string): Promise<BriefRefinement>;
}

type RefinerFactory = (opts: {
  projectRoot: string;
  llm: LLMClient;
  model: string;
}) => RefinerLike;

const defaultRefinerFactory: RefinerFactory = (opts) => new BriefRefiner(opts);

export async function runBriefQualityGate(
  c: BriefQualityCase,
  deps: GateDeps,
  projectRoot: string,
  _refinerFactory: RefinerFactory = defaultRefinerFactory,
): Promise<GateOutcome<BriefRefinement>> {
  try {
    const refiner = _refinerFactory({ projectRoot, llm: deps.llm, model: deps.gateModel });
    const output = await refiner.refine(c.brief);
    return { status: 'ok', output };
  } catch (err) {
    return {
      status: 'failed',
      detail: err instanceof Error ? err.message : String(err),
    };
  }
}
