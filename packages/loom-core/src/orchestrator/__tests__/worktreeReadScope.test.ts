// Tests for story-067-003: WorktreeReadScope settings.json materializer.
//
// Integration: writes real files to a temp directory and asserts on-disk shape.

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { materializeWorktreeReadScope } from '../WorktreeReadScope.js';

const FAKE_LOOM_SCRIPT = '/usr/local/lib/node_modules/loom/dist/index.js';

interface SettingsJson {
  hooks?: {
    PreToolUse?: Array<{
      matcher: string;
      hooks: Array<{ type: string; command: string }>;
    }>;
  };
  permissions?: {
    allow?: string[];
    deny?: string[];
  };
}

let tmpDir: string;
let worktreePath: string;
let readRoot: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'loom-worktree-read-scope-'));
  worktreePath = path.join(tmpDir, 'worktree');
  readRoot = path.join(tmpDir, 'repo-root');
  fs.mkdirSync(worktreePath, { recursive: true });
  fs.mkdirSync(readRoot, { recursive: true });
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('materializeWorktreeReadScope — file creation', () => {
  it('writes .claude/settings.json to <worktreePath>', () => {
    const { settingsPath } = materializeWorktreeReadScope({
      worktreePath,
      readRoot,
      loomScriptPath: FAKE_LOOM_SCRIPT,
    });
    assert.ok(fs.existsSync(settingsPath), 'settings.json should be created');
    assert.equal(settingsPath, path.join(worktreePath, '.claude', 'settings.json'));
  });

  it('returns the absolute settingsPath', () => {
    const { settingsPath } = materializeWorktreeReadScope({
      worktreePath,
      readRoot,
      loomScriptPath: FAKE_LOOM_SCRIPT,
    });
    assert.ok(path.isAbsolute(settingsPath));
  });
});

describe('materializeWorktreeReadScope — whole-file overwrite', () => {
  it('replaces a pre-existing settings.json completely', () => {
    const claudeDir = path.join(worktreePath, '.claude');
    fs.mkdirSync(claudeDir, { recursive: true });
    const settingsPath = path.join(claudeDir, 'settings.json');
    // Write pre-existing content that should NOT survive
    fs.writeFileSync(settingsPath, JSON.stringify({ someOtherKey: 'old-value' }, null, 2));

    materializeWorktreeReadScope({ worktreePath, readRoot, loomScriptPath: FAKE_LOOM_SCRIPT });

    const written = JSON.parse(fs.readFileSync(settingsPath, 'utf8')) as SettingsJson;
    assert.ok(!('someOtherKey' in written), 'pre-existing key should not survive overwrite');
    assert.ok(written.hooks?.PreToolUse, 'new hooks should be present');
  });
});

describe('materializeWorktreeReadScope — PreToolUse hook shape', () => {
  it('sets hook matcher to "Read|Grep|Glob|Bash"', () => {
    materializeWorktreeReadScope({ worktreePath, readRoot, loomScriptPath: FAKE_LOOM_SCRIPT });
    const settingsPath = path.join(worktreePath, '.claude', 'settings.json');
    const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8')) as SettingsJson;
    const hooks = settings.hooks?.PreToolUse;
    assert.ok(Array.isArray(hooks) && hooks.length === 1, 'should have exactly one PreToolUse entry');
    assert.equal(hooks![0].matcher, 'Read|Grep|Glob|Bash');
  });

  it('hook command is `node "<loomScriptPath>" guard hook`', () => {
    materializeWorktreeReadScope({ worktreePath, readRoot, loomScriptPath: FAKE_LOOM_SCRIPT });
    const settingsPath = path.join(worktreePath, '.claude', 'settings.json');
    const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8')) as SettingsJson;
    const hookEntry = settings.hooks?.PreToolUse?.[0];
    assert.ok(hookEntry, 'hook entry should exist');
    assert.equal(hookEntry.hooks.length, 1);
    assert.equal(hookEntry.hooks[0].type, 'command');
    assert.equal(hookEntry.hooks[0].command, `node "${FAKE_LOOM_SCRIPT}" guard hook`);
  });
});

describe('materializeWorktreeReadScope — permissions allow globs (defense-in-depth)', () => {
  // Workers run --permission-mode bypassPermissions so the permissions block
  // is advisory (defense-in-depth). The hook is the real load-bearing control.
  // We assert the globs exist and cover in-repo paths, but they are not
  // security-critical on their own.

  it('permissions.allow includes a Read glob for the worktree path', () => {
    materializeWorktreeReadScope({ worktreePath, readRoot, loomScriptPath: FAKE_LOOM_SCRIPT });
    const settingsPath = path.join(worktreePath, '.claude', 'settings.json');
    const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8')) as SettingsJson;
    const allow = settings.permissions?.allow ?? [];
    const hasWorktreeRead = allow.some(g => g.includes('Read(') && g.includes(worktreePath));
    assert.ok(hasWorktreeRead, 'allow should contain a Read glob for the worktree');
  });

  it('permissions.allow includes a Read glob for the readRoot path', () => {
    materializeWorktreeReadScope({ worktreePath, readRoot, loomScriptPath: FAKE_LOOM_SCRIPT });
    const settingsPath = path.join(worktreePath, '.claude', 'settings.json');
    const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8')) as SettingsJson;
    const allow = settings.permissions?.allow ?? [];
    const hasReadRootGlob = allow.some(g => g.includes('Read(') && g.includes(readRoot));
    assert.ok(hasReadRootGlob, 'allow should contain a Read glob for readRoot');
  });

  it('permissions.allow covers an absolute in-repo path via worktree glob', () => {
    materializeWorktreeReadScope({ worktreePath, readRoot, loomScriptPath: FAKE_LOOM_SCRIPT });
    const settingsPath = path.join(worktreePath, '.claude', 'settings.json');
    const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8')) as SettingsJson;
    const allow = settings.permissions?.allow ?? [];
    // An in-repo file should match one of the allow globs
    const inRepoFile = path.join(worktreePath, 'src', 'index.ts');
    const covered = allow.some(g => {
      // Glob is of the form Read(//<prefix>/**) — check the prefix matches
      const match = g.match(/^Read\(\/\/(.+?)\*\*\)$/);
      if (!match) return false;
      return inRepoFile.startsWith(match[1]);
    });
    assert.ok(covered, 'an absolute in-repo path should be covered by an allow glob');
  });
});

describe('materializeWorktreeReadScope — permissions deny globs (defense-in-depth)', () => {
  it('permissions.deny contains the //** backstop', () => {
    materializeWorktreeReadScope({ worktreePath, readRoot, loomScriptPath: FAKE_LOOM_SCRIPT });
    const settingsPath = path.join(worktreePath, '.claude', 'settings.json');
    const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8')) as SettingsJson;
    const deny = settings.permissions?.deny ?? [];
    assert.ok(deny.some(g => g === 'Read(//**)'), 'deny should include Read(//**)');
  });

  it('permissions.deny contains the ~/** backstop', () => {
    materializeWorktreeReadScope({ worktreePath, readRoot, loomScriptPath: FAKE_LOOM_SCRIPT });
    const settingsPath = path.join(worktreePath, '.claude', 'settings.json');
    const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8')) as SettingsJson;
    const deny = settings.permissions?.deny ?? [];
    assert.ok(deny.some(g => g === 'Read(~/**)'), 'deny should include Read(~/**)');
  });
});

describe('materializeWorktreeReadScope — idempotency', () => {
  it('calling twice produces the same output (idempotent)', () => {
    materializeWorktreeReadScope({ worktreePath, readRoot, loomScriptPath: FAKE_LOOM_SCRIPT });
    const settingsPath = path.join(worktreePath, '.claude', 'settings.json');
    const first = fs.readFileSync(settingsPath, 'utf8');

    materializeWorktreeReadScope({ worktreePath, readRoot, loomScriptPath: FAKE_LOOM_SCRIPT });
    const second = fs.readFileSync(settingsPath, 'utf8');
    assert.equal(first, second, 'two calls should produce identical output');
  });
});
