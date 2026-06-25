/**
 * Doc-scrub assertions for story-003-005.
 *
 * Verifies that loom-MCP-surface language has been removed from all docs owned
 * by this story: docs/capabilities.md, CLAUDE.md, README.md,
 * docs/getting-started/index.md, and docs/index.md.
 *
 * docs/operations/releasing.md is owned by story-003-004 and was audited there;
 * it is intentionally NOT included here to avoid a silent ordering dependency
 * between stories — story-003-004's test suite covers that file.
 *
 * Note: this file itself contains the forbidden strings as string literals in
 * FORBIDDEN_STRINGS; that is unavoidable for a forbidden-string test. The
 * OWNED_FILES scan excludes this test file, so the AC's "zero hits in owned
 * docs" is not violated.
 *
 * The mechanical done-ness bar (ADR-004): the seven forbidden strings must
 * return zero hits in the owned files. Retained mentions (loom mcp add/list,
 * provisioning docs) must be preserved.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

// __dirname = packages/loom-cli/dist/__tests__
const REPO_ROOT = path.resolve(__dirname, '../../../..');

const OWNED_FILES = [
  path.join(REPO_ROOT, 'CLAUDE.md'),
  path.join(REPO_ROOT, 'README.md'),
  path.join(REPO_ROOT, 'docs', 'capabilities.md'),
  path.join(REPO_ROOT, 'docs', 'index.md'),
  path.join(REPO_ROOT, 'docs', 'getting-started', 'index.md'),
  // docs/operations/releasing.md is owned by story-003-004; covered by its test suite
];

const FORBIDDEN_STRINGS: string[] = [
  'loom-mcp',
  'loom serve',
  'loom init --mcp',
  'mcp__loom',
  'first-class',
  'primary surface',
  'two interfaces over the same engine',
];

describe('docs scrub (story-003-005) — forbidden strings absent from owned files', () => {
  it('all owned files exist on disk', () => {
    for (const f of OWNED_FILES) {
      assert.ok(fs.existsSync(f), `Expected file to exist: ${path.relative(REPO_ROOT, f)}`);
    }
  });

  for (const forbidden of FORBIDDEN_STRINGS) {
    it(`"${forbidden}" is absent from all owned docs`, () => {
      const hits: string[] = [];
      for (const f of OWNED_FILES) {
        if (!fs.existsSync(f)) continue;
        const content = fs.readFileSync(f, 'utf8');
        if (content.includes(forbidden)) {
          const lines = content.split('\n');
          const lineNums = lines
            .map((l, i) => (l.includes(forbidden) ? i + 1 : -1))
            .filter((n) => n !== -1);
          hits.push(`${path.relative(REPO_ROOT, f)}:${lineNums.join(',')}`);
        }
      }
      assert.deepEqual(
        hits,
        [],
        `Forbidden string "${forbidden}" found in: ${hits.join('; ')}`
      );
    });
  }
});

describe('docs scrub (story-003-005) — retained provisioning content preserved', () => {
  it('capabilities.md retains loom mcp add provisioning row', () => {
    const capabilities = fs.readFileSync(
      path.join(REPO_ROOT, 'docs', 'capabilities.md'),
      'utf8'
    );
    assert.ok(
      capabilities.includes('loom mcp add'),
      'capabilities.md must retain the "loom mcp add" provisioning row'
    );
  });

  it('capabilities.md retains policy.mcp.registry reference', () => {
    const capabilities = fs.readFileSync(
      path.join(REPO_ROOT, 'docs', 'capabilities.md'),
      'utf8'
    );
    assert.ok(
      capabilities.includes('policy.mcp.registry'),
      'capabilities.md must retain policy.mcp.registry (worker-provisioning config)'
    );
  });

  it('capabilities.md retains cursor-mcp-strictness.md research link', () => {
    const capabilities = fs.readFileSync(
      path.join(REPO_ROOT, 'docs', 'capabilities.md'),
      'utf8'
    );
    assert.ok(
      capabilities.includes('cursor-mcp-strictness.md'),
      'capabilities.md must retain the link to the retained research doc'
    );
  });
});

describe('docs scrub (story-003-005) — CLI=usability, web=observability reframing', () => {
  it('capabilities.md contains CLI=usability, web=observability framing', () => {
    const capabilities = fs.readFileSync(
      path.join(REPO_ROOT, 'docs', 'capabilities.md'),
      'utf8'
    );
    assert.ok(
      capabilities.includes('CLI = usability') || capabilities.includes('CLI=usability'),
      'capabilities.md should reflect CLI = usability framing'
    );
    assert.ok(
      capabilities.includes('web = observability') || capabilities.includes('web=observability'),
      'capabilities.md should reflect web = observability framing'
    );
  });

  it('README.md usability surface framing is present', () => {
    const readme = fs.readFileSync(path.join(REPO_ROOT, 'README.md'), 'utf8');
    assert.ok(
      readme.includes('usability surface') || readme.includes('CLI is the usability'),
      'README.md should frame the CLI as the usability surface'
    );
  });

  it('README.md observability surface framing is present', () => {
    const readme = fs.readFileSync(path.join(REPO_ROOT, 'README.md'), 'utf8');
    assert.ok(
      readme.includes('observability surface') || readme.includes('observability'),
      'README.md should reference observability'
    );
  });

  it('capabilities.md Init row no longer lists --mcp option', () => {
    const capabilities = fs.readFileSync(
      path.join(REPO_ROOT, 'docs', 'capabilities.md'),
      'utf8'
    );
    const lines = capabilities.split('\n');
    const initRow = lines.find(
      (l) => l.includes('**Init in any repo**') && l.trimStart().startsWith('|')
    );
    assert.ok(initRow, 'capabilities.md must contain the "Init in any repo" row');
    assert.ok(
      !initRow!.includes('--mcp'),
      'Init row must not list --mcp (option was removed)'
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// story-064-001 — v6.0.0 narrative, canonical corrections, model-version guard
// ─────────────────────────────────────────────────────────────────────────────

// Verbatim canonical phrasings from the shared contract (ADR-003, epic-064).
// Both headline files must contain these exact strings (identical phrasing
// across both files is the correctness bar for the cross-epic consistency
// invariant).
const ARTIFACT_RELOCATION_VERBATIM =
  'Delivered artifacts live in the loom-home control plane; target repositories receive only code pull requests.';

const CROSS_REPO_LANDING_VERBATIM =
  'A single-repo epic produces one pull request. A cross-repo epic produces one pull request per repository, landed in topological (dependency) order with all-ready-or-none staging and forward-revert rollback.';

const MODEL_TIER_PHRASING_VERBATIM = 'the latest Claude models';

const HEADLINE_FILES = [
  { label: 'README.md', filePath: path.join(REPO_ROOT, 'README.md') },
  { label: 'docs/index.md', filePath: path.join(REPO_ROOT, 'docs', 'index.md') },
];

describe('docs scrub (story-064-001) — ARTIFACT_RELOCATION canonical string', () => {
  for (const { label, filePath } of HEADLINE_FILES) {
    it(`${label}: contains ARTIFACT_RELOCATION verbatim`, () => {
      const content = fs.readFileSync(filePath, 'utf8');
      assert.ok(
        content.includes(ARTIFACT_RELOCATION_VERBATIM),
        `${label} must contain the ARTIFACT_RELOCATION canonical string verbatim`
      );
    });

    it(`${label}: does not claim artifacts land in .loom_outputs/<epic-id>/ in your repo`, () => {
      const content = fs.readFileSync(filePath, 'utf8');
      assert.ok(
        !content.includes('.loom_outputs/<epic-id>/'),
        `${label} must not claim artifacts land in .loom_outputs/<epic-id>/ (replaced by ARTIFACT_RELOCATION)`
      );
    });
  }
});

describe('docs scrub (story-064-001) — CROSS_REPO_LANDING canonical string', () => {
  for (const { label, filePath } of HEADLINE_FILES) {
    it(`${label}: contains CROSS_REPO_LANDING verbatim`, () => {
      const content = fs.readFileSync(filePath, 'utf8');
      assert.ok(
        content.includes(CROSS_REPO_LANDING_VERBATIM),
        `${label} must contain the CROSS_REPO_LANDING canonical string verbatim`
      );
    });
  }
});

describe('docs scrub (story-064-001) — MODEL_TIER_PHRASING and no pinned versions', () => {
  for (const { label, filePath } of HEADLINE_FILES) {
    it(`${label}: no pinned model version (Opus/Sonnet/Haiku N.N)`, () => {
      const content = fs.readFileSync(filePath, 'utf8');
      const match = /\b(Opus|Sonnet|Haiku)\s+\d+\.\d+/.exec(content);
      assert.ok(
        match === null,
        `${label} must not pin a model version — found: "${match?.[0] ?? ''}"`
      );
    });

    it(`${label}: contains MODEL_TIER_PHRASING ("the latest Claude models")`, () => {
      const content = fs.readFileSync(filePath, 'utf8');
      assert.ok(
        content.includes(MODEL_TIER_PHRASING_VERBATIM),
        `${label} must use MODEL_TIER_PHRASING verbatim: "the latest Claude models"`
      );
    });
  }
});

describe('docs scrub (story-064-001) — v6.0.0 narrative tokens', () => {
  const V6_TOKENS = [
    'self-learning',
    'self-healing',
    'cross-repo',
    'loom-home',
    'all-ready-or-none',
    'loom cost',
  ];

  for (const { label, filePath } of HEADLINE_FILES) {
    for (const token of V6_TOKENS) {
      it(`${label}: contains v6.0.0 token "${token}"`, () => {
        const content = fs.readFileSync(filePath, 'utf8');
        assert.ok(
          content.includes(token),
          `${label} must contain v6.0.0 narrative token "${token}"`
        );
      });
    }
  }
});
