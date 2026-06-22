import type { AuditLog, IntakeVerdict, EffectiveRouting } from '@loom-ai/core';
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
  /** Used by the confirm path (story-045-003) for stdin interaction. */
  isTTY: boolean;
  /** TODO(045-004): wire recordIntakeRouted here for confirm-path provenance. */
  audit: AuditLog;
  /** TODO(045-004): wire recordIntakeRouted here for confirm-path provenance. */
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

  switch (level) {
    case 'advisory':
      return printAndRoute(verdict, out);

    case 'confirm':
      // 045-003 wires confirmRouting() in the isTTY branch.
      // 045-004 wires recordIntakeRouted() for audit provenance (audit + epicId seam).
      // Until those stories land, degrade to advisory so planning is never blocked (ADR-004).
      if (!opts.isTTY) {
        out.write('  [warn] intake_routing=confirm: non-interactive terminal — routing as advisory instead\n');
      } else {
        out.write('  [warn] intake_routing=confirm not yet active — routing as advisory (interactive confirmation available in a later release)\n');
      }
      // audit + epicId: seam parameters consumed by story-045-004 (recordIntakeRouted)
      void opts.audit; void opts.epicId;
      return printAndRoute(verdict, out);

    default: {
      const _: never = level;
      void _;
      return undefined;
    }
  }
}

/** Print the full classification surface (non-blocking) and return EffectiveRouting. */
function printAndRoute(verdict: IntakeVerdict, out: NodeJS.WritableStream): EffectiveRouting {
  out.write(`\n  Intake classification: ${verdict.type} / ${verdict.size} (confidence: ${verdict.confidence})\n`);
  out.write(`  Rationale: ${verdict.rationale}\n\n`);
  return {
    type:       verdict.type,
    size:       verdict.size,
    confidence: verdict.confidence,
    source:     'classifier',
  };
}
