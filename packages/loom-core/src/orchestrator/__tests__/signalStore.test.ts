import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createDatabase } from '../../state/Database.js';
import { AuditLog } from '../../state/AuditLog.js';
import { SignalLedger } from '../signalStore.js';
import { buildStorySignals } from '../signalLedger.js';
import type { StorySignals } from '../../types.js';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeTempDir(): { dir: string; cleanup: () => void } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'loom-signal-store-'));
  return { dir, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

const SAMPLE_HEURISTICS = {
  diff_lines: 120,
  diff_files: 5,
  tests_green_first_try: null as null,
  risky_paths_touched: ['src/auth/login.ts'],
};

function makeSignals(): StorySignals {
  return buildStorySignals(SAMPLE_HEURISTICS);
}

// ─── audit_log sink ───────────────────────────────────────────────────────────

describe('SignalLedger.record – audit_log sink', () => {
  it('writes a story_signals row with correct action, command, allowed, and detail', () => {
    const { dir, cleanup } = makeTempDir();
    try {
      const db = createDatabase(':memory:');
      const ledger = new SignalLedger({ db, projectRoot: dir });
      const signals = makeSignals();

      // No agentId here — the agents table FK would reject a non-existent id.
      ledger.record('story-010-002', signals);

      const audit = new AuditLog(db);
      const rows = audit.getByStory('story-010-002', 10);
      const row = rows.find((r) => r.action === 'story_signals');
      assert.ok(row, 'story_signals row must exist in audit_log');
      assert.equal(row.command, 'story-010-002');
      // SQLite stores allowed as INTEGER 1; the AuditLogEntry type says boolean | null
      // but better-sqlite3 returns JavaScript number 1 for INTEGER columns.
      assert.equal(row.allowed as unknown, 1);
      assert.ok(row.detail, 'detail must be non-null');
      // JSON round-trip: undefined properties are elided by JSON.stringify.
      const parsed = JSON.parse(row.detail) as StorySignals;
      assert.equal(parsed.tier, signals.tier);
      assert.deepEqual(parsed.steps, signals.steps);
      assert.deepEqual(parsed.heuristics, signals.heuristics);
    } finally {
      cleanup();
    }
  });

  it('NFR-2: audit row exists before record() returns (synchronous write)', () => {
    const { dir, cleanup } = makeTempDir();
    try {
      const db = createDatabase(':memory:');
      const ledger = new SignalLedger({ db, projectRoot: dir });
      const signals = makeSignals();

      ledger.record('story-010-002', signals);

      // Assert immediately on return — no deferred/async write.
      const audit = new AuditLog(db);
      const rows = audit.getByStory('story-010-002', 10);
      assert.ok(rows.some((r) => r.action === 'story_signals'), 'audit row must be present synchronously');
    } finally {
      cleanup();
    }
  });

  it('round-trips StorySignals through JSON.parse(detail)', () => {
    const { dir, cleanup } = makeTempDir();
    try {
      const db = createDatabase(':memory:');
      const ledger = new SignalLedger({ db, projectRoot: dir });
      const signals = makeSignals();

      ledger.record('story-001-001', signals);

      const rows = db
        .prepare("SELECT detail FROM audit_log WHERE action='story_signals' AND command=?")
        .all('story-001-001') as { detail: string }[];
      assert.equal(rows.length, 1);
      const rt = JSON.parse(rows[0].detail) as StorySignals;
      assert.deepEqual(rt.tier, signals.tier);
      assert.deepEqual(rt.steps, signals.steps);
      assert.deepEqual(rt.heuristics, signals.heuristics);
    } finally {
      cleanup();
    }
  });
});

// ─── markdown sink ────────────────────────────────────────────────────────────

describe('SignalLedger.record – markdown sink', () => {
  it('creates .loom/signals/<story-id>.md containing tier, steps, and heuristics', () => {
    const { dir, cleanup } = makeTempDir();
    try {
      const db = createDatabase(':memory:');
      const ledger = new SignalLedger({ db, projectRoot: dir });
      const signals = makeSignals();

      ledger.record('story-010-002', signals);

      const mdPath = path.join(dir, '.loom', 'signals', 'story-010-002.md');
      assert.ok(fs.existsSync(mdPath), 'markdown file must be created');
      const md = fs.readFileSync(mdPath, 'utf8');
      assert.ok(md.includes('story-010-002'), 'markdown must contain the story id');
      assert.ok(md.includes(signals.tier), 'markdown must contain tier');
      assert.ok(md.includes('verify_phase'), 'markdown must use snake_case verify_phase');
      assert.ok(md.includes('skill_gen'), 'markdown must use snake_case skill_gen');
    } finally {
      cleanup();
    }
  });

  it('markdown is keyed by story id — each story gets its own file', () => {
    const { dir, cleanup } = makeTempDir();
    try {
      const db = createDatabase(':memory:');
      const ledger = new SignalLedger({ db, projectRoot: dir });

      ledger.record('story-001-001', makeSignals());
      ledger.record('story-001-002', makeSignals());

      assert.ok(fs.existsSync(path.join(dir, '.loom', 'signals', 'story-001-001.md')));
      assert.ok(fs.existsSync(path.join(dir, '.loom', 'signals', 'story-001-002.md')));
    } finally {
      cleanup();
    }
  });
});

// ─── Cross-sink shape test (FR-3 / FR-4) ─────────────────────────────────────

describe('SignalLedger.record – cross-sink shape (FR-3/FR-4)', () => {
  it('audit JSON and markdown carry identical computed values from ONE StorySignals object', () => {
    const { dir, cleanup } = makeTempDir();
    try {
      const db = createDatabase(':memory:');
      const ledger = new SignalLedger({ db, projectRoot: dir });
      const signals = makeSignals();

      ledger.record('story-010-002', signals);

      // Audit sink: parse detail JSON
      const rows = db
        .prepare("SELECT detail FROM audit_log WHERE action='story_signals' AND command=?")
        .all('story-010-002') as { detail: string }[];
      assert.equal(rows.length, 1);
      const fromAudit = JSON.parse(rows[0].detail) as StorySignals;

      // Markdown sink: read file
      const md = fs.readFileSync(
        path.join(dir, '.loom', 'signals', 'story-010-002.md'),
        'utf8'
      );

      // Values must be identical across both sinks (from ONE signals object).
      assert.equal(fromAudit.tier, signals.tier, 'audit tier must match');
      assert.equal(fromAudit.steps.reviewers, signals.steps.reviewers);
      assert.equal(fromAudit.steps.verify_phase, signals.steps.verify_phase);
      assert.equal(fromAudit.steps.skill_gen, signals.steps.skill_gen);
      assert.deepEqual(fromAudit.heuristics, signals.heuristics);

      // Markdown contains the same computed values.
      assert.ok(md.includes(`tier: ${signals.tier}`), `markdown must contain 'tier: ${signals.tier}'`);
      assert.ok(md.includes(`reviewers: ${signals.steps.reviewers}`));
      assert.ok(md.includes(`verify_phase: ${signals.steps.verify_phase}`));
      assert.ok(md.includes(`skill_gen: ${signals.steps.skill_gen}`));
      if (signals.heuristics) {
        assert.ok(md.includes(`diff_lines: ${signals.heuristics.diff_lines}`));
        assert.ok(md.includes(`diff_files: ${signals.heuristics.diff_files}`));
      }

      // steps must use snake_case in both sinks (ADR-5).
      const steps = fromAudit.steps as Record<string, unknown>;
      assert.ok('verify_phase' in steps, 'audit detail must use verify_phase (snake_case)');
      assert.ok('skill_gen' in steps, 'audit detail must use skill_gen (snake_case)');
      assert.ok(!('verifyPhase' in steps), 'verifyPhase must NOT appear in audit detail');
      assert.ok(!('skillGen' in steps), 'skillGen must NOT appear in audit detail');

      assert.ok(md.includes('verify_phase'), 'markdown must use verify_phase (snake_case)');
      assert.ok(md.includes('skill_gen'), 'markdown must use skill_gen (snake_case)');
      assert.ok(!md.includes('verifyPhase'), 'verifyPhase must NOT appear in markdown');
      assert.ok(!md.includes('skillGen'), 'skillGen must NOT appear in markdown');
    } finally {
      cleanup();
    }
  });
});

// ─── Best-effort / never-throws (FR-8) ───────────────────────────────────────

describe('SignalLedger.record – best-effort, never throws (FR-8)', () => {
  it('unwritable .loom/signals (path collision with file): record() does not throw', () => {
    const { dir, cleanup } = makeTempDir();
    try {
      // Place a FILE at .loom/signals so mkdirSync fails.
      const loomDir = path.join(dir, '.loom');
      fs.mkdirSync(loomDir, { recursive: true });
      fs.writeFileSync(path.join(loomDir, 'signals'), 'collision');

      const db = createDatabase(':memory:');
      const ledger = new SignalLedger({ db, projectRoot: dir });
      const signals = makeSignals();

      assert.doesNotThrow(() => ledger.record('story-010-002', signals));

      // Audit row for the signals still written (before the markdown failure).
      const audit = new AuditLog(db);
      const rows = audit.getByStory('story-010-002', 20);
      assert.ok(rows.some((r) => r.action === 'story_signals'), 'audit row still present');
      // Optional skipped marker emitted on markdown failure.
      assert.ok(rows.some((r) => r.action === 'story_signals_skipped'), 'story_signals_skipped emitted');
    } finally {
      cleanup();
    }
  });

  it('closed DB handle: record() does not throw and story completion is unaffected', () => {
    const { dir, cleanup } = makeTempDir();
    try {
      const db = createDatabase(':memory:');
      const ledger = new SignalLedger({ db, projectRoot: dir });
      db.close(); // Force all subsequent DB operations to fail.

      const signals = makeSignals();
      assert.doesNotThrow(() => ledger.record('story-010-002', signals));
    } finally {
      cleanup();
    }
  });
});

// ─── Path-traversal guard ─────────────────────────────────────────────────────

describe('SignalLedger.record – path-traversal guard', () => {
  it('storyId not matching story-NNN-NNN is silently ignored; no file written', () => {
    const { dir, cleanup } = makeTempDir();
    try {
      const db = createDatabase(':memory:');
      const ledger = new SignalLedger({ db, projectRoot: dir });
      const signals = makeSignals();

      const badIds = ['../../etc/passwd', 'story-1/../x', 'not-a-story', 'story-001-00', '', '../'];
      for (const id of badIds) {
        assert.doesNotThrow(() => ledger.record(id, signals), `should not throw for id: ${id}`);
        const signalsDir = path.join(dir, '.loom', 'signals');
        if (fs.existsSync(signalsDir)) {
          const files = fs.readdirSync(signalsDir);
          assert.equal(files.length, 0, `no file should be written for id: ${id}`);
        }
      }
    } finally {
      cleanup();
    }
  });

  it('valid story-NNN-NNN id is accepted and both sinks are written', () => {
    const { dir, cleanup } = makeTempDir();
    try {
      const db = createDatabase(':memory:');
      const ledger = new SignalLedger({ db, projectRoot: dir });
      const signals = makeSignals();

      ledger.record('story-010-002', signals);

      assert.ok(fs.existsSync(path.join(dir, '.loom', 'signals', 'story-010-002.md')));
      const audit = new AuditLog(db);
      const rows = audit.getByStory('story-010-002', 10);
      assert.ok(rows.some((r) => r.action === 'story_signals'));
    } finally {
      cleanup();
    }
  });
});

// ─── adaptive_cost independence (FR-5) ────────────────────────────────────────

describe('SignalLedger.record – adaptive_cost independence (FR-5)', () => {
  it('recording happens regardless of any external policy knob — no adaptive_cost parameter accepted', () => {
    const { dir, cleanup } = makeTempDir();
    try {
      // Call record() twice with identical inputs. Since the method takes no
      // policy parameters, adaptive_cost cannot influence it — verified by
      // asserting both calls produce consistent audit rows.
      const db = createDatabase(':memory:');
      const ledger = new SignalLedger({ db, projectRoot: dir });
      const signals = makeSignals();

      ledger.record('story-001-001', signals);
      ledger.record('story-001-002', signals);

      const audit = new AuditLog(db);
      const r1 = audit.getByStory('story-001-001', 10).find((r) => r.action === 'story_signals');
      const r2 = audit.getByStory('story-001-002', 10).find((r) => r.action === 'story_signals');
      assert.ok(r1 && r1.detail, 'first call written');
      assert.ok(r2 && r2.detail, 'second call written');
      assert.deepEqual(JSON.parse(r1!.detail!), JSON.parse(r2!.detail!), 'identical signals → identical rows');
    } finally {
      cleanup();
    }
  });
});

// ─── readEpic ─────────────────────────────────────────────────────────────────

describe('SignalLedger.readEpic', () => {
  it('returns a Map with StorySignals for each storyId that has a record', () => {
    const { dir, cleanup } = makeTempDir();
    try {
      const db = createDatabase(':memory:');
      const ledger = new SignalLedger({ db, projectRoot: dir });
      const s1 = buildStorySignals({ diff_lines: 10, diff_files: 1, tests_green_first_try: null, risky_paths_touched: [] });
      const s2 = buildStorySignals({ diff_lines: 200, diff_files: 10, tests_green_first_try: false, risky_paths_touched: [] });

      ledger.record('story-001-001', s1);
      ledger.record('story-001-002', s2);

      const result = ledger.readEpic(['story-001-001', 'story-001-002', 'story-001-003']);
      assert.equal(result.size, 2);
      // JSON round-trip elides undefined properties (triage, self_assessment) — compare normalized.
      const n1 = JSON.parse(JSON.stringify(s1)) as StorySignals;
      const n2 = JSON.parse(JSON.stringify(s2)) as StorySignals;
      assert.deepEqual(result.get('story-001-001'), n1);
      assert.deepEqual(result.get('story-001-002'), n2);
      assert.equal(result.get('story-001-003'), undefined, 'unrecorded story must be absent');
    } finally {
      cleanup();
    }
  });

  it('returns exactly one entry per storyId even when multiple rows exist', () => {
    const { dir, cleanup } = makeTempDir();
    try {
      const db = createDatabase(':memory:');
      const ledger = new SignalLedger({ db, projectRoot: dir });
      const s1 = buildStorySignals({ diff_lines: 10, diff_files: 1, tests_green_first_try: null, risky_paths_touched: [] });
      const s2 = buildStorySignals({ diff_lines: 500, diff_files: 20, tests_green_first_try: null, risky_paths_touched: [] });

      ledger.record('story-001-001', s1);
      ledger.record('story-001-001', s2); // Two rows for the same storyId.

      const result = ledger.readEpic(['story-001-001']);
      // readEpic must return exactly ONE entry per storyId (not two).
      assert.equal(result.size, 1, 'map must have exactly one entry per storyId');
      const got = result.get('story-001-001');
      assert.ok(got, 'must have a record for story-001-001');
      // The returned record must be valid StorySignals (one of the two written).
      const validDiffs = new Set([10, 500]);
      assert.ok(
        validDiffs.has(got.heuristics?.diff_lines ?? -1),
        'returned record must match one of the written signals'
      );
    } finally {
      cleanup();
    }
  });

  it('empty storyIds → empty Map', () => {
    const { dir, cleanup } = makeTempDir();
    try {
      const db = createDatabase(':memory:');
      const ledger = new SignalLedger({ db, projectRoot: dir });
      assert.equal(ledger.readEpic([]).size, 0);
    } finally {
      cleanup();
    }
  });

  it('reads from audit_log only — does not require markdown file to exist', () => {
    const { dir, cleanup } = makeTempDir();
    try {
      const db = createDatabase(':memory:');
      // Write audit row directly without going through ledger.record, so no markdown exists.
      const audit = new AuditLog(db);
      const signals = makeSignals();
      audit.record({
        action: 'story_signals',
        command: 'story-002-001',
        allowed: true,
        detail: signals as unknown as Record<string, unknown>,
      });

      const ledger = new SignalLedger({ db, projectRoot: dir });
      const result = ledger.readEpic(['story-002-001']);
      assert.ok(result.has('story-002-001'), 'must find row written directly to audit_log');
      const got = result.get('story-002-001')!;
      // JSON round-trip elides undefined properties; compare fields individually.
      assert.equal(got.tier, signals.tier);
      assert.deepEqual(got.steps, signals.steps);
      assert.deepEqual(got.heuristics, signals.heuristics);
      // No markdown file exists — confirm readEpic did not create one.
      assert.ok(!fs.existsSync(path.join(dir, '.loom', 'signals', 'story-002-001.md')));
    } finally {
      cleanup();
    }
  });
});

// ─── gitignore coverage (NFR-3) ──────────────────────────────────────────────

describe('gitignore coverage (NFR-3)', () => {
  it('.loom/signals/ is covered by .gitignore', () => {
    // Walk up from this test file's __dirname to find the repo root .gitignore.
    // Compiled path: dist/orchestrator/__tests__/ → packages/loom-core/dist/ →
    // packages/loom-core/ → packages/ → repo root (5 levels up).
    const repoRoot = path.resolve(__dirname, '../../../../../');
    const gitignorePath = path.join(repoRoot, '.gitignore');
    assert.ok(fs.existsSync(gitignorePath), '.gitignore must exist at repo root');
    const gitignore = fs.readFileSync(gitignorePath, 'utf8');
    // .loom/signals/ must be explicitly listed or covered by a blanket .loom/ rule.
    const covered =
      gitignore.includes('.loom/signals/') ||
      gitignore.includes('.loom/signals') ||
      gitignore.includes('.loom/\n') ||
      gitignore.includes('.loom/ ');
    assert.ok(covered, '.loom/signals/ must be gitignored (NFR-3)');
  });
});
