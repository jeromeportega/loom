/**
 * Doc-scrub assertions for story-003-005.
 *
 * Verifies that loom-MCP-surface language has been removed from all docs owned
 * by this story: docs/capabilities.md, CLAUDE.md, README.md,
 * docs/getting-started/index.md, and docs/index.md.
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
];

const FORBIDDEN_STRINGS = [
  'loom-mcp',
  'loom serve',
  'loom init --mcp',
  'mcp__loom',
  'first-class',
  'primary surface',
  'two interfaces over the same engine',
] as const;

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
  const capabilities = fs.readFileSync(
    path.join(REPO_ROOT, 'docs', 'capabilities.md'),
    'utf8'
  );

  it('capabilities.md retains loom mcp add provisioning row', () => {
    assert.ok(
      capabilities.includes('loom mcp add'),
      'capabilities.md must retain the "loom mcp add" provisioning row'
    );
  });

  it('capabilities.md retains policy.mcp.registry reference', () => {
    assert.ok(
      capabilities.includes('policy.mcp.registry'),
      'capabilities.md must retain policy.mcp.registry (worker-provisioning config)'
    );
  });

  it('capabilities.md retains cursor-mcp-strictness.md research link', () => {
    assert.ok(
      capabilities.includes('cursor-mcp-strictness.md'),
      'capabilities.md must retain the link to the retained research doc'
    );
  });
});

describe('docs scrub (story-003-005) — CLI=usability, web=observability reframing', () => {
  const capabilities = fs.readFileSync(
    path.join(REPO_ROOT, 'docs', 'capabilities.md'),
    'utf8'
  );
  const readme = fs.readFileSync(path.join(REPO_ROOT, 'README.md'), 'utf8');

  it('capabilities.md contains CLI=usability, web=observability framing', () => {
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
    assert.ok(
      readme.includes('usability surface') || readme.includes('CLI is the usability'),
      'README.md should frame the CLI as the usability surface'
    );
  });

  it('README.md observability surface framing is present', () => {
    assert.ok(
      readme.includes('observability surface') || readme.includes('observability'),
      'README.md should reference observability'
    );
  });

  it('capabilities.md Init row no longer lists --mcp option', () => {
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
