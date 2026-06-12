import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SourcesConfig } from '../skills/SourcesConfig.js';
import { SkillProposer } from '../skills/SkillProposer.js';

let work: string;
let generatedDir: string;
let upstream: string;
let upstreamUrl: string;

function gitc(args: string[], cwd: string): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

function seedUpstream(): string {
  upstream = fs.mkdtempSync(path.join(os.tmpdir(), 'loom-propose-up-'));
  gitc(['init', '-q', '-b', 'main'], upstream);
  gitc(['config', 'user.email', 't@loom.dev'], upstream);
  gitc(['config', 'user.name', 'T'], upstream);
  gitc(['config', 'commit.gpgsign', 'false'], upstream);
  gitc(['config', 'receive.denyCurrentBranch', 'updateInstead'], upstream);
  fs.mkdirSync(path.join(upstream, 'skills'), { recursive: true });
  fs.writeFileSync(path.join(upstream, 'README.md'), '# upstream\n');
  gitc(['add', '.'], upstream);
  gitc(['commit', '-q', '-m', 'initial'], upstream);
  return `file://${upstream}`;
}

function seedCandidate(name: string, opts: { description?: string; body?: string } = {}): void {
  const dir = path.join(generatedDir, name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'SKILL.md'),
    `---\n` +
      `name: ${name}\n` +
      `description: ${opts.description ?? 'A useful skill.'}\n` +
      `metadata:\n` +
      `  source: generated\n` +
      `  lifecycle: candidate\n` +
      `---\n\n` +
      `# ${name}\n\n${opts.body ?? 'Do the thing carefully.\nSecond line.'}\n`,
  );
}

function makeConfig(opts: { sources: string[] }): SourcesConfig {
  const file = path.join(work, 'sources.yaml');
  const body =
    `sources:\n` +
    opts.sources
      .map((n, i) => {
        const url =
          i === 0 ? upstreamUrl : 'https://ghe.example/acme/' + n + '.git';
        return (
          `  - name: ${n}\n` +
          `    url: ${url}\n` +
          `    branch: main\n` +
          `    auth: { type: github_pat, env_var: ${n.toUpperCase().replace(/-/g, '_')}_PAT }\n`
        );
      })
      .join('');
  fs.writeFileSync(file, body);
  return SourcesConfig.load({ path: file });
}

beforeEach(() => {
  work = fs.mkdtempSync(path.join(os.tmpdir(), 'loom-propose-work-'));
  generatedDir = path.join(work, 'generated');
  fs.mkdirSync(generatedDir);
  upstreamUrl = seedUpstream();
});

afterEach(() => {
  fs.rmSync(work, { recursive: true, force: true });
  fs.rmSync(upstream, { recursive: true, force: true });
});

describe('SkillProposer.propose — operator-initiated path', () => {
  it('clones, branches, commits the candidate, pushes, and calls prCreator', () => {
    seedCandidate('python-testing', {
      description: 'Pytest conventions for the team.',
    });
    const config = makeConfig({ sources: ['loom-skills'] });

    const prCalls: Array<{ head: string; title: string }> = [];
    const proposer = new SkillProposer({
      sourcesConfig: config,
      generatedDir,
      env: () => 'fake',
      onProgress: () => {},
      prCreator: ({ head, title }) => {
        prCalls.push({ head, title });
        return `https://ghe.example/acme/loom-skills/pull/42`;
      },
    });

    const result = proposer.propose({ candidateName: 'python-testing' });
    assert.equal(result.status, 'proposed');
    assert.equal(result.sourceName, 'loom-skills');
    assert.equal(result.url, 'https://ghe.example/acme/loom-skills/pull/42');
    assert.match(result.branch ?? '', /^propose\/python-testing-/);
    assert.equal(prCalls.length, 1);
    assert.match(prCalls[0].title, /python-testing/);
    assert.equal(prCalls[0].head, result.branch);

    // The push landed because we configured the upstream with
    // receive.denyCurrentBranch=updateInstead — the branch should be
    // visible upstream.
    const branches = gitc(['branch', '-a'], upstream);
    assert.match(branches, new RegExp(result.branch!));

    // The committed skill file should be in the pushed branch's tree. We
    // can't check the working tree because the upstream's HEAD is `main`,
    // not the propose branch — read the file directly out of the ref.
    const branchTree = gitc(
      ['ls-tree', '-r', result.branch!, '--name-only'],
      upstream,
    );
    assert.match(branchTree, /skills\/python-testing\/SKILL\.md/);
    const upstreamSkill = gitc(
      ['show', `${result.branch}:skills/python-testing/SKILL.md`],
      upstream,
    );
    assert.ok(
      !upstreamSkill.includes('lifecycle: candidate'),
      'loom-local lifecycle metadata must be stripped before commit',
    );
    assert.ok(
      !/\bsource:\s*generated\b/.test(upstreamSkill),
      'loom-local source: generated metadata must be stripped before commit',
    );
  });

  it('honors --dry-run: composes body, does not clone or push', () => {
    seedCandidate('python-testing');
    const config = makeConfig({ sources: ['loom-skills'] });

    const proposer = new SkillProposer({
      sourcesConfig: config,
      generatedDir,
      env: () => 'fake',
      onProgress: () => {},
      prCreator: () => {
        assert.fail('prCreator must not run in --dry-run');
      },
    });

    const result = proposer.propose({ candidateName: 'python-testing', dryRun: true });
    assert.equal(result.status, 'dry-run');
    assert.match(result.body ?? '', /Description/);
    assert.match(result.body ?? '', /Review questions/);

    // Upstream should not have a propose branch — we never pushed.
    const branches = gitc(['branch', '-a'], upstream);
    assert.ok(!branches.includes('propose/python-testing-'));
  });

  it('returns an error when the candidate dir is missing', () => {
    const config = makeConfig({ sources: ['loom-skills'] });
    const proposer = new SkillProposer({
      sourcesConfig: config,
      generatedDir,
      env: () => 'fake',
      onProgress: () => {},
      prCreator: () => 'http://unused',
    });
    const result = proposer.propose({ candidateName: 'never-generated' });
    assert.equal(result.status, 'error');
    assert.match(result.error ?? '', /No candidate at/);
  });

  it('requires --source when multiple sources are configured', () => {
    seedCandidate('python-testing');
    const config = makeConfig({ sources: ['loom-skills', 'other-skills'] });
    const proposer = new SkillProposer({
      sourcesConfig: config,
      generatedDir,
      env: () => 'fake',
      onProgress: () => {},
      prCreator: () => 'http://unused',
    });
    const result = proposer.propose({ candidateName: 'python-testing' });
    assert.equal(result.status, 'error');
    assert.match(result.error ?? '', /Multiple sources/);
  });

  it('errors when --source names a source not in sources.yaml', () => {
    seedCandidate('python-testing');
    const config = makeConfig({ sources: ['loom-skills'] });
    const proposer = new SkillProposer({
      sourcesConfig: config,
      generatedDir,
      env: () => 'fake',
      onProgress: () => {},
      prCreator: () => 'http://unused',
    });
    const result = proposer.propose({
      candidateName: 'python-testing',
      sourceName: 'nope',
    });
    assert.equal(result.status, 'error');
    assert.match(result.error ?? '', /No source named "nope"/);
  });

  it('errors with a useful message when the PAT env var is unset', () => {
    seedCandidate('python-testing');
    const config = makeConfig({ sources: ['loom-skills'] });
    const proposer = new SkillProposer({
      sourcesConfig: config,
      generatedDir,
      env: () => undefined,
      onProgress: () => {},
      prCreator: () => 'http://unused',
    });
    const result = proposer.propose({ candidateName: 'python-testing' });
    assert.equal(result.status, 'error');
    assert.match(result.error ?? '', /PAT env var/);
    assert.match(result.error ?? '', /unset/);
  });

  it('marks the PR body when auto-proposed', () => {
    seedCandidate('python-testing');
    const config = makeConfig({ sources: ['loom-skills'] });
    const proposer = new SkillProposer({
      sourcesConfig: config,
      generatedDir,
      env: () => 'fake',
      onProgress: () => {},
      prCreator: () => 'http://unused',
    });
    const result = proposer.propose({
      candidateName: 'python-testing',
      autoProposed: true,
      dryRun: true,
    });
    assert.match(result.body ?? '', /Auto-proposed by loom/);
  });
});
