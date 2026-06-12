/**
 * When claude-cli truncates the refiner response mid-string (output-token
 * cap), JSON parsing fails irrecoverably. The refiner salvages the partial
 * `refined_brief` so the user keeps the draft, but the result is
 * fail-closed: ready: false and quality_score = SALVAGE_QUALITY_SCORE,
 * because the model's actual judgment never arrived and salvage must not
 * vouch for unparsed content.
 *
 * iter-2 of the SWE-bench Lite loop hit this on astropy-14182 with
 * `Unterminated string in JSON at position 2338`; the model had emitted
 * 2KB of valid markdown before the response cut off. This test pins
 * the salvage contract for that shape of breakage.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { MockLLMClient } from '../llm/MockLLMClient.js';
import {
  BriefRefiner,
  salvagePartialRefinedBrief,
  FALLBACK_QUALITY_SCORE,
  SALVAGE_QUALITY_SCORE,
} from '../brief/BriefRefiner.js';

describe('salvagePartialRefinedBrief', () => {
  it('extracts the partial body when the response is truncated mid-string', () => {
    const truncated =
      '```json\n{\n  "ready": true,\n  "refined_brief": "# Support `header_rows`\\n\\n## Goal\\nAllow users to pass header_rows';
    const out = salvagePartialRefinedBrief(truncated);
    assert.ok(out);
    assert.ok(out!.startsWith('# Support `header_rows`'));
    assert.ok(out!.includes('## Goal'));
    assert.ok(out!.includes('Allow users to pass header_rows'));
  });

  it('decodes JSON escape sequences (\\n, \\t, \\", \\\\) inside the salvaged body', () => {
    const truncated =
      '{"refined_brief": "line1\\nline2\\twith a \\"quote\\" and a \\\\ backslash';
    const out = salvagePartialRefinedBrief(truncated)!;
    assert.equal(out, 'line1\nline2\twith a "quote" and a \\ backslash');
  });

  it('stops at the closing quote when the string IS terminated', () => {
    const proper =
      '{"refined_brief": "complete brief", "critique": {}}';
    const out = salvagePartialRefinedBrief(proper);
    assert.equal(out, 'complete brief');
  });

  it('treats \\" as an in-string escape, not the terminator', () => {
    const truncated =
      '{"refined_brief": "the user said \\"hello\\" and then';
    const out = salvagePartialRefinedBrief(truncated)!;
    assert.equal(out, 'the user said "hello" and then');
  });

  it('returns null when the response has no refined_brief at all', () => {
    assert.equal(salvagePartialRefinedBrief('{"ready": false, "questions": []}'), null);
    assert.equal(salvagePartialRefinedBrief('not json at all'), null);
    assert.equal(salvagePartialRefinedBrief(''), null);
  });

  it('returns null when refined_brief is present but the body is empty', () => {
    assert.equal(salvagePartialRefinedBrief('{"refined_brief": ""'), null);
  });
});

describe('BriefRefiner.refine — salvage path on truncated response', () => {
  it('returns a parseable BriefRefinement with the partial brief when JSON is truncated', async () => {
    // Mimic the iter-2 astropy-14182 failure: the model started a valid
    // JSON object, emitted a long refined_brief, then the response ended
    // mid-string before any closing quote/brace.
    const truncatedResponse =
      '```json\n{\n  "ready": true,\n  "refined_brief": "# Title\\n\\n## Goal\\nDo the thing.\\n\\n## Detail\\nMore words that go on and on until the token budget is exhausted before the model can close the string';
    const llm = new MockLLMClient(() => truncatedResponse);
    const refiner = new BriefRefiner({ projectRoot: '/tmp', llm, model: 'm' });
    const r = await refiner.refine('rough brief from user');
    // Fail closed: the partial draft is preserved, but the model's judgment
    // never arrived, so salvage refuses to vouch — ready: false and
    // SALVAGE_QUALITY_SCORE keep the result below any sane gate threshold.
    assert.equal(r.ready, false);
    assert.equal(r.quality_score, SALVAGE_QUALITY_SCORE);
    assert.ok(r.refined_brief);
    assert.ok(r.refined_brief!.startsWith('# Title'));
    assert.ok(r.refined_brief!.includes('## Goal'));
    assert.ok(
      r.critique.ambiguities.some((a) => /truncated/i.test(a)),
      'salvage should surface the truncation in the critique',
    );
  });

  it('survives a truncated trailing escape sequence in the partial body', async () => {
    // Truncation cuts off `\u` before its 4 hex digits — JSON.parse would
    // reject the body as-is; the trim-loop has to shave the last few
    // chars to recover.
    const truncatedResponse =
      '{"refined_brief": "# A heading\\nfollowed by a unicode escape that got cut: \\u00';
    const llm = new MockLLMClient(() => truncatedResponse);
    const refiner = new BriefRefiner({ projectRoot: '/tmp', llm, model: 'm' });
    const r = await refiner.refine('rough');
    assert.equal(r.ready, false);
    assert.equal(r.quality_score, SALVAGE_QUALITY_SCORE);
    assert.ok(r.refined_brief);
    assert.ok(r.refined_brief!.startsWith('# A heading'));
  });

  it('still falls back to ready=false when the response has no recognisable refined_brief', async () => {
    const llm = new MockLLMClient(() => 'totally garbled non-JSON nonsense with no brief in it');
    const refiner = new BriefRefiner({ projectRoot: '/tmp', llm, model: 'm' });
    const r = await refiner.refine('any rough brief');
    assert.equal(r.ready, false);
    assert.equal(r.quality_score, FALLBACK_QUALITY_SCORE);
    assert.ok(r.critique.ambiguities[0]?.includes('not parseable as JSON'));
  });
});
