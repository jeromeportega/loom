import path from 'node:path';
import { LessonExtractor } from '../../findings/LessonExtractor.js';
import type { Lesson } from '../../findings/lesson.js';
import type { GateOutcome, GateDeps } from '../framework/types.js';
import type { LessonExtractorCase } from './caseSchema.js';

/** Resolves the production SKILL.md path for the lesson-extractor. */
export function resolveLessonExtractorSkillMd(projectRoot: string): string {
  return path.resolve(projectRoot, 'skills/lesson-extractor/SKILL.md');
}

/**
 * Drives the production LessonExtractor over one eval case, observe-only (ADR-002).
 * Never reimplements extraction — imports and constructs the real class.
 */
export async function runLessonExtractorGate(
  c: LessonExtractorCase,
  deps: GateDeps,
  opts: { projectRoot: string },
): Promise<GateOutcome<Lesson[]>> {
  try {
    const extractor = new LessonExtractor({
      llm: deps.llm,
      model: deps.gateModel,
      skillMdPath: resolveLessonExtractorSkillMd(opts.projectRoot),
    });
    const output = await extractor.extract(c.telemetry);
    return { status: 'ok', output };
  } catch (e) {
    return { status: 'failed', detail: String(e) };
  }
}
