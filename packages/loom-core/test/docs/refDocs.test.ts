/**
 * Reference-doc assertions for story-064-003.
 *
 * Verifies that the command/workflow reference pages (getting-started,
 * configuration, cli-command-descriptions) cover the seven shipped topics
 * required by AC1, apply the three canonical corrections verbatim (AC3),
 * and do not introduce phantom command/knob tokens not present in the live
 * capabilities fences (the critical subset boundary).
 *
 * docs/capabilities.md is READ-ONLY for this story (ADR-006). The fence
 * content is verified unchanged; the live token sets come from the fences.
 */
import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

// ─── Canonical correction strings (must appear verbatim, whitespace-normalised) ─

const ARTIFACT_RELOCATION =
  'Delivered artifacts live in the loom-home control plane; target repositories receive only code pull requests.';

const CROSS_REPO_LANDING =
  'A single-repo epic produces one pull request. A cross-repo epic produces one pull request per repository, landed in topological (dependency) order with all-ready-or-none staging and forward-revert rollback.';

const CONFIG_HIERARCHY =
  'loom-home team config (base)  ←  target-repo policy.yaml (override)  ←  env vars (secrets / final override)';

// ─── Repo root resolution ────────────────────────────────────────────────────

function findRepoRoot(): string {
  let dir = __dirname;
  for (let i = 0; i < 12; i++) {
    if (
      fs.existsSync(path.join(dir, 'packages', 'loom-core')) &&
      fs.existsSync(path.join(dir, 'packages', 'loom-cli'))
    ) {
      return dir;
    }
    dir = path.dirname(dir);
  }
  throw new Error('refDocs.test: could not locate monorepo root');
}

function readDoc(relative: string): string {
  return fs.readFileSync(path.join(findRepoRoot(), relative), 'utf8');
}

/** Normalise runs of whitespace (including newlines) to a single space. */
function ws(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}

// ─── Parse documented tokens from a markdown page (regex mirrors coverage-check.ts) ─

/**
 * Extract base command paths from `loom <...>` code spans in markdown.
 *
 * The capabilities fence records bare subcommand paths (e.g. "run", "guard check").
 * Reference docs use the full invocation form with flags and arguments
 * (e.g. "`loom run --verbose`", "`loom retry <story-id>`"). We normalise
 * by keeping only the leading words that are not flags/args — stopping at
 * the first word that starts with `-`, `<`, `[`, `"`, `'`, or contains `…`.
 *
 * This lets "`loom run --checkpoint epic`" → "run" and
 * "`loom guard check`" → "guard check", while "`loom …`" → skipped.
 */
function parseCommandTokens(markdown: string): Set<string> {
  const re = /`loom (\S[^`]*)`/g;
  const tokens = new Set<string>();
  let m: RegExpExecArray | null;
  while ((m = re.exec(markdown)) !== null) {
    const words = m[1].trim().split(/\s+/);
    const commandWords: string[] = [];
    for (const w of words) {
      // Stop at flags, positional placeholders, optional blocks, quoted args, ellipses, or chaining
      if (/^[-<\["']/.test(w) || w.includes('…') || w === '&&' || w === '||') break;
      commandWords.push(w);
    }
    if (commandWords.length > 0) {
      tokens.add(commandWords.join(' '));
    }
  }
  return tokens;
}

function parseKnobTokens(markdown: string): Set<string> {
  const re = /`policy\.([^`]+)`/g;
  const tokens = new Set<string>();
  let m: RegExpExecArray | null;
  while ((m = re.exec(markdown)) !== null) {
    tokens.add(m[1].trim());
  }
  return tokens;
}

// ─── Parse live token sets from capabilities.md fences ───────────────────────

const FENCE = {
  command: { start: '<!-- coverage:command:start -->', end: '<!-- coverage:command:end -->' },
  knob: { start: '<!-- coverage:knob:start -->', end: '<!-- coverage:knob:end -->' },
} as const;

function parseFenceTokens(markdown: string, kind: 'command' | 'knob'): Set<string> {
  const { start, end } = FENCE[kind];
  const si = markdown.indexOf(start);
  const ei = markdown.indexOf(end);
  if (si === -1 || ei === -1 || ei <= si) return new Set();
  const region = markdown.slice(si + start.length, ei);
  const re =
    kind === 'command'
      ? /`loom (\S[^`]*)`/g
      : /`policy\.([^`]+)`/g;
  const tokens = new Set<string>();
  let m: RegExpExecArray | null;
  while ((m = re.exec(region)) !== null) {
    tokens.add(m[1].trim());
  }
  return tokens;
}

// ─── Coverage-subset: every token in ref docs must be in capabilities fences ─

describe('story-064-003 — reference docs coverage subset (no phantom tokens)', () => {
  let liveCommands: Set<string>;
  let liveKnobs: Set<string>;
  let gettingStarted: string;
  let configuration: string;
  let cliCommandDesc: string;

  before(() => {
    const caps = readDoc('docs/capabilities.md');
    liveCommands = parseFenceTokens(caps, 'command');
    liveKnobs = parseFenceTokens(caps, 'knob');

    gettingStarted = readDoc('docs/getting-started/index.md');
    configuration = readDoc('docs/configuration.md');
    cliCommandDesc = readDoc('docs/architecture/cli-command-descriptions.md');
  });

  it('capabilities.md command fence is non-empty', () => {
    assert.ok(liveCommands.size > 0, 'command fence must be non-empty');
  });

  it('capabilities.md knob fence is non-empty', () => {
    assert.ok(liveKnobs.size > 0, 'knob fence must be non-empty');
  });

  it('getting-started command tokens are a subset of live surface', () => {
    const refTokens = parseCommandTokens(gettingStarted);
    const phantoms = [...refTokens].filter((t) => !liveCommands.has(t));
    assert.deepEqual(
      phantoms,
      [],
      `Phantom command tokens in getting-started: ${phantoms.map((t) => '`loom ' + t + '`').join(', ')}`
    );
  });

  it('configuration.md command tokens are a subset of live surface', () => {
    const refTokens = parseCommandTokens(configuration);
    const phantoms = [...refTokens].filter((t) => !liveCommands.has(t));
    assert.deepEqual(
      phantoms,
      [],
      `Phantom command tokens in configuration.md: ${phantoms.map((t) => '`loom ' + t + '`').join(', ')}`
    );
  });

  it('cli-command-descriptions.md command tokens are a subset of live surface', () => {
    const refTokens = parseCommandTokens(cliCommandDesc);
    const phantoms = [...refTokens].filter((t) => !liveCommands.has(t));
    assert.deepEqual(
      phantoms,
      [],
      `Phantom command tokens in cli-command-descriptions.md: ${phantoms.map((t) => '`loom ' + t + '`').join(', ')}`
    );
  });

  it('getting-started knob tokens are a subset of live surface', () => {
    const refTokens = parseKnobTokens(gettingStarted);
    const phantoms = [...refTokens].filter((t) => !liveKnobs.has(t));
    assert.deepEqual(
      phantoms,
      [],
      `Phantom knob tokens in getting-started: ${phantoms.map((t) => '`policy.' + t + '`').join(', ')}`
    );
  });

  it('configuration.md knob tokens are a subset of live surface', () => {
    const refTokens = parseKnobTokens(configuration);
    const phantoms = [...refTokens].filter((t) => !liveKnobs.has(t));
    assert.deepEqual(
      phantoms,
      [],
      `Phantom knob tokens in configuration.md: ${phantoms.map((t) => '`policy.' + t + '`').join(', ')}`
    );
  });

  it('cli-command-descriptions.md knob tokens are a subset of live surface', () => {
    const refTokens = parseKnobTokens(cliCommandDesc);
    const phantoms = [...refTokens].filter((t) => !liveKnobs.has(t));
    assert.deepEqual(
      phantoms,
      [],
      `Phantom knob tokens in cli-command-descriptions.md: ${phantoms.map((t) => '`policy.' + t + '`').join(', ')}`
    );
  });
});

// ─── Coverage presence: all seven AC1 topics must appear in ref docs ─────────

describe('story-064-003 — reference docs coverage presence (AC1 topics)', () => {
  let combined: string;

  before(() => {
    const gettingStarted = readDoc('docs/getting-started/index.md');
    const configuration = readDoc('docs/configuration.md');
    const cliCommandDesc = readDoc('docs/architecture/cli-command-descriptions.md');
    combined = [gettingStarted, configuration, cliCommandDesc].join('\n');
  });

  it('AC1: loom-home workspace and manifest are mentioned', () => {
    assert.ok(
      /workspace\.yaml|workspace manifest/i.test(combined),
      'must mention the workspace manifest (workspace.yaml)'
    );
    assert.ok(
      /loom-home/i.test(combined),
      'must mention loom-home'
    );
  });

  it('AC1: cross-repo execution is mentioned', () => {
    assert.ok(
      /cross.repo/i.test(combined),
      'must mention cross-repo execution'
    );
  });

  it('AC1: loom migrate is mentioned', () => {
    assert.ok(
      combined.includes('loom migrate'),
      'must mention `loom migrate`'
    );
  });

  it('AC1: loom cost is mentioned', () => {
    assert.ok(
      combined.includes('loom cost'),
      'must mention `loom cost`'
    );
  });

  it('AC1: worker stall auto-recovery is mentioned', () => {
    assert.ok(
      /stall.recov|stall_recovery_budget|auto.retr|auto.recov/i.test(combined),
      'must mention worker stall auto-recovery or stall_recovery_budget'
    );
  });

  it('AC1: standalone-story path is mentioned', () => {
    assert.ok(
      /standalone.stor|story.sized|story-NNN/i.test(combined),
      'must mention standalone-story path or story-NNN id'
    );
  });

  it('AC1: config hierarchy is mentioned', () => {
    assert.ok(
      /loom-home.*policy\.yaml.*env|CONFIG_HIERARCHY|team config.*base.*policy\.yaml.*env/i.test(combined) ||
        combined.includes('loom-home team config (base)'),
      'must mention the three-layer config hierarchy'
    );
  });
});

// ─── Claim corrections: canonical strings must appear verbatim (AC3) ─────────

describe('story-064-003 — canonical corrections applied verbatim (AC3)', () => {
  let gettingStarted: string;
  let configuration: string;

  before(() => {
    gettingStarted = readDoc('docs/getting-started/index.md');
    configuration = readDoc('docs/configuration.md');
  });

  it('AC3: ARTIFACT_RELOCATION appears verbatim in getting-started', () => {
    const normalized = ws(gettingStarted);
    assert.ok(
      normalized.includes(ws(ARTIFACT_RELOCATION)),
      `ARTIFACT_RELOCATION must appear verbatim.\nExpected (ws-normalised): "${ws(ARTIFACT_RELOCATION)}"`
    );
  });

  it('AC3: CROSS_REPO_LANDING appears verbatim in getting-started', () => {
    const normalized = ws(gettingStarted);
    assert.ok(
      normalized.includes(ws(CROSS_REPO_LANDING)),
      `CROSS_REPO_LANDING must appear verbatim.\nExpected (ws-normalised): "${ws(CROSS_REPO_LANDING)}"`
    );
  });

  it('AC3: CONFIG_HIERARCHY appears verbatim in configuration.md', () => {
    assert.ok(
      configuration.includes(CONFIG_HIERARCHY),
      `CONFIG_HIERARCHY must appear verbatim in configuration.md.\nExpected: "${CONFIG_HIERARCHY}"`
    );
  });

  it('AC3: no pinned model version in getting-started', () => {
    // claude-<name>-<major>-<minor> format (e.g. claude-opus-4-8)
    const pinned = /claude-[a-z]+-\d+-\d+/.exec(gettingStarted);
    assert.ok(
      pinned === null,
      `Pinned model version found in getting-started: "${pinned?.[0]}" — use MODEL_TIER_PHRASING instead`
    );
  });

  it('AC3: no pinned model version in configuration.md', () => {
    const pinned = /claude-[a-z]+-\d+-\d+/.exec(configuration);
    assert.ok(
      pinned === null,
      `Pinned model version found in configuration.md: "${pinned?.[0]}" — use MODEL_TIER_PHRASING instead`
    );
  });

  it('AC3: no pinned model version in cli-command-descriptions.md', () => {
    const cliCommandDesc = readDoc('docs/architecture/cli-command-descriptions.md');
    const pinned = /claude-[a-z]+-\d+-\d+/.exec(cliCommandDesc);
    assert.ok(
      pinned === null,
      `Pinned model version found in cli-command-descriptions.md: "${pinned?.[0]}" — use MODEL_TIER_PHRASING instead`
    );
  });

  it('AC3: MODEL_TIER_PHRASING ("the latest Claude models") appears in the owned files', () => {
    const configuration = readDoc('docs/configuration.md');
    const cliCommandDesc = readDoc('docs/architecture/cli-command-descriptions.md');
    const combined = [gettingStarted, configuration, cliCommandDesc].join('\n');
    assert.ok(
      combined.includes('the latest Claude models'),
      'MODEL_TIER_PHRASING ("the latest Claude models") must appear in the reference docs'
    );
  });
});

// ─── Read-only ground truth: capabilities.md fences must be intact (ADR-006) ─

describe('story-064-003 — capabilities.md fences unchanged (ADR-006, NFR-1)', () => {
  let caps: string;

  before(() => {
    caps = readDoc('docs/capabilities.md');
  });

  it('command fence start marker is present', () => {
    assert.ok(
      caps.includes(FENCE.command.start),
      'capabilities.md must contain the command fence start marker'
    );
  });

  it('command fence end marker is present', () => {
    assert.ok(
      caps.includes(FENCE.command.end),
      'capabilities.md must contain the command fence end marker'
    );
  });

  it('knob fence start marker is present', () => {
    assert.ok(
      caps.includes(FENCE.knob.start),
      'capabilities.md must contain the knob fence start marker'
    );
  });

  it('knob fence end marker is present', () => {
    assert.ok(
      caps.includes(FENCE.knob.end),
      'capabilities.md must contain the knob fence end marker'
    );
  });

  it('loom recover is in the command fence (fence is live, not truncated)', () => {
    const commands = parseFenceTokens(caps, 'command');
    assert.ok(commands.has('recover'), '`loom recover` must be in the command fence');
  });

  it('loom cost is in the command fence', () => {
    const commands = parseFenceTokens(caps, 'command');
    assert.ok(commands.has('cost'), '`loom cost` must be in the command fence');
  });

  // stall_recovery_budget and intake_routing were baked-removed (knob-hardening);
  // assert on kept knobs instead so the fence sanity check stays meaningful.
  it('policy.agents.max_concurrent is in the knob fence', () => {
    const knobs = parseFenceTokens(caps, 'knob');
    assert.ok(
      knobs.has('agents.max_concurrent'),
      '`policy.agents.max_concurrent` must be in the knob fence'
    );
  });

  it('policy.git.protected_branches is in the knob fence', () => {
    const knobs = parseFenceTokens(caps, 'knob');
    assert.ok(
      knobs.has('git.protected_branches'),
      '`policy.git.protected_branches` must be in the knob fence'
    );
  });
});
