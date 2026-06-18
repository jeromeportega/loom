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
  for (; i < lines.length && TABLE_ROW.test(lines[i]); i++) {
    const row = lines[i];
    if (SEPARATOR_ROW.test(row)) continue;
    if (!seenHeader) {
      seenHeader = true; // first non-separator pipe row is the column header
      continue;
    }

    const cells = splitRow(row);
    if (cells.length < 2) continue; // need at least owner + path columns

    const owner = parseOwner(cells[0], epicId);
    if (!owner) continue; // unparseable owner cell -> skip the whole row

    for (const token of cells[1].split(PATH_DELIMITER)) {
      const normalized = normalizePath(token);
      if (!normalized) continue; // empty / prose-only token -> skip just it
      entries.push({ epicId: owner.epicId, ...(owner.storyId ? { storyId: owner.storyId } : {}), path: normalized });
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
// Cross-epic overlap advisory (story-007-008)
//
// Consumes the OwnershipMap above to flag files claimed by more than one epic.
// This is an ADVISORY: it warns, it never blocks. The comparison is deliberately
// the dumbest thing that can work — EXACT lexical path equality after the
// parser's normalization — because the entire epic-007 effort exists to kill the
// false-failure mode that smarter matching (globbing, directory-prefix
// inference, semantic analysis) reintroduces. Same-directory-different-filename
// collisions go unflagged on purpose; that is an accepted trade-off.
// ---------------------------------------------------------------------------

/**
 * One file claimed by two or more epics, with every owner that claims it.
 * `owners` always has length >= 2 (a path owned by a single epic is not an
 * overlap) and lists the (epic, story) pair from each contributing map.
 */
export interface Overlap {
  /** The exact repo-relative POSIX path both/all owners share. */
  path: string;
  /** Every owner claiming `path`, across all compared maps. */
  owners: Array<{ epicId: string; storyId?: string }>;
}

/**
 * Computes the set of files the `target` ownership map shares with any of the
 * `others`, by EXACT lexical path equality (`===`) — no globbing, no
 * directory-prefix inference, no case folding, no semantics. `src/a.ts` and
 * `src/A.ts` are different paths; `src/a.ts` and `src/` are different paths.
 *
 * Every owner (the target's plus each other map's) of a shared path is listed
 * in `owners`. A path that appears only in the target, or only in the others,
 * is not an overlap. Order of paths follows first appearance in `target`.
 */
export function computeOverlaps(
  target: OwnershipMap,
  others: Map<string, OwnershipMap>
): Overlap[] {
  // Index every other map's owners by exact path so each target path is a
  // single lookup. A path may be claimed by several other epics (or several
  // stories within one), so the value is a list of owners.
  const otherOwnersByPath = new Map<string, Array<{ epicId: string; storyId?: string }>>();
  for (const map of others.values()) {
    for (const entry of map) {
      const list = otherOwnersByPath.get(entry.path);
      const owner = entry.storyId
        ? { epicId: entry.epicId, storyId: entry.storyId }
        : { epicId: entry.epicId };
      if (list) list.push(owner);
      else otherOwnersByPath.set(entry.path, [owner]);
    }
  }

  const overlaps: Overlap[] = [];
  const seen = new Set<string>();
  for (const entry of target) {
    const otherOwners = otherOwnersByPath.get(entry.path);
    if (!otherOwners) continue; // no other epic claims this exact path
    if (seen.has(entry.path)) continue; // already recorded this path
    seen.add(entry.path);

    const targetOwner = entry.storyId
      ? { epicId: entry.epicId, storyId: entry.storyId }
      : { epicId: entry.epicId };
    overlaps.push({ path: entry.path, owners: [targetOwner, ...otherOwners] });
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
