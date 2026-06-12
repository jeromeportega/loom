import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  openDatabase,
  EpicStore,
  resetDatabaseForTest,
  computeOverlaps,
  renderOverlapAdvisory,
  type OwnershipMap,
} from '@loom-ai/core';
import { printOverlapAdvisory } from '../crossEpicOverlap.js';

// ---------------------------------------------------------------------------
// Unit: computeOverlaps (exact lexical path equality only)
// ---------------------------------------------------------------------------

describe('computeOverlaps — exact lexical path equality', () => {
  it('case 1: a path shared with another epic yields one Overlap listing BOTH owners', () => {
    const target: OwnershipMap = [
      { epicId: 'epic-007', storyId: 'story-007-008', path: 'src/shared.ts' },
      { epicId: 'epic-007', storyId: 'story-007-008', path: 'src/only-007.ts' },
    ];
    const others = new Map<string, OwnershipMap>([
      [
        'epic-008',
        [{ epicId: 'epic-008', storyId: 'story-008-002', path: 'src/shared.ts' }],
      ],
    ]);

    const overlaps = computeOverlaps(target, others);
    assert.equal(overlaps.length, 1);
    assert.equal(overlaps[0].path, 'src/shared.ts');
    assert.deepEqual(overlaps[0].owners, [
      { epicId: 'epic-007', storyId: 'story-007-008' },
      { epicId: 'epic-008', storyId: 'story-008-002' },
    ]);
  });

  it('case 2: glob / dirname-prefix / case differences produce NO overlap', () => {
    const target: OwnershipMap = [{ epicId: 'epic-007', path: 'src/a.ts' }];
    const others = new Map<string, OwnershipMap>([
      [
        'epic-008',
        [
          { epicId: 'epic-008', path: 'src/' }, // dirname prefix — NOT a match
          { epicId: 'epic-008', path: 'src/A.ts' }, // case differs — NOT a match
          { epicId: 'epic-008', path: 'src/*.ts' }, // glob — NOT a match
          { epicId: 'epic-008', path: 'src/a.tsx' }, // suffix differs — NOT a match
        ],
      ],
    ]);

    assert.deepEqual(computeOverlaps(target, others), []);
  });

  it('case 2b: an exact match alongside near-misses flags only the exact one', () => {
    const target: OwnershipMap = [
      { epicId: 'epic-007', path: 'src/a.ts' },
      { epicId: 'epic-007', path: 'src/b.ts' },
    ];
    const others = new Map<string, OwnershipMap>([
      [
        'epic-008',
        [
          { epicId: 'epic-008', path: 'src/A.ts' }, // near miss
          { epicId: 'epic-008', path: 'src/b.ts' }, // exact
        ],
      ],
    ]);

    const overlaps = computeOverlaps(target, others);
    assert.deepEqual(overlaps.map((o) => o.path), ['src/b.ts']);
  });

  it('lists every owner when several other epics claim the same exact path', () => {
    const target: OwnershipMap = [
      { epicId: 'epic-007', storyId: 'story-007-008', path: 'src/contended.ts' },
    ];
    const others = new Map<string, OwnershipMap>([
      ['epic-008', [{ epicId: 'epic-008', storyId: 'story-008-001', path: 'src/contended.ts' }]],
      ['epic-009', [{ epicId: 'epic-009', path: 'src/contended.ts' }]],
    ]);

    const overlaps = computeOverlaps(target, others);
    assert.equal(overlaps.length, 1);
    assert.deepEqual(overlaps[0].owners, [
      { epicId: 'epic-007', storyId: 'story-007-008' },
      { epicId: 'epic-008', storyId: 'story-008-001' },
      { epicId: 'epic-009' },
    ]);
  });

  it('reports each shared path once even when the target lists it twice', () => {
    const target: OwnershipMap = [
      { epicId: 'epic-007', storyId: 'story-007-001', path: 'src/dup.ts' },
      { epicId: 'epic-007', storyId: 'story-007-002', path: 'src/dup.ts' },
    ];
    const others = new Map<string, OwnershipMap>([
      ['epic-008', [{ epicId: 'epic-008', path: 'src/dup.ts' }]],
    ]);

    const overlaps = computeOverlaps(target, others);
    assert.equal(overlaps.length, 1);
    assert.equal(overlaps[0].path, 'src/dup.ts');
  });

  it('returns [] when there are no other maps to compare against', () => {
    const target: OwnershipMap = [{ epicId: 'epic-007', path: 'src/a.ts' }];
    assert.deepEqual(computeOverlaps(target, new Map()), []);
  });
});

// ---------------------------------------------------------------------------
// Unit: renderOverlapAdvisory (framing + empty)
// ---------------------------------------------------------------------------

describe('renderOverlapAdvisory — copy framing', () => {
  it('case 4: returns [] for empty overlaps', () => {
    assert.deepEqual(renderOverlapAdvisory([]), []);
  });

  it('case 4: frames the result as "lexical path match only" and names both owners', () => {
    const lines = renderOverlapAdvisory([
      {
        path: 'src/shared.ts',
        owners: [
          { epicId: 'epic-007', storyId: 'story-007-008' },
          { epicId: 'epic-008', storyId: 'story-008-002' },
        ],
      },
    ]);
    const joined = lines.join('\n');
    assert.match(joined, /lexical path match only/i);
    assert.match(joined, /src\/shared\.ts/);
    assert.match(joined, /epic-007 \/ story-007-008/);
    assert.match(joined, /epic-008 \/ story-008-002/);
    // It is an advisory, not a block.
    assert.match(joined, /nothing is blocked/i);
  });
});

// ---------------------------------------------------------------------------
// Unit: printOverlapAdvisory with injected deps (missing-contract skip)
// ---------------------------------------------------------------------------

describe('printOverlapAdvisory — dependency-injected', () => {
  function capture(): { lines: string[]; print: (l: string) => void } {
    const lines: string[] = [];
    return { lines, print: (l) => lines.push(l) };
  }

  it('case 3: a missing contract for a compared epic is silently skipped; others still run', () => {
    const maps: Record<string, OwnershipMap | null> = {
      'epic-007': [{ epicId: 'epic-007', storyId: 'story-007-008', path: 'src/shared.ts' }],
      'epic-008': null, // shared_contract = off for this one
      'epic-009': [{ epicId: 'epic-009', storyId: 'story-009-001', path: 'src/shared.ts' }],
    };
    const { lines, print } = capture();

    assert.doesNotThrow(() =>
      printOverlapAdvisory('/proj', 'epic-007', {
        listInFlightEpicIds: () => ['epic-007', 'epic-008', 'epic-009'],
        loadMap: (_root, id) => maps[id] ?? null,
        print,
      })
    );

    const joined = lines.join('\n');
    // epic-008 (null contract) is skipped, but epic-009's exact overlap is found.
    assert.match(joined, /src\/shared\.ts/);
    assert.match(joined, /epic-009 \/ story-009-001/);
    assert.match(joined, /lexical path match only/i);
  });

  it('case 3: a null TARGET contract (shared_contract=off) prints nothing', () => {
    const { lines, print } = capture();
    printOverlapAdvisory('/proj', 'epic-007', {
      listInFlightEpicIds: () => ['epic-008'],
      loadMap: () => null,
      print,
    });
    assert.deepEqual(lines, []);
  });

  it('never compares an epic with itself', () => {
    const target: OwnershipMap = [{ epicId: 'epic-007', path: 'src/a.ts' }];
    const { lines, print } = capture();
    printOverlapAdvisory('/proj', 'epic-007', {
      listInFlightEpicIds: () => ['epic-007'], // only itself in flight
      loadMap: () => target,
      print,
    });
    assert.deepEqual(lines, [], 'self-overlap is never reported');
  });

  it('prints nothing when there is no overlap', () => {
    const maps: Record<string, OwnershipMap> = {
      'epic-007': [{ epicId: 'epic-007', path: 'src/a.ts' }],
      'epic-008': [{ epicId: 'epic-008', path: 'src/b.ts' }],
    };
    const { lines, print } = capture();
    printOverlapAdvisory('/proj', 'epic-007', {
      listInFlightEpicIds: () => ['epic-007', 'epic-008'],
      loadMap: (_root, id) => maps[id],
      print,
    });
    assert.deepEqual(lines, []);
  });
});

// ---------------------------------------------------------------------------
// Light integration: the advisory prints at approve AND at dispatch, and
// approval/dispatch still succeed (never blocked).
// ---------------------------------------------------------------------------

const LOOM_CLI = path.resolve(__dirname, '../index.js');

function contract(epicId: string, ownerPaths: Array<[string, string]>): string {
  const rows = ownerPaths
    .map(([owner, p]) => `| ${owner} | \`${p}\` |`)
    .join('\n');
  return (
    `# ${epicId} Shared Implementation Contract\n\n` +
    `## File & module ownership map\n\n` +
    `| Story | Owns |\n|---|---|\n${rows}\n`
  );
}

function writeContract(root: string, epicId: string, body: string): void {
  const dir = path.join(root, '.loom', 'contract');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${epicId}.md`), body, 'utf8');
}

describe('cross-epic overlap advisory — wiring at approve and dispatch', () => {
  let tmpDir: string;

  function loom(cmdSuffix: string): { stdout: string; stderr: string; status: number } {
    try {
      const stdout = execSync(`node "${LOOM_CLI}" ${cmdSuffix}`, {
        cwd: tmpDir,
        encoding: 'utf8',
        stdio: ['pipe', 'pipe', 'pipe'],
        env: { ...process.env },
      });
      return { stdout, stderr: '', status: 0 };
    } catch (err: unknown) {
      const e = err as { stdout?: string; stderr?: string; status?: number };
      return { stdout: e.stdout ?? '', stderr: e.stderr ?? '', status: e.status ?? 1 };
    }
  }

  function epicStatus(id: string): string | undefined {
    resetDatabaseForTest();
    const db = openDatabase(path.join(tmpDir, '.loom'));
    const status = new EpicStore(db).get(id)?.status;
    resetDatabaseForTest();
    return status;
  }

  before(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'loom-overlap-test-'));
    execSync('git init -q', { cwd: tmpDir });
    loom('init');

    // Seed epic-100 (planned, the approve/dispatch target) and epic-200
    // (already in-flight). Both contracts claim the EXACT same path.
    resetDatabaseForTest();
    const db = openDatabase(path.join(tmpDir, '.loom'));
    const store = new EpicStore(db);
    store.create('epic-100', 'Overlap target epic');
    const inflight = store.create('epic-200', 'In-flight epic');
    store.updateStatus(inflight.id, 'approved');
    resetDatabaseForTest();

    writeContract(
      tmpDir,
      'epic-100',
      contract('epic-100', [['story-100-001', 'packages/loom-core/src/shared/Overlapping.ts']])
    );
    writeContract(
      tmpDir,
      'epic-200',
      contract('epic-200', [['story-200-001', 'packages/loom-core/src/shared/Overlapping.ts']])
    );
  });

  after(() => {
    resetDatabaseForTest();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('case 5: approve prints the advisory with both owners AND still approves', () => {
    const result = loom('approve epic-100');
    assert.equal(result.status, 0, 'approval succeeds (never blocked)');
    assert.equal(epicStatus('epic-100'), 'approved');

    assert.match(result.stdout, /lexical path match only/i);
    assert.match(result.stdout, /packages\/loom-core\/src\/shared\/Overlapping\.ts/);
    assert.match(result.stdout, /epic-100 \/ story-100-001/);
    assert.match(result.stdout, /epic-200 \/ story-200-001/);
  });

  it('case 6: the same advisory prints at `loom run` dispatch start (before supervisor.run)', () => {
    // epic-100 is approved (from the previous test). The advisory must print at
    // dispatch start, BEFORE the supervisor loads stories. We don't seed a full
    // epic YAML, so the supervisor then fails to load stories — but that comes
    // AFTER the advisory, which is exactly the ordering this story guarantees:
    // the check runs at dispatch start and never blocks reaching it.
    const { stdout } = loom('run epic-100');

    // The advisory landing in stdout proves the check ran at dispatch start:
    // it is wired in run.ts immediately before `supervisor.run()`, so its
    // output appearing at all means the call site fired before dispatch.
    assert.match(stdout, /lexical path match only/i);
    assert.match(stdout, /packages\/loom-core\/src\/shared\/Overlapping\.ts/);
    assert.match(stdout, /epic-100 \/ story-100-001/);
    assert.match(stdout, /epic-200 \/ story-200-001/);
  });
});
