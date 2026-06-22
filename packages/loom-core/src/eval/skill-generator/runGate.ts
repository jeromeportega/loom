import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import { createDatabase } from '../../state/Database.js';
import { AgentStore } from '../../state/AgentStore.js';
import { AuditLog } from '../../state/AuditLog.js';
import { SkillGenerator } from '../../skills/SkillGenerator.js';
import { SkillStore } from '../../skills/SkillStore.js';
import { EMPTY_USAGE } from '../../llm/LLMClient.js';
import type { LLMClient, LLMRequest, LLMResponse } from '../../llm/LLMClient.js';
import type { GateOutcome, GateDeps } from '../framework/types.js';
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
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'loom-eval-sg-'));
  try {
    // Fresh :memory: db per case — no cross-case leakage (NFR-1).
    const db = createDatabase(':memory:');

    // FK: agents.epic_id → epics.id — insert a minimal epic row first.
    const epicId = `eval-epic-${c.id}`;
    db.prepare('INSERT INTO epics (id, title) VALUES (?, ?)').run(epicId, `eval-${c.id}`);

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
        // Canned accept for SkillJudge: format satisfies JudgeResultSchema via extractJsonBlock.
        return {
          text: '```json\n{"score": 10, "verdict": "accept", "reason": "eval harness canned accept"}\n```',
          model: deps.gateModel,
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
    const story = {
      ...c.work.story,
      estimated_complexity: 'small' as const,
      dependencies: [] as string[],
    };

    await new SkillGenerator({
      db,
      llm: recordingClient,
      model: deps.gateModel,
      skillStore: store,
    }).afterStory(agent.id, story);

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

    const decision: SkillGeneratorDecision =
      raw.length === 0 || raw.toUpperCase().startsWith('NONE')
        ? { decision: 'none', skillMd: null }
        : { decision: 'generate', skillMd: raw };

    return { status: 'ok', output: decision };
  } catch (e) {
    return { status: 'failed', detail: String(e) };
  } finally {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* best-effort */ }
  }
}
