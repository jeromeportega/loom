import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { extractJsonObject } from '../llm/extractJson.js';

describe('extractJsonObject — pure JSON', () => {
  it('parses a bare JSON object', () => {
    assert.deepEqual(extractJsonObject('{"a": 1, "b": "two"}'), { a: 1, b: 'two' });
  });

  it('handles nested objects', () => {
    const result = extractJsonObject('{"outer": {"inner": 42}}') as { outer: { inner: number } };
    assert.equal(result.outer.inner, 42);
  });
});

describe('extractJsonObject — markdown fence-wrapped', () => {
  it('strips ```json fences', () => {
    const text = '```json\n{"a": 1}\n```';
    assert.deepEqual(extractJsonObject(text), { a: 1 });
  });

  it('strips bare ``` fences', () => {
    const text = '```\n{"a": 1}\n```';
    assert.deepEqual(extractJsonObject(text), { a: 1 });
  });

  it('handles fenced block with surrounding prose', () => {
    const text = [
      'Here is the JSON:',
      '```json',
      '{"type": "feature", "size": "story"}',
      '```',
      'Let me know if you need anything else.',
    ].join('\n');
    const result = extractJsonObject(text) as { type: string; size: string };
    assert.equal(result.type, 'feature');
    assert.equal(result.size, 'story');
  });
});

describe('extractJsonObject — prose-wrapped', () => {
  it('recovers JSON from leading prose', () => {
    const text = 'Here is the classification:\n{"type": "feature", "size": "story"}';
    const result = extractJsonObject(text) as { type: string; size: string };
    assert.equal(result.type, 'feature');
    assert.equal(result.size, 'story');
  });

  it('recovers JSON from trailing prose', () => {
    const text = '{"type": "feature"} That is my classification.';
    const result = extractJsonObject(text) as { type: string };
    assert.equal(result.type, 'feature');
  });

  it('recovers JSON from both leading and trailing prose', () => {
    const text = 'Sure! Here is the answer: {"type": "bug", "x": 1} Let me know if you need more.';
    const result = extractJsonObject(text) as { type: string; x: number };
    assert.equal(result.type, 'bug');
    assert.equal(result.x, 1);
  });

  it('recovers nested JSON from prose', () => {
    const text = 'Result: {"outer": {"inner": 42}} Done.';
    const result = extractJsonObject(text) as { outer: { inner: number } };
    assert.equal(result.outer.inner, 42);
  });
});

describe('extractJsonObject — assistant prefill scenario', () => {
  it('recovers JSON when text starts with a stray { (prefill re-prepend artifact)', () => {
    // classifyIntake prepends '{' to the API continuation; if the continuation
    // was itself a complete JSON object this produces '{{...}'.
    const text = '{' + '{"type": "feature", "size": "story", "confidence": "high", "rationale": "x"}';
    const result = extractJsonObject(text) as { type: string; size: string };
    assert.equal(result.type, 'feature');
    assert.equal(result.size, 'story');
  });

  it('recovers JSON from prose continuation after prefill re-prepend', () => {
    // classifyIntake prepends '{'; LLM returned fields + trailing prose.
    // After prepend: '{"type":"feature",...}\nSome trailing text'
    const continuation = '"type": "feature", "size": "story", "confidence": "high", "rationale": "New capability."}\n\nI hope this helps!';
    const text = '{' + continuation;
    const result = extractJsonObject(text) as { type: string };
    assert.equal(result.type, 'feature');
  });
});

describe('extractJsonObject — tolerant fallback', () => {
  it('recovers JSON with literal newlines inside string values', () => {
    const text = '{"a": "line1\nline2"}';
    const result = extractJsonObject(text) as { a: string };
    assert.ok(result.a.includes('line1'));
    assert.ok(result.a.includes('line2'));
  });

  it('recovers JSON with literal tabs inside string values', () => {
    const text = '{"a": "col1\tcol2"}';
    const result = extractJsonObject(text) as { a: string };
    assert.ok(result.a.includes('col1'));
    assert.ok(result.a.includes('col2'));
  });
});

describe('extractJsonObject — error cases', () => {
  it('throws a descriptive error when no JSON object is present', () => {
    assert.throws(() => extractJsonObject('no json here at all'), /could not parse/);
  });

  it('throws on structural JSON errors that are not bare control chars', () => {
    assert.throws(() => extractJsonObject('{"k": "missing closing brace"'), /could not parse/);
  });

  it('throws when fenced content is not valid JSON', () => {
    assert.throws(() => extractJsonObject('```json\nnot valid json\n```'), /could not parse/);
  });
});
