import fs from 'node:fs';
import path from 'node:path';
import type Database from 'better-sqlite3';
import { AuditLog } from '../state/index.js';

/** A single guidance entry in the operator-injected message log. */
export interface GuidanceEntry {
  timestamp: string;
  /** Free-form text the operator wrote. */
  message: string;
  /** Optional author tag (defaults to "operator"). */
  author?: string;
}

export interface OperatorGuidanceOptions {
  projectRoot: string;
  /** Optional AuditLog — when set, every add/clear is recorded. */
  db?: Database.Database;
}

/**
 * Operator → worker side-channel. The operator records steering messages
 * for a specific story via `add()`; the worker (when it has the read path
 * wired in by policy) consumes them via `read()` and treats the content
 * as priority instructions.
 *
 * Stored at `<projectRoot>/.loom/guidance/<story-id>.md` so a running
 * worker can be steered without loom restarts. Each `add()` appends to
 * the file rather than overwriting — the operator can layer guidance
 * without losing the prior context, and the file doubles as a history.
 *
 * `clear()` removes the file entirely; useful after a story revises and
 * the operator wants to start a fresh conversation. The audit log
 * preserves the full history regardless.
 */
export class OperatorGuidance {
  constructor(private opts: OperatorGuidanceOptions) {}

  /** Directory holding per-story guidance files. */
  private guidanceDir(): string {
    return path.join(this.opts.projectRoot, '.loom', 'guidance');
  }

  /** Path to one story's guidance file. */
  fileFor(storyId: string): string {
    return path.join(this.guidanceDir(), `${storyId}.md`);
  }

  /**
   * Append a guidance message for the given story. Operator-facing
   * helpers stamp the entry with an ISO timestamp; the worker prompt
   * adapter reads back the raw markdown so the structure is preserved.
   */
  add(storyId: string, message: string, opts: { author?: string } = {}): GuidanceEntry {
    if (!storyId) throw new Error('storyId is required');
    if (!message.trim()) throw new Error('message is empty');
    fs.mkdirSync(this.guidanceDir(), { recursive: true });
    const entry: GuidanceEntry = {
      timestamp: new Date().toISOString(),
      message: message.trim(),
      author: opts.author,
    };
    const block =
      `\n---\n` +
      `**${entry.timestamp}** (${entry.author ?? 'operator'})\n\n` +
      entry.message +
      '\n';
    const file = this.fileFor(storyId);
    fs.appendFileSync(file, block);
    this.audit('operator_guidance_add', storyId, {
      author: entry.author,
      ts: entry.timestamp,
      bytes: block.length,
    });
    return entry;
  }

  /** Returns the markdown content of the guidance file, or null if absent. */
  read(storyId: string): string | null {
    const file = this.fileFor(storyId);
    if (!fs.existsSync(file)) return null;
    const content = fs.readFileSync(file, 'utf8').trim();
    return content.length > 0 ? content : null;
  }

  /** Remove the guidance file for a story. No-op when the file doesn't exist. */
  clear(storyId: string): void {
    const file = this.fileFor(storyId);
    if (fs.existsSync(file)) {
      fs.rmSync(file);
      this.audit('operator_guidance_clear', storyId, {});
    }
  }

  /** Directory holding the per-worker pull-offset markers. Separate from
      the guidance directory so a `clear()` doesn't sweep them away. */
  private pulledDir(): string {
    return path.join(this.guidanceDir(), '.pulled');
  }

  /** Path to one story's pull-offset marker file. */
  private pulledOffsetFile(storyId: string): string {
    return path.join(this.pulledDir(), `${storyId}.offset`);
  }

  /**
   * Worker-side pull of new guidance since the last call (Phase 2 of
   * live agent guidance — used by `loom_pull_guidance` for cursor-cli
   * workers that can't accept mid-spawn stdin injection).
   *
   * Returns the appended bytes since the offset stored in
   * `.loom/guidance/.pulled/<story-id>.offset`, then advances the
   * offset. Returns `{ content: null }` when there is nothing new.
   * Tolerant of clear() — when the guidance file shrank below our stored
   * offset, the offset is reset to 0 and the full current content is
   * returned.
   *
   * The offset is intentionally separate from the Supervisor's
   * in-memory `guidanceOffsets` map: this is the worker's consumption
   * marker, that one is the supervisor's stdin-push marker — same
   * file, two independent readers.
   */
  pullSince(storyId: string): { content: string | null; has_more: boolean } {
    if (!storyId) throw new Error('storyId is required');
    const file = this.fileFor(storyId);
    if (!fs.existsSync(file)) {
      // Drop any stale offset marker so a future add() resets cleanly.
      try {
        fs.rmSync(this.pulledOffsetFile(storyId), { force: true });
      } catch {
        // Best-effort.
      }
      return { content: null, has_more: false };
    }
    const size = fs.statSync(file).size;
    const stored = this.readOffset(storyId);
    // Handle clear() / shrink: reset offset and serve the whole file.
    const from = size < stored ? 0 : stored;
    if (size <= from) {
      return { content: null, has_more: false };
    }
    const fh = fs.openSync(file, 'r');
    let delta = '';
    try {
      const buf = Buffer.alloc(size - from);
      fs.readSync(fh, buf, 0, buf.length, from);
      delta = buf.toString('utf8');
    } finally {
      try {
        fs.closeSync(fh);
      } catch {
        // best-effort
      }
    }
    this.writeOffset(storyId, size);
    this.audit('operator_guidance_pulled', storyId, {
      bytes: delta.length,
      from,
      to: size,
    });
    return { content: delta, has_more: false };
  }

  private readOffset(storyId: string): number {
    try {
      const raw = fs.readFileSync(this.pulledOffsetFile(storyId), 'utf8');
      const n = parseInt(raw, 10);
      return Number.isFinite(n) && n >= 0 ? n : 0;
    } catch {
      return 0;
    }
  }

  private writeOffset(storyId: string, offset: number): void {
    try {
      fs.mkdirSync(this.pulledDir(), { recursive: true });
      fs.writeFileSync(this.pulledOffsetFile(storyId), String(offset));
    } catch {
      // Marker is best-effort — the worker can still see guidance via
      // the per-revision prompt path if the offset write fails.
    }
  }

  /** Lists guidance files present on disk — useful for the dashboard. */
  listStories(): string[] {
    const dir = this.guidanceDir();
    if (!fs.existsSync(dir)) return [];
    return fs
      .readdirSync(dir)
      .filter((f) => f.endsWith('.md'))
      .map((f) => f.slice(0, -3));
  }

  private audit(action: string, storyId: string, detail: Record<string, unknown>): void {
    if (!this.opts.db) return;
    try {
      new AuditLog(this.opts.db).record({
        action,
        command: storyId,
        allowed: true,
        detail,
      });
    } catch {
      // Audit is best-effort — never fail the write because logging broke.
    }
  }
}
