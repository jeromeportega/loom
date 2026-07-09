/**
 * Tests for coverage-check.ts — parseDocumentedTokens + checkCapabilitiesCoverage.
 *
 * UNIT: parse + diff logic against in-memory markdown fixtures (deterministic, no I/O
 *       except a temp-dir schema for the diff cases).
 * INTEGRATION: checkCapabilitiesCoverage() against the real docs/capabilities.md.
 *   NOTE: the AC5 integration test is skipped until story-015-003 adds the coverage
 *   fences to docs/capabilities.md. Remove the .skip when 015-003 merges.
 */
import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Command } from 'commander';
import { parseDocumentedTokens, checkCapabilitiesCoverage } from '../describe/coverage-check.js';

// ─── fixture helpers ──────────────────────────────────────────────────────────

function cmdFence(content: string): string {
  return `<!-- coverage:command:start -->\n${content}\n<!-- coverage:command:end -->`;
}

function knobFence(content: string): string {
  return `<!-- coverage:knob:start -->\n${content}\n<!-- coverage:knob:end -->`;
}

/**
 * Minimal policy.schema.yaml for fixture-based tests.
 * Produces exactly these operator knob tokens:
 *   git.protected_branches, git.allowed_remotes,
 *   agents.max_concurrent, filesystem.protected_paths
 * (agents.internal_field is x-internal → excluded)
 */
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
      allowed_remotes:
        type: array
        items:
          type: string
  agents:
    type: object
    properties:
      max_concurrent:
        type: integer
      internal_field:
        type: integer
        x-internal: true
  filesystem:
    type: object
    properties:
      protected_paths:
        type: array
        items:
          type: string
`;

/** Knob tokens produced by MINIMAL_SCHEMA_YAML. */
const FIXTURE_KNOBS = [
  'git.protected_branches',
  'git.allowed_remotes',
  'agents.max_concurrent',
  'filesystem.protected_paths',
];

const createdDirs: string[] = [];
after(() => {
  for (const dir of createdDirs) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

/** Write a temp dir with the fixture schema and the supplied markdown. */
function buildFixtureDir(markdown: string): string {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'loom-cov-test-'));
  createdDirs.push(tmpDir);
  fs.mkdirSync(path.join(tmpDir, 'schemas'));
  fs.writeFileSync(path.join(tmpDir, 'schemas', 'policy.schema.yaml'), MINIMAL_SCHEMA_YAML);
  fs.mkdirSync(path.join(tmpDir, 'docs'));
  fs.writeFileSync(path.join(tmpDir, 'docs', 'capabilities.md'), markdown);
  return tmpDir;
}

/** Build a Commander program containing the given leaf command names (single-word). */
function makeFabricatedProgram(...names: string[]): Command {
  const program = new Command('loom');
  for (const name of names) {
    program.command(name);
  }
  return program;
}

/** Markdown that fully covers a given command + knob fixture set. */
function fullCoverageMarkdown(commandNames: string[], knobNames: string[]): string {
  const cmdSpans = commandNames.map((n) => `\`loom ${n}\``).join('\n');
  const knobSpans = knobNames.map((n) => `\`policy.${n}\``).join('\n');
  return `${cmdFence(cmdSpans)}\n\n${knobFence(knobSpans)}`;
}

// ─── parseDocumentedTokens — command fence (AC3) ─────────────────────────────

describe('parseDocumentedTokens — command fence scoping [AC3]', () => {
  it('captures tokens inside the fence and ignores identical spans outside', () => {
    const md = [
      'Prose mentions `loom run` outside the fence — must be ignored.',
      '',
      cmdFence('`loom epic`\n`loom init`'),
      '',
      'More prose `loom archive` also outside.',
    ].join('\n');

    const tokens = parseDocumentedTokens(md, 'command');
    assert.ok(tokens.has('epic'), '"epic" inside fence must be captured');
    assert.ok(tokens.has('init'), '"init" inside fence must be captured');
    assert.ok(!tokens.has('run'), '"run" outside fence must be ignored');
    assert.ok(!tokens.has('archive'), '"archive" outside fence must be ignored');
  });

  it('returns empty Set when the command fence is absent (fail-loud)', () => {
    const md = 'No fence here. `loom run` in prose.';
    const tokens = parseDocumentedTokens(md, 'command');
    assert.strictEqual(tokens.size, 0, 'absent fence must yield zero tokens — not silently "covered"');
  });

  it('exact match — `loom run` does NOT satisfy the token "runner" [AC3 anti-substring]', () => {
    const md = cmdFence('`loom run`');
    const tokens = parseDocumentedTokens(md, 'command');
    assert.ok(tokens.has('run'), '"run" must be captured');
    assert.ok(!tokens.has('runner'), '"run" must not satisfy "runner" via substring match');
  });

  it('captures multi-word token "guard check" as a single token', () => {
    const md = cmdFence('`loom guard check`');
    const tokens = parseDocumentedTokens(md, 'command');
    assert.ok(tokens.has('guard check'), '"guard check" must be captured as one token');
    assert.ok(!tokens.has('guard'), '"guard" alone must not appear as a separate token');
    assert.ok(!tokens.has('check'), '"check" alone must not appear as a separate token');
  });

  it('captures all tokens when multiple spans appear inside the fence', () => {
    const md = cmdFence('`loom epic`\n`loom run`\n`loom init`');
    const tokens = parseDocumentedTokens(md, 'command');
    assert.strictEqual(tokens.size, 3);
    assert.ok(tokens.has('epic'));
    assert.ok(tokens.has('run'));
    assert.ok(tokens.has('init'));
  });
});

// ─── parseDocumentedTokens — knob fence (AC3) ────────────────────────────────

describe('parseDocumentedTokens — knob fence scoping [AC3]', () => {
  it('captures tokens inside the knob fence and ignores identical spans outside', () => {
    const md = [
      'Prose mentions `policy.agents.max_concurrent` outside — must be ignored.',
      '',
      knobFence('`policy.git.protected_branches`'),
      '',
      'More prose `policy.filesystem.protected_paths` outside.',
    ].join('\n');

    const tokens = parseDocumentedTokens(md, 'knob');
    assert.ok(tokens.has('git.protected_branches'), '"git.protected_branches" inside fence must be captured');
    assert.ok(!tokens.has('agents.max_concurrent'), '"agents.max_concurrent" outside fence must be ignored');
    assert.ok(!tokens.has('filesystem.protected_paths'), '"filesystem.protected_paths" outside fence must be ignored');
  });

  it('returns empty Set when the knob fence is absent (fail-loud)', () => {
    const md = 'No knob fence here. `policy.agents.max_concurrent` in prose.';
    const tokens = parseDocumentedTokens(md, 'knob');
    assert.strictEqual(tokens.size, 0, 'absent knob fence must yield zero tokens');
  });

  it('exact match — `policy.agents.max` does NOT satisfy "agents.max_concurrent" [AC3 anti-substring]', () => {
    const md = knobFence('`policy.agents.max`');
    const tokens = parseDocumentedTokens(md, 'knob');
    assert.ok(tokens.has('agents.max'), '"agents.max" must be captured');
    assert.ok(
      !tokens.has('agents.max_concurrent'),
      '"agents.max" is a different token from "agents.max_concurrent" — no substring match'
    );
  });

  it('exact match — `policy.agents.max_concurrent` satisfies itself only', () => {
    const md = knobFence('`policy.agents.max_concurrent`');
    const tokens = parseDocumentedTokens(md, 'knob');
    assert.ok(tokens.has('agents.max_concurrent'));
    assert.ok(!tokens.has('agents.max'), '"agents.max" must not be inferred from a longer token');
  });

  it('captures multiple knob tokens from the same fence region', () => {
    const md = knobFence(
      '`policy.git.protected_branches`\n`policy.agents.max_concurrent`\n`policy.filesystem.protected_paths`'
    );
    const tokens = parseDocumentedTokens(md, 'knob');
    assert.ok(tokens.has('git.protected_branches'));
    assert.ok(tokens.has('agents.max_concurrent'));
    assert.ok(tokens.has('filesystem.protected_paths'));
  });
});

// ─── checkCapabilitiesCoverage — [AC1] missing surface ───────────────────────

describe('checkCapabilitiesCoverage — [AC1] missing command', () => {
  it('returns ok:false and lists the omitted command in SurfaceDiff.missing', () => {
    const program = makeFabricatedProgram('cmd-present', 'cmd-absent');
    const md = fullCoverageMarkdown(
      ['cmd-present'], // cmd-absent intentionally omitted from docs
      FIXTURE_KNOBS
    );
    const tmpDir = buildFixtureDir(md);

    const report = checkCapabilitiesCoverage({ root: tmpDir, program });

    assert.ok(!report.ok, 'report must not be ok when a command is missing from docs');
    const cmdDiff = report.diffs.find((d) => d.surface === 'command');
    assert.ok(cmdDiff, 'diffs must include a command entry');
    assert.ok(
      cmdDiff.missing.includes('cmd-absent'),
      `"cmd-absent" must be in missing; got: ${JSON.stringify(cmdDiff.missing)}`
    );
    assert.ok(
      report.messages.some((m) => m.includes('cmd-absent')),
      'messages must name the missing token'
    );
  });
});

describe('checkCapabilitiesCoverage — [AC1] missing knob', () => {
  it('returns ok:false and lists the omitted knob in SurfaceDiff.missing', () => {
    const program = makeFabricatedProgram('my-cmd');
    // agents.max_concurrent intentionally omitted from docs
    const coveredKnobs = FIXTURE_KNOBS.filter((k) => k !== 'agents.max_concurrent');
    const md = fullCoverageMarkdown(['my-cmd'], coveredKnobs);
    const tmpDir = buildFixtureDir(md);

    const report = checkCapabilitiesCoverage({ root: tmpDir, program });

    assert.ok(!report.ok, 'report must not be ok when a knob is missing from docs');
    const knobDiff = report.diffs.find((d) => d.surface === 'knob');
    assert.ok(knobDiff, 'diffs must include a knob entry');
    assert.ok(
      knobDiff.missing.includes('agents.max_concurrent'),
      `"agents.max_concurrent" must be in missing; got: ${JSON.stringify(knobDiff.missing)}`
    );
    assert.ok(
      report.messages.some((m) => m.includes('agents.max_concurrent')),
      'messages must name the missing knob token'
    );
  });
});

// ─── checkCapabilitiesCoverage — [AC2] phantom surface ───────────────────────

describe('checkCapabilitiesCoverage — [AC2] phantom command', () => {
  it('returns ok:false and lists the fictional command in SurfaceDiff.phantom', () => {
    const program = makeFabricatedProgram('real-cmd');
    const md = fullCoverageMarkdown(
      ['real-cmd', 'fictional-nonexistent-cmd'], // fictional-nonexistent-cmd not in live source
      FIXTURE_KNOBS
    );
    const tmpDir = buildFixtureDir(md);

    const report = checkCapabilitiesCoverage({ root: tmpDir, program });

    assert.ok(!report.ok, 'report must not be ok when docs contain a phantom command');
    const cmdDiff = report.diffs.find((d) => d.surface === 'command');
    assert.ok(cmdDiff, 'diffs must include a command entry');
    assert.ok(
      cmdDiff.phantom.includes('fictional-nonexistent-cmd'),
      `"fictional-nonexistent-cmd" must be in phantom; got: ${JSON.stringify(cmdDiff.phantom)}`
    );
    assert.ok(
      report.messages.some((m) => m.includes('fictional-nonexistent-cmd')),
      'messages must name the phantom token'
    );
  });
});

describe('checkCapabilitiesCoverage — [AC2] phantom knob', () => {
  it('returns ok:false and lists the fictional knob in SurfaceDiff.phantom', () => {
    const program = makeFabricatedProgram('my-cmd');
    const md = fullCoverageMarkdown(
      ['my-cmd'],
      [...FIXTURE_KNOBS, 'agents.nonexistent_knob'] // fictional knob not in schema
    );
    const tmpDir = buildFixtureDir(md);

    const report = checkCapabilitiesCoverage({ root: tmpDir, program });

    assert.ok(!report.ok, 'report must not be ok when docs contain a phantom knob');
    const knobDiff = report.diffs.find((d) => d.surface === 'knob');
    assert.ok(knobDiff, 'diffs must include a knob entry');
    assert.ok(
      knobDiff.phantom.includes('agents.nonexistent_knob'),
      `"agents.nonexistent_knob" must be in phantom; got: ${JSON.stringify(knobDiff.phantom)}`
    );
    assert.ok(
      report.messages.some((m) => m.includes('agents.nonexistent_knob')),
      'messages must name the phantom knob token'
    );
  });
});

// ─── checkCapabilitiesCoverage — [AC4] alias tolerance ───────────────────────

describe('checkCapabilitiesCoverage — [AC4] alias tolerance', () => {
  it('a documented alias token is not phantom (it IS in the live source via alias expansion)', () => {
    // Build the program explicitly with the alias so the fixture is self-contained.
    // operatorCommands resolves alias tokens from the spec registry (statusSpec.aliases=['st']),
    // but adding .alias('st') to Commander documents the intent and keeps the test correct
    // even if the resolution strategy changes.
    const program = new Command('loom');
    program.command('status').alias('st');
    // Document only the alias — not the canonical 'status' — to isolate the alias behaviour
    const md = fullCoverageMarkdown(['st'], FIXTURE_KNOBS);
    const tmpDir = buildFixtureDir(md);

    const report = checkCapabilitiesCoverage({ root: tmpDir, program });
    const cmdDiff = report.diffs.find((d) => d.surface === 'command');
    assert.ok(cmdDiff, 'diffs must include a command entry');

    // AC4: the alias 'st' is a legitimate live token — must NOT appear in phantom
    assert.ok(
      !cmdDiff.phantom.includes('st'),
      '"st" is a legitimate alias in the live source — must not be phantom'
    );
    // 'st' is in documented, so NOT in missing either
    assert.ok(
      !cmdDiff.missing.includes('st'),
      '"st" is documented — must not appear in missing'
    );
    // (The canonical 'status' IS missing because we only documented the alias — expected)
    assert.ok(
      cmdDiff.missing.includes('status'),
      '"status" (canonical, not documented) must appear in missing — complementary assertion'
    );
  });

  it('documenting both canonical and alias produces no phantom and no missing for that command', () => {
    const program = new Command('loom');
    program.command('status').alias('st');
    // Document both canonical ('status') and alias ('st')
    const md = fullCoverageMarkdown(['status', 'st'], FIXTURE_KNOBS);
    const tmpDir = buildFixtureDir(md);

    const report = checkCapabilitiesCoverage({ root: tmpDir, program });
    const cmdDiff = report.diffs.find((d) => d.surface === 'command');
    assert.ok(cmdDiff, 'diffs must include a command entry');

    assert.ok(!cmdDiff.phantom.includes('st'), '"st" documented + in live source → not phantom');
    assert.ok(!cmdDiff.missing.includes('st'), '"st" documented → not missing');
    assert.ok(!cmdDiff.phantom.includes('status'), '"status" documented + in live source → not phantom');
    assert.ok(!cmdDiff.missing.includes('status'), '"status" documented → not missing');
  });
});

// ─── checkCapabilitiesCoverage — fail-loud: missing fence ────────────────────

describe('checkCapabilitiesCoverage — fail-loud when fences are absent', () => {
  it('all live commands reported missing when command fence is deleted', () => {
    const program = makeFabricatedProgram('cmd-a', 'cmd-b');
    // Markdown has the knob fence but NO command fence
    const md = knobFence(FIXTURE_KNOBS.map((k) => `\`policy.${k}\``).join('\n'));
    const tmpDir = buildFixtureDir(md);

    const report = checkCapabilitiesCoverage({ root: tmpDir, program });

    assert.ok(!report.ok, 'must be not-ok when command fence is absent');
    const cmdDiff = report.diffs.find((d) => d.surface === 'command');
    assert.ok(cmdDiff, 'diffs must include a command entry');
    assert.ok(
      cmdDiff.missing.includes('cmd-a'),
      '"cmd-a" must be in missing when command fence is absent'
    );
    assert.ok(
      cmdDiff.missing.includes('cmd-b'),
      '"cmd-b" must be in missing when command fence is absent'
    );
    // Zero documented tokens when fence is absent — not a silent pass
    assert.strictEqual(cmdDiff.phantom.length, 0, 'no phantom when fence yields empty set');
  });

  it('all live knobs reported missing when knob fence is deleted', () => {
    const program = makeFabricatedProgram('my-cmd');
    // Markdown has the command fence but NO knob fence
    const md = cmdFence('`loom my-cmd`');
    const tmpDir = buildFixtureDir(md);

    const report = checkCapabilitiesCoverage({ root: tmpDir, program });

    assert.ok(!report.ok, 'must be not-ok when knob fence is absent');
    const knobDiff = report.diffs.find((d) => d.surface === 'knob');
    assert.ok(knobDiff, 'diffs must include a knob entry');
    assert.ok(knobDiff.missing.length > 0, 'some live knobs must appear as missing');
    for (const knob of FIXTURE_KNOBS) {
      assert.ok(
        knobDiff.missing.includes(knob),
        `"${knob}" must be in missing when knob fence is absent`
      );
    }
  });
});

// ─── checkCapabilitiesCoverage — happy path ──────────────────────────────────

describe('checkCapabilitiesCoverage — happy path (ok:true)', () => {
  it('returns ok:true when page fully covers the fixture surface', () => {
    const cmdNames = ['cmd-a', 'cmd-b'];
    const program = makeFabricatedProgram(...cmdNames);
    const md = fullCoverageMarkdown(cmdNames, FIXTURE_KNOBS);
    const tmpDir = buildFixtureDir(md);

    const report = checkCapabilitiesCoverage({ root: tmpDir, program });

    assert.ok(report.ok, `expected ok:true; messages: ${report.messages.join('; ')}`);
    assert.deepStrictEqual(report.messages, [], 'messages must be empty when ok:true');
    assert.strictEqual(report.diffs.length, 2, 'diffs must have exactly two entries');
    for (const diff of report.diffs) {
      assert.deepStrictEqual(diff.missing, [], `${diff.surface}: no missing tokens expected`);
      assert.deepStrictEqual(diff.phantom, [], `${diff.surface}: no phantom tokens expected`);
    }
  });
});

// ─── checkCapabilitiesCoverage — CoverageReport shape ────────────────────────

describe('checkCapabilitiesCoverage — CoverageReport shape', () => {
  it('diffs always contains exactly two entries: surface "command" then "knob"', () => {
    const program = makeFabricatedProgram('my-cmd');
    const md = fullCoverageMarkdown(['my-cmd'], FIXTURE_KNOBS);
    const tmpDir = buildFixtureDir(md);

    const report = checkCapabilitiesCoverage({ root: tmpDir, program });

    assert.strictEqual(report.diffs.length, 2, 'exactly two diff entries');
    assert.strictEqual(report.diffs[0].surface, 'command');
    assert.strictEqual(report.diffs[1].surface, 'knob');
  });

  it('messages is an empty array when ok:true', () => {
    const program = makeFabricatedProgram('my-cmd');
    const md = fullCoverageMarkdown(['my-cmd'], FIXTURE_KNOBS);
    const tmpDir = buildFixtureDir(md);

    const { ok, messages } = checkCapabilitiesCoverage({ root: tmpDir, program });
    assert.ok(ok);
    assert.deepStrictEqual(messages, []);
  });

  it('each SurfaceDiff has sorted missing and phantom arrays', () => {
    const program = makeFabricatedProgram('zzz-cmd', 'aaa-cmd');
    // Document only zzz-cmd + one fictional: 'mmm-fictional'
    const md = fullCoverageMarkdown(['zzz-cmd', 'mmm-fictional'], FIXTURE_KNOBS);
    const tmpDir = buildFixtureDir(md);

    const report = checkCapabilitiesCoverage({ root: tmpDir, program });
    const cmdDiff = report.diffs.find((d) => d.surface === 'command');
    assert.ok(cmdDiff, 'diffs must include a command entry');

    // missing: ['aaa-cmd'] (sorted); phantom: ['mmm-fictional'] (sorted)
    assert.deepStrictEqual(cmdDiff.missing, ['aaa-cmd'], 'missing must be sorted');
    assert.deepStrictEqual(cmdDiff.phantom, ['mmm-fictional'], 'phantom must be sorted');
  });
});

// ─── [AC5] integration test against the real docs/capabilities.md ─────────────
describe('checkCapabilitiesCoverage — [AC5] live capabilities page drift guard', () => {
  it('capabilities.md fully covers the live CLI and policy knob surface', () => {
    const report = checkCapabilitiesCoverage();
    assert.ok(report.ok, report.messages.join('\n'));
  });
});

// ─── [AC5-static] doc content assertions for epic-087 pruning ────────────────

describe('capabilities.md — epic-087 pruned surface (static assertions)', () => {
  const REPO_ROOT = path.resolve(__dirname, '..', '..', '..', '..');
  const CAPABILITIES = path.join(REPO_ROOT, 'docs', 'capabilities.md');
  const doc = fs.readFileSync(CAPABILITIES, 'utf8');

  /**
   * Returns true if any primary markdown table row (starts with |) has the
   * given regex match in the HOW-TO cell (second cell) only.
   * Row format: | **Label** | how-to | notes |
   * We extract just the second cell (the "how to use" column) to identify
   * primary command rows by their invocation, not by prose mentions elsewhere.
   */
  function hasHowToCell(content: string, pattern: RegExp): boolean {
    return content.split('\n').some((line) => {
      const t = line.trimStart();
      if (!t.startsWith('|')) return false;
      // Replace escaped pipes before splitting so \| inside a cell doesn't shift indices.
      const cells = t.replace(/\\\|/g, '\x00').split('|').map((c) => c.replace(/\x00/g, '\\|'));
      const howTo = cells.length >= 3 ? cells[2] : '';
      return pattern.test(howTo);
    });
  }

  /**
   * Returns true if any primary markdown table row has the given regex match
   * in the LABEL cell (first cell).
   */
  function hasLabelRow(content: string, labelPattern: RegExp): boolean {
    return content.split('\n').some((line) => {
      const t = line.trimStart();
      if (!t.startsWith('|')) return false;
      const cells = t.split('|');
      const label = cells.length >= 2 ? cells[1] : '';
      return labelPattern.test(label);
    });
  }

  it('recover appears with a description referencing state-detection', () => {
    assert.ok(
      doc.includes('auto-detect') || doc.includes('auto-detects') || doc.includes('state-detect'),
      'capabilities.md must mention auto-detect state behavior for recover'
    );
    const hasRecoverRow = hasHowToCell(doc, /`loom recover/);
    assert.ok(hasRecoverRow, 'capabilities.md must contain a primary row for `loom recover`');
  });

  it('publish does not appear as a primary command row', () => {
    assert.ok(
      !hasHowToCell(doc, /`loom publish\b/),
      'capabilities.md must not list `loom publish` as a primary command row'
    );
  });

  it('finalize does not appear as a primary command row', () => {
    assert.ok(
      !hasHowToCell(doc, /`loom finalize\b/),
      'capabilities.md must not list `loom finalize` as a primary command row'
    );
  });

  it('reconcile does not appear as a primary command row', () => {
    assert.ok(
      !hasHowToCell(doc, /`loom reconcile\b/),
      'capabilities.md must not list `loom reconcile` as a primary command row'
    );
  });

  it('scan does not appear as a primary command row', () => {
    assert.ok(
      !hasHowToCell(doc, /`loom scan\b/) && !hasLabelRow(doc, /\*\*Run signal scanners\*\*/),
      'capabilities.md must not list `loom scan` as a primary command row'
    );
  });

  it('opportunities does not appear as a primary command row', () => {
    assert.ok(
      !hasHowToCell(doc, /`loom opportunities\b/) && !hasLabelRow(doc, /\*\*Opportunity board\*\*/),
      'capabilities.md must not list `loom opportunities` as a primary command row'
    );
  });

  it('propose does not appear as a primary command row', () => {
    assert.ok(
      !hasHowToCell(doc, /`loom propose\b/) && !hasLabelRow(doc, /\*\*Self-propose/),
      'capabilities.md must not list `loom propose` as a primary command row'
    );
  });

  it('project does not appear as a primary command row', () => {
    assert.ok(
      !hasHowToCell(doc, /`loom project\b/) && !hasLabelRow(doc, /\*\*Single project detail\*\*/),
      'capabilities.md must not list `loom project` as a primary command row'
    );
  });
});
