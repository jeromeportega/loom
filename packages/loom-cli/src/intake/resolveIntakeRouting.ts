import type { AuditLog, EffectiveRouting } from '@loom-ai/core';
import type { IntakeClassificationResult } from './recordIntakeClassification.js';

/**
 * Routing brain: given a classification result and the policy level, decides
 * whether and how to inject routing into the planner.
 *
 * Returns `undefined` for the off-path AND when classification failed → the
 * planner runs byte-identically to today (NFR-1, legacy path).
 *
 * Takes injected seams so the confirm path (story-045-003) and audit path
 * (story-045-004) can plug in without re-architecting the dispatcher.
 */
export async function resolveIntakeRouting(opts: {
  classification: IntakeClassificationResult;
  level: 'off' | 'advisory' | 'confirm';
  isTTY: boolean;
  audit: AuditLog;
  epicId: string;
  /** Injected output stream for testable printing. Defaults to process.stdout. */
  out?: NodeJS.WritableStream;
}): Promise<EffectiveRouting | undefined> {
  const { classification, level } = opts;

  // off → always skip routing (legacy path, byte-identical planner output)
  if (level === 'off') return undefined;

  // classification failed → skip routing; never a partial route
  if (!classification.ok) return undefined;

  const { verdict } = classification;
  const out = opts.out ?? process.stdout;

  if (level === 'advisory') {
    // Print the full classification surface (non-blocking — no stdin read)
    out.write(`\n  Intake classification: ${verdict.type} / ${verdict.size} (confidence: ${verdict.confidence})\n`);
    out.write(`  Rationale: ${verdict.rationale}\n\n`);

    return {
      type:       verdict.type,
      size:       verdict.size,
      confidence: verdict.confidence,
      source:     'classifier',
    };
  }

  // confirm path: 045-003 wires confirmRouting() here (isTTY branch) and
  // 045-004 wires recordIntakeRouted() for provenance. Until then, degrade
  // to advisory so planning proceeds without blocking (ADR-004).
  if (level === 'confirm') {
    out.write(`\n  Intake classification: ${verdict.type} / ${verdict.size} (confidence: ${verdict.confidence})\n`);
    out.write(`  Rationale: ${verdict.rationale}\n\n`);

    return {
      type:       verdict.type,
      size:       verdict.size,
      confidence: verdict.confidence,
      source:     'classifier',
    };
  }

  return undefined;
}
