import { SharedContract } from './SharedContract.js';

/**
 * One (owner, path) pair lifted from an epic contract's file-ownership table.
 * `path` is the only thing callers act on, and only ever for string
 * compare/display (overlap advisories) — never opened, statted, or executed.
 * Keep it that way: nothing in this module touches `fs` keyed on a parsed path.
 */
export interface OwnershipEntry {
  /** Owning epic id, e.g. 'epic-007'. */
  epicId: string;
  /** Owning story id, e.g. 'story-007-003', when the owner cell carries one. */
  storyId?: string;
  /**
   * Manifest slug of the repo this path belongs to. When absent, the entry is
   * treated as belonging to the primary repo (resolved by the caller or by
   * the `primarySlug` argument to `computeOverlaps`). Single-repo epics omit
   * this field entirely — behaviour is unchanged from before cross-repo support.
   */
  repo?: string;
  /** Repo-relative POSIX path; backticks / `(new)` / `(delete)` / trailing prose stripped. */
  path: string;
}

/** One entry per (owner, path) pair extracted from the ownership table. */
export type OwnershipMap = OwnershipEntry[];

// The heading that introduces the ownership table in every epic contract
// (Winston's architect persona emits it verbatim). We match it loosely:
// any markdown heading level, optional surrounding bold/emphasis markers, and
// case-insensitive — but the literal phrase must be present.
const OWNERSHIP_HEADING = /^#{1,6}\s+.*file\s*&\s*module\s+ownership\s+map/i;

// A table row is any line that starts (after optional indent) with a pipe.
const TABLE_ROW = /^\s*\|/;

// The header/body separator: a row whose every cell is dashes (with optional
// alignment colons). `| --- | --- |`, `|:---|:---:|`, etc.
const SEPARATOR_ROW = /^\s*\|(?:\s*:?-+:?\s*\|)+\s*$/;

// Cells within a path column are separated by a comma, a middle dot (the
// delimiter the real epic 001–006 contracts use), or an HTML line break.
const PATH_DELIMITER = /[,·]|<br\s*\/?>/;

// A story id anywhere in an owner cell, e.g. 'story-007-003'. Epic id is the
// 'epic-NNN' prefix of it; a bare 'epic-007' owner has no story segment.
const STORY_ID = /story-(\d+)-\d+/i;
const EPIC_ID = /epic-(\d+)/i;

/**
 * Parses the "File & module ownership map" table from an epic contract.
 *
 * Hand-rolled and total, mirroring `parseListModelsOutput`: every input
 * returns an `OwnershipMap` (possibly empty) and no input throws. A row that
 * does not yield a usable (owner, path) pair is silently skipped — a malformed
 * contract degrades to fewer entries, never to a crash that would block the
 * overlap advisory that consumes this.
 *
 * Scanning is linear: find the heading, then read the contiguous pipe-table
 * beneath it. The first table row is the header and the next is the dash
 * separator; both are skipped. Each remaining row contributes one entry per
 * path token in column 2, all attributed to column 1's owner.
 *
 * `epicId` is the contract's own epic and is used as the fallback owner when a
 * row's owner cell carries no explicit `epic-NNN` (the common case — rows name
 * a story, and the epic is implied by which contract we are reading).
 */
export function parseOwnershipMap(markdown: string, epicId: string): OwnershipMap {
  const entries: OwnershipMap = [];
  const lines = markdown.split('\n');

  // 1. Locate the heading.
  let i = 0;
  for (; i < lines.length; i++) {
    if (OWNERSHIP_HEADING.test(lines[i])) break;
  }
  if (i >= lines.length) return entries; // no ownership section -> empty map

  // 2. Skip down to the first table row beneath the heading.
  i++;
  while (i < lines.length && !TABLE_ROW.test(lines[i])) {
    // A new heading before any table means the section had no table.
    if (/^#{1,6}\s/.test(lines[i])) return entries;
    i++;
  }
  if (i >= lines.length) return entries;

  // 3. Walk the contiguous table. Skip the header row and a dash separator row
  //    if present; everything else is a data row.
  let seenHeader = false;
  let repoColIdx = -1; // -1 = no Repo column present
  let pathColIdx = 1;  // default: Owns is in column index 1 (two-column layout)

  for (; i < lines.length && TABLE_ROW.test(lines[i]); i++) {
    const row = lines[i];
    if (SEPARATOR_ROW.test(row)) continue;
    if (!seenHeader) {
      seenHeader = true; // first non-separator pipe row is the column header
      // Detect optional Repo column by scanning header cells. The cross-repo
      // layout is | Story | Repo | Owns |; single-repo omits the middle column.
      const headerCells = splitRow(row);
      for (let ci = 0; ci < headerCells.length; ci++) {
        if (/^repo(sitory)?$/i.test(headerCells[ci].trim())) {
          repoColIdx = ci;
          pathColIdx = ci + 1; // Owns column immediately follows Repo
          break;
        }
      }
      continue;
    }

    const cells = splitRow(row);
    if (cells.length < pathColIdx + 1) continue; // need enough columns

    const owner = parseOwner(cells[0], epicId);
    if (!owner) continue; // unparseable owner cell -> skip the whole row

    // Extract repo slug when the Repo column is present.
    let repo: string | undefined;
    if (repoColIdx >= 0 && repoColIdx < cells.length) {
      const slug = cells[repoColIdx].trim();
      if (slug.length > 0) repo = slug;
    }

    for (const token of cells[pathColIdx].split(PATH_DELIMITER)) {
      const normalized = normalizePath(token);
      if (!normalized) continue; // empty / prose-only token -> skip just it
      entries.push({
        epicId: owner.epicId,
        ...(owner.storyId ? { storyId: owner.storyId } : {}),
        ...(repo !== undefined ? { repo } : {}),
        path: normalized,
      });
    }
  }

  return entries;
}

/**
 * Loads and parses the ownership map for `epicId` from its materialized
 * contract at `.loom/contract/<epic-id>.md` (the `SharedContract` convention).
 * Returns `null` when no contract exists — the shared-contract-off case — so
 * callers can cleanly skip the overlap advisory rather than treat absence as an
 * empty (but present) map.
 */
export function loadOwnershipMap(projectRoot: string, epicId: string): OwnershipMap | null {
  const body = SharedContract.read(projectRoot, epicId);
  if (body === null) return null;
  return parseOwnershipMap(body, epicId);
}

/** Splits a markdown table row into trimmed cell strings, dropping the edge pipes. */
function splitRow(row: string): string[] {
  const trimmed = row.trim().replace(/^\|/, '').replace(/\|$/, '');
  return trimmed.split('|').map((c) => c.trim());
}

/**
 * Resolves a row's owner cell to an epic id (+ optional story id). The cell may
 * carry backticks, bold markers, or trailing prose; we only need the id tokens.
 * Falls back to the contract's own `epicId` when the cell names a story without
 * an explicit epic, or names neither.
 */
function parseOwner(cell: string, epicId: string): { epicId: string; storyId?: string } | undefined {
  const storyMatch = STORY_ID.exec(cell);
  if (storyMatch) {
    // 'story-007-003' -> epic 'epic-007' unless the cell also spells out an epic.
    const epicMatch = EPIC_ID.exec(cell);
    return {
      epicId: epicMatch ? `epic-${epicMatch[1]}` : `epic-${storyMatch[1]}`,
      storyId: storyMatch[0].toLowerCase(),
    };
  }
  const epicMatch = EPIC_ID.exec(cell);
  if (epicMatch) return { epicId: `epic-${epicMatch[1]}` };
  // No id at all: still attribute to the contract's epic if the cell is
  // otherwise non-empty (a bare path-owner). A truly empty owner cell can't own.
  if (cell.trim().length > 0) return { epicId };
  return undefined;
}

/** Extension allowlist for path-like token detection — exported so callers can import rather than duplicate. */
export const KNOWN_EXT = /\.(ts|tsx|js|jsx|mjs|cjs|json|md|ya?ml|sql|sh|css|html)$/i;

/** True when a slash-normalised token looks like a file path. */
function isPathLike(token: string): boolean {
  return token.includes('/') || KNOWN_EXT.test(token);
}

/**
 * Normalizes a single path token from a cell:
 *  - strip surrounding backticks,
 *  - strip `(new)` / `(delete)` style parenthesized annotations,
 *  - keep only the leading path token (drop trailing prose after whitespace),
 *  - convert backslashes to POSIX separators and trim a leading `./`.
 * Returns '' when nothing path-like remains (bare words, code fragments, etc.).
 */
export function normalizePath(token: string): string {
  let s = token.trim();
  // Strip parenthesized annotations anywhere: `foo.ts (new)`, `(delete) bar`.
  s = s.replace(/\([^)]*\)/g, ' ').trim();
  // Strip surrounding backticks (and any stray ones the table used for code).
  s = s.replace(/`/g, '').trim();
  if (!s) return '';
  // Keep the first whitespace-delimited token; the rest is trailing prose
  // ("src/foo.ts the entry point" -> "src/foo.ts").
  const head = s.split(/\s+/)[0];
  // Normalize separators to POSIX; preserve a leading './' so that
  // extensionless root files written as './Makefile' still pass the gate below.
  const posix = head.replace(/\\/g, '/');
  // Reject tokens with no path content (pure punctuation left over).
  if (!/[A-Za-z0-9]/.test(posix)) return '';
  // Final gate: only include tokens that look like file paths (path separator
  // or known source-file extension). A leading './' makes extensionless root
  // files detectable; bare words and code fragments are excluded here.
  if (!isPathLike(posix)) return '';
  // Normalize away the leading './' for storage.
  return posix.replace(/^\.\//, '');
}

// ---------------------------------------------------------------------------
// Cross-epic overlap advisory (story-007-008) + within-epic detection (story-028-001)
//
// Consumes the OwnershipMap above to flag files claimed by more than one epic
// (cross-epic) or by more than one story within the same epic (within-epic).
// Both advisories are ADVISORY: they warn, they never block. The comparison is
// deliberately the dumbest thing that can work — EXACT lexical path equality
// after the parser's normalization — because the entire epic-007 effort exists
// to kill the false-failure mode that smarter matching (globbing, directory-
// prefix inference, semantic analysis) reintroduces. Same-directory-different-
// filename collisions go unflagged on purpose; that is an accepted trade-off.
// ---------------------------------------------------------------------------

/**
 * One file claimed by two or more epics, with every owner that claims it.
 * `owners` always has length >= 2 (a path owned by a single epic is not an
 * overlap) and lists the (epic, story) pair from each contributing map.
 */
export interface Overlap {
  /** The exact repo-relative POSIX path both/all owners share. */
  path: string;
  /**
   * Manifest slug of the repo where the conflict was detected. Populated from
   * `entry.repo ?? primarySlug`; absent when `primarySlug` was not provided
   * (single-repo callers that pass no slug). Cross-repo consumers use this to
   * emit unambiguous conflict messages when two repos share the same relative path.
   */
  repo?: string;
  /** Every owner claiming `path`, across all compared maps. */
  owners: Array<{ epicId: string; storyId?: string }>;
}

/**
 * Builds a path-to-owners index from a flat OwnershipMap, accumulating all
 * owners for each exact path. Shared by computeOverlaps() and
 * computeWithinEpicOverlaps() so the indexing loop lives in one place.
 */
function groupOwnersByPath(
  map: OwnershipMap
): Map<string, Array<{ epicId: string; storyId?: string }>> {
  const result = new Map<string, Array<{ epicId: string; storyId?: string }>>();
  for (const entry of map) {
    const owner: { epicId: string; storyId?: string } = entry.storyId
      ? { epicId: entry.epicId, storyId: entry.storyId }
      : { epicId: entry.epicId };
    const list = result.get(entry.path);
    if (list) list.push(owner);
    else result.set(entry.path, [owner]);
  }
  return result;
}

/**
 * Computes the set of files the `target` ownership map shares with any of the
 * `others`, by EXACT lexical path equality within the same repo. The comparison
 * key is the composite `${repo}\0${path}` so the same relative path in two
 * different repos is NOT a conflict — only the same path in the same repo is.
 *
 * `primarySlug` is the manifest slug of the primary repo. Entries whose `repo`
 * field is absent resolve to `primarySlug` for keying purposes. When `primarySlug`
 * is omitted (single-repo callers that have no manifest context), all repo-absent
 * entries are treated as belonging to the same implicit repo and still collide
 * correctly — single-repo behaviour is unchanged.
 *
 * Every owner (the target's plus each other map's) of a shared (repo, path) is
 * listed in `owners`. A path that appears only in the target, or only in the
 * others, is not an overlap. Order of paths follows first appearance in `target`.
 */
export function computeOverlaps(
  target: OwnershipMap,
  others: Map<string, OwnershipMap>,
  primarySlug = '',
): Overlap[] {
  // Composite key: repo (defaulting to primarySlug) + NUL separator + path.
  const repoKey = (e: OwnershipEntry): string => `${e.repo ?? primarySlug}\0${e.path}`;

  // Index all other-map entries by composite key.
  const otherOwnersByKey = new Map<string, Array<{ epicId: string; storyId?: string }>>();
  for (const map of others.values()) {
    for (const entry of map) {
      const key = repoKey(entry);
      const owner: { epicId: string; storyId?: string } = entry.storyId
        ? { epicId: entry.epicId, storyId: entry.storyId }
        : { epicId: entry.epicId };
      const list = otherOwnersByKey.get(key);
      if (list) list.push(owner);
      else otherOwnersByKey.set(key, [owner]);
    }
  }

  const overlaps: Overlap[] = [];
  const seen = new Set<string>();
  for (const entry of target) {
    const key = repoKey(entry);
    const otherOwners = otherOwnersByKey.get(key);
    if (!otherOwners) continue; // no other epic claims this exact (repo, path)
    if (seen.has(key)) continue; // already recorded this (repo, path)
    seen.add(key);

    const targetOwner = entry.storyId
      ? { epicId: entry.epicId, storyId: entry.storyId }
      : { epicId: entry.epicId };
    const repoValue = entry.repo ?? primarySlug;
    overlaps.push({
      path: entry.path,
      ...(repoValue ? { repo: repoValue } : {}),
      owners: [targetOwner, ...otherOwners],
    });
  }

  return overlaps;
}

/**
 * Detects files declared by two or more distinct stories within a single
 * epic's OwnershipMap, using EXACT lexical path equality — no globbing, no
 * directory-prefix inference. Only story-attributed entries (storyId present)
 * participate; epic-level entries without a story are not story-to-story
 * conflicts. A single story claiming the same path twice is NOT an overlap —
 * overlap requires ≥2 distinct storyIds.
 *
 * Routes through groupOwnersByPath(), the same helper used by computeOverlaps(),
 * so the indexing logic lives in exactly one place.
 */
export function computeWithinEpicOverlaps(map: OwnershipMap): Overlap[] {
  const ownersByPath = groupOwnersByPath(map);
  const overlaps: Overlap[] = [];

  for (const [path, owners] of ownersByPath) {
    // Collect one representative owner per distinct storyId.
    const byStoryId = new Map<string, { epicId: string; storyId: string }>();
    for (const o of owners) {
      if (o.storyId !== undefined && !byStoryId.has(o.storyId)) {
        byStoryId.set(o.storyId, { epicId: o.epicId, storyId: o.storyId });
      }
    }
    if (byStoryId.size < 2) continue; // single story (or no stories) — not an overlap
    overlaps.push({ path, owners: [...byStoryId.values()] });
  }

  return overlaps;
}

/**
 * Renders overlaps into operator-facing advisory lines. Empty input -> `[]`
 * (the caller prints nothing). The copy frames the result explicitly as a
 * "lexical path match only" finding so an operator never reads the advisory as
 * a definitive conflict — it is a heads-up, not a gate. The caller prints these
 * lines; this function never exits.
 */
export function renderOverlapAdvisory(overlaps: Overlap[]): string[] {
  if (overlaps.length === 0) return [];

  const lines: string[] = [];
  const fileWord = overlaps.length === 1 ? 'file' : 'files';
  lines.push(
    `  Cross-epic overlap advisory (lexical path match only): ${overlaps.length} ${fileWord} claimed by more than one epic.`
  );
  for (const overlap of overlaps) {
    lines.push(`    ${overlap.path}`);
    for (const owner of overlap.owners) {
      const who = owner.storyId ? `${owner.epicId} / ${owner.storyId}` : owner.epicId;
      lines.push(`      - ${who}`);
    }
  }
  lines.push(
    '  This is a lexical path match only — not a conflict. Review before dispatch; nothing is blocked.'
  );
  return lines;
}
