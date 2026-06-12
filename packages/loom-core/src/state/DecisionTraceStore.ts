import Database from 'better-sqlite3';

/**
 * One reasoning event from an agent — captured at the moment a decision was
 * being made, before the action it led to. The audit log records WHAT an
 * agent did; decision traces record WHY.
 *
 * V1 source: claude's stream-json `thinking` content blocks, captured by
 * `ClaudeCodeWorker.parseStreamLine` (the events are emitted before tool
 * use / text response, so the rationale leads the action). Future sources:
 * planner-LLM reasoning (Analyst / PM / Architect), review agent rationale.
 */
export interface DecisionTrace {
  id: number;
  agent_id: string | null;
  epic_id: string | null;
  story_id: string | null;
  /** Discriminator: 'thinking' | 'tool_intent' | 'plan_rationale' | 'pivot' */
  kind: string;
  /** Short label for what the rationale is about (e.g., tool name, file path). */
  subject: string | null;
  /** The reasoning text. May be long; this is the load-bearing field. */
  rationale: string;
  /** Optional JSON-encoded structured context. */
  metadata: string | null;
  timestamp: string;
}

export interface RecordTraceInput {
  agent_id?: string;
  epic_id?: string;
  story_id?: string;
  kind: string;
  subject?: string;
  rationale: string;
  metadata?: Record<string, unknown>;
}

/** Per-trace truncation to bound storage on extreme thinking blocks. */
const MAX_RATIONALE_CHARS = 16_384;

/**
 * Persists agent reasoning events. Append-only — no edits, no deletes.
 * Reads are scoped: by agent (worker view), by story (story-level replay),
 * by epic (whole-epic timeline).
 */
export class DecisionTraceStore {
  constructor(private db: Database.Database) {}

  /** Records one decision trace. Long rationales are truncated. */
  record(entry: RecordTraceInput): void {
    const rationale =
      entry.rationale.length > MAX_RATIONALE_CHARS
        ? entry.rationale.slice(0, MAX_RATIONALE_CHARS) + '\n…[truncated]'
        : entry.rationale;
    this.db
      .prepare(
        `INSERT INTO decision_traces
           (agent_id, epic_id, story_id, kind, subject, rationale, metadata)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        entry.agent_id ?? null,
        entry.epic_id ?? null,
        entry.story_id ?? null,
        entry.kind,
        entry.subject ?? null,
        rationale,
        entry.metadata ? JSON.stringify(entry.metadata) : null
      );
  }

  /** Returns the chronological reasoning timeline for one agent. */
  getByAgent(agentId: string, limit = 200): DecisionTrace[] {
    return this.db
      .prepare(
        `SELECT * FROM decision_traces
         WHERE agent_id = ?
         ORDER BY id ASC LIMIT ?`
      )
      .all(agentId, limit) as DecisionTrace[];
  }

  /** Returns the chronological reasoning timeline for one story (all agents). */
  getByStory(storyId: string, limit = 500): DecisionTrace[] {
    return this.db
      .prepare(
        `SELECT * FROM decision_traces
         WHERE story_id = ?
         ORDER BY id ASC LIMIT ?`
      )
      .all(storyId, limit) as DecisionTrace[];
  }

  /** Whole-epic replay — every reasoning event across every story. */
  getByEpic(epicId: string, limit = 2000): DecisionTrace[] {
    return this.db
      .prepare(
        `SELECT * FROM decision_traces
         WHERE epic_id = ?
         ORDER BY id ASC LIMIT ?`
      )
      .all(epicId, limit) as DecisionTrace[];
  }
}
