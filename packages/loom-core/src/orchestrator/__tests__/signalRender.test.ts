import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import yaml from 'js-yaml';
import { renderBuildSignalAnalysis, type SignalRenderInput } from '../signalRender.js';
import { buildStorySignals } from '../signalLedger.js';
import { SignalLedger } from '../signalStore.js';
import { createDatabase } from '../../state/Database.js';
import { AuditLog } from '../../state/AuditLog.js';
import { EpicStore } from '../../state/EpicStore.js';
import { AgentStore } from '../../state/AgentStore.js';
import { EpicFinalizer } from '../EpicFinalizer.js';
import type { StorySignals } from '../../types.js';

// ─── Helpers ──────────────────────────────────────────────────────────────────

const BASE_HEURISTICS = {
  diff_lines: 50,
  diff_files: 2,
  tests_green_first_try: null as null,
  risky_paths_touched: [] as string[],
};

function makeHeavySignals(): StorySignals {
  // No selfAssessment → confidence='low' → tier='heavy' (see tier.ts:40-41).
  return buildStorySignals({ ...BASE_HEURISTICS });
}

function makeLightSignals(): StorySignals {
  return buildStorySignals(
    { diff_lines: 40, diff_files: 2, tests_green_first_try: true, risky_paths_touched: [] },
    {
      selfAssessment: { confidence: 'high', complexity: 'low' },
      triage: { risk: 'low', predicted_complexity: 'low', rationale: '' },
    }
  );
}

function makeStandardSignals(): StorySignals {
  return buildStorySignals(
    { diff_lines: 150, diff_files: 6, tests_green_first_try: null, risky_paths_touched: [] },
    { selfAssessment: { confidence: 'medium', complexity: 'medium' } }
  );
}

function makeInput(overrides: Partial<SignalRenderInput> = {}): SignalRenderInput {
  const storyId = 'story-001-001';
  return {
    records: new Map([[storyId, makeHeavySignals()]]),
    outcomes: new Map([[storyId, { reviewFindings: null, gateGreen: null }]]),
    storyOrder: [storyId],
    ...overrides,
  };
}

// ─── Unit tests: section header and per-story fields ──────────────────────────

describe('renderBuildSignalAnalysis — section header', () => {
  it('output starts with "## Build signal analysis"', () => {
    const out = renderBuildSignalAnalysis(makeInput());
    assert.ok(out.startsWith('## Build signal analysis'), 'header must be first line');
  });

  it('lists storyId as a sub-heading', () => {
    const out = renderBuildSignalAnalysis(makeInput());
    assert.ok(out.includes('### story-001-001'));
  });

  it('skips stories with no record', () => {
    const out = renderBuildSignalAnalysis(
      makeInput({ storyOrder: ['story-001-001', 'story-001-002'] })
    );
    assert.ok(!out.includes('### story-001-002'), 'story without record must not appear');
  });

  it('respects storyOrder for output order', () => {
    const records = new Map<string, StorySignals>([
      ['story-001-001', makeHeavySignals()],
      ['story-001-002', makeHeavySignals()],
    ]);
    const out = renderBuildSignalAnalysis({
      records,
      outcomes: new Map(),
      storyOrder: ['story-001-002', 'story-001-001'],
    });
    const pos1 = out.indexOf('### story-001-001');
    const pos2 = out.indexOf('### story-001-002');
    assert.ok(pos2 < pos1, 'story-001-002 must appear before story-001-001');
  });
});

describe('renderBuildSignalAnalysis — heuristics and tier', () => {
  it('renders diff_lines, diff_files, tests_green_first_try, risky_paths_touched', () => {
    const signals = buildStorySignals({
      diff_lines: 300,
      diff_files: 8,
      tests_green_first_try: true,
      risky_paths_touched: ['src/auth.ts', 'src/db.ts'],
    });
    const out = renderBuildSignalAnalysis({
      records: new Map([['story-001-001', signals]]),
      outcomes: new Map(),
      storyOrder: ['story-001-001'],
    });
    assert.ok(out.includes('diff_lines: 300'));
    assert.ok(out.includes('diff_files: 8'));
    assert.ok(out.includes('tests_green_first_try: true'));
    assert.ok(out.includes('src/auth.ts'));
    assert.ok(out.includes('src/db.ts'));
  });

  it('renders "none" for empty risky_paths_touched', () => {
    const signals = buildStorySignals({
      ...BASE_HEURISTICS,
      risky_paths_touched: [],
    });
    const out = renderBuildSignalAnalysis({
      records: new Map([['story-001-001', signals]]),
      outcomes: new Map(),
      storyOrder: ['story-001-001'],
    });
    assert.ok(out.includes('risky_paths_touched: none'));
  });

  it('renders tier and steps', () => {
    const signals = makeHeavySignals();
    assert.equal(signals.tier, 'heavy');
    const out = renderBuildSignalAnalysis({
      records: new Map([['story-001-001', signals]]),
      outcomes: new Map(),
      storyOrder: ['story-001-001'],
    });
    assert.ok(out.includes('**Recommended tier:** heavy'));
    assert.ok(out.includes(`reviewers: ${signals.steps.reviewers}`));
    assert.ok(out.includes(`verify_phase: ${signals.steps.verify_phase}`));
    assert.ok(out.includes(`skill_gen: ${signals.steps.skill_gen}`));
  });

  it('skips heuristics block when signals.heuristics is absent', () => {
    const bare: StorySignals = { tier: 'standard', steps: { reviewers: 2, verify_phase: true, skill_gen: true } };
    const out = renderBuildSignalAnalysis({
      records: new Map([['story-001-001', bare]]),
      outcomes: new Map(),
      storyOrder: ['story-001-001'],
    });
    assert.ok(!out.includes('**Heuristics**'), 'must not emit heuristics block when absent');
  });
});

// ─── Unit tests: over-spend flag (FR-7) ───────────────────────────────────────

describe('renderBuildSignalAnalysis — over-spend flag (FR-7)', () => {
  it('fires when tier=heavy AND reviewFindings===0 AND gateGreen===true', () => {
    const out = renderBuildSignalAnalysis(
      makeInput({
        outcomes: new Map([['story-001-001', { reviewFindings: 0, gateGreen: true }]]),
      })
    );
    assert.ok(out.includes('Over-spend candidate'), 'flag must fire on exact triple');
    assert.ok(out.includes('safely downgrade'), 'flag text must mention downgrade');
  });

  it('heavy + reviewFindings>0 → no flag', () => {
    const out = renderBuildSignalAnalysis(
      makeInput({
        outcomes: new Map([['story-001-001', { reviewFindings: 3, gateGreen: true }]]),
      })
    );
    assert.ok(!out.includes('Over-spend candidate'), 'must not flag when findings > 0');
  });

  it('heavy + gateGreen=false → no flag', () => {
    const out = renderBuildSignalAnalysis(
      makeInput({
        outcomes: new Map([['story-001-001', { reviewFindings: 0, gateGreen: false }]]),
      })
    );
    assert.ok(!out.includes('Over-spend candidate'), 'must not flag when gate is red');
  });

  it('heavy + reviewFindings=null (ADR-6) → no flag, still emits heuristics+tier', () => {
    const out = renderBuildSignalAnalysis(
      makeInput({
        outcomes: new Map([['story-001-001', { reviewFindings: null, gateGreen: true }]]),
      })
    );
    assert.ok(!out.includes('Over-spend candidate'), 'must not flag when reviewFindings is null');
    assert.ok(out.includes('**Recommended tier:**'), 'must still emit tier');
  });

  it('heavy + gateGreen=null (ADR-6) → no flag, still emits heuristics+tier', () => {
    const out = renderBuildSignalAnalysis(
      makeInput({
        outcomes: new Map([['story-001-001', { reviewFindings: 0, gateGreen: null }]]),
      })
    );
    assert.ok(!out.includes('Over-spend candidate'), 'must not flag when gateGreen is null');
    assert.ok(out.includes('**Recommended tier:**'), 'must still emit tier');
  });

  it('both outcome fields null (ADR-6) → no flag, no false-precision text', () => {
    const out = renderBuildSignalAnalysis(
      makeInput({
        outcomes: new Map([['story-001-001', { reviewFindings: null, gateGreen: null }]]),
      })
    );
    assert.ok(!out.includes('Over-spend candidate'));
    assert.ok(!out.includes('downgrade'));
  });

  it('story absent from outcomes map → no flag', () => {
    const out = renderBuildSignalAnalysis(
      makeInput({
        outcomes: new Map(), // no entry for story-001-001
      })
    );
    assert.ok(!out.includes('Over-spend candidate'));
  });
});

// ─── Unit tests: under-spend never flagged ────────────────────────────────────

describe('renderBuildSignalAnalysis — under-spend never flagged', () => {
  it('light tier with findings → no flag in either direction', () => {
    const signals = makeLightSignals();
    assert.equal(signals.tier, 'light');
    const out = renderBuildSignalAnalysis({
      records: new Map([['story-001-001', signals]]),
      outcomes: new Map([['story-001-001', { reviewFindings: 5, gateGreen: false }]]),
      storyOrder: ['story-001-001'],
    });
    assert.ok(!out.includes('candidate'), 'under-spend must never be flagged');
    assert.ok(!out.includes('downgrade'));
  });

  it('standard tier with findings and green gate → no flag', () => {
    const signals = makeStandardSignals();
    assert.equal(signals.tier, 'standard');
    const out = renderBuildSignalAnalysis({
      records: new Map([['story-001-001', signals]]),
      outcomes: new Map([['story-001-001', { reviewFindings: 2, gateGreen: true }]]),
      storyOrder: ['story-001-001'],
    });
    assert.ok(!out.includes('candidate'));
  });

  it('standard tier with no findings and green gate → no flag (only heavy triggers)', () => {
    const signals = makeStandardSignals();
    const out = renderBuildSignalAnalysis({
      records: new Map([['story-001-001', signals]]),
      outcomes: new Map([['story-001-001', { reviewFindings: 0, gateGreen: true }]]),
      storyOrder: ['story-001-001'],
    });
    assert.ok(!out.includes('candidate'));
  });
});

// ─── Unit tests: empty input ──────────────────────────────────────────────────

describe('renderBuildSignalAnalysis — empty inputs', () => {
  it('empty storyOrder → only the header is emitted', () => {
    const out = renderBuildSignalAnalysis({ records: new Map(), outcomes: new Map(), storyOrder: [] });
    assert.ok(out.startsWith('## Build signal analysis'));
    assert.ok(!out.includes('###'));
  });
});

// ─── Integration tests: EpicFinalizer wiring (NFR-1) ─────────────────────────

let repo: string;
let base: string;
let loomDir: string;

function gitc(args: string[], cwd = repo): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

function storyBranchFor(id: string, file: string, content: string): void {
  gitc(['checkout', '-q', '-b', `story/${id}`, base]);
  fs.writeFileSync(path.join(repo, file), content);
  gitc(['add', file]);
  gitc(['commit', '-q', '-m', `${id}: work`]);
  gitc(['checkout', '-q', base]);
}

function seedEpic(
  db: ReturnType<typeof createDatabase>,
  epicId: string,
  storyId: string
): string {
  const planningDir = path.join(loomDir, 'planning', 'run-1');
  fs.mkdirSync(planningDir, { recursive: true });
  fs.writeFileSync(path.join(planningDir, 'project-brief.md'), '# brief\n');
  fs.writeFileSync(path.join(planningDir, 'prd.md'), '# prd\n');
  fs.writeFileSync(path.join(planningDir, 'architecture.md'), '# arch\n');

  const yamlAbs = path.join(planningDir, 'epic.yaml');
  const doc = {
    epic_id: epicId,
    title: 'Signal analysis integration test',
    priority: 'must-have',
    prd_ref: 'prd.md',
    requirements: ['renders signal analysis'],
    stories: [
      {
        id: storyId,
        title: 'A story with signals',
        description: 'noop',
        acceptance_criteria: ['it merges'],
        estimated_complexity: 'small',
        dependencies: [],
      },
    ],
  };
  fs.writeFileSync(yamlAbs, yaml.dump(doc));

  const rel = (p: string): string => path.relative(repo, p);
  const epicStore = new EpicStore(db);
  epicStore.create(epicId, 'Signal analysis integration test', rel(yamlAbs));
  epicStore.updateBaseSha(epicId, base);
  epicStore.updatePaths(epicId, {
    brief_path: rel(path.join(planningDir, 'project-brief.md')),
    prd_path: rel(path.join(planningDir, 'prd.md')),
    yaml_path: rel(yamlAbs),
  });

  const agentStore = new AgentStore(db);
  const agent = agentStore.create(epicId, storyId, 'A story with signals');
  agentStore.updateStatus(agent.id, 'done');

  return rel(yamlAbs);
}

let remoteDir: string;

beforeEach(() => {
  repo = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'loom-sigrender-')));
  loomDir = path.join(repo, '.loom');
  fs.mkdirSync(loomDir, { recursive: true });

  gitc(['init', '-q']);
  gitc(['config', 'user.email', 'test@loom.dev']);
  gitc(['config', 'user.name', 'Loom Test']);
  gitc(['config', 'commit.gpgsign', 'false']);
  fs.writeFileSync(path.join(repo, '.gitignore'), '.loom/\n');
  fs.writeFileSync(path.join(repo, 'README.md'), '# test\n');
  gitc(['add', '.gitignore', 'README.md']);
  gitc(['commit', '-q', '-m', 'initial']);
  base = gitc(['rev-parse', 'HEAD']);

  // Add a local bare remote so finalize doesn't short-circuit at "no remote".
  // The actual push is mocked; we just need defaultRemote() to return 'origin'.
  remoteDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'loom-bare-')));
  execFileSync('git', ['init', '--bare', '-q'], { cwd: remoteDir });
  gitc(['remote', 'add', 'origin', remoteDir]);
});

afterEach(() => {
  fs.rmSync(repo, { recursive: true, force: true });
  fs.rmSync(remoteDir, { recursive: true, force: true });
});

describe('EpicFinalizer — Build signal analysis wiring (story-010-003)', () => {
  it('appends "## Build signal analysis" to PR body when signal records exist', async () => {
    const epicId = 'epic-010';
    const storyId = 'story-010-001';
    const db = createDatabase(':memory:');
    seedEpic(db, epicId, storyId);
    storyBranchFor(storyId, 'feature.txt', 'hello\n');

    // Pre-record signals so finalize's readEpic finds them.
    const ledger = new SignalLedger({ db, projectRoot: repo });
    ledger.record(storyId, makeHeavySignals());

    let capturedBody = '';
    const finalizer = new EpicFinalizer({
      projectRoot: repo,
      db,
      allowedRemotes: [remoteDir],
      prStrategy: 'per-epic',
      integrationGate: 'off',
      pushBranch: () => ({ ok: true, output: '' }),
      openPr: ({ body }) => {
        capturedBody = body;
        return 'https://github.com/test/pr/1';
      },
    });

    const result = await finalizer.finalize(epicId);
    assert.ok(
      result.status === 'merged' || result.status === 'partial',
      `unexpected status: ${result.status}`
    );
    assert.ok(
      capturedBody.includes('## Build signal analysis'),
      'PR body must contain "## Build signal analysis"'
    );
    assert.ok(
      capturedBody.includes(`### ${storyId}`),
      'PR body must list the story ID'
    );
    assert.ok(
      capturedBody.includes('**Recommended tier:**'),
      'PR body must include tier'
    );
  });

  it('does not append signal analysis when no records exist', async () => {
    const epicId = 'epic-010';
    const storyId = 'story-010-001';
    const db = createDatabase(':memory:');
    seedEpic(db, epicId, storyId);
    storyBranchFor(storyId, 'feature.txt', 'hello\n');

    // No signals recorded.
    let capturedBody = '';
    const finalizer = new EpicFinalizer({
      projectRoot: repo,
      db,
      allowedRemotes: [remoteDir],
      prStrategy: 'per-epic',
      integrationGate: 'off',
      pushBranch: () => ({ ok: true, output: '' }),
      openPr: ({ body }) => {
        capturedBody = body;
        return 'https://github.com/test/pr/1';
      },
    });

    await finalizer.finalize(epicId);
    assert.ok(
      !capturedBody.includes('## Build signal analysis'),
      'PR body must NOT include signal analysis when no records exist'
    );
  });

  it('NFR-1: finalize read path adds zero story_signals audit rows and zero .loom/signals files', async () => {
    const epicId = 'epic-010';
    const storyId = 'story-010-001';
    const db = createDatabase(':memory:');
    seedEpic(db, epicId, storyId);
    storyBranchFor(storyId, 'feature.txt', 'hello\n');

    const ledger = new SignalLedger({ db, projectRoot: repo });
    ledger.record(storyId, makeHeavySignals());

    // Snapshot: count story_signals rows + .loom/signals files before finalize.
    const audit = new AuditLog(db);
    const rowsBefore = audit.getByStory(storyId, 200).filter((r) => r.action === 'story_signals').length;
    const signalsDir = path.join(repo, '.loom', 'signals');
    const filesBefore = fs.existsSync(signalsDir)
      ? fs.readdirSync(signalsDir).sort()
      : ([] as string[]);

    const finalizer = new EpicFinalizer({
      projectRoot: repo,
      db,
      allowedRemotes: [remoteDir],
      prStrategy: 'per-epic',
      integrationGate: 'off',
      pushBranch: () => ({ ok: true, output: '' }),
      openPr: () => 'https://github.com/test/pr/1',
    });

    await finalizer.finalize(epicId);

    const rowsAfter = audit.getByStory(storyId, 200).filter((r) => r.action === 'story_signals').length;
    const filesAfter = fs.existsSync(signalsDir)
      ? fs.readdirSync(signalsDir).sort()
      : ([] as string[]);

    assert.equal(rowsAfter, rowsBefore, 'readEpic must not write new story_signals audit rows');
    assert.deepEqual(filesAfter, filesBefore, 'readEpic must not write .loom/signals files');
  });

  it('NFR-1 regression: finalize/dispatch outcomes identical whether ledger records exist or not', async () => {
    // Run finalize twice: once with signal records, once without. The FinalizeResult
    // (merged, conflicted, status) must be the same — ledger records must not
    // affect execution decisions.
    async function runFinalize(withSignals: boolean): Promise<{ status: string; merged: string[] }> {
      const tmpRepo = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'loom-nfr1-')));
      const tmpLoom = path.join(tmpRepo, '.loom');
      fs.mkdirSync(tmpLoom, { recursive: true });

      const gc = (args: string[]): string =>
        execFileSync('git', args, { cwd: tmpRepo, encoding: 'utf8' }).trim();
      gc(['init', '-q']);
      gc(['config', 'user.email', 'test@loom.dev']);
      gc(['config', 'user.name', 'Loom Test']);
      gc(['config', 'commit.gpgsign', 'false']);
      fs.writeFileSync(path.join(tmpRepo, '.gitignore'), '.loom/\n');
      fs.writeFileSync(path.join(tmpRepo, 'README.md'), '# test\n');
      gc(['add', '.gitignore', 'README.md']);
      gc(['commit', '-q', '-m', 'initial']);
      const tmpBase = gc(['rev-parse', 'HEAD']);

      const epicId = 'epic-010';
      const storyId = 'story-010-001';
      const db = createDatabase(':memory:');

      // seed epic
      const planningDir = path.join(tmpLoom, 'planning', 'run-1');
      fs.mkdirSync(planningDir, { recursive: true });
      const yamlAbs = path.join(planningDir, 'epic.yaml');
      fs.writeFileSync(yamlAbs, yaml.dump({
        epic_id: epicId,
        title: 'NFR-1 regression epic',
        priority: 'must-have',
        prd_ref: 'prd.md',
        requirements: ['nfr1'],
        stories: [{
          id: storyId,
          title: 'nfr1 story',
          description: 'noop',
          acceptance_criteria: ['merges'],
          estimated_complexity: 'small',
          dependencies: [],
        }],
      }));
      const rel = (p: string): string => path.relative(tmpRepo, p);
      const epicStore = new EpicStore(db);
      epicStore.create(epicId, 'NFR-1 regression epic', rel(yamlAbs));
      epicStore.updateBaseSha(epicId, tmpBase);
      epicStore.updatePaths(epicId, { yaml_path: rel(yamlAbs) });
      const agentStore = new AgentStore(db);
      const agent = agentStore.create(epicId, storyId, 'nfr1 story');
      agentStore.updateStatus(agent.id, 'done');

      // Create story branch
      gc(['checkout', '-q', '-b', `story/${storyId}`, tmpBase]);
      fs.writeFileSync(path.join(tmpRepo, 'nfr1.txt'), 'nfr1\n');
      gc(['add', 'nfr1.txt']);
      gc(['commit', '-q', '-m', `${storyId}: nfr1`]);
      gc(['checkout', '-q', tmpBase]);

      if (withSignals) {
        const ledger = new SignalLedger({ db, projectRoot: tmpRepo });
        ledger.record(storyId, makeHeavySignals());
      }

      const finalizer = new EpicFinalizer({
        projectRoot: tmpRepo,
        db,
        allowedRemotes: [],
        prStrategy: 'per-epic',
        integrationGate: 'off',
        pushBranch: () => ({ ok: true, output: '' }),
        openPr: () => 'https://github.com/test/pr/1',
      });

      const result = await finalizer.finalize(epicId);
      fs.rmSync(tmpRepo, { recursive: true, force: true });
      return { status: result.status, merged: result.merged };
    }

    const withRecords = await runFinalize(true);
    const withoutRecords = await runFinalize(false);

    assert.equal(withRecords.status, withoutRecords.status, 'status must be identical');
    assert.deepEqual(withRecords.merged, withoutRecords.merged, 'merged list must be identical');
  });
});
