import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

function findCapabilitiesMd(): string {
  let dir = __dirname;
  for (let i = 0; i < 12; i++) {
    const candidate = path.join(dir, 'docs', 'capabilities.md');
    if (fs.existsSync(candidate)) return candidate;
    dir = path.dirname(dir);
  }
  throw new Error('could not locate docs/capabilities.md');
}

describe('docs/capabilities.md — signal ledger (story-010-004)', () => {
  let content: string;

  it('loads docs/capabilities.md', () => {
    const p = findCapabilitiesMd();
    content = fs.readFileSync(p, 'utf8');
    assert.ok(content.length > 0, 'capabilities.md must not be empty');
  });

  it('documents .loom/signals/<story-id>.md ledger files', () => {
    assert.ok(
      content.includes('.loom/signals/'),
      'must mention .loom/signals/ path'
    );
  });

  it('describes the ledger files as observe-only', () => {
    assert.ok(
      /observe.only/i.test(content),
      'must describe the ledger as observe-only'
    );
  });

  it('explicitly states the ledger does NOT influence execution (NFR-1)', () => {
    assert.ok(
      /does NOT influence execution/i.test(content),
      'must state the ledger does NOT influence execution'
    );
  });

  it('documents the Build signal analysis section appended to the epic PR body', () => {
    assert.ok(
      content.includes('Build signal analysis'),
      'must mention "Build signal analysis"'
    );
  });

  it('mentions the PR body in context with Build signal analysis', () => {
    // The PR body context and Build signal analysis should appear close together.
    const idx = content.indexOf('Build signal analysis');
    assert.ok(idx !== -1, '"Build signal analysis" must be present');
    const surrounding = content.slice(Math.max(0, idx - 300), idx + 300);
    assert.ok(
      /PR body|epic PR/i.test(surrounding),
      '"Build signal analysis" entry must mention the PR body or epic PR'
    );
  });
});

// ─── Standalone-story routing (epic-047, story-047-006) ──────────────────────

describe('docs/capabilities.md — standalone-story routing (story-047-006)', () => {
  let body: string;

  before(() => {
    const p = findCapabilitiesMd();
    body = fs.readFileSync(p, 'utf8');
  });

  it('documents standalone-story routing in the intake_routing row', () => {
    assert.ok(
      /standalone.story routing|standalone.*path/i.test(body),
      'must document standalone-story routing'
    );
  });

  it('describes the trigger: an effective size of story', () => {
    // intake_routing was baked to "advisory" (knob-hardening) — there are no
    // off/confirm modes anymore. The trigger is now purely the classifier
    // resolving an effective size of story.
    const hasSizeStory = /size.*story|effective.*size.*story|resolves to.*story|story.sized/i.test(body);
    assert.ok(hasSizeStory, 'must mention effective size=story as the trigger condition');
  });

  it('describes the lightweight planning: no PRD and no decomposition', () => {
    assert.ok(
      /no.*PRD|no.*decomposition|no PM/i.test(body),
      'must describe lightweight planning (no PRD, no decomposition)'
    );
  });

  it('describes the single-story / single-PR outcome', () => {
    assert.ok(
      /one PR|single.*PR|produces.*PR|one.*worker|single.*story.*container/i.test(body),
      'must describe the single-PR outcome'
    );
  });

  it('states that briefs larger than story-sized use the normal epic path', () => {
    // No intake_routing=off mode post knob-hardening; multi-story briefs always
    // take the normal Analyst→PM→Architect epic path.
    assert.ok(
      /larger.*epic path|normal.*epic path|multi.story.*epic|otherwise.*epic path/i.test(body),
      'must clarify that larger briefs use the normal epic path'
    );
  });
});

// ─── Native story-NNN storage identity (epic-059) ────────────────────────────

describe('docs/capabilities.md — native story-NNN storage identity (epic-059)', () => {
  let body: string;

  before(() => {
    const p = findCapabilitiesMd();
    body = fs.readFileSync(p, 'utf8');
  });

  it('states that story-NNN is the native storage identity (primary key)', () => {
    assert.ok(
      /story-NNN.*native storage identity|native storage identity.*story-NNN|primary key.*standalone|standalone.*primary key/i.test(body),
      'must state that story-NNN is the native storage identity or primary key'
    );
  });

  it('states that no internal translation is needed (end-to-end native)', () => {
    assert.ok(
      /no internal translation|natively|native.*id|end-to-end/i.test(body),
      'must state that story-NNN is accepted natively with no translation'
    );
  });

  it('lists CLI commands that accept story-NNN directly', () => {
    const hasCLICommands =
      /loom run.*loom approve|loom artifacts.*loom traces|loom approve.*loom artifacts/i.test(body);
    assert.ok(hasCLICommands, 'must list CLI commands that accept story-NNN directly');
  });

  it('documents migration v26 rewriting existing epic-NNN standalone rows', () => {
    assert.ok(
      /[Mm]igration v26|migration.*standalone.*epic-NNN|epic-NNN.*standalone.*story-NNN/i.test(body),
      'must mention migration v26 repointing existing standalone records'
    );
  });
});
