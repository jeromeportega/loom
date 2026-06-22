import type { AuditLog, IntakeVerdict, EffectiveRouting } from '@loom-ai/core';
import type { IntakeClassificationResult } from './recordIntakeClassification.js';
import { confirmRouting } from './confirmRouting.js';
import { recordIntakeRouted } from './recordIntakeRouted.js';

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
  /** Injected input stream for confirm-path interaction. Defaults to process.stdin. */
  input?: NodeJS.ReadableStream;
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
      if (!opts.isTTY) {
        // Non-interactive degrade (ADR-004): warn loudly and route as advisory so
        // headless/CI planning is never stalled (mode:'confirm-degraded-advisory').
        out.write('  [warn] intake_routing=confirm: non-interactive terminal — routing as advisory instead\n');
        recordIntakeRouted(opts.audit, opts.epicId, {
          mode:       'confirm-degraded-advisory',
          decision:   'accepted',
          original:   { type: verdict.type, size: verdict.size },
          routed:     { type: verdict.type, size: verdict.size },
          confidence: verdict.confidence,
        });
        return printAndRoute(verdict, out);
      }
      // Interactive path: prompt operator to accept or override (AC1, AC3).
      return resolveConfirm(verdict, out, opts.input, opts.audit, opts.epicId);

    default: {
      const _: never = level;
      void _;
      return undefined;
    }
  }
}

/**
 * Interactive confirm path: delegate to confirmRouting, record provenance, then
 * build EffectiveRouting. source:'operator-override' when type or size changed.
 */
async function resolveConfirm(
  verdict: IntakeVerdict,
  out: NodeJS.WritableStream,
  input: NodeJS.ReadableStream | undefined,
  audit: AuditLog,
  epicId: string,
): Promise<EffectiveRouting> {
  const result = await confirmRouting(verdict, { out, input });
  recordIntakeRouted(audit, epicId, {
    mode:       'confirm',
    decision:   result.decision,
    original:   { type: verdict.type, size: verdict.size },
    routed:     { type: result.type,  size: result.size },
    confidence: verdict.confidence,
  });
  return {
    type:       result.type,
    size:       result.size,
    confidence: verdict.confidence,
    source:     result.decision === 'overridden' ? 'operator-override' : 'classifier',
  };
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
