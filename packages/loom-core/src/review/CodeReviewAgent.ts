import type { LLMClient, LLMUsage } from '../llm/index.js';
import { SkillStore } from '../skills/index.js';
import { extractJsonBlock } from '../planner/util.js';
import type { ReviewReport, ReviewFinding, ReviewStoryContext } from './types.js';

export interface CodeReviewAgentOptions {
  projectRoot: string;
  llm: LLMClient;
  /** Model id — defaults to the policy planning-tier model. */
  model: string;
}

export interface CodeReviewInput {
  story: ReviewStoryContext;
  /** Unified diff text for the change. */
  diff: string;
}

export interface CodeReviewResult {
  report: ReviewReport;
  usage: LLMUsage;
}

const FALLBACK_SYSTEM =
  'You are a staff engineer reviewing a code change. Identify problems in ' +
  'order: correctness, security, failure handling, clarity, tests. Group ' +
  'findings by severity. Be specific and cite locations. If the change is ' +
  'sound, say so plainly — do not invent nitpicks. Respond ONLY with a JSON ' +
  'object inside a ```json fenced block, matching this schema: ' +
  '{ "findings": [{ "severity": "blocker"|"should-fix"|"nit", "file": string, ' +
  '"line"?: number, "issue": string, "suggestion"?: string }], ' +
  '"summary": string }.';

const JSON_INSTRUCTIONS =
  'Respond ONLY with one ```json fenced block matching the schema. The ' +
  '`findings` array may be empty if the change is sound. Cite real files.';

/**
 * Runs a single code-review pass against a diff. Uses the bundled
 * `loom-code-review` skill as the system prompt where available, falling
 * back to an inline instruction. Defensive output parsing: a malformed
 * response surfaces as a single `should-fix` finding ("review unparseable")
 * rather than crashing the caller.
 */
export class CodeReviewAgent {
  constructor(private opts: CodeReviewAgentOptions) {}

  async review(input: CodeReviewInput): Promise<CodeReviewResult> {
    const skillStore = new SkillStore({ projectRoot: this.opts.projectRoot });
    const skill = skillStore.load('loom-code-review');
    const systemBody = [skill ?? FALLBACK_SYSTEM, '', JSON_INSTRUCTIONS].join('\n');

    const userContent = [
      `Review the diff for story ${input.story.storyId} (${input.story.title}).`,
      '',
      '## Story description',
      input.story.description,
      '',
      '## Acceptance criteria',
      input.story.acceptanceCriteria.map((ac) => `- ${ac}`).join('\n'),
      '',
      '## Diff',
      '',
      '```diff',
      input.diff.trim(),
      '```',
      '',
      'Now produce the review JSON.',
    ].join('\n');

    const response = await this.opts.llm.complete({
      model: this.opts.model,
      system: [{ text: systemBody, cache: true }],
      messages: [{ role: 'user', content: userContent }],
    });

    return {
      report: parseReviewReport(response.text),
      usage: response.usage,
    };
  }
}

const SEVERITIES = new Set<string>(['blocker', 'should-fix', 'nit']);

function isReviewFinding(f: unknown): f is ReviewFinding {
  if (!f || typeof f !== 'object') return false;
  const r = f as Record<string, unknown>;
  return (
    typeof r.file === 'string' &&
    typeof r.issue === 'string' &&
    typeof r.severity === 'string' &&
    SEVERITIES.has(r.severity)
  );
}

/** Defensive parser — never throws; degrades to a single 'should-fix' note. */
export function parseReviewReport(text: string): ReviewReport {
  let parsed: unknown;
  try {
    parsed = extractJsonBlock(text);
  } catch {
    return {
      findings: [
        {
          severity: 'should-fix',
          file: '(review)',
          issue: 'Review response did not contain a parseable JSON block',
        },
      ],
      summary: text.slice(0, 400),
    };
  }
  if (!parsed || typeof parsed !== 'object') {
    return {
      findings: [
        {
          severity: 'should-fix',
          file: '(review)',
          issue: 'Review response was not a JSON object',
        },
      ],
      summary: text.slice(0, 400),
    };
  }
  const obj = parsed as { findings?: unknown; summary?: unknown };
  const findings: ReviewFinding[] = Array.isArray(obj.findings)
    ? obj.findings.filter(isReviewFinding).map((f) => {
        const finding: ReviewFinding = {
          severity: f.severity,
          file: f.file,
          issue: f.issue,
        };
        if (typeof f.line === 'number') finding.line = f.line;
        if (typeof f.suggestion === 'string') finding.suggestion = f.suggestion;
        return finding;
      })
    : [];
  return {
    findings,
    summary:
      typeof obj.summary === 'string' ? obj.summary : 'Review produced no summary.',
  };
}
