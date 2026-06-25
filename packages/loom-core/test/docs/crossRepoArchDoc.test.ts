import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';

const MAX_ANCESTOR_DEPTH = 12;

function findRepoRoot(): string {
  let dir = __dirname;
  for (let i = 0; i < MAX_ANCESTOR_DEPTH; i++) {
    if (
      fs.existsSync(path.join(dir, 'packages', 'loom-core')) &&
      fs.existsSync(path.join(dir, 'packages', 'loom-cli'))
    ) {
      return dir;
    }
    dir = path.dirname(dir);
  }
  throw new Error('could not locate monorepo root');
}

const ARCH_DOC_REL = 'docs/architecture/cross-repo-loom-home.md';
const MKDOCS_REL = 'mkdocs.yml';

describe('docs/architecture/cross-repo-loom-home.md — promoted as-shipped doc (story-064-004)', () => {
  let content: string;
  let repoRoot: string;

  before(() => {
    repoRoot = findRepoRoot();
    content = fs.readFileSync(path.join(repoRoot, ARCH_DOC_REL), 'utf8');
  });

  // AC2: Status flip — no design/phasing markers survive
  it('does not contain "Status: design" marker', () => {
    assert.ok(!content.includes('Status: design'), 'must not contain "Status: design"');
  });

  it('does not contain "proposed" framing', () => {
    assert.ok(!/\bproposed\b/i.test(content), 'must not contain "proposed" framing');
  });

  it('does not contain "NEXT BUILD" marker', () => {
    assert.ok(!content.includes('NEXT BUILD'), 'must not contain "NEXT BUILD"');
  });

  it('does not contain "Phase 1" phasing language', () => {
    assert.ok(!/\bPhase 1\b/.test(content), 'must not contain "Phase 1" phasing language');
  });

  it('does not contain "Phase 2" phasing language', () => {
    assert.ok(!/\bPhase 2\b/.test(content), 'must not contain "Phase 2" phasing language');
  });

  it('does not contain "Phase 3" phasing language', () => {
    assert.ok(!/\bPhase 3\b/.test(content), 'must not contain "Phase 3" phasing language');
  });

  it('does not contain open-questions section', () => {
    assert.ok(
      !/## Open questions/i.test(content),
      'must not contain an "Open questions" section'
    );
  });

  it('is labeled as shipped across epics 050–063', () => {
    assert.ok(
      /shipped across epics 050[–-]063/i.test(content),
      'must be labeled as shipped across epics 050–063'
    );
  });

  // AC2: no parallel duplicate architecture file created
  it('no parallel/duplicate architecture file was created', () => {
    const archDir = path.join(repoRoot, 'docs', 'architecture');
    const files = fs.readdirSync(archDir);
    // Only cross-repo-loom-home.md should be the cross-repo architecture file
    const crossRepoFiles = files.filter(
      f => f !== 'cross-repo-loom-home.md' && /cross.repo|loom.home/i.test(f)
    );
    assert.deepStrictEqual(
      crossRepoFiles,
      [],
      `No parallel cross-repo architecture files should exist, found: ${crossRepoFiles.join(', ')}`
    );
  });

  // FR-6: exact config-precedence string
  it('contains the exact CONFIG_HIERARCHY precedence string (FR-6)', () => {
    const hierarchy =
      'loom-home team config (base)  ←  target-repo policy.yaml (override)  ←  env vars (secrets / final override)';
    assert.ok(
      content.includes(hierarchy),
      `must contain exact config hierarchy: "${hierarchy}"`
    );
  });

  // AC1: shipped-tense coverage of key topics
  it('describes the loom-home control plane', () => {
    assert.ok(
      /loom-home.*control plane|control plane.*loom-home/i.test(content),
      'must describe the loom-home control plane'
    );
  });

  it('describes the workspace manifest', () => {
    assert.ok(
      /workspace.*manifest|workspace\.yaml/i.test(content),
      'must describe the workspace manifest'
    );
  });

  it('describes cross-repo execution', () => {
    assert.ok(
      /cross.repo.*execution|cross-repo execution/i.test(content),
      'must describe cross-repo execution'
    );
  });

  it('describes ordered (topological) landing', () => {
    assert.ok(
      /topolog|dependency order|ordered landing/i.test(content),
      'must describe ordered/topological landing'
    );
  });

  it('describes forward-revert rollback', () => {
    assert.ok(
      /forward.revert rollback|forward.revert|rollback/i.test(content),
      'must describe forward-revert rollback'
    );
  });

  // AC3: no contradiction — uses canonical CROSS_REPO_LANDING phrasing
  it('uses canonical CROSS_REPO_LANDING phrasing (ADR-003)', () => {
    const canonical =
      'A single-repo epic produces one pull request. A cross-repo epic produces one\npull request per repository, landed in topological (dependency) order with\nall-ready-or-none staging and forward-revert rollback.';
    assert.ok(
      content.includes(canonical),
      'must contain canonical CROSS_REPO_LANDING phrasing'
    );
  });

  // AC3: deferred items listed as NOT shipped
  it('lists Mission Control as not shipped', () => {
    assert.ok(
      /Mission Control.*not shipped|not shipped.*Mission Control/i.test(content),
      'Mission Control must be listed as not shipped'
    );
  });

  it('does not claim Jira intake adapter is shipped', () => {
    // It may mention it as deferred, but must not claim it as a shipped feature
    const jiraIdx = content.indexOf('Jira intake adapter');
    if (jiraIdx !== -1) {
      const surrounding = content.slice(Math.max(0, jiraIdx - 50), jiraIdx + 100);
      assert.ok(
        /not shipped|deferred|not in scope/i.test(surrounding),
        'Jira intake adapter must be mentioned only as deferred/not shipped'
      );
    }
  });
});

describe('mkdocs.yml — Architecture nav entry (story-064-004)', () => {
  let navContent: string;
  let repoRoot: string;

  before(() => {
    repoRoot = findRepoRoot();
    navContent = fs.readFileSync(path.join(repoRoot, MKDOCS_REL), 'utf8');
  });

  it('lists cross-repo-loom-home.md under the Architecture section', () => {
    // Parse nav structure to find the Architecture section
    const lines = navContent.split('\n');
    let inArch = false;
    let found = false;
    for (const line of lines) {
      if (/^  - "Architecture"/.test(line)) {
        inArch = true;
        continue;
      }
      // Next top-level nav section ends Architecture
      if (inArch && /^  - "/.test(line) && !/^    /.test(line)) {
        inArch = false;
      }
      if (inArch && line.includes('architecture/cross-repo-loom-home.md')) {
        found = true;
        break;
      }
    }
    assert.ok(found, 'mkdocs.yml must list architecture/cross-repo-loom-home.md under "Architecture"');
  });
});

describe('mkdocs build smoke check (story-064-004)', () => {
  let repoRoot: string;

  before(() => {
    repoRoot = findRepoRoot();
  });

  it('mkdocs build succeeds with no "not in nav" warning for cross-repo-loom-home.md', () => {
    // Find mkdocs binary — try PATH first, then known pip install location
    const mkdocsCandidates = [
      'mkdocs',
      '/Users/jeromeortega/Library/Python/3.9/bin/mkdocs',
      '/usr/local/bin/mkdocs',
    ];
    let mkdocsBin = '';
    for (const candidate of mkdocsCandidates) {
      try {
        execSync(`${candidate} --version`, { stdio: 'pipe' });
        mkdocsBin = candidate;
        break;
      } catch {
        // try next
      }
    }

    if (!mkdocsBin) {
      // mkdocs not available — skip gracefully
      console.log('  [skip] mkdocs not found; skipping build smoke check');
      return;
    }

    let output = '';
    try {
      output = execSync(`${mkdocsBin} build --strict 2>&1`, {
        cwd: repoRoot,
        encoding: 'utf8',
        timeout: 60_000,
      });
    } catch (err: unknown) {
      const e = err as { stdout?: string; stderr?: string; message?: string };
      output = (e.stdout ?? '') + (e.stderr ?? '') + (e.message ?? '');
      // Check if the failure is specifically about cross-repo-loom-home.md
      if (/cross-repo-loom-home/.test(output) && /not in nav/i.test(output)) {
        assert.fail(
          `mkdocs build failed: cross-repo-loom-home.md is not in the nav. Output:\n${output}`
        );
      }
      // Any other strict-mode failure — still report but don't mask nav issue
      assert.fail(`mkdocs build failed:\n${output}`);
    }

    // Confirm no "not in nav" warning for our file
    assert.ok(
      !(/cross-repo-loom-home.*not in nav|not in nav.*cross-repo-loom-home/i.test(output)),
      `mkdocs build should not warn about cross-repo-loom-home.md not being in nav. Output:\n${output}`
    );
  });
});
