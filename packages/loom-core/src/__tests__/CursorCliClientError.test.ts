import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CursorCliClient, MAX_ERROR_OUTPUT_CHARS } from '../llm/CursorCliClient.js';
import type { LLMRequest } from '../llm/LLMClient.js';

// A model-list-shaped stderr longer than the old 500-char bound. A unique
// sentinel sits at the very end so the test can prove the TAIL survived — a
// substring near the start would pass even with the old slice(0, 500).
const TAIL_SENTINEL = 'claude-sonnet-4-6-FINAL-MODEL-SENTINEL-END';
function buildLongStderr(): string {
  const header = 'Error: invalid model id. Valid models are:\n';
  const lines: string[] = [];
  for (let i = 0; i < 120; i++) {
    lines.push(`  - claude-model-variant-${String(i).padStart(4, '0')}-availability-internal`);
  }
  lines.push(`  - ${TAIL_SENTINEL}`);
  return header + lines.join('\n');
}

const req: LLMRequest = {
  model: 'bogus-model',
  system: [],
  messages: [{ role: 'user', content: 'hi' }],
};

describe('CursorCliClient.complete non-zero exit', () => {
  let dir: string;
  let binPath: string;
  let stderrText: string;

  before(() => {
    dir = mkdtempSync(join(tmpdir(), 'cursor-cli-err-'));
    stderrText = buildLongStderr();
    assert.ok(stderrText.length > 500, 'fixture must exceed the old 500-char bound');

    const errFile = join(dir, 'stderr.txt');
    writeFileSync(errFile, stderrText);

    // A fake cursor-agent: drain stdin, echo the canned stderr, exit non-zero.
    const script = `#!/bin/sh\ncat > /dev/null\ncat ${JSON.stringify(errFile)} 1>&2\nexit 7\n`;
    binPath = join(dir, 'fake-cursor-agent');
    writeFileSync(binPath, script);
    chmodSync(binPath, 0o755);
  });

  after(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('surfaces the full stderr untruncated, including the tail', async () => {
    const client = new CursorCliClient({ cursorBin: binPath });
    await assert.rejects(
      () => client.complete(req),
      (err: unknown) => {
        assert.ok(err instanceof Error);
        assert.match(err.message, /cursor-agent exited 7:/);
        // The complete message — not just a 500-char prefix — must be present.
        assert.ok(
          err.message.includes(stderrText),
          'error message should contain the entire stderr verbatim'
        );
        // Explicitly prove the tail survived (old slice(0,500) would drop it).
        assert.ok(
          err.message.includes(TAIL_SENTINEL),
          'error message should contain the final characters of stderr'
        );
        return true;
      }
    );
  });

  it('bounds the surfaced output with MAX_ERROR_OUTPUT_CHARS = 64_000', () => {
    assert.equal(MAX_ERROR_OUTPUT_CHARS, 64_000);
  });
});
