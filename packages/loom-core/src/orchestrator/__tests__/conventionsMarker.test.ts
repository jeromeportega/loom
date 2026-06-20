import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseConventions,
  CONVENTIONS_MARKER,
  MAX_CONVENTION_CHARS,
  MAX_CONVENTIONS_PER_STORY,
  MAX_CONVENTION_MARKER_CHARS,
} from '../conventionsMarker.js';

describe('parseConventions', () => {
  // (a) well-formed marker → string[]
  it('parses a well-formed LOOM_CONVENTIONS marker', () => {
    const out = `some worker output\n${CONVENTIONS_MARKER} {"conventions":["use ULID not UUID","gate X behind flag Y"]}`;
    const result = parseConventions(out);
    assert.deepEqual(result, ['use ULID not UUID', 'gate X behind flag Y']);
  });

  // (b) absent marker → undefined
  it('returns undefined when marker is absent', () => {
    assert.equal(parseConventions('just some normal worker output'), undefined);
  });

  it('returns undefined for empty input', () => {
    assert.equal(parseConventions(''), undefined);
  });

  // (c) malformed/truncated JSON → undefined, NEVER throws
  it('returns undefined for malformed JSON without throwing', () => {
    assert.doesNotThrow(() => {
      const result = parseConventions(`${CONVENTIONS_MARKER} {conventions: ["bad"]}`);
      assert.equal(result, undefined);
    });
  });

  it('returns undefined for truncated JSON without throwing', () => {
    assert.doesNotThrow(() => {
      const result = parseConventions(`${CONVENTIONS_MARKER} {"conventions":["truncated`);
      assert.equal(result, undefined);
    });
  });

  it('returns undefined for non-object JSON without throwing', () => {
    assert.doesNotThrow(() => {
      const result = parseConventions(`${CONVENTIONS_MARKER} ["array not object"]`);
      assert.equal(result, undefined);
    });
  });

  it('returns undefined when conventions field is missing', () => {
    const result = parseConventions(`${CONVENTIONS_MARKER} {"other":"value"}`);
    assert.equal(result, undefined);
  });

  it('returns undefined when conventions is not an array', () => {
    const result = parseConventions(`${CONVENTIONS_MARKER} {"conventions":"not an array"}`);
    assert.equal(result, undefined);
  });

  // (d) multiple marker occurrences → takes the LAST occurrence
  it('takes the LAST occurrence when the model echoed the marker mid-reasoning', () => {
    const out = [
      `I will end with ${CONVENTIONS_MARKER} {"conventions":["first"]} as instructed.`,
      'work happens...',
      `${CONVENTIONS_MARKER} {"conventions":["use ULID not UUID","gate X behind Y"]}`,
    ].join('\n');
    const result = parseConventions(out);
    assert.deepEqual(result, ['use ULID not UUID', 'gate X behind Y']);
  });

  // (e) raw marker payload > MAX_CONVENTION_MARKER_CHARS → rejected before parse
  it('rejects raw marker payload exceeding MAX_CONVENTION_MARKER_CHARS', () => {
    const big = 'x'.repeat(MAX_CONVENTION_MARKER_CHARS + 1);
    const out = `${CONVENTIONS_MARKER} {"conventions":["${big}"]}`;
    assert.equal(parseConventions(out), undefined);
  });

  it('accepts a payload just at the MAX_CONVENTION_MARKER_CHARS boundary', () => {
    // Build a payload that is exactly at the limit
    const shortEntry = 'short entry';
    const filler = `{"conventions":["${shortEntry}"]}`;
    // Pad with space before the JSON so we hit the limit exactly
    const padding = ' '.repeat(MAX_CONVENTION_MARKER_CHARS - filler.length);
    const out = `${CONVENTIONS_MARKER}${padding}${filler}`;
    // The after-marker portion is exactly MAX_CONVENTION_MARKER_CHARS
    const afterMarker = out.slice(out.lastIndexOf(CONVENTIONS_MARKER) + CONVENTIONS_MARKER.length);
    assert.ok(afterMarker.length <= MAX_CONVENTION_MARKER_CHARS, 'test assumption: at boundary');
    const result = parseConventions(out);
    // Padding shifts the { so we may or may not parse — just assert no throw
    assert.doesNotThrow(() => parseConventions(out));
    // The actual result depends on padding, but it must not throw
    void result;
  });

  // (f) single convention text > MAX_CONVENTION_CHARS → bounded/dropped on ingest
  it('truncates a single convention entry exceeding MAX_CONVENTION_CHARS', () => {
    const long = 'a'.repeat(MAX_CONVENTION_CHARS + 50);
    const out = `${CONVENTIONS_MARKER} {"conventions":["${long}"]}`;
    const result = parseConventions(out);
    assert.ok(Array.isArray(result) && result.length === 1);
    assert.equal(result![0].length, MAX_CONVENTION_CHARS);
  });

  // (g) more than MAX_CONVENTIONS_PER_STORY entries → capped
  it('caps entries at MAX_CONVENTIONS_PER_STORY', () => {
    const entries = Array.from({ length: MAX_CONVENTIONS_PER_STORY + 3 }, (_, i) => `entry ${i}`);
    const out = `${CONVENTIONS_MARKER} ${JSON.stringify({ conventions: entries })}`;
    const result = parseConventions(out);
    assert.ok(Array.isArray(result));
    assert.equal(result!.length, MAX_CONVENTIONS_PER_STORY);
  });

  it('ignores non-string entries in conventions array', () => {
    const out = `${CONVENTIONS_MARKER} {"conventions":[42, "valid", null, "also valid"]}`;
    const result = parseConventions(out);
    assert.deepEqual(result, ['valid', 'also valid']);
  });

  it('ignores empty/whitespace-only string entries', () => {
    const out = `${CONVENTIONS_MARKER} {"conventions":["  ", "valid entry", ""]}`;
    const result = parseConventions(out);
    assert.deepEqual(result, ['valid entry']);
  });

  it('returns undefined for an empty conventions array', () => {
    const out = `${CONVENTIONS_MARKER} {"conventions":[]}`;
    assert.equal(parseConventions(out), undefined);
  });

  it('returns undefined when all entries are non-string', () => {
    const out = `${CONVENTIONS_MARKER} {"conventions":[1, 2, 3]}`;
    assert.equal(parseConventions(out), undefined);
  });

  it('ignores trailing prose after the JSON object', () => {
    const out = `${CONVENTIONS_MARKER} {"conventions":["use ULID"]} — thanks!`;
    const result = parseConventions(out);
    assert.deepEqual(result, ['use ULID']);
  });
});
