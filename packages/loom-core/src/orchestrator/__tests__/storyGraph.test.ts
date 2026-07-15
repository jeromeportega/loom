import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildStoryGraph,
  topologicalSort,
  detectCycles,
  findReadyStories,
  criticalPath,
  StoryGraphCycleError,
} from '../storyGraph.js';
import type { Story } from '../../types.js';
import type { WorkspaceManifest, ManifestEntry } from '../../home/workspaceManifest.js';

// ── Fixtures ──────────────────────────────────────────────────────────────────

function story(id: string, deps: string[] = [], opts: { effort?: number; repo?: string } = {}): Story {
  return {
    id,
    title: `Story ${id} title long enough`,
    description: 'description',
    acceptance_criteria: ['AC1'],
    estimated_complexity: 'medium',
    dependencies: deps,
    ...(opts.effort !== undefined ? { estimated_effort: opts.effort } : {}),
    ...(opts.repo !== undefined ? { repo: opts.repo } : {}),
  };
}

function entry(slug: string): ManifestEntry {
  return { slug, path: `/repos/${slug}`, remote_url: null };
}

function manifest(repos: ManifestEntry[]): WorkspaceManifest {
  return { version: 1, repos };
}

// Validates that every story in `order` appears after all its dependencies
// (standard topological order property).
function isValidTopologicalOrder(order: string[], edges: Map<string, string[]>, nodes: Set<string>): boolean {
  const pos = new Map<string, number>(order.map((id, i) => [id, i]));
  for (const [id, deps] of edges) {
    if (!nodes.has(id)) continue;
    for (const dep of deps) {
      if (!nodes.has(dep)) continue;
      const depPos = pos.get(dep);
      const idPos = pos.get(id);
      if (depPos === undefined || idPos === undefined) return false;
      if (depPos >= idPos) return false; // dep must appear BEFORE id
    }
  }
  return true;
}

// ── 1. buildStoryGraph ────────────────────────────────────────────────────────

describe('buildStoryGraph — empty list', () => {
  it('produces empty nodes and empty edges', () => {
    const g = buildStoryGraph([]);
    assert.equal(g.nodes.size, 0);
    assert.equal(g.edges.size, 0);
  });
});

describe('buildStoryGraph — single story, no dependencies', () => {
  it('produces one node and an empty edge list', () => {
    const s = story('story-001-001');
    const g = buildStoryGraph([s]);
    assert.equal(g.nodes.size, 1);
    assert.ok(g.nodes.has('story-001-001'));
    assert.deepEqual(g.edges.get('story-001-001'), []);
  });
});

describe('buildStoryGraph — linear chain A→B→C', () => {
  // A=story-001-001, B=story-001-002, C=story-001-003
  // A depends on B, B depends on C
  const A = story('story-001-001', ['story-001-002']);
  const B = story('story-001-002', ['story-001-003']);
  const C = story('story-001-003');

  const g = buildStoryGraph([A, B, C]);

  it('creates a node for each story', () => {
    assert.equal(g.nodes.size, 3);
    assert.ok(g.nodes.has('story-001-001'));
    assert.ok(g.nodes.has('story-001-002'));
    assert.ok(g.nodes.has('story-001-003'));
  });

  it('records correct adjacency in edges', () => {
    assert.deepEqual(g.edges.get('story-001-001'), ['story-001-002']);
    assert.deepEqual(g.edges.get('story-001-002'), ['story-001-003']);
    assert.deepEqual(g.edges.get('story-001-003'), []);
  });
});

describe('buildStoryGraph — story with non-existent dependency', () => {
  it('records the edge even when the dep ID is absent from the node set', () => {
    const s = story('story-001-001', ['story-999-999']);
    const g = buildStoryGraph([s]);
    assert.ok(g.nodes.has('story-001-001'));
    assert.ok(!g.nodes.has('story-999-999'), 'non-existent dep is not a node');
    assert.deepEqual(g.edges.get('story-001-001'), ['story-999-999'], 'edge is still recorded');
  });
});

// ── 2. topologicalSort ────────────────────────────────────────────────────────

describe('topologicalSort — empty graph', () => {
  it('returns []', () => {
    const g = buildStoryGraph([]);
    assert.deepEqual(topologicalSort(g), []);
  });
});

describe('topologicalSort — single node', () => {
  it('returns [node]', () => {
    const g = buildStoryGraph([story('story-001-001')]);
    assert.deepEqual(topologicalSort(g), ['story-001-001']);
  });
});

describe('topologicalSort — acyclic multi-node graph', () => {
  // A depends on B, B depends on C → valid toposort has C before B before A
  const A = story('story-001-001', ['story-001-002']);
  const B = story('story-001-002', ['story-001-003']);
  const C = story('story-001-003');
  const g = buildStoryGraph([A, B, C]);

  it('returns a valid topological order (deps before consumers)', () => {
    const order = topologicalSort(g);
    assert.equal(order.length, 3);
    assert.ok(
      isValidTopologicalOrder(order, g.edges, new Set(g.nodes.keys())),
      `expected valid topo order, got: ${order.join(', ')}`,
    );
  });

  it('story-001-003 (no deps) appears before story-001-002 and story-001-001', () => {
    const order = topologicalSort(g);
    const pos = new Map(order.map((id, i) => [id, i]));
    assert.ok(pos.get('story-001-003')! < pos.get('story-001-002')!);
    assert.ok(pos.get('story-001-002')! < pos.get('story-001-001')!);
  });
});

describe('topologicalSort — cyclic graph', () => {
  it('throws StoryGraphCycleError for a two-node cycle', () => {
    const A = story('story-001-001', ['story-001-002']);
    const B = story('story-001-002', ['story-001-001']);
    const g = buildStoryGraph([A, B]);
    assert.throws(
      () => topologicalSort(g),
      (err: unknown) => {
        assert.ok(err instanceof StoryGraphCycleError, `expected StoryGraphCycleError, got ${err}`);
        assert.ok(err.cyclePath.length > 0, 'cyclePath must be populated');
        return true;
      },
    );
  });

  it('cyclePath contains the actual cycle members', () => {
    const A = story('story-001-001', ['story-001-002']);
    const B = story('story-001-002', ['story-001-001']);
    const g = buildStoryGraph([A, B]);
    try {
      topologicalSort(g);
      assert.fail('expected StoryGraphCycleError to be thrown');
    } catch (err) {
      assert.ok(err instanceof StoryGraphCycleError);
      assert.ok(err.cyclePath.includes('story-001-001'), 'cyclePath includes story-001-001');
      assert.ok(err.cyclePath.includes('story-001-002'), 'cyclePath includes story-001-002');
    }
  });

  it('throws for a self-loop', () => {
    const A = story('story-001-001', ['story-001-001']);
    const g = buildStoryGraph([A]);
    assert.throws(() => topologicalSort(g), StoryGraphCycleError);
  });
});

// ── 3. detectCycles ───────────────────────────────────────────────────────────

describe('detectCycles — acyclic graph', () => {
  it('returns [] for an empty graph', () => {
    assert.deepEqual(detectCycles(buildStoryGraph([])), []);
  });

  it('returns [] for a single node', () => {
    assert.deepEqual(detectCycles(buildStoryGraph([story('story-001-001')])), []);
  });

  it('returns [] for a linear chain', () => {
    const g = buildStoryGraph([
      story('story-001-001', ['story-001-002']),
      story('story-001-002', ['story-001-003']),
      story('story-001-003'),
    ]);
    assert.deepEqual(detectCycles(g), []);
  });
});

describe('detectCycles — self-loop', () => {
  it('returns a path array containing the node twice (A → A)', () => {
    const g = buildStoryGraph([story('story-001-001', ['story-001-001'])]);
    const cycle = detectCycles(g);
    assert.ok(cycle.length >= 2, 'cycle path must have at least 2 entries');
    assert.ok(cycle.includes('story-001-001'), 'cycle path includes the self-looping node');
    // Back-edge representation: first and last entry are the same node
    assert.equal(cycle[0], cycle[cycle.length - 1]);
  });
});

describe('detectCycles — two-node cycle', () => {
  it('returns a non-empty path for A ↔ B', () => {
    const g = buildStoryGraph([
      story('story-001-001', ['story-001-002']),
      story('story-001-002', ['story-001-001']),
    ]);
    const cycle = detectCycles(g);
    assert.ok(cycle.length > 0, 'two-node cycle must return a non-empty path');
    assert.ok(cycle.includes('story-001-001'), 'cycle includes story-001-001');
    assert.ok(cycle.includes('story-001-002'), 'cycle includes story-001-002');
  });
});

describe('detectCycles — three-node cycle', () => {
  it('returns a path containing all three nodes (A→B→C→A)', () => {
    // A depends on B, B depends on C, C depends on A
    const g = buildStoryGraph([
      story('story-001-001', ['story-001-002']),
      story('story-001-002', ['story-001-003']),
      story('story-001-003', ['story-001-001']),
    ]);
    const cycle = detectCycles(g);
    assert.ok(cycle.length > 0, 'three-node cycle must return a non-empty path');
    assert.ok(cycle.includes('story-001-001'), 'cycle includes A');
    assert.ok(cycle.includes('story-001-002'), 'cycle includes B');
    assert.ok(cycle.includes('story-001-003'), 'cycle includes C');
  });
});

describe('detectCycles — cross-repo edges', () => {
  // Two stories in repo-a depend on two stories in repo-b and vice-versa,
  // creating a repo-level cycle without a story-level cycle.
  //   story-001-001 (repo-a) depends on story-001-002 (repo-b)  → repo-a needs repo-b
  //   story-001-003 (repo-b) depends on story-001-004 (repo-a)  → repo-b needs repo-a
  //   No story depends on itself or forms a story-level cycle.
  const crossRepoManifest = manifest([entry('repo-a'), entry('repo-b')]);
  const primarySlug = 'repo-a';

  const cycleStories = [
    story('story-001-001', ['story-001-002'], { repo: 'repo-a' }),
    story('story-001-002', [], { repo: 'repo-b' }),
    story('story-001-003', ['story-001-004'], { repo: 'repo-b' }),
    story('story-001-004', [], { repo: 'repo-a' }),
  ];

  it('returns a non-empty path when validateCrossRepoEdges detects a cycle', () => {
    const g = buildStoryGraph(cycleStories);
    const cycle = detectCycles(g, { manifest: crossRepoManifest, primarySlug });
    assert.ok(cycle.length > 0, 'cross-repo cycle must produce a non-empty path');
  });

  it('returns [] for a valid cross-repo edge (no cycle)', () => {
    // Only one direction: repo-a consumer depends on repo-b producer (valid)
    const validStories = [
      story('story-001-001', ['story-001-002'], { repo: 'repo-a' }),
      story('story-001-002', [], { repo: 'repo-b' }),
    ];
    const g = buildStoryGraph(validStories);
    const cycle = detectCycles(g, { manifest: crossRepoManifest, primarySlug });
    assert.deepEqual(cycle, []);
  });

  it('returns [] when no manifest is provided even for cross-repo stories', () => {
    const g = buildStoryGraph(cycleStories);
    const cycle = detectCycles(g); // no opts → cross-repo check skipped
    assert.deepEqual(cycle, []);
  });
});

// ── 4. findReadyStories ───────────────────────────────────────────────────────

describe('findReadyStories — story with no dependencies', () => {
  it('is ready when completed set is empty', () => {
    const s = story('story-001-001');
    const g = buildStoryGraph([s]);
    const ready = findReadyStories(g, new Set());
    assert.equal(ready.length, 1);
    assert.equal(ready[0].id, 'story-001-001');
  });
});

describe('findReadyStories — single dependency satisfied', () => {
  it('returns the story when its dependency is completed', () => {
    const g = buildStoryGraph([
      story('story-001-001', ['story-001-002']),
      story('story-001-002'),
    ]);
    const ready = findReadyStories(g, new Set(['story-001-002']));
    const ids = ready.map(s => s.id);
    assert.ok(ids.includes('story-001-001'), 'story-001-001 should be ready');
    assert.ok(ids.includes('story-001-002'), 'story-001-002 (no deps) should also be ready');
  });
});

describe('findReadyStories — dependency NOT satisfied', () => {
  it('does not return a story when its dependency is absent from completed', () => {
    const g = buildStoryGraph([
      story('story-001-001', ['story-001-002']),
      story('story-001-002'),
    ]);
    const ready = findReadyStories(g, new Set());
    const ids = ready.map(s => s.id);
    assert.ok(!ids.includes('story-001-001'), 'story-001-001 should NOT be ready (dep missing)');
    assert.ok(ids.includes('story-001-002'), 'story-001-002 (no deps) should be ready');
  });
});

describe('findReadyStories — two dependencies, only one completed', () => {
  it('does not return the story when only one of two deps is done', () => {
    const g = buildStoryGraph([
      story('story-001-001', ['story-001-002', 'story-001-003']),
      story('story-001-002'),
      story('story-001-003'),
    ]);
    const ready = findReadyStories(g, new Set(['story-001-002']));
    const ids = ready.map(s => s.id);
    assert.ok(!ids.includes('story-001-001'), 'story-001-001 still blocked (story-001-003 not done)');
  });

  it('returns the story when both deps are completed', () => {
    const g = buildStoryGraph([
      story('story-001-001', ['story-001-002', 'story-001-003']),
      story('story-001-002'),
      story('story-001-003'),
    ]);
    const ready = findReadyStories(g, new Set(['story-001-002', 'story-001-003']));
    const ids = ready.map(s => s.id);
    assert.ok(ids.includes('story-001-001'), 'story-001-001 is ready when both deps done');
  });
});

// ── 5. criticalPath ───────────────────────────────────────────────────────────

describe('criticalPath — empty graph', () => {
  it('returns { chain: [], estimatedMinutes: 0 }', () => {
    const result = criticalPath(buildStoryGraph([]));
    assert.deepEqual(result, { chain: [], estimatedMinutes: 0 });
  });
});

describe('criticalPath — single node', () => {
  it('returns the single story as the chain with its estimated_effort', () => {
    const g = buildStoryGraph([story('story-001-001', [], { effort: 5 })]);
    const result = criticalPath(g);
    assert.deepEqual(result, { chain: ['story-001-001'], estimatedMinutes: 5 });
  });

  it('returns estimatedMinutes 0 when effort is absent', () => {
    const g = buildStoryGraph([story('story-001-001')]);
    const result = criticalPath(g);
    assert.deepEqual(result, { chain: ['story-001-001'], estimatedMinutes: 0 });
  });
});

describe('criticalPath — linear chain', () => {
  // A(10) → B(20) → C(5), meaning B depends on A, C depends on B.
  // Source A, then B, then C. Chain [A, B, C], total 10+20+5=35.
  const A = story('story-001-001', [], { effort: 10 });
  const B = story('story-001-002', ['story-001-001'], { effort: 20 });
  const C = story('story-001-003', ['story-001-002'], { effort: 5 });
  const g = buildStoryGraph([A, B, C]);

  it('returns the full chain in execution order (source first)', () => {
    const result = criticalPath(g);
    assert.deepEqual(result.chain, ['story-001-001', 'story-001-002', 'story-001-003']);
  });

  it('returns the correct total estimatedMinutes', () => {
    const result = criticalPath(g);
    assert.equal(result.estimatedMinutes, 35);
  });
});

describe('criticalPath — diamond shape', () => {
  // A(10): no deps (source)
  // B(15): depends on A  → path A→B weight 25
  // C(5):  depends on A  → path A→C weight 15
  // D(1):  depends on B and C → path via B: 10+15+1=26, via C: 10+5+1=16
  const A = story('story-001-001', [], { effort: 10 });
  const B = story('story-001-002', ['story-001-001'], { effort: 15 });
  const C = story('story-001-003', ['story-001-001'], { effort: 5 });
  const D = story('story-001-004', ['story-001-002', 'story-001-003'], { effort: 1 });
  const g = buildStoryGraph([A, B, C, D]);

  it('returns the heavier path (A→B→D, weight 26)', () => {
    const result = criticalPath(g);
    assert.equal(result.estimatedMinutes, 26);
    assert.deepEqual(result.chain, ['story-001-001', 'story-001-002', 'story-001-004']);
  });
});

describe('criticalPath — all estimated_effort absent', () => {
  // Falls back to edge-count longest path; estimatedMinutes is 0; chain is non-empty.
  it('returns the longest chain by edge count with estimatedMinutes 0', () => {
    // Chain: A → B → C (B depends on A, C depends on B) — length 3
    // Isolated: D (no deps, no connections) — length 1
    const g = buildStoryGraph([
      story('story-001-001'),
      story('story-001-002', ['story-001-001']),
      story('story-001-003', ['story-001-002']),
      story('story-001-004'),
    ]);
    const result = criticalPath(g);
    assert.equal(result.estimatedMinutes, 0);
    assert.ok(result.chain.length > 0, 'chain must be non-empty');
    // Longest chain has 3 nodes
    assert.equal(result.chain.length, 3);
    assert.deepEqual(result.chain, ['story-001-001', 'story-001-002', 'story-001-003']);
  });
});

describe('criticalPath — mixed: some efforts absent', () => {
  // A(5): no deps
  // B(absent→0): depends on A
  // C(10): depends on B
  // Path A→B→C: 5+0+10=15
  it('treats absent effort as 0 and finds the correct weighted longest path', () => {
    const A = story('story-001-001', [], { effort: 5 });
    const B = story('story-001-002', ['story-001-001']); // no effort
    const C = story('story-001-003', ['story-001-002'], { effort: 10 });
    const g = buildStoryGraph([A, B, C]);
    const result = criticalPath(g);
    assert.equal(result.estimatedMinutes, 15);
    assert.deepEqual(result.chain, ['story-001-001', 'story-001-002', 'story-001-003']);
  });

  it('picks the path with higher total weight over a shorter one', () => {
    // Two paths from source X(0):
    //   X → Y(5) → Z(5)  total = 10
    //   X → W(8)          total = 8
    // Longest by weight is X→Y→Z
    const X = story('story-001-001', [], { effort: 0 });
    const Y = story('story-001-002', ['story-001-001'], { effort: 5 });
    const Z = story('story-001-003', ['story-001-002'], { effort: 5 });
    const W = story('story-001-004', ['story-001-001'], { effort: 8 });
    const g = buildStoryGraph([X, Y, Z, W]);
    const result = criticalPath(g);
    assert.equal(result.estimatedMinutes, 10);
    assert.deepEqual(result.chain, ['story-001-001', 'story-001-002', 'story-001-003']);
  });
});
