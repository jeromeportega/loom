#!/usr/bin/env node
/**
 * 30-min spike for live agent guidance — verifies the upstream JSONL
 * shape claude expects on `--input-format stream-json` AND what it
 * echoes back on `--replay-user-messages`.
 *
 * Plan: docs/research/live-agent-guidance.md + plan v2.
 *
 * Run from anywhere:
 *   node scripts/manual/spike-claude-streamjson.mjs
 *
 * Cost: ~2 short Sonnet turns ("say HI" / "say BYE"). Cents.
 *
 * Output: JSON written to /tmp/loom-spike-<timestamp>.json with:
 *  - every line emitted by claude on stdout (parsed)
 *  - both user-message inputs we wrote
 *  - timing + whether each input produced a turn
 *  - the shape of message.content in any `type:'user'` echo
 *  - whether `cache_read_input_tokens > 0` on the second `result` (proves
 *    the system-prompt cache survives mid-spawn injection)
 *
 * Stops on either: two `result` events seen, OR 90s total wall-clock.
 */

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const OUT = `/tmp/loom-spike-${new Date()
  .toISOString()
  .replace(/[:.]/g, '-')}.json`;

const FIRST = {
  type: 'user',
  message: { role: 'user', content: 'Reply with just the single word: HI' },
};
const SECOND = {
  type: 'user',
  message: { role: 'user', content: 'Now reply with just the single word: BYE' },
};

const args = [
  '-p',
  '--permission-mode', 'bypassPermissions',
  '--output-format', 'stream-json',
  '--input-format', 'stream-json',
  '--include-partial-messages',
  '--replay-user-messages',
  '--verbose',
];

const child = spawn('claude', args, {
  cwd: process.cwd(),
  stdio: ['pipe', 'pipe', 'pipe'],
});

const lines = [];
const events = [];
let stdoutBuf = '';
let stderrBuf = '';
let firstResultSeen = false;
let secondPushed = false;
let secondResultSeen = false;
const t0 = Date.now();

const log = (kind, payload) => {
  events.push({ ts: Date.now() - t0, kind, payload });
  process.stderr.write(`[${Date.now() - t0}ms] ${kind}\n`);
};

child.stdout.on('data', (chunk) => {
  stdoutBuf += chunk.toString();
  const parts = stdoutBuf.split('\n');
  stdoutBuf = parts.pop() ?? '';
  for (const line of parts) {
    if (line.length === 0) continue;
    lines.push(line);
    let parsed;
    try {
      parsed = JSON.parse(line);
    } catch {
      log('stdout-non-json', { line });
      continue;
    }
    log('stdout-event', { type: parsed.type, subtype: parsed.subtype, raw: parsed });
    if (parsed.type === 'result') {
      if (!firstResultSeen) {
        firstResultSeen = true;
        log('first-result', {
          cache_read_input_tokens: parsed.usage?.cache_read_input_tokens,
          cache_creation_input_tokens: parsed.usage?.cache_creation_input_tokens,
          input_tokens: parsed.usage?.input_tokens,
          output_tokens: parsed.usage?.output_tokens,
          result_text: parsed.result?.slice?.(0, 80),
        });
        // Push the second user message now that we've seen the first turn complete.
        if (!secondPushed) {
          secondPushed = true;
          log('pushing-second', { msg: SECOND.message.content });
          child.stdin.write(JSON.stringify(SECOND) + '\n');
        }
      } else if (!secondResultSeen) {
        secondResultSeen = true;
        log('second-result', {
          cache_read_input_tokens: parsed.usage?.cache_read_input_tokens,
          cache_creation_input_tokens: parsed.usage?.cache_creation_input_tokens,
          input_tokens: parsed.usage?.input_tokens,
          output_tokens: parsed.usage?.output_tokens,
          result_text: parsed.result?.slice?.(0, 80),
        });
        // We've seen both turns; close stdin to let claude flush + exit.
        try { child.stdin.end(); } catch {}
      }
    }
    if (parsed.type === 'user') {
      // This is the replay-user-messages echo.
      log('user-echo', {
        content_type: Array.isArray(parsed.message?.content) ? 'array' : typeof parsed.message?.content,
        content_sample:
          typeof parsed.message?.content === 'string'
            ? parsed.message.content.slice(0, 80)
            : JSON.stringify(parsed.message?.content)?.slice(0, 200),
      });
    }
  }
});

child.stderr.on('data', (chunk) => {
  const s = chunk.toString();
  stderrBuf += s;
  log('stderr', { chunk: s.slice(0, 200) });
});

child.on('error', (err) => {
  log('spawn-error', { message: err.message });
  finish(`spawn-error: ${err.message}`);
});

child.on('close', (code) => {
  log('child-close', { code });
  finish('child-close');
});

// Hard timeout.
setTimeout(() => {
  log('timeout', {});
  try { child.kill('SIGTERM'); } catch {}
  finish('timeout-90s');
}, 90_000);

// Write the initial user message.
log('writing-first', { msg: FIRST.message.content });
child.stdin.write(JSON.stringify(FIRST) + '\n');

let finished = false;
function finish(reason) {
  if (finished) return;
  finished = true;
  const summary = {
    reason,
    args,
    elapsed_ms: Date.now() - t0,
    first_result_seen: firstResultSeen,
    second_pushed: secondPushed,
    second_result_seen: secondResultSeen,
    user_echoes: events.filter((e) => e.kind === 'user-echo').length,
    line_count: lines.length,
    events,
    raw_stdout_lines_sample: lines.slice(0, 8),
    raw_stderr_tail: stderrBuf.slice(-500),
  };
  fs.writeFileSync(OUT, JSON.stringify(summary, null, 2));
  console.log(`\nSPIKE COMPLETE — wrote ${OUT}`);
  console.log(`Summary: first_result=${firstResultSeen} second_pushed=${secondPushed} second_result=${secondResultSeen} user_echoes=${summary.user_echoes}`);
  process.exit(0);
}
