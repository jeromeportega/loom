import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { appendResolvedDecisionsAppendix } from '../appendix.js';
import type { ResolvedDecision } from '../types.js';

describe('appendResolvedDecisionsAppendix', () => {
  it('appends a heading and one bullet per decision, preserving the brief verbatim', () => {
    const brief = 'Build the thing.';
    const out = appendResolvedDecisionsAppendix(brief, [
      { id: 'a', text: 'Which store?', blast_radius: 'high', answer: 'sqlite', tag: 'user-decided' },
      { id: 'b', text: 'Cap?', blast_radius: 'low', answer: '4', tag: 'auto-default' },
    ]);
    assert.ok(out.startsWith('Build the thing.\n\n'), 'original brief is a verbatim prefix');
    assert.ok(out.includes('## Resolved Assumptions and Decisions'));
    assert.ok(out.includes('- **Which store?** — sqlite *(tag: user-decided)*'));
    assert.ok(out.includes('- **Cap?** — 4 *(tag: auto-default)*'));
  });

  it('renders a citation link when present', () => {
    const out = appendResolvedDecisionsAppendix('B', [
      { id: 'a', text: 'Where?', blast_radius: 'high', answer: 'here', tag: 'fact-cited', citation: 'src/x.ts:9' },
    ]);
    assert.ok(out.includes('([`src/x.ts:9`](src/x.ts:9))'));
  });

  it('omits the citation link when absent', () => {
    const out = appendResolvedDecisionsAppendix('B', [
      { id: 'a', text: 'Q', blast_radius: 'low', answer: 'x', tag: 'fact-uncited' },
    ]);
    assert.ok(!out.includes(']('), 'no link markup when there is no citation');
  });

  it('is pure — does not mutate the input brief and returns a new string', () => {
    const brief = 'original';
    const out = appendResolvedDecisionsAppendix(brief, []);
    assert.equal(brief, 'original');
    assert.notEqual(out, brief);
    assert.ok(out.includes('## Resolved Assumptions and Decisions'));
  });
});
