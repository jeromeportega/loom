import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  parseOwnershipMap,
  loadOwnershipMap,
  normalizePath,
  computeOverlaps,
  computeWithinEpicOverlaps,
  renderOverlapAdvisory,
  type OwnershipEntry,
  type OwnershipMap,
} from '../ContractOwnership.js';

// __dirname = packages/loom-core/dist/orchestrator/__tests__ at runtime, but the
// .md fixtures are not emitted into dist by tsc, so resolve them from the src
// tree: up to the package root, then back down into src/.
const FIXTURES = path.resolve(
  __dirname,
  '../../../src/orchestrator/__tests__/fixtures/ownership'
);

function fixture(epicId: string): string {
  return fs.readFileSync(path.join(FIXTURES, `${epicId}.md`), 'utf8');
}

/** Convenience: the set of paths a parse produced, order-independent. */
function pathSet(map: OwnershipMap): Set<string> {
  return new Set(map.map((e) => e.path));
}

describe('parseOwnershipMap — heading + table extraction', () => {
  const md =
    '# Contract\n\n' +
    '## File & module ownership map\n\n' +
    '| Story | Owns |\n' +
    '| --- | --- |\n' +
    '| story-007-003 | `packages/loom-core/src/foo.ts` |\n' +
    '| epic-007 | `packages/loom-core/src/bar.ts` |\n';

  it('extracts one entry per row with owner + normalized path', () => {
    const map = parseOwnershipMap(md, 'epic-007');
    assert.deepEqual(map, [
      { epicId: 'epic-007', storyId: 'story-007-003', path: 'packages/loom-core/src/foo.ts' },
      { epicId: 'epic-007', path: 'packages/loom-core/src/bar.ts' },
    ]);
  });

  it('attributes a story-owner row to the epic derived from its story id', () => {
    const map = parseOwnershipMap(md, 'epic-007');
    assert.equal(map[0].storyId, 'story-007-003');
    assert.equal(map[0].epicId, 'epic-007');
  });

  it('returns an empty map when the heading is absent', () => {
    const map = parseOwnershipMap('# Contract\n\nNo ownership section here.\n', 'epic-007');
    assert.deepEqual(map, []);
  });

  it('returns an empty map when the heading has no table beneath it', () => {
    const md2 =
      '## File & module ownership map\n\nProse, then another section.\n\n## Next section\n';
    assert.deepEqual(parseOwnershipMap(md2, 'epic-007'), []);
  });
});

describe('parseOwnershipMap — multi-path cell splitting', () => {
  it('splits on comma, middle dot, and <br> — one entry per token', () => {
    const md =
      '## File & module ownership map\n' +
      '| Story | Owns |\n' +
      '| --- | --- |\n' +
      '| story-007-001 | `a/one.ts`, `a/two.ts` · `a/three.ts`<br>`a/four.ts` |\n';
    const map = parseOwnershipMap(md, 'epic-007');
    assert.deepEqual(pathSet(map), new Set(['a/one.ts', 'a/two.ts', 'a/three.ts', 'a/four.ts']));
    for (const e of map) {
      assert.equal(e.epicId, 'epic-007');
      assert.equal(e.storyId, 'story-007-001');
    }
  });

  it('handles <br/> and <br /> self-closing variants', () => {
    const md =
      '## File & module ownership map\n' +
      '| Story | Owns |\n' +
      '| --- | --- |\n' +
      '| epic-007 | a.ts<br/>b.ts<br />c.ts |\n';
    assert.deepEqual(pathSet(parseOwnershipMap(md, 'epic-007')), new Set(['a.ts', 'b.ts', 'c.ts']));
  });
});

describe('parseOwnershipMap — per-path normalization', () => {
  function paths(cell: string): string[] {
    const md =
      '## File & module ownership map\n' +
      '| Story | Owns |\n' +
      '| --- | --- |\n' +
      `| epic-007 | ${cell} |\n`;
    return parseOwnershipMap(md, 'epic-007').map((e) => e.path);
  }

  it('strips surrounding backticks', () => {
    assert.deepEqual(paths('`src/foo.ts`'), ['src/foo.ts']);
  });

  it('strips (new) and (delete) annotations', () => {
    assert.deepEqual(paths('`src/foo.ts` (new)'), ['src/foo.ts']);
    assert.deepEqual(paths('src/bar.ts (delete)'), ['src/bar.ts']);
    assert.deepEqual(paths('src/baz.ts (sole editor)'), ['src/baz.ts']);
  });

  it('strips trailing prose after the path token', () => {
    assert.deepEqual(paths('`src/epic.ts` (reservation ordering)'), ['src/epic.ts']);
    assert.deepEqual(paths('src/run.ts the dispatch entry point'), ['src/run.ts']);
  });

  it('normalizes Windows separators to POSIX and drops a leading ./', () => {
    assert.deepEqual(paths('src\\nested\\file.ts'), ['src/nested/file.ts']);
    assert.deepEqual(paths('./src/foo.ts'), ['src/foo.ts']);
  });
});

describe('parseOwnershipMap — totality (never throws)', () => {
  it('skips a row missing the path column without throwing', () => {
    const md =
      '## File & module ownership map\n' +
      '| Story | Owns |\n' +
      '| --- | --- |\n' +
      '| story-007-001 |\n' + // only one cell
      '| story-007-002 | `src/ok.ts` |\n';
    const map = parseOwnershipMap(md, 'epic-007');
    assert.deepEqual(pathSet(map), new Set(['src/ok.ts']));
  });

  it('skips a garbage path cell (annotation only) without throwing', () => {
    const md =
      '## File & module ownership map\n' +
      '| Story | Owns |\n' +
      '| --- | --- |\n' +
      '| story-007-001 | (delete) |\n' +
      '| story-007-002 | `src/ok.ts` |\n';
    assert.deepEqual(pathSet(parseOwnershipMap(md, 'epic-007')), new Set(['src/ok.ts']));
  });

  it('skips a row whose owner cell is empty', () => {
    const md =
      '## File & module ownership map\n' +
      '| Story | Owns |\n' +
      '| --- | --- |\n' +
      '|  | `src/orphan.ts` |\n' +
      '| story-007-002 | `src/ok.ts` |\n';
    assert.deepEqual(pathSet(parseOwnershipMap(md, 'epic-007')), new Set(['src/ok.ts']));
  });

  it('does not throw on arbitrary / empty / non-markdown input', () => {
    for (const input of ['', '\n\n\n', '###', 'not | a | table', '|||||', '·,·,·']) {
      assert.doesNotThrow(() => parseOwnershipMap(input, 'epic-007'));
      assert.ok(Array.isArray(parseOwnershipMap(input, 'epic-007')));
    }
  });
});

describe('loadOwnershipMap', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'loom-ownership-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('returns null when no contract exists (shared_contract = off)', () => {
    assert.equal(loadOwnershipMap(tmpDir, 'epic-007'), null);
  });

  it('returns a populated map when the contract is present', () => {
    const dir = path.join(tmpDir, '.loom', 'contract');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'epic-007.md'), fixture('epic-001'), 'utf8');
    const map = loadOwnershipMap(tmpDir, 'epic-007');
    assert.ok(map !== null);
    assert.ok(map!.length > 0);
  });
});

describe('parseOwnershipMap — real-contract fixtures (epics 001–006, · delimiter)', () => {
  // Expected normalized path sets lifted from each epic's real ownership table.
  const expected: Record<string, string[]> = {
    'epic-001': [
      'packages/loom-core/src/brief/gate.ts',
      'packages/loom-core/src/brief/__tests__/gate.test.ts',
      'packages/loom-core/src/brief/BriefRefiner.ts',
      'packages/loom-core/src/brief/types.ts',
      'packages/loom-cli/src/commands/epic.ts',
      'packages/loom-cli/src/index.ts',
      'packages/loom-mcp/src/tools/registry.ts',
      'packages/loom-core/src/state/AuditLog.ts',
    ],
    'epic-002': [
      'packages/loom-core/src/mcp/WorktreeMcp.ts',
      'packages/loom-core/src/mcp/__tests__/WorktreeMcp.test.ts',
      'packages/loom-core/src/orchestrator/CursorMcpEnforcer.ts',
      'packages/loom-core/src/orchestrator/ClaudeCodeWorker.ts',
      'packages/loom-core/src/orchestrator/Supervisor.ts',
      'packages/loom-core/src/mcp/adapter.ts',
    ],
    'epic-003': [
      'packages/loom-core/src/orchestrator/GatePreflight.ts',
      'packages/loom-core/src/orchestrator/IntegrationGate.ts',
      'packages/loom-core/src/orchestrator/GateDryRun.ts',
      'packages/loom-core/src/orchestrator/git.ts',
      'packages/loom-cli/src/commands/doctorGateCheck.ts',
      'packages/loom-cli/src/index.ts',
    ],
    'epic-004': [
      'packages/loom-core/src/orchestrator/BaseCliWorker.ts',
      'packages/loom-core/src/orchestrator/CursorAgentWorker.ts',
      'packages/loom-core/src/orchestrator/configWarnings.ts',
      'packages/loom-core/src/orchestrator/workerFactory.ts',
      'packages/loom-core/src/orchestrator/WorkerTimeoutGuard.ts',
    ],
    'epic-005': [
      'packages/loom-core/src/types.ts',
      'packages/loom-core/src/state/EpicStore.ts',
      'packages/loom-core/src/orchestrator/EpicFinalizer.ts',
      'packages/loom-core/src/orchestrator/IntegrationGate.ts',
      'packages/loom-core/src/orchestrator/Supervisor.ts',
    ],
    'epic-006': [
      'packages/loom-core/src/orchestrator/resilience/constants.ts',
      'packages/loom-core/src/orchestrator/resilience/RetryClock.ts',
      'packages/loom-core/src/orchestrator/InfraFailureClassifier.ts',
      'packages/loom-core/src/state/Database.ts',
      'packages/loom-core/src/orchestrator/InfraRetryController.ts',
      'packages/loom-cli/src/commands/retry.ts',
    ],
  };

  for (const epicId of Object.keys(expected)) {
    it(`${epicId} round-trips to the expected normalized path set`, () => {
      const map = parseOwnershipMap(fixture(epicId), epicId);
      assert.deepEqual(pathSet(map), new Set(expected[epicId]));
      // Every entry is attributed to the contract's epic, and no path carries
      // backticks, parens, or whitespace (proof of normalization).
      for (const e of map) {
        assert.equal(e.epicId, epicId);
        assert.doesNotMatch(e.path, /[`()\s]/);
        assert.doesNotMatch(e.path, /\\/); // POSIX separators only
      }
    });
  }

  it('attaches the correct story id to each fixture entry', () => {
    const map = parseOwnershipMap(fixture('epic-001'), 'epic-001');
    const gateEntry = map.find((e) => e.path === 'packages/loom-core/src/brief/gate.ts');
    assert.equal(gateEntry?.storyId, 'story-001-001');
  });
});

describe('parseOwnershipMap — security: no fs access keyed on parsed paths', () => {
  it('returns paths for compare/display only, never touching the filesystem', () => {
    // The fixtures name real source files. Parsing must NOT stat/open them: we
    // point the parser at a path that exists on disk and assert it is returned
    // verbatim as a string, not resolved against or read from the fs.
    const md =
      '## File & module ownership map\n' +
      '| Story | Owns |\n' +
      '| --- | --- |\n' +
      '| story-007-007 | `packages/loom-core/src/orchestrator/ContractOwnership.ts` |\n' +
      '| story-007-007 | `does/not/exist/anywhere.ts` |\n';
    const map = parseOwnershipMap(md, 'epic-007');
    // A non-existent path is returned identically to a real one — proof the
    // parser does no existence check.
    assert.deepEqual(pathSet(map), new Set([
      'packages/loom-core/src/orchestrator/ContractOwnership.ts',
      'does/not/exist/anywhere.ts',
    ]));
  });
});

// ---------------------------------------------------------------------------
// isPathLike gate — tested via the exported normalizePath
// ---------------------------------------------------------------------------

describe('normalizePath — isPathLike TRUE (path-shaped tokens are kept) [AC1][AC2]', () => {
  // Tokens with a path separator or known source-file extension must survive.
  it('keeps tokens with a path separator', () => {
    assert.equal(normalizePath('src/foo.ts'), 'src/foo.ts');
    assert.equal(normalizePath('a/b'), 'a/b');
    assert.equal(normalizePath('packages/loom-core/src/orchestrator/ContractOwnership.ts'),
      'packages/loom-core/src/orchestrator/ContractOwnership.ts');
  });

  it('makes extensionless root files detectable via a leading ./', () => {
    // ./Makefile carries a '/' that survives the gate; the ./ is stripped for storage.
    assert.equal(normalizePath('./Makefile'), 'Makefile');
  });

  it('keeps every known extension — ts/tsx', () => {
    assert.equal(normalizePath('foo.ts'), 'foo.ts');
    assert.equal(normalizePath('foo.tsx'), 'foo.tsx');
    assert.equal(normalizePath('Foo.TS'), 'Foo.TS'); // case-insensitive
  });

  it('keeps every known extension — js/jsx/mjs/cjs', () => {
    assert.equal(normalizePath('foo.js'), 'foo.js');
    assert.equal(normalizePath('foo.jsx'), 'foo.jsx');
    assert.equal(normalizePath('foo.mjs'), 'foo.mjs');
    assert.equal(normalizePath('foo.cjs'), 'foo.cjs');
  });

  it('keeps every known extension — json/md/yaml/yml', () => {
    assert.equal(normalizePath('config.json'), 'config.json');
    assert.equal(normalizePath('x.md'), 'x.md');
    assert.equal(normalizePath('config.yaml'), 'config.yaml');
    assert.equal(normalizePath('config.yml'), 'config.yml');
  });

  it('keeps every known extension — sql/sh/css/html', () => {
    assert.equal(normalizePath('schema.sql'), 'schema.sql');
    assert.equal(normalizePath('install.sh'), 'install.sh');
    assert.equal(normalizePath('styles.css'), 'styles.css');
    assert.equal(normalizePath('index.html'), 'index.html');
  });

  it('non-existent paths still pass — existence is not a gate [AC2]', () => {
    assert.equal(normalizePath('does/not/exist/yet.ts'), 'does/not/exist/yet.ts');
    assert.equal(normalizePath('future-epic/new-feature.ts'), 'future-epic/new-feature.ts');
  });
});

describe('normalizePath — isPathLike FALSE (non-path tokens are excluded) [AC1]', () => {
  // Bare words, extensionless names, and code fragments must all return ''.
  it('excludes bare words with no extension or separator', () => {
    assert.equal(normalizePath('computeOverlaps'), '');
    assert.equal(normalizePath('loom'), '');
    assert.equal(normalizePath('LICENSE'), '');
  });

  it('excludes extensionless root filenames (no leading ./)', () => {
    assert.equal(normalizePath('Makefile'), '');
    assert.equal(normalizePath('Dockerfile'), '');
  });

  it('excludes code fragments', () => {
    // foo() — parens stripped by annotation regex, leaving bare "foo"
    assert.equal(normalizePath('foo()'), '');
    // if(!x) — parens stripped, leaving bare "if"
    assert.equal(normalizePath('if(!x)'), '');
    // ${VAR} — no separator, no known extension
    assert.equal(normalizePath('${VAR}'), '');
  });

  it('existing pure-punctuation rejection still holds', () => {
    assert.equal(normalizePath('(delete)'), '');
    assert.equal(normalizePath(''), '');
    assert.equal(normalizePath('---'), '');
  });
});

// ---------------------------------------------------------------------------
// Regression fixture — false bare-word entries now produce zero results [AC4]
// ---------------------------------------------------------------------------

describe('regression fixture — no false bare-word or code-fragment entries [AC4][AC5]', () => {
  // A realistic planning input that previously produced false entries
  // (bare words and code fragments in the path column).
  const regressionMd =
    '## File & module ownership map\n' +
    '| Story | Owns |\n' +
    '| --- | --- |\n' +
    // Row mixing bare words, code fragments, and one real path:
    '| story-007-001 | computeOverlaps · loom · Makefile · foo() · ${VAR} · packages/loom-core/src/real.ts |\n';

  it('produces zero non-path entries from a contract with bare words and code fragments [AC4]', () => {
    const map = parseOwnershipMap(regressionMd, 'epic-007');
    // Every entry in the map must be a genuine path (has / or known extension).
    const nonPath = map.filter(
      (e) => !e.path.includes('/') && !/\.(ts|tsx|js|jsx|mjs|cjs|json|md|ya?ml|sql|sh|css|html)$/i.test(e.path)
    );
    assert.equal(nonPath.length, 0, `Expected 0 non-path entries, got: ${JSON.stringify(nonPath)}`);
    // The previously-false bare words must be absent.
    assert.ok(!map.some((e) => e.path === 'computeOverlaps'), 'computeOverlaps must not appear');
    assert.ok(!map.some((e) => e.path === 'loom'), 'loom must not appear');
    assert.ok(!map.some((e) => e.path === 'Makefile'), 'Makefile must not appear');
    assert.ok(!map.some((e) => e.path === 'foo'), 'foo must not appear');
  });

  it('still reports a genuinely shared path-shaped file — advisory must not go dark [AC5]', () => {
    // Two epics each own the same real path; computeOverlaps must surface it.
    const targetMd =
      '## File & module ownership map\n' +
      '| Story | Owns |\n' +
      '| --- | --- |\n' +
      '| story-007-001 | packages/loom-core/src/real.ts |\n';
    const otherMd =
      '## File & module ownership map\n' +
      '| Story | Owns |\n' +
      '| --- | --- |\n' +
      '| story-008-001 | packages/loom-core/src/real.ts |\n';

    const target = parseOwnershipMap(targetMd, 'epic-007');
    const others = new Map([['epic-008', parseOwnershipMap(otherMd, 'epic-008')]]);
    const overlaps = computeOverlaps(target, others);

    assert.equal(overlaps.length, 1);
    assert.equal(overlaps[0].path, 'packages/loom-core/src/real.ts');
    assert.ok(overlaps[0].owners.length >= 2, 'shared path must have >= 2 owners');

    const advisory = renderOverlapAdvisory(overlaps);
    assert.ok(Array.isArray(advisory), 'renderOverlapAdvisory must return string[]');
    assert.ok(advisory.length > 0, 'advisory must not be empty for a real overlap');
    assert.ok(
      advisory.some((line) => line.includes('packages/loom-core/src/real.ts')),
      'advisory output must contain the shared path'
    );
  });
});

// ---------------------------------------------------------------------------
// Advisory-only: renderOverlapAdvisory never throws or blocks [AC3]
// ---------------------------------------------------------------------------

describe('advisory-only: renderOverlapAdvisory returns strings and never blocks [AC3]', () => {
  it('returns an empty array when there are no overlaps', () => {
    const result = renderOverlapAdvisory([]);
    assert.deepEqual(result, []);
  });

  it('returns string[] for overlaps without throwing or exiting', () => {
    const overlaps = [
      { path: 'src/shared.ts', owners: [{ epicId: 'epic-001', storyId: 'story-001-001' }, { epicId: 'epic-002' }] },
    ];
    let result: string[];
    assert.doesNotThrow(() => {
      result = renderOverlapAdvisory(overlaps);
    });
    assert.ok(Array.isArray(result!));
    assert.ok(result!.every((line) => typeof line === 'string'));
    assert.ok(result!.some((line) => line.includes('src/shared.ts')));
    // The advisory copy must frame this as non-blocking.
    assert.ok(
      result!.some((line) => line.toLowerCase().includes('advisory') || line.toLowerCase().includes('not a conflict')),
      'advisory output must include non-blocking framing'
    );
  });
});

// ---------------------------------------------------------------------------
// computeWithinEpicOverlaps — story-028-001
// ---------------------------------------------------------------------------

/** Builds an OwnershipEntry for a story in epic-028. */
function storyEntry(storyId: string, filePath: string): OwnershipEntry {
  return { epicId: 'epic-028', storyId, path: filePath };
}

describe('computeWithinEpicOverlaps — empty and disjoint inputs', () => {
  it('returns empty for an empty map', () => {
    assert.deepEqual(computeWithinEpicOverlaps([]), []);
  });

  it('returns empty when all stories own distinct paths', () => {
    const map: OwnershipMap = [
      storyEntry('story-028-001', 'packages/loom-core/src/foo.ts'),
      storyEntry('story-028-002', 'packages/loom-core/src/bar.ts'),
    ];
    assert.deepEqual(computeWithinEpicOverlaps(map), []);
  });
});

describe('computeWithinEpicOverlaps — happy path: same-file overlap detection [AC-1]', () => {
  it('two stories declaring the exact same path produce one Overlap with both storyIds', () => {
    const map: OwnershipMap = [
      storyEntry('story-028-001', 'packages/loom-core/src/shared.ts'),
      storyEntry('story-028-002', 'packages/loom-core/src/shared.ts'),
    ];
    const overlaps = computeWithinEpicOverlaps(map);
    assert.equal(overlaps.length, 1);
    assert.equal(overlaps[0].path, 'packages/loom-core/src/shared.ts');
    const storyIds = overlaps[0].owners.map((o) => o.storyId).sort();
    assert.deepEqual(storyIds, ['story-028-001', 'story-028-002']);
  });

  it('all owners in a within-epic Overlap have storyId populated', () => {
    const map: OwnershipMap = [
      storyEntry('story-028-001', 'packages/loom-core/src/shared.ts'),
      storyEntry('story-028-002', 'packages/loom-core/src/shared.ts'),
    ];
    const overlaps = computeWithinEpicOverlaps(map);
    for (const o of overlaps[0].owners) {
      assert.ok(o.storyId !== undefined, 'every within-epic owner must carry storyId');
    }
  });
});

describe('computeWithinEpicOverlaps — N>2 stories on one path', () => {
  it('three stories on the same path produce one Overlap carrying all three owners', () => {
    const map: OwnershipMap = [
      storyEntry('story-028-001', 'packages/loom-core/src/shared.ts'),
      storyEntry('story-028-002', 'packages/loom-core/src/shared.ts'),
      storyEntry('story-028-003', 'packages/loom-core/src/shared.ts'),
    ];
    const overlaps = computeWithinEpicOverlaps(map);
    assert.equal(overlaps.length, 1);
    assert.equal(overlaps[0].path, 'packages/loom-core/src/shared.ts');
    const storyIds = overlaps[0].owners.map((o) => o.storyId).sort();
    assert.deepEqual(storyIds, ['story-028-001', 'story-028-002', 'story-028-003']);
  });

  it('reports one Overlap per conflicting path, not one per pair', () => {
    const map: OwnershipMap = [
      storyEntry('story-028-001', 'packages/loom-core/src/a.ts'),
      storyEntry('story-028-002', 'packages/loom-core/src/a.ts'),
      storyEntry('story-028-003', 'packages/loom-core/src/a.ts'),
      storyEntry('story-028-004', 'packages/loom-core/src/a.ts'),
    ];
    const overlaps = computeWithinEpicOverlaps(map);
    assert.equal(overlaps.length, 1, 'one Overlap per conflicting path regardless of owner count');
    assert.equal(overlaps[0].owners.length, 4);
  });
});

describe('computeWithinEpicOverlaps — duplicate-entry guard', () => {
  it('same story declaring the same path twice is NOT an overlap (requires ≥2 distinct storyIds)', () => {
    const map: OwnershipMap = [
      storyEntry('story-028-001', 'packages/loom-core/src/foo.ts'),
      storyEntry('story-028-001', 'packages/loom-core/src/foo.ts'),
    ];
    assert.deepEqual(computeWithinEpicOverlaps(map), []);
  });

  it('same story with multiple paths but no cross-story sharing is not an overlap', () => {
    const map: OwnershipMap = [
      storyEntry('story-028-001', 'packages/loom-core/src/foo.ts'),
      storyEntry('story-028-001', 'packages/loom-core/src/bar.ts'),
    ];
    assert.deepEqual(computeWithinEpicOverlaps(map), []);
  });
});

describe('computeWithinEpicOverlaps — real-paths-only [AC-2]', () => {
  it('free-text tokens parsed from a contract do not produce overlaps', () => {
    // Two stories each own the same bare word and the same code fragment, plus
    // distinct real paths. parseOwnershipMap filters the non-path tokens, so
    // computeWithinEpicOverlaps sees only the real paths and finds no shared one.
    const md =
      '## File & module ownership map\n' +
      '| Story | Owns |\n' +
      '| --- | --- |\n' +
      '| story-028-001 | computeOverlaps · loom · `packages/loom-core/src/foo.ts` |\n' +
      '| story-028-002 | computeOverlaps · loom · `packages/loom-core/src/bar.ts` |\n';
    const map = parseOwnershipMap(md, 'epic-028');
    assert.deepEqual(computeWithinEpicOverlaps(map), []);
  });
});

describe('computeWithinEpicOverlaps — normalization [AC-2]', () => {
  it('./x.ts and x.ts parsed from a contract collapse to the same path and produce one overlap', () => {
    const md =
      '## File & module ownership map\n' +
      '| Story | Owns |\n' +
      '| --- | --- |\n' +
      '| story-028-001 | `./packages/loom-core/src/foo.ts` |\n' +
      '| story-028-002 | `packages/loom-core/src/foo.ts` |\n';
    const map = parseOwnershipMap(md, 'epic-028');
    const overlaps = computeWithinEpicOverlaps(map);
    assert.equal(overlaps.length, 1);
    assert.equal(overlaps[0].path, 'packages/loom-core/src/foo.ts');
  });

  it('genuinely different paths do not collapse (exact-lexical equality, no globbing)', () => {
    const map: OwnershipMap = [
      storyEntry('story-028-001', 'packages/loom-core/src/foo.ts'),
      storyEntry('story-028-002', 'packages/loom-core/src/bar.ts'),
    ];
    assert.deepEqual(computeWithinEpicOverlaps(map), []);
  });
});

describe('computeWithinEpicOverlaps — no-drift: computeOverlaps unchanged after refactor [AC-3][AC-4]', () => {
  it('computeOverlaps still surfaces a cross-epic shared path after groupOwnersByPath extraction', () => {
    const targetMd =
      '## File & module ownership map\n' +
      '| Story | Owns |\n' +
      '| --- | --- |\n' +
      '| story-007-001 | packages/loom-core/src/real.ts |\n';
    const otherMd =
      '## File & module ownership map\n' +
      '| Story | Owns |\n' +
      '| --- | --- |\n' +
      '| story-008-001 | packages/loom-core/src/real.ts |\n';
    const target = parseOwnershipMap(targetMd, 'epic-007');
    const others = new Map([['epic-008', parseOwnershipMap(otherMd, 'epic-008')]]);
    const overlaps = computeOverlaps(target, others);
    assert.equal(overlaps.length, 1);
    assert.equal(overlaps[0].path, 'packages/loom-core/src/real.ts');
    assert.ok(overlaps[0].owners.length >= 2);
  });

  it('computeOverlaps returns empty when no path is shared across epics', () => {
    const target = parseOwnershipMap(fixture('epic-001'), 'epic-001');
    const others = new Map([['epic-002', parseOwnershipMap(fixture('epic-002'), 'epic-002')]]);
    assert.deepEqual(computeOverlaps(target, others), []);
  });
});

// ---------------------------------------------------------------------------
// Cross-repo interface contract (story-058-004)
//
// computeOverlaps is re-keyed from `path` to `${repo}\0${path}` so the same
// relative path in two different repos is NOT a false conflict, while the same
// path in the same repo IS still detected.
// ---------------------------------------------------------------------------

/** Build a minimal OwnershipEntry with an explicit repo. */
function repoEntry(epicId: string, storyId: string, repo: string, filePath: string): OwnershipEntry {
  return { epicId, storyId, repo, path: filePath };
}

describe('computeOverlaps — cross-repo keying (story-058-004) [AC1]', () => {
  it('same relative path in two DIFFERENT repos is NOT reported as a conflict', () => {
    // Producer: src/shared.ts in repo-a
    const target: OwnershipMap = [
      repoEntry('epic-058', 'story-058-004', 'repo-a', 'src/shared.ts'),
    ];
    // Consumer: same path but in repo-b
    const others = new Map<string, OwnershipMap>([
      ['epic-058', [repoEntry('epic-058', 'story-058-005', 'repo-b', 'src/shared.ts')]],
    ]);
    const overlaps = computeOverlaps(target, others, 'repo-a');
    assert.equal(overlaps.length, 0, 'cross-repo same-path must not be flagged as an overlap');
  });

  it('same relative path in the SAME repo IS reported as a conflict [AC2]', () => {
    const target: OwnershipMap = [
      repoEntry('epic-001', 'story-001-001', 'repo-a', 'src/shared.ts'),
    ];
    const others = new Map<string, OwnershipMap>([
      ['epic-002', [repoEntry('epic-002', 'story-002-001', 'repo-a', 'src/shared.ts')]],
    ]);
    const overlaps = computeOverlaps(target, others, 'repo-a');
    assert.equal(overlaps.length, 1, 'same-repo same-path must still be flagged');
    assert.equal(overlaps[0].path, 'src/shared.ts');
    assert.ok(overlaps[0].owners.length >= 2);
  });

  it('multiple paths — only same-repo conflicts surfaced', () => {
    const target: OwnershipMap = [
      repoEntry('epic-001', 'story-001-001', 'repo-a', 'src/foo.ts'), // same-repo conflict
      repoEntry('epic-001', 'story-001-002', 'repo-a', 'src/bar.ts'), // unique path
      repoEntry('epic-001', 'story-001-003', 'repo-b', 'src/baz.ts'), // cross-repo, no conflict
    ];
    const others = new Map<string, OwnershipMap>([
      ['epic-002', [
        repoEntry('epic-002', 'story-002-001', 'repo-a', 'src/foo.ts'), // same repo → conflict
        repoEntry('epic-002', 'story-002-002', 'repo-a', 'src/baz.ts'), // different path than repo-b entry
      ]],
    ]);
    const overlaps = computeOverlaps(target, others, 'repo-a');
    assert.equal(overlaps.length, 1, 'only the same-repo same-path pair is a conflict');
    assert.equal(overlaps[0].path, 'src/foo.ts');
  });
});

describe('computeOverlaps — omitted repo defaults to primarySlug [AC3]', () => {
  it('two entries with repo omitted and same path collide (both resolve to primarySlug)', () => {
    const target: OwnershipMap = [
      { epicId: 'epic-001', storyId: 'story-001-001', path: 'src/shared.ts' }, // no repo
    ];
    const others = new Map<string, OwnershipMap>([
      ['epic-002', [{ epicId: 'epic-002', storyId: 'story-002-001', path: 'src/shared.ts' }]],
    ]);
    const overlaps = computeOverlaps(target, others, 'primary-repo');
    assert.equal(overlaps.length, 1, 'omitted-repo entries on the same path must still collide');
    assert.equal(overlaps[0].path, 'src/shared.ts');
  });

  it('entry with repo omitted does NOT conflict with same path in a DIFFERENT explicit repo', () => {
    // omitted-repo → primary ('repo-a'); explicit repo-b entry → no conflict
    const target: OwnershipMap = [
      { epicId: 'epic-001', storyId: 'story-001-001', path: 'src/shared.ts' }, // repo = 'repo-a' (primary)
    ];
    const others = new Map<string, OwnershipMap>([
      ['epic-002', [repoEntry('epic-002', 'story-002-001', 'repo-b', 'src/shared.ts')]],
    ]);
    const overlaps = computeOverlaps(target, others, 'repo-a');
    assert.equal(overlaps.length, 0, 'omitted-repo (primary) vs explicit-different-repo must not conflict');
  });

  it('entry with repo omitted DOES conflict with same path in the SAME explicit primary repo', () => {
    const target: OwnershipMap = [
      { epicId: 'epic-001', storyId: 'story-001-001', path: 'src/shared.ts' }, // repo = undefined → 'repo-a'
    ];
    const others = new Map<string, OwnershipMap>([
      ['epic-002', [repoEntry('epic-002', 'story-002-001', 'repo-a', 'src/shared.ts')]], // explicit primary
    ]);
    const overlaps = computeOverlaps(target, others, 'repo-a');
    assert.equal(overlaps.length, 1, 'omitted-repo vs same explicit primary repo is a conflict');
  });
});

describe('computeOverlaps — single-repo regression [AC5]', () => {
  it('when every entry omits repo, behaviour is byte-for-byte identical to pre-change', () => {
    // Simulate a pre-existing single-repo scenario — no repo field on any entry.
    const targetMd =
      '## File & module ownership map\n' +
      '| Story | Owns |\n' +
      '| --- | --- |\n' +
      '| story-007-001 | packages/loom-core/src/real.ts |\n';
    const otherMd =
      '## File & module ownership map\n' +
      '| Story | Owns |\n' +
      '| --- | --- |\n' +
      '| story-008-001 | packages/loom-core/src/real.ts |\n';
    const target = parseOwnershipMap(targetMd, 'epic-007');
    const others = new Map([['epic-008', parseOwnershipMap(otherMd, 'epic-008')]]);
    // Calling without primarySlug (backward-compat) or with one — same path still collides.
    const withoutSlug = computeOverlaps(target, others);
    const withSlug = computeOverlaps(target, others, 'loom');
    assert.equal(withoutSlug.length, 1, 'no primarySlug: same path must still conflict');
    assert.equal(withSlug.length, 1, 'with primarySlug: same path must still conflict');
    assert.equal(withoutSlug[0].path, 'packages/loom-core/src/real.ts');
    assert.equal(withSlug[0].path, 'packages/loom-core/src/real.ts');
  });

  it('single-repo: disjoint paths across epics produce no overlaps', () => {
    const target = parseOwnershipMap(fixture('epic-001'), 'epic-001');
    const others = new Map([['epic-002', parseOwnershipMap(fixture('epic-002'), 'epic-002')]]);
    assert.deepEqual(computeOverlaps(target, others), []);
    assert.deepEqual(computeOverlaps(target, others, 'loom'), []);
  });
});

describe('parseOwnershipMap — repo column round-trip [blocker fix]', () => {
  const mdWithRepoCol =
    '## File & module ownership map\n\n' +
    '| Story | Repo | Owns |\n' +
    '|---|---|---|\n' +
    '| story-058-004 | producer-svc | `packages/loom-core/src/orchestrator/ContractOwnership.ts` |\n' +
    '| story-058-005 | consumer-svc | `packages/loom-core/src/orchestrator/CrossRepoCoordinator.ts` |\n';

  it('populates entry.repo from the Repo column', () => {
    const map = parseOwnershipMap(mdWithRepoCol, 'epic-058');
    assert.equal(map.length, 2);
    assert.equal(map[0].repo, 'producer-svc');
    assert.equal(map[0].path, 'packages/loom-core/src/orchestrator/ContractOwnership.ts');
    assert.equal(map[1].repo, 'consumer-svc');
    assert.equal(map[1].path, 'packages/loom-core/src/orchestrator/CrossRepoCoordinator.ts');
  });

  it('entries from a two-column table (no Repo column) still have repo: undefined', () => {
    const md =
      '## File & module ownership map\n' +
      '| Story | Owns |\n' +
      '| --- | --- |\n' +
      '| story-007-001 | `src/foo.ts` |\n';
    const map = parseOwnershipMap(md, 'epic-007');
    assert.equal(map.length, 1);
    assert.equal(map[0].repo, undefined, 'single-repo table must not produce a repo field');
  });

  it('parsed cross-repo entries with the same path in different repos do NOT conflict', () => {
    const mdA =
      '## File & module ownership map\n' +
      '| Story | Repo | Owns |\n' +
      '|---|---|---|\n' +
      '| story-058-001 | repo-a | `src/shared.ts` |\n';
    const mdB =
      '## File & module ownership map\n' +
      '| Story | Repo | Owns |\n' +
      '|---|---|---|\n' +
      '| story-058-002 | repo-b | `src/shared.ts` |\n';
    const target = parseOwnershipMap(mdA, 'epic-058');
    const others = new Map([['epic-058-b', parseOwnershipMap(mdB, 'epic-058')]]);
    assert.equal(target[0].repo, 'repo-a', 'parseOwnershipMap must set repo from the Repo column');
    assert.equal(parseOwnershipMap(mdB, 'epic-058')[0].repo, 'repo-b');
    const overlaps = computeOverlaps(target, others, 'repo-a');
    assert.equal(overlaps.length, 0, 'cross-repo same-path must NOT conflict after repo column is parsed');
  });

  it('parsed entries with the same path in the SAME repo still conflict', () => {
    const mdSameRepo =
      '## File & module ownership map\n' +
      '| Story | Repo | Owns |\n' +
      '|---|---|---|\n' +
      '| story-001-001 | repo-a | `src/shared.ts` |\n';
    const mdSameRepo2 =
      '## File & module ownership map\n' +
      '| Story | Repo | Owns |\n' +
      '|---|---|---|\n' +
      '| story-002-001 | repo-a | `src/shared.ts` |\n';
    const target = parseOwnershipMap(mdSameRepo, 'epic-001');
    const others = new Map([['epic-002', parseOwnershipMap(mdSameRepo2, 'epic-002')]]);
    const overlaps = computeOverlaps(target, others, 'repo-a');
    assert.equal(overlaps.length, 1, 'same-repo same-path must still be flagged after repo column is parsed');
    assert.equal(overlaps[0].path, 'src/shared.ts');
  });
});

describe('computeOverlaps — Overlap.repo field [medium fix]', () => {
  it('Overlap.repo is populated from entry.repo when present', () => {
    const target: OwnershipMap = [repoEntry('epic-001', 'story-001-001', 'repo-a', 'src/shared.ts')];
    const others = new Map<string, OwnershipMap>([
      ['epic-002', [repoEntry('epic-002', 'story-002-001', 'repo-a', 'src/shared.ts')]],
    ]);
    const overlaps = computeOverlaps(target, others, 'repo-a');
    assert.equal(overlaps.length, 1);
    assert.equal(overlaps[0].repo, 'repo-a', 'Overlap.repo must be populated from the entry repo');
  });

  it('Overlap.repo falls back to primarySlug when entry.repo is absent', () => {
    const target: OwnershipMap = [
      { epicId: 'epic-001', storyId: 'story-001-001', path: 'src/shared.ts' },
    ];
    const others = new Map<string, OwnershipMap>([
      ['epic-002', [{ epicId: 'epic-002', storyId: 'story-002-001', path: 'src/shared.ts' }]],
    ]);
    const overlaps = computeOverlaps(target, others, 'loom');
    assert.equal(overlaps.length, 1);
    assert.equal(overlaps[0].repo, 'loom', 'Overlap.repo must fall back to primarySlug');
  });

  it('Overlap.repo is absent when primarySlug is empty (single-repo callers that pass no slug)', () => {
    const target: OwnershipMap = [
      { epicId: 'epic-001', storyId: 'story-001-001', path: 'src/shared.ts' },
    ];
    const others = new Map<string, OwnershipMap>([
      ['epic-002', [{ epicId: 'epic-002', storyId: 'story-002-001', path: 'src/shared.ts' }]],
    ]);
    const overlaps = computeOverlaps(target, others); // no primarySlug
    assert.equal(overlaps.length, 1);
    assert.equal(overlaps[0].repo, undefined, 'Overlap.repo must be absent when no primarySlug given');
  });
});

// SharedContract — repo column passthrough tests are in SharedContract.test.ts

// ---------------------------------------------------------------------------
// computeWithinEpicOverlaps — cross-repo within-epic (story-058-004)
//
// When two stories in the SAME epic target DIFFERENT repos, the same relative
// path is NOT a within-epic conflict. Only the same path in the SAME repo is.
// ---------------------------------------------------------------------------

describe('computeWithinEpicOverlaps — cross-repo same-epic paths [story-058-004]', () => {
  it('same relative path in two DIFFERENT repos within one epic is NOT a conflict', () => {
    // Both stories belong to epic-058 but target different repos.
    const map: OwnershipMap = [
      { epicId: 'epic-058', storyId: 'story-058-004', repo: 'repo-a', path: 'src/index.ts' },
      { epicId: 'epic-058', storyId: 'story-058-005', repo: 'repo-b', path: 'src/index.ts' },
    ];
    const overlaps = computeWithinEpicOverlaps(map, 'repo-a');
    assert.equal(overlaps.length, 0, 'cross-repo same-path within one epic must NOT be a conflict');
  });

  it('same relative path in the SAME repo within one epic IS a conflict (regression)', () => {
    const map: OwnershipMap = [
      { epicId: 'epic-058', storyId: 'story-058-001', repo: 'repo-a', path: 'src/index.ts' },
      { epicId: 'epic-058', storyId: 'story-058-002', repo: 'repo-a', path: 'src/index.ts' },
    ];
    const overlaps = computeWithinEpicOverlaps(map, 'repo-a');
    assert.equal(overlaps.length, 1, 'same-repo same-path within one epic must still be a conflict');
    assert.equal(overlaps[0].path, 'src/index.ts');
    const storyIds = overlaps[0].owners.map((o) => o.storyId).sort();
    assert.deepEqual(storyIds, ['story-058-001', 'story-058-002']);
  });

  it('omitted repo defaults to primarySlug — two omitted-repo entries on same path collide', () => {
    const map: OwnershipMap = [
      { epicId: 'epic-058', storyId: 'story-058-001', path: 'src/index.ts' }, // repo → 'primary'
      { epicId: 'epic-058', storyId: 'story-058-002', path: 'src/index.ts' }, // repo → 'primary'
    ];
    const overlaps = computeWithinEpicOverlaps(map, 'primary');
    assert.equal(overlaps.length, 1, 'two omitted-repo entries on same path must still collide');
  });

  it('omitted-repo entry does NOT conflict with same path in an explicit different repo', () => {
    const map: OwnershipMap = [
      { epicId: 'epic-058', storyId: 'story-058-001', path: 'src/index.ts' },       // → primary
      { epicId: 'epic-058', storyId: 'story-058-002', repo: 'repo-b', path: 'src/index.ts' }, // → repo-b
    ];
    // primarySlug = 'repo-a' (different from repo-b), so no conflict
    const overlaps = computeWithinEpicOverlaps(map, 'repo-a');
    assert.equal(overlaps.length, 0, 'omitted-repo (primary=repo-a) vs repo-b same-path is NOT a conflict');
  });

  it('single-repo regression: when every entry omits repo, behaviour is unchanged', () => {
    // Pre-existing single-repo scenario with no repo fields.
    const map: OwnershipMap = [
      { epicId: 'epic-028', storyId: 'story-028-001', path: 'src/shared.ts' },
      { epicId: 'epic-028', storyId: 'story-028-002', path: 'src/shared.ts' },
    ];
    // Without primarySlug: should still detect the overlap.
    const overlaps = computeWithinEpicOverlaps(map);
    assert.equal(overlaps.length, 1, 'single-repo entries must still overlap when they share a path');
    assert.equal(overlaps[0].path, 'src/shared.ts');
  });
});
