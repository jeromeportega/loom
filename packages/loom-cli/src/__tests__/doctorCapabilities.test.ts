/**
 * Tests for `loom doctor --capabilities` (story-015-004).
 *
 * INTEGRATION: exercises the mode dispatch + reporting path.
 * - AC1: runCapabilitiesMode calls checkCapabilitiesCoverage and surfaces its result.
 * - AC2 consistency: the doctor mode reports ok/fail and messages that exactly match the
 *   CoverageReport returned by checkCapabilitiesCoverage on the same fixture root.
 * - Mode dispatch: `loom doctor --capabilities` via subprocess exits 0 (best-effort).
 *
 * Matching logic is already unit-covered in story-015-002. This file does NOT
 * re-test parseDocumentedTokens or checkCapabilitiesCoverage internals.
 */
import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Command } from 'commander';
import { runCapabilitiesMode } from '../commands/doctor.js';
import { checkCapabilitiesCoverage } from '../describe/coverage-check.js';

// ─── fixture helpers ──────────────────────────────────────────────────────────

const MINIMAL_SCHEMA_YAML = `\
type: object
properties:
  git:
    type: object
    properties:
      protected_branches:
        type: array
        items:
          type: string
  agents:
    type: object
    properties:
      max_concurrent:
        type: integer
  filesystem:
    type: object
    properties:
      protected_paths:
        type: array
        items:
          type: string
`;

const FIXTURE_KNOBS = ['git.protected_branches', 'agents.max_concurrent', 'filesystem.protected_paths'];

function cmdFence(content: string): string {
  return `<!-- coverage:command:start -->\n${content}\n<!-- coverage:command:end -->`;
}

function knobFence(content: string): string {
  return `<!-- coverage:knob:start -->\n${content}\n<!-- coverage:knob:end -->`;
}

function fullCoverageMarkdown(commandNames: string[], knobNames: string[]): string {
  const cmdSpans = commandNames.map((n) => `\`loom ${n}\``).join('\n');
  const knobSpans = knobNames.map((n) => `\`policy.${n}\``).join('\n');
  return `${cmdFence(cmdSpans)}\n\n${knobFence(knobSpans)}`;
}

const createdDirs: string[] = [];
after(() => {
  for (const dir of createdDirs) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function buildFixtureDir(markdown: string): string {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'loom-dr-cap-'));
  createdDirs.push(tmpDir);
  fs.mkdirSync(path.join(tmpDir, 'schemas'));
  fs.writeFileSync(path.join(tmpDir, 'schemas', 'policy.schema.yaml'), MINIMAL_SCHEMA_YAML);
  fs.mkdirSync(path.join(tmpDir, 'docs'));
  fs.writeFileSync(path.join(tmpDir, 'docs', 'capabilities.md'), markdown);
  return tmpDir;
}

function makeFabricatedProgram(...names: string[]): Command {
  const program = new Command('loom');
  for (const name of names) {
    program.command(name);
  }
  return program;
}

/** Capture console.log lines emitted by fn(). */
function captureLog(fn: () => void): string[] {
  const lines: string[] = [];
  const orig = console.log;
  console.log = (...args: unknown[]) => lines.push(args.map(String).join(' '));
  try {
    fn();
  } finally {
    console.log = orig;
  }
  return lines;
}

// ─── AC1: runCapabilitiesMode invokes checkCapabilitiesCoverage ───────────────

describe('runCapabilitiesMode — AC1: surfaces a capabilities coverage check', () => {
  it('emits a "capabilities coverage" check line', () => {
    const program = makeFabricatedProgram('cmd-a');
    const root = buildFixtureDir(fullCoverageMarkdown(['cmd-a'], FIXTURE_KNOBS));

    const lines = captureLog(() => runCapabilitiesMode({ program, root }));

    assert.ok(
      lines.some((l) => l.includes('capabilities coverage')),
      `expected a "capabilities coverage" line; got:\n${lines.join('\n')}`
    );
  });

  it('emits an [ok  ] mark when coverage is complete', () => {
    const program = makeFabricatedProgram('cmd-ok');
    const root = buildFixtureDir(fullCoverageMarkdown(['cmd-ok'], FIXTURE_KNOBS));

    const lines = captureLog(() => runCapabilitiesMode({ program, root }));
    const checkLine = lines.find((l) => l.includes('capabilities coverage'));

    assert.ok(checkLine, 'check line must be present');
    assert.ok(checkLine!.includes('[ok  ]'), `expected [ok  ]; got: ${checkLine}`);
  });

  it('emits a [warn] mark when drift is detected', () => {
    const program = makeFabricatedProgram('cmd-missing');
    // No command fence → all commands report as missing
    const root = buildFixtureDir(knobFence(FIXTURE_KNOBS.map((k) => `\`policy.${k}\``).join('\n')));

    const lines = captureLog(() => runCapabilitiesMode({ program, root }));
    const checkLine = lines.find((l) => l.includes('capabilities coverage'));

    assert.ok(checkLine, 'check line must be present');
    assert.ok(checkLine!.includes('[warn]'), `expected [warn]; got: ${checkLine}`);
  });

  it('emits the mode header "loom doctor --capabilities"', () => {
    const program = makeFabricatedProgram('cmd-a');
    const root = buildFixtureDir(fullCoverageMarkdown(['cmd-a'], FIXTURE_KNOBS));

    const lines = captureLog(() => runCapabilitiesMode({ program, root }));

    assert.ok(
      lines.some((l) => l.includes('loom doctor --capabilities')),
      `expected mode header; got:\n${lines.join('\n')}`
    );
  });
});

// ─── AC2: consistency with checkCapabilitiesCoverage ─────────────────────────

describe('runCapabilitiesMode — AC2: consistent with checkCapabilitiesCoverage (ADR-2)', () => {
  it('reports ok:true iff checkCapabilitiesCoverage returns ok:true (passing fixture)', () => {
    const cmdNames = ['alpha', 'beta'];
    const program = makeFabricatedProgram(...cmdNames);
    const root = buildFixtureDir(fullCoverageMarkdown(cmdNames, FIXTURE_KNOBS));

    const report = checkCapabilitiesCoverage({ program, root });
    const lines = captureLog(() => runCapabilitiesMode({ program, root }));
    const checkLine = lines.find((l) => l.includes('capabilities coverage'));

    assert.ok(report.ok, 'fixture should produce ok:true');
    assert.ok(checkLine, 'check line must be present');
    assert.ok(checkLine!.includes('[ok  ]'), `report.ok is true but doctor shows: ${checkLine}`);
  });

  it('reports ok:false iff checkCapabilitiesCoverage returns ok:false (drift fixture)', () => {
    const program = makeFabricatedProgram('live-cmd', 'undocumented-cmd');
    // only live-cmd is documented → undocumented-cmd is missing
    const root = buildFixtureDir(fullCoverageMarkdown(['live-cmd'], FIXTURE_KNOBS));

    const report = checkCapabilitiesCoverage({ program, root });
    const lines = captureLog(() => runCapabilitiesMode({ program, root }));
    const checkLine = lines.find((l) => l.includes('capabilities coverage'));

    assert.ok(!report.ok, 'fixture should produce ok:false');
    assert.ok(checkLine, 'check line must be present');
    assert.ok(checkLine!.includes('[warn]'), `report.ok is false but doctor shows: ${checkLine}`);
  });

  it('emits every report.messages line when drift is detected', () => {
    const program = makeFabricatedProgram('cmd-present', 'cmd-absent');
    const root = buildFixtureDir(fullCoverageMarkdown(['cmd-present'], FIXTURE_KNOBS));

    const report = checkCapabilitiesCoverage({ program, root });
    const lines = captureLog(() => runCapabilitiesMode({ program, root }));

    assert.ok(!report.ok, 'fixture must have drift');
    assert.ok(report.messages.length > 0, 'fixture must produce messages');
    for (const msg of report.messages) {
      assert.ok(
        lines.some((l) => l.includes(msg)),
        `expected message "${msg}" in output; got:\n${lines.join('\n')}`
      );
    }
  });

  it('emits no drift messages when coverage is complete', () => {
    const cmdNames = ['gamma', 'delta'];
    const program = makeFabricatedProgram(...cmdNames);
    const root = buildFixtureDir(fullCoverageMarkdown(cmdNames, FIXTURE_KNOBS));

    const report = checkCapabilitiesCoverage({ program, root });
    const lines = captureLog(() => runCapabilitiesMode({ program, root }));

    assert.ok(report.ok, 'fixture must be ok');
    assert.deepStrictEqual(report.messages, [], 'no messages expected when ok');
    // No drift content in output
    assert.ok(
      !lines.some((l) => l.includes('missing from docs') || l.includes('absent from live')),
      'no drift message lines expected when ok'
    );
  });

  it('output check status exactly matches report.ok for both happy and failing fixtures', () => {
    const passingProgram = makeFabricatedProgram('one-cmd');
    const passingRoot = buildFixtureDir(fullCoverageMarkdown(['one-cmd'], FIXTURE_KNOBS));

    const failingProgram = makeFabricatedProgram('one-cmd', 'two-cmd');
    const failingRoot = buildFixtureDir(fullCoverageMarkdown(['one-cmd'], FIXTURE_KNOBS));

    const passingReport = checkCapabilitiesCoverage({ program: passingProgram, root: passingRoot });
    const failingReport = checkCapabilitiesCoverage({ program: failingProgram, root: failingRoot });

    const passingLines = captureLog(() => runCapabilitiesMode({ program: passingProgram, root: passingRoot }));
    const failingLines = captureLog(() => runCapabilitiesMode({ program: failingProgram, root: failingRoot }));

    const passingCheckLine = passingLines.find((l) => l.includes('capabilities coverage'));
    const failingCheckLine = failingLines.find((l) => l.includes('capabilities coverage'));

    assert.ok(passingReport.ok, 'passing fixture: ok must be true');
    assert.ok(!failingReport.ok, 'failing fixture: ok must be false');
    assert.ok(passingCheckLine!.includes('[ok  ]'), 'passing fixture: doctor must show [ok  ]');
    assert.ok(failingCheckLine!.includes('[warn]'), 'failing fixture: doctor must show [warn]');
  });
});

// ─── Mode dispatch: subprocess test ──────────────────────────────────────────

describe('loom doctor --capabilities — subprocess mode dispatch', () => {
  const LOOM_CLI = path.resolve(__dirname, '../index.js');

  function doctorCapabilities(cwd: string): { stdout: string; status: number } {
    try {
      const stdout = execSync(`node "${LOOM_CLI}" doctor --capabilities`, {
        cwd,
        encoding: 'utf8',
        stdio: ['pipe', 'pipe', 'pipe'],
        env: { ...process.env, LOOM_HOME: path.join(cwd, '.loom-home') },
      });
      return { stdout, status: 0 };
    } catch (err: unknown) {
      const e = err as { stdout?: string; status?: number };
      return { stdout: e.stdout ?? '', status: e.status ?? 1 };
    }
  }

  it('exits 0 regardless of drift status (best-effort, required:false)', () => {
    // Run against a temp dir that has no capabilities.md — the check will warn but exit 0.
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'loom-dr-sub-'));
    createdDirs.push(tmpDir);

    const result = doctorCapabilities(tmpDir);
    assert.equal(result.status, 0, `expected exit 0; got ${result.status}\n${result.stdout}`);
  });

  it('includes "capabilities coverage" in subprocess output', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'loom-dr-sub2-'));
    createdDirs.push(tmpDir);

    const result = doctorCapabilities(tmpDir);
    assert.ok(
      result.stdout.includes('capabilities coverage'),
      `expected "capabilities coverage" in output; got:\n${result.stdout}`
    );
  });

  it('includes "loom doctor --capabilities" mode header in subprocess output', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'loom-dr-sub3-'));
    createdDirs.push(tmpDir);

    const result = doctorCapabilities(tmpDir);
    assert.ok(
      result.stdout.includes('loom doctor --capabilities'),
      `expected mode header in output; got:\n${result.stdout}`
    );
  });
});
