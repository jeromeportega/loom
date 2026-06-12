/**
 * The brief refiner and several planner personas ask the model for a
 * JSON object containing multi-paragraph markdown as a string value.
 * Models routinely emit those strings with literal newlines instead of
 * `\n` escapes, which strict JSON.parse rejects as "Unterminated string."
 * The bench saw this fail 3 of 4 SWE-bench Lite tasks at brief refinement
 * before the planner ever got a turn. extractJsonBlock now retries with a
 * tolerant pre-pass; these tests pin that contract.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { extractJsonBlock, escapeBareControlsInStrings } from '../planner/util.js';

describe('extractJsonBlock', () => {
  it('parses well-formed JSON unchanged (tolerant fallback is a no-op)', () => {
    const text = '```json\n{"ready": true, "n": 7}\n```';
    assert.deepEqual(extractJsonBlock(text), { ready: true, n: 7 });
  });

  it('recovers JSON where a string value contains literal newlines', () => {
    const text = [
      '```json',
      '{',
      '  "ready": true,',
      '  "refined_brief": "# Title',
      '',
      '## Goal',
      'Multi-line markdown body with paragraphs."',
      '}',
      '```',
    ].join('\n');
    const out = extractJsonBlock(text) as { ready: boolean; refined_brief: string };
    assert.equal(out.ready, true);
    assert.ok(out.refined_brief.includes('# Title'));
    assert.ok(out.refined_brief.includes('Multi-line markdown body'));
  });

  it('recovers JSON where a string value contains literal tabs and carriage returns', () => {
    const text = '{"k": "line1\tcol\r\nline2"}';
    const out = extractJsonBlock(text) as { k: string };
    assert.equal(out.k, 'line1\tcol\r\nline2');
  });

  it('still throws when the structural problem is not a bare control char', () => {
    const text = '{"k": "missing closing brace"';
    assert.throws(() => extractJsonBlock(text), /could not parse/);
  });

  it('handles raw (unfenced) JSON', () => {
    assert.deepEqual(extractJsonBlock('{"a": 1}'), { a: 1 });
  });
});

describe('escapeBareControlsInStrings', () => {
  it('passes well-formed JSON through unchanged', () => {
    const json = '{"a": "b", "c": "d\\ne"}';
    assert.equal(escapeBareControlsInStrings(json), json);
  });

  it('escapes a bare newline inside a string value', () => {
    const before = '{"a": "line1\nline2"}';
    const after = escapeBareControlsInStrings(before);
    assert.equal(after, '{"a": "line1\\nline2"}');
    assert.deepEqual(JSON.parse(after), { a: 'line1\nline2' });
  });

  it('does NOT escape newlines outside string literals (e.g., between tokens)', () => {
    const before = '{\n  "a": 1\n}';
    assert.equal(escapeBareControlsInStrings(before), before);
  });

  it('treats \\" and \\\\ as escape sequences so closing quotes are tracked', () => {
    const before = '{"a": "she said \\"hi\\"", "b": "after"}';
    // No bare controls; should pass through unchanged. If the escape-state
    // machine were wrong, it would consider the \" as a closing quote and
    // mangle "b" by treating its space/whitespace as outside-string.
    assert.equal(escapeBareControlsInStrings(before), before);
  });
});
