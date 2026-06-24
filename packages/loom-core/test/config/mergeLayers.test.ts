import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mergeLayers } from '../../src/config/mergeLayers.js';
import { MERGE_STRATEGY } from '../../src/config/mergeStrategy.js';
import { ConfigMergeError } from '../../src/config/errors.js';
import type { ConfigLayer } from '../../src/config/types.js';

// ── helpers ───────────────────────────────────────────────────────────────────

function layer(name: 'team' | 'repo' | 'env', tree: unknown): ConfigLayer {
  return { name, tree };
}

function get(tree: unknown, dotPath: string): unknown {
  return dotPath.split('.').reduce<unknown>((cur, k) => {
    if (typeof cur !== 'object' || cur === null) return undefined;
    return (cur as Record<string, unknown>)[k];
  }, tree);
}

// ── Scalar — higher layer wins ────────────────────────────────────────────────

describe('scalar — higher layer wins', () => {
  it('env wins over repo and team', () => {
    const layers = [
      layer('team', { agents: { model: 'team-model' } }),
      layer('repo', { agents: { model: 'repo-model' } }),
      layer('env',  { agents: { model: 'env-model' } }),
    ];
    const { tree } = mergeLayers(layers, MERGE_STRATEGY);
    assert.equal(get(tree, 'agents.model'), 'env-model');
  });

  it('repo wins over team when env is absent', () => {
    const layers = [
      layer('team', { agents: { model: 'team-model' } }),
      layer('repo', { agents: { model: 'repo-model' } }),
      layer('env',  {}),
    ];
    const { tree } = mergeLayers(layers, MERGE_STRATEGY);
    assert.equal(get(tree, 'agents.model'), 'repo-model');
  });

  it('team value resolves when only team sets it', () => {
    const layers = [
      layer('team', { agents: { model: 'team-model' } }),
      layer('repo', {}),
      layer('env',  {}),
    ];
    const { tree } = mergeLayers(layers, MERGE_STRATEGY);
    assert.equal(get(tree, 'agents.model'), 'team-model');
  });

  it('absent fields stay absent through merge (ADR-007)', () => {
    const layers = [
      layer('team', {}),
      layer('repo', {}),
      layer('env',  {}),
    ];
    const { tree } = mergeLayers(layers, MERGE_STRATEGY);
    assert.equal(get(tree, 'agents.model'), undefined);
  });

  it('null is treated as absent and does not overwrite a present value', () => {
    const layers = [
      layer('team', { agents: { model: 'team-model' } }),
      layer('repo', { agents: { model: null } }),
      layer('env',  {}),
    ];
    // null is absent → team's value wins
    const { tree } = mergeLayers(layers, MERGE_STRATEGY);
    assert.equal(get(tree, 'agents.model'), 'team-model');
  });
});

// ── Deep map — key-wise merge ─────────────────────────────────────────────────

describe('deep map — key-wise merge', () => {
  it('disjoint keys from different layers both appear', () => {
    const layers = [
      layer('team', { agents: { max_concurrent: 3 } }),
      layer('repo', { agents: { model: 'claude-haiku' } }),
      layer('env',  {}),
    ];
    const { tree } = mergeLayers(layers, MERGE_STRATEGY);
    assert.equal(get(tree, 'agents.max_concurrent'), 3);
    assert.equal(get(tree, 'agents.model'), 'claude-haiku');
  });

  it('repo overrides team for the same nested key', () => {
    const layers = [
      layer('team', { agents: { max_concurrent: 3 } }),
      layer('repo', { agents: { max_concurrent: 5 } }),
      layer('env',  {}),
    ];
    const { tree } = mergeLayers(layers, MERGE_STRATEGY);
    assert.equal(get(tree, 'agents.max_concurrent'), 5);
  });

  it('env overrides repo and team for the same nested key', () => {
    const layers = [
      layer('team', { agents: { max_concurrent: 3 } }),
      layer('repo', { agents: { max_concurrent: 5 } }),
      layer('env',  { agents: { max_concurrent: 7 } }),
    ];
    const { tree } = mergeLayers(layers, MERGE_STRATEGY);
    assert.equal(get(tree, 'agents.max_concurrent'), 7);
  });

  it('cross-section merge: team.agents and repo.git coexist', () => {
    const layers = [
      layer('team', { agents: { model: 'claude-sonnet' } }),
      layer('repo', { git: { agents_must_use_pr: true } }),
      layer('env',  {}),
    ];
    const { tree } = mergeLayers(layers, MERGE_STRATEGY);
    assert.equal(get(tree, 'agents.model'), 'claude-sonnet');
    assert.equal(get(tree, 'git.agents_must_use_pr'), true);
  });
});

// ── Union — denylist most-restrictive ─────────────────────────────────────────

describe('union — denylist most-restrictive (ADR-004)', () => {
  it('protected_branches: result contains entries from both team and repo', () => {
    const layers = [
      layer('team', { git: { protected_branches: ['release'] } }),
      layer('repo', { git: { protected_branches: ['main'] } }),
      layer('env',  {}),
    ];
    const { tree } = mergeLayers(layers, MERGE_STRATEGY);
    const branches = get(tree, 'git.protected_branches') as string[];
    assert.ok(branches.includes('release'));
    assert.ok(branches.includes('main'));
  });

  it('env loosening attempt: env sets only [release] but cannot remove main', () => {
    const layers = [
      layer('team', { git: { protected_branches: ['release'] } }),
      layer('repo', { git: { protected_branches: ['main'] } }),
      layer('env',  { git: { protected_branches: ['release'] } }),
    ];
    const { tree } = mergeLayers(layers, MERGE_STRATEGY);
    const branches = get(tree, 'git.protected_branches') as string[];
    assert.ok(branches.includes('main'), `'main' must survive env loosening: ${JSON.stringify(branches)}`);
    assert.ok(branches.includes('release'));
  });

  it('env loosening attempt: env sets [] but cannot remove any entry', () => {
    const layers = [
      layer('team', { git: { protected_branches: ['release'] } }),
      layer('repo', { git: { protected_branches: ['main'] } }),
      layer('env',  { git: { protected_branches: [] } }),
    ];
    const { tree } = mergeLayers(layers, MERGE_STRATEGY);
    const branches = get(tree, 'git.protected_branches') as string[];
    assert.ok(branches.includes('main'), `'main' must survive empty env list: ${JSON.stringify(branches)}`);
    assert.ok(branches.includes('release'));
  });

  it('union deduplicates entries shared across layers', () => {
    const layers = [
      layer('team', { git: { protected_branches: ['main', 'release'] } }),
      layer('repo', { git: { protected_branches: ['main'] } }),
      layer('env',  {}),
    ];
    const { tree } = mergeLayers(layers, MERGE_STRATEGY);
    const branches = get(tree, 'git.protected_branches') as string[];
    assert.equal(branches.filter(b => b === 'main').length, 1, 'no duplicates after union');
  });

  it('forbidden_flags: union of team and repo', () => {
    const layers = [
      layer('team', { git: { forbidden_flags: ['--force'] } }),
      layer('repo', { git: { forbidden_flags: ['--force-with-lease'] } }),
      layer('env',  {}),
    ];
    const { tree } = mergeLayers(layers, MERGE_STRATEGY);
    const flags = get(tree, 'git.forbidden_flags') as string[];
    assert.ok(flags.includes('--force'));
    assert.ok(flags.includes('--force-with-lease'));
  });

  it('filesystem.protected_paths: union', () => {
    const layers = [
      layer('team', { filesystem: { protected_paths: ['~/.ssh'] } }),
      layer('repo', { filesystem: { protected_paths: ['/etc'] } }),
      layer('env',  {}),
    ];
    const { tree } = mergeLayers(layers, MERGE_STRATEGY);
    const paths = get(tree, 'filesystem.protected_paths') as string[];
    assert.ok(paths.includes('~/.ssh'));
    assert.ok(paths.includes('/etc'));
  });

  it('agents.risky_paths: union', () => {
    const layers = [
      layer('team', { agents: { risky_paths: ['**/auth/**'] } }),
      layer('repo', { agents: { risky_paths: ['**/payments/**'] } }),
      layer('env',  {}),
    ];
    const { tree } = mergeLayers(layers, MERGE_STRATEGY);
    const paths = get(tree, 'agents.risky_paths') as string[];
    assert.ok(paths.includes('**/auth/**'));
    assert.ok(paths.includes('**/payments/**'));
  });
});

// ── Intersect — allowlist most-restrictive ────────────────────────────────────

describe('intersect — allowlist most-restrictive (ADR-004)', () => {
  it('allowed_remotes: intersection of team and repo', () => {
    const layers = [
      layer('team', { git: { allowed_remotes: ['origin', 'upstream'] } }),
      layer('repo', { git: { allowed_remotes: ['origin'] } }),
      layer('env',  {}),
    ];
    const { tree } = mergeLayers(layers, MERGE_STRATEGY);
    const remotes = get(tree, 'git.allowed_remotes') as string[];
    assert.deepEqual(remotes, ['origin']);
  });

  it('widening attempt: env cannot add an entry not in team or repo', () => {
    const layers = [
      layer('team', { git: { allowed_remotes: ['origin'] } }),
      layer('repo', {}),
      layer('env',  { git: { allowed_remotes: ['origin', 'upstream'] } }),
    ];
    const { tree } = mergeLayers(layers, MERGE_STRATEGY);
    const remotes = get(tree, 'git.allowed_remotes') as string[];
    assert.ok(!remotes.includes('upstream'), 'env cannot widen the allowlist');
    assert.ok(remotes.includes('origin'));
  });

  it('single present layer: value passes through unchanged', () => {
    const layers = [
      layer('team', { git: { allowed_remotes: ['origin', 'upstream'] } }),
      layer('repo', {}),
      layer('env',  {}),
    ];
    const { tree } = mergeLayers(layers, MERGE_STRATEGY);
    const remotes = get(tree, 'git.allowed_remotes') as string[];
    assert.deepEqual([...remotes].sort(), ['origin', 'upstream']);
  });

  it('absent layers are not treated as empty sets — do not collapse to []', () => {
    // Only team has allowed_remotes; repo and env are absent.
    // The result should be team's value, not []
    const layers = [
      layer('team', { git: { allowed_remotes: ['origin'] } }),
      layer('repo', {}),
      layer('env',  {}),
    ];
    const { tree } = mergeLayers(layers, MERGE_STRATEGY);
    const remotes = get(tree, 'git.allowed_remotes') as string[];
    assert.equal(remotes.length, 1);
    assert.ok(remotes.includes('origin'));
  });

  it('env tightening: env with a subset further restricts the allowlist', () => {
    const layers = [
      layer('team', { git: { allowed_remotes: ['origin', 'upstream'] } }),
      layer('repo', { git: { allowed_remotes: ['origin', 'upstream'] } }),
      layer('env',  { git: { allowed_remotes: ['origin'] } }),
    ];
    const { tree } = mergeLayers(layers, MERGE_STRATEGY);
    const remotes = get(tree, 'git.allowed_remotes') as string[];
    assert.deepEqual(remotes, ['origin']);
  });
});

// ── Non-guard list — replace ──────────────────────────────────────────────────

describe('replace — non-guard list, higher layer wins', () => {
  it('unlisted array field: higher layer replaces lower', () => {
    // Use an empty registry so the structural default ('replace') applies.
    const layers = [
      layer('team', { some_list: ['a', 'b'] }),
      layer('repo', { some_list: ['c'] }),
      layer('env',  {}),
    ];
    const { tree } = mergeLayers(layers, {});
    assert.deepEqual(get(tree, 'some_list'), ['c']);
  });

  it('env overrides repo list', () => {
    const layers = [
      layer('team', { some_list: ['a'] }),
      layer('repo', { some_list: ['b', 'c'] }),
      layer('env',  { some_list: ['d'] }),
    ];
    const { tree } = mergeLayers(layers, {});
    assert.deepEqual(get(tree, 'some_list'), ['d']);
  });
});

// ── And — guard boolean, true wins ───────────────────────────────────────────

describe('and — agents_must_use_pr: true wins', () => {
  it('lower layer true wins over higher layer false', () => {
    const layers = [
      layer('team', { git: { agents_must_use_pr: true } }),
      layer('repo', { git: { agents_must_use_pr: false } }),
      layer('env',  {}),
    ];
    const { tree } = mergeLayers(layers, MERGE_STRATEGY);
    assert.equal(get(tree, 'git.agents_must_use_pr'), true);
  });

  it('higher layer true over lower layer false still resolves true', () => {
    const layers = [
      layer('team', { git: { agents_must_use_pr: false } }),
      layer('repo', { git: { agents_must_use_pr: true } }),
      layer('env',  {}),
    ];
    const { tree } = mergeLayers(layers, MERGE_STRATEGY);
    assert.equal(get(tree, 'git.agents_must_use_pr'), true);
  });

  it('false stays false when no layer sets true', () => {
    const layers = [
      layer('team', { git: { agents_must_use_pr: false } }),
      layer('repo', {}),
      layer('env',  {}),
    ];
    const { tree } = mergeLayers(layers, MERGE_STRATEGY);
    assert.equal(get(tree, 'git.agents_must_use_pr'), false);
  });

  it('all three layers setting true → true', () => {
    const layers = [
      layer('team', { git: { agents_must_use_pr: true } }),
      layer('repo', { git: { agents_must_use_pr: true } }),
      layer('env',  { git: { agents_must_use_pr: true } }),
    ];
    const { tree } = mergeLayers(layers, MERGE_STRATEGY);
    assert.equal(get(tree, 'git.agents_must_use_pr'), true);
  });

  it('env false cannot override team or repo true', () => {
    const layers = [
      layer('team', { git: { agents_must_use_pr: true } }),
      layer('repo', {}),
      layer('env',  { git: { agents_must_use_pr: false } }),
    ];
    const { tree } = mergeLayers(layers, MERGE_STRATEGY);
    assert.equal(get(tree, 'git.agents_must_use_pr'), true);
  });
});

// ── Type conflicts ─────────────────────────────────────────────────────────────

describe('type conflict — deterministic ConfigMergeError (FR-8)', () => {
  it('throws ConfigMergeError when scalar conflicts with map', () => {
    const layers = [
      layer('team', { agents: { model: 'string-value' } }),
      layer('repo', { agents: { model: { nested: 'object' } } }),
      layer('env',  {}),
    ];
    assert.throws(
      () => mergeLayers(layers, MERGE_STRATEGY),
      (err: unknown) => {
        assert.ok(err instanceof ConfigMergeError);
        assert.equal(err.keyPath, 'agents.model');
        return true;
      },
    );
  });

  it('throws ConfigMergeError when scalar conflicts with list', () => {
    const layers = [
      layer('team', { agents: { model: 'string' } }),
      layer('repo', { agents: { model: ['list-item'] } }),
      layer('env',  {}),
    ];
    assert.throws(
      () => mergeLayers(layers, MERGE_STRATEGY),
      (err: unknown) => {
        assert.ok(err instanceof ConfigMergeError);
        assert.equal(err.keyPath, 'agents.model');
        return true;
      },
    );
  });

  it('throws ConfigMergeError when map conflicts with list', () => {
    const layers = [
      layer('team', { key: { is: 'map' } }),
      layer('repo', { key: ['is', 'list'] }),
      layer('env',  {}),
    ];
    assert.throws(
      () => mergeLayers(layers, {}),
      (err: unknown) => {
        assert.ok(err instanceof ConfigMergeError);
        assert.equal(err.keyPath, 'key');
        return true;
      },
    );
  });

  it('ConfigMergeError includes per-layer kind details', () => {
    const layers = [
      layer('team', { key: 'scalar-value' }),
      layer('repo', { key: { is: 'map' } }),
      layer('env',  {}),
    ];
    assert.throws(
      () => mergeLayers(layers, {}),
      (err: unknown) => {
        assert.ok(err instanceof ConfigMergeError);
        assert.equal(err.keyPath, 'key');
        const teamEntry = err.conflict.find(c => c.layer === 'team');
        const repoEntry = err.conflict.find(c => c.layer === 'repo');
        assert.ok(teamEntry, 'conflict must include team layer');
        assert.ok(repoEntry, 'conflict must include repo layer');
        assert.equal(teamEntry.kind, 'scalar');
        assert.equal(repoEntry.kind, 'map');
        return true;
      },
    );
  });

  it('same conflict → same error message (deterministic)', () => {
    const makeConflict = () => [
      layer('team', { key: 'scalar' }),
      layer('repo', { key: { map: true } }),
      layer('env',  {}),
    ];
    let err1: ConfigMergeError | undefined;
    let err2: ConfigMergeError | undefined;
    try { mergeLayers(makeConflict(), {}); } catch (e) { err1 = e as ConfigMergeError; }
    try { mergeLayers(makeConflict(), {}); } catch (e) { err2 = e as ConfigMergeError; }
    assert.ok(err1 && err2, 'both calls must throw');
    assert.equal(err1.message, err2.message);
    assert.equal(err1.keyPath, err2.keyPath);
    assert.deepEqual(err1.conflict, err2.conflict);
  });
});

// ── Provenance ────────────────────────────────────────────────────────────────

describe('provenance — audit trail', () => {
  it('scalar: provenance records the winning layer', () => {
    const layers = [
      layer('team', { agents: { model: 'team-model' } }),
      layer('repo', { agents: { model: 'repo-model' } }),
      layer('env',  {}),
    ];
    const { provenance } = mergeLayers(layers, MERGE_STRATEGY);
    assert.equal(provenance['agents.model'], 'repo');
  });

  it('env wins: provenance records env', () => {
    const layers = [
      layer('team', { agents: { model: 'team' } }),
      layer('repo', { agents: { model: 'repo' } }),
      layer('env',  { agents: { model: 'env' } }),
    ];
    const { provenance } = mergeLayers(layers, MERGE_STRATEGY);
    assert.equal(provenance['agents.model'], 'env');
  });
});

// ── Empty layers / edge cases ─────────────────────────────────────────────────

describe('edge cases', () => {
  it('all empty layers → empty tree', () => {
    const layers = [layer('team', {}), layer('repo', {}), layer('env', {})];
    const { tree } = mergeLayers(layers, MERGE_STRATEGY);
    assert.deepEqual(tree, {});
  });

  it('single layer: value passes through unchanged', () => {
    const layers = [
      layer('team', { agents: { model: 'only-model', max_concurrent: 3 } }),
      layer('repo', {}),
      layer('env',  {}),
    ];
    const { tree } = mergeLayers(layers, MERGE_STRATEGY);
    assert.equal(get(tree, 'agents.model'), 'only-model');
    assert.equal(get(tree, 'agents.max_concurrent'), 3);
  });

  it('sections not present in any layer do not appear in result', () => {
    const layers = [
      layer('team', { agents: { model: 'x' } }),
      layer('repo', {}),
      layer('env',  {}),
    ];
    const { tree } = mergeLayers(layers, MERGE_STRATEGY);
    assert.equal(get(tree, 'git'), undefined);
    assert.equal(get(tree, 'filesystem'), undefined);
  });
});
