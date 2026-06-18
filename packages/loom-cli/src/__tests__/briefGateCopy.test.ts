import { describe, it, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { execSync, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { MockLLMClient, resetDatabaseForTest } from '@loom-ai/core';
import type { LLMRequest, GateVerdict } from '@loom-ai/core';
import { runEpic, spec } from '../commands/epic.js';
import { formatClarificationsNotice } from '../commands/briefGateMessage.js';

// __dirname = packages/loom-cli/dist/__tests__
const LOOM_CLI = path.resolve(__dirname, '../index.js');
const REPO_ROOT = path.resolve(__dirname, '../../../..');

// Needles are assembled from fragments so this test file never contains the
// contiguous phrases it forbids — otherwise the repo-wide sweep below would
// match itself.
const NEGOTIABLE = 'non' + '-negotiable';
const CANNOT_BYPASS = 'cannot be ' + 'bypassed';
const UNBYPASSABLE = 'un' + 'bypassable';
// Gate-specific framing that claims the gate can never be overridden.
const GATE_PHRASES = [NEGOTIABLE, CANNOT_BYPASS, UNBYPASSABLE];
const gatePhraseRe = new RegExp(GATE_PHRASES.join('|'), 'i');
// These two only ever described the gate, so they must be absent repo-wide.
const UNIQUE_PHRASES = [CANNOT_BYPASS, UNBYPASSABLE];

// Files that carry user-facing copy about the brief-quality gate. None of
// them may describe the gate as impossible to override.
// File deleted when loom-mcp package was removed.
const GATE_COPY_FILES = [
  'packages/loom-cli/src/commands/init.ts',
  'docs/capabilities.md',
  'README.md',
  'docs/architecture/brief-refinement.md',
];

// .loom_outputs holds promoted planning artifacts (brief/PRD/architecture of
// delivered epics) — they legitimately quote the stale copy they were written
// to remove, and are committed by the EpicFinalizer AFTER the integration
// gate runs, so they must not count as live gate copy.
const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', '__tests__', '.loom', '.loom_outputs']);

function collectFiles(dir: string, acc: string[]): void {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (SKIP_DIRS.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      collectFiles(full, acc);
    } else if (entry.isFile()) {
      acc.push(full);
    }
  }
}

describe('brief-quality gate copy (story-001-004)', () => {
  let tmpDir: string;

  before(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'loom-gate-copy-'));
    execSync('git init -q', { cwd: tmpDir });
    execSync(`node "${LOOM_CLI}" init`, {
      cwd: tmpDir,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, LOOM_HOME: path.join(tmpDir, '.loom-home') },
    });
  });

  after(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('loom init policy comment documents the --force escape hatch and drops the unbypassable claim', () => {
    const policy = fs.readFileSync(path.join(tmpDir, '.loom', 'policy.yaml'), 'utf8');
    const lines = policy.split('\n');
    const idx = lines.findIndex((l) => l.includes('min_brief_quality_score:'));
    assert.ok(idx > 0, 'policy.yaml should define min_brief_quality_score');

    // The comment block immediately precedes the key.
    let start = idx - 1;
    while (start >= 0 && lines[start].trimStart().startsWith('#')) start--;
    const comment = lines.slice(start + 1, idx).join('\n');

    assert.match(comment, /--force/, 'comment should mention the --force escape hatch');
    assert.match(comment, /force: true/, 'comment should mention the MCP force: true form');
    assert.doesNotMatch(
      comment,
      gatePhraseRe,
      'comment must not claim the gate is impossible to override'
    );
  });

  it('gate-copy files describe the override as an escape hatch, not a disable switch', () => {
    for (const rel of GATE_COPY_FILES) {
      const content = fs.readFileSync(path.join(REPO_ROOT, rel), 'utf8');
      assert.doesNotMatch(content, gatePhraseRe, `${rel} still claims the gate cannot be overridden`);
    }
  });

  it('the gate-specific "unbypassable" phrasing appears nowhere in the repo', () => {
    const files: string[] = [];
    collectFiles(REPO_ROOT, files);
    const offenders: string[] = [];
    for (const file of files) {
      let text: string;
      try {
        text = fs.readFileSync(file, 'utf8');
      } catch {
        continue;
      }
      for (const phrase of UNIQUE_PHRASES) {
        if (text.toLowerCase().includes(phrase.toLowerCase())) {
          offenders.push(`${path.relative(REPO_ROOT, file)} :: "${phrase}"`);
        }
      }
    }
    assert.deepEqual(offenders, [], `stale gate copy found:\n${offenders.join('\n')}`);
  });
});

// ── Pass-with-clarifications message copy (story-012-002) ────────────────────

// Derive the force flag from the spec — same source as the string the function embeds.
const forceOpt = spec.options.find((o) => o.name === '--force');
if (!forceOpt) throw new Error('--force option not found in spec — update FORCE_FLAG');
const FORCE_FLAG = forceOpt.name;

const MOCK_VERDICT: GateVerdict = {
  outcome: 'pass-with-clarifications',
  pass: false,
  ready: false,
  quality_score: 8,
  threshold: 6,
};
const MOCK_QUESTIONS = ['What is the target audience?', 'Which database should be used?'];

describe('formatClarificationsNotice — message content (story-012-002)', () => {
  it('contains a clearly labeled PASSED-with-clarifications header', () => {
    const out = formatClarificationsNotice(MOCK_VERDICT, { questions: MOCK_QUESTIONS });
    assert.match(out, /PASSED-with-clarifications/i);
  });

  it('includes the quality score and threshold', () => {
    const out = formatClarificationsNotice(MOCK_VERDICT, { questions: MOCK_QUESTIONS });
    assert.match(out, /8\/10/);
    assert.match(out, /6/);
  });

  it('frames the open questions as OPTIONAL, not required', () => {
    const out = formatClarificationsNotice(MOCK_VERDICT, { questions: MOCK_QUESTIONS });
    assert.match(out, /OPTIONAL/i);
    for (const q of MOCK_QUESTIONS) {
      assert.ok(out.includes(q), `question should appear in output: ${q}`);
    }
  });

  it(`names the actual force flag (${FORCE_FLAG}) as the way to plan as-is`, () => {
    const out = formatClarificationsNotice(MOCK_VERDICT, { questions: MOCK_QUESTIONS });
    assert.ok(out.includes(FORCE_FLAG), `output must embed the force flag "${FORCE_FLAG}" (from spec)`);
  });

  it('does not reuse below-threshold rejection phrasing', () => {
    const out = formatClarificationsNotice(MOCK_VERDICT, { questions: MOCK_QUESTIONS });
    // below-threshold uses "Open questions to address:" to label its questions
    assert.doesNotMatch(out, /open questions to address/i);
    // below-threshold uses "need >= N" in its score line
    assert.doesNotMatch(out, /need >=/i);
    // below-threshold closes with "Tighten the brief above and re-run"
    assert.doesNotMatch(out, /tighten the brief above/i);
  });

  it('gracefully handles an empty questions list (no OPTIONAL section rendered)', () => {
    const out = formatClarificationsNotice(MOCK_VERDICT, { questions: [] });
    assert.match(out, /PASSED-with-clarifications/i);
    assert.doesNotMatch(out, /OPTIONAL/);
    // The --force option must still be present even without clarifications
    assert.match(out, /--force/);
    // The "resolve these clarifications" phrase must not appear when there are none
    assert.doesNotMatch(out, /resolve these clarifications/);
  });
});

// ── Integration tests via runEpic + captured output ────────────────────────────

function passthroughLLM(opts: { ready: boolean; score: number; questions?: string[] }) {
  return (req: LLMRequest): string => {
    const last = req.messages[req.messages.length - 1].content;
    // Discriminates the BriefRefiner call by a stable substring in its user message
    // (BriefRefiner.ts:95). This coupling is shared across multiple test files.
    if (last.includes('Apply the discipline above')) {
      return (
        '```json\n' +
        JSON.stringify({
          ready: opts.ready,
          quality_score: opts.score,
          refined_brief: '# Brief\n\n## Goal\nShip it.',
          critique: {
            strong_points: [],
            ambiguities: [],
            missing_scope: [],
            untestable_claims: [],
            hidden_complexity: [],
          },
          questions: opts.questions ?? MOCK_QUESTIONS,
          delta: { added_sections: [], clarifications: [], flagged_assumptions: [] },
        }) +
        '\n```'
      );
    }
    // For any other LLM call (e.g., planning personas after gate), return a neutral
    // stub. The gate exits at code 3 before reaching the planner, so these should
    // not be reached on the tested path — but a stub avoids confusing failures if
    // the pipeline ever makes an extra call.
    return '{}';
  };
}

async function captureEpic(
  brief: string,
  opts: { force?: boolean; llm: MockLLMClient }
): Promise<{ stdout: string; stderr: string; exitCode: number | null }> {
  const origExit = process.exit;
  const origLog = console.log;
  const origErr = console.error;
  let exitCode: number | null = null;
  let exited = false;
  let stdout = '';
  let stderr = '';
  class ExitSignal extends Error {}
  (process as unknown as { exit: (c?: number) => never }).exit = (c?: number) => {
    // Only record the first exit code — a second call (e.g., from a dangling async
    // operation after the first exit) would silently overwrite the one the test cares about.
    if (!exited) { exitCode = c ?? 0; exited = true; }
    throw new ExitSignal();
  };
  console.log = (...args: unknown[]) => {
    stdout += args.join(' ') + '\n';
  };
  console.error = (...args: unknown[]) => {
    stderr += args.join(' ') + '\n';
  };
  try {
    await runEpic(brief, opts);
  } catch (err) {
    if (!(err instanceof ExitSignal)) throw err;
  } finally {
    process.exit = origExit;
    console.log = origLog;
    console.error = origErr;
  }
  return { stdout, stderr, exitCode };
}

describe('pass-with-clarifications integration (story-012-002)', () => {
  const LOOM_CLI_PATH = path.resolve(__dirname, '../index.js');
  let tmpDir: string;
  let prevCwd: string;
  let loomHomeDir: string;
  let prevLoomHome: string | undefined;

  beforeEach(() => {
    prevLoomHome = process.env.LOOM_HOME;
    loomHomeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'loom-clarif-home-'));
    process.env.LOOM_HOME = loomHomeDir;

    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'loom-clarif-'));
    execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: tmpDir });
    execFileSync('git', ['config', 'user.email', 'test@loom.dev'], { cwd: tmpDir });
    execFileSync('git', ['config', 'user.name', 'Loom Test'], { cwd: tmpDir });
    execFileSync('git', ['config', 'commit.gpgsign', 'false'], { cwd: tmpDir });
    fs.writeFileSync(path.join(tmpDir, 'README.md'), '# test\n');
    execFileSync('git', ['add', '.'], { cwd: tmpDir });
    execFileSync('git', ['commit', '-q', '-m', 'initial'], { cwd: tmpDir });
    execFileSync('node', [LOOM_CLI_PATH, 'init'], { cwd: tmpDir, stdio: 'ignore' });

    prevCwd = process.cwd();
    process.chdir(tmpDir);
    resetDatabaseForTest();
  });

  afterEach(() => {
    process.chdir(prevCwd);
    resetDatabaseForTest();
    fs.rmSync(tmpDir, { recursive: true, force: true });
    fs.rmSync(loomHomeDir, { recursive: true, force: true });
    if (prevLoomHome === undefined) delete process.env.LOOM_HOME;
    else process.env.LOOM_HOME = prevLoomHome;
  });

  const BRIEF = 'Build a demo feature to verify the pass-with-clarifications integration path.';

  it('exits 3 and emits PASSED-with-clarifications header in output', async () => {
    const llm = new MockLLMClient(passthroughLLM({ ready: false, score: 8 }));
    const { stdout, stderr, exitCode } = await captureEpic(BRIEF, { force: false, llm });
    assert.equal(exitCode, 3);
    const combined = stdout + stderr;
    assert.match(combined, /PASSED-with-clarifications/i);
  });

  it('frames clarifications as OPTIONAL, not as an error directive', async () => {
    const llm = new MockLLMClient(passthroughLLM({ ready: false, score: 8 }));
    const { stdout, stderr, exitCode } = await captureEpic(BRIEF, { force: false, llm });
    assert.equal(exitCode, 3);
    const combined = stdout + stderr;
    assert.match(combined, /OPTIONAL/i);
    assert.doesNotMatch(combined, /open questions to address/i);
  });

  it(`names the actual force flag (${FORCE_FLAG}) as the planning path`, async () => {
    const llm = new MockLLMClient(passthroughLLM({ ready: false, score: 8 }));
    const { stdout, stderr, exitCode } = await captureEpic(BRIEF, { force: false, llm });
    assert.equal(exitCode, 3);
    const combined = stdout + stderr;
    assert.ok(
      combined.includes(FORCE_FLAG),
      `output must name the force flag "${FORCE_FLAG}" (from spec)`
    );
  });

  it('output does not reuse the below-threshold rejection label or phrasing', async () => {
    const llm = new MockLLMClient(passthroughLLM({ ready: false, score: 8 }));
    const { stdout, stderr } = await captureEpic(BRIEF, { force: false, llm });
    const combined = stdout + stderr;
    // below-threshold uses "need >= N" in its score header; pass-with-clarifications must not
    assert.doesNotMatch(combined, /need >=/i);
    // below-threshold closes with "Tighten the brief above and re-run"
    assert.doesNotMatch(combined, /tighten the brief above/i);
  });
});
