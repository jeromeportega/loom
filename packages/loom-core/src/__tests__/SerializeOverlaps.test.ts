import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import yaml from 'js-yaml';
import { deriveSameFileSerialization } from '../orchestrator/SerializeOverlaps.js';
import type { SerializationEdge } from '../orchestrator/SerializeOverlaps.js';
import { applySameFileSerialization } from '../planner/Planner.js';
import { SharedContract } from '../orchestrator/SharedContract.js';
import { AuditLog } from '../state/AuditLog.js';
import { resetDatabaseForTest } from '../state/Database.js';
import { EpicYamlSchema, StorySchema } from '../types.js';
import type { Story, EpicYaml } from '../types.js';
import type { Overlap } from '../orchestrator/ContractOwnership.js';

// ─── Helpers ────────────────────────────────────────────────────────────────

function makeStory(id: string, deps: string[] = []): Story {
  return {
    id,
    title: 'A valid story title',
    description: 'build the thing',
    acceptance_criteria: ['works'],
    estimated_complexity: 'small',
    dependencies: deps,
  };
}

function makeOverlap(path: string, storyIds: string[], epicId = 'epic-001'): Overlap {
  return {
    path,
    owners: storyIds.map((sid) => ({ epicId, storyId: sid })),
  };
}

function makeEpic(epicId: string, stories: Story[]): EpicYaml {
  return {
    epic_id: epicId,
    title: 'A valid epic title for tests',
    status: 'planned',
    priority: 'must-have',
    prd_ref: '.loom/planning/epic-001/prd.md',
    requirements: ['FR-1'],
    stories,
  };
}

/**
 * Checks for cycles in the dependency graph formed by `existingDeps` (from
 * story.dependencies) plus `additionalEdges`. Returns true if a cycle is found.
 * edge.from depends on edge.dependsOn, so a cycle is: A→B→…→A in the
 * "must complete first" direction.
 */
function hasCycle(stories: Story[], additionalEdges: SerializationEdge[]): boolean {
  const adj = new Map<string, Set<string>>();
  for (const s of stories) {
    adj.set(s.id, new Set(s.dependencies));
  }
  for (const e of additionalEdges) {
    const deps = adj.get(e.from) ?? new Set<string>();
    deps.add(e.dependsOn);
    adj.set(e.from, deps);
  }

  const UNVISITED = 0, VISITING = 1, VISITED = 2;
  const state = new Map<string, number>();

  function dfs(node: string): boolean {
    const s = state.get(node) ?? UNVISITED;
    if (s === VISITING) return true;
    if (s === VISITED) return false;
    state.set(node, VISITING);
    for (const next of adj.get(node) ?? new Set()) {
      if (dfs(next)) return true;
    }
    state.set(node, VISITED);
    return false;
  }

  for (const node of adj.keys()) {
    if ((state.get(node) ?? UNVISITED) === UNVISITED && dfs(node)) return true;
  }
  return false;
}

/** Ownership contract markdown that parseOwnershipMap can read. */
function makeContract(epicId: string, rows: Array<{ storyId: string; files: string[] }>): string {
  const tableRows = rows
    .flatMap(({ storyId, files }) =>
      files.map((f) => `| ${storyId} | \`${f}\` |`)
    )
    .join('\n');
  return (
    `# Implementation Contract\n\n` +
    `## File & module ownership map\n\n` +
    `| Story | Owns |\n` +
    `| --- | --- |\n` +
    tableRows +
    '\n'
  );
}

// ─── Unit tests: deriveSameFileSerialization ─────────────────────────────────

describe('deriveSameFileSerialization — no overlaps', () => {
  it('returns zero edges when overlaps is empty', () => {
    const stories = [makeStory('story-001-001'), makeStory('story-001-002')];
    const edges = deriveSameFileSerialization(stories, []);
    assert.equal(edges.length, 0);
  });
});

describe('deriveSameFileSerialization — two-story overlap', () => {
  it('emits exactly one edge directed later→earlier under topo order', () => {
    // stories[0]=S1 (topo index 0), stories[1]=S2 (topo index 1)
    // S1 should complete before S2, so edge: { from: S2, dependsOn: S1 }
    const stories = [makeStory('story-001-001'), makeStory('story-001-002')];
    const overlaps = [makeOverlap('src/foo.ts', ['story-001-001', 'story-001-002'])];
    const edges = deriveSameFileSerialization(stories, overlaps);

    assert.equal(edges.length, 1);
    assert.equal(edges[0].from, 'story-001-002');
    assert.equal(edges[0].dependsOn, 'story-001-001');
    assert.equal(edges[0].path, 'src/foo.ts');
    assert.equal(edges[0].reason, 'same-file-conflict-avoidance');
  });

  it('orders by topo index regardless of overlap owner listing order', () => {
    // Overlap lists S2 before S1, but S1 has lower topo index → S1 must come first
    const stories = [makeStory('story-001-001'), makeStory('story-001-002')];
    const overlaps = [makeOverlap('src/foo.ts', ['story-001-002', 'story-001-001'])];
    const edges = deriveSameFileSerialization(stories, overlaps);

    assert.equal(edges[0].from, 'story-001-002');
    assert.equal(edges[0].dependsOn, 'story-001-001');
  });
});

describe('deriveSameFileSerialization — N>2 stories sharing one file', () => {
  it('emits n-1 edges forming a single linear chain, no transitive extras', () => {
    // Three stories in topo order: S1, S2, S3
    // Expected chain: S1→S2→S3 (edges: S2 depends on S1, S3 depends on S2)
    const stories = [
      makeStory('story-001-001'),
      makeStory('story-001-002'),
      makeStory('story-001-003'),
    ];
    const overlaps = [
      makeOverlap('src/foo.ts', ['story-001-001', 'story-001-002', 'story-001-003']),
    ];
    const edges = deriveSameFileSerialization(stories, overlaps);

    assert.equal(edges.length, 2, 'n-1 edges for n=3');
    assert.equal(edges[0].from, 'story-001-002');
    assert.equal(edges[0].dependsOn, 'story-001-001');
    assert.equal(edges[1].from, 'story-001-003');
    assert.equal(edges[1].dependsOn, 'story-001-002');

    // No transitive extra edge (S3 depends on S1 would be redundant)
    const transitive = edges.find(
      (e) => e.from === 'story-001-003' && e.dependsOn === 'story-001-001'
    );
    assert.equal(transitive, undefined, 'no transitive/redundant edge');
  });
});

describe('deriveSameFileSerialization — determinism', () => {
  it('produces byte-identical output when called twice on the same input', () => {
    const stories = [
      makeStory('story-001-001'),
      makeStory('story-001-002'),
      makeStory('story-001-003'),
    ];
    const overlaps = [
      makeOverlap('src/a.ts', ['story-001-001', 'story-001-003']),
      makeOverlap('src/b.ts', ['story-001-001', 'story-001-002']),
    ];
    const first = deriveSameFileSerialization(stories, overlaps);
    const second = deriveSameFileSerialization(stories, overlaps);
    assert.deepEqual(first, second);
  });

  it('tie-breaks by story id when two stories share the same topo index (shouldn\'t happen normally, but safe)', () => {
    // Simulate two stories with no topo-index info (not in stories array) → Infinity tie-break by id
    const stories: Story[] = [];
    const overlaps = [makeOverlap('src/foo.ts', ['story-001-002', 'story-001-001'])];
    const edges = deriveSameFileSerialization(stories, overlaps);
    // Both have Infinity topo index; lexicographic tiebreak: '001' < '002'
    assert.equal(edges[0].dependsOn, 'story-001-001');
    assert.equal(edges[0].from, 'story-001-002');
  });
});

describe('deriveSameFileSerialization — pre-existing edge (idempotent)', () => {
  it('omits an edge that already exists in story.dependencies', () => {
    // S2 already depends on S1
    const stories = [
      makeStory('story-001-001'),
      makeStory('story-001-002', ['story-001-001']),
    ];
    const overlaps = [makeOverlap('src/foo.ts', ['story-001-001', 'story-001-002'])];
    const edges = deriveSameFileSerialization(stories, overlaps);
    assert.equal(edges.length, 0, 'no new edge when dependency already exists');
  });

  it('emits only the missing edges when some already exist in a longer chain', () => {
    // Three stories; S2 already depends on S1, but S3 has no dependency yet
    const stories = [
      makeStory('story-001-001'),
      makeStory('story-001-002', ['story-001-001']),
      makeStory('story-001-003'),
    ];
    const overlaps = [
      makeOverlap('src/foo.ts', ['story-001-001', 'story-001-002', 'story-001-003']),
    ];
    const edges = deriveSameFileSerialization(stories, overlaps);

    assert.equal(edges.length, 1, 'only missing edge emitted');
    assert.equal(edges[0].from, 'story-001-003');
    assert.equal(edges[0].dependsOn, 'story-001-002');
  });
});

describe('deriveSameFileSerialization — story in multiple same-file groups', () => {
  it('chains compose and the union is acyclic', () => {
    // S1 (idx 0) and S2 (idx 1) share file A
    // S2 (idx 1) and S3 (idx 2) share file B
    const stories = [
      makeStory('story-001-001'),
      makeStory('story-001-002'),
      makeStory('story-001-003'),
    ];
    const overlaps = [
      makeOverlap('src/a.ts', ['story-001-001', 'story-001-002']),
      makeOverlap('src/b.ts', ['story-001-002', 'story-001-003']),
    ];
    const edges = deriveSameFileSerialization(stories, overlaps);

    assert.equal(edges.length, 2);
    assert.ok(!hasCycle(stories, edges), 'composed chains must be acyclic');
  });

  it('deduplicates an edge that two different overlapping files would produce', () => {
    // S1 and S2 share BOTH file A and file B
    const stories = [makeStory('story-001-001'), makeStory('story-001-002')];
    const overlaps = [
      makeOverlap('src/a.ts', ['story-001-001', 'story-001-002']),
      makeOverlap('src/b.ts', ['story-001-001', 'story-001-002']),
    ];
    const edges = deriveSameFileSerialization(stories, overlaps);

    // Only one edge emitted even though two files would trigger S2→S1
    assert.equal(edges.length, 1);
  });

  it('cycle safety: edges on non-overlapping stories remain acyclic', () => {
    // S1, S2, S3 each share one file with one other; no cycles possible
    const stories = [
      makeStory('story-001-001'),
      makeStory('story-001-002'),
      makeStory('story-001-003'),
    ];
    const overlaps = [
      makeOverlap('src/a.ts', ['story-001-001', 'story-001-002']),
      makeOverlap('src/b.ts', ['story-001-002', 'story-001-003']),
      makeOverlap('src/c.ts', ['story-001-001', 'story-001-003']),
    ];
    const edges = deriveSameFileSerialization(stories, overlaps);
    assert.ok(!hasCycle(stories, edges), 'multi-file group edges must be acyclic');
  });
});

// ─── Integration tests: applySameFileSerialization ───────────────────────────

/** Stub AuditLog that records calls without needing a real DB. */
function makeAuditStub(): { audit: AuditLog; rows: Array<Parameters<AuditLog['record']>[0]> } {
  const rows: Array<Parameters<AuditLog['record']>[0]> = [];
  const audit = {
    record: (entry: Parameters<AuditLog['record']>[0]) => { rows.push(entry); },
  } as unknown as AuditLog;
  return { audit, rows };
}

/** Write an initial epic YAML to the planning directory under projectRoot. */
function writeEpicYaml(epic: EpicYaml, projectRoot: string): void {
  const dir = path.join(projectRoot, '.loom', 'planning', epic.epic_id, 'epics');
  fs.mkdirSync(dir, { recursive: true });
  const yamlStr =
    '# Generated by loom — PM persona (John), enriched by Architect (Winston)\n' +
    '# Validated against schemas/epic.schema.yaml\n' +
    yaml.dump(epic, { lineWidth: 100, noRefs: true });
  fs.writeFileSync(path.join(dir, `${epic.epic_id}.yaml`), yamlStr);
}

describe('integration — applySameFileSerialization', () => {
  let tmpDir: string;

  beforeEach(() => {
    resetDatabaseForTest();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'loom-serialize-'));
  });

  afterEach(() => {
    resetDatabaseForTest();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

describe('applySameFileSerialization — edges land in dependencies and dependency_reasons', () => {
  it('adds a dependency edge and dependency_reason entry for overlapping stories', () => {
    const s1 = makeStory('story-001-001');
    const s2 = makeStory('story-001-002');
    const epic = makeEpic('epic-001', [s1, s2]);
    writeEpicYaml(epic, tmpDir);

    SharedContract.write(
      tmpDir,
      'epic-001',
      makeContract('epic-001', [
        { storyId: 'story-001-001', files: ['src/shared.ts'] },
        { storyId: 'story-001-002', files: ['src/shared.ts'] },
      ])
    );

    const { audit } = makeAuditStub();
    applySameFileSerialization([epic], tmpDir, audit);

    assert.deepEqual(s2.dependencies, ['story-001-001'], 'edge added to dependencies');
    assert.ok(s2.dependency_reasons, 'dependency_reasons created');
    assert.equal(s2.dependency_reasons!.length, 1);
    assert.equal(s2.dependency_reasons![0].depends_on, 'story-001-001');
    assert.equal(s2.dependency_reasons![0].reason, 'same-file-conflict-avoidance');
    assert.equal(s2.dependency_reasons![0].path, 'src/shared.ts');
  });

  it('persists dependency_reasons to the YAML on disk', () => {
    const s1 = makeStory('story-001-001');
    const s2 = makeStory('story-001-002');
    const epic = makeEpic('epic-001', [s1, s2]);
    writeEpicYaml(epic, tmpDir);

    SharedContract.write(
      tmpDir,
      'epic-001',
      makeContract('epic-001', [
        { storyId: 'story-001-001', files: ['src/shared.ts'] },
        { storyId: 'story-001-002', files: ['src/shared.ts'] },
      ])
    );

    const { audit } = makeAuditStub();
    applySameFileSerialization([epic], tmpDir, audit);

    const yamlPath = path.join(tmpDir, '.loom', 'planning', 'epic-001', 'epics', 'epic-001.yaml');
    const parsed = EpicYamlSchema.parse(yaml.load(fs.readFileSync(yamlPath, 'utf8')));
    const story2 = parsed.stories.find((s) => s.id === 'story-001-002')!;
    assert.ok(story2.dependency_reasons, 'dependency_reasons in YAML');
    assert.equal(story2.dependency_reasons![0].reason, 'same-file-conflict-avoidance');
    assert.equal(story2.dependency_reasons![0].path, 'src/shared.ts');
  });
});

describe('applySameFileSerialization — additive-only (AC-3)', () => {
  it('does not modify any story field other than dependencies and dependency_reasons', () => {
    const s1 = makeStory('story-001-001');
    const s2 = makeStory('story-001-002');
    const epic = makeEpic('epic-001', [s1, s2]);
    writeEpicYaml(epic, tmpDir);

    const before = {
      s1: { ...s1 },
      s2: { ...s2, dependencies: [...s2.dependencies] },
    };

    SharedContract.write(
      tmpDir,
      'epic-001',
      makeContract('epic-001', [
        { storyId: 'story-001-001', files: ['src/shared.ts'] },
        { storyId: 'story-001-002', files: ['src/shared.ts'] },
      ])
    );

    const { audit } = makeAuditStub();
    applySameFileSerialization([epic], tmpDir, audit);

    // s1 (the earlier story) must be completely unchanged
    assert.equal(s1.title, before.s1.title);
    assert.equal(s1.description, before.s1.description);
    assert.deepEqual(s1.acceptance_criteria, before.s1.acceptance_criteria);
    assert.deepEqual(s1.dependencies, before.s1.dependencies);
    assert.equal(s1.dependency_reasons, undefined);

    // s2: only dependencies and dependency_reasons changed
    assert.equal(s2.title, before.s2.title);
    assert.equal(s2.description, before.s2.description);
    assert.deepEqual(s2.acceptance_criteria, before.s2.acceptance_criteria);
  });
});

describe('applySameFileSerialization — non-overlapping stories unchanged', () => {
  it('does not add edges between stories that touch different files', () => {
    const s1 = makeStory('story-001-001'); // owns src/a.ts
    const s2 = makeStory('story-001-002'); // owns src/b.ts
    const epic = makeEpic('epic-001', [s1, s2]);
    writeEpicYaml(epic, tmpDir);

    SharedContract.write(
      tmpDir,
      'epic-001',
      makeContract('epic-001', [
        { storyId: 'story-001-001', files: ['src/a.ts'] },
        { storyId: 'story-001-002', files: ['src/b.ts'] },
      ])
    );

    const { audit, rows } = makeAuditStub();
    applySameFileSerialization([epic], tmpDir, audit);

    assert.deepEqual(s1.dependencies, [], 's1 dependencies unchanged');
    assert.deepEqual(s2.dependencies, [], 's2 dependencies unchanged');
    assert.equal(rows.length, 0, 'no audit rows for non-overlapping stories');
  });
});

describe('applySameFileSerialization — audit rows', () => {
  it('writes exactly one audit row per shared file', () => {
    const s1 = makeStory('story-001-001');
    const s2 = makeStory('story-001-002');
    const s3 = makeStory('story-001-003');
    const epic = makeEpic('epic-001', [s1, s2, s3]);
    writeEpicYaml(epic, tmpDir);

    // Two separate files, each shared by different story pairs
    SharedContract.write(
      tmpDir,
      'epic-001',
      makeContract('epic-001', [
        { storyId: 'story-001-001', files: ['src/a.ts', 'src/b.ts'] },
        { storyId: 'story-001-002', files: ['src/a.ts'] },
        { storyId: 'story-001-003', files: ['src/b.ts'] },
      ])
    );

    const { audit, rows } = makeAuditStub();
    applySameFileSerialization([epic], tmpDir, audit);

    assert.equal(rows.length, 2, 'one row per shared file');
    const paths = rows.map((r) => (r.detail as { path: string }).path).sort();
    assert.deepEqual(paths, ['src/a.ts', 'src/b.ts']);

    for (const row of rows) {
      assert.equal(row.action, 'plan_serialize_same_file');
      assert.equal(row.command, 'epic-001');
      const detail = row.detail as { path: string; chain: string[]; added_edges: object[] };
      assert.ok(Array.isArray(detail.chain), 'chain is an array');
      assert.ok(Array.isArray(detail.added_edges), 'added_edges is an array');
    }
  });

  it('audit detail contains the correct chain and added_edges', () => {
    const s1 = makeStory('story-001-001');
    const s2 = makeStory('story-001-002');
    const s3 = makeStory('story-001-003');
    const epic = makeEpic('epic-001', [s1, s2, s3]);
    writeEpicYaml(epic, tmpDir);

    SharedContract.write(
      tmpDir,
      'epic-001',
      makeContract('epic-001', [
        { storyId: 'story-001-001', files: ['src/shared.ts'] },
        { storyId: 'story-001-002', files: ['src/shared.ts'] },
        { storyId: 'story-001-003', files: ['src/shared.ts'] },
      ])
    );

    const { audit, rows } = makeAuditStub();
    applySameFileSerialization([epic], tmpDir, audit);

    assert.equal(rows.length, 1);
    const detail = rows[0].detail as { path: string; chain: string[]; added_edges: Array<{ from: string; dependsOn: string }> };
    assert.equal(detail.path, 'src/shared.ts');
    assert.deepEqual(detail.chain, ['story-001-001', 'story-001-002', 'story-001-003']);
    assert.equal(detail.added_edges.length, 2);
    assert.deepEqual(detail.added_edges[0], { from: 'story-001-002', dependsOn: 'story-001-001' });
    assert.deepEqual(detail.added_edges[1], { from: 'story-001-003', dependsOn: 'story-001-002' });
  });
});

describe('applySameFileSerialization — quiet skip (no contract)', () => {
  it('is a no-op and does not throw when no contract exists', () => {
    const s1 = makeStory('story-001-001');
    const s2 = makeStory('story-001-002');
    const epic = makeEpic('epic-001', [s1, s2]);
    // No contract written to disk

    const { audit, rows } = makeAuditStub();
    assert.doesNotThrow(() => applySameFileSerialization([epic], tmpDir, audit));
    assert.deepEqual(s1.dependencies, []);
    assert.deepEqual(s2.dependencies, []);
    assert.equal(rows.length, 0);
  });

  it('is a no-op when epics array is empty', () => {
    const { audit, rows } = makeAuditStub();
    assert.doesNotThrow(() => applySameFileSerialization([], tmpDir, audit));
    assert.equal(rows.length, 0);
  });
});

}); // end describe('integration — applySameFileSerialization')

describe('applySameFileSerialization — backward compatibility (NFR-2)', () => {
  it('StorySchema validates a story without dependency_reasons (existing plan compat)', () => {
    const story = makeStory('story-001-001');
    assert.doesNotThrow(() => StorySchema.parse(story));
    // No dependency_reasons → parses fine
    const parsed = StorySchema.parse(story);
    assert.equal(parsed.dependency_reasons, undefined);
  });

  it('StorySchema validates a story WITH dependency_reasons', () => {
    const story: Story = {
      ...makeStory('story-001-001'),
      dependency_reasons: [
        { depends_on: 'story-001-002', reason: 'same-file-conflict-avoidance', path: 'src/x.ts' },
      ],
    };
    const parsed = StorySchema.parse(story);
    assert.equal(parsed.dependency_reasons![0].reason, 'same-file-conflict-avoidance');
  });

  it('round-trips a story YAML with dependency_reasons through EpicYamlSchema', () => {
    const s1 = makeStory('story-001-001');
    const s2: Story = {
      ...makeStory('story-001-002'),
      dependencies: ['story-001-001'],
      dependency_reasons: [
        { depends_on: 'story-001-001', reason: 'same-file-conflict-avoidance', path: 'src/shared.ts' },
      ],
    };
    const epic = makeEpic('epic-001', [s1, s2]);
    const yamlStr = yaml.dump(epic, { lineWidth: 100, noRefs: true });
    const reloaded = EpicYamlSchema.parse(yaml.load(yamlStr));

    const story2 = reloaded.stories.find((s) => s.id === 'story-001-002')!;
    assert.ok(story2.dependency_reasons);
    assert.equal(story2.dependency_reasons![0].reason, 'same-file-conflict-avoidance');
    assert.equal(story2.dependency_reasons![0].path, 'src/shared.ts');
  });
});
