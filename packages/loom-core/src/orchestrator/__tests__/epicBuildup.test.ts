import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  EpicBuildup,
  type BuildupEntry,
  type EpicBuildupDoc,
} from '../EpicBuildup.js';
import { MAX_CONVENTION_CHARS, MAX_CONVENTIONS_PER_STORY } from '../conventionsMarker.js';

let tmpRoot: string;

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'loom-buildup-'));
});

afterEach(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

function makeEntry(storyId: string, overrides: Partial<BuildupEntry> = {}): BuildupEntry {
  return {
    storyId,
    title: `Story ${storyId} title`,
    completedAt: '2026-01-01T00:00:00.000Z',
    body: `# Context — ${storyId}\n\nSome content here.`,
    ...overrides,
  };
}

// (h) pathFor → .loom/buildup/<epic-id>.json
describe('EpicBuildup.pathFor', () => {
  it('returns .loom/buildup/<epic-id>.json keyed by epic id', () => {
    const p = EpicBuildup.pathFor('/project', 'epic-001');
    assert.equal(p, '/project/.loom/buildup/epic-001.json');
  });

  it('uses the full epic id as the filename', () => {
    const p = EpicBuildup.pathFor('/project', 'epic-007');
    assert.ok(p.endsWith('/epic-007.json'));
  });
});

// (k) read returns null on missing file AND on corrupt/partial JSON (fail-safe)
describe('EpicBuildup.read', () => {
  it('returns null when file does not exist', () => {
    assert.equal(EpicBuildup.read(tmpRoot, 'epic-999'), null);
  });

  it('returns null for corrupt JSON', () => {
    const file = EpicBuildup.pathFor(tmpRoot, 'epic-001');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, '{corrupt json', 'utf8');
    assert.equal(EpicBuildup.read(tmpRoot, 'epic-001'), null);
  });

  it('returns null for partial/truncated JSON', () => {
    const file = EpicBuildup.pathFor(tmpRoot, 'epic-001');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, '{"epicId":"epic-001","version":1,"entries":[{', 'utf8');
    assert.equal(EpicBuildup.read(tmpRoot, 'epic-001'), null);
  });

  it('returns null for JSON that lacks required fields', () => {
    const file = EpicBuildup.pathFor(tmpRoot, 'epic-001');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, '{"epicId":"epic-001"}', 'utf8');
    assert.equal(EpicBuildup.read(tmpRoot, 'epic-001'), null);
  });

  it('returns the doc when file is valid', () => {
    EpicBuildup.appendStoryEntry(tmpRoot, 'epic-001', makeEntry('story-001-001'));
    const doc = EpicBuildup.read(tmpRoot, 'epic-001');
    assert.ok(doc !== null);
    assert.equal(doc!.epicId, 'epic-001');
    assert.equal(doc!.version, 1);
  });
});

// (i) appendStoryEntry writes a valid doc and is idempotent
describe('EpicBuildup.appendStoryEntry', () => {
  it('creates the buildup dir and writes the doc', () => {
    const file = EpicBuildup.pathFor(tmpRoot, 'epic-001');
    assert.ok(!fs.existsSync(file), 'file should not exist before first write');

    EpicBuildup.appendStoryEntry(tmpRoot, 'epic-001', makeEntry('story-001-001'));

    assert.ok(fs.existsSync(file), 'file should exist after append');
    const doc = JSON.parse(fs.readFileSync(file, 'utf8')) as EpicBuildupDoc;
    assert.equal(doc.epicId, 'epic-001');
    assert.equal(doc.version, 1);
    assert.equal(doc.entries.length, 1);
    assert.equal(doc.entries[0].storyId, 'story-001-001');
  });

  it('appends a second entry chronologically', () => {
    EpicBuildup.appendStoryEntry(tmpRoot, 'epic-001', makeEntry('story-001-001'));
    EpicBuildup.appendStoryEntry(tmpRoot, 'epic-001', makeEntry('story-001-002'));

    const doc = EpicBuildup.read(tmpRoot, 'epic-001');
    assert.equal(doc!.entries.length, 2);
    assert.equal(doc!.entries[0].storyId, 'story-001-001');
    assert.equal(doc!.entries[1].storyId, 'story-001-002');
  });

  it('is idempotent — a second append of the same storyId is a no-op', () => {
    EpicBuildup.appendStoryEntry(tmpRoot, 'epic-001', makeEntry('story-001-001'));
    EpicBuildup.appendStoryEntry(tmpRoot, 'epic-001', makeEntry('story-001-001'));

    const doc = EpicBuildup.read(tmpRoot, 'epic-001');
    assert.equal(doc!.entries.length, 1, 'duplicate storyId must not create a second entry');
  });

  it('initialises an empty conventions array on first write', () => {
    EpicBuildup.appendStoryEntry(tmpRoot, 'epic-001', makeEntry('story-001-001'));
    const doc = EpicBuildup.read(tmpRoot, 'epic-001');
    assert.deepEqual(doc!.conventions, []);
  });
});

// (l) write is atomic — assert no partially-written canonical file is observable
describe('EpicBuildup atomicity', () => {
  it('does not leave a .tmp file after a successful write', () => {
    EpicBuildup.appendStoryEntry(tmpRoot, 'epic-001', makeEntry('story-001-001'));
    const dir = path.join(tmpRoot, '.loom', 'buildup');
    const files = fs.readdirSync(dir);
    assert.ok(!files.some((f) => f.includes('.tmp')), 'no .tmp files should remain');
    assert.ok(files.includes('epic-001.json'), 'canonical file must exist');
  });

  it('canonical file is valid JSON immediately after write', () => {
    EpicBuildup.appendStoryEntry(tmpRoot, 'epic-001', makeEntry('story-001-001'));
    const raw = fs.readFileSync(EpicBuildup.pathFor(tmpRoot, 'epic-001'), 'utf8');
    assert.doesNotThrow(() => JSON.parse(raw), 'canonical file must be valid JSON');
  });
});

// (j) appendConventions dedupes by hash
describe('EpicBuildup.appendConventions', () => {
  const AT = '2026-01-01T00:00:00.000Z';

  it('appends conventions with hash dedup', () => {
    EpicBuildup.appendConventions(tmpRoot, 'epic-001', 'story-001-001', AT, [
      'use ULID not UUID',
      'gate X behind flag Y',
    ]);
    const doc = EpicBuildup.read(tmpRoot, 'epic-001');
    assert.equal(doc!.conventions.length, 2);
    assert.equal(doc!.conventions[0].text, 'use ULID not UUID');
    assert.equal(doc!.conventions[0].storyId, 'story-001-001');
    assert.ok(doc!.conventions[0].hash.length > 0);
  });

  it('ignores a duplicate convention by hash', () => {
    EpicBuildup.appendConventions(tmpRoot, 'epic-001', 'story-001-001', AT, ['use ULID']);
    EpicBuildup.appendConventions(tmpRoot, 'epic-001', 'story-001-002', AT, ['use ULID']);
    const doc = EpicBuildup.read(tmpRoot, 'epic-001');
    assert.equal(doc!.conventions.length, 1, 'duplicate convention must be dropped');
  });

  it('respects MAX_CONVENTIONS_PER_STORY cap on ingest', () => {
    const texts = Array.from({ length: MAX_CONVENTIONS_PER_STORY + 3 }, (_, i) => `convention ${i}`);
    EpicBuildup.appendConventions(tmpRoot, 'epic-001', 'story-001-001', AT, texts);
    const doc = EpicBuildup.read(tmpRoot, 'epic-001');
    assert.equal(doc!.conventions.length, MAX_CONVENTIONS_PER_STORY);
  });

  it('truncates convention text to MAX_CONVENTION_CHARS', () => {
    const long = 'a'.repeat(MAX_CONVENTION_CHARS + 100);
    EpicBuildup.appendConventions(tmpRoot, 'epic-001', 'story-001-001', AT, [long]);
    const doc = EpicBuildup.read(tmpRoot, 'epic-001');
    assert.equal(doc!.conventions[0].text.length, MAX_CONVENTION_CHARS);
  });

  it('is a no-op when texts array is empty', () => {
    EpicBuildup.appendConventions(tmpRoot, 'epic-001', 'story-001-001', AT, []);
    assert.equal(EpicBuildup.read(tmpRoot, 'epic-001'), null, 'no file should be created for empty texts');
  });

  it('accumulates conventions from multiple stories', () => {
    EpicBuildup.appendConventions(tmpRoot, 'epic-001', 'story-001-001', AT, ['convention A']);
    EpicBuildup.appendConventions(tmpRoot, 'epic-001', 'story-001-002', AT, ['convention B']);
    const doc = EpicBuildup.read(tmpRoot, 'epic-001');
    assert.equal(doc!.conventions.length, 2);
    assert.equal(doc!.conventions[0].storyId, 'story-001-001');
    assert.equal(doc!.conventions[1].storyId, 'story-001-002');
  });

  it('coexists with story entries in the same doc', () => {
    EpicBuildup.appendStoryEntry(tmpRoot, 'epic-001', makeEntry('story-001-001'));
    EpicBuildup.appendConventions(tmpRoot, 'epic-001', 'story-001-001', AT, ['use ULID']);
    const doc = EpicBuildup.read(tmpRoot, 'epic-001');
    assert.equal(doc!.entries.length, 1);
    assert.equal(doc!.conventions.length, 1);
  });
});

// renderForInjection
describe('EpicBuildup.renderForInjection', () => {
  it('returns empty string for an empty doc', () => {
    const doc: EpicBuildupDoc = { epicId: 'epic-001', version: 1, entries: [], conventions: [] };
    assert.equal(EpicBuildup.renderForInjection(doc).trim(), '');
  });

  it('renders conventions before entries', () => {
    const doc: EpicBuildupDoc = {
      epicId: 'epic-001',
      version: 1,
      entries: [makeEntry('story-001-001')],
      conventions: [
        {
          storyId: 'story-001-001',
          recordedAt: '2026-01-01T00:00:00.000Z',
          text: 'use ULID not UUID',
          hash: 'abc',
        },
      ],
    };
    const rendered = EpicBuildup.renderForInjection(doc);
    const convIdx = rendered.indexOf('Discovered conventions');
    const entryIdx = rendered.indexOf('story-001-001');
    assert.ok(convIdx < entryIdx, 'conventions section should precede story entries');
  });

  it('respects budget cap by truncating', () => {
    const doc: EpicBuildupDoc = {
      epicId: 'epic-001',
      version: 1,
      entries: [makeEntry('story-001-001', { body: 'x'.repeat(10_000) })],
      conventions: [],
    };
    const rendered = EpicBuildup.renderForInjection(doc, 500);
    assert.ok(rendered.length <= 550, 'rendered output should be near the budget cap');
  });
});
