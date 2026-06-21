import type { LLMClient } from '../llm/index.js';
import { SkillStore } from '../skills/index.js';
import { extractJsonBlock } from '../planner/util.js';
import type { BriefRefinement } from './types.js';

export interface BriefRefinerOptions {
  projectRoot: string;
  llm: LLMClient;
  /**
   * Model id for the refinement call. Entry points resolve this with
   * modelFor(policy, 'planning') (ADR-006): refinement is the front door of
   * the planning pipeline and its judgment (ready + quality_score) gates the
   * planner, so it runs on the planning-tier model — never
   * policy.agents.model.
   */
  model: string;
}

/**
 * quality_score when the refinement call failed outright (transport error or
 * unparseable output with nothing to salvage). Fail closed: we know nothing
 * about the brief, so vouch for nothing.
 */
export const FALLBACK_QUALITY_SCORE = 0;

/**
 * quality_score when a truncated response was salvaged. The partial
 * refined_brief is preserved for the user, but the model's actual judgment
 * (ready, quality_score) never arrived — so the result is fail-closed:
 * ready: false and a score low enough that no sane threshold passes it.
 * Salvaged-but-good briefs now refuse instead of pass; that is the accepted
 * cost of never vouching for unparsed content.
 */
export const SALVAGE_QUALITY_SCORE = 3;

const FALLBACK_SKILL =
  'You are a senior staff engineer helping a developer turn a rough idea into ' +
  'a focused brief ready for autonomous planning. Surface ambiguity, missing ' +
  'scope (error handling, migration, observability, edge cases), and the ' +
  'untestable. Be specific. Trim, do not embellish.';

const JSON_SCHEMA_INSTRUCTIONS = [
  'Respond ONLY with one ```json fenced block matching this exact schema:',
  '',
  '```json',
  '{',
  '  "ready": boolean,            // true if the brief is concrete enough to plan',
  '  "quality_score": number,     // holistic 0-10: how ready this brief is for autonomous planning, judged as a whole — NOT a count of critique items',
  '  "refined_brief": string,     // omit ONLY if the input is too underspecified for any honest draft',
  '  "critique": {',
  '    "strong_points": [string],',
  '    "ambiguities": [string],',
  '    "missing_scope": [string],',
  '    "untestable_claims": [string],',
  '    "hidden_complexity": [string]',
  '  },',
  '  "questions": [string],       // empty when ready=true; ordered by importance otherwise',
  '  "delta": {',
  '    "added_sections": [string],         // section headings you added that the user did not have',
  '    "clarifications": [{ "from": string, "to": string }],',
  '    "flagged_assumptions": [string]     // things you had to assume; user should review',
  '  }',
  '}',
  '```',
  '',
  'Rules:',
  '- "ready" is true only when every critique array except strong_points is acceptably small AND the brief is something the planner could decompose without inventing requirements.',
  '- If ready=false, "questions" must be non-empty.',
  '- "refined_brief" is markdown (no preamble, start at the first `#`). Tag assumptions with `[ASSUMPTION]`.',
  '- Every "delta.clarifications" entry must reference text actually in the original or actually in your refined_brief.',
  '- Skip the refined_brief entirely if the input is so vague that drafting would be invention. Set ready=false and produce a questions list.',
].join('\n');

/**
 * Single-call structured refinement: takes a rough brief, returns the
 * structured critique + delta + optional refined draft. Designed to be the
 * brain behind `loom brief` (CLI) and `loom_refine_brief` (MCP tool).
 *
 * Cost: one Sonnet call (~10s); session-based by default.
 *
 * Robust to malformed model output: a missing or unparseable JSON block
 * falls back to a `ready=false` shape with the raw text in the
 * critique.ambiguities field, so a chat client always gets a structured
 * response and can degrade gracefully.
 */
export class BriefRefiner {
  constructor(private opts: BriefRefinerOptions) {}

  async refine(rough: string): Promise<BriefRefinement> {
    const skillStore = new SkillStore({ projectRoot: this.opts.projectRoot });
    const skillBody = skillStore.load('loom-brief-builder') ?? FALLBACK_SKILL;

    const systemText = [skillBody, '', JSON_SCHEMA_INSTRUCTIONS].join('\n');
    const userMsg = [
      "Here is the developer's rough brief. Apply the discipline above and",
      'respond with the JSON object only.',
      '',
      '---',
      rough.trim(),
    ].join('\n');

    let response;
    try {
      response = await this.opts.llm.complete({
        model: this.opts.model,
        system: [{ text: systemText, cache: true }],
        messages: [{ role: 'user', content: userMsg }],
        maxTokens: 8192,
        nonAgentic: { excludeDynamicSections: true },
      });
    } catch (err) {
      return fallback(rough, `refinement call failed: ${(err as Error).message}`);
    }

    try {
      const parsed = extractJsonBlock(response.text) as Partial<BriefRefinement>;
      return normalize(parsed, rough);
    } catch (err) {
      // Salvage path. The refiner's output is mostly a long multi-paragraph
      // `refined_brief` string; the CLI backend periodically truncates the
      // response mid-string when its output-token budget is hit, leaving an
      // unterminated JSON document that neither strict nor tolerant parsing
      // can recover. The user's brief is fine — the failure is downstream
      // plumbing — so degrading to "no refinement" would penalise them for
      // an infra hiccup. Instead, regex-extract whatever partial
      // refined_brief came through and proceed with an empty critique.
      const salvaged = salvagePartialRefinedBrief(response.text);
      if (salvaged) {
        // Fail closed: the partial refined_brief is preserved for the user,
        // but the model's actual ready/quality_score judgment never arrived,
        // so the salvage cannot vouch for the brief — ready: false and
        // SALVAGE_QUALITY_SCORE keep it below any sane gate threshold.
        return normalize(
          {
            ready: false,
            quality_score: SALVAGE_QUALITY_SCORE,
            refined_brief: salvaged,
            critique: {
              strong_points: [],
              ambiguities: [
                'Refiner response was truncated by the backend; the full critique is unavailable. Re-run for a complete refinement pass.',
              ],
              missing_scope: [],
              untestable_claims: [],
              hidden_complexity: [],
            },
          },
          rough
        );
      }
      return fallback(rough, `model output not parseable as JSON: ${(err as Error).message}`);
    }
  }
}

/**
 * Pulls the partial `refined_brief` value out of an unterminated JSON
 * response. The regex matches the key, optional whitespace, opening quote,
 * then any characters up to either the closing quote OR end-of-input. Closing
 * quote detection treats `\"` as an in-string escape rather than the
 * terminator. Returns null if no recognisable partial exists.
 *
 * Exported for unit testing.
 */
export function salvagePartialRefinedBrief(text: string): string | null {
  // Find the key, then walk the string body manually so we can stop at an
  // unescaped closing quote OR run off the end (truncated case).
  const keyMatch = text.match(/"refined_brief"\s*:\s*"/);
  if (!keyMatch) return null;
  const start = keyMatch.index! + keyMatch[0].length;
  let body = '';
  let escaped = false;
  for (let i = start; i < text.length; i++) {
    const c = text[i];
    if (escaped) {
      body += c;
      escaped = false;
      continue;
    }
    if (c === '\\') {
      body += c;
      escaped = true;
      continue;
    }
    if (c === '"') break; // string properly closed
    body += c;
  }
  if (body.length === 0) return null;
  // If the input was truncated mid-escape, the loop exits with escaped=true
  // and an orphan trailing `\` in body — drop it so JSON.parse doesn't choke.
  if (escaped) body = body.slice(0, -1);
  // Use JSON.parse on the body-wrapped-as-string to decode the escapes
  // (`\n`, `\t`, `\"`, `\\`, `\uXXXX`, …) by the JSON spec rather than a
  // bespoke replace chain. If even that fails (e.g. a stray `\u` with too
  // few hex digits at the truncation boundary), drop the suspect trailing
  // characters and retry; on total failure, return the raw body so the
  // caller at least has the un-decoded markdown.
  for (let trim = 0; trim <= 6 && trim < body.length; trim++) {
    try {
      return JSON.parse('"' + body.slice(0, body.length - trim) + '"') as string;
    } catch {
      // try shaving one more character off the tail
    }
  }
  return body;
}

/**
 * Validates / coerces the model's output into a fully-populated
 * BriefRefinement. Missing arrays default to empty; missing booleans default
 * to false (conservative: forces the operator to acknowledge). quality_score
 * is the model's own holistic judgment, clamped to [0,10]; a missing or
 * non-numeric score maps to 0 (fail closed).
 */
function normalize(raw: Partial<BriefRefinement>, original: string): BriefRefinement {
  const critique = (raw.critique ?? {}) as Partial<BriefRefinement['critique']>;
  const delta = (raw.delta ?? {}) as Partial<BriefRefinement['delta']>;
  const normalizedCritique = {
    strong_points: asStringArray(critique.strong_points),
    ambiguities: asStringArray(critique.ambiguities),
    missing_scope: asStringArray(critique.missing_scope),
    untestable_claims: asStringArray(critique.untestable_claims),
    hidden_complexity: asStringArray(critique.hidden_complexity),
  };
  return {
    ready: typeof raw.ready === 'boolean' ? raw.ready : false,
    original,
    refined_brief:
      typeof raw.refined_brief === 'string' && raw.refined_brief.trim().length > 0
        ? raw.refined_brief
        : undefined,
    critique: normalizedCritique,
    questions: asStringArray(raw.questions),
    quality_score: clampScore(raw.quality_score),
    delta: {
      added_sections: asStringArray(delta.added_sections),
      clarifications: Array.isArray(delta.clarifications)
        ? delta.clarifications.filter(
            (c): c is { from: string; to: string } =>
              !!c && typeof c === 'object' && typeof (c as { from?: unknown }).from === 'string' && typeof (c as { to?: unknown }).to === 'string'
          )
        : [],
      flagged_assumptions: asStringArray(delta.flagged_assumptions),
    },
  };
}

function clampScore(v: unknown): number {
  if (typeof v !== 'number' || Number.isNaN(v)) return 0;
  return Math.min(10, Math.max(0, v));
}

function asStringArray(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
}

/**
 * Defensive output for cases where the refinement call failed at the
 * transport or JSON-parse layer. The chat client still gets a structured
 * response (ready=false + the reason in critique.ambiguities) instead of
 * a thrown exception.
 */
function fallback(rough: string, reason: string): BriefRefinement {
  return {
    ready: false,
    original: rough,
    critique: {
      strong_points: [],
      ambiguities: [reason],
      missing_scope: [],
      untestable_claims: [],
      hidden_complexity: [],
    },
    questions: ['Brief refinement did not complete. Run again or proceed with `loom epic` if confident.'],
    quality_score: FALLBACK_QUALITY_SCORE,
    delta: {
      added_sections: [],
      clarifications: [],
      flagged_assumptions: [],
    },
  };
}
