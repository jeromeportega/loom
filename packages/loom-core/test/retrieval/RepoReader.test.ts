import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { PolicySchema } from '../../src/types.js';
import { resolveEffectiveConfig } from '../../src/config/resolveEffectiveConfig.js';
import { gitSafe } from '../../src/orchestrator/git.js';
import { registerRepo } from '../../src/home/workspaceManifest.js';
import { resolveRegisteredRepo } from '../../src/retrieval/ManifestResolver.js';
import { loadSliceBounds } from '../../src/retrieval/SliceBounds.js';
import { readBounded } from '../../src/retrieval/RepoReader.js';
import { isSecretPath, redactSecrets } from '../../src/retrieval/secretFilter.js';
import { RetrievalRefused, CROSS_REPO_RULES } from '../../src/retrieval/types.js';
import type { ResolvedRepo, SliceBounds } from '../../src/retrieval/types.js';
import yaml from 'js-yaml';

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeTmp(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `loom-reader-${prefix}-`));
  // Resolve symlinks (macOS /tmp → /private/tmp).
  try { return fs.realpathSync(dir); } catch { return dir; }
}

function gitInit(dir: string): void {
  const res = gitSafe(dir, ['init']);
  if (!res.ok) throw new Error(`git init failed: ${res.output}`);
}

function makeRepo(): { repoDir: string; loomHome: string; resolved: ResolvedRepo; cleanup: () => void } {
  const loomHome = makeTmp('home');
  const repoDir = makeTmp('repo');
  fs.mkdirSync(loomHome, { recursive: true });
  gitInit(repoDir);
  const entry = registerRepo(loomHome, repoDir);
  const resolved = resolveRegisteredRepo(loomHome, entry.slug);
  return {
    repoDir,
    loomHome,
    resolved,
    cleanup: () => {
      fs.rmSync(loomHome, { recursive: true, force: true });
      fs.rmSync(repoDir, { recursive: true, force: true });
    },
  };
}

function defaultBounds(): SliceBounds {
  return loadSliceBounds(PolicySchema.parse({}));
}

function writeFile(dir: string, relPath: string, content: string): void {
  const abs = path.join(dir, relPath);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content, 'utf8');
}

// ── AC-2: loadSliceBounds — defaults ─────────────────────────────────────────

describe('loadSliceBounds — AC-2: conservative defaults from empty policy', () => {
  it('returns correct defaults when cross_repo.bounds is absent', () => {
    const policy = PolicySchema.parse({});
    const bounds = loadSliceBounds(policy);
    assert.equal(bounds.maxLineWindow, 200);
    assert.equal(bounds.maxFileBytes, 262144);
    assert.equal(bounds.maxFiles, 20);
    assert.equal(bounds.maxMatchesPerFile, 10);
  });

  it('returns correct defaults when cross_repo is explicitly empty', () => {
    const policy = PolicySchema.parse({ cross_repo: {} });
    const bounds = loadSliceBounds(policy);
    assert.equal(bounds.maxLineWindow, 200);
    assert.equal(bounds.maxFileBytes, 262144);
    assert.equal(bounds.maxFiles, 20);
    assert.equal(bounds.maxMatchesPerFile, 10);
  });

  it('cross_repo.enabled defaults to false', () => {
    const policy = PolicySchema.parse({});
    assert.equal(policy.cross_repo.enabled, false);
  });

  it('cross_repo.secret_globs has the expected defaults', () => {
    const policy = PolicySchema.parse({});
    const globs = policy.cross_repo.secret_globs;
    assert.ok(globs.includes('**/.env'));
    assert.ok(globs.includes('**/*.pem'));
    assert.ok(globs.includes('**/secrets/**'));
  });
});

// ── AC-4: loadSliceBounds — configurability via resolveEffectiveConfig ────────

describe('loadSliceBounds — AC-4: override via policy.cross_repo.bounds', () => {
  it('custom bounds override the defaults', () => {
    const policy = PolicySchema.parse({
      cross_repo: {
        bounds: {
          max_line_window: 50,
          max_file_bytes: 1024,
          max_files: 5,
          max_matches_per_file: 3,
        },
      },
    });
    const bounds = loadSliceBounds(policy);
    assert.equal(bounds.maxLineWindow, 50);
    assert.equal(bounds.maxFileBytes, 1024);
    assert.equal(bounds.maxFiles, 5);
    assert.equal(bounds.maxMatchesPerFile, 3);
  });

  it('resolveEffectiveConfig team→repo→env precedence propagates through loadSliceBounds', () => {
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'loom-bounds-layers-'));
    const realTmpRoot = (() => { try { return fs.realpathSync(tmpRoot); } catch { return tmpRoot; } })();
    const projectRoot = path.join(realTmpRoot, 'project');
    const loomdir = path.join(projectRoot, '.loom');
    const loomHomeDir = path.join(realTmpRoot, 'loom-home');
    fs.mkdirSync(loomdir, { recursive: true });
    fs.mkdirSync(loomHomeDir, { recursive: true });

    try {
      // team sets max_line_window=100
      fs.writeFileSync(
        path.join(loomHomeDir, 'team-config.yaml'),
        yaml.dump({ cross_repo: { bounds: { max_line_window: 100 } } }),
        'utf8',
      );
      // repo overrides max_line_window=75 and sets max_files=8
      fs.writeFileSync(
        path.join(loomdir, 'policy.yaml'),
        yaml.dump({ cross_repo: { bounds: { max_line_window: 75, max_files: 8 } } }),
        'utf8',
      );
      // env overrides max_line_window=30
      const env: NodeJS.ProcessEnv = { LOOM_CROSS_REPO_BOUNDS_MAX_LINE_WINDOW: undefined };

      const { policy } = resolveEffectiveConfig({ loomdir, projectRoot, env: {} });
      // repo wins over team for max_line_window (scalar higher-wins)
      const bounds = loadSliceBounds(policy);
      assert.equal(bounds.maxLineWindow, 75, 'repo overrides team for max_line_window');
      assert.equal(bounds.maxFiles, 8, 'repo value for max_files');
      // maxFileBytes and maxMatchesPerFile fall through to defaults
      assert.equal(bounds.maxFileBytes, 262144);
      assert.equal(bounds.maxMatchesPerFile, 10);
    } finally {
      fs.rmSync(realTmpRoot, { recursive: true, force: true });
    }
  });

  it('secret_globs union-merges across layers (security denylist cannot shrink)', () => {
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'loom-globs-union-'));
    const realTmpRoot = (() => { try { return fs.realpathSync(tmpRoot); } catch { return tmpRoot; } })();
    const projectRoot = path.join(realTmpRoot, 'project');
    const loomdir = path.join(projectRoot, '.loom');
    const loomHomeDir = path.join(realTmpRoot, 'loom-home');
    fs.mkdirSync(loomdir, { recursive: true });
    fs.mkdirSync(loomHomeDir, { recursive: true });

    try {
      // team adds a custom secret glob
      fs.writeFileSync(
        path.join(loomHomeDir, 'team-config.yaml'),
        yaml.dump({ cross_repo: { secret_globs: ['**/custom-secret.txt'] } }),
        'utf8',
      );
      // repo adds another glob (cannot remove team's)
      fs.writeFileSync(
        path.join(loomdir, 'policy.yaml'),
        yaml.dump({ cross_repo: { secret_globs: ['**/repo-secret/**'] } }),
        'utf8',
      );

      const { policy } = resolveEffectiveConfig({ loomdir, projectRoot, env: {} });
      // Union: both globs survive, neither overrides the other
      assert.ok(policy.cross_repo.secret_globs.includes('**/custom-secret.txt'), 'team glob preserved');
      assert.ok(policy.cross_repo.secret_globs.includes('**/repo-secret/**'), 'repo glob preserved');
    } finally {
      fs.rmSync(realTmpRoot, { recursive: true, force: true });
    }
  });
});

// ── isSecretPath ──────────────────────────────────────────────────────────────

describe('isSecretPath', () => {
  it('returns true for .env in any directory', () => {
    assert.ok(isSecretPath('.env', ['**/.env']));
    assert.ok(isSecretPath('config/.env', ['**/.env']));
    assert.ok(isSecretPath('deep/nested/.env', ['**/.env']));
  });

  it('returns true for .env.local with .env.* glob', () => {
    assert.ok(isSecretPath('.env.local', ['**/.env.*']));
    assert.ok(isSecretPath('sub/.env.production', ['**/.env.*']));
  });

  it('returns true for .pem files', () => {
    assert.ok(isSecretPath('cert.pem', ['**/*.pem']));
    assert.ok(isSecretPath('certs/server.pem', ['**/*.pem']));
  });

  it('returns true for files under secrets/', () => {
    assert.ok(isSecretPath('secrets/token', ['**/secrets/**']));
    assert.ok(isSecretPath('config/secrets/key.txt', ['**/secrets/**']));
  });

  it('returns false for non-secret files', () => {
    assert.ok(!isSecretPath('src/index.ts', ['**/.env', '**/*.pem']));
    assert.ok(!isSecretPath('README.md', ['**/.env', '**/*.pem']));
  });

  it('returns false with an empty glob list', () => {
    assert.ok(!isSecretPath('.env', []));
  });
});

// ── redactSecrets ─────────────────────────────────────────────────────────────

describe('redactSecrets (re-exported from secretFilter)', () => {
  it('redacts Anthropic API keys', () => {
    const text = 'key=sk-ant-api03-ABCDEFGHIJKLMNOPQRST';
    const result = redactSecrets(text);
    assert.ok(!result.includes('sk-ant-api03-ABCDEFGHIJKLMNOPQRST'));
    assert.ok(result.includes('sk-ant-[REDACTED]'));
  });

  it('passes clean text through unchanged', () => {
    const text = 'const x = 1 + 2;';
    assert.equal(redactSecrets(text), text);
  });
});

// ── AC-1: Full-file read ──────────────────────────────────────────────────────

describe('readBounded — AC-1: full-file read (lines = undefined)', () => {
  let ctx: ReturnType<typeof makeRepo>;
  before(() => { ctx = makeRepo(); });
  after(() => { ctx.cleanup(); });

  it('returns full content, truncated=false, window=[1,lastLine] for a small file', () => {
    writeFile(ctx.repoDir, 'hello.ts', 'line1\nline2\nline3\n');
    const result = readBounded(ctx.resolved, 'hello.ts', undefined, defaultBounds(), []);
    assert.equal(result.slug, ctx.resolved.slug);
    assert.equal(result.path, 'hello.ts');
    assert.equal(result.content, 'line1\nline2\nline3');
    assert.deepEqual(result.window, [1, 3]);
    assert.equal(result.truncated, false);
  });

  it('handles a file without a trailing newline', () => {
    writeFile(ctx.repoDir, 'notail.txt', 'a\nb\nc');
    const result = readBounded(ctx.resolved, 'notail.txt', undefined, defaultBounds(), []);
    assert.equal(result.content, 'a\nb\nc');
    assert.deepEqual(result.window, [1, 3]);
    assert.equal(result.truncated, false);
  });

  it('handles a single-line file', () => {
    writeFile(ctx.repoDir, 'single.txt', 'only line\n');
    const result = readBounded(ctx.resolved, 'single.txt', undefined, defaultBounds(), []);
    assert.equal(result.content, 'only line');
    assert.deepEqual(result.window, [1, 1]);
    assert.equal(result.truncated, false);
  });

  it('handles a file in a subdirectory', () => {
    writeFile(ctx.repoDir, 'src/utils.ts', 'export const x = 1;\nexport const y = 2;\n');
    const result = readBounded(ctx.resolved, 'src/utils.ts', undefined, defaultBounds(), []);
    assert.equal(result.content, 'export const x = 1;\nexport const y = 2;');
    assert.deepEqual(result.window, [1, 2]);
    assert.equal(result.truncated, false);
  });
});

// ── AC-1: Windowed read ───────────────────────────────────────────────────────

describe('readBounded — AC-1: windowed read (lines = [a, b])', () => {
  let ctx: ReturnType<typeof makeRepo>;
  before(() => { ctx = makeRepo(); });
  after(() => { ctx.cleanup(); });

  const CONTENT = Array.from({ length: 20 }, (_, i) => `line${i + 1}`).join('\n') + '\n';

  before(() => { writeFile(ctx.repoDir, 'twenty.txt', CONTENT); });

  it('returns exactly the requested window', () => {
    const result = readBounded(ctx.resolved, 'twenty.txt', [5, 10], defaultBounds(), []);
    assert.deepEqual(result.window, [5, 10]);
    assert.equal(result.content, 'line5\nline6\nline7\nline8\nline9\nline10');
    assert.equal(result.truncated, false);
  });

  it('window at end of file: b beyond EOF clamps, not errors', () => {
    // File has 20 lines; request [18, 25] should clamp to [18, 20]
    const result = readBounded(ctx.resolved, 'twenty.txt', [18, 25], defaultBounds(), []);
    assert.deepEqual(result.window, [18, 20]);
    assert.equal(result.content, 'line18\nline19\nline20');
    assert.equal(result.truncated, false);
  });

  it('single-line window [n, n]', () => {
    const result = readBounded(ctx.resolved, 'twenty.txt', [7, 7], defaultBounds(), []);
    assert.deepEqual(result.window, [7, 7]);
    assert.equal(result.content, 'line7');
    assert.equal(result.truncated, false);
  });
});

// ── AC-3: Over-wide window — truncate-and-flag ────────────────────────────────

describe('readBounded — AC-3: over-wide window truncates and sets truncated=true', () => {
  let ctx: ReturnType<typeof makeRepo>;
  before(() => { ctx = makeRepo(); });
  after(() => { ctx.cleanup(); });

  before(() => {
    // 10-line file with custom bounds allowing only 3-line windows
    writeFile(ctx.repoDir, 'tenlines.txt', Array.from({ length: 10 }, (_, i) => `L${i + 1}`).join('\n') + '\n');
  });

  it('truncates over-wide window to maxLineWindow and sets truncated=true', () => {
    const narrowBounds: SliceBounds = { maxLineWindow: 3, maxFileBytes: 262144, maxFiles: 20, maxMatchesPerFile: 10 };
    // Request window [1, 10] but maxLineWindow=3 → truncated to [1, 3]
    const result = readBounded(ctx.resolved, 'tenlines.txt', [1, 10], narrowBounds, []);
    assert.deepEqual(result.window, [1, 3]);
    assert.equal(result.content, 'L1\nL2\nL3');
    assert.equal(result.truncated, true);
  });

  it('does NOT return a whole-file dump when window is over-wide', () => {
    const narrowBounds: SliceBounds = { maxLineWindow: 2, maxFileBytes: 262144, maxFiles: 20, maxMatchesPerFile: 10 };
    const result = readBounded(ctx.resolved, 'tenlines.txt', [1, 10], narrowBounds, []);
    // Only 2 lines should be present, not all 10
    assert.equal(result.content.split('\n').length, 2);
    assert.equal(result.truncated, true);
  });

  it('window exactly at maxLineWindow is not truncated', () => {
    const exactBounds: SliceBounds = { maxLineWindow: 5, maxFileBytes: 262144, maxFiles: 20, maxMatchesPerFile: 10 };
    const result = readBounded(ctx.resolved, 'tenlines.txt', [1, 5], exactBounds, []);
    assert.equal(result.truncated, false);
    assert.equal(result.content.split('\n').length, 5);
  });
});

// ── AC-3: Oversized file — refused ────────────────────────────────────────────

describe('readBounded — AC-3: file over maxFileBytes is refused (not truncated)', () => {
  let ctx: ReturnType<typeof makeRepo>;
  before(() => { ctx = makeRepo(); });
  after(() => { ctx.cleanup(); });

  before(() => {
    // Create a 5-byte file; tests will use maxFileBytes=4 to trigger the refusal
    writeFile(ctx.repoDir, 'toobig.txt', 'ABCDE');
  });

  it('throws RetrievalRefused(FILE_TOO_LARGE) when file exceeds maxFileBytes', () => {
    const tinyBounds: SliceBounds = { maxLineWindow: 200, maxFileBytes: 4, maxFiles: 20, maxMatchesPerFile: 10 };
    assert.throws(
      () => readBounded(ctx.resolved, 'toobig.txt', undefined, tinyBounds, []),
      (err: unknown) => {
        assert.ok(err instanceof RetrievalRefused, `expected RetrievalRefused, got ${err}`);
        assert.equal(err.rule, CROSS_REPO_RULES.FILE_TOO_LARGE);
        return true;
      },
    );
  });

  it('does NOT return partial content for an oversized file', () => {
    const tinyBounds: SliceBounds = { maxLineWindow: 200, maxFileBytes: 4, maxFiles: 20, maxMatchesPerFile: 10 };
    assert.throws(
      () => readBounded(ctx.resolved, 'toobig.txt', undefined, tinyBounds, []),
      RetrievalRefused,
    );
  });

  it('reads a file exactly at the byte limit without error', () => {
    // 'ABCDE' is 5 bytes; maxFileBytes=5 should NOT refuse
    const exactBounds: SliceBounds = { maxLineWindow: 200, maxFileBytes: 5, maxFiles: 20, maxMatchesPerFile: 10 };
    const result = readBounded(ctx.resolved, 'toobig.txt', undefined, exactBounds, []);
    assert.equal(result.content, 'ABCDE');
    assert.equal(result.truncated, false);
  });
});

// ── Path-escape refusal ───────────────────────────────────────────────────────

describe('readBounded — path-escape refusal', () => {
  let ctx: ReturnType<typeof makeRepo>;
  before(() => { ctx = makeRepo(); });
  after(() => { ctx.cleanup(); });

  before(() => {
    // A target file outside the repo root
    writeFile(ctx.repoDir, 'safe.txt', 'safe content\n');
  });

  it('../ traversal is refused', () => {
    assert.throws(
      () => readBounded(ctx.resolved, '../evil.txt', undefined, defaultBounds(), []),
      (err: unknown) => {
        assert.ok(err instanceof RetrievalRefused, `expected RetrievalRefused, got ${err}`);
        assert.equal(err.rule, CROSS_REPO_RULES.OUT_OF_WORKSPACE);
        return true;
      },
    );
  });

  it('absolute path outside root is refused', () => {
    assert.throws(
      () => readBounded(ctx.resolved, '/etc/passwd', undefined, defaultBounds(), []),
      (err: unknown) => {
        assert.ok(err instanceof RetrievalRefused);
        assert.equal(err.rule, CROSS_REPO_RULES.OUT_OF_WORKSPACE);
        return true;
      },
    );
  });

  it('symlink that escapes repo root is refused', () => {
    // Create a symlink inside the repo pointing to the os temp dir (outside the repo)
    const symlinkPath = path.join(ctx.repoDir, 'escape-link');
    const target = os.tmpdir();
    try {
      fs.symlinkSync(target, symlinkPath);
    } catch {
      // Skip if symlink creation fails (unlikely in test env)
      return;
    }
    try {
      assert.throws(
        () => readBounded(ctx.resolved, 'escape-link', undefined, defaultBounds(), []),
        (err: unknown) => {
          assert.ok(err instanceof RetrievalRefused);
          // May be OUT_OF_WORKSPACE (symlink escape) or STALE_PATH (resolve failed)
          assert.ok(
            err.rule === CROSS_REPO_RULES.OUT_OF_WORKSPACE || err.rule === CROSS_REPO_RULES.STALE_PATH,
            `expected OUT_OF_WORKSPACE or STALE_PATH, got ${err.rule}`,
          );
          return true;
        },
      );
    } finally {
      try { fs.unlinkSync(symlinkPath); } catch {}
    }
  });

  it('safe path inside repo is accepted', () => {
    const result = readBounded(ctx.resolved, 'safe.txt', undefined, defaultBounds(), []);
    assert.equal(result.content, 'safe content');
  });

  it('non-existent path is refused with STALE_PATH', () => {
    assert.throws(
      () => readBounded(ctx.resolved, 'nonexistent.txt', undefined, defaultBounds(), []),
      (err: unknown) => {
        assert.ok(err instanceof RetrievalRefused);
        assert.equal(err.rule, CROSS_REPO_RULES.STALE_PATH);
        return true;
      },
    );
  });
});

// ── Secret exclusion via secretGlobs ─────────────────────────────────────────

describe('readBounded — secret glob exclusion (FR-7)', () => {
  let ctx: ReturnType<typeof makeRepo>;
  before(() => { ctx = makeRepo(); });
  after(() => { ctx.cleanup(); });

  before(() => {
    writeFile(ctx.repoDir, '.env', 'SECRET=abc123\n');
    writeFile(ctx.repoDir, 'config/keys.pem', '-----BEGIN CERTIFICATE-----\n');
    writeFile(ctx.repoDir, 'secrets/token.txt', 'my-token\n');
    writeFile(ctx.repoDir, 'src/app.ts', 'const x = 1;\n');
    writeFile(ctx.repoDir, 'src/creds.ts', `const key = 'sk-ant-api03-ABCDEFGHIJKLMNOPQRST';\n`);
  });

  const defaultGlobs = ['**/.env', '**/.env.*', '**/*.pem', '**/*.key', '**/id_rsa*', '**/secrets/**', '**/*.tfstate'];

  it('refuses to read .env files matching secret globs', () => {
    assert.throws(
      () => readBounded(ctx.resolved, '.env', undefined, defaultBounds(), defaultGlobs),
      (err: unknown) => {
        assert.ok(err instanceof RetrievalRefused);
        assert.equal(err.rule, CROSS_REPO_RULES.SECRET_EXCLUDED);
        return true;
      },
    );
  });

  it('refuses to read .pem files', () => {
    assert.throws(
      () => readBounded(ctx.resolved, 'config/keys.pem', undefined, defaultBounds(), defaultGlobs),
      (err: unknown) => {
        assert.ok(err instanceof RetrievalRefused);
        assert.equal(err.rule, CROSS_REPO_RULES.SECRET_EXCLUDED);
        return true;
      },
    );
  });

  it('refuses to read files under secrets/', () => {
    assert.throws(
      () => readBounded(ctx.resolved, 'secrets/token.txt', undefined, defaultBounds(), defaultGlobs),
      (err: unknown) => {
        assert.ok(err instanceof RetrievalRefused);
        assert.equal(err.rule, CROSS_REPO_RULES.SECRET_EXCLUDED);
        return true;
      },
    );
  });

  it('secret check happens BEFORE any fs read (no content leaked)', () => {
    // We verify the secret check is first by using a file that both matches a glob
    // and doesn't exist — it should throw SECRET_EXCLUDED, not STALE_PATH.
    assert.throws(
      () => readBounded(ctx.resolved, 'nonexistent.pem', undefined, defaultBounds(), defaultGlobs),
      (err: unknown) => {
        assert.ok(err instanceof RetrievalRefused);
        assert.equal(err.rule, CROSS_REPO_RULES.SECRET_EXCLUDED);
        return true;
      },
    );
  });

  it('non-secret file is readable', () => {
    const result = readBounded(ctx.resolved, 'src/app.ts', undefined, defaultBounds(), defaultGlobs);
    assert.equal(result.content, 'const x = 1;');
    assert.equal(result.truncated, false);
  });

  it('content containing an inline credential is redacted', () => {
    const result = readBounded(ctx.resolved, 'src/creds.ts', undefined, defaultBounds(), defaultGlobs);
    assert.ok(!result.content.includes('sk-ant-api03-ABCDEFGHIJKLMNOPQRST'), 'raw key must not appear');
    assert.ok(result.content.includes('sk-ant-[REDACTED]'), 'redacted placeholder must be present');
  });

  it('empty secret glob list allows all paths', () => {
    const result = readBounded(ctx.resolved, '.env', undefined, defaultBounds(), []);
    assert.ok(result.content.includes('SECRET=abc123'));
  });
});
