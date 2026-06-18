import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { ClaudeCodeWorker } from '../orchestrator/ClaudeCodeWorker.js';
import type { WorkerUsage } from '../orchestrator/WorkerRunner.js';

/**
 * Regression test for story-014-001: cumulative stream-json usage harvest.
 *
 * The fixture below is the executable definition of "cumulative" that locks the
 * semantics story-014-001 discovered. It would fail if a future refactor
 * reintroduced the partial-delta under-count (i.e. reading result.usage directly
 * instead of accumulating per-turn assistant-event deltas).
 *
 * Update the fixture constants if the claude-code backend changes its stream-json
 * event shape — the comment on FIXTURE.resultEvent explains why result.usage is
 * intentionally different from the cumulative total.
 */

interface ParsedLine {
  humanText?: string;
  usage?: WorkerUsage;
  traces?: Array<{ kind: string; subject?: string; rationale: string }>;
  model?: string;
}

/** Parse a line on a REUSED worker instance (preserves streamUsageAccum). */
function parseLineWith(worker: ClaudeCodeWorker, line: string): ParsedLine {
  return (worker as unknown as { parseStreamLine: (l: string) => ParsedLine }).parseStreamLine(line);
}

/**
 * Representative claude stream-json sequence — verbatim shape of what the real
 * claude CLI emits for a 3-turn agentic session.
 *
 * Key invariant encoded here: each `assistant` event carries a per-turn usage
 * DELTA (not the session cumulative). The `result` event's `usage` field also
 * carries only the FINAL TURN'S delta, not the aggregate. The correct session
 * total is the SUM of all assistant-event deltas.
 */
const FIXTURE = {
  // Session bootstrap — resets the accumulator; surfaces the executed model id.
  systemInit: JSON.stringify({
    type: 'system',
    subtype: 'init',
    model: 'claude-sonnet-4-6',
    session_id: 'sess_regression_014_002',
  }),

  // Turn 1: initial read (cold start → large cache_creation spike, small cache_read).
  assistantTurn1: JSON.stringify({
    type: 'assistant',
    message: {
      id: 'msg_t1',
      role: 'assistant',
      content: [
        { type: 'text', text: 'Reading the worker source to understand the accumulation seam.' },
        { type: 'tool_use', id: 'tu_01', name: 'Read', input: { file_path: 'src/orchestrator/ClaudeCodeWorker.ts' } },
      ],
      usage: {
        input_tokens: 500,
        output_tokens: 100,
        cache_read_input_tokens: 2000,
        cache_creation_input_tokens: 5000,
      },
    },
  }),

  // Turn 2: follow-up analysis (warm cache → cache_read grows, cache_creation zero).
  assistantTurn2: JSON.stringify({
    type: 'assistant',
    message: {
      id: 'msg_t2',
      role: 'assistant',
      content: [
        { type: 'text', text: 'I see the parseUsage fallback. Let me check the test suite.' },
        { type: 'tool_use', id: 'tu_02', name: 'Bash', input: { command: 'npm test -- --test-name-pattern usage' } },
      ],
      usage: {
        input_tokens: 450,
        output_tokens: 80,
        cache_read_input_tokens: 6000,
        cache_creation_input_tokens: 0,
      },
    },
  }),

  // Turn 3: final edit (warm cache, moderate output).
  assistantTurn3: JSON.stringify({
    type: 'assistant',
    message: {
      id: 'msg_t3',
      role: 'assistant',
      content: [
        { type: 'text', text: 'Applying the accumulation fix.' },
        { type: 'tool_use', id: 'tu_03', name: 'Edit', input: { file_path: 'src/orchestrator/ClaudeCodeWorker.ts', old_string: 'old', new_string: 'new' } },
      ],
      usage: {
        input_tokens: 300,
        output_tokens: 120,
        cache_read_input_tokens: 7500,
        cache_creation_input_tokens: 0,
      },
    },
  }),

  // Terminal event: num_turns=3, total_cost_usd is the real backend cost figure.
  //
  // IMPORTANT: result.usage carries ONLY the final turn's delta (turn 3: 300/120/7500/0).
  // A naive implementation that uses result.usage directly would under-count by:
  //   input:        500 + 450 = 950 tokens (missing turns 1 + 2)
  //   output:       100 + 80  = 180 tokens
  //   cache_read:  2000 + 6000 = 8000 tokens
  //   cache_creation: 5000 tokens (entirely missing)
  // The correct harvest reads the accumulated assistant-event totals, NOT result.usage.
  resultEvent: JSON.stringify({
    type: 'result',
    subtype: 'success',
    is_error: false,
    result: 'Changes applied and tests pass.',
    num_turns: 3,
    total_cost_usd: 0.0842,
    usage: {
      // Final turn delta only — NOT the cumulative total.
      input_tokens: 300,
      output_tokens: 120,
      cache_read_input_tokens: 7500,
      cache_creation_input_tokens: 0,
    },
  }),
} as const;

/**
 * Cumulative sum of all three assistant-event deltas — the correct persisted total.
 *
 * Maps 1:1 to AgentStore.setUsage() column names (FR-9):
 *   tokens_input         ← inputTokens
 *   tokens_output        ← outputTokens
 *   tokens_cached        ← cacheReadTokens
 *   tokens_cache_creation← cacheCreationTokens
 *   request_count        ← requestCount
 *   cost_usd             ← costUsd
 */
const EXPECTED_PERSISTED: WorkerUsage = {
  inputTokens:         500 + 450 + 300,       // tokens_input:          1250
  outputTokens:        100 + 80  + 120,        // tokens_output:          300
  cacheReadTokens:     2000 + 6000 + 7500,     // tokens_cached:        15500
  cacheCreationTokens: 5000 + 0 + 0,           // tokens_cache_creation: 5000
  totalTokens:         1250 + 300 + 15500 + 5000, // 22050
  costUsd:             0.0842,                 // cost_usd — backend value, not recomputed
  requestCount:        3,                      // request_count — from result.num_turns
};

// ─── AC1 + AC2: representative fixture replay ────────────────────────────────

describe('ClaudeCodeWorker stream-json usage harvest — regression (story-014-002)', () => {
  it('AC1+AC2: replays full 3-turn fixture; persisted totals equal the summed stream usage', () => {
    const worker = new ClaudeCodeWorker();

    // Replay the session in order: init → 3 assistant turns → result.
    parseLineWith(worker, FIXTURE.systemInit);
    parseLineWith(worker, FIXTURE.assistantTurn1);
    parseLineWith(worker, FIXTURE.assistantTurn2);
    parseLineWith(worker, FIXTURE.assistantTurn3);
    const finalParsed = parseLineWith(worker, FIXTURE.resultEvent);

    // The usage returned on the result event is what the Supervisor passes to
    // AgentStore.setUsage() — assert each column mapping explicitly.
    assert.ok(finalParsed.usage, 'result event must return usage');
    const u = finalParsed.usage;

    assert.equal(u.inputTokens,         EXPECTED_PERSISTED.inputTokens,
      'tokens_input must equal sum of all assistant-event input_tokens');
    assert.equal(u.outputTokens,        EXPECTED_PERSISTED.outputTokens,
      'tokens_output must equal sum of all assistant-event output_tokens');
    assert.equal(u.cacheReadTokens,     EXPECTED_PERSISTED.cacheReadTokens,
      'tokens_cached must equal sum of all assistant-event cache_read_input_tokens');
    assert.equal(u.cacheCreationTokens, EXPECTED_PERSISTED.cacheCreationTokens,
      'tokens_cache_creation must equal sum of all assistant-event cache_creation_input_tokens');
    assert.equal(u.totalTokens,         EXPECTED_PERSISTED.totalTokens,
      'totalTokens must equal the combined column sum');
    assert.equal(u.requestCount,        EXPECTED_PERSISTED.requestCount,
      'request_count must equal result.num_turns');
    assert.equal(u.costUsd,             EXPECTED_PERSISTED.costUsd,
      'cost_usd must equal result.total_cost_usd — not recomputed from token counts');
  });

  it('AC2: deepEqual across all fields at once (full persisted-record assertion)', () => {
    const worker = new ClaudeCodeWorker();
    parseLineWith(worker, FIXTURE.systemInit);
    parseLineWith(worker, FIXTURE.assistantTurn1);
    parseLineWith(worker, FIXTURE.assistantTurn2);
    parseLineWith(worker, FIXTURE.assistantTurn3);
    const { usage } = parseLineWith(worker, FIXTURE.resultEvent);
    assert.deepEqual(usage, EXPECTED_PERSISTED);
  });

  it('regression sentinel: result.usage alone (pre-fix behaviour) differs from cumulative total', () => {
    // If the harvest read result.usage directly instead of accumulating
    // assistant-event deltas, input_tokens would be 300 (turn 3 only), not 1250.
    // This assertion documents the regression boundary — update if the fixture changes.
    const resultOnlyInputTokens = 300;
    assert.notEqual(
      resultOnlyInputTokens,
      EXPECTED_PERSISTED.inputTokens,
      'result.usage.input_tokens (last-turn delta) must differ from the cumulative sum'
    );
    // Explicitly confirm the under-count magnitude.
    assert.equal(
      EXPECTED_PERSISTED.inputTokens - resultOnlyInputTokens,
      950, // missing turn 1 (500) + turn 2 (450)
      'pre-fix under-count: 950 input tokens from turns 1+2 would be lost'
    );
  });

  it('AC2: cost_usd is total_cost_usd from the result event — never recomputed from tokens', () => {
    // Two sessions with identical token counts but different backend costs.
    // Verify that costUsd follows the declared total_cost_usd, not a
    // locally-computed estimate based on token totals.
    const workerA = new ClaudeCodeWorker();
    parseLineWith(workerA, FIXTURE.systemInit);
    parseLineWith(workerA, FIXTURE.assistantTurn1);
    const resultA = parseLineWith(workerA, JSON.stringify({
      type: 'result', subtype: 'success', result: 'done',
      num_turns: 1, total_cost_usd: 0.1111,
      usage: { input_tokens: 500, output_tokens: 100, cache_read_input_tokens: 2000, cache_creation_input_tokens: 5000 },
    }));
    assert.equal(resultA.usage?.costUsd, 0.1111,
      'costUsd must be the backend total_cost_usd value');

    // Same tokens, different cost — must reflect the declared value.
    const workerB = new ClaudeCodeWorker();
    parseLineWith(workerB, FIXTURE.systemInit);
    parseLineWith(workerB, FIXTURE.assistantTurn1);
    const resultB = parseLineWith(workerB, JSON.stringify({
      type: 'result', subtype: 'success', result: 'done',
      num_turns: 1, total_cost_usd: 0.9999,
      usage: { input_tokens: 500, output_tokens: 100, cache_read_input_tokens: 2000, cache_creation_input_tokens: 5000 },
    }));
    assert.equal(resultB.usage?.costUsd, 0.9999,
      'costUsd must track the declared total_cost_usd, not a computed value');
  });

  it('AC2: request_count comes from result.num_turns across all fixture turns', () => {
    const worker = new ClaudeCodeWorker();
    parseLineWith(worker, FIXTURE.systemInit);
    parseLineWith(worker, FIXTURE.assistantTurn1);
    parseLineWith(worker, FIXTURE.assistantTurn2);
    parseLineWith(worker, FIXTURE.assistantTurn3);
    const { usage } = parseLineWith(worker, FIXTURE.resultEvent);
    assert.equal(usage?.requestCount, 3,
      'request_count must equal num_turns=3 from the result event');
  });

  it('system/init resets the accumulator — a second stream does not bleed prior totals', () => {
    // First stream: full 3-turn session accumulates 1250 input tokens.
    const worker = new ClaudeCodeWorker();
    parseLineWith(worker, FIXTURE.systemInit);
    parseLineWith(worker, FIXTURE.assistantTurn1);
    parseLineWith(worker, FIXTURE.assistantTurn2);
    parseLineWith(worker, FIXTURE.assistantTurn3);
    parseLineWith(worker, FIXTURE.resultEvent);

    // Second stream on the SAME worker: system/init must reset the accumulator.
    parseLineWith(worker, FIXTURE.systemInit);
    // Only one assistant turn — 100 input tokens.
    parseLineWith(worker, JSON.stringify({
      type: 'assistant',
      message: {
        content: [{ type: 'text', text: 'Starting fresh.' }],
        usage: { input_tokens: 100, output_tokens: 40, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
      },
    }));
    const { usage: secondUsage } = parseLineWith(worker, JSON.stringify({
      type: 'result', subtype: 'success', result: 'done',
      num_turns: 1, total_cost_usd: 0.001,
      usage: { input_tokens: 100, output_tokens: 40, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
    }));

    assert.equal(secondUsage?.inputTokens, 100,
      'second stream must not include first stream tokens — accumulator must reset on system/init');
    assert.notEqual(secondUsage?.inputTokens, 1250 + 100,
      'bleed from first stream (1250 + 100 = 1350) must not appear');
  });
});
