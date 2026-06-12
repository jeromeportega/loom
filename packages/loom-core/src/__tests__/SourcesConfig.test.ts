import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SourcesConfig } from '../skills/SourcesConfig.js';

let dir: string;

function write(content: string): string {
  const file = path.join(dir, 'sources.yaml');
  fs.writeFileSync(file, content);
  return file;
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'loom-sources-'));
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('SourcesConfig.load', () => {
  it('returns an empty config when the file does not exist', () => {
    const cfg = SourcesConfig.load({ path: path.join(dir, 'missing.yaml') });
    assert.equal(cfg.list().length, 0);
    assert.equal(cfg.isEmpty(), true);
  });

  it('parses a single-source file with all fields', () => {
    const file = write(`
sources:
  - name: loom-skills
    url: https://github.com/acme/loom-skills.git
    branch: main
    pinned_sha: 8c4f9a2deadbeef
    auth:
      type: github_pat
      env_var: LOOM_SKILLS_PAT
    include:
      - "loom-*"
    exclude:
      - "experimental-*"
`);
    const cfg = SourcesConfig.load({ path: file });
    const list = cfg.list();
    assert.equal(list.length, 1);
    const s = list[0];
    assert.equal(s.name, 'loom-skills');
    assert.equal(s.url, 'https://github.com/acme/loom-skills.git');
    assert.equal(s.branch, 'main');
    assert.equal(s.pinned_sha, '8c4f9a2deadbeef');
    assert.equal(s.auth.type, 'github_pat');
    assert.equal(s.auth.env_var, 'LOOM_SKILLS_PAT');
    assert.deepEqual(s.include, ['loom-*']);
    assert.deepEqual(s.exclude, ['experimental-*']);
  });

  it("defaults branch to 'main' and pinned_sha to '' when omitted", () => {
    const file = write(`
sources:
  - name: loom-skills
    url: https://github.com/acme/loom-skills.git
    auth:
      type: github_pat
      env_var: LOOM_SKILLS_PAT
`);
    const cfg = SourcesConfig.load({ path: file });
    const s = cfg.list()[0];
    assert.equal(s.branch, 'main');
    assert.equal(s.pinned_sha, '');
  });

  it('accepts multi-source configs', () => {
    const file = write(`
sources:
  - name: acme-skills
    url: https://github.com/acme/loom-skills.git
    auth: { type: github_pat, env_var: ACME_PAT }
  - name: open-skills
    url: https://github.com/example/loom-skills.git
    auth: { type: github_pat, env_var: OSS_PAT }
`);
    const cfg = SourcesConfig.load({ path: file });
    assert.equal(cfg.list().length, 2);
    assert.equal(cfg.get('acme-skills')?.url, 'https://github.com/acme/loom-skills.git');
    assert.equal(cfg.get('open-skills')?.url, 'https://github.com/example/loom-skills.git');
  });

  it('rejects an invalid source name (uppercase / underscores)', () => {
    const file = write(`
sources:
  - name: LoomSkills
    url: https://github.com/acme/loom-skills.git
    auth: { type: github_pat, env_var: LOOM_SKILLS_PAT }
`);
    assert.throws(() => SourcesConfig.load({ path: file }), /name must be lowercase/);
  });

  it('rejects a missing url', () => {
    const file = write(`
sources:
  - name: loom-skills
    auth: { type: github_pat, env_var: LOOM_SKILLS_PAT }
`);
    assert.throws(() => SourcesConfig.load({ path: file }), /url/);
  });

  it('rejects a non-url string for url', () => {
    const file = write(`
sources:
  - name: loom-skills
    url: not-a-url
    auth: { type: github_pat, env_var: LOOM_SKILLS_PAT }
`);
    assert.throws(() => SourcesConfig.load({ path: file }), /valid HTTPS\/SSH git URL/);
  });

  it('rejects missing auth.env_var', () => {
    const file = write(`
sources:
  - name: loom-skills
    url: https://github.com/acme/loom-skills.git
    auth: { type: github_pat, env_var: "" }
`);
    assert.throws(() => SourcesConfig.load({ path: file }), /env_var must name/);
  });

  it('rejects an unsupported auth type', () => {
    const file = write(`
sources:
  - name: loom-skills
    url: https://github.com/acme/loom-skills.git
    auth: { type: ssh_key, env_var: LOOM_SKILLS_PAT }
`);
    assert.throws(() => SourcesConfig.load({ path: file }));
  });

  it('rejects duplicate source names', () => {
    const file = write(`
sources:
  - name: loom-skills
    url: https://github.com/acme/loom-skills.git
    auth: { type: github_pat, env_var: PAT_A }
  - name: loom-skills
    url: https://github.com/example/loom-skills.git
    auth: { type: github_pat, env_var: PAT_B }
`);
    assert.throws(() => SourcesConfig.load({ path: file }), /duplicate source name 'loom-skills'/);
  });

  it('throws on malformed YAML rather than silently returning empty', () => {
    const file = write(`sources: [\n  - name: loom-skills\n  url: oops`);
    assert.throws(() => SourcesConfig.load({ path: file }), /not valid YAML/);
  });

  it('throws when the root is not a YAML object', () => {
    const file = write(`- just\n- a\n- list\n`);
    assert.throws(
      () => SourcesConfig.load({ path: file }),
      /must be a YAML object/,
    );
  });

  it('accepts an empty sources: [] file as valid (no-op config)', () => {
    const file = write(`sources: []\n`);
    const cfg = SourcesConfig.load({ path: file });
    assert.equal(cfg.list().length, 0);
    assert.equal(cfg.isEmpty(), true);
  });
});

describe('SourcesConfig accessors', () => {
  it('get() returns undefined for unknown names', () => {
    const cfg = new SourcesConfig([], '/nope');
    assert.equal(cfg.get('loom-skills'), undefined);
  });

  it('list() returns a defensive copy', () => {
    const file = write(`
sources:
  - name: loom-skills
    url: https://github.com/acme/loom-skills.git
    auth: { type: github_pat, env_var: LOOM_SKILLS_PAT }
`);
    const cfg = SourcesConfig.load({ path: file });
    const first = cfg.list();
    first.length = 0;
    assert.equal(cfg.list().length, 1, 'mutating the returned array must not affect the config');
  });
});
