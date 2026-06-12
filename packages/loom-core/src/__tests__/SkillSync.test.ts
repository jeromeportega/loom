import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SourcesConfig } from '../skills/SourcesConfig.js';
import { SkillSync, updatePinInPlace } from '../skills/SkillSync.js';

let work: string;
let upstream: string;
let upstreamCloneUrl: string;
let mirrorRoot: string;

function gitc(args: string[], cwd: string): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

/** Creates an upstream "source repo" we can clone from via a file:// URL. */
function seedUpstream(): { url: string; baseSha: string; secondSha: string } {
  upstream = fs.mkdtempSync(path.join(os.tmpdir(), 'loom-skills-up-'));
  gitc(['init', '-q', '-b', 'main'], upstream);
  gitc(['config', 'user.email', 't@loom.dev'], upstream);
  gitc(['config', 'user.name', 'T'], upstream);
  gitc(['config', 'commit.gpgsign', 'false'], upstream);
  fs.writeFileSync(path.join(upstream, 'README.md'), '# loom-skills\n');
  gitc(['add', '.'], upstream);
  gitc(['commit', '-q', '-m', 'initial'], upstream);
  const baseSha = gitc(['rev-parse', 'HEAD'], upstream);
  fs.writeFileSync(path.join(upstream, 'README.md'), '# loom-skills v2\n');
  gitc(['add', '.'], upstream);
  gitc(['commit', '-q', '-m', 'second'], upstream);
  const secondSha = gitc(['rev-parse', 'HEAD'], upstream);
  return { url: `file://${upstream}`, baseSha, secondSha };
}

beforeEach(() => {
  work = fs.mkdtempSync(path.join(os.tmpdir(), 'loom-skills-work-'));
  mirrorRoot = path.join(work, 'shared');
});

afterEach(() => {
  fs.rmSync(work, { recursive: true, force: true });
  if (upstream) fs.rmSync(upstream, { recursive: true, force: true });
});

function configWithOneSource(opts: {
  url: string;
  pinned?: string;
  envVar?: string;
}): SourcesConfig {
  const file = path.join(work, 'sources.yaml');
  fs.writeFileSync(
    file,
    `sources:\n` +
      `  - name: loom-skills\n` +
      `    url: ${opts.url}\n` +
      `    branch: main\n` +
      (opts.pinned !== undefined ? `    pinned_sha: "${opts.pinned}"\n` : '') +
      `    auth:\n` +
      `      type: github_pat\n` +
      `      env_var: ${opts.envVar ?? 'LOOM_SKILLS_PAT'}\n`,
  );
  return SourcesConfig.load({ path: file });
}

describe('SkillSync.sync — first sync (empty pin)', () => {
  it('clones the upstream and captures the branch HEAD as the new pin', () => {
    const { url, secondSha } = seedUpstream();
    const config = configWithOneSource({ url });
    const sync = new SkillSync({
      config,
      mirrorRoot,
      env: () => 'fake-pat-value', // file:// ignores the PAT but presence is required
      onProgress: () => {},
    });
    const report = sync.sync();
    assert.equal(report.results.length, 1);
    assert.equal(report.results[0].status, 'first-sync');
    assert.equal(report.results[0].newSha, secondSha);
    assert.deepEqual(report.pinUpdates, [{ name: 'loom-skills', sha: secondSha }]);
    assert.equal(
      fs.existsSync(path.join(mirrorRoot, 'loom-skills', '.git')),
      true,
      'mirror should exist on disk after first sync',
    );
  });
});

describe('SkillSync.sync — pin enforcement', () => {
  it('checks out a specific pin instead of HEAD', () => {
    const { url, baseSha, secondSha } = seedUpstream();
    const config = configWithOneSource({ url, pinned: baseSha });
    const sync = new SkillSync({
      config,
      mirrorRoot,
      env: () => 'fake',
      onProgress: () => {},
    });
    const report = sync.sync();
    assert.equal(report.results[0].status, 'updated');
    assert.equal(report.results[0].newSha, baseSha);
    // No pin advance — pin already provided, no update flag.
    assert.deepEqual(report.pinUpdates, []);
    // Verify HEAD actually moved to baseSha.
    const mirror = path.join(mirrorRoot, 'loom-skills');
    assert.equal(gitc(['rev-parse', 'HEAD'], mirror), baseSha);
    assert.notEqual(baseSha, secondSha, 'sanity: baseSha != secondSha');
  });
});

describe('SkillSync.sync — repeat run is idempotent', () => {
  it('second sync against the same pin reports unchanged', () => {
    const { url, baseSha } = seedUpstream();
    const config = configWithOneSource({ url, pinned: baseSha });
    const sync = new SkillSync({
      config,
      mirrorRoot,
      env: () => 'fake',
      onProgress: () => {},
    });
    sync.sync();
    const second = sync.sync();
    assert.equal(second.results[0].status, 'unchanged');
    assert.equal(second.pinUpdates.length, 0);
  });
});

describe('SkillSync.sync — --update advances the pin', () => {
  it('moves the mirror to branch HEAD and reports a pin update', () => {
    const { url, baseSha, secondSha } = seedUpstream();
    // Start pinned to the older commit.
    const config = configWithOneSource({ url, pinned: baseSha });
    const sync = new SkillSync({
      config,
      mirrorRoot,
      env: () => 'fake',
      onProgress: () => {},
    });
    sync.sync(); // initial sync to the old pin
    const report = sync.sync({ update: true });
    assert.equal(report.results[0].status, 'updated');
    assert.equal(report.results[0].newSha, secondSha);
    assert.deepEqual(report.pinUpdates, [{ name: 'loom-skills', sha: secondSha }]);
  });
});

describe('SkillSync.sync — missing PAT', () => {
  it('errors when the auth env var is unset', () => {
    const { url } = seedUpstream();
    const config = configWithOneSource({ url, envVar: 'LOOM_SKILLS_PAT' });
    const sync = new SkillSync({
      config,
      mirrorRoot,
      env: () => undefined, // PAT unset
      onProgress: () => {},
    });
    const report = sync.sync();
    assert.equal(report.results[0].status, 'error');
    assert.match(report.results[0].error ?? '', /LOOM_SKILLS_PAT/);
    assert.match(report.results[0].error ?? '', /unset/);
    // No partial mirror dir created.
    assert.equal(
      fs.existsSync(path.join(mirrorRoot, 'loom-skills', '.git')),
      false,
    );
  });

  it('scrubs the PAT from error messages even when set', () => {
    // Upstream URL points at a directory that doesn't exist — git fails;
    // we want to confirm the PAT (if any) doesn't leak in the error path.
    const config = configWithOneSource({
      url: 'https://example.invalid/loom-skills.git',
    });
    const sync = new SkillSync({
      config,
      mirrorRoot,
      env: () => 'SUPER_SECRET_PAT_VALUE',
      onProgress: () => {},
    });
    const report = sync.sync();
    assert.equal(report.results[0].status, 'error');
    assert.ok(
      !((report.results[0].error ?? '').includes('SUPER_SECRET_PAT_VALUE')),
      'PAT must not appear in error messages',
    );
  });
});

describe('SkillSync.sync — empty config is a no-op', () => {
  it('does nothing when sources.yaml has no sources', () => {
    const file = path.join(work, 'sources.yaml');
    fs.writeFileSync(file, 'sources: []\n');
    const config = SourcesConfig.load({ path: file });
    const sync = new SkillSync({
      config,
      mirrorRoot,
      env: () => 'fake',
      onProgress: () => {},
    });
    const report = sync.sync();
    assert.equal(report.results.length, 0);
    assert.equal(report.pinUpdates.length, 0);
  });
});

describe('updatePinInPlace — surgical YAML edit', () => {
  it('replaces an existing pinned_sha line and preserves surrounding text', () => {
    const before = [
      '# operator comment 1',
      'sources:',
      '  - name: loom-skills',
      '    url: https://ghe.example/acme/loom-skills.git',
      '    branch: main',
      '    pinned_sha: "OLD_SHA"  # original pin',
      '    auth:',
      '      type: github_pat',
      '      env_var: LOOM_SKILLS_PAT',
      '# trailing comment',
      '',
    ].join('\n');
    const after = updatePinInPlace(before, 'loom-skills', 'NEW_SHA');
    assert.match(after, /pinned_sha: "NEW_SHA"/);
    assert.ok(!after.includes('OLD_SHA'), 'old SHA must be replaced');
    // Operator comments survive.
    assert.match(after, /# operator comment 1/);
    assert.match(after, /# trailing comment/);
  });

  it('inserts a pinned_sha line when the source had none', () => {
    const before = [
      'sources:',
      '  - name: loom-skills',
      '    url: https://ghe.example/acme/loom-skills.git',
      '    branch: main',
      '    auth: { type: github_pat, env_var: LOOM_SKILLS_PAT }',
      '',
    ].join('\n');
    const after = updatePinInPlace(before, 'loom-skills', 'CAPTURED_SHA');
    assert.match(after, /pinned_sha: "CAPTURED_SHA"/);
  });

  it('only edits the target source when multiple sources are present', () => {
    const before = [
      'sources:',
      '  - name: loom-skills',
      '    url: https://ghe.example/acme/loom-skills.git',
      '    pinned_sha: "LOOM_OLD"',
      '    auth: { type: github_pat, env_var: A }',
      '  - name: other-skills',
      '    url: https://ghe.example/other/skills.git',
      '    pinned_sha: "OTHER_OLD"',
      '    auth: { type: github_pat, env_var: B }',
      '',
    ].join('\n');
    const after = updatePinInPlace(before, 'loom-skills', 'LOOM_NEW');
    assert.match(after, /pinned_sha: "LOOM_NEW"/);
    assert.match(after, /pinned_sha: "OTHER_OLD"/, 'other source must stay untouched');
    assert.ok(!after.includes('LOOM_OLD'));
  });
});
