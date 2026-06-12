import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDatabase, EpicStore, resetDatabaseForTest } from '@loom-ai/core';

// __dirname = packages/loom-cli/dist/__tests__
const LOOM_CLI = path.resolve(__dirname, '../index.js');
const REPO_ROOT = path.resolve(__dirname, '../../../..');

// Needles are assembled from fragments so this test file never contains the
// contiguous phrases it forbids — otherwise the sweep below would match itself.
const DISPATCH_BACKGROUND = 'dispatch in the ' + 'background';
const DISPATCHES_WORKERS = 'dispatches ' + 'workers';
const START_STORY_DISPATCH = 'start story ' + 'dispatch';

// The trailing hint `loom approve` must end with — assembled in fragments so
// the sweep's "approve claims dispatch" heuristic never trips on this file.
const RUN_HINT = 'run `loom ' + 'run <epic-id>` to ' + 'dispatch.';

// The CLI command token (with a space) — distinct from the MCP tool
// `loom_approve_plan`, whose historical background-dispatch behavior is
// described in docs/reviews + the MCP runbook and is out of scope here.
const APPROVE_CMD = 'loom ' + 'approve';
const RUN_CMD = 'loom ' + 'run';

// Live source roots for the copy sweep. Excludes .loom_outputs/ (promoted
// planning artifacts of delivered epics — frozen historical copy committed by
// the EpicFinalizer, not live operator-facing source).
const LIVE_ROOTS = [
  'docs',
  '.claude/skills',
  '.agents/skills',
  'packages/loom-cli/src',
];

const SKIP_DIRS = new Set([
  'node_modules',
  '.git',
  'dist',
  '__tests__',
  '.loom',
  '.loom_outputs',
]);

function collectFiles(dir: string, acc: string[]): void {
  if (!fs.existsSync(dir)) return;
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

/**
 * A line falsely claims `loom approve` (the CLI) dispatches workers when it
 * mentions the `loom approve` command alongside a dispatch claim but does NOT
 * name `loom run` as the dispatcher. Truthful copy either omits the dispatch
 * claim or hands dispatch to `loom run` on the same line.
 */
function lineFalselyClaimsApproveDispatches(line: string): boolean {
  const lower = line.toLowerCase();
  if (!lower.includes(APPROVE_CMD)) return false;
  // `loom_approve_plan` is the MCP tool, not the CLI command — exclude it.
  const mentionsCliApprove = /loom approve\b/i.test(line);
  if (!mentionsCliApprove) return false;
  const claimsDispatch = /dispatch/i.test(line);
  if (!claimsDispatch) return false;
  // Truthful: dispatch attributed to `loom run` on the same line.
  if (lower.includes(RUN_CMD)) return false;
  return true;
}

describe('loom approve copy sweep — no false dispatch claim (story-007-003)', () => {
  it('no live doc/skill/CLI source claims `loom approve` dispatches workers', () => {
    const files: string[] = [];
    for (const root of LIVE_ROOTS) {
      collectFiles(path.join(REPO_ROOT, root), files);
    }
    assert.ok(files.length > 0, 'sweep should find live source files to scan');

    const offenders: string[] = [];
    for (const file of files) {
      let text: string;
      try {
        text = fs.readFileSync(file, 'utf8');
      } catch {
        continue;
      }
      const lines = text.split('\n');
      lines.forEach((line, i) => {
        if (lineFalselyClaimsApproveDispatches(line)) {
          offenders.push(`${path.relative(REPO_ROOT, file)}:${i + 1} :: ${line.trim()}`);
        }
      });
    }
    assert.deepEqual(
      offenders,
      [],
      `live source falsely claims \`loom approve\` dispatches workers:\n${offenders.join('\n')}`
    );
  });

  it('the loom-approve copy surfaces carry no dispatch-attributing phrasing', () => {
    // The skill copy lives in init.ts's SLASH_COMMANDS template (generated into
    // .claude/skills/loom-approve) and in the committed .agents skill. These two
    // CLI/skill surfaces describe `loom approve` itself, so the phrasings that
    // once attributed dispatch to it must be absent. (Docs prose about the MCP
    // tool `loom_approve_plan` is a separate, out-of-scope surface.)
    const approveCopySources = [
      'packages/loom-cli/src/commands/init.ts',
      '.agents/skills/loom-approve/SKILL.md',
    ];
    const phrasings = [DISPATCH_BACKGROUND, START_STORY_DISPATCH];
    const offenders: string[] = [];
    for (const rel of approveCopySources) {
      const text = fs.readFileSync(path.join(REPO_ROOT, rel), 'utf8').toLowerCase();
      for (const phrase of phrasings) {
        if (text.includes(phrase.toLowerCase())) {
          offenders.push(`${rel} :: "${phrase}"`);
        }
      }
    }
    assert.deepEqual(
      offenders,
      [],
      `loom-approve copy still attributes dispatch to approve:\n${offenders.join('\n')}`
    );
  });

  it('the sweep excludes .loom_outputs/ — a planted match there does not fail it', () => {
    // Plant an offending line under a fake .loom_outputs/ tree and confirm the
    // collector skips it (the exclusion is load-bearing: delivered epics' frozen
    // planning artifacts legitimately quote the very copy this story removes).
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'loom-sweep-exclude-'));
    try {
      const outDir = path.join(tmp, '.loom_outputs', 'epic-001');
      fs.mkdirSync(outDir, { recursive: true });
      const planted = `${APPROVE_CMD} ${DISPATCHES_WORKERS}\n`;
      fs.writeFileSync(path.join(outDir, 'architecture.md'), planted);
      // Sanity: the planted line WOULD be flagged if it were live.
      assert.ok(
        lineFalselyClaimsApproveDispatches(planted.trim()),
        'planted line must be an offender by the heuristic'
      );

      const collected: string[] = [];
      collectFiles(tmp, collected);
      const sawPlanted = collected.some((f) => f.includes('.loom_outputs'));
      assert.equal(
        sawPlanted,
        false,
        '.loom_outputs/ must be excluded from the live-source sweep'
      );
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('both loom-approve skill files drop the "dispatch in the background" claim', () => {
    // .agents/skills/loom-approve/SKILL.md is a committed live source.
    const agentsSkill = fs.readFileSync(
      path.join(REPO_ROOT, '.agents/skills/loom-approve/SKILL.md'),
      'utf8'
    );
    assert.ok(
      !agentsSkill.toLowerCase().includes(DISPATCH_BACKGROUND.toLowerCase()),
      '.agents/skills/loom-approve/SKILL.md must not claim background dispatch'
    );
    assert.ok(
      !agentsSkill.toLowerCase().includes(START_STORY_DISPATCH.toLowerCase()),
      '.agents/skills/loom-approve/SKILL.md must not claim it starts story dispatch'
    );
    assert.match(
      agentsSkill,
      /loom run/,
      '.agents/skills/loom-approve/SKILL.md should hand dispatch to `loom run`'
    );

    // .claude/skills/loom-approve/SKILL.md is generated by `loom init` from the
    // SLASH_COMMANDS template in init.ts (and gitignored once generated), so we
    // assert on the freshly generated file.
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'loom-approve-skill-'));
    try {
      execSync('git init -q', { cwd: tmp });
      execSync(`node "${LOOM_CLI}" init`, {
        cwd: tmp,
        stdio: ['pipe', 'pipe', 'pipe'],
        env: { ...process.env, LOOM_HOME: path.join(tmp, '.loom-home') },
      });
      const claudeSkill = fs.readFileSync(
        path.join(tmp, '.claude', 'skills', 'loom-approve', 'SKILL.md'),
        'utf8'
      );
      assert.ok(
        !claudeSkill.toLowerCase().includes(DISPATCH_BACKGROUND.toLowerCase()),
        'generated .claude/skills/loom-approve/SKILL.md must not claim background dispatch'
      );
      assert.ok(
        !claudeSkill.toLowerCase().includes(START_STORY_DISPATCH.toLowerCase()),
        'generated .claude/skills/loom-approve/SKILL.md must not claim it starts story dispatch'
      );
      assert.match(
        claudeSkill,
        /loom run/,
        'generated .claude/skills/loom-approve/SKILL.md should hand dispatch to `loom run`'
      );
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe('runApprove success copy ends with the run-hint (story-007-003)', () => {
  let tmpDir: string;

  function loom(cmdSuffix: string): { stdout: string; stderr: string; status: number } {
    try {
      const stdout = execSync(`node "${LOOM_CLI}" ${cmdSuffix}`, {
        cwd: tmpDir,
        encoding: 'utf8',
        stdio: ['pipe', 'pipe', 'pipe'],
        env: { ...process.env, LOOM_HOME: path.join(tmpDir, '.loom-home') },
      });
      return { stdout, stderr: '', status: 0 };
    } catch (err: unknown) {
      const e = err as { stdout?: string; stderr?: string; status?: number };
      return { stdout: e.stdout ?? '', stderr: e.stderr ?? '', status: e.status ?? 1 };
    }
  }

  before(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'loom-approve-copy-'));
    execSync('git init -q', { cwd: tmpDir });
    loom('init');
    resetDatabaseForTest();
    const db = openDatabase(path.join(tmpDir, '.loom'));
    const store = new EpicStore(db);
    store.create('epic-001', 'First seeded epic');
    store.create('epic-002', 'Second seeded epic');
    resetDatabaseForTest();
  });

  after(() => {
    resetDatabaseForTest();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('single-epic approve ends with the literal `loom run <epic-id>` dispatch hint', () => {
    const result = loom('approve epic-001');
    assert.equal(result.status, 0);
    const trimmed = result.stdout.trimEnd();
    assert.ok(
      trimmed.endsWith(RUN_HINT),
      `approve copy must END WITH the run-hint.\nGot:\n${result.stdout}`
    );
  });

  it('bulk approve also ends with the literal `loom run <epic-id>` dispatch hint', () => {
    // epic-002 is still planned; bare `loom approve` approves all planned.
    const result = loom('approve');
    assert.equal(result.status, 0);
    const trimmed = result.stdout.trimEnd();
    assert.ok(
      trimmed.endsWith(RUN_HINT),
      `bulk approve copy must END WITH the run-hint.\nGot:\n${result.stdout}`
    );
  });
});
