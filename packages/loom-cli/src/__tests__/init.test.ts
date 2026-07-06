import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// __dirname = packages/loom-cli/dist/__tests__
// CLI entry = packages/loom-cli/dist/index.js
const LOOM_CLI = path.resolve(__dirname, '../index.js');

let tmpDir: string;

function loom(...args: string[]): { stdout: string; stderr: string; status: number } {
  return loomCmd(args.join(' '));
}

function loomCmd(cmdSuffix: string): { stdout: string; stderr: string; status: number } {
  try {
    const stdout = execSync(`node "${LOOM_CLI}" ${cmdSuffix}`, {
      cwd: tmpDir,
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
      // Keep the project registry out of the developer's real ~/.loom.
      env: { ...process.env, LOOM_HOME: path.join(tmpDir, '.loom-home') },
    });
    return { stdout, stderr: '', status: 0 };
  } catch (err: unknown) {
    const e = err as { stdout?: string; stderr?: string; status?: number };
    return { stdout: e.stdout ?? '', stderr: e.stderr ?? '', status: e.status ?? 1 };
  }
}

before(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'loom-init-test-'));
  execSync('git init -q', { cwd: tmpDir });
});

after(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('loom init', () => {
  it('creates .loom/policy.yaml', () => {
    loom('init');
    assert.ok(fs.existsSync(path.join(tmpDir, '.loom', 'policy.yaml')));
  });

  it('does NOT create .loom/loom.db (DB is now at loom-home)', () => {
    assert.ok(!fs.existsSync(path.join(tmpDir, '.loom', 'loom.db')));
  });

  it('creates .loom/worktrees/ directory', () => {
    assert.ok(fs.existsSync(path.join(tmpDir, '.loom', 'worktrees')));
  });

  it('writes PreToolUse hook to .claude/settings.json', () => {
    const settingsPath = path.join(tmpDir, '.claude', 'settings.json');
    assert.ok(fs.existsSync(settingsPath));
    const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8')) as {
      hooks?: { PreToolUse?: unknown[] };
    };
    assert.ok(Array.isArray(settings.hooks?.PreToolUse));
    assert.equal(settings.hooks!.PreToolUse!.length, 1);
    const hook = settings.hooks!.PreToolUse![0] as { matcher: string };
    assert.equal(hook.matcher, 'Bash');
  });

  it('is idempotent — second run skips existing files', () => {
    const result = loom('init');
    assert.ok(result.stdout.includes('skipped'));
    // Policy file should still be valid
    const policy = fs.readFileSync(path.join(tmpDir, '.loom', 'policy.yaml'), 'utf8');
    assert.ok(policy.includes('protected_branches'));
  });

  it('--cursor writes rules file only; does NOT create .cursor/mcp.json with a loom entry', () => {
    loom('init', '--cursor');
    // The rules file is still written for Cursor IDE integration
    const rulesPath = path.join(tmpDir, '.cursor', 'rules', 'loom.mdc');
    assert.ok(fs.existsSync(rulesPath));
    // loom init no longer writes a loom-server entry to .cursor/mcp.json
    assert.ok(
      !fs.existsSync(path.join(tmpDir, '.cursor', 'mcp.json')),
      '--cursor must NOT create .cursor/mcp.json anymore'
    );
  });

  it('creates .cursor/rules/loom.mdc with --cursor flag', () => {
    const rulesPath = path.join(tmpDir, '.cursor', 'rules', 'loom.mdc');
    assert.ok(fs.existsSync(rulesPath));
    const content = fs.readFileSync(rulesPath, 'utf8');
    assert.ok(content.includes('loom_policy_check'));
  });

  it('writes the PreToolUse hook with an absolute loom path (no PATH dependency)', () => {
    const settingsPath = path.join(tmpDir, '.claude', 'settings.json');
    const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8')) as {
      hooks: { PreToolUse: Array<{ matcher: string; hooks: Array<{ command: string }> }> };
    };
    const cmd = settings.hooks.PreToolUse[0].hooks[0].command;
    assert.ok(cmd.includes('guard hook'));
    assert.ok(cmd.includes('index.js'), 'hook should reference the loom script by path');
    assert.ok(cmd.startsWith('node '), 'hook should invoke node directly');
  });

  it('--mcp flag is removed — exits non-zero as unknown option', () => {
    // The loom-server MCP entry generator is gone; --mcp is no longer a valid flag.
    const result = loom('init', '--mcp');
    assert.notEqual(result.status, 0, '--mcp should be an unknown option');
    assert.ok(
      !fs.existsSync(path.join(tmpDir, '.mcp.json')),
      '.mcp.json must NOT be created'
    );
  });

  it('plain loom init never creates .mcp.json', () => {
    loom('init');
    assert.ok(
      !fs.existsSync(path.join(tmpDir, '.mcp.json')),
      'plain `loom init` must NOT write .mcp.json'
    );
  });

  it('writes a CLAUDE.md describing the loom workflow', () => {
    const content = fs.readFileSync(path.join(tmpDir, 'CLAUDE.md'), 'utf8');
    assert.ok(content.includes('loom epic'));
    assert.ok(content.includes('Guardrails'));
  });

  it('writes the loom slash-command skills', () => {
    for (const name of ['loom-epic', 'loom-status', 'loom-approve']) {
      const skill = path.join(tmpDir, '.claude', 'skills', name, 'SKILL.md');
      assert.ok(fs.existsSync(skill), `${name} skill should exist`);
      const content = fs.readFileSync(skill, 'utf8');
      assert.ok(content.includes(`name: ${name}`));
    }
  });

  it('installs the UX-designer slash command (the other bundled skills are auto-discovered)', () => {
    const ux = path.join(tmpDir, '.claude', 'skills', 'loom-ux-designer', 'SKILL.md');
    assert.ok(fs.existsSync(ux), 'loom-ux-designer slash command should be installed');
    const content = fs.readFileSync(ux, 'utf8');
    assert.ok(content.includes('name: loom-ux-designer'));
    assert.ok(!/bmad/i.test(content), 'bundled skill must not reference bmad');

    // The other bundled skills are NOT installed as slash commands — the
    // SkillStore discovers them directly from @loom-ai/core's bundled dir.
    for (const name of ['loom-code-review', 'loom-plan-review', 'loom-edge-case-review']) {
      const skillPath = path.join(tmpDir, '.claude', 'skills', name, 'SKILL.md');
      assert.equal(fs.existsSync(skillPath), false, `${name} should not be a slash command`);
    }
  });

  it('writes a loom-managed gitignore block with the noisy artifacts ignored', () => {
    const content = fs.readFileSync(path.join(tmpDir, '.gitignore'), 'utf8');
    assert.match(content, /# >>> loom-managed/);
    assert.match(content, /# <<< loom-managed/);
    // The noisy generated outputs the user complained about.
    assert.match(content, /\.loom\/planning\//);
    // Research decision docs are tracked by default — they are team decisions,
    // not noise — so the managed block must NOT ignore them.
    const managedBlock = content.match(/# >>> loom-managed[\s\S]*?# <<< loom-managed/)?.[0] ?? '';
    assert.doesNotMatch(managedBlock, /\.loom\/research\//);
    // Per-machine integration files.
    assert.match(content, /\.claude\/settings\.json/);
    assert.match(content, /\.claude\/skills\/loom-\*\//);
    assert.match(content, /\.mcp\.json/);
    // Local-only state.
    assert.match(content, /\.loom\/loom\.db\*/);
    assert.match(content, /\.loom\/worktrees\//);
    // Worker scratch — keeps probes/investigation out of the PR diff
    // (paired with the worker.md prompt directing scratch here).
    assert.match(content, /\.loom\/scratch\//);
    // The team-shared policy is NOT inside the managed block (so it stays tracked).
    const block = content.match(/# >>> loom-managed[\s\S]*?# <<< loom-managed/);
    assert.ok(block);
    assert.equal(block[0].includes('.loom/policy.yaml'), false);
  });

  it('regenerating init keeps the loom gitignore block at the same place', () => {
    const before = fs.readFileSync(path.join(tmpDir, '.gitignore'), 'utf8');
    const beginCount = (before.match(/# >>> loom-managed/g) ?? []).length;
    assert.equal(beginCount, 1);
    // A second init should NOT duplicate the block.
    loom('init');
    const after = fs.readFileSync(path.join(tmpDir, '.gitignore'), 'utf8');
    const afterBeginCount = (after.match(/# >>> loom-managed/g) ?? []).length;
    assert.equal(afterBeginCount, 1, 'loom init should not duplicate the block');
  });

  it('does not overwrite an existing CLAUDE.md', () => {
    fs.writeFileSync(path.join(tmpDir, 'CLAUDE.md'), '# my own claude.md\n');
    loom('init');
    assert.equal(
      fs.readFileSync(path.join(tmpDir, 'CLAUDE.md'), 'utf8'),
      '# my own claude.md\n'
    );
  });
});

describe('loom guard hook (Claude Code stdin JSON protocol)', () => {
  function runHookWithJson(payload: object): { stdout: string; stderr: string; status: number } {
    try {
      const stdout = execSync(`node "${LOOM_CLI}" guard hook`, {
        cwd: tmpDir,
        encoding: 'utf8',
        input: JSON.stringify(payload),
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      return { stdout, stderr: '', status: 0 };
    } catch (err: unknown) {
      const e = err as { stdout?: string; stderr?: string; status?: number };
      return { stdout: e.stdout ?? '', stderr: e.stderr ?? '', status: e.status ?? 1 };
    }
  }

  it('exits 0 for allowed Bash command', () => {
    const result = runHookWithJson({
      hook_event_name: 'PreToolUse',
      tool_name: 'Bash',
      tool_input: { command: 'git add .' },
    });
    assert.equal(result.status, 0);
  });

  it('exits 2 (block with feedback) for git push --force', () => {
    const result = runHookWithJson({
      hook_event_name: 'PreToolUse',
      tool_name: 'Bash',
      tool_input: { command: 'git push --force' },
    });
    assert.equal(result.status, 2);
    assert.ok(result.stderr.includes('loom blocked'));
    assert.ok(result.stderr.includes('git.forbidden_flags'));
  });

  it('exits 2 for rm -rf ~/.ssh', () => {
    const result = runHookWithJson({
      hook_event_name: 'PreToolUse',
      tool_name: 'Bash',
      tool_input: { command: 'rm -rf ~/.ssh' },
    });
    assert.equal(result.status, 2);
    assert.ok(result.stderr.includes('filesystem.protected_paths'));
  });

  it('exits 2 for chained command bypass attempt', () => {
    const result = runHookWithJson({
      hook_event_name: 'PreToolUse',
      tool_name: 'Bash',
      tool_input: { command: 'git status; git push --force' },
    });
    assert.equal(result.status, 2);
    assert.ok(result.stderr.includes('shell.metacharacters'));
  });

  it('exits 2 for bash -c wrapper bypass attempt', () => {
    const result = runHookWithJson({
      hook_event_name: 'PreToolUse',
      tool_name: 'Bash',
      tool_input: { command: 'bash -c "git push --force"' },
    });
    assert.equal(result.status, 2);
    assert.ok(result.stderr.includes('shell.wrapper_program'));
  });

  it('exits 0 for Read of an in-scope file (worktree path allowed)', () => {
    // Read/Grep/Glob are now intercepted by checkReadScope — an in-scope path
    // (under the worktree root) must exit 0 so legitimate reads run prompt-free.
    // Use fs.realpathSync to match the path the subprocess's process.cwd() returns
    // (important on macOS where /tmp is a symlink to /private/var/folders/...).
    const realTmpDir = fs.realpathSync(tmpDir);
    const result = runHookWithJson({
      hook_event_name: 'PreToolUse',
      tool_name: 'Read',
      tool_input: { file_path: path.join(realTmpDir, 'README.md') },
    });
    assert.equal(result.status, 0);
  });

  it('exits 0 for non-intercepted tool calls (e.g., Edit)', () => {
    // Edit/Write/other non-Read tools are not intercepted by read-scope checks.
    const result = runHookWithJson({
      hook_event_name: 'PreToolUse',
      tool_name: 'Edit',
      tool_input: { file_path: '/etc/passwd', old_string: 'root', new_string: 'hack' },
    });
    assert.equal(result.status, 0);
  });

  it('exits 0 for malformed JSON (fails open to avoid breaking unrelated hooks)', () => {
    try {
      const stdout = execSync(`node "${LOOM_CLI}" guard hook`, {
        cwd: tmpDir,
        encoding: 'utf8',
        input: 'not json at all',
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      assert.ok(typeof stdout === 'string');
    } catch (err) {
      const e = err as { status?: number };
      assert.fail(`expected exit 0, got ${e.status}`);
    }
  });
});

describe('loom guard check', () => {
  it('exits 1 and writes JSON for git push --force', () => {
    const result = loomCmd('guard check --command "git push --force"');
    assert.equal(result.status, 1);
    const msg = JSON.parse(result.stderr.trim());
    assert.equal(msg.loom_guard, 'blocked');
    assert.equal(msg.rule, 'git.forbidden_flags');
  });

  it('exits 1 for rm -rf ~/.ssh', () => {
    const result = loomCmd('guard check --command "rm -rf ~/.ssh"');
    assert.equal(result.status, 1);
    const msg = JSON.parse(result.stderr.trim());
    assert.equal(msg.loom_guard, 'blocked');
    assert.equal(msg.rule, 'filesystem.protected_paths');
  });

  it('exits 0 for git add .', () => {
    const result = loomCmd('guard check --command "git add ."');
    assert.equal(result.status, 0);
  });

  it('exits 0 for npm install', () => {
    const result = loomCmd('guard check --command "npm install"');
    assert.equal(result.status, 0);
  });
});

// ─── Retain regression: loom mcp add/list ────────────────────────────────────
// These tests verify the third-party worker-provisioning subsystem remains
// intact after the loom-server mcpConfig generator is removed.
describe('loom mcp retain regression', () => {
  it('loom mcp list exits 0 and reports unconfigured registry (policy.mcp.registry unset)', () => {
    const result = loom('mcp', 'list');
    assert.equal(result.status, 0);
    assert.ok(result.stdout.includes('No MCP registry configured'));
  });

  it('loom mcp list shows servers when policy.mcp.registry points at a valid registry', () => {
    const registryDir = fs.mkdtempSync(path.join(os.tmpdir(), 'loom-reg-'));
    try {
      const serverDir = path.join(registryDir, 'servers', 'test-server');
      fs.mkdirSync(serverDir, { recursive: true });
      fs.writeFileSync(path.join(serverDir, 'server.json'), JSON.stringify({
        name: 'test-server',
        description: 'A test MCP server',
        packages: [{
          registry_type: 'npm',
          identifier: '@test/mcp',
          version: '1.0.0',
          transport: { type: 'stdio' },
          environment_variables: [],
        }],
      }));

      const policyPath = path.join(tmpDir, '.loom', 'policy.yaml');
      const policy = fs.readFileSync(policyPath, 'utf8');
      fs.writeFileSync(policyPath, policy.replace('registry: ""', `registry: "${registryDir}"`));

      const result = loom('mcp', 'list');
      assert.equal(result.status, 0);
      assert.ok(result.stdout.includes('test-server'));

      // Restore policy after test
      fs.writeFileSync(policyPath, policy);
    } finally {
      fs.rmSync(registryDir, { recursive: true, force: true });
    }
  });

  it('loom mcp add writes the server entry to .mcp.json and .cursor/mcp.json', () => {
    const registryDir = fs.mkdtempSync(path.join(os.tmpdir(), 'loom-reg-'));
    try {
      const serverDir = path.join(registryDir, 'servers', 'my-server');
      fs.mkdirSync(serverDir, { recursive: true });
      fs.writeFileSync(path.join(serverDir, 'server.json'), JSON.stringify({
        name: 'my-server',
        description: 'Test provisioning server',
        packages: [{
          registry_type: 'npm',
          identifier: '@test/my-server',
          version: '2.0.0',
          transport: { type: 'stdio' },
          environment_variables: [],
        }],
      }));

      const policyPath = path.join(tmpDir, '.loom', 'policy.yaml');
      const policy = fs.readFileSync(policyPath, 'utf8');
      fs.writeFileSync(policyPath, policy.replace('registry: ""', `registry: "${registryDir}"`));

      const result = loom('mcp', 'add', 'my-server');
      assert.equal(result.status, 0, `loom mcp add should exit 0; stderr: ${result.stderr}`);

      // .mcp.json must contain the server entry (no loom server — provisioning only)
      const mcpJson = JSON.parse(
        fs.readFileSync(path.join(tmpDir, '.mcp.json'), 'utf8')
      ) as { mcpServers: Record<string, unknown> };
      assert.ok(mcpJson.mcpServers['my-server'], 'third-party server must appear in .mcp.json');
      assert.equal(mcpJson.mcpServers['loom'], undefined, 'loom self-server must NOT be added by mcp add');

      // .cursor/mcp.json must also contain it
      const cursorJson = JSON.parse(
        fs.readFileSync(path.join(tmpDir, '.cursor', 'mcp.json'), 'utf8')
      ) as { mcpServers: Record<string, unknown> };
      assert.ok(cursorJson.mcpServers['my-server'], 'third-party server must appear in .cursor/mcp.json');

      // Restore policy after test
      fs.writeFileSync(policyPath, policy);
    } finally {
      fs.rmSync(registryDir, { recursive: true, force: true });
    }
  });
});
