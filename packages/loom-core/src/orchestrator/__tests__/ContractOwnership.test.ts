import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  parseOwnershipMap,
  loadOwnershipMap,
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
