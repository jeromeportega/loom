/**
 * FR-8 argv regression guard — non-agentic completion mode.
 *
 * Asserts on the constructed `claude` subprocess argv, NOT on mocked LLM output.
 * Output mocks never spawn `claude`, so they cannot catch a flag-spelling regression.
 * Exact flag tokens are pinned here; a rename/removal breaks the build loudly.
 *
 * Acceptance criteria mapped to test cases:
 *  AC1 — all assertions are on argv arrays, never on subprocess output
 *  AC2 — non-agentic: --system-prompt present, tools disabled via NON_AGENTIC_TOOLS_DISABLE_ARGS
 *  AC3 — non-agentic: --append-system-prompt must be absent (classifier path never uses it)
 *  AC4 — default agentic (nonAgentic undefined): --append-system-prompt present, no --system-prompt/tools-disable
 *  AC5 — all cases pass
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildBufferedArgs,
  buildStreamingArgs,
  NON_AGENTIC_TOOLS_DISABLE_ARGS,
} from '../ClaudeCliClient.js';
import { MockLLMClient } from '../MockLLMClient.js';
import { classifyIntake } from '../../intake/IntakeClassifier.js';

const MODEL = 'claude-sonnet-4-6';
const SYSTEM = 'You are a strict JSON classifier. Return only JSON.';

// ─── buildBufferedArgs ────────────────────────────────────────────────────────

describe('buildBufferedArgs — non-agentic path (AC2, AC3)', () => {
  it('contains --system-prompt with the system text', () => {
    const args = buildBufferedArgs(MODEL, SYSTEM, { excludeDynamicSections: true });
    const idx = args.indexOf('--system-prompt');
    assert.ok(idx !== -1, 'must contain --system-prompt');
    assert.equal(args[idx + 1], SYSTEM, '--system-prompt value must be the system text');
  });

  it('contains the exact tools-disable token from NON_AGENTIC_TOOLS_DISABLE_ARGS', () => {
    const args = buildBufferedArgs(MODEL, SYSTEM, { excludeDynamicSections: true });
    const toolsIdx = args.indexOf(NON_AGENTIC_TOOLS_DISABLE_ARGS[0]);
    assert.ok(toolsIdx !== -1, 'must contain the tools-disable flag');
    assert.equal(
      args[toolsIdx + 1],
      NON_AGENTIC_TOOLS_DISABLE_ARGS[1],
      'tools-disable value must match NON_AGENTIC_TOOLS_DISABLE_ARGS[1]',
    );
  });

  it('does NOT contain --append-system-prompt (AC3)', () => {
    const args = buildBufferedArgs(MODEL, SYSTEM, { excludeDynamicSections: true });
    assert.ok(!args.includes('--append-system-prompt'), 'must NOT contain --append-system-prompt');
  });
});

describe('buildBufferedArgs — default agentic path (AC4)', () => {
  it('contains --append-system-prompt with the system text', () => {
    const args = buildBufferedArgs(MODEL, SYSTEM, undefined);
    const idx = args.indexOf('--append-system-prompt');
    assert.ok(idx !== -1, 'must contain --append-system-prompt');
    assert.equal(args[idx + 1], SYSTEM, '--append-system-prompt value must be the system text');
  });

  it('does NOT contain --system-prompt or tools-disable args', () => {
    const args = buildBufferedArgs(MODEL, SYSTEM, undefined);
    assert.ok(!args.includes('--system-prompt'), 'must NOT contain --system-prompt');
    assert.ok(
      !args.includes(NON_AGENTIC_TOOLS_DISABLE_ARGS[0]),
      'must NOT contain the tools-disable flag',
    );
  });
});

// ─── buildStreamingArgs ───────────────────────────────────────────────────────

describe('buildStreamingArgs — non-agentic path (AC2, AC3)', () => {
  it('contains --system-prompt with the system text', () => {
    const args = buildStreamingArgs(MODEL, SYSTEM, { excludeDynamicSections: true });
    const idx = args.indexOf('--system-prompt');
    assert.ok(idx !== -1, 'must contain --system-prompt');
    assert.equal(args[idx + 1], SYSTEM, '--system-prompt value must be the system text');
  });

  it('contains the exact tools-disable token from NON_AGENTIC_TOOLS_DISABLE_ARGS', () => {
    const args = buildStreamingArgs(MODEL, SYSTEM, { excludeDynamicSections: true });
    const toolsIdx = args.indexOf(NON_AGENTIC_TOOLS_DISABLE_ARGS[0]);
    assert.ok(toolsIdx !== -1, 'must contain the tools-disable flag');
    assert.equal(
      args[toolsIdx + 1],
      NON_AGENTIC_TOOLS_DISABLE_ARGS[1],
      'tools-disable value must match NON_AGENTIC_TOOLS_DISABLE_ARGS[1]',
    );
  });

  it('does NOT contain --append-system-prompt (AC3)', () => {
    const args = buildStreamingArgs(MODEL, SYSTEM, { excludeDynamicSections: true });
    assert.ok(!args.includes('--append-system-prompt'), 'must NOT contain --append-system-prompt');
  });
});

describe('buildStreamingArgs — default agentic path (AC4)', () => {
  it('contains --append-system-prompt with the system text', () => {
    const args = buildStreamingArgs(MODEL, SYSTEM, undefined);
    const idx = args.indexOf('--append-system-prompt');
    assert.ok(idx !== -1, 'must contain --append-system-prompt');
    assert.equal(args[idx + 1], SYSTEM, '--append-system-prompt value must be the system text');
  });

  it('does NOT contain --system-prompt or tools-disable args', () => {
    const args = buildStreamingArgs(MODEL, SYSTEM, undefined);
    assert.ok(!args.includes('--system-prompt'), 'must NOT contain --system-prompt');
    assert.ok(
      !args.includes(NON_AGENTIC_TOOLS_DISABLE_ARGS[0]),
      'must NOT contain the tools-disable flag',
    );
  });
});

// ─── Classifier call-site tie-in (AC3 guard) ─────────────────────────────────
//
// Feeds the actual classifyIntake call through a mock LLM and confirms that the
// captured request carries nonAgentic, so that buildBufferedArgs on the same
// inputs produces the non-agentic argv shape. This test fails if the classifier
// ever reverts to omitting the nonAgentic field.

describe('classifyIntake — call-site nonAgentic contract (AC3 tie-in)', () => {
  it('sends nonAgentic: { excludeDynamicSections: true } so the argv avoids --append-system-prompt', async () => {
    const validVerdictJson = JSON.stringify({
      type: 'feature',
      size: 'story',
      confidence: 'high',
      rationale: 'Regression guard: confirm classifier ships nonAgentic flag',
    });
    const mock = new MockLLMClient([validVerdictJson]);

    await classifyIntake('Add full-text search to the dashboard', { llm: mock, model: MODEL });

    const req = mock.requests[0];
    assert.ok(req !== undefined, 'classifyIntake must have called the LLM');
    assert.ok(req.nonAgentic !== undefined, 'request must carry nonAgentic (classifier must opt in)');

    // Reconstruct the argv the real ClaudeCliClient would build from this request.
    const systemText = req.system.map((b) => b.text).join('\n\n');
    const args = buildBufferedArgs(req.model, systemText, req.nonAgentic);

    assert.ok(
      !args.includes('--append-system-prompt'),
      'classifier argv must NOT contain --append-system-prompt',
    );
    assert.ok(args.includes('--system-prompt'), 'classifier argv must contain --system-prompt');
    assert.ok(
      args.includes(NON_AGENTIC_TOOLS_DISABLE_ARGS[0]),
      'classifier argv must include the tools-disable flag',
    );
  });
});
