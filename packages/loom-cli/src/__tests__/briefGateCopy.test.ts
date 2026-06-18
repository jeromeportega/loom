import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

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
// Note: packages/loom-mcp/src/tools/registry.ts was deleted in epic-003 (story-003-001).
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
