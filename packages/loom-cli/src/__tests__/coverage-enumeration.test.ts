/**
 * Unit tests for operatorCommands() and operatorKnobs() in coverage.ts.
 * No DB, network, or process side effects — pure enumeration functions.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { Command } from 'commander';
import { operatorCommands, operatorKnobs } from '../describe/coverage.js';
import { buildProgram } from '../index.js';
import { collectSpecs } from '../describe/registry.js';

// ---------------------------------------------------------------------------
// operatorCommands — happy path + AC1/AC4
// ---------------------------------------------------------------------------

describe('operatorCommands(buildProgram())', () => {
  // Hoist program + tokens — buildProgram() is read-only in these tests.
  const program = buildProgram();
  const tokens = operatorCommands(program);

  // Source the expected set from the live registry — NOT a literal array (AC1).
  const REQUIRED_OPERATOR_COMMANDS = new Set(
    collectSpecs()
      .filter((s) => (s.audience ?? 'operator') === 'operator')
      .map((s) => s.name)
  );

  it('returns a Set', () => {
    assert.ok(tokens instanceof Set);
  });

  it('contains init', () => {
    assert.ok(tokens.has('init'), 'expected "init" in operator commands');
  });

  it('contains epic', () => {
    assert.ok(tokens.has('epic'), 'expected "epic" in operator commands');
  });

  it('contains approve', () => {
    assert.ok(tokens.has('approve'), 'expected "approve" in operator commands');
  });

  it('contains run', () => {
    assert.ok(tokens.has('run'), 'expected "run" in operator commands');
  });

  it('contains status', () => {
    assert.ok(tokens.has('status'), 'expected "status" in operator commands');
  });

  it('contains diff', () => {
    assert.ok(tokens.has('diff'), 'expected "diff" in operator commands');
  });

  it('contains review', () => {
    assert.ok(tokens.has('review'), 'expected "review" in operator commands');
  });

  it('contains artifacts', () => {
    assert.ok(tokens.has('artifacts'), 'expected "artifacts" in operator commands');
  });

  it('contains traces', () => {
    assert.ok(tokens.has('traces'), 'expected "traces" in operator commands');
  });

  it('contains audit', () => {
    assert.ok(tokens.has('audit'), 'expected "audit" in operator commands');
  });

  it('contains autonomy', () => {
    assert.ok(tokens.has('autonomy'), 'expected "autonomy" in operator commands');
  });

  it('includes all operator-audience specs from collectSpecs()', () => {
    for (const name of REQUIRED_OPERATOR_COMMANDS) {
      assert.ok(tokens.has(name), `expected "${name}" (operator spec) in result`);
    }
  });
});

// ---------------------------------------------------------------------------
// operatorCommands — AC1 no-hardcode proof
// ---------------------------------------------------------------------------

describe('operatorCommands — no-hardcode proof', () => {
  it('a fabricated subcommand in the supplied program appears in the output', () => {
    const fabricated = new Command('loom');
    fabricated.command('my-fabricated-cmd-xyzzy');

    const tokens = operatorCommands(fabricated);
    assert.ok(
      tokens.has('my-fabricated-cmd-xyzzy'),
      'fabricated command must appear — proves derivation from the live program, not a hardcoded list'
    );
  });

  it('result changes when the program changes (second fabricated command)', () => {
    const programA = new Command('loom');
    programA.command('cmd-a');

    const programB = new Command('loom');
    programB.command('cmd-b');

    assert.ok(operatorCommands(programA).has('cmd-a'));
    assert.ok(!operatorCommands(programA).has('cmd-b'));
    assert.ok(operatorCommands(programB).has('cmd-b'));
    assert.ok(!operatorCommands(programB).has('cmd-a'));
  });
});

// ---------------------------------------------------------------------------
// operatorCommands — AC3 subset rule: audience filtering
// ---------------------------------------------------------------------------

describe('operatorCommands — audience filtering', () => {
  const tokens = operatorCommands(buildProgram());

  it('describe (audience: internal) is excluded from operator commands', () => {
    assert.ok(!tokens.has('describe'), '"describe" is audience:internal and must be excluded');
  });

  it('release (audience: internal) is excluded from operator commands', () => {
    assert.ok(!tokens.has('release'), '"release" is audience:internal and must be excluded');
  });

  it('publish (audience: internal) is excluded from operator commands', () => {
    assert.ok(!tokens.has('publish'), '"publish" is audience:internal and must be excluded');
  });

  it('guard hook (audience: internal) is excluded from operator commands', () => {
    assert.ok(!tokens.has('guard hook'), '"guard hook" is audience:internal and must be excluded');
  });

  it('guard check (no audience, defaults to operator) is included', () => {
    // Companion assertion: proves multi-word token format IS produced and filtering
    // correctly includes operator specs while excluding only the internal sibling.
    assert.ok(tokens.has('guard check'), '"guard check" defaults to operator and must be included');
  });

  it('a spec with no audience defaults to operator and is included', () => {
    const program = new Command('loom');
    program.command('unspecced-cmd');
    const t = operatorCommands(program);
    assert.ok(
      t.has('unspecced-cmd'),
      'command without a spec defaults to audience=operator and must be included'
    );
  });
});

// ---------------------------------------------------------------------------
// operatorCommands — AC3/aliases: alias expansion
// ---------------------------------------------------------------------------

describe('operatorCommands — alias expansion', () => {
  const tokens = operatorCommands(buildProgram());

  it('status spec alias "st" appears in operator tokens alongside the canonical name', () => {
    // status spec carries aliases: ['st'] — both the canonical name and the alias must appear.
    // This exercises the spec?.aliases expansion loop in operatorCommands().
    assert.ok(tokens.has('status'), 'canonical name "status" must be present');
    assert.ok(tokens.has('st'), 'alias "st" from status spec must appear in operator tokens');
  });

  it('a command with no spec and no aliases contributes only its name token', () => {
    const program = new Command('loom');
    program.command('bare-cmd');
    const t = operatorCommands(program);
    assert.ok(t.has('bare-cmd'), 'name token must be present');
    // size === 1: only the name, no spurious alias tokens
    assert.strictEqual(t.size, 1, 'no alias tokens should appear for a command without a spec');
  });
});

// ---------------------------------------------------------------------------
// operatorKnobs — happy path + AC2
// ---------------------------------------------------------------------------

describe('operatorKnobs — happy path', () => {
  // dist/__tests__  →  dist  →  packages/loom-cli  →  packages  →  repo root
  const schemaPath = resolve(__dirname, '..', '..', '..', '..', 'schemas', 'policy.schema.yaml');
  const knobs = operatorKnobs(schemaPath);

  it('returns a Set', () => {
    assert.ok(knobs instanceof Set);
  });

  it('includes agents.max_concurrent', () => {
    assert.ok(knobs.has('agents.max_concurrent'), 'expected "agents.max_concurrent" in knobs');
  });

  it('includes git.protected_branches', () => {
    assert.ok(knobs.has('git.protected_branches'), 'expected "git.protected_branches" in knobs');
  });

  it('includes agents.worktree_isolation', () => {
    assert.ok(knobs.has('agents.worktree_isolation'), 'expected "agents.worktree_isolation"');
  });

  it('includes git.allowed_remotes', () => {
    assert.ok(knobs.has('git.allowed_remotes'), 'expected "git.allowed_remotes"');
  });

  it('includes filesystem.protected_paths', () => {
    assert.ok(knobs.has('filesystem.protected_paths'), 'expected "filesystem.protected_paths"');
  });

  it('includes filesystem.allowed_write_root', () => {
    assert.ok(knobs.has('filesystem.allowed_write_root'), 'expected "filesystem.allowed_write_root"');
  });
});

// ---------------------------------------------------------------------------
// operatorKnobs — AC3 subset rule: x-internal and container exclusion
// ---------------------------------------------------------------------------

describe('operatorKnobs — subset rule', () => {
  const schemaPath = resolve(__dirname, '..', '..', '..', '..', 'schemas', 'policy.schema.yaml');
  const knobs = operatorKnobs(schemaPath);

  it('agents.integrator_max_attempts (x-internal: true) is excluded', () => {
    assert.ok(
      !knobs.has('agents.integrator_max_attempts'),
      'agents.integrator_max_attempts is x-internal and must be excluded'
    );
  });

  it('container nodes (e.g. agents.story_timeout_multipliers) are NOT emitted as tokens', () => {
    assert.ok(
      !knobs.has('agents.story_timeout_multipliers'),
      'container node agents.story_timeout_multipliers must not appear as a token'
    );
  });

  it('leaf children of container nodes ARE included (e.g. agents.story_timeout_multipliers.medium)', () => {
    assert.ok(
      knobs.has('agents.story_timeout_multipliers.medium'),
      'leaf child agents.story_timeout_multipliers.medium must be included'
    );
  });

  it('fields outside git|filesystem|agents are NOT included (e.g. mcp.registry)', () => {
    assert.ok(
      !knobs.has('mcp.registry'),
      'mcp.registry is outside the git|filesystem|agents blocks and must not be included'
    );
  });

  it('does not include the block names themselves (git, filesystem, agents)', () => {
    assert.ok(!knobs.has('git'), '"git" itself is a container block, not a knob token');
    assert.ok(!knobs.has('filesystem'), '"filesystem" itself must not be a token');
    assert.ok(!knobs.has('agents'), '"agents" itself must not be a token');
  });
});

// ---------------------------------------------------------------------------
// operatorKnobs — custom schema path parameter
// ---------------------------------------------------------------------------

describe('operatorKnobs — custom schema fixture', () => {
  it('reads a custom YAML schema path when supplied', () => {
    const realPath = resolve(__dirname, '..', '..', '..', '..', 'schemas', 'policy.schema.yaml');
    const knobs = operatorKnobs(realPath);
    assert.ok(knobs.size > 0, 'operatorKnobs(explicitPath) must return at least one token');
  });
});
