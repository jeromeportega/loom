import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ClaudeCodeWorker, mcpConfigPath } from '../orchestrator/ClaudeCodeWorker.js';
import { CursorAgentWorker } from '../orchestrator/CursorAgentWorker.js';
import type { WorkerAssignment } from '../orchestrator/WorkerRunner.js';
import type { Story } from '../types.js';

/**
 * Exposes the protected `agentArgs(assignment)` seam so we can assert the
 * spawn-arg construction without spinning up a real `claude` subprocess.
 * agentArgs is pure arg construction (it only stats the worktree config
 * file), so unit coverage is sufficient — no process spawn needed.
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
class TestableClaude extends ClaudeCodeWorker {
  exposeAgentArgs(assignment: WorkerAssignment): string[] {
    return (this as any).agentArgs(assignment);
  }
}

class TestableCursor extends CursorAgentWorker {
  exposeAgentArgs(assignment: WorkerAssignment): string[] {
    return (this as any).agentArgs(assignment);
  }
}
/* eslint-enable @typescript-eslint/no-explicit-any */

const STORY: Story = {
  id: 'story-002-003',
  title: 'spawn workers with strict MCP config flags',
  description: '',
  acceptance_criteria: ['n/a'],
  estimated_complexity: 'small',
  dependencies: [],
};

function assignmentFor(worktreePath: string): WorkerAssignment {
  return {
    storyId: STORY.id,
    epicId: 'epic-002',
    story: STORY,
    worktreePath,
    branchName: `story/${STORY.id}`,
    baseSha: '',
    projectRoot: worktreePath,
    skills: [],
  };
}

describe('ClaudeCodeWorker.agentArgs — strict MCP config flags', () => {
  let worktree: string;

  beforeEach(() => {
    worktree = fs.mkdtempSync(path.join(os.tmpdir(), 'loom-claude-args-'));
  });

  afterEach(() => {
    fs.rmSync(worktree, { recursive: true, force: true });
  });

  it('appends --strict-mcp-config --mcp-config <worktree>/.cursor/mcp.json when the generated config exists', () => {
    // Materialize the worktree config the way story-002-001 does.
    const configPath = path.join(worktree, '.cursor', 'mcp.json');
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    fs.writeFileSync(configPath, JSON.stringify({ mcpServers: {} }), 'utf8');

    const args = new TestableClaude().exposeAgentArgs(assignmentFor(worktree));

    // The flags must appear as a contiguous, correctly-ordered triple, and
    // the path must be exactly the path.join-derived absolute path.
    const strictIdx = args.indexOf('--strict-mcp-config');
    assert.notEqual(strictIdx, -1, 'expected --strict-mcp-config in args');
    assert.deepEqual(
      args.slice(strictIdx, strictIdx + 3),
      ['--strict-mcp-config', '--mcp-config', path.join(worktree, '.cursor', 'mcp.json')]
    );
  });

  it('omits both flags when the generated config is absent', () => {
    const args = new TestableClaude().exposeAgentArgs(assignmentFor(worktree));
    assert.ok(!args.includes('--strict-mcp-config'), 'strict flag must not appear without config');
    assert.ok(!args.includes('--mcp-config'), 'mcp-config flag must not appear without config');
  });

  it('preserves the baseline claude args unchanged around the new flags', () => {
    // Capture the no-config baseline first.
    const baseline = new TestableClaude().exposeAgentArgs(assignmentFor(worktree));

    const configPath = mcpConfigPath(worktree);
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    fs.writeFileSync(configPath, '{}', 'utf8');

    const withConfig = new TestableClaude().exposeAgentArgs(assignmentFor(worktree));

    // The new flags are strictly appended — the leading args are untouched.
    assert.deepEqual(withConfig.slice(0, baseline.length), baseline);
    assert.deepEqual(withConfig.slice(baseline.length), [
      '--strict-mcp-config',
      '--mcp-config',
      configPath,
    ]);
  });

  it('honors a custom claudeArgs base when appending the flags', () => {
    const configPath = mcpConfigPath(worktree);
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    fs.writeFileSync(configPath, '{}', 'utf8');

    const worker = new TestableClaude({ claudeArgs: ['-p', '--verbose'] });
    const args = worker.exposeAgentArgs(assignmentFor(worktree));
    assert.deepEqual(args, ['-p', '--verbose', '--strict-mcp-config', '--mcp-config', configPath]);
  });
});

describe('mcpConfigPath — single-source path convention', () => {
  it('derives <worktree>/.cursor/mcp.json', () => {
    assert.equal(
      mcpConfigPath('/some/worktree'),
      path.join('/some/worktree', '.cursor', 'mcp.json')
    );
  });
});

describe('CursorAgentWorker.agentArgs — signature-change regression guard', () => {
  it('accepts the assignment arg and returns its base args unchanged', () => {
    const worktree = fs.mkdtempSync(path.join(os.tmpdir(), 'loom-cursor-args-'));
    try {
      // Even with a worktree config present, cursor reads project config via
      // cwd — its args are independent of the assignment.
      const configPath = mcpConfigPath(worktree);
      fs.mkdirSync(path.dirname(configPath), { recursive: true });
      fs.writeFileSync(configPath, '{}', 'utf8');

      const args = new TestableCursor({ model: 'sonnet-4' }).exposeAgentArgs(assignmentFor(worktree));
      // epic-004 switched cursor-agent to streamed output; the guard's intent
      // is unchanged — the assignment arg must not alter cursor's args.
      assert.deepEqual(args, [
        '-p',
        '--model',
        'sonnet-4',
        '--force',
        '--trust',
        '--output-format',
        'stream-json',
        '--stream-partial-output',
      ]);
      assert.ok(!args.includes('--strict-mcp-config'));
    } finally {
      fs.rmSync(worktree, { recursive: true, force: true });
    }
  });
});
