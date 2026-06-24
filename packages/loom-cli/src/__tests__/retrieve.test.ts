/**
 * Thin smoke tests for `loom retrieve` CLI (story-057-005).
 *
 * Tests that:
 *  1. The retrieve search/read specs validate against CommandDescriptionSchema.
 *  2. The commands are registered in buildProgram().
 *  3. Missing required flags cause a non-zero exit.
 *
 * The real contract is the RetrievalService API — see
 * packages/loom-core/test/retrieval/RetrievalService.test.ts for the
 * end-to-end integration tests. This file keeps the CLI surface thin.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { CommandDescriptionSchema } from '../describe/schema.js';
import { specSearch, specRead, runRetrieveSearch, runRetrieveRead } from '../commands/retrieve.js';
import { enumerateRegisteredCommands } from '../describe/registry.js';
import { buildProgram } from '../index.js';

// ── Spec validation ───────────────────────────────────────────────────────────

describe('retrieve CLI — spec validation', () => {
  it('specSearch validates against CommandDescriptionSchema', () => {
    assert.doesNotThrow(
      () => CommandDescriptionSchema.parse(specSearch),
      'specSearch must be a valid CommandDescription',
    );
  });

  it('specRead validates against CommandDescriptionSchema', () => {
    assert.doesNotThrow(
      () => CommandDescriptionSchema.parse(specRead),
      'specRead must be a valid CommandDescription',
    );
  });

  it('specSearch.name is "retrieve search"', () => {
    assert.equal(specSearch.name, 'retrieve search');
  });

  it('specRead.name is "retrieve read"', () => {
    assert.equal(specRead.name, 'retrieve read');
  });
});

// ── Registration in buildProgram() ────────────────────────────────────────────

describe('retrieve CLI — buildProgram registration', () => {
  it('"retrieve search" is registered in the live command tree', () => {
    const cmds = enumerateRegisteredCommands(buildProgram());
    assert.ok(cmds.includes('retrieve search'), `expected "retrieve search" in ${cmds.join(', ')}`);
  });

  it('"retrieve read" is registered in the live command tree', () => {
    const cmds = enumerateRegisteredCommands(buildProgram());
    assert.ok(cmds.includes('retrieve read'), `expected "retrieve read" in ${cmds.join(', ')}`);
  });
});

// ── Missing-flag behavior: exits non-zero ─────────────────────────────────────

interface Captured { errors: string[]; exitCode: number | null }

async function capture(fn: () => Promise<void>): Promise<Captured> {
  const origExit = process.exit as (code?: number) => never;
  const origErr = console.error;
  const origStderr = process.stderr.write.bind(process.stderr);
  const errors: string[] = [];
  let exitCode: number | null = null;

  (process as NodeJS.Process & { exit: (code?: number) => never }).exit = (code?: number) => {
    exitCode = code ?? 0;
    throw new Error(`process.exit(${code})`);
  };
  console.error = (...args: unknown[]) => errors.push(args.map(String).join(' '));
  process.stderr.write = (chunk: unknown) => {
    errors.push(typeof chunk === 'string' ? chunk : String(chunk));
    return true;
  };

  try {
    await fn();
  } catch (e) {
    if (!(e instanceof Error && e.message.startsWith('process.exit'))) throw e;
  } finally {
    (process as NodeJS.Process & { exit: (code?: number) => never }).exit = origExit;
    console.error = origErr;
    process.stderr.write = origStderr;
  }
  return { errors, exitCode };
}

describe('retrieve CLI — non-zero exit on missing loom initialization', () => {
  it('runRetrieveSearch exits non-zero when loom is not initialized', async () => {
    // process.cwd() in this test context won't have a .loom/policy.yaml,
    // so the command should detect that and exit(1).
    const { exitCode } = await capture(async () => {
      await runRetrieveSearch({ repo: 'some-repo', query: 'anything' });
    });
    // Exit 1 = loom not initialized (or cross-repo refusal)
    assert.ok(exitCode !== null && exitCode !== 0, 'should exit non-zero when loom is not initialized');
  });

  it('runRetrieveRead exits non-zero when loom is not initialized', async () => {
    const { exitCode } = await capture(async () => {
      await runRetrieveRead({ repo: 'some-repo', path: 'any.ts' });
    });
    assert.ok(exitCode !== null && exitCode !== 0, 'should exit non-zero when loom is not initialized');
  });

  it('runRetrieveRead exits non-zero when --lines is malformed', async () => {
    // Can test parseLines validation without needing a real loom env
    // by passing an invalid lines value (the parse error happens before the fs check).
    // We pass a bad --lines; the command will exit(1) with a parse error.
    const { exitCode, errors } = await capture(async () => {
      await runRetrieveRead({ repo: 'some-repo', path: 'any.ts', lines: 'not-valid' });
    });
    assert.ok(exitCode !== null && exitCode !== 0, 'malformed --lines should exit non-zero');
    assert.ok(errors.some(e => e.includes('--lines')), `error message should mention --lines; got: ${errors.join(' | ')}`);
  });
});
