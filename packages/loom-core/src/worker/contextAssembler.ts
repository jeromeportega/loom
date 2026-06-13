import type Database from 'better-sqlite3';
import { Distillation } from '../findings/distillation.js';
import type { LessonRow } from '../findings/lesson.js';
import { selectLessonsForStory } from '../findings/lessonMatch.js';
import { SkillUsageStore } from '../state/SkillUsageStore.js';
import { AuditLog } from '../state/AuditLog.js';
import { countTokens } from './tokenCount.js';

/**
 * The four planning artifacts handed to a worker. Matches the `doc-distiller`
 * skill input in the epic-001 shared contract. Any field may be an empty string
 * (an epic may have no separate architecture doc, a probe story no PRD, etc.).
 */
export interface PlanningArtifacts {
  prd: string;
  epic: string;
  architecture: string;
  story: string;
}

/**
 * Result of {@link assembleWorkerContext}: the uncompressed context, the
 * distilled context fed to the worker, and the acceptance criteria proven to
 * have survived distillation verbatim.
 */
export interface AssembledContext {
  raw: string;
  distilled: string;
  acceptance_criteria_preserved: string[];
}

/** A distiller maps the planning artifacts to the compact `distilled` text. */
export type Distiller = (
  artifacts: PlanningArtifacts,
) => string | Promise<string>;

export interface AssembleOptions {
  /**
   * State database. When supplied, the standard `skill_usage` row and the
   * `context.distilled` audit_log row are written before returning (CLAUDE.md
   * invariant #5). Omit it (tests / dry runs) to skip provenance.
   */
  db?: Database.Database;
  /**
   * Concrete agent id for provenance attribution. `audit_log.agent_id` has an
   * FK to `agents(id)`, so pass a real id or leave it unset (the row is then
   * recorded with a null agent). `skill_usage.agent_id` is NOT NULL with no FK,
   * so it falls back to a story-derived id.
   */
  agent_id?: string;
  epic_id?: string;
  /**
   * Override the distiller. Defaults to the deterministic, dependency-free
   * compressor below — the graceful-degradation path bmad-distillator
   * documents, and the one loom uses headless so a worker context never costs
   * an extra LLM round-trip. Tests inject their own to exercise the verifier.
   */
  distill?: Distiller;
  /** Sink for the soft compression-target warning. Defaults to `console.warn`. */
  warn?: (message: string) => void;
  /**
   * Story metadata required for lesson matching. When omitted, lesson injection
   * is skipped even if `lessons` is supplied.
   */
  storyTitle?: string;
  storyDescription?: string;
  epicTitle?: string;
  /**
   * Pre-fetched lesson pool to match against. Requires `storyTitle` /
   * `storyDescription` to be set; otherwise ignored.
   */
  lessons?: LessonRow[];
  /**
   * Lesson store used to record each injected lesson as applied. When absent,
   * lessons are still injected into the distilled text but not marked applied.
   */
  lessonStore?: {
    markApplied: (
      id: number,
      applied_as: 'worker_guidance' | 'policy_suggestion',
      applied_ref: string,
    ) => void;
  };
}

/** Distilled context may be at most this fraction of the source token count. */
export const COMPRESSION_TARGET_RATIO = 0.55;

/**
 * Assemble (and distill) the worker context for one story. Invokes the
 * doc-distiller exactly once, verifies every acceptance criterion survived
 * verbatim, records the compression telemetry, and returns the context.
 *
 * Per ADR-005 the verbatim check is a HARD failure: if any acceptance-criterion
 * string from the input artifacts is missing from the distilled output this
 * throws and the run aborts — a paraphrase, even a harmless one, fails it.
 * Missing the {@link COMPRESSION_TARGET_RATIO} target is the opposite: logged,
 * never fatal.
 */
export async function assembleWorkerContext(
  story_id: string,
  planning_artifacts: PlanningArtifacts,
  opts: AssembleOptions = {},
): Promise<AssembledContext> {
  const raw = formatArtifacts(planning_artifacts);
  const acceptanceCriteria = extractAcceptanceCriteria(planning_artifacts);

  const distill = opts.distill ?? defaultDistill;
  const distilled = await distill(planning_artifacts);

  // ADR-005 hard fail: every acceptance criterion must appear verbatim.
  const dropped = acceptanceCriteria.filter((ac) => !distilled.includes(ac));
  if (dropped.length > 0) {
    throw new Error(
      `doc-distiller dropped ${dropped.length} acceptance criterion/criteria for ` +
        `story ${story_id}: ${dropped.map((d) => JSON.stringify(d)).join(', ')}`,
    );
  }

  const source_token_count = countTokens(raw);

  // Inject relevant lessons as a clearly-delimited advisory block (FR-7, T-1).
  // Injection happens before token counting so the final count reflects the
  // actual output size (including the lesson block). The block is appended AFTER
  // the AC check so lesson content never interferes with verbatim-AC verification.
  // This is advisory only — never system instructions.
  let finalDistilled = distilled;
  if (opts.storyTitle !== undefined) {
    const selected = selectLessonsForStory(
      {
        id: story_id,
        title: opts.storyTitle,
        description: opts.storyDescription ?? '',
      },
      opts.epicTitle ?? '',
      opts.lessons ?? [],
    );
    if (selected.length > 0) {
      finalDistilled = `${distilled}\n\n${renderLessonsBlock(selected)}`;
      if (opts.lessonStore) {
        for (const lesson of selected) {
          // Idempotency guard: skip if already recorded for this story (e.g. on retry).
          if (lesson.applied_ref !== story_id) {
            opts.lessonStore.markApplied(lesson.id, 'worker_guidance', story_id);
          }
        }
      }
    }
  }

  // Token counts reflect the final assembled output (including any lesson block).
  const distilled_token_count = countTokens(finalDistilled);
  const ratio =
    source_token_count === 0 ? 0 : distilled_token_count / source_token_count;

  // Soft target: log and continue (never throw) when compression falls short.
  if (ratio > COMPRESSION_TARGET_RATIO) {
    const warn = opts.warn ?? ((m: string) => console.warn(m));
    warn(
      `doc-distiller missed compression target for story ${story_id}: ` +
        `${distilled_token_count}/${source_token_count} tokens ` +
        `(${(ratio * 100).toFixed(1)}% > ${(COMPRESSION_TARGET_RATIO * 100).toFixed(0)}%)`,
    );
  }

  const distillation: Distillation = Distillation.parse({
    distilled: finalDistilled,
    source_token_count,
    distilled_token_count,
    acceptance_criteria_preserved: acceptanceCriteria,
  });

  if (opts.db) {
    const usageAgentId = opts.agent_id ?? `agent-${story_id}`;
    new SkillUsageStore(opts.db).recordInjection(
      'doc-distiller',
      usageAgentId,
      story_id,
    );
    new AuditLog(opts.db).record({
      agent_id: opts.agent_id,
      action: 'context.distilled',
      command: story_id,
      detail: {
        story_id,
        epic_id: opts.epic_id,
        source_token_count,
        distilled_token_count,
        ratio,
        acceptance_criteria_preserved: distillation.acceptance_criteria_preserved,
      },
    });
  }

  return {
    raw,
    distilled: finalDistilled,
    acceptance_criteria_preserved: distillation.acceptance_criteria_preserved,
  };
}

/**
 * Render selected lessons as a clearly-delimited advisory block.
 * Advisory only — this block must never appear in the system instructions
 * position (T-1); it lives in the context-notes / operator-guidance seam.
 */
function renderLessonsBlock(lessons: LessonRow[]): string {
  const items = lessons.map((l) => `- [${l.category}] ${l.general_rule}`);
  return [
    '## Lessons from prior epics',
    '',
    'Advisory only — past observations that may be relevant to this story. Apply judgment.',
    '',
    ...items,
  ].join('\n');
}

/** Concatenate the four artifacts into one labelled document (the `raw` context). */
export function formatArtifacts(a: PlanningArtifacts): string {
  const sections: Array<[string, string]> = [
    ['PRD', a.prd],
    ['Epic', a.epic],
    ['Architecture', a.architecture],
    ['Story', a.story],
  ];
  return sections
    .filter(([, body]) => body.trim().length > 0)
    .map(([title, body]) => `# ${title}\n\n${body.trim()}`)
    .join('\n\n');
}

const CHECKBOX_BULLET = /^[-*]\s*\[[ xX]?\]\s+(.+?)\s*$/;
const PLAIN_BULLET = /^[-*]\s+(.+?)\s*$/;
const HEADING = /^#{1,6}\s+(.+?)\s*$/;
const AC_HEADING = /acceptance\s+criteria/i;

/**
 * Pull every acceptance-criterion string out of the planning artifacts. Two
 * shapes are recognized: checkbox bullets (`- [ ] …`, the worker-prompt and
 * story format) anywhere, and plain bullets (`- …`) under any heading whose
 * text contains "acceptance criteria". The captured text is the criterion only
 * (bullet / checkbox marker stripped), trimmed; duplicates are dropped while
 * preserving first-seen order.
 */
export function extractAcceptanceCriteria(a: PlanningArtifacts): string[] {
  const text = [a.prd, a.epic, a.architecture, a.story].join('\n');
  const out: string[] = [];
  const seen = new Set<string>();
  let underAcHeading = false;

  const add = (s: string): void => {
    const ac = s.trim();
    if (ac.length === 0 || seen.has(ac)) return;
    seen.add(ac);
    out.push(ac);
  };

  for (const rawLine of text.split('\n')) {
    const line = rawLine.trim();
    const heading = line.match(HEADING);
    if (heading) {
      underAcHeading = AC_HEADING.test(heading[1]);
      continue;
    }
    const checkbox = line.match(CHECKBOX_BULLET);
    if (checkbox) {
      add(checkbox[1]);
      continue;
    }
    if (underAcHeading) {
      const bullet = line.match(PLAIN_BULLET);
      if (bullet) {
        add(bullet[1]);
        continue;
      }
      // A non-bullet, non-heading line ends the acceptance-criteria list only
      // when it carries content; blank lines inside the list are tolerated.
      if (line.length > 0) underAcHeading = false;
    }
  }

  return out;
}

/**
 * Deterministic, dependency-free distiller — the default. Compresses the
 * concatenated artifacts (cross-artifact dedup + whitespace / decoration /
 * filler stripping) and re-appends every acceptance criterion verbatim under a
 * dedicated heading so the verbatim check can never fail by construction.
 */
export function defaultDistill(a: PlanningArtifacts): string {
  const acs = extractAcceptanceCriteria(a);
  const skip = new Set(acs.map(normalizeLine));
  const body = compress(formatArtifacts(a), skip);
  if (acs.length === 0) return body;
  const acBlock = [
    '## Acceptance criteria (verbatim)',
    ...acs.map((ac) => `- ${ac}`),
  ].join('\n');
  return body.length > 0 ? `${body}\n\n${acBlock}` : acBlock;
}

const FILLER = [
  'as mentioned earlier',
  'it is worth noting',
  'it should be noted that',
  'in addition to this',
  'this document describes',
  'as outlined above',
];

/**
 * Collapse a document to its signal: drop blank and decorative lines, strip
 * heading markers and emphasis, drop pure-filler lines, and keep only the first
 * occurrence of each (normalized) line so content restated across the PRD,
 * epic, architecture, and story collapses to one copy. Lines whose normalized
 * form is in `skip` are removed entirely (acceptance criteria, re-added
 * verbatim by the caller).
 */
function compress(text: string, skip: Set<string>): string {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const rawLine of text.split('\n')) {
    let line = rawLine.replace(/\s+/g, ' ').trim();
    if (line.length === 0) continue;
    if (/^[-=_*#>\s]{3,}$/.test(line)) continue; // horizontal rules / dividers
    line = line.replace(/^#{1,6}\s*/, ''); // heading markers
    line = line.replace(/\*\*(.+?)\*\*/g, '$1').replace(/[*_`]/g, ''); // emphasis
    line = line.trim();
    if (line.length === 0) continue;
    const norm = normalizeLine(line);
    if (norm.length === 0) continue;
    if (skip.has(norm)) continue;
    if (FILLER.includes(norm)) continue;
    if (seen.has(norm)) continue;
    seen.add(norm);
    out.push(line);
  }
  return out.join('\n');
}

/** Lowercase, drop non-alphanumeric (except spaces), collapse spaces, trim. */
function normalizeLine(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9 ]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}
