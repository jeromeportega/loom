import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import { createDatabase } from '../../state/Database.js';
import { AgentStore } from '../../state/AgentStore.js';
import { AuditLog } from '../../state/AuditLog.js';
import { EpicStore } from '../../state/EpicStore.js';
import { SkillGenerator } from '../../skills/SkillGenerator.js';
import { SkillStore } from '../../skills/SkillStore.js';
import { EMPTY_USAGE } from '../../llm/LLMClient.js';
import type { LLMClient, LLMRequest, LLMResponse } from '../../llm/LLMClient.js';
import type { GateOutcome, GateDeps } from '../framework/types.js';
import type { Story } from '../../types.js';
import type { SkillGeneratorCase } from './caseSchema.js';
import type { SkillGeneratorDecision } from './judgeTypes.js';

/**
 * Drives the production SkillGenerator over one eval case, observe-only (ADR-002).
 *
 * COUPLING WARNING (ADR-002): This runner depends on the SkillGenerator's internal
 * LLM call ordering — the FIRST complete() is the skill-extractor call, and SUBSEQUENT
 * calls belong to the internal SkillJudge. This is the deliberate price of leaving
 * SkillGenerator.ts byte-unchanged. If the generator ever adds a pre-extraction LLM
 * call, the first-call-wins rule will misattribute the forwarded call.
 *
 * Isolation: each call opens a fresh :memory: db seeded from case data, and a new
 * SkillStore pointing at an ephemeral temp dir — no operator state is touched (T2, NFR-1/4).
 */
export async function runSkillGeneratorGate(
  c: SkillGeneratorCase,
  deps: GateDeps,
): Promise<GateOutcome<SkillGeneratorDecision>> {
  // Declare outside try so the finally block can clean up even if mkdtemp fails.
  let tmpDir = '';
  try {
    // Non-blocking mkdtemp — avoids stalling the event loop under parallel eval runs.
    tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'loom-eval-sg-'));

    // Fresh :memory: db per case — no cross-case leakage (NFR-1).
    const db = createDatabase(':memory:');

    // FK: agents.epic_id → epics.id — use EpicStore so schema evolution is handled
    // automatically (raw INSERT would silently fail if a future migration adds a
    // NOT NULL column without a default).
    const epicId = `eval-epic-${c.id}`;
    const epicStore = new EpicStore(db);
    epicStore.create(epicId, `eval-${c.id}`);

    // Seed the agent row: log_tail = diff_context is what SkillGenerator reads as
    // "Output tail" when building the extraction context prompt.
    const agentStore = new AgentStore(db);
    const agent = agentStore.create(epicId, c.work.story.id, c.work.story.title);
    agentStore.updateLogTail(agent.id, c.work.diff_context);

    // Seed the completion audit row: detail.summary is what SkillGenerator reads as
    // the "Worker outcome Summary" when building the extraction context prompt.
    const auditLog = new AuditLog(db);
    auditLog.record({
      agent_id: agent.id,
      action: 'completion',
      detail: { summary: c.work.summary },
    });

    // Recording client (ADR-002 first-call-wins):
    //   call #1 — the extractor — forwarded to deps.llm/gateModel; response.text captured.
    //   call #2+ — the internal SkillJudge — returns a canned accept so the generator
    //   runs deterministically without a second real model hit.
    let callCount = 0;
    let recordedRaw: string | null = null;
    const recordingClient: LLMClient = {
      async complete(req: LLMRequest): Promise<LLMResponse> {
        callCount++;
        if (callCount === 1) {
          const response = await deps.llm.complete({ ...req, model: deps.gateModel });
          recordedRaw = response.text;
          return response;
        }
        // Canned accept for SkillJudge — format must satisfy JudgeResultSchema (the
        // schema parsed by extractJsonBlock inside SkillGenerator). COUPLING: if
        // JudgeResultSchema renames 'verdict' or drops 'score', parsing silently fails
        // and the generator returns null, making every eval case return { status:'failed' }.
        // If that happens, check SkillGenerator's internal JudgeResultSchema first.
        return {
          text: '```json\n{"score": 10, "verdict": "accept", "reason": "eval harness canned accept"}\n```',
          // Use req.model so the field accurately reflects what SkillGenerator requested,
          // not the gate model — SkillJudge may request a different model in future.
          model: req.model,
          stopReason: 'end_turn',
          usage: { ...EMPTY_USAGE },
        };
      },
    };

    // SkillStore pointed at tmpDir on both projectRoot and globalSkillsDir so that
    // writeSkill() never reaches the repo's .loom/skills/ or ~/.loom/skills/generated/.
    const store = new SkillStore({
      projectRoot: tmpDir,
      globalSkillsDir: path.join(tmpDir, 'global'),
    });

    // Construct a Story-compatible object from the case's work context.
    // SkillGenerator only uses id, title, description, and acceptance_criteria.
    const story: Story = {
      ...c.work.story,
      estimated_complexity: 'small',
      dependencies: [],
    };

    // Defensive: afterStory() is best-effort and currently never throws (it wraps
    // extract() in try/catch). The inner try/catch here ensures that even if a future
    // generator refactor propagates an error after call #1 has already recorded,
    // recordedRaw is still usable for deriving the gate decision.
    try {
      await new SkillGenerator({
        db,
        llm: recordingClient,
        model: deps.gateModel,
        skillStore: store,
      }).afterStory(agent.id, story);
    } catch (afterStoryErr) {
      if (recordedRaw === null) throw afterStoryErr;
      // extractor succeeded; only post-extraction logic threw — fall through to derive decision
    }

    // Derive the gate decision from the captured extractor response (ADR-002).
    if (recordedRaw === null) {
      return {
        status: 'failed',
        detail: 'extractor did not record a response (generator may have swallowed an error)',
      };
    }
    // TypeScript cannot narrow `let` variables mutated inside async closures —
    // use an explicit cast since we've just checked for null above.
    const raw = recordedRaw as string;

    // Intentional startsWith('NONE') per story spec (test plan, ADR-002): the
    // production extractor emits either a SKILL.md body or "NONE" (possibly with
    // trailing explanation). Exact-match would miss legitimate "NONE — reason"
    // outputs. Risk of false-positive for skill bodies that open with the word
    // "none" is accepted as a spec-documented trade-off.
    const decision: SkillGeneratorDecision =
      raw.length === 0 || raw.toUpperCase().startsWith('NONE')
        ? { decision: 'none', skillMd: null }
        : { decision: 'generate', skillMd: raw };

    return { status: 'ok', output: decision };
  } catch (e) {
    return { status: 'failed', detail: e instanceof Error ? (e.stack ?? e.message) : String(e) };
  } finally {
    if (tmpDir) {
      try { await fs.promises.rm(tmpDir, { recursive: true, force: true }); } catch { /* best-effort */ }
    }
  }
}
