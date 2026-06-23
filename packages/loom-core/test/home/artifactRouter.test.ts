import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { routeArtifacts } from '../../src/home/artifactRouter.js';
import type { Provenance } from '../../src/home/types.js';
import { gitSafe } from '../../src/orchestrator/git.js';

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeTmp(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'loom-router-'));
}

function gitInit(dir: string): void {
  const res = gitSafe(dir, ['init']);
  if (!res.ok) throw new Error(`git init failed: ${res.output}`);
}

function gitCommit(dir: string): void {
  gitSafe(dir, ['config', 'user.email', 'test@loom.test']);
  gitSafe(dir, ['config', 'user.name', 'Loom Test']);
  const sentinel = path.join(dir, 'README.md');
  fs.writeFileSync(sentinel, '# test\n', 'utf8');
  gitSafe(dir, ['add', 'README.md']);
  gitSafe(dir, ['commit', '-m', 'initial']);
}

function setupSourceArtifacts(runDir: string): { [K in 'brief' | 'prd' | 'architecture' | 'epicYaml']: string } {
  const epicsDir = path.join(runDir, 'epics');
  fs.mkdirSync(epicsDir, { recursive: true });
  const brief = path.join(runDir, 'project-brief.md');
  const prd = path.join(runDir, 'prd.md');
  const architecture = path.join(runDir, 'architecture.md');
  const epicYaml = path.join(epicsDir, 'epic-001.yaml');
  fs.writeFileSync(brief, '# Brief content\n', 'utf8');
  fs.writeFileSync(prd, '# PRD content\n', 'utf8');
  fs.writeFileSync(architecture, '# Architecture content\n', 'utf8');
  fs.writeFileSync(epicYaml, 'id: epic-001\n', 'utf8');
  return { brief, prd, architecture, epicYaml };
}

const FIXED_CLOCK = '2026-01-15T10:00:00.000Z';
const clock = () => FIXED_CLOCK;

// ── Case 1: All four artifacts land in loom-home, target repo untouched ───────

describe('routeArtifacts — case 1: all four artifacts written to loom-home', () => {
  let tmp: string;
  let loomHomePath: string;
  let projectRoot: string;
  let runDir: string;
  let sources: ReturnType<typeof setupSourceArtifacts>;
  let result: ReturnType<typeof routeArtifacts>;

  before(() => {
    tmp = makeTmp();
    loomHomePath = path.join(tmp, 'loom-home');
    projectRoot = path.join(tmp, 'project');
    runDir = path.join(tmp, 'run', 'run-abc');
    fs.mkdirSync(loomHomePath, { recursive: true });
    fs.mkdirSync(projectRoot, { recursive: true });
    gitInit(loomHomePath);
    sources = setupSourceArtifacts(runDir);
    result = routeArtifacts({
      loomHomePath,
      projectRoot,
      epicId: 'epic-001',
      runId: 'run-abc',
      artifactSources: sources,
      clock,
    });
  });

  after(() => fs.rmSync(tmp, { recursive: true, force: true }));

  it('returns an artifactDir under loomHomePath', () => {
    assert.ok(
      result.artifactDir.startsWith(loomHomePath + path.sep),
      `artifactDir must be under loom-home: ${result.artifactDir}`,
    );
  });

  it('project-brief.md lands under loom-home with identical content', () => {
    const dest = path.join(result.artifactDir, 'project-brief.md');
    assert.ok(fs.existsSync(dest), 'project-brief.md must exist in artifactDir');
    assert.equal(
      fs.readFileSync(dest, 'utf8'),
      fs.readFileSync(sources.brief, 'utf8'),
    );
  });

  it('prd.md lands under loom-home with identical content', () => {
    const dest = path.join(result.artifactDir, 'prd.md');
    assert.ok(fs.existsSync(dest), 'prd.md must exist in artifactDir');
    assert.equal(
      fs.readFileSync(dest, 'utf8'),
      fs.readFileSync(sources.prd, 'utf8'),
    );
  });

  it('architecture.md lands under loom-home with identical content', () => {
    const dest = path.join(result.artifactDir, 'architecture.md');
    assert.ok(fs.existsSync(dest), 'architecture.md must exist in artifactDir');
    assert.equal(
      fs.readFileSync(dest, 'utf8'),
      fs.readFileSync(sources.architecture, 'utf8'),
    );
  });

  it('epic.yaml lands under loom-home with identical content', () => {
    const dest = path.join(result.artifactDir, 'epic.yaml');
    assert.ok(fs.existsSync(dest), 'epic.yaml must exist in artifactDir');
    assert.equal(
      fs.readFileSync(dest, 'utf8'),
      fs.readFileSync(sources.epicYaml, 'utf8'),
    );
  });

  it('nothing is written into the target repo working tree', () => {
    const projectFiles = fs.readdirSync(projectRoot);
    assert.equal(projectFiles.length, 0, `target repo must remain empty, got: ${projectFiles}`);
  });
});

// ── Case 2: provenance.json has all required fields ───────────────────────────

describe('routeArtifacts — case 2: provenance.json fields', () => {
  let tmp: string;
  let loomHomePath: string;
  let projectRoot: string;
  let provenance: Provenance;
  let result: ReturnType<typeof routeArtifacts>;

  before(() => {
    tmp = makeTmp();
    loomHomePath = path.join(tmp, 'loom-home');
    projectRoot = path.join(tmp, 'my-app');
    const runDir = path.join(tmp, 'run', 'run-xyz');
    fs.mkdirSync(loomHomePath, { recursive: true });
    fs.mkdirSync(projectRoot, { recursive: true });
    gitInit(loomHomePath);
    gitInit(projectRoot);
    gitCommit(projectRoot);
    const sources = setupSourceArtifacts(runDir);
    result = routeArtifacts({
      loomHomePath,
      projectRoot,
      epicId: 'epic-002',
      runId: 'run-xyz',
      artifactSources: sources,
      clock,
    });
    const raw = fs.readFileSync(path.join(result.artifactDir, 'provenance.json'), 'utf8');
    provenance = JSON.parse(raw) as Provenance;
  });

  after(() => fs.rmSync(tmp, { recursive: true, force: true }));

  it('loom_home_schema is 1', () => {
    assert.equal(provenance.loom_home_schema, 1);
  });

  it('target_repo.name equals basename of projectRoot', () => {
    assert.equal(provenance.target_repo.name, 'my-app');
  });

  it('target_repo.path equals absolute projectRoot', () => {
    assert.equal(provenance.target_repo.path, projectRoot);
  });

  it('target_repo.slug is present and non-empty', () => {
    assert.ok(typeof provenance.target_repo.slug === 'string' && provenance.target_repo.slug.length > 0);
  });

  it('epic_id matches input', () => {
    assert.equal(provenance.epic_id, 'epic-002');
  });

  it('run_id matches input', () => {
    assert.equal(provenance.run_id, 'run-xyz');
  });

  it('target_head_sha is set (projectRoot has a commit)', () => {
    assert.ok(provenance.target_head_sha !== null, 'target_head_sha must be non-null when HEAD exists');
    assert.match(provenance.target_head_sha!, /^[0-9a-f]{40}$/);
  });

  it('created_at matches injected clock', () => {
    assert.equal(provenance.created_at, FIXED_CLOCK);
  });

  it('target_head_sha is null when projectRoot has no git history', () => {
    const noGitDir = path.join(tmp, 'no-git-project');
    fs.mkdirSync(noGitDir, { recursive: true });
    const runDir2 = path.join(tmp, 'run', 'run-nogit');
    const sources2 = setupSourceArtifacts(runDir2);
    const r2 = routeArtifacts({
      loomHomePath,
      projectRoot: noGitDir,
      epicId: 'epic-003',
      runId: 'run-nogit',
      artifactSources: sources2,
      clock,
    });
    const raw2 = fs.readFileSync(path.join(r2.artifactDir, 'provenance.json'), 'utf8');
    const p2 = JSON.parse(raw2) as Provenance;
    assert.equal(p2.target_head_sha, null);
  });
});

// ── Case 3: Slug determinism (ADR-7) ─────────────────────────────────────────

describe('routeArtifacts — case 3: slug determinism', () => {
  let tmp: string;
  let loomHomePath: string;
  let projectRoot: string;

  before(() => {
    tmp = makeTmp();
    loomHomePath = path.join(tmp, 'loom-home');
    projectRoot = path.join(tmp, 'my-project');
    fs.mkdirSync(loomHomePath, { recursive: true });
    fs.mkdirSync(projectRoot, { recursive: true });
    gitInit(loomHomePath);
  });

  after(() => fs.rmSync(tmp, { recursive: true, force: true }));

  it('same projectRoot (no remote) produces same slug across two calls', () => {
    const runDir1 = path.join(tmp, 'run1');
    const sources1 = setupSourceArtifacts(runDir1);
    const r1 = routeArtifacts({
      loomHomePath,
      projectRoot,
      epicId: 'epic-001',
      runId: 'run-1',
      artifactSources: sources1,
      clock,
    });

    const runDir2 = path.join(tmp, 'run2');
    const sources2 = setupSourceArtifacts(runDir2);
    const r2 = routeArtifacts({
      loomHomePath,
      projectRoot,
      epicId: 'epic-002',
      runId: 'run-2',
      artifactSources: sources2,
      clock,
    });

    assert.equal(r1.provenance.target_repo.slug, r2.provenance.target_repo.slug);
  });

  it('slug matches directory name on disk (three channels not drifted)', () => {
    const runDir = path.join(tmp, 'run-slug-check');
    const sources = setupSourceArtifacts(runDir);
    const r = routeArtifacts({
      loomHomePath,
      projectRoot,
      epicId: 'epic-010',
      runId: 'run-slug-check',
      artifactSources: sources,
      clock,
    });
    const slug = r.provenance.target_repo.slug;
    const reposDir = path.join(loomHomePath, 'repos');
    const slugDirs = fs.readdirSync(reposDir);
    assert.ok(slugDirs.includes(slug), `on-disk dir must equal provenance.slug (${slug}); found: ${slugDirs}`);
  });

  it('slug has format <sanitized-name>-<8-char-hex>', () => {
    const runDir = path.join(tmp, 'run-format');
    const sources = setupSourceArtifacts(runDir);
    const r = routeArtifacts({
      loomHomePath,
      projectRoot,
      epicId: 'epic-011',
      runId: 'run-format',
      artifactSources: sources,
      clock,
    });
    const slug = r.provenance.target_repo.slug;
    assert.match(slug, /^[a-z0-9-]+-[0-9a-f]{8}$/, `slug must be <name>-<8hex>: ${slug}`);
  });

  it('relDir is repos/<slug>/<epicId>', () => {
    const runDir = path.join(tmp, 'run-rel');
    const sources = setupSourceArtifacts(runDir);
    const r = routeArtifacts({
      loomHomePath,
      projectRoot,
      epicId: 'epic-012',
      runId: 'run-rel',
      artifactSources: sources,
      clock,
    });
    const slug = r.provenance.target_repo.slug;
    assert.equal(r.relDir, path.join('repos', slug, 'epic-012'));
  });
});

// ── Case 4: Boundary — absent optional sources ────────────────────────────────

describe('routeArtifacts — case 4: absent source does not throw', () => {
  let tmp: string;
  let loomHomePath: string;
  let projectRoot: string;

  before(() => {
    tmp = makeTmp();
    loomHomePath = path.join(tmp, 'loom-home');
    projectRoot = path.join(tmp, 'project');
    fs.mkdirSync(loomHomePath, { recursive: true });
    fs.mkdirSync(projectRoot, { recursive: true });
    gitInit(loomHomePath);
  });

  after(() => fs.rmSync(tmp, { recursive: true, force: true }));

  it('omitting epicYaml source copies other three and does not throw', () => {
    const runDir = path.join(tmp, 'run-partial');
    fs.mkdirSync(runDir, { recursive: true });
    const brief = path.join(runDir, 'project-brief.md');
    const prd = path.join(runDir, 'prd.md');
    const architecture = path.join(runDir, 'architecture.md');
    fs.writeFileSync(brief, '# Brief\n', 'utf8');
    fs.writeFileSync(prd, '# PRD\n', 'utf8');
    fs.writeFileSync(architecture, '# Arch\n', 'utf8');

    let result!: ReturnType<typeof routeArtifacts>;
    assert.doesNotThrow(() => {
      result = routeArtifacts({
        loomHomePath,
        projectRoot,
        epicId: 'epic-020',
        runId: 'run-partial',
        artifactSources: { brief, prd, architecture },
        clock,
      });
    });

    assert.ok(fs.existsSync(path.join(result.artifactDir, 'project-brief.md')));
    assert.ok(fs.existsSync(path.join(result.artifactDir, 'prd.md')));
    assert.ok(fs.existsSync(path.join(result.artifactDir, 'architecture.md')));
    assert.ok(!fs.existsSync(path.join(result.artifactDir, 'epic.yaml')), 'epic.yaml must not be created when source absent');
  });

  it('empty artifactSources writes only provenance.json and does not throw', () => {
    let result!: ReturnType<typeof routeArtifacts>;
    assert.doesNotThrow(() => {
      result = routeArtifacts({
        loomHomePath,
        projectRoot,
        epicId: 'epic-021',
        runId: 'run-empty',
        artifactSources: {},
        clock,
      });
    });
    assert.ok(fs.existsSync(path.join(result.artifactDir, 'provenance.json')));
    const files = fs.readdirSync(result.artifactDir);
    assert.deepEqual(files, ['provenance.json']);
  });
});

// ── Case 5: No commit — loom-home git history unchanged after routing ──────────

describe('routeArtifacts — case 5: no git commit made in loom-home', () => {
  let tmp: string;
  let loomHomePath: string;
  let projectRoot: string;

  before(() => {
    tmp = makeTmp();
    loomHomePath = path.join(tmp, 'loom-home');
    projectRoot = path.join(tmp, 'project');
    fs.mkdirSync(loomHomePath, { recursive: true });
    fs.mkdirSync(projectRoot, { recursive: true });
    gitInit(loomHomePath);
  });

  after(() => fs.rmSync(tmp, { recursive: true, force: true }));

  it('loom-home has no commits after routeArtifacts (git log empty)', () => {
    const runDir = path.join(tmp, 'run-nocommit');
    const sources = setupSourceArtifacts(runDir);

    routeArtifacts({
      loomHomePath,
      projectRoot,
      epicId: 'epic-030',
      runId: 'run-nocommit',
      artifactSources: sources,
      clock,
    });

    const logRes = gitSafe(loomHomePath, ['log', '--oneline']);
    assert.ok(
      !logRes.ok || logRes.output.trim() === '',
      `loom-home must have no commits after routeArtifacts; git log: ${logRes.output}`,
    );
  });
});

// ── Case 6: Machine-local state untouched ────────────────────────────────────

describe('routeArtifacts — case 6: machine-local state untouched', () => {
  let tmp: string;
  let loomHomePath: string;
  let projectRoot: string;

  before(() => {
    tmp = makeTmp();
    loomHomePath = path.join(tmp, 'loom-home');
    projectRoot = path.join(tmp, 'project');
    fs.mkdirSync(loomHomePath, { recursive: true });
    fs.mkdirSync(projectRoot, { recursive: true });
    gitInit(loomHomePath);
  });

  after(() => fs.rmSync(tmp, { recursive: true, force: true }));

  it('no SQLite DB is created in loom-home', () => {
    const runDir = path.join(tmp, 'run-state');
    const sources = setupSourceArtifacts(runDir);

    routeArtifacts({
      loomHomePath,
      projectRoot,
      epicId: 'epic-040',
      runId: 'run-state',
      artifactSources: sources,
      clock,
    });

    const dbFiles = fs.readdirSync(loomHomePath, { recursive: true })
      .map(String)
      .filter(f => f.endsWith('.db'));
    assert.equal(dbFiles.length, 0, `no SQLite DB must be created in loom-home; found: ${dbFiles}`);
  });

  it('no worktrees directory is created in loom-home', () => {
    const runDir = path.join(tmp, 'run-state2');
    const sources = setupSourceArtifacts(runDir);

    routeArtifacts({
      loomHomePath,
      projectRoot,
      epicId: 'epic-041',
      runId: 'run-state2',
      artifactSources: sources,
      clock,
    });

    const hasWorktrees = fs.existsSync(path.join(loomHomePath, 'worktrees'));
    assert.ok(!hasWorktrees, 'no worktrees directory must be created in loom-home');
  });
});
