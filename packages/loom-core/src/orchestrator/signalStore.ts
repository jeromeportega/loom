import fs from 'node:fs';
import path from 'node:path';
import type Database from 'better-sqlite3';
import { AuditLog } from '../state/AuditLog.js';
import type { StorySignals } from '../types.js';

const STORY_ID_RE = /^story-\d{3}-\d{3}$/;

export class SignalLedger {
  private audit: AuditLog;

  constructor(private opts: { db: Database.Database; projectRoot: string }) {
    this.audit = new AuditLog(opts.db);
  }

  /**
   * Writes StorySignals to both sinks (audit_log + markdown). Best-effort:
   * catches and swallows every error, never throws (FR-8). The audit row
   * lands before return (NFR-2). Runs regardless of ADAPTIVE_COST.
   */
  record(storyId: string, signals: StorySignals, agentId?: string): void {
    let auditWritten = false;
    try {
      if (!STORY_ID_RE.test(storyId)) {
        // Traversal guard — silently skip invalid ids; no path is constructed.
        return;
      }

      // Audit sink — synchronous write, lands before return (NFR-2).
      this.audit.record({
        agent_id: agentId,
        action: 'story_signals',
        command: storyId,
        allowed: true,
        detail: signals as unknown as Record<string, unknown>,
      });
      auditWritten = true;

      // Markdown sink — same StorySignals object, no drift possible.
      const signalsDir = path.join(this.opts.projectRoot, '.loom', 'signals');
      fs.mkdirSync(signalsDir, { recursive: true });
      fs.writeFileSync(path.join(signalsDir, `${storyId}.md`), renderMarkdown(storyId, signals));
    } catch {
      // Best-effort: never propagate (FR-8). Optionally emit a skip marker
      // so the audit log records that persistence was attempted but failed.
      if (auditWritten) {
        try {
          this.audit.record({
            agent_id: agentId,
            action: 'story_signals_skipped',
            command: storyId,
            allowed: true,
          });
        } catch {
          // Double-failure: DB write also failed — swallow silently.
        }
      }
    }
  }

  /**
   * Reads the latest StorySignals for each given storyId from audit_log only
   * (never touches the markdown file, never writes anything).
   */
  readEpic(storyIds: string[]): Map<string, StorySignals> {
    const result = new Map<string, StorySignals>();
    for (const storyId of storyIds) {
      try {
        const rows = this.audit.getByStory(storyId, 100);
        // getByStory returns ORDER BY timestamp DESC; find() picks the latest.
        const signalRow = rows.find((r) => r.action === 'story_signals');
        if (signalRow?.detail) {
          result.set(storyId, JSON.parse(signalRow.detail) as StorySignals);
        }
      } catch {
        // Skip malformed or missing rows gracefully.
      }
    }
    return result;
  }
}

function renderMarkdown(storyId: string, signals: StorySignals): string {
  const lines: string[] = [
    `# Story Signals: ${storyId}`,
    '',
    `tier: ${signals.tier}`,
    '',
    'steps:',
    `  reviewers: ${signals.steps.reviewers}`,
    `  verify_phase: ${signals.steps.verify_phase}`,
    `  skill_gen: ${signals.steps.skill_gen}`,
  ];

  if (signals.heuristics) {
    const h = signals.heuristics;
    lines.push('', 'heuristics:');
    lines.push(`  diff_lines: ${h.diff_lines}`);
    lines.push(`  diff_files: ${h.diff_files}`);
    lines.push(`  tests_green_first_try: ${h.tests_green_first_try}`);
  }

  lines.push('');
  return lines.join('\n');
}
