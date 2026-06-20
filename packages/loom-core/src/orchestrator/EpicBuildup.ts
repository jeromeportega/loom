import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { MAX_CONVENTION_CHARS, MAX_CONVENTIONS_PER_STORY } from './conventionsMarker.js';

export interface EpicBuildupDoc {
  epicId: string;
  version: 1;
  /** Chronological by completion (oldest first). */
  entries: BuildupEntry[];
  /** Chronological, deduped by hash. */
  conventions: ConventionEntry[];
}

export interface BuildupEntry {
  storyId: string;
  title: string;
  completedAt: string;
  /** Markdown from StoryContext.render() — no model call. */
  body: string;
}

export interface ConventionEntry {
  storyId: string;
  recordedAt: string;
  /** Already truncated to MAX_CONVENTION_CHARS. */
  text: string;
  /** sha256 of normalized text — dedup key. */
  hash: string;
}

/** Total injected content ceiling (NFR-3). */
export const EPIC_BUILDUP_INJECT_BUDGET = 12_000;
/** Reserved sub-budget for conventions, evicted last (FR-5). */
export const CONVENTIONS_INJECT_BUDGET = 4_000;

/**
 * Append-only, single-writer, atomic-tmp+rename store for per-epic build-up docs.
 * Persisted at <projectRoot>/.loom/buildup/<epic-id>.json.
 */
export class EpicBuildup {
  /** Canonical path for an epic's build-up doc. */
  static pathFor(projectRoot: string, epicId: string): string {
    return path.join(projectRoot, '.loom', 'buildup', `${epicId}.json`);
  }

  /**
   * Reads the build-up doc, returning null on missing file OR corrupt/partial JSON
   * (fail-safe: callers treat null as "empty doc").
   */
  static read(projectRoot: string, epicId: string): EpicBuildupDoc | null {
    const file = EpicBuildup.pathFor(projectRoot, epicId);
    try {
      const raw = fs.readFileSync(file, 'utf8');
      const parsed = JSON.parse(raw) as unknown;
      if (!isValidDoc(parsed)) return null;
      return parsed;
    } catch {
      return null;
    }
  }

  /**
   * Appends a story entry to the build-up doc. Idempotent: if entry.storyId
   * is already present, this is a no-op. Synchronous read-modify-write with
   * atomic tmp+rename. Returns true when the entry was newly added, false when
   * it was already present (so callers can skip the audit row on no-ops).
   */
  static appendStoryEntry(
    projectRoot: string,
    epicId: string,
    entry: BuildupEntry
  ): boolean {
    const file = EpicBuildup.pathFor(projectRoot, epicId);
    fs.mkdirSync(path.dirname(file), { recursive: true });

    const doc: EpicBuildupDoc = EpicBuildup.read(projectRoot, epicId) ?? {
      epicId,
      version: 1,
      entries: [],
      conventions: [],
    };

    // Idempotent: no-op if already present.
    if (doc.entries.some((e) => e.storyId === entry.storyId)) return false;

    doc.entries.push(entry);
    atomicWrite(file, doc);
    return true;
  }

  /**
   * Parses, truncates, and dedupes conventions then appends them. Each text is
   * already bounded by the caller (parseConventions enforces per-entry caps);
   * this method enforces store-side dedup by hash so a duplicate convention
   * from any story is silently ignored. Returns the count of conventions
   * actually appended (0 when all were duplicates or the list was empty).
   */
  static appendConventions(
    projectRoot: string,
    epicId: string,
    storyId: string,
    recordedAt: string,
    texts: string[]
  ): number {
    if (texts.length === 0) return 0;
    const file = EpicBuildup.pathFor(projectRoot, epicId);
    fs.mkdirSync(path.dirname(file), { recursive: true });

    const doc: EpicBuildupDoc = EpicBuildup.read(projectRoot, epicId) ?? {
      epicId,
      version: 1,
      entries: [],
      conventions: [],
    };

    const existingHashes = new Set(doc.conventions.map((c) => c.hash));
    let added = 0;

    for (const raw of texts) {
      // Enforce per-entry length cap (defensive — parser already truncates, but store-side is the trust boundary).
      const text = raw.slice(0, MAX_CONVENTION_CHARS);
      const hash = sha256(text);
      if (existingHashes.has(hash)) continue;
      // Enforce per-story cap at ingest (store-side, never trusting worker).
      if (added >= MAX_CONVENTIONS_PER_STORY) break;
      doc.conventions.push({ storyId, recordedAt, text, hash });
      existingHashes.add(hash);
      added++;
    }

    if (added === 0) return 0;
    atomicWrite(file, doc);
    return added;
  }

  /**
   * Renders a size-capped injection block: conventions (reserved sub-budget)
   * first, then story entries newest-first. Returns empty string for an empty doc.
   */
  static renderForInjection(doc: EpicBuildupDoc, budgetChars = EPIC_BUILDUP_INJECT_BUDGET): string {
    const parts: string[] = [];

    // Conventions block (reserved sub-budget, but always subject to the overall cap).
    if (doc.conventions.length > 0) {
      const convLines = doc.conventions.map((c) => `- [${c.storyId}] ${c.text}`);
      const convBlock =
        '#### Discovered conventions & gotchas\n' + convLines.join('\n');
      const convCap = Math.min(CONVENTIONS_INJECT_BUDGET, budgetChars);
      const capped =
        convBlock.length <= convCap ? convBlock : convBlock.slice(0, convCap);
      parts.push(capped);
    }

    // Story entries newest-first.
    const reversed = [...doc.entries].reverse();
    for (const entry of reversed) {
      const block = `#### ${entry.storyId}: ${entry.title}\n${entry.body}`;
      const remaining = budgetChars - parts.reduce((s, p) => s + p.length, 0);
      if (remaining <= 0) break;
      parts.push(block.length <= remaining ? block : block.slice(0, remaining));
    }

    return parts.join('\n\n');
  }
}

// ─── Internal helpers ──────────────────────────────────────────────────────────

function sha256(text: string): string {
  return crypto.createHash('sha256').update(text, 'utf8').digest('hex');
}

function atomicWrite(file: string, doc: EpicBuildupDoc): void {
  const tmp = `${file}.tmp-${process.pid}`;
  try {
    fs.writeFileSync(tmp, JSON.stringify(doc, null, 2), 'utf8');
    fs.renameSync(tmp, file);
  } catch (err) {
    try { fs.rmSync(tmp, { force: true }); } catch {}
    throw err;
  }
}

function isValidDoc(v: unknown): v is EpicBuildupDoc {
  if (typeof v !== 'object' || v === null) return false;
  const o = v as Record<string, unknown>;
  return (
    typeof o.epicId === 'string' &&
    o.version === 1 &&
    Array.isArray(o.entries) &&
    Array.isArray(o.conventions)
  );
}
