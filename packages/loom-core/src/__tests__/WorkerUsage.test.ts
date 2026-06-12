import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { ClaudeCodeWorker, renderToolCall } from '../orchestrator/ClaudeCodeWorker.js';

/**
 * Exercises the stream-json parser without spinning up the real claude CLI.
 * Casts to `any` (the parser is `protected`) so we can hit it directly.
 */
interface ParsedLine {
  humanText?: string;
  usage?: unknown;
  traces?: Array<{ kind: string; subject?: string; rationale: string }>;
}
function parseLine(line: string): ParsedLine {
  const worker = new ClaudeCodeWorker();
  return (worker as unknown as { parseStreamLine: (l: string) => ParsedLine }).parseStreamLine(line);
}

describe('ClaudeCodeWorker.parseStreamLine — stream-json (Epic 16 story-016-004)', () => {
  it('returns the final usage from a `type:"result"` event', () => {
    const line = JSON.stringify({
      type: 'result',
      subtype: 'success',
      is_error: false,
      result: 'OK',
      total_cost_usd: 0.0427,
      usage: {
        input_tokens: 100,
        output_tokens: 200,
        cache_read_input_tokens: 5000,
        cache_creation_input_tokens: 12000,
      },
    });
    const parsed = parseLine(line);
    assert.deepEqual(parsed.usage, {
      inputTokens: 100,
      outputTokens: 200,
      cacheReadTokens: 5000,
      cacheCreationTokens: 12000,
      totalTokens: 17300,
      costUsd: 0.0427,
      // v0.5.0: the final result event also attributes 1 LLM session/request
      // for per-request billing surfaces (cursor-cli org pricing).
      requestCount: 1,
    });
    assert.match(parsed.humanText ?? '', /OK/);
  });

  it('extracts assistant message text and interim usage from a `type:"assistant"` event', () => {
    const line = JSON.stringify({
      type: 'assistant',
      message: {
        content: [
          { type: 'text', text: 'Looking at the file…' },
          { type: 'tool_use', name: 'Bash', input: { command: 'ls' } },
        ],
        usage: {
          input_tokens: 9,
          output_tokens: 3,
          cache_read_input_tokens: 0,
          cache_creation_input_tokens: 42792,
        },
      },
    });
    const parsed = parseLine(line);
    assert.match(parsed.humanText ?? '', /Looking at the file/);
    assert.match(parsed.humanText ?? '', /\[Bash\] ls/);
    assert.deepEqual(parsed.usage, {
      inputTokens: 9,
      outputTokens: 3,
      cacheReadTokens: 0,
      cacheCreationTokens: 42792,
      totalTokens: 42804,
    });
  });

  it('summarizes the system init event with the model id', () => {
    const line = JSON.stringify({
      type: 'system',
      subtype: 'init',
      model: 'claude-sonnet-4-6',
    });
    const parsed = parseLine(line);
    assert.match(parsed.humanText ?? '', /claude-sonnet-4-6/);
    assert.equal(parsed.usage, undefined);
  });

  it('passes a non-JSON line through as humanText (defensive fallback)', () => {
    const parsed = parseLine('plain stderr-ish message');
    assert.equal(parsed.humanText, 'plain stderr-ish message');
    assert.equal(parsed.usage, undefined);
  });

  it('ignores silent event types (rate_limit_event, etc.)', () => {
    const line = JSON.stringify({ type: 'rate_limit_event', rate_limit_info: {} });
    const parsed = parseLine(line);
    assert.equal(parsed.humanText, undefined);
    assert.equal(parsed.usage, undefined);
  });

  it('captures thinking blocks as decision traces', () => {
    const line = JSON.stringify({
      type: 'assistant',
      message: {
        content: [
          {
            type: 'thinking',
            thinking: 'I need to find the file that defines the bug. Let me start by reading the auth module.',
          },
          { type: 'text', text: 'Reading the auth module now.' },
        ],
      },
    });
    const parsed = parseLine(line) as { traces?: Array<{ kind: string; rationale: string }> };
    assert.ok(parsed.traces, 'expected traces');
    assert.equal(parsed.traces!.length, 1);
    assert.equal(parsed.traces![0].kind, 'thinking');
    assert.match(parsed.traces![0].rationale, /find the file/);
  });

  it("emits a 'tool_intent' trace alongside a 'thinking' block when a tool follows", () => {
    const line = JSON.stringify({
      type: 'assistant',
      message: {
        content: [
          {
            type: 'thinking',
            thinking: 'I should grep for the function to locate its definition.',
          },
          { type: 'tool_use', name: 'Bash', input: { command: 'grep -rn auth' } },
        ],
      },
    });
    const parsed = parseLine(line) as { traces?: Array<{ kind: string; subject?: string; rationale: string }> };
    assert.equal(parsed.traces!.length, 2);
    assert.equal(parsed.traces![0].kind, 'thinking');
    assert.equal(parsed.traces![1].kind, 'tool_intent');
    assert.equal(parsed.traces![1].subject, 'Bash');
    assert.match(parsed.traces![1].rationale, /grep for the function/);
  });

  it('emits no traces when the assistant message has no thinking / tool_use blocks', () => {
    const line = JSON.stringify({
      type: 'assistant',
      message: { content: [{ type: 'text', text: 'Just a reply.' }] },
    });
    const parsed = parseLine(line);
    assert.equal(parsed.traces, undefined);
  });
});

describe('renderToolCall — per-tool human-readable summary', () => {
  it('Bash: surfaces description + command', () => {
    const out = renderToolCall('Bash', {
      command: 'grep -rn order_by django/db/',
      description: 'locate ordering parts',
    });
    assert.match(out, /^\[Bash\]/);
    assert.match(out, /locate ordering parts/);
    assert.match(out, /grep -rn order_by/);
  });

  it('Bash: without description still renders the command', () => {
    assert.equal(renderToolCall('Bash', { command: 'pytest tests/' }), '[Bash] pytest tests/');
  });

  it('Read: line range only when both offset+limit present', () => {
    assert.equal(
      renderToolCall('Read', { file_path: 'src/app.ts', offset: 100, limit: 50 }),
      '[Read] src/app.ts:100-150',
    );
    assert.equal(renderToolCall('Read', { file_path: 'src/app.ts' }), '[Read] src/app.ts');
  });

  it('Edit: flags replace_all', () => {
    assert.equal(renderToolCall('Edit', { file_path: 'src/app.ts' }), '[Edit] src/app.ts');
    assert.equal(
      renderToolCall('Edit', { file_path: 'src/app.ts', replace_all: true }),
      '[Edit] src/app.ts (replace_all)',
    );
  });

  it('MultiEdit: shows edit count with correct pluralization', () => {
    assert.equal(
      renderToolCall('MultiEdit', { file_path: 'src/app.ts', edits: [{}] }),
      '[MultiEdit] src/app.ts (1 edit)',
    );
    assert.equal(
      renderToolCall('MultiEdit', { file_path: 'src/app.ts', edits: [{}, {}, {}] }),
      '[MultiEdit] src/app.ts (3 edits)',
    );
  });

  it('Write: shows line count of the content', () => {
    assert.equal(
      renderToolCall('Write', { file_path: 'x.ts', content: 'one\ntwo\nthree\nfour' }),
      '[Write] x.ts (4 lines)',
    );
    assert.equal(renderToolCall('Write', { file_path: 'x.ts', content: '' }), '[Write] x.ts');
  });

  it('Grep: pattern + optional path', () => {
    assert.equal(
      renderToolCall('Grep', { pattern: 'order_by', path: 'django/db/' }),
      "[Grep] 'order_by' in django/db/",
    );
    assert.equal(renderToolCall('Grep', { pattern: 'order_by' }), "[Grep] 'order_by'");
  });

  it('Glob: pattern + optional path', () => {
    assert.equal(renderToolCall('Glob', { pattern: '**/*.py' }), '[Glob] **/*.py');
    assert.equal(
      renderToolCall('Glob', { pattern: '*.py', path: 'src/' }),
      '[Glob] *.py in src/',
    );
  });

  it('WebFetch + WebSearch: target rendering', () => {
    assert.equal(
      renderToolCall('WebFetch', { url: 'https://example.com/docs' }),
      '[WebFetch] https://example.com/docs',
    );
    assert.equal(
      renderToolCall('WebSearch', { query: 'django ordering bug' }),
      '[WebSearch] django ordering bug',
    );
  });

  it('Task: includes subagent_type when set', () => {
    assert.equal(
      renderToolCall('Task', { description: 'audit auth', subagent_type: 'Explore' }),
      '[Task Explore] audit auth',
    );
    assert.equal(
      renderToolCall('Task', { description: 'do the thing' }),
      '[Task] do the thing',
    );
  });

  it('TodoWrite + NotebookEdit + Skill + SlashCommand: per-tool shape', () => {
    assert.equal(renderToolCall('TodoWrite', { todos: [{}, {}] }), '[TodoWrite] 2 todos');
    assert.equal(renderToolCall('TodoWrite', { todos: [{}] }), '[TodoWrite] 1 todo');
    assert.equal(
      renderToolCall('NotebookEdit', { notebook_path: 'notes.ipynb' }),
      '[NotebookEdit] notes.ipynb',
    );
    assert.equal(
      renderToolCall('Skill', { skill: 'loom-code-review' }),
      '[Skill] loom-code-review',
    );
    assert.equal(
      renderToolCall('SlashCommand', { command: '/init' }),
      '[SlashCommand] /init',
    );
  });

  it('MCP tools render as [mcp <server/tool>] with a scalar hint when available', () => {
    assert.equal(
      renderToolCall('mcp__loom__loom_get_status', { epic_id: 'epic-001' }),
      '[mcp loom/loom_get_status] epic-001',
    );
    assert.equal(
      renderToolCall('mcp__jira__getTicketDetails', { ticket_id: 'PROJ-2867' }),
      '[mcp jira/getTicketDetails] PROJ-2867',
    );
    assert.equal(renderToolCall('mcp__loom__loom_get_status', {}), '[mcp loom/loom_get_status]');
  });

  it('Unknown tool falls back to [tool: name]', () => {
    assert.equal(renderToolCall('SomethingBrandNew', {}), '[tool: SomethingBrandNew]');
  });

  it('malformed input never throws', () => {
    assert.equal(renderToolCall('Bash', null), '[Bash] ');
    assert.equal(renderToolCall('Bash', undefined), '[Bash] ');
    assert.equal(renderToolCall('Read', { file_path: 42 }), '[Read] ?');
    assert.equal(renderToolCall('Write', { file_path: null, content: 5 }), '[Write] ?');
  });
});
