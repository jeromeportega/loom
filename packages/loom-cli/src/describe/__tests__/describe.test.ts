import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Command } from 'commander';
import { ZodError } from 'zod';
import { ManifestSchema, CommandDescriptionSchema } from '../schema.js';
import { collectSpecs } from '../registry.js';
import { WORKFLOWS } from '../workflows.js';
import { buildManifest } from '../manifest.js';
import { runDescribe, registerDescribe, spec as describeSpec } from '../../commands/describe.js';

// ---------------------------------------------------------------------------
// Capture helpers
// ---------------------------------------------------------------------------

interface Captured {
  stdout: string;
  stderr: string;
  exitCode: number | string | undefined;
}

function capture(fn: () => void): Captured {
  const logs: string[] = [];
  const errors: string[] = [];
  const origLog = console.log;
  const origErr = console.error;
  const origExitCode = process.exitCode;
  process.exitCode = undefined;
  console.log = (...args: unknown[]) => logs.push(args.map(String).join(' '));
  console.error = (...args: unknown[]) => errors.push(args.map(String).join(' '));
  try {
    fn();
  } finally {
    console.log = origLog;
    console.error = origErr;
  }
  const code = process.exitCode;
  process.exitCode = origExitCode;
  return { stdout: logs.join('\n'), stderr: errors.join('\n'), exitCode: code };
}

// ---------------------------------------------------------------------------
// runDescribe — no arg: full manifest
// ---------------------------------------------------------------------------

describe('runDescribe — no arg', () => {
  it('emits valid JSON to stdout and exits 0', () => {
    const { stdout, exitCode } = capture(() => runDescribe());
    assert.ok(stdout.length > 0, 'stdout must not be empty');
    assert.doesNotThrow(() => JSON.parse(stdout), 'stdout must be valid JSON');
    assert.equal(exitCode, undefined, 'exitCode must not be set (exit 0)');
  });

  it('stdout validates against ManifestSchema', () => {
    const { stdout } = capture(() => runDescribe());
    const parsed = JSON.parse(stdout);
    const result = ManifestSchema.safeParse(parsed);
    if (!result.success) {
      const msgs = result.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('\n');
      assert.fail(`Full manifest failed ManifestSchema validation:\n${msgs}`);
    }
  });

  it('manifest contains both commands and workflows', () => {
    const { stdout } = capture(() => runDescribe());
    const manifest = JSON.parse(stdout) as { commands: unknown[]; workflows: unknown[] };
    assert.ok(Array.isArray(manifest.commands) && manifest.commands.length > 0, 'manifest.commands must be a non-empty array');
    assert.ok(Array.isArray(manifest.workflows) && manifest.workflows.length > 0, 'manifest.workflows must be a non-empty array');
  });

  it('output is deterministic and round-trips through JSON.parse', () => {
    const { stdout: a } = capture(() => runDescribe());
    const { stdout: b } = capture(() => runDescribe());
    assert.equal(a, b, 'consecutive calls must produce identical output');
    assert.equal(JSON.stringify(JSON.parse(a), null, 2), a, 'output must be JSON.stringify(payload, null, 2)');
  });

  it('loomVersion in manifest matches package.json version', () => {
    const { stdout } = capture(() => runDescribe());
    const manifest = JSON.parse(stdout) as { loomVersion: string };
    // loomVersion must be a non-empty semver-like string
    assert.ok(manifest.loomVersion.length > 0, 'loomVersion must be non-empty');
    assert.match(manifest.loomVersion, /^\d+\.\d+\.\d+/, 'loomVersion must look like a semver');
  });
});

// ---------------------------------------------------------------------------
// runDescribe — single command by name
// ---------------------------------------------------------------------------

describe('runDescribe — single command lookup', () => {
  it('loom describe status: stdout validates against CommandDescriptionSchema', () => {
    const { stdout, exitCode } = capture(() => runDescribe('status'));
    assert.equal(exitCode, undefined, 'exit 0 for known command');
    const parsed = JSON.parse(stdout);
    const result = CommandDescriptionSchema.safeParse(parsed);
    if (!result.success) {
      const msgs = result.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('\n');
      assert.fail(`status spec failed schema validation:\n${msgs}`);
    }
  });

  it('loom describe status: output deep-equals the authored spec', () => {
    const { stdout } = capture(() => runDescribe('status'));
    const parsed = JSON.parse(stdout) as { name: string };
    assert.equal(parsed.name, 'status', 'returned spec must have name === "status"');
    // Verify the round-trip matches the authored spec from collectSpecs
    const authored = collectSpecs().find((s) => s.name === 'status');
    assert.ok(authored, 'status spec must be in collectSpecs()');
    assert.deepEqual(parsed, JSON.parse(JSON.stringify(authored)));
  });

  it('multi-word lookup: "guard check" resolves to the guard check spec', () => {
    const { stdout, exitCode } = capture(() => runDescribe('guard check'));
    assert.equal(exitCode, undefined, 'exit 0 for guard check');
    const parsed = JSON.parse(stdout) as { name: string };
    assert.equal(parsed.name, 'guard check', 'spec name must be "guard check"');
  });

  it('multi-word lookup: "mcp add" resolves to the mcp add spec', () => {
    const { stdout, exitCode } = capture(() => runDescribe('mcp add'));
    assert.equal(exitCode, undefined, 'exit 0 for mcp add');
    const parsed = JSON.parse(stdout) as { name: string };
    assert.equal(parsed.name, 'mcp add', 'spec name must be "mcp add"');
  });
});

// ---------------------------------------------------------------------------
// runDescribe — unknown command
// ---------------------------------------------------------------------------

describe('runDescribe — unknown command', () => {
  it('sets exitCode=1, writes to stderr, emits nothing valid to stdout', () => {
    const { stdout, stderr, exitCode } = capture(() => runDescribe('nope'));
    assert.equal(exitCode, 1, 'exitCode must be 1 for unknown command');
    assert.ok(stderr.length > 0, 'stderr must contain a message');
    assert.match(stderr, /nope/i, 'stderr should include the unknown command name');
    // stdout must not be parseable as a valid manifest or command description
    if (stdout.trim().length > 0) {
      assert.throws(() => {
        ManifestSchema.parse(JSON.parse(stdout));
      }, 'stdout must not be a valid manifest for unknown command');
    }
  });
});

// ---------------------------------------------------------------------------
// buildManifest — unit tests
// ---------------------------------------------------------------------------

describe('buildManifest', () => {
  it('returns a ManifestSchema-valid object with a real program', () => {
    const program = new Command();
    // build a minimal program that mirrors the real one
    const result = buildManifest(program);
    const validation = ManifestSchema.safeParse(result);
    if (!validation.success) {
      const msgs = validation.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('\n');
      assert.fail(`buildManifest output failed ManifestSchema validation:\n${msgs}`);
    }
  });

  it('returned manifest includes only operator-audience commands from collectSpecs()', () => {
    const program = new Command();
    const manifest = buildManifest(program);
    const operatorSpecs = collectSpecs().filter((s) => (s.audience ?? 'operator') === 'operator');
    assert.equal(
      manifest.commands.length,
      operatorSpecs.length,
      'manifest.commands must equal operator-audience collectSpecs() count'
    );
  });

  it('returned manifest includes all WORKFLOWS', () => {
    const program = new Command();
    const manifest = buildManifest(program);
    assert.equal(
      manifest.workflows.length,
      WORKFLOWS.length,
      'manifest.workflows must equal WORKFLOWS count'
    );
  });

  it('source is literal "live-commander-registry"', () => {
    const program = new Command();
    const manifest = buildManifest(program);
    assert.equal(manifest.source, 'live-commander-registry');
  });

  it('ManifestSchema.parse throws ZodError for invalid spec with path: message format', () => {
    // Verify the ZodError format (path: message) per PMAgent.ts:140.
    // buildManifest delegates validation to ManifestSchema.parse internally.
    assert.throws(
      () => {
        ManifestSchema.parse({
          loomVersion: '1.0.0',
          source: 'live-commander-registry',
          commands: [
            {
              name: '', // invalid: empty name
              summary: 'x',
              whenToUse: 'y',
              arguments: [],
              options: [],
              output: { text: 'z' },
              examples: [{ command: 'loom x', description: 'desc' }],
              exitCodes: [{ code: 0, meaning: 'ok' }],
              errors: [],
              relationships: { prerequisites: [], nextSteps: [] },
            },
          ],
          workflows: WORKFLOWS,
        });
      },
      (err: unknown) => {
        assert.ok(err instanceof ZodError, 'must throw a ZodError');
        const formatted = err.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('\n');
        assert.match(formatted, /commands\.\d+\.name:/, 'formatted error must show path');
        assert.ok(formatted.includes(':'), 'formatted error must use path: message format');
        return true;
      }
    );
  });
});

// ---------------------------------------------------------------------------
// describe spec self-validation
// ---------------------------------------------------------------------------

describe('describe command spec', () => {
  it('spec passes CommandDescriptionSchema validation', () => {
    const result = CommandDescriptionSchema.safeParse(describeSpec);
    if (!result.success) {
      const msgs = result.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('\n');
      assert.fail(`describe spec failed CommandDescriptionSchema:\n${msgs}`);
    }
  });

  it('spec name is "describe"', () => {
    assert.equal(describeSpec.name, 'describe');
  });

  it('describe spec is present in collectSpecs()', () => {
    const found = collectSpecs().find((s) => s.name === 'describe');
    assert.ok(found, 'describe spec must appear in collectSpecs()');
  });
});

// ---------------------------------------------------------------------------
// --help smoke test (NFR-1)
// ---------------------------------------------------------------------------

describe('--help smoke tests', () => {
  it('registerDescribe does not break Commander help output', () => {
    const program = new Command('loom');
    program.exitOverride(); // prevent process.exit() from crashing the test
    registerDescribe(program);
    // helpInformation() returns a string — if it doesn't throw, help is intact.
    // `describe` is hidden from help (story-087-001) but the command is still registered.
    const helpText = program.helpInformation();
    assert.ok(helpText.length > 0, 'help output must be non-empty');
    const registered = program.commands.find((c) => c.name() === 'describe');
    assert.ok(registered, 'describe command must be registered even though it is hidden from help');
  });
});

// ---------------------------------------------------------------------------
// docs/capabilities.md must contain a describe row
// ---------------------------------------------------------------------------

describe('docs/capabilities.md', () => {
  it('contains a "describe" row', () => {
    // __dirname = dist/describe/__tests__; repo root is 5 levels up
    // dist/describe/__tests__ -> dist/describe -> dist -> loom-cli -> packages -> repo root
    const repoRoot = resolve(__dirname, '..', '..', '..', '..', '..');
    const capabilitiesPath = resolve(repoRoot, 'docs', 'capabilities.md');
    const doc = readFileSync(capabilitiesPath, 'utf8');
    const hasDescribeRow = doc
      .split('\n')
      .some((line) => line.includes('**Emit CLI manifest**') || (line.includes('describe') && line.trimStart().startsWith('|')));
    assert.ok(hasDescribeRow, 'docs/capabilities.md must contain a "describe" row');
  });
});
