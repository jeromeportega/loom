import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { Command } from 'commander';
import { CommandDescriptionSchema } from '../schema.js';
import { collectSpecs, enumerateRegisteredCommands } from '../registry.js';
import { applySpec } from '../applySpec.js';
import { spec as pullGuidanceSpec } from '../../commands/pullGuidance.js';
import { spec as projectSpec } from '../../commands/project.js';

// ---------------------------------------------------------------------------
// collectSpecs — schema validation
// ---------------------------------------------------------------------------

describe('collectSpecs', () => {
  const specs = collectSpecs();

  it('returns at least one spec', () => {
    assert.ok(specs.length > 0, 'collectSpecs must return at least one spec');
  });

  it('every spec passes CommandDescriptionSchema.parse()', () => {
    for (const spec of specs) {
      const result = CommandDescriptionSchema.safeParse(spec);
      if (!result.success) {
        const msgs = result.error.issues
          .map((i) => `${i.path.join('.')}: ${i.message}`)
          .join('\n');
        assert.fail(`Spec "${spec.name}" failed schema validation:\n${msgs}`);
      }
    }
  });

  it('spec name values are unique (no duplicate description store)', () => {
    const names = specs.map((s) => s.name);
    const uniqueNames = new Set(names);
    assert.strictEqual(
      uniqueNames.size,
      names.length,
      `Duplicate spec names found: ${names.filter((n, i) => names.indexOf(n) !== i).join(', ')}`
    );
  });

  // ---------------------------------------------------------------------------
  // Named parity-port additions must be present
  // ---------------------------------------------------------------------------

  it('has a spec for pull-guidance', () => {
    const found = specs.find((s) => s.name === 'pull-guidance');
    assert.ok(found, 'Expected a spec with name === "pull-guidance"');
  });

  it('has a spec for project', () => {
    const found = specs.find((s) => s.name === 'project');
    assert.ok(found, 'Expected a spec with name === "project"');
  });

  // ---------------------------------------------------------------------------
  // stop and propose commands are present with their flags documented
  // ---------------------------------------------------------------------------

  it('has a spec for stop with --epic and --reason options', () => {
    const found = specs.find((s) => s.name === 'stop');
    assert.ok(found, 'Expected a spec with name === "stop"');
    const optNames = found!.options.map((o) => o.name);
    assert.ok(optNames.includes('--epic'), 'stop spec must list --epic option');
    assert.ok(optNames.includes('--reason'), 'stop spec must list --reason option');
  });

  it('has a spec for propose with --top-lessons and --top-opps options', () => {
    const found = specs.find((s) => s.name === 'propose');
    assert.ok(found, 'Expected a spec with name === "propose"');
    const optNames = found!.options.map((o) => o.name);
    assert.ok(optNames.includes('--top-lessons'), 'propose spec must list --top-lessons option');
    assert.ok(optNames.includes('--top-opps'), 'propose spec must list --top-opps option');
  });

  // ---------------------------------------------------------------------------
  // Removed command must not appear
  // ---------------------------------------------------------------------------

  it('does not include a spec for serve (removed command)', () => {
    const found = specs.find((s) => s.name === 'serve');
    assert.strictEqual(found, undefined, 'serve is a removed command and must not appear in collectSpecs()');
  });

  // ---------------------------------------------------------------------------
  // Full-path subcommand names must be exact
  // ---------------------------------------------------------------------------

  it('has a spec with name === "mcp add"', () => {
    const found = specs.find((s) => s.name === 'mcp add');
    assert.ok(found, 'Expected a spec with name === "mcp add" (full path)');
  });

  it('has a spec with name === "mcp list"', () => {
    const found = specs.find((s) => s.name === 'mcp list');
    assert.ok(found, 'Expected a spec with name === "mcp list" (full path)');
  });

  it('has a spec with name === "guard check"', () => {
    const found = specs.find((s) => s.name === 'guard check');
    assert.ok(found, 'Expected a spec with name === "guard check" (full path)');
  });
});

// ---------------------------------------------------------------------------
// applySpec — one-origin summary wiring
// ---------------------------------------------------------------------------

describe('applySpec', () => {
  it('sets command.description() equal to spec.summary for pull-guidance', () => {
    const program = new Command();
    const cmd = applySpec(program.command('pull-guidance'), pullGuidanceSpec);
    assert.strictEqual(
      cmd.description(),
      pullGuidanceSpec.summary,
      'applySpec must set command description from spec.summary'
    );
  });

  it('sets command.description() equal to spec.summary for project', () => {
    const program = new Command();
    const cmd = applySpec(program.command('project'), projectSpec);
    assert.strictEqual(
      cmd.description(),
      projectSpec.summary,
      'applySpec must set command description from spec.summary'
    );
  });

  it('registers arguments from spec', () => {
    const program = new Command();
    const cmd = applySpec(program.command('pull-guidance'), pullGuidanceSpec);
    // Commander exposes registered args on _args
    const argNames = cmd.registeredArguments.map((a) => a.required ? `<${a.name()}>` : `[${a.name()}]`);
    assert.ok(argNames.length > 0, 'applySpec must register arguments from spec');
  });

  it('registers options from spec', () => {
    const program = new Command();
    const cmd = applySpec(program.command('pull-guidance'), pullGuidanceSpec);
    const optNames = cmd.options.map((o) => o.long ?? '');
    assert.ok(
      optNames.some((n) => n === '--json'),
      'applySpec must register options from spec'
    );
  });

  it('returns the command for chaining .action()', () => {
    const program = new Command();
    const cmd = applySpec(program.command('pull-guidance'), pullGuidanceSpec);
    assert.ok(cmd instanceof Command, 'applySpec must return the Command instance');
  });
});

// ---------------------------------------------------------------------------
// enumerateRegisteredCommands
// ---------------------------------------------------------------------------

describe('enumerateRegisteredCommands', () => {
  function buildTestProgram(): Command {
    const program = new Command('loom');
    program.command('status');
    program.command('run');
    const guard = program.command('guard');
    guard.command('check');
    guard.command('hook');
    const mcp = program.command('mcp');
    mcp.command('list');
    mcp.command('add');
    return program;
  }

  it('returns flat list of full-path command names', () => {
    const program = buildTestProgram();
    const names = enumerateRegisteredCommands(program);
    assert.ok(names.includes('status'), 'must include top-level commands');
    assert.ok(names.includes('guard check'), 'must include full-path subcommands');
    assert.ok(names.includes('guard hook'), 'must include guard hook');
    assert.ok(names.includes('mcp list'), 'must include mcp list');
    assert.ok(names.includes('mcp add'), 'must include mcp add');
  });

  it('includes full-path child names for grouped subcommands but not the group container itself', () => {
    const program = buildTestProgram();
    const names = enumerateRegisteredCommands(program);
    // Leaf commands must appear with their full path.
    assert.ok(names.includes('guard check'), 'guard check must appear');
    assert.ok(names.includes('mcp add'), 'mcp add must appear');
    // Parent group containers (no action, only sub-commands) must not appear.
    assert.strictEqual(names.filter((n) => n === 'guard').length, 0, 'guard parent must not appear as a standalone name');
    assert.strictEqual(names.filter((n) => n === 'mcp').length, 0, 'mcp parent must not appear as a standalone name');
  });

  it('returns unique names for a well-formed program', () => {
    const program = buildTestProgram();
    const names = enumerateRegisteredCommands(program);
    const unique = new Set(names);
    assert.strictEqual(unique.size, names.length, 'all enumerated names must be unique');
  });
});
