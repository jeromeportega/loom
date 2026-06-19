/**
 * Unit tests for WorkerLogStore (story-019-001).
 *
 * Tests append-on-stream semantics, no-overwrite at completion, redaction,
 * offset accounting (byte, not char), and storage location invariant.
 */
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { WorkerLogStore } from '../state/WorkerLogStore.js';
import { redactSecrets } from '../util/redact.js';

let tmpDir: string;
let loomdir: string;
let store: WorkerLogStore;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'loom-wls-'));
  loomdir = path.join(tmpDir, '.loom');
  store = new WorkerLogStore(loomdir);
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ─── pathFor ────────────────────────────────────────────────────────────────

describe('WorkerLogStore.pathFor', () => {
  it('resolves to <loomdir>/logs/<story-id>.log', () => {
    const p = store.pathFor('story-019-001');
    assert.equal(p, path.join(loomdir, 'logs', 'story-019-001.log'));
  });

  it('does not create the directory on access', () => {
    store.pathFor('story-019-001');
    assert.ok(!fs.existsSync(path.join(loomdir, 'logs')), 'pathFor must not create dirs');
  });
});

// ─── append ─────────────────────────────────────────────────────────────────

describe('WorkerLogStore.append — basic behaviour', () => {
  it('creates the file on first call and returns the byte length', () => {
    const n = store.append('story-001', 'hello world');
    const filePath = store.pathFor('story-001');
    assert.ok(fs.existsSync(filePath), 'file must be created');
    assert.equal(n, Buffer.byteLength('hello world', 'utf8'));
    assert.equal(n, fs.statSync(filePath).size);
  });

  it('successive appends accumulate; return value equals file size each time', () => {
    const chunks = ['first ', 'second ', 'third'];
    let runningTotal = 0;
    for (const chunk of chunks) {
      const n = store.append('story-acc', chunk);
      runningTotal += Buffer.byteLength(chunk, 'utf8');
      assert.equal(n, runningTotal, `after chunk "${chunk}" return value mismatch`);
      assert.equal(n, fs.statSync(store.pathFor('story-acc')).size);
    }
    const content = fs.readFileSync(store.pathFor('story-acc'), 'utf8');
    assert.equal(content, chunks.join(''));
  });

  it('creates parent logs/ directory automatically', () => {
    assert.ok(!fs.existsSync(path.join(loomdir, 'logs')));
    store.append('story-mkd', 'data');
    assert.ok(fs.existsSync(path.join(loomdir, 'logs')));
  });
});

// ─── append-on-stream: each chunk is on disk immediately ────────────────────

describe('WorkerLogStore — append-on-stream', () => {
  it('each chunk appears on disk immediately after its append call', () => {
    const chunks = ['chunk-A\n', 'chunk-B\n', 'chunk-C\n'];
    let accumulated = '';
    for (const chunk of chunks) {
      store.append('story-stream', chunk);
      accumulated += chunk;
      const onDisk = fs.readFileSync(store.pathFor('story-stream'), 'utf8');
      assert.equal(onDisk, accumulated, `after "${chunk.trim()}" content mismatch`);
    }
  });
});

// ─── no-overwrite at completion (FR-1 critical) ──────────────────────────────

describe('WorkerLogStore — no-overwrite at completion', () => {
  it('file holds 100% of the concatenated stream after multiple appends', () => {
    // Simulate more than 4 KB (the DB tail limit) of streamed output.
    const TAIL_CHARS = 4096;
    const CHUNK_SIZE = 512;
    const NUM_CHUNKS = Math.ceil((TAIL_CHARS * 2) / CHUNK_SIZE) + 1;
    const chunks: string[] = [];
    for (let i = 0; i < NUM_CHUNKS; i++) {
      chunks.push(`chunk-${String(i).padStart(4, '0')} ${'x'.repeat(CHUNK_SIZE - 12)}\n`);
    }
    const totalContent = chunks.join('');
    for (const chunk of chunks) {
      store.append('story-nooverwrite', chunk);
    }
    const onDisk = fs.readFileSync(store.pathFor('story-nooverwrite'), 'utf8');
    assert.equal(onDisk.length, totalContent.length, 'file must contain ALL streamed bytes');
    assert.equal(onDisk, totalContent, 'file content must be byte-identical to full stream');
    // The file is strictly larger than a 4 KB tail would be
    assert.ok(
      fs.statSync(store.pathFor('story-nooverwrite')).size > TAIL_CHARS,
      'file size must exceed the tail limit — proves no tail-only write happened'
    );
  });
});

// ─── redaction-before-write (FR-4 critical) ──────────────────────────────────

describe('WorkerLogStore — redaction-before-write', () => {
  it('appending pre-redacted content means file contains no secrets', () => {
    const rawChunk = 'token: sk-ant-api03-abcdefghij1234567890 and ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ';
    const redacted = redactSecrets(rawChunk);

    store.append('story-redact', redacted);

    const onDisk = fs.readFileSync(store.pathFor('story-redact'), 'utf8');
    assert.ok(!onDisk.includes('sk-ant-api03'), 'file must not contain raw Anthropic key');
    assert.ok(!onDisk.includes('ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ'), 'file must not contain raw GH PAT');
    assert.ok(onDisk.includes('[REDACTED]'), 'file must contain redaction marker');
    assert.equal(onDisk, redacted);
  });

  it('redactSecrets covers all three secret families tested by the test plan', () => {
    const chunk = [
      'sk-ant-api03-AAAAAAAAAAAAA',
      'ghp_AAAAAAAAAAAAAAAAAAAAAA',
      'github_pat_AAAAAAAAAAAAAAAAAAAAA',
    ].join(' ');
    const redacted = redactSecrets(chunk);
    assert.ok(!redacted.includes('sk-ant-api03-'), 'sk-ant must be redacted');
    assert.ok(!redacted.includes('ghp_AAAAAA'), 'ghp_ must be redacted');
    assert.ok(!redacted.includes('github_pat_AAAAAA'), 'github_pat_ must be redacted');
  });
});

// ─── offset accounting (FR-3) ────────────────────────────────────────────────

describe('WorkerLogStore — offset accounting', () => {
  it('return value equals Buffer.byteLength(content, utf8)', () => {
    const text = 'hello world';
    const n = store.append('story-off1', text);
    assert.equal(n, Buffer.byteLength(text, 'utf8'));
  });

  it('multibyte UTF-8: byte count != char count', () => {
    // "é" is 2 bytes in UTF-8 but 1 char — proves byte (not char) counting
    const multibyte = 'café résumé naïve';
    const n = store.append('story-utf8', multibyte);
    assert.ok(n > multibyte.length, 'byte count must exceed char count for multibyte text');
    assert.equal(n, Buffer.byteLength(multibyte, 'utf8'));
    assert.equal(n, fs.statSync(store.pathFor('story-utf8')).size);
  });

  it('accumulated offset across appends equals file size', () => {
    const parts = ['one-é', 'two-ñ', 'three-中'];
    let last = 0;
    for (const p of parts) {
      last = store.append('story-acc-utf8', p);
    }
    const fileSize = fs.statSync(store.pathFor('story-acc-utf8')).size;
    assert.equal(last, fileSize, 'last append return value must equal file size');
  });
});

// ─── byteLength ──────────────────────────────────────────────────────────────

describe('WorkerLogStore.byteLength', () => {
  it('returns 0 when the file is absent', () => {
    assert.equal(store.byteLength('story-absent'), 0);
  });

  it('equals the last append return value', () => {
    const n = store.append('story-bl', 'some content');
    assert.equal(store.byteLength('story-bl'), n);
  });
});

// ─── read ────────────────────────────────────────────────────────────────────

describe('WorkerLogStore.read', () => {
  it('round-trips full content with no args', () => {
    const content = 'full content round-trip';
    store.append('story-rt', content);
    const buf = store.read('story-rt');
    assert.equal(buf.toString('utf8'), content);
  });

  it('returns empty Buffer for absent file', () => {
    assert.equal(store.read('story-nope').length, 0);
  });

  it('returns empty Buffer when from === upTo (boundary)', () => {
    store.append('story-bnd', 'abc');
    const byteLen = store.byteLength('story-bnd');
    assert.equal(store.read('story-bnd', byteLen, byteLen).length, 0);
  });

  it('slices correctly with fromOffset and upTo', () => {
    store.append('story-slice', 'ABCDEF');
    const buf = store.read('story-slice', 2, 5);
    assert.equal(buf.toString('utf8'), 'CDE');
  });
});

// ─── remove ──────────────────────────────────────────────────────────────────

describe('WorkerLogStore.remove', () => {
  it('deletes the file', () => {
    store.append('story-rm', 'x');
    assert.ok(fs.existsSync(store.pathFor('story-rm')));
    store.remove('story-rm');
    assert.ok(!fs.existsSync(store.pathFor('story-rm')));
  });

  it('is idempotent — no throw when file is absent', () => {
    assert.doesNotThrow(() => store.remove('story-nope'));
  });
});

// ─── storage-location invariant (NFR-1) ─────────────────────────────────────

describe('WorkerLogStore — storage location', () => {
  it('file lives under <loomdir>/logs (not a bare temp file or DB blob)', () => {
    store.append('story-loc', 'data');
    const filePath = store.pathFor('story-loc');
    // Must be rooted at <loomdir>/logs — not a database blob, and not at the
    // root of any temp dir (the logs dir is a subdirectory of loomdir).
    assert.ok(
      filePath.startsWith(path.join(loomdir, 'logs')),
      `file must be under <loomdir>/logs, got: ${filePath}`
    );
    // Verify it is NOT stored directly under os.tmpdir() root (i.e. not a
    // bare mkstemp-style file). The loomdir itself may be in tmpdir during
    // tests, but the file must be inside its logs/ subdirectory.
    const tmpRoot = os.tmpdir() + path.sep;
    const fileRelativeToTmp = path.relative(os.tmpdir(), filePath);
    assert.ok(
      fileRelativeToTmp.includes(path.sep),
      'file must be inside a subdirectory structure, not directly in the temp root'
    );
  });
});
