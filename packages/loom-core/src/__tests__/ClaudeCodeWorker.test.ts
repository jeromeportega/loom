import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import type { ChildProcess } from 'node:child_process';
import { ClaudeCodeWorker } from '../orchestrator/ClaudeCodeWorker.js';
import { MAX_GUIDANCE_BYTES } from '../orchestrator/WorkerInputChannel.js';

/**
 * Subclass exposing the protected hooks so we can exercise the streaming-
 * input integration without spinning up a real `claude` CLI subprocess.
 * The plan deliberately uses the existing `spawnAgent` test seam — we do
 * NOT mock `child_process.spawn` here.
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
class TestableClaude extends ClaudeCodeWorker {
  exposeBuildInputChannel(child: ChildProcess) {
    return (this as any).buildInputChannel(child);
  }
  exposeFormatInitialPrompt(prompt: string) {
    return (this as any).formatInitialPrompt(prompt);
  }
  exposeIsTerminalLine(line: string) {
    return (this as any).isTerminalLine(line);
  }
  exposeParseStreamLine(line: string) {
    return (this as any).parseStreamLine(line);
  }
  exposeStreamingInput() {
    return (this as any).streamingInput();
  }
  exposeAgentArgs(assignment: any) {
    return (this as any).agentArgs(assignment);
  }
}
/* eslint-enable @typescript-eslint/no-explicit-any */

function fakeChild(stdin: NodeJS.WritableStream): ChildProcess {
  return { stdin } as unknown as ChildProcess;
}

describe('ClaudeCodeWorker — streaming-input integration', () => {
  it('streamingInput() returns true', () => {
    assert.equal(new TestableClaude().exposeStreamingInput(), true);
  });

  it('formatInitialPrompt wraps as a JSONL user message (spike-confirmed shape)', () => {
    const w = new TestableClaude();
    const out = w.exposeFormatInitialPrompt('hello world');
    assert.ok(out.endsWith('\n'));
    const parsed = JSON.parse(out.trim());
    assert.equal(parsed.type, 'user');
    assert.equal(parsed.message.role, 'user');
    assert.equal(parsed.message.content, 'hello world');
  });

  it('isTerminalLine recognises type:"result" and nothing else', () => {
    const w = new TestableClaude();
    assert.ok(w.exposeIsTerminalLine('{"type":"result","subtype":"success"}'));
    assert.ok(!w.exposeIsTerminalLine('{"type":"assistant"}'));
    assert.ok(!w.exposeIsTerminalLine('{"type":"user"}'));
    assert.ok(!w.exposeIsTerminalLine('not json'));
  });
});

describe('ClaudeCodeWorker — buildInputChannel', () => {
  it('push writes a JSONL user message to stdin and returns true', async () => {
    const w = new TestableClaude();
    const stdin = new PassThrough();
    const collected: string[] = [];
    stdin.on('data', (chunk) => collected.push(chunk.toString()));
    const ch = w.exposeBuildInputChannel(fakeChild(stdin));

    const ok = await ch.push('also handle the auth case');
    assert.equal(ok, true);

    // Flush microtasks so PassThrough emits 'data'.
    await new Promise((r) => setImmediate(r));
    const written = collected.join('');
    assert.ok(written.endsWith('\n'));
    const parsed = JSON.parse(written.trim());
    assert.equal(parsed.type, 'user');
    assert.equal(parsed.message.role, 'user');
    assert.equal(parsed.message.content, 'also handle the auth case');
  });

  it('push returns false when the message exceeds MAX_GUIDANCE_BYTES', async () => {
    const w = new TestableClaude();
    const stdin = new PassThrough();
    const ch = w.exposeBuildInputChannel(fakeChild(stdin));
    const huge = 'x'.repeat(MAX_GUIDANCE_BYTES + 1);
    const ok = await ch.push(huge);
    assert.equal(ok, false);
  });

  it('available() flips false after close()', () => {
    const w = new TestableClaude();
    const stdin = new PassThrough();
    const ch = w.exposeBuildInputChannel(fakeChild(stdin));
    assert.equal(ch.available(), true);
    ch.close();
    assert.equal(ch.available(), false);
  });

  it('push returns false after stdin has been ended', async () => {
    const w = new TestableClaude();
    const stdin = new PassThrough();
    const ch = w.exposeBuildInputChannel(fakeChild(stdin));
    stdin.end();
    const ok = await ch.push('whatever');
    assert.equal(ok, false);
  });

  it('push awaits drain when the stdin pipe is full', async () => {
    const w = new TestableClaude();
    // highWaterMark forces write() to return false on any non-trivial write.
    const stdin = new PassThrough({ highWaterMark: 4 });
    const ch = w.exposeBuildInputChannel(fakeChild(stdin));

    // Don't drain yet — push() should block on 'drain'.
    let pushResolved = false;
    const push = (ch.push('a message that exceeds the watermark') as Promise<boolean>).then(
      (ok) => {
        pushResolved = true;
        return ok;
      }
    );

    // Give the event loop a tick. push must NOT have resolved yet because
    // we haven't drained the PassThrough.
    await new Promise((r) => setImmediate(r));
    assert.equal(pushResolved, false, 'push resolved before drain — backpressure not respected');

    // Drain — flips 'drain' once the buffer empties.
    stdin.on('data', () => {});
    stdin.resume();

    const ok = await push;
    assert.equal(ok, true);
  });
});

describe('ClaudeCodeWorker — model flag (regression: policy.agents.model was a dead knob)', () => {
  // A worktree path with no .cursor/mcp.json, so agentArgs returns the base args.
  const noMcpAssignment = { worktreePath: '/nonexistent-loom-worktree-xyz' } as any;

  it('appends --model <id> when a model is configured', () => {
    const w = new TestableClaude({ model: 'claude-sonnet-4-6' });
    const args = w.exposeAgentArgs(noMcpAssignment);
    const i = args.indexOf('--model');
    assert.ok(i >= 0, 'expected --model in the claude args');
    assert.equal(args[i + 1], 'claude-sonnet-4-6');
  });

  it('omits --model when no model is configured (baseline byte-identical)', () => {
    const w = new TestableClaude();
    const args = w.exposeAgentArgs(noMcpAssignment);
    assert.ok(!args.includes('--model'), 'baseline args must not carry --model');
  });

  it('an explicit claudeArgs override suppresses the injected --model', () => {
    const w = new TestableClaude({ model: 'claude-sonnet-4-6', claudeArgs: ['-p'] });
    const args = w.exposeAgentArgs(noMcpAssignment);
    assert.deepEqual(args, ['-p']);
  });
});

describe('ClaudeCodeWorker — parseStreamLine user-echo handling', () => {
  it('records a guidance_received trace for string content (primary spike-confirmed shape)', () => {
    const w = new TestableClaude();
    const line = JSON.stringify({
      type: 'user',
      message: { role: 'user', content: 'also handle the auth case' },
    });
    const parsed = w.exposeParseStreamLine(line);
    assert.ok(parsed.traces, 'expected traces in parsed line');
    assert.equal(parsed.traces.length, 1);
    assert.equal(parsed.traces[0].kind, 'guidance_received');
    assert.equal(parsed.traces[0].rationale, 'also handle the auth case');
  });

  it('records a guidance_received trace for array content (defensive)', () => {
    const w = new TestableClaude();
    const line = JSON.stringify({
      type: 'user',
      message: {
        role: 'user',
        content: [
          { type: 'text', text: 'also handle auth' },
          { type: 'text', text: 'and logging' },
        ],
      },
    });
    const parsed = w.exposeParseStreamLine(line);
    assert.ok(parsed.traces);
    assert.equal(parsed.traces[0].kind, 'guidance_received');
    assert.match(parsed.traces[0].rationale, /also handle auth/);
    assert.match(parsed.traces[0].rationale, /and logging/);
  });

  it('returns empty for a user event without content', () => {
    const w = new TestableClaude();
    const parsed = w.exposeParseStreamLine('{"type":"user","message":{}}');
    assert.deepEqual(parsed, {});
  });

  it('silently drops stream_event / system/status / rate_limit_event (no new branches needed)', () => {
    const w = new TestableClaude();
    const drops = [
      '{"type":"stream_event","event":{"type":"message_start"}}',
      '{"type":"system","subtype":"status","status":"requesting"}',
      '{"type":"rate_limit_event","rate_limit_info":{"status":"allowed"}}',
    ];
    for (const line of drops) {
      const parsed = w.exposeParseStreamLine(line);
      assert.deepEqual(parsed, {}, `expected empty parse for ${line.slice(0, 40)}`);
    }
  });
});
