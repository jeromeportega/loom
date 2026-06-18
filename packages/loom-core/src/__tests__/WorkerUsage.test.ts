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
  /** Executed model id from the system/init event (epic-013). */
  model?: string;
}
function parseLine(line: string): ParsedLine {
  const worker = new ClaudeCodeWorker();
  return (worker as unknown as { parseStreamLine: (l: string) => ParsedLine }).parseStreamLine(line);
}
/** Parse a line on a REUSED worker instance (preserves streamUsageAccum across calls). */
function parseLineWith(worker: ClaudeCodeWorker, line: string): ParsedLine {
  return (worker as unknown as { parseStreamLine: (l: string) => ParsedLine }).parseStreamLine(line);
}

describe('ClaudeCodeWorker.parseStreamLine — stream-json (Epic 16 story-016-004)', () => {
  it('returns usage from a `type:"result"` event (single-turn: no prior assistant events)', () => {
    // When no assistant events preceded the result, fall back to result.usage
    // for token counts. num_turns drives requestCount (story-014-001 fix).
    const line = JSON.stringify({
      type: 'result',
      subtype: 'success',
      is_error: false,
      result: 'OK',
      total_cost_usd: 0.0427,
      num_turns: 1,
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
    // epic-013: executed model id is surfaced for agents.model attribution.
    assert.equal(parsed.model, 'claude-sonnet-4-6');
  });

  it('returns model: undefined for non-init system events', () => {
    const line = JSON.stringify({ type: 'system', subtype: 'other' });
    const parsed = parseLine(line);
    assert.equal(parsed.model, undefined);
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

/**
 * story-014-001: Verify that assistant-event usage is accumulated (not replaced)
 * and that result.usage (final-turn delta) is NOT the authoritative total.
 *
 * Root cause: assistant events carry per-turn deltas; applySessionUsage uses REPLACE
 * semantics (correct only when the value IS the running cumulative total). The fix
 * maintains streamUsageAccum in ClaudeCodeWorker so the running sum is always the
 * value passed to applySessionUsage.
 */
describe('ClaudeCodeWorker — stream-json usage harvest (story-014-001)', () => {
  function assistantLine(usage: {
    input_tokens: number;
    output_tokens: number;
    cache_read_input_tokens?: number;
    cache_creation_input_tokens?: number;
  }): string {
    return JSON.stringify({
      type: 'assistant',
      message: {
        content: [{ type: 'text', text: 'thinking…' }],
        usage,
      },
    });
  }

  function resultLine(opts: {
    result?: string;
    total_cost_usd?: number;
    num_turns?: number;
    usage?: {
      input_tokens: number;
      output_tokens: number;
      cache_read_input_tokens?: number;
      cache_creation_input_tokens?: number;
    };
  }): string {
    return JSON.stringify({
      type: 'result',
      result: opts.result ?? 'done',
      ...(opts.total_cost_usd !== undefined ? { total_cost_usd: opts.total_cost_usd } : {}),
      ...(opts.num_turns !== undefined ? { num_turns: opts.num_turns } : {}),
      ...(opts.usage !== undefined ? { usage: opts.usage } : {}),
    });
  }

  it('AC2+AC3: accumulates multi-turn assistant deltas — result total equals sum, NOT last delta', () => {
    const worker = new ClaudeCodeWorker();
    // Turn 1: 100 input, 50 output
    parseLineWith(worker, assistantLine({ input_tokens: 100, output_tokens: 50 }));
    // Turn 2: 200 input, 80 output, 10 cache read
    parseLineWith(worker, assistantLine({
      input_tokens: 200, output_tokens: 80,
      cache_read_input_tokens: 10,
    }));
    // Turn 3: 150 input, 60 output, 20 cache creation
    parseLineWith(worker, assistantLine({
      input_tokens: 150, output_tokens: 60,
      cache_creation_input_tokens: 20,
    }));
    // result event: carries ONLY the final turn's delta (150/60/0/20).
    // The fix must return the SUM of all three turns, not just this delta.
    const finalResult = parseLineWith(worker, resultLine({
      total_cost_usd: 0.05,
      num_turns: 3,
      usage: { input_tokens: 150, output_tokens: 60, cache_creation_input_tokens: 20 },
    }));

    assert.deepEqual(finalResult.usage, {
      inputTokens: 100 + 200 + 150,   // 450 — sum of all turns
      outputTokens: 50 + 80 + 60,      // 190
      cacheReadTokens: 0 + 10 + 0,     // 10
      cacheCreationTokens: 0 + 0 + 20, // 20
      totalTokens: 450 + 190 + 10 + 20, // 670
      costUsd: 0.05,                   // AC5: backend total_cost_usd unchanged
      requestCount: 3,                 // AC4: from num_turns
    });
  });

  it('AC4: requestCount comes from result.num_turns, not hardcoded 1', () => {
    const worker = new ClaudeCodeWorker();
    parseLineWith(worker, assistantLine({ input_tokens: 10, output_tokens: 5 }));
    parseLineWith(worker, assistantLine({ input_tokens: 10, output_tokens: 5 }));
    const result = parseLineWith(worker, resultLine({ num_turns: 7, total_cost_usd: 0.01 }));
    const usage = result.usage as { requestCount?: number } | undefined;
    assert.equal(usage?.requestCount, 7);
  });

  it('AC5: cost_usd is backend total_cost_usd — unchanged by accumulation', () => {
    const worker = new ClaudeCodeWorker();
    // Two turns, each with 100 tokens — accumulation must NOT touch costUsd
    parseLineWith(worker, assistantLine({ input_tokens: 100, output_tokens: 50 }));
    parseLineWith(worker, assistantLine({ input_tokens: 100, output_tokens: 50 }));
    const result = parseLineWith(worker, resultLine({ total_cost_usd: 0.0427, num_turns: 2 }));
    const usage = result.usage as { costUsd?: number } | undefined;
    assert.equal(usage?.costUsd, 0.0427);
  });

  it('edge: missing/empty usage fields default to 0 — no NaN or undefined tokens', () => {
    const worker = new ClaudeCodeWorker();
    // Assistant event with no cache fields
    parseLineWith(worker, assistantLine({ input_tokens: 10, output_tokens: 5 }));
    const result = parseLineWith(worker, resultLine({ num_turns: 1 }));
    const usage = result.usage as {
      inputTokens: number; outputTokens: number;
      cacheReadTokens: number; cacheCreationTokens: number; totalTokens: number;
    } | undefined;
    assert.ok(usage, 'should have usage');
    assert.equal(Number.isNaN(usage.inputTokens), false);
    assert.equal(Number.isNaN(usage.cacheReadTokens), false);
    assert.equal(usage.cacheReadTokens, 0);
    assert.equal(usage.cacheCreationTokens, 0);
    assert.equal(usage.totalTokens, 15);
  });

  it('edge: no assistant events — falls back to result.usage (single-turn or partial stream)', () => {
    const worker = new ClaudeCodeWorker();
    const result = parseLineWith(worker, resultLine({
      total_cost_usd: 0.01,
      num_turns: 1,
      usage: { input_tokens: 50, output_tokens: 20 },
    }));
    assert.deepEqual(result.usage, {
      inputTokens: 50,
      outputTokens: 20,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      totalTokens: 70,
      costUsd: 0.01,
      requestCount: 1,
    });
  });

  it('edge: requestCount absent when num_turns missing from result event', () => {
    const worker = new ClaudeCodeWorker();
    parseLineWith(worker, assistantLine({ input_tokens: 10, output_tokens: 5 }));
    const result = parseLineWith(worker, resultLine({ total_cost_usd: 0.005 }));
    const usage = result.usage as { requestCount?: number } | undefined;
    assert.equal(usage?.requestCount, undefined);
  });

  it('system/init resets accumulator so successive streams do not bleed', () => {
    const worker = new ClaudeCodeWorker();
    // First stream: accumulate 200 input tokens
    parseLineWith(worker, assistantLine({ input_tokens: 200, output_tokens: 100 }));
    // system/init marks the start of a new spawn — must reset accumulator
    parseLineWith(worker, JSON.stringify({ type: 'system', subtype: 'init', model: 'claude-sonnet-4-6' }));
    // Second stream: only 30 input tokens
    parseLineWith(worker, assistantLine({ input_tokens: 30, output_tokens: 10 }));
    const result = parseLineWith(worker, resultLine({ num_turns: 1 }));
    const usage = result.usage as { inputTokens: number } | undefined;
    // Must be 30, not 230 (bleed from first stream)
    assert.equal(usage?.inputTokens, 30);
  });

  it('running usage from assistant events is available mid-stream (for budget gating)', () => {
    const worker = new ClaudeCodeWorker();
    const after1 = parseLineWith(worker, assistantLine({ input_tokens: 100, output_tokens: 50 }));
    assert.deepEqual(after1.usage, {
      inputTokens: 100, outputTokens: 50,
      cacheReadTokens: 0, cacheCreationTokens: 0, totalTokens: 150,
    });
    const after2 = parseLineWith(worker, assistantLine({ input_tokens: 200, output_tokens: 80 }));
    assert.deepEqual(after2.usage, {
      inputTokens: 300, outputTokens: 130,
      cacheReadTokens: 0, cacheCreationTokens: 0, totalTokens: 430,
    });
  });
});
