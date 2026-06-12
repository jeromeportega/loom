import fs from 'node:fs';
import path from 'node:path';
import matter from 'gray-matter';
import type Database from 'better-sqlite3';
import type { Story } from '../types.js';
import type { LLMClient } from '../llm/index.js';
import { AgentStore, AuditLog } from '../state/index.js';
import { SkillStore, type SkillManifest } from './SkillStore.js';
import { SkillJudge } from './SkillJudge.js';
import { SkillProposer } from './SkillProposer.js';
import { checkSkillConformance } from './spec.js';
import { loadBundledPrompt } from '../planner/PersonaLoader.js';

export interface SkillGeneratorOptions {
  db: Database.Database;
  llm: LLMClient;
  /** Model for extraction — Haiku by default (policy.agents.skill_gen_model). */
  model: string;
  skillStore: SkillStore;
  /** A judged skill scoring below this (0-10) is rejected. Default: 6. */
  judgeMinScore?: number;
  /**
   * Auto-propose pipeline. When `autoProposer` is set AND `autoProposeMode`
   * is not 'off', a candidate that lands AND clears `autoProposeMinScore`
   * triggers a PR against its target source — subject to
   * `autoProposeMaxPerEpic` (skipped silently with audit entry if over cap).
   * Every decision (proposed / skipped:under-threshold / skipped:over-cap /
   * error) lands in audit_log under action='skill_auto_propose_decision'.
   *
   * Auto-propose is a separate concern from generation itself; absent these
   * options the generator behaves exactly as before (#18
   * story-cloud-004).
   */
  autoProposer?: SkillProposer;
  autoProposeMode?: 'off' | 'sampled' | 'always';
  autoProposeMinScore?: number;
  autoProposeMaxPerEpic?: number;
}

/**
 * After a story completes, asks an LLM whether the work produced a reusable
 * skill. If so, writes a new agentskills.io SKILL.md to the generated-skills
 * directory — this is loom's self-learning loop. Designed to be best-effort:
 * any failure returns null and never disturbs the run.
 */
export class SkillGenerator {
  /**
   * Per-epic auto-propose counter. Bounded by autoProposeMaxPerEpic so
   * one loose-enough threshold can't spam reviewers with PRs across a
   * single supervisor run. Keyed by epic_id; never reset within a
   * generator's lifetime (one supervisor run = one fresh generator).
   */
  private autoProposeCounts = new Map<string, number>();

  constructor(private opts: SkillGeneratorOptions) {}

  async afterStory(agentId: string, story: Story): Promise<SkillManifest | null> {
    try {
      return await this.extract(agentId, story);
    } catch {
      // Skill generation is best-effort — never fail a run because of it.
      return null;
    }
  }

  private async extract(
    agentId: string,
    story: Story
  ): Promise<SkillManifest | null> {
    const agent = new AgentStore(this.opts.db).get(agentId);
    const audit = new AuditLog(this.opts.db).getByAgent(agentId);
    const completion = audit.find((e) => e.action === 'completion');
    const summary =
      completion?.detail != null
        ? (JSON.parse(completion.detail) as { summary?: string }).summary ?? ''
        : '';

    const existing = this.opts.skillStore.discover();
    const existingList =
      existing.length > 0
        ? existing.map((s) => `- ${s.name}: ${s.description}`).join('\n')
        : '(none yet)';

    const context = [
      '## Story',
      `${story.id} — ${story.title}`,
      story.description,
      '',
      '## Acceptance criteria',
      ...story.acceptance_criteria.map((ac) => `- ${ac}`),
      '',
      '## Worker outcome',
      `Summary: ${summary || '(none)'}`,
      `Output tail:\n${agent?.log_tail ?? '(none)'}`,
      '',
      '## Existing skills (do not duplicate these)',
      existingList,
    ].join('\n');

    const prompt = loadBundledPrompt('skill-extractor').replace('{{CONTEXT}}', context);

    const response = await this.opts.llm.complete({
      model: this.opts.model,
      system: [{ text: prompt, cache: true }],
      messages: [
        { role: 'user', content: 'Decide now. Output NONE or a single SKILL.md.' },
      ],
    });

    const text = response.text.trim();
    if (text.length === 0 || text.toUpperCase().startsWith('NONE')) {
      return null;
    }

    // Quality gate — a judge scores the candidate before it enters the library.
    // The judge is best-effort: an error defaults to 'accept', never blocking.
    const judge = new SkillJudge({ llm: this.opts.llm, model: this.opts.model });
    const verdict = await judge.judge(text, existing);
    const minScore = this.opts.judgeMinScore ?? 6;
    if (verdict.verdict === 'reject' || verdict.score < minScore) {
      return null; // skill judged not worth keeping
    }

    const manifest = this.writeSkill(text, {
      generated_from_story_id: story.id,
      generated_from_epic_id: agent?.epic_id ?? '',
    });
    if (manifest && this.opts.autoProposer && this.opts.autoProposeMode && this.opts.autoProposeMode !== 'off') {
      const epicId = agent?.epic_id ?? '';
      this.maybeAutoPropose(manifest, verdict.score, epicId, story);
    }
    return manifest;
  }

  /**
   * Decide whether to auto-propose `manifest`. Honors the mode / threshold /
   * per-epic cap and records the decision in audit_log regardless of outcome
   * so a future operator can replay the proposal pattern.
   */
  private maybeAutoPropose(
    manifest: SkillManifest,
    judgeScore: number,
    epicId: string,
    story: Story,
  ): void {
    const audit = new AuditLog(this.opts.db);
    const mode = this.opts.autoProposeMode ?? 'off';
    const minScore = this.opts.autoProposeMinScore ?? 8;
    const maxPerEpic = this.opts.autoProposeMaxPerEpic ?? 1;
    const epicKey = epicId || '(unknown-epic)';
    const used = this.autoProposeCounts.get(epicKey) ?? 0;

    if (judgeScore < minScore) {
      audit.record({
        action: 'skill_auto_propose_decision',
        command: manifest.name,
        allowed: false,
        detail: {
          decision: 'skipped:under-threshold',
          judge_score: judgeScore,
          min_score: minScore,
          mode,
          epic_id: epicKey,
        },
      });
      return;
    }
    if (mode === 'sampled' && used >= maxPerEpic) {
      audit.record({
        action: 'skill_auto_propose_decision',
        command: manifest.name,
        allowed: false,
        detail: {
          decision: 'skipped:over-cap',
          judge_score: judgeScore,
          max_per_epic: maxPerEpic,
          used,
          mode,
          epic_id: epicKey,
        },
      });
      return;
    }

    const result = this.opts.autoProposer!.propose({
      candidateName: manifest.name,
      autoProposed: true,
      context: `produced in ${epicKey} by story ${story.id}; judge score ${judgeScore}/10`,
    });

    if (result.status === 'proposed') {
      this.autoProposeCounts.set(epicKey, used + 1);
      audit.record({
        action: 'skill_auto_propose_decision',
        command: manifest.name,
        allowed: true,
        detail: {
          decision: 'proposed',
          judge_score: judgeScore,
          mode,
          epic_id: epicKey,
          source: result.sourceName,
          branch: result.branch,
          url: result.url,
        },
      });
    } else {
      // SkillProposer already logged the error to audit_log; this row is the
      // SkillGenerator's view of "I tried to auto-propose and it failed."
      audit.record({
        action: 'skill_auto_propose_decision',
        command: manifest.name,
        allowed: false,
        detail: {
          decision: 'error',
          judge_score: judgeScore,
          mode,
          epic_id: epicKey,
          source: result.sourceName,
          error: result.error,
        },
      });
    }
  }

  private writeSkill(
    skillMd: string,
    provenance: { generated_from_story_id: string; generated_from_epic_id: string },
  ): SkillManifest | null {
    const parsed = matter(skillMd);
    const data = parsed.data as Record<string, unknown>;
    const name = data.name;
    const description = data.description;

    // agentskills.io spec compliance — refuse to write anything that
    // wouldn't be portable to hermes-agent / Claude Skills / etc. This is
    // the same check the SpecConformance test asserts against.
    const conformance = checkSkillConformance({
      name,
      description,
      body: parsed.content,
    });
    if (!conformance.ok || typeof name !== 'string' || typeof description !== 'string') {
      return null;
    }

    // Every generated skill is born a 'candidate' — loom controls the
    // lifecycle, not the LLM. The canary in SkillSelector bounds its reach
    // until it earns promotion to 'active'. Provenance records which story
    // produced this skill so a future injection can be traced back to its
    // origin; SkillProposer strips it before any external PR.
    const metadata: Record<string, unknown> = {
      ...((data.metadata as Record<string, unknown>) ?? {}),
      source: 'generated',
      lifecycle: 'candidate',
      generated_from_story_id: provenance.generated_from_story_id,
      generated_from_epic_id: provenance.generated_from_epic_id,
    };
    const finalMd = matter.stringify(parsed.content, { ...data, metadata });

    const dir = path.join(this.opts.skillStore.generatedDir(), name);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'SKILL.md'), finalMd);

    return {
      name,
      description,
      metadata,
      source: 'generated',
      lifecycle: 'candidate',
      file: path.join(dir, 'SKILL.md'),
    };
  }
}
