import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { resolveLoomHomePath } from '../../src/home/resolveLoomHomePath.js';
import { PolicySchema } from '../../src/types.js';

// ── resolveLoomHomePath unit tests ─────────────────────────────────────────

describe('resolveLoomHomePath — default sibling resolution', () => {
  it('returns parent-dir/loom-home when no override is set', () => {
    const result = resolveLoomHomePath('/home/u/repos/app', {});
    assert.equal(result, '/home/u/repos/loom-home');
  });

  it('result equals path.dirname(projectRoot) + /loom-home', () => {
    const projectRoot = '/home/u/repos/app';
    const result = resolveLoomHomePath(projectRoot, {});
    assert.equal(result, path.join(path.dirname(projectRoot), 'loom-home'));
  });

  it('default result is always absolute', () => {
    const result = resolveLoomHomePath('/some/deep/project', {});
    assert.ok(path.isAbsolute(result), `expected absolute path, got: ${result}`);
  });
});

describe('resolveLoomHomePath — absolute override', () => {
  it('returns the override path verbatim when it is absolute', () => {
    const result = resolveLoomHomePath('/home/u/repos/app', {
      loom_home: '/srv/control/loom-home',
    });
    assert.equal(result, '/srv/control/loom-home');
  });

  it('override result is always absolute', () => {
    const result = resolveLoomHomePath('/any/project', {
      loom_home: '/absolute/loom-home',
    });
    assert.ok(path.isAbsolute(result), `expected absolute path, got: ${result}`);
  });
});

describe('resolveLoomHomePath — tilde override', () => {
  it('expands ~ to os.homedir()', () => {
    const result = resolveLoomHomePath('/any/project', {
      loom_home: '~/workspaces/cp/loom-home',
    });
    assert.ok(!result.includes('~'), `result must not contain ~, got: ${result}`);
    assert.ok(
      result.startsWith(os.homedir()),
      `expected result to start with homedir (${os.homedir()}), got: ${result}`,
    );
    assert.equal(result, path.join(os.homedir(), 'workspaces/cp/loom-home'));
  });

  it('tilde result is always absolute', () => {
    const result = resolveLoomHomePath('/any/project', {
      loom_home: '~/loom-home',
    });
    assert.ok(path.isAbsolute(result), `expected absolute path, got: ${result}`);
    assert.ok(!result.includes('~'));
  });
});

// ── PolicySchema tests ─────────────────────────────────────────────────────

describe('PolicySchema — loom_home field', () => {
  it('parses {} successfully with loom_home undefined (no field required)', () => {
    const p = PolicySchema.parse({});
    assert.equal(p.loom_home, undefined);
  });

  it('parses {loom_home: "/x"} successfully', () => {
    const p = PolicySchema.parse({ loom_home: '/x' });
    assert.equal(p.loom_home, '/x');
  });

  it('parses {loom_home: "~/foo"} successfully', () => {
    const p = PolicySchema.parse({ loom_home: '~/foo' });
    assert.equal(p.loom_home, '~/foo');
  });
});
