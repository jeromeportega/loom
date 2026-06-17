import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runPullGuidance } from '../commands/pullGuidance.js';

// ─── Capture helper ─────────────────────────────────────────────────────────

interface Captured {
  stdout: string[];
  stderr: string[];
  exitCode: number | undefined;
}

function capture(fn: () => void): Captured {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const prevLog = console.log;
  const prevError = console.error;
  const prevExitCode = process.exitCode;
  process.exitCode = undefined;

  console.log = (...args: unknown[]) => stdout.push(args.map(String).join(' '));
  console.error = (...args: unknown[]) => stderr.push(args.map(String).join(' '));

  try {
    fn();
  } finally {
    console.log = prevLog;
    console.error = prevError;
  }

  const exitCode = process.exitCode as number | undefined;
  process.exitCode = prevExitCode;
  return { stdout, stderr, exitCode };
}

// ─── Lifecycle ───────────────────────────────────────────────────────────────

let tmpDir: string;
let prevCwd: string;
const STORY_ID = 'story-test-001';

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'loom-pull-guidance-'));
  fs.mkdirSync(path.join(tmpDir, '.loom', 'guidance'), { recursive: true });
  prevCwd = process.cwd();
  process.chdir(tmpDir);
});

afterEach(() => {
  process.chdir(prevCwd);
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('runPullGuidance — happy path', () => {
  it('prints guidance content as plain text on stdout, exit 0', () => {
    fs.writeFileSync(
      path.join(tmpDir, '.loom', 'guidance', `${STORY_ID}.md`),
      'Focus on the auth middleware first.'
    );

    const { stdout, exitCode } = capture(() => runPullGuidance(STORY_ID));

    assert.ok(
      stdout.join('\n').includes('Focus on the auth middleware first.'),
      'content printed to stdout'
    );
    assert.equal(exitCode, undefined, 'exit code not set on success');
  });
});

describe('runPullGuidance --json', () => {
  it('emits { content, has_more } JSON — shape byte-identical to loom_pull_guidance (ADR-002)', () => {
    fs.writeFileSync(
      path.join(tmpDir, '.loom', 'guidance', `${STORY_ID}.md`),
      'Focus on performance next.'
    );

    const { stdout, exitCode } = capture(() => runPullGuidance(STORY_ID, { json: true }));

    assert.equal(exitCode, undefined, 'exit code not set on success');
    const jsonLine = stdout.find((l) => l.trim().startsWith('{'));
    assert.ok(jsonLine, 'JSON line present in stdout');
    const parsed = JSON.parse(jsonLine!) as { content: string | null; has_more: boolean };
    assert.ok('content' in parsed, 'content key present');
    assert.ok('has_more' in parsed, 'has_more key present');
    assert.equal(typeof parsed.has_more, 'boolean', 'has_more is boolean');
    assert.ok(parsed.content !== null && parsed.content.includes('Focus on performance'), 'content has guidance text');
    // Exactly two keys — byte-identical shape to the old MCP payload
    assert.deepEqual(Object.keys(parsed).sort(), ['content', 'has_more']);
  });

  it('emits { content: null, has_more: false } when no guidance exists', () => {
    const { stdout, exitCode } = capture(() => runPullGuidance(STORY_ID, { json: true }));

    assert.equal(exitCode, undefined);
    const jsonLine = stdout.find((l) => l.trim().startsWith('{'));
    assert.ok(jsonLine);
    const parsed = JSON.parse(jsonLine!) as { content: string | null; has_more: boolean };
    assert.equal(parsed.content, null);
    assert.equal(parsed.has_more, false);
  });
});

describe('runPullGuidance — no new guidance', () => {
  it('prints "no new guidance" and exits 0 when there is no guidance file', () => {
    const { stdout, stderr, exitCode } = capture(() => runPullGuidance(STORY_ID));

    assert.ok(stdout.join('\n').includes('no new guidance'), 'no new guidance message on stdout');
    assert.equal(stderr.length, 0, 'nothing on stderr');
    assert.equal(exitCode, undefined, 'exit code not set (exit 0)');
  });

  it('prints "no new guidance" after all content has been consumed', () => {
    fs.writeFileSync(
      path.join(tmpDir, '.loom', 'guidance', `${STORY_ID}.md`),
      'Initial guidance.'
    );

    // First pull — consumes the content
    const first = capture(() => runPullGuidance(STORY_ID));
    assert.ok(first.stdout.join('\n').includes('Initial guidance.'), 'first call returns content');

    // Second pull — offset is at end of file, nothing new
    const second = capture(() => runPullGuidance(STORY_ID));
    assert.ok(second.stdout.join('\n').includes('no new guidance'), 'second call reports no new guidance');
    assert.equal(second.exitCode, undefined, 'exit 0 on second call');
  });
});

describe('runPullGuidance — offset advancement', () => {
  it('second call returns no content after offset advances past end of file', () => {
    const guidanceFile = path.join(tmpDir, '.loom', 'guidance', `${STORY_ID}.md`);
    fs.writeFileSync(guidanceFile, 'First batch of guidance.');

    capture(() => runPullGuidance(STORY_ID)); // consume

    // Verify offset file was written
    const offsetFile = path.join(tmpDir, '.loom', 'guidance', '.pulled', `${STORY_ID}.offset`);
    assert.ok(fs.existsSync(offsetFile), 'offset file created after first pull');
    const offset = parseInt(fs.readFileSync(offsetFile, 'utf8'), 10);
    assert.ok(offset > 0, 'offset advanced past zero');

    // Second call sees no new content
    const { stdout } = capture(() => runPullGuidance(STORY_ID));
    assert.ok(stdout.join('\n').includes('no new guidance'));
  });

  it('appended content is returned on the next pull after offset advances', () => {
    const guidanceFile = path.join(tmpDir, '.loom', 'guidance', `${STORY_ID}.md`);
    fs.writeFileSync(guidanceFile, 'First batch.');

    capture(() => runPullGuidance(STORY_ID)); // consume first batch

    // Append more guidance
    fs.appendFileSync(guidanceFile, '\nSecond batch.');

    const { stdout } = capture(() => runPullGuidance(STORY_ID));
    assert.ok(stdout.join('\n').includes('Second batch.'), 'second pull returns newly appended content');
  });
});

describe('runPullGuidance — error handling', () => {
  it('exits 1 with a single-line stderr message when storyId causes an error (no stack trace)', () => {
    // Passing an empty string triggers pullSince to throw "storyId is required"
    const { stdout, stderr, exitCode } = capture(() => runPullGuidance(''));

    assert.equal(exitCode, 1, 'process.exitCode set to 1');
    assert.equal(stdout.length, 0, 'nothing on stdout');
    assert.ok(stderr.length > 0, 'error message on stderr');

    const errorOutput = stderr.join('\n');
    // Must be a single-line message — no stack trace
    assert.ok(!errorOutput.includes('    at '), 'no stack trace lines');
    assert.ok(!errorOutput.includes('\nError:'), 'no multi-line Error: dump');
    // Message is meaningful
    assert.ok(errorOutput.includes('loom pull-guidance:'), 'message prefixed with command name');
  });
});
