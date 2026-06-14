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

  it('creates .loom/loom.db', () => {
    assert.ok(fs.existsSync(path.join(tmpDir, '.loom', 'loom.db')));
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

  it('creates .cursor/mcp.json with --cursor flag', () => {
    loom('init', '--cursor');
    const mcpPath = path.join(tmpDir, '.cursor', 'mcp.json');
    assert.ok(fs.existsSync(mcpPath));
    const mcp = JSON.parse(fs.readFileSync(mcpPath, 'utf8')) as {
      mcpServers?: { loom?: unknown };
    };
    assert.ok(mcp.mcpServers?.loom);
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

  it('writes .mcp.json only with the --mcp flag (opt-in; CLI is the primary surface)', () => {
    // Default init no longer writes .mcp.json — the MCP server is opt-in.
    assert.ok(
      !fs.existsSync(path.join(tmpDir, '.mcp.json')),
      'default `loom init` must NOT write .mcp.json'
    );
    // Opting in writes it, wired to the loom MCP server.
    loom('init', '--mcp');
    const mcp = JSON.parse(
      fs.readFileSync(path.join(tmpDir, '.mcp.json'), 'utf8')
    ) as { mcpServers: { loom?: { command: string; args: string[] } } };
    assert.ok(mcp.mcpServers.loom);
    assert.equal(mcp.mcpServers.loom.command, 'node');
    assert.ok(mcp.mcpServers.loom.args.includes('serve'));
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

  it('exits 0 for non-Bash tool calls (e.g., Read, Edit)', () => {
    const result = runHookWithJson({
      hook_event_name: 'PreToolUse',
      tool_name: 'Read',
      tool_input: { file_path: '/tmp/something' },
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
