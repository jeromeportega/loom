/**
 * Narrative-sweep assertions for story-064-006.
 *
 * Corpus-wide consistency pass over the realigned narrative and operational docs:
 *
 * (1) DEFERRED_DENYLIST — five "not yet shipped" items must never read as shipped
 *     in any narrative/operational doc.  They may appear only in explicitly-unshipped
 *     contexts (e.g. "— not shipped." as in cross-repo-loom-home.md).
 *
 * (2) Artifact-location claim — docs/use-cases/index.md must contain the
 *     ARTIFACT_RELOCATION canonical string verbatim and must not reference
 *     `.loom_outputs/<epic-id>/` as the current artifact location.
 *
 * (3) docs/strategy/positioning.md must not reference `.loom_outputs/<epic-id>/`
 *     as the artifact promotion path (now loom-home `repos/<slug>/<epic-id>/`).
 *
 * (4) MODEL_TIER_PHRASING — docs/architecture/index.md must not contain pinned
 *     model version strings ("Claude 4.x", "Claude Sonnet N.N") in its prose
 *     (code-block schema defaults are a distinct form and not tested here).
 *
 * Out of scope (historical records — do not add to corpus):
 *   docs/reviews/**, docs/runbooks/**, docs/eval/**, docs/research/**,
 *   docs/testing/**, docs/dogfooding/**
 */
import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

// ─── Repo root resolution ────────────────────────────────────────────────────

function findRepoRoot(): string {
  let dir = __dirname;
  for (let i = 0; i < 12; i++) {
    if (
      fs.existsSync(path.join(dir, 'packages', 'loom-core')) &&
      fs.existsSync(path.join(dir, 'packages', 'loom-cli'))
    ) {
      return dir;
    }
    dir = path.dirname(dir);
  }
  throw new Error('narrativeSweep.test: could not locate monorepo root');
}

function readDoc(repoRoot: string, rel: string): string {
  return fs.readFileSync(path.join(repoRoot, rel), 'utf8');
}

// ─── Canonical correction strings (ADR-003, epic-064) ───────────────────────

const ARTIFACT_RELOCATION =
  'Delivered artifacts live in the loom-home control plane; target repositories receive only code pull requests.';

// ─── Narrative + operational corpus ─────────────────────────────────────────

const CORPUS_REL = [
  'README.md',
  'CLAUDE.md',
  'docs/index.md',
  'docs/use-cases/index.md',
  'docs/getting-started/index.md',
  'docs/configuration.md',
  'docs/architecture/cli-command-descriptions.md',
  'docs/architecture/cross-repo-loom-home.md',
  'docs/architecture/index.md',
  'docs/strategy/positioning.md',
  'docs/operations/known-limitations.md',
  'docs/operations/releasing.md',
];

// ─── DEFERRED_DENYLIST entries ───────────────────────────────────────────────
// Each term that must NOT read as shipped.
// If a term appears in a corpus file, EVERY line containing the term must
// carry an explicit "not shipped" marker, so the context is unambiguous.

interface DenyEntry {
  term: string;
  // Regex a matching line must satisfy (i.e. the line acknowledges the item is unshipped).
  allowedLinePattern: RegExp;
  // Human label for error messages.
  label: string;
}

const DEFERRED_DENYLIST: DenyEntry[] = [
  {
    term: 'Mission Control',
    allowedLinePattern: /not shipped|deferred|unshipped/i,
    label: 'Mission Control (interactive web)',
  },
  {
    term: 'Jira',
    allowedLinePattern: /not shipped|deferred|unshipped/i,
    label: 'Jira intake adapter',
  },
  {
    term: 'cost prediction',
    allowedLinePattern: /not shipped|deferred|unshipped/i,
    label: 'cost prediction model',
  },
  {
    term: 'unified work-item',
    allowedLinePattern: /not shipped|deferred|unshipped/i,
    label: 'unified work-item / card model',
  },
  {
    term: 'card model',
    allowedLinePattern: /not shipped|deferred|unshipped/i,
    label: 'unified card model',
  },
];

// "sharing DB-resident learnings to a team remote" - split across phrase;
// check by phrase fragments.
const TEAM_REMOTE_TERM = 'team remote';
const TEAM_REMOTE_ALLOWED = /not shipped|deferred|unshipped/i;

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('narrative-sweep (story-064-006) — corpus files exist', () => {
  let repoRoot: string;

  before(() => {
    repoRoot = findRepoRoot();
  });

  it('all corpus files exist on disk', () => {
    for (const rel of CORPUS_REL) {
      assert.ok(
        fs.existsSync(path.join(repoRoot, rel)),
        `Expected corpus file to exist: ${rel}`
      );
    }
  });
});

describe('narrative-sweep (story-064-006) — DEFERRED_DENYLIST: items must not read as shipped', () => {
  let repoRoot: string;
  let corpusContents: Map<string, string>;

  before(() => {
    repoRoot = findRepoRoot();
    corpusContents = new Map(
      CORPUS_REL.map((rel) => [rel, readDoc(repoRoot, rel)])
    );
  });

  for (const entry of DEFERRED_DENYLIST) {
    it(`"${entry.label}" never reads as shipped in corpus`, () => {
      const violations: string[] = [];
      for (const [rel, content] of corpusContents) {
        const lines = content.split('\n');
        for (let i = 0; i < lines.length; i++) {
          const line = lines[i];
          if (line.includes(entry.term) && !entry.allowedLinePattern.test(line)) {
            violations.push(`${rel}:${i + 1}: ${line.trim()}`);
          }
        }
      }
      assert.deepEqual(
        violations,
        [],
        `"${entry.label}" appears as shipped (no "not shipped" context):\n${violations.join('\n')}`
      );
    });
  }

  it('"sharing DB-resident learnings to a team remote" never reads as shipped in corpus', () => {
    const violations: string[] = [];
    for (const [rel, content] of corpusContents) {
      const lines = content.split('\n');
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        if (line.includes(TEAM_REMOTE_TERM) && !TEAM_REMOTE_ALLOWED.test(line)) {
          violations.push(`${rel}:${i + 1}: ${line.trim()}`);
        }
      }
    }
    assert.deepEqual(
      violations,
      [],
      `"sharing DB-resident learnings to a team remote" appears as shipped:\n${violations.join('\n')}`
    );
  });
});

describe('narrative-sweep (story-064-006) — artifact-location claim (docs/use-cases/index.md)', () => {
  let repoRoot: string;
  let content: string;

  before(() => {
    repoRoot = findRepoRoot();
    content = readDoc(repoRoot, 'docs/use-cases/index.md');
  });

  it('does not claim artifacts live under .loom_outputs/<epic-id>/', () => {
    assert.ok(
      !content.includes('.loom_outputs/<epic-id>/'),
      'docs/use-cases/index.md must not reference .loom_outputs/<epic-id>/ (artifacts now live in loom-home)'
    );
  });

  it('contains ARTIFACT_RELOCATION canonical string verbatim', () => {
    assert.ok(
      content.includes(ARTIFACT_RELOCATION),
      `docs/use-cases/index.md must contain ARTIFACT_RELOCATION verbatim:\n  "${ARTIFACT_RELOCATION}"`
    );
  });
});

describe('narrative-sweep (story-064-006) — artifact-location claim (docs/strategy/positioning.md)', () => {
  let repoRoot: string;
  let content: string;

  before(() => {
    repoRoot = findRepoRoot();
    content = readDoc(repoRoot, 'docs/strategy/positioning.md');
  });

  it('EpicFinalizer row does not reference .loom_outputs/<epic-id>/ as artifact path', () => {
    assert.ok(
      !content.includes('.loom_outputs/<epic-id>/'),
      'docs/strategy/positioning.md must not reference .loom_outputs/<epic-id>/ (artifact path is now loom-home repos/<slug>/<epic-id>/)'
    );
  });
});

describe('narrative-sweep (story-064-006) — MODEL_TIER_PHRASING (docs/architecture/index.md)', () => {
  let repoRoot: string;
  let content: string;

  before(() => {
    repoRoot = findRepoRoot();
    content = readDoc(repoRoot, 'docs/architecture/index.md');
  });

  it('tech stack table does not pin "Claude 4.x"', () => {
    assert.ok(
      !content.includes('Claude 4.x'),
      'docs/architecture/index.md tech stack table must not pin "Claude 4.x" — use "the latest Claude models"'
    );
  });

  it('ADR prose does not contain "Claude Sonnet 4.6"', () => {
    assert.ok(
      !content.includes('Claude Sonnet 4.6'),
      'docs/architecture/index.md ADR-004 must not pin "Claude Sonnet 4.6" — use "the latest Claude models"'
    );
  });
});
