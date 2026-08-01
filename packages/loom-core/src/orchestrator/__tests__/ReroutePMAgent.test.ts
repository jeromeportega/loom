/**
 * ReroutePMAgent + the shared too-big signal helpers. These cover the two REAL
 * I/O adapters the mock-based reroute tests skip — the exact seams where the
 * re-gate found format-contract blockers (PM emits placeholder ids the schema
 * rejected; worker emits `LOOM_TOO_BIG:` the parser dropped).
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { MockLLMClient } from '../../llm/MockLLMClient.js';
import { ReroutePMAgent } from '../ReroutePMAgent.js';
import {
  matchTooBigSignal,
  formatTooBigSignal,
  LOOM_TOO_BIG_SIGNAL,
} from '../constants.js';

// ─── Shared signal helper (emit ⇄ parse must never drift) ───────────────────────

describe('matchTooBigSignal ⇄ formatTooBigSignal', () => {
  it('parses the EXACT line formatTooBigSignal emits (the colon form)', () => {
    const line = formatTooBigSignal('split into API + UI layers');
    assert.equal(line, 'LOOM_TOO_BIG: split into API + UI layers');
    // The regression: the worker prompt emitted this colon form but the parser
    // only matched the space form. This must now capture the payload cleanly.
    assert.equal(matchTooBigSignal(line), 'split into API + UI layers');
  });

  it('parses the bare keyword (empty payload)', () => {
    assert.equal(matchTooBigSignal('LOOM_TOO_BIG'), '');
    assert.equal(matchTooBigSignal('  LOOM_TOO_BIG  '), '');
  });

  it('parses the space form', () => {
    assert.equal(matchTooBigSignal('LOOM_TOO_BIG needs a split'), 'needs a split');
  });

  it('strips leading colon+whitespace from the payload (no stray ": ")', () => {
    assert.equal(matchTooBigSignal('LOOM_TOO_BIG:   trimmed'), 'trimmed');
  });

  it('rejects a longer word (LOOM_TOO_BIGGER is not the signal)', () => {
    assert.equal(matchTooBigSignal('LOOM_TOO_BIGGER: nope'), undefined);
    assert.equal(matchTooBigSignal('LOOM_TOO_BIGX'), undefined);
  });

  it('rejects a non-signal line', () => {
    assert.equal(matchTooBigSignal('just some log output'), undefined);
    assert.equal(matchTooBigSignal(''), undefined);
  });

  it('uses the canonical keyword constant', () => {
    assert.ok(formatTooBigSignal('x').startsWith(LOOM_TOO_BIG_SIGNAL));
  });
});

// ─── ReroutePMAgent.decompose (the real adapter) ────────────────────────────────

const VALID_PM_OUTPUT = JSON.stringify({
  stories: [
    { id: 'sub-1', title: 'API layer', description: 'do the api', acceptance_criteria: ['api works'], estimated_complexity: 'small', dependencies: [] },
    { id: 'sub-2', title: 'UI layer', description: 'do the ui', acceptance_criteria: ['ui works'], estimated_complexity: 'small', dependencies: ['sub-1'] },
  ],
});

describe('ReroutePMAgent.decompose', () => {
  it('[Happy] accepts the placeholder-id output it INSTRUCTS the PM to emit', async () => {
    // The blocker: the agent told the PM to use "sub-1" ids but validated against
    // the strict story-NNN regex → every compliant call failed. This asserts the
    // instructed shape now parses.
    const agent = new ReroutePMAgent({ llm: new MockLLMClient([VALID_PM_OUTPUT]), model: 'test' });
    const subs = await agent.decompose('# Story\n\nbig one', 'too big', []);
    assert.equal(subs.length, 2);
    assert.equal(subs[0].id, 'sub-1');
    assert.deepEqual(subs[1].dependencies, ['sub-1']);
  });

  it('[Happy] works with an EMPTY fanOutPayload (the cap-kill trigger has none)', async () => {
    const agent = new ReroutePMAgent({ llm: new MockLLMClient([VALID_PM_OUTPUT]), model: 'test' });
    const subs = await agent.decompose('# Story', '', []);
    assert.equal(subs.length, 2);
  });

  it('[Retry] a first bad response then a good one succeeds (bounded retry)', async () => {
    const agent = new ReroutePMAgent({
      llm: new MockLLMClient(['not json at all', VALID_PM_OUTPUT]),
      model: 'test',
    });
    const subs = await agent.decompose('# Story', 'reason', []);
    assert.equal(subs.length, 2);
  });

  it('[Negative] fewer than 2 sub-stories fails schema (after retries)', async () => {
    const one = JSON.stringify({ stories: [{ id: 'sub-1', title: 't', description: 'd', acceptance_criteria: ['a'], estimated_complexity: 'small', dependencies: [] }] });
    const agent = new ReroutePMAgent({ llm: new MockLLMClient([one, one]), model: 'test' });
    await assert.rejects(() => agent.decompose('# Story', '', []), /valid sub-stories decomposition/);
  });

  it('[Negative] unparseable output fails after 2 attempts', async () => {
    const agent = new ReroutePMAgent({ llm: new MockLLMClient(['nope', 'still nope']), model: 'test' });
    await assert.rejects(() => agent.decompose('# Story', '', []), /after 2 attempts/);
  });

  it('passes the coverage keys into the prompt so the PM can satisfy them', async () => {
    let seenPrompt = '';
    const llm = new MockLLMClient((req) => {
      seenPrompt = req.messages[0].content;
      return VALID_PM_OUTPUT;
    });
    const agent = new ReroutePMAgent({ llm, model: 'test' });
    await agent.decompose('# Story', '', ['apiSchema', 'dbMigration']);
    assert.match(seenPrompt, /apiSchema/);
    assert.match(seenPrompt, /dbMigration/);
    assert.match(seenPrompt, /EXACTLY ONE sub-story/);
  });

  it('uses a dedicated splitter system prompt, not the PRD planning persona', async () => {
    let sys = '';
    const llm = new MockLLMClient((req) => { sys = req.system[0].text; return VALID_PM_OUTPUT; });
    const agent = new ReroutePMAgent({ llm, model: 'test' });
    await agent.decompose('# Story', '', []);
    assert.match(sys, /split/i);
    assert.ok(!/PRD/i.test(sys), 'must NOT load the PRD-conditioned planning persona');
    // Caching invariant: the system block is cache-marked.
    const cachedLlm = new MockLLMClient((req) => {
      assert.equal(req.system[0].cache, true);
      return VALID_PM_OUTPUT;
    });
    await new ReroutePMAgent({ llm: cachedLlm, model: 'test' }).decompose('# Story', '', []);
  });
});
