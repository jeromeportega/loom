/**
 * Integration test: target-repo epic-branch diff is code-only (story-050-005).
 *
 * Structural proof of the code-only invariant (NFR-2 / FR-8). Uses real
 * gitSafe and real temp repos — no git mocking — so the two-repo cwd
 * separation is actually exercised.
 *
 * Three cases per the test plan:
 *   1. CODE-ONLY DIFF — git diff on the epic branch in the target repo contains
 *      zero loom artifact paths (.loom_outputs/, project-brief.md, prd.md,
 *      architecture.md, epic.yaml) after promoteArtifacts runs.
 *   2. LEDGER PRESENT — loom-home holds repos/<slug>/<epic-id>/ with all four
 *      artifacts and provenance.json, committed to loom-home's own history.
 *   3. NO HISTORY REWRITE — a pre-existing .loom_outputs/<old-epic>/ commit SHA
 *      is byte-for-byte unchanged (no rebase/rewrite) after promoteArtifacts.
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EpicFinalizer } from '../../src/orchestrator/EpicFinalizer.js';
import { EpicStore } from '../../src/state/EpicStore.js';
import { createDatabase } from '../../src/state/Database.js';
import { gitSafe } from '../../src/orchestrator/git.js';

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeTmp(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'loom-codeonly-'));
}

function initRepo(dir: string): void {
  fs.mkdirSync(dir, { recursive: true });
  gitSafe(dir, ['init']);
  gitSafe(dir, ['config', 'user.email', 'test@loom.test']);
  gitSafe(dir, ['config', 'user.name', 'Loom Test']);
}

function initialCommit(dir: string, message: string = 'initial'): string {
  const readme = path.join(dir, 'README.md');
  fs.writeFileSync(readme, `# ${path.basename(dir)}\n`, 'utf8');
  gitSafe(dir, ['add', 'README.md']);
  gitSafe(dir, ['commit', '-m', message]);
  return gitSafe(dir, ['rev-parse', 'HEAD']).output.trim();
}

function seedPlanningArtifacts(
  targetRepo: string,
  epicId: string,
): { brief_path: string; prd_path: string; yaml_path: string } {
  const planDir = path.join(targetRepo, '.loom', 'planning', epicId);
  const epicsDir = path.join(planDir, 'epics');
  fs.mkdirSync(epicsDir, { recursive: true });
  fs.writeFileSync(path.join(planDir, 'project-brief.md'), '# Brief\n', 'utf8');
  fs.writeFileSync(path.join(planDir, 'prd.md'), '# PRD\n', 'utf8');
  fs.writeFileSync(path.join(planDir, 'architecture.md'), '# Architecture\n', 'utf8');
  fs.writeFileSync(path.join(epicsDir, `${epicId}.yaml`), `id: ${epicId}\n`, 'utf8');
  return {
    brief_path: `.loom/planning/${epicId}/project-brief.md`,
    prd_path: `.loom/planning/${epicId}/prd.md`,
    yaml_path: `.loom/planning/${epicId}/epics/${epicId}.yaml`,
  };
}

function callPromoteArtifacts(
  finalizer: EpicFinalizer,
  epicId: string,
  epic: object,
  store: EpicStore,
): void {
  (
    finalizer as unknown as {
      promoteArtifacts(id: string, e: object, s: EpicStore): void;
    }
  ).promoteArtifacts(epicId, epic, store);
}

// ── Cases 1 + 2: CODE-ONLY DIFF and LEDGER PRESENT (shared setup) ─────────────
//
// Setup: target repo with an epic branch containing a code change, plus a fresh
// loom-home. promoteArtifacts() must route artifacts to loom-home only.

describe('target-repo code-only invariant — cases 1+2: code-only diff and ledger present', () => {
  let tmp: string;
  let targetRepo: string;
  let loomHomePath: string;
  let store: EpicStore;
  let baseSha: string;
  let epicBranchSha: string;
  const epicId = 'epic-codeonly-001';

  before(() => {
    tmp = makeTmp();
    targetRepo = path.join(tmp, 'target');
    loomHomePath = path.join(tmp, 'loom-home');

    // --- Target repo: initial commit on default branch ---
    initRepo(targetRepo);
    baseSha = initialCommit(targetRepo);

    // --- Epic branch with a single code change ---
    gitSafe(targetRepo, ['checkout', '-b', `epic/${epicId}`]);
    const srcDir = path.join(targetRepo, 'src');
    fs.mkdirSync(srcDir, { recursive: true });
    fs.writeFileSync(path.join(srcDir, 'feature.ts'), 'export const x = 1;\n', 'utf8');
    gitSafe(targetRepo, ['add', path.join('src', 'feature.ts')]);
    gitSafe(targetRepo, ['commit', '-m', 'feat: add feature']);
    epicBranchSha = gitSafe(targetRepo, ['rev-parse', 'HEAD']).output.trim();

    // Planning artifacts on disk only (not committed to the target repo).
    const paths = seedPlanningArtifacts(targetRepo, epicId);

    // --- Loom-home: init + initial commit ---
    initRepo(loomHomePath);
    initialCommit(loomHomePath, 'initial');

    // --- EpicStore: create epic row with artifact paths ---
    const loomDir = path.join(targetRepo, '.loom');
    const db = createDatabase(path.join(loomDir, 'loom.db'));
    store = new EpicStore(db);
    store.create(epicId, 'Code-only integration test epic');
    store.updatePaths(epicId, {
      brief_path: paths.brief_path,
      prd_path: paths.prd_path,
      yaml_path: paths.yaml_path,
    });
    store.updateBaseSha(epicId, baseSha);

    // --- Call promoteArtifacts (the method under test) ---
    const finalizer = new EpicFinalizer({
      projectRoot: targetRepo,
      db,
      allowedRemotes: [],
      prStrategy: 'per-epic',
      loomHome: loomHomePath,
    });
    const epic = store.get(epicId)!;
    callPromoteArtifacts(finalizer, epicId, epic, store);
  });

  after(() => fs.rmSync(tmp, { recursive: true, force: true }));

  // ── Case 1: CODE-ONLY DIFF ───────────────────────────────────────────────────

  it('case 1: git diff contains no .loom_outputs/ paths (NFR-2 structural guard)', () => {
    const diffRes = gitSafe(targetRepo, ['diff', '--name-only', baseSha, epicBranchSha]);
    const files = diffRes.output.trim().split('\n').filter(Boolean);
    const loomPaths = files.filter((f) => f.includes('.loom_outputs'));
    assert.equal(
      loomPaths.length,
      0,
      `diff must not contain any .loom_outputs/ path; got: ${loomPaths.join(', ')}`,
    );
  });

  it('case 1: git diff contains no project-brief.md committed to target branch', () => {
    const diffRes = gitSafe(targetRepo, ['diff', '--name-only', baseSha, epicBranchSha]);
    const files = diffRes.output.trim().split('\n').filter(Boolean);
    const match = files.filter((f) => f.endsWith('project-brief.md'));
    assert.equal(
      match.length,
      0,
      `diff must not contain project-brief.md; got: ${match.join(', ')}`,
    );
  });

  it('case 1: git diff contains no prd.md committed to target branch', () => {
    const diffRes = gitSafe(targetRepo, ['diff', '--name-only', baseSha, epicBranchSha]);
    const files = diffRes.output.trim().split('\n').filter(Boolean);
    const match = files.filter((f) => f.endsWith('prd.md'));
    assert.equal(match.length, 0, `diff must not contain prd.md; got: ${match.join(', ')}`);
  });

  it('case 1: git diff contains no architecture.md committed to target branch', () => {
    const diffRes = gitSafe(targetRepo, ['diff', '--name-only', baseSha, epicBranchSha]);
    const files = diffRes.output.trim().split('\n').filter(Boolean);
    const match = files.filter((f) => f.endsWith('architecture.md'));
    assert.equal(
      match.length,
      0,
      `diff must not contain architecture.md; got: ${match.join(', ')}`,
    );
  });

  it('case 1: git diff contains no epic.yaml committed to target branch', () => {
    const diffRes = gitSafe(targetRepo, ['diff', '--name-only', baseSha, epicBranchSha]);
    const files = diffRes.output.trim().split('\n').filter(Boolean);
    const match = files.filter((f) => f.endsWith('epic.yaml'));
    assert.equal(match.length, 0, `diff must not contain epic.yaml; got: ${match.join(', ')}`);
  });

  it('case 1: git diff is code-only — exactly the expected code file and nothing else', () => {
    const diffRes = gitSafe(targetRepo, ['diff', '--name-only', baseSha, epicBranchSha]);
    const files = diffRes.output.trim().split('\n').filter(Boolean);
    assert.deepEqual(
      files,
      ['src/feature.ts'],
      `expected exactly [src/feature.ts] in the diff; got: ${JSON.stringify(files)}`,
    );
  });

  it('case 1: target repo HEAD is unchanged after promoteArtifacts (no new commit on target)', () => {
    const headNow = gitSafe(targetRepo, ['rev-parse', 'HEAD']).output.trim();
    assert.equal(
      headNow,
      epicBranchSha,
      'promoteArtifacts must not add any commit to the target repo',
    );
  });

  // ── Case 2: LEDGER PRESENT ───────────────────────────────────────────────────

  it('case 2: loom-home repos/<slug>/<epicId>/ directory exists', () => {
    const reposDir = path.join(loomHomePath, 'repos');
    assert.ok(fs.existsSync(reposDir), 'repos/ dir must exist in loom-home');
    const slugs = fs.readdirSync(reposDir);
    assert.equal(slugs.length, 1, `expected exactly one slug dir; got: ${slugs.join(', ')}`);
    const artifactDir = path.join(reposDir, slugs[0], epicId);
    assert.ok(fs.existsSync(artifactDir), `artifact dir must exist at: ${artifactDir}`);
  });

  it('case 2: loom-home artifact dir contains project-brief.md', () => {
    const reposDir = path.join(loomHomePath, 'repos');
    const slugs = fs.readdirSync(reposDir);
    const artifactDir = path.join(reposDir, slugs[0], epicId);
    assert.ok(
      fs.existsSync(path.join(artifactDir, 'project-brief.md')),
      'project-brief.md must be in loom-home artifact dir',
    );
  });

  it('case 2: loom-home artifact dir contains prd.md', () => {
    const reposDir = path.join(loomHomePath, 'repos');
    const slugs = fs.readdirSync(reposDir);
    const artifactDir = path.join(reposDir, slugs[0], epicId);
    assert.ok(
      fs.existsSync(path.join(artifactDir, 'prd.md')),
      'prd.md must be in loom-home artifact dir',
    );
  });

  it('case 2: loom-home artifact dir contains architecture.md', () => {
    const reposDir = path.join(loomHomePath, 'repos');
    const slugs = fs.readdirSync(reposDir);
    const artifactDir = path.join(reposDir, slugs[0], epicId);
    assert.ok(
      fs.existsSync(path.join(artifactDir, 'architecture.md')),
      'architecture.md must be in loom-home artifact dir',
    );
  });

  it('case 2: loom-home artifact dir contains epic.yaml', () => {
    const reposDir = path.join(loomHomePath, 'repos');
    const slugs = fs.readdirSync(reposDir);
    const artifactDir = path.join(reposDir, slugs[0], epicId);
    assert.ok(
      fs.existsSync(path.join(artifactDir, 'epic.yaml')),
      'epic.yaml must be in loom-home artifact dir',
    );
  });

  it('case 2: loom-home artifact dir contains provenance.json', () => {
    const reposDir = path.join(loomHomePath, 'repos');
    const slugs = fs.readdirSync(reposDir);
    const artifactDir = path.join(reposDir, slugs[0], epicId);
    assert.ok(
      fs.existsSync(path.join(artifactDir, 'provenance.json')),
      'provenance.json must be in loom-home artifact dir',
    );
  });

  it('case 2: loom-home has at least two commits (initial + artifact commit)', () => {
    const countRes = gitSafe(loomHomePath, ['rev-list', '--count', 'HEAD']);
    const count = parseInt(countRes.output.trim(), 10);
    assert.ok(count >= 2, `loom-home must have at least 2 commits; got: ${count}`);
  });

  it('case 2: loom-home commit includes artifacts under repos/<slug>/<epicId>/', () => {
    const lsRes = gitSafe(loomHomePath, ['ls-tree', '--name-only', '-r', 'HEAD']);
    const committedFiles = lsRes.output.trim().split('\n').filter(Boolean);
    const artifactFiles = committedFiles.filter((f) => f.includes(epicId));
    assert.ok(
      artifactFiles.length > 0,
      `loom-home HEAD must include committed artifact files for ${epicId}; got: ${committedFiles.join(', ')}`,
    );
  });

  it('case 2: provenance.json references the correct epic_id', () => {
    const reposDir = path.join(loomHomePath, 'repos');
    const slugs = fs.readdirSync(reposDir);
    const artifactDir = path.join(reposDir, slugs[0], epicId);
    const provenance = JSON.parse(
      fs.readFileSync(path.join(artifactDir, 'provenance.json'), 'utf8'),
    );
    assert.equal(provenance.epic_id, epicId, 'provenance.json must reference the correct epic_id');
  });

  it('case 2: EpicStore loom_home_status=committed', () => {
    const { status } = store.getLoomHomeStatus(epicId);
    assert.equal(status, 'committed');
  });
});

// ── Case 3: NO HISTORY REWRITE ───────────────────────────────────────────────
//
// Seed the target repo with a pre-existing .loom_outputs/<old-epic>/ commit,
// capture its SHA, then run promoteArtifacts. Assert that the old commit SHA
// is byte-for-byte unchanged — no rebase or rewrite occurred.

describe('target-repo code-only invariant — case 3: no history rewrite of pre-existing .loom_outputs commits', () => {
  let tmp: string;
  let targetRepo: string;
  let loomHomePath: string;
  let store: EpicStore;
  let oldLoomOutputsSha: string;
  const epicId = 'epic-codeonly-003';

  before(() => {
    tmp = makeTmp();
    targetRepo = path.join(tmp, 'target');
    loomHomePath = path.join(tmp, 'loom-home');

    // --- Target repo: initial commit ---
    initRepo(targetRepo);
    initialCommit(targetRepo);

    // --- Commit a pre-existing .loom_outputs/<old-epic>/ to simulate old behavior ---
    const oldOutputDir = path.join(targetRepo, '.loom_outputs', 'old-epic-001');
    fs.mkdirSync(oldOutputDir, { recursive: true });
    fs.writeFileSync(path.join(oldOutputDir, 'data.md'), '# Old artifacts\n', 'utf8');
    gitSafe(targetRepo, ['add', '.loom_outputs']);
    gitSafe(targetRepo, ['commit', '-m', 'feat: old loom outputs (pre-migration artifact)']);
    oldLoomOutputsSha = gitSafe(targetRepo, ['rev-parse', 'HEAD']).output.trim();

    // --- Epic branch from the .loom_outputs commit, adding code ---
    gitSafe(targetRepo, ['checkout', '-b', `epic/${epicId}`]);
    const srcDir = path.join(targetRepo, 'src');
    fs.mkdirSync(srcDir, { recursive: true });
    fs.writeFileSync(path.join(srcDir, 'feature.ts'), 'export const y = 2;\n', 'utf8');
    gitSafe(targetRepo, ['add', path.join('src', 'feature.ts')]);
    gitSafe(targetRepo, ['commit', '-m', 'feat: add feature for new epic']);

    // Planning artifacts on disk only (not committed to the target repo).
    const paths = seedPlanningArtifacts(targetRepo, epicId);

    // --- Loom-home: init + initial commit ---
    initRepo(loomHomePath);
    initialCommit(loomHomePath, 'initial');

    // --- EpicStore: create epic row ---
    const loomDir = path.join(targetRepo, '.loom');
    const db = createDatabase(path.join(loomDir, 'loom.db'));
    store = new EpicStore(db);
    store.create(epicId, 'History rewrite guard test epic');
    store.updatePaths(epicId, {
      brief_path: paths.brief_path,
      prd_path: paths.prd_path,
      yaml_path: paths.yaml_path,
    });
    store.updateBaseSha(epicId, oldLoomOutputsSha);

    // --- Call promoteArtifacts (the method under test) ---
    const finalizer = new EpicFinalizer({
      projectRoot: targetRepo,
      db,
      allowedRemotes: [],
      prStrategy: 'per-epic',
      loomHome: loomHomePath,
    });
    const epic = store.get(epicId)!;
    callPromoteArtifacts(finalizer, epicId, epic, store);
  });

  after(() => fs.rmSync(tmp, { recursive: true, force: true }));

  it('case 3: the pre-existing .loom_outputs commit SHA is unchanged in git history (no rebase)', () => {
    const logRes = gitSafe(targetRepo, ['rev-list', '--all']);
    const allShas = logRes.output.trim().split('\n').filter(Boolean);
    assert.ok(
      allShas.includes(oldLoomOutputsSha),
      `old .loom_outputs commit SHA must still be in history unchanged; ` +
        `expected ${oldLoomOutputsSha} in: ${allShas.join(', ')}`,
    );
  });

  it('case 3: the pre-existing .loom_outputs files are accessible at the captured SHA', () => {
    const showRes = gitSafe(targetRepo, [
      'show',
      '--name-only',
      '--pretty=format:',
      oldLoomOutputsSha,
    ]);
    assert.ok(
      showRes.output.includes('.loom_outputs'),
      `old commit must still reference .loom_outputs files; got: ${showRes.output}`,
    );
  });

  it('case 3: EpicStore loom_home_status=committed (promoteArtifacts succeeded)', () => {
    const { status } = store.getLoomHomeStatus(epicId);
    assert.equal(
      status,
      'committed',
      'loom-home commit must succeed even when target has old .loom_outputs history',
    );
  });

  it('case 3: loom-home captures artifacts without touching target repo commits', () => {
    const reposDir = path.join(loomHomePath, 'repos');
    assert.ok(fs.existsSync(reposDir), 'repos/ dir must exist in loom-home');
    const slugs = fs.readdirSync(reposDir);
    assert.equal(slugs.length, 1);
    const artifactDir = path.join(reposDir, slugs[0], epicId);
    assert.ok(
      fs.existsSync(path.join(artifactDir, 'provenance.json')),
      'provenance.json must exist in loom-home',
    );
  });
});
