/**
 * Monotonicity and registry-coverage tests.
 *
 * T1: Guard denylist (union) — no layer can shrink the set.
 * T3: Guard allowlist (intersect) — no layer can widen the set.
 * ADR-003: Every guard-shaped field in PolicySchema has an explicit MERGE_STRATEGY entry.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod';
import { mergeLayers } from '../../src/config/mergeLayers.js';
import { MERGE_STRATEGY } from '../../src/config/mergeStrategy.js';
import { PolicySchema } from '../../src/types.js';
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

// ── T1 — Denylist union monotonicity ─────────────────────────────────────────

describe('T1 — denylist union: no layer can shrink the protected set', () => {
  it('protected_branches: union across all three orderings (team, repo, env)', () => {
    // Base state: team protects 'release', repo protects 'main'.
    // Any env value, including attempts to narrow or clear, cannot remove either.
    const looseningAttempts = [
      // env omits the field entirely
      { git: {} },
      // env sets only release (trying to drop main)
      { git: { protected_branches: ['release'] } },
      // env sets only main (trying to drop release)
      { git: { protected_branches: ['main'] } },
      // env sets empty list (trying to clear all)
      { git: { protected_branches: [] } },
    ];

    for (const envTree of looseningAttempts) {
      const layers = [
        layer('team', { git: { protected_branches: ['release'] } }),
        layer('repo', { git: { protected_branches: ['main'] } }),
        layer('env',  envTree),
      ];
      const { tree } = mergeLayers(layers, MERGE_STRATEGY);
      const branches = get(tree, 'git.protected_branches') as string[];
      assert.ok(
        branches.includes('main'),
        `'main' must survive env=${JSON.stringify(envTree)}: got ${JSON.stringify(branches)}`,
      );
      assert.ok(
        branches.includes('release'),
        `'release' must survive env=${JSON.stringify(envTree)}: got ${JSON.stringify(branches)}`,
      );
    }
  });

  it('protected_branches: env can ADD to the set (only tighten, never loosen)', () => {
    const layers = [
      layer('team', { git: { protected_branches: ['main'] } }),
      layer('repo', {}),
      layer('env',  { git: { protected_branches: ['develop'] } }),
    ];
    const { tree } = mergeLayers(layers, MERGE_STRATEGY);
    const branches = get(tree, 'git.protected_branches') as string[];
    assert.ok(branches.includes('main'), 'main must remain');
    assert.ok(branches.includes('develop'), 'env can add develop (tightening)');
  });

  it('forbidden_flags: env loosening attempt does not remove entries', () => {
    const layers = [
      layer('team', { git: { forbidden_flags: ['--force'] } }),
      layer('repo', { git: { forbidden_flags: ['--force-with-lease'] } }),
      layer('env',  { git: { forbidden_flags: ['--force'] } }), // tries to drop '--force-with-lease'
    ];
    const { tree } = mergeLayers(layers, MERGE_STRATEGY);
    const flags = get(tree, 'git.forbidden_flags') as string[];
    assert.ok(flags.includes('--force'), '--force must remain');
    assert.ok(flags.includes('--force-with-lease'), '--force-with-lease must not be dropped by env');
  });

  it('filesystem.protected_paths: union, env cannot drop entries', () => {
    const layers = [
      layer('team', { filesystem: { protected_paths: ['~/.ssh'] } }),
      layer('repo', { filesystem: { protected_paths: ['/etc'] } }),
      layer('env',  { filesystem: { protected_paths: [] } }), // tries to clear
    ];
    const { tree } = mergeLayers(layers, MERGE_STRATEGY);
    const paths = get(tree, 'filesystem.protected_paths') as string[];
    assert.ok(paths.includes('~/.ssh'), '~/.ssh must remain');
    assert.ok(paths.includes('/etc'), '/etc must remain');
  });

  it('agents.risky_paths: union, lower layer entry survives higher layer omission', () => {
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

// ── T3 — Allowlist intersect monotonicity ─────────────────────────────────────

describe('T3 — allowlist intersect: no layer can widen the permitted set', () => {
  it('allowed_remotes: intersect of team and repo', () => {
    const layers = [
      layer('team', { git: { allowed_remotes: ['origin', 'upstream'] } }),
      layer('repo', { git: { allowed_remotes: ['origin'] } }),
      layer('env',  {}),
    ];
    const { tree } = mergeLayers(layers, MERGE_STRATEGY);
    const remotes = get(tree, 'git.allowed_remotes') as string[];
    assert.deepEqual(remotes, ['origin']);
  });

  it('widening attempt: env adding to team list is blocked by intersection', () => {
    // env tries to add 'upstream' that team doesn't have.
    // Result: only 'origin' (the intersection of team's ['origin'] and env's ['origin', 'upstream']).
    const envTree = { git: { allowed_remotes: ['origin', 'upstream'] } };
    const layers = [
      layer('team', { git: { allowed_remotes: ['origin'] } }),
      layer('repo', {}),
      layer('env',  envTree),
    ];
    const { tree } = mergeLayers(layers, MERGE_STRATEGY);
    const remotes = get(tree, 'git.allowed_remotes') as string[];
    assert.ok(
      !remotes.includes('upstream'),
      `'upstream' must NOT be added by env — it is not in team's allowlist`,
    );
    // The team-permitted 'origin' must survive the widening attempt.
    assert.ok(
      remotes.includes('origin'),
      `'origin' must remain after env widening attempt: got ${JSON.stringify(remotes)}`,
    );
  });

  it('widening attempt: env with completely disjoint list produces empty intersect (with warning)', () => {
    // env tries to completely replace with a new list that shares nothing with team.
    // Result: empty intersect [] — this is most-restrictive but should emit a warning.
    // An empty allowlist blocks ALL operations at this path; this test confirms
    // the semantic (empty result is correct) while the console.warn notifies the operator.
    const envTree = { git: { allowed_remotes: ['upstream', 'backup'] } };
    const layers = [
      layer('team', { git: { allowed_remotes: ['origin'] } }),
      layer('repo', {}),
      layer('env',  envTree),
    ];
    const warns: string[] = [];
    const orig = console.warn;
    console.warn = (...args: unknown[]) => { warns.push(String(args[0])); };
    let remotes: string[];
    try {
      const { tree } = mergeLayers(layers, MERGE_STRATEGY);
      remotes = (get(tree, 'git.allowed_remotes') ?? []) as string[];
    } finally {
      console.warn = orig;
    }
    // The empty intersect is mathematically correct.
    assert.ok(!remotes.includes('upstream'), `'upstream' must NOT appear`);
    assert.ok(!remotes.includes('backup'), `'backup' must NOT appear`);
    // The operator must receive a warning about the empty allowlist.
    assert.ok(warns.some(w => w.includes('empty allowlist')), 'must warn about empty intersect allowlist');
  });

  it('absent layers are not treated as a universal allowlist (do not collapse to [])', () => {
    // Only team has allowed_remotes; repo and env are absent.
    // Result must be team's value, NOT [] (which would be wrongly over-restrictive).
    const layers = [
      layer('team', { git: { allowed_remotes: ['origin', 'upstream'] } }),
      layer('repo', {}),
      layer('env',  {}),
    ];
    const { tree } = mergeLayers(layers, MERGE_STRATEGY);
    const remotes = get(tree, 'git.allowed_remotes') as string[];
    assert.deepEqual([...remotes].sort(), ['origin', 'upstream']);
  });

  it('env can tighten the allowlist (only restriction, never expansion)', () => {
    const layers = [
      layer('team', { git: { allowed_remotes: ['origin', 'upstream'] } }),
      layer('repo', { git: { allowed_remotes: ['origin', 'upstream'] } }),
      layer('env',  { git: { allowed_remotes: ['origin'] } }),
    ];
    const { tree } = mergeLayers(layers, MERGE_STRATEGY);
    const remotes = get(tree, 'git.allowed_remotes') as string[];
    assert.deepEqual(remotes, ['origin']);
  });

  it('three-way intersect: only elements in ALL present layers survive', () => {
    const layers = [
      layer('team', { git: { allowed_remotes: ['origin', 'upstream', 'backup'] } }),
      layer('repo', { git: { allowed_remotes: ['origin', 'upstream'] } }),
      layer('env',  { git: { allowed_remotes: ['origin'] } }),
    ];
    const { tree } = mergeLayers(layers, MERGE_STRATEGY);
    const remotes = get(tree, 'git.allowed_remotes') as string[];
    assert.deepEqual(remotes, ['origin']);
  });
});

// ── agents_must_use_pr — true wins ───────────────────────────────────────────

describe('agents_must_use_pr — true wins regardless of precedence', () => {
  it('lower layer true is never overridden by higher layer false', () => {
    const layers = [
      layer('team', { git: { agents_must_use_pr: true } }),
      layer('repo', { git: { agents_must_use_pr: false } }),
      layer('env',  { git: { agents_must_use_pr: false } }),
    ];
    const { tree } = mergeLayers(layers, MERGE_STRATEGY);
    assert.equal(get(tree, 'git.agents_must_use_pr'), true);
  });

  it('higher layer true over lower layer false resolves true', () => {
    const layers = [
      layer('team', { git: { agents_must_use_pr: false } }),
      layer('repo', { git: { agents_must_use_pr: true } }),
      layer('env',  {}),
    ];
    const { tree } = mergeLayers(layers, MERGE_STRATEGY);
    assert.equal(get(tree, 'git.agents_must_use_pr'), true);
  });

  it('env true over team and repo false resolves true', () => {
    const layers = [
      layer('team', { git: { agents_must_use_pr: false } }),
      layer('repo', { git: { agents_must_use_pr: false } }),
      layer('env',  { git: { agents_must_use_pr: true } }),
    ];
    const { tree } = mergeLayers(layers, MERGE_STRATEGY);
    assert.equal(get(tree, 'git.agents_must_use_pr'), true);
  });
});

// ── ADR-003 — registry coverage meta-test ────────────────────────────────────

describe('ADR-003 — registry coverage: every guard-shaped field in PolicySchema has an explicit MERGE_STRATEGY entry', () => {
  function unwrapInner(schema: z.ZodTypeAny): z.ZodTypeAny {
    if (schema instanceof z.ZodDefault)
      return unwrapInner((schema._def as { innerType: z.ZodTypeAny }).innerType);
    if (schema instanceof z.ZodOptional)
      return unwrapInner((schema._def as { innerType: z.ZodTypeAny }).innerType);
    if (schema instanceof z.ZodNullable)
      return unwrapInner((schema._def as { innerType: z.ZodTypeAny }).innerType);
    return schema;
  }

  function enumerateFields(
    schema: z.ZodObject<z.ZodRawShape>,
    prefix = '',
  ): { dotPath: string; fieldName: string }[] {
    const result: { dotPath: string; fieldName: string }[] = [];
    for (const [key, rawSchema] of Object.entries(schema.shape)) {
      const dotPath = prefix ? `${prefix}.${key}` : key;
      const inner = unwrapInner(rawSchema as z.ZodTypeAny);
      if (inner instanceof z.ZodObject) {
        result.push(...enumerateFields(inner, dotPath));
      } else {
        result.push({ dotPath, fieldName: key });
      }
    }
    return result;
  }

  function isGuardShaped(fieldName: string): boolean {
    return (
      fieldName.endsWith('_branches') ||
      fieldName.endsWith('_paths') ||
      fieldName.startsWith('allowed_') ||
      fieldName.startsWith('forbidden_') ||
      fieldName.startsWith('risky_') ||
      // Guard booleans where `true` wins regardless of precedence (ADR-004).
      fieldName === 'agents_must_use_pr'
    );
  }

  it('every guard-shaped field has an explicit MERGE_STRATEGY entry', () => {
    const allFields = enumerateFields(PolicySchema);
    const guardFields = allFields.filter(f => isGuardShaped(f.fieldName));

    // Sanity check: we must find at least the known guard fields
    assert.ok(
      guardFields.length >= 5,
      `Expected at least 5 guard-shaped fields, found ${guardFields.length}: ${JSON.stringify(guardFields)}`,
    );

    for (const { dotPath, fieldName } of guardFields) {
      assert.ok(
        Object.prototype.hasOwnProperty.call(MERGE_STRATEGY, dotPath),
        `MERGE_STRATEGY is missing an entry for guard-shaped field "${dotPath}" (fieldName: "${fieldName}"). ` +
          `Add "${dotPath}" to MERGE_STRATEGY or a new guard list will default to loosenable 'replace'.`,
      );
    }
  });

  it('no guard-shaped field defaults to loosenable replace', () => {
    const allFields = enumerateFields(PolicySchema);
    const guardFields = allFields.filter(f => isGuardShaped(f.fieldName));

    for (const { dotPath } of guardFields) {
      if (Object.prototype.hasOwnProperty.call(MERGE_STRATEGY, dotPath)) {
        assert.notEqual(
          MERGE_STRATEGY[dotPath],
          'replace',
          `Guard field "${dotPath}" must NOT use 'replace' strategy — use 'union', 'intersect', 'and', or 'scalar'`,
        );
      }
    }
  });

  it('known guard fields are present in the registry', () => {
    const required = [
      'git.protected_branches',
      'git.forbidden_flags',
      'git.allowed_remotes',
      'git.agents_must_use_pr',
      'filesystem.protected_paths',
      'filesystem.allowed_write_root',
      'agents.risky_paths',
    ];
    for (const key of required) {
      assert.ok(
        Object.prototype.hasOwnProperty.call(MERGE_STRATEGY, key),
        `MERGE_STRATEGY must have an entry for "${key}"`,
      );
    }
  });
});
