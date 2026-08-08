import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type * as readline from 'node:readline';
import { runGrillingInterview, type InterviewOptions } from '../interview.js';
import type { GrillingDecision, ProvenanceTag } from '../types.js';
import type { LLMClient, LLMRequest, LLMResponse } from '../../llm/index.js';

const TAGS: ProvenanceTag[] = [
  'user-decided', 'user-accepted-recommendation', 'auto-default', 'fact-cited', 'fact-uncited',
];

function decision(p: Partial<GrillingDecision> & Pick<GrillingDecision, 'id'>): GrillingDecision {
  return {
    text: `Q ${p.id}`,
    blast_radius: 'low',
    prerequisites: [],
    recommendation: `rec-${p.id}`,
    alternatives: [{ label: 'alt', tradeoff: 'x' }, { label: 'alt2', tradeoff: 'y' }],
    is_lookup_able: false,
    ...p,
  };
}

/** Mock readline.Interface: dequeues queued answers; '__CLOSE__' fires the close event. */
class MockRl {
  private idx = 0;
  private closeCbs: (() => void)[] = [];
  questionCount = 0;
  constructor(private answers: string[]) {}
  question(_q: string, cb: (a: string) => void): void {
    this.questionCount++;
    const a = this.idx < this.answers.length ? this.answers[this.idx++] : '';
    if (a === '__CLOSE__') {
      // Faithful to node:readline: closing the interface (Ctrl-C / Ctrl-D / EOF)
      // fires 'close' and DROPS the pending question callback — the callback is
      // never invoked. (A mock that resolved it here would hide the real
      // cancel-path hang: the production `ask` must settle via the close event.)
      this.closeCbs.forEach((f) => f());
      return;
    }
    queueMicrotask(() => cb(a));
  }
  on(ev: string, fn: () => void): this { if (ev === 'close') this.closeCbs.push(fn); return this; }
  removeListener(ev: string, fn: () => void): this {
    if (ev === 'close') this.closeCbs = this.closeCbs.filter((f) => f !== fn);
    return this;
  }
  close(): void { this.closeCbs.forEach((f) => f()); }
}

let llmCalls = 0;
function mockLlm(): LLMClient {
  return {
    complete: async (_req: LLMRequest): Promise<LLMResponse> => {
      llmCalls++;
      return { text: 'no citation here', usage: { inputTokens: 3, outputTokens: 7, requestCount: 1 } } as LLMResponse;
    },
  };
}

function opts(rl: MockRl, llm?: LLMClient): InterviewOptions {
  return { llm: llm ?? mockLlm(), model: 'm', repoRoot: '/tmp/x', rl: rl as unknown as readline.Interface };
}

describe('runGrillingInterview', () => {
  it('low-blast bulk-accept → user-accepted-recommendation; completes', async () => {
    const rl = new MockRl(['', 'y']);
    const r = await runGrillingInterview([decision({ id: 'a' }), decision({ id: 'b' })], opts(rl));
    assert.equal(r.outcome, 'completed');
    assert.equal(r.resolved.length, 2);
    assert.ok(r.resolved.every((d) => d.tag === 'user-accepted-recommendation'));
    assert.ok(r.resolved.every((d) => d.answer.startsWith('rec-')));
  });

  it('explicit answer → user-decided; answer matching recommendation → accepted', async () => {
    const rl = new MockRl(['sqlite', 'rec-b']);
    const r = await runGrillingInterview(
      [decision({ id: 'a', blast_radius: 'high' }), decision({ id: 'b', blast_radius: 'high' })],
      opts(rl),
    );
    assert.equal(r.outcome, 'completed');
    const a = r.resolved.find((d) => d.id === 'a')!;
    const b = r.resolved.find((d) => d.id === 'b')!;
    assert.equal(a.tag, 'user-decided');
    assert.equal(a.answer, 'sqlite');
    assert.equal(b.tag, 'user-accepted-recommendation');
  });

  it('high-blast bulk-accept is rejected and re-prompted', async () => {
    const rl = new MockRl(['y', 'real answer']); // 'y' rejected, then explicit
    const r = await runGrillingInterview([decision({ id: 'a', blast_radius: 'high' })], opts(rl));
    assert.equal(r.outcome, 'completed');
    assert.equal(rl.questionCount, 2, 'a re-prompt must have occurred');
    assert.equal(r.resolved[0].tag, 'user-decided');
    assert.equal(r.resolved[0].answer, 'real answer');
  });

  it('respects topological order — a dependent is not asked before its prerequisite', async () => {
    // b requires a. First answer settles a; b only becomes frontier afterward.
    const rl = new MockRl(['ans-a', 'ans-b']);
    const decisions = [
      decision({ id: 'b', prerequisites: ['a'], blast_radius: 'high' }),
      decision({ id: 'a', blast_radius: 'high' }),
    ];
    const r = await runGrillingInterview(decisions, opts(rl));
    assert.equal(r.outcome, 'completed');
    assert.equal(r.resolved.find((d) => d.id === 'a')!.answer, 'ans-a');
    assert.equal(r.resolved.find((d) => d.id === 'b')!.answer, 'ans-b');
  });

  it('fact-checks lookup-able decisions and accumulates tokenCost', async () => {
    llmCalls = 0;
    const rl = new MockRl(['y']);
    const r = await runGrillingInterview(
      [decision({ id: 'a', is_lookup_able: true })],
      opts(rl),
    );
    assert.equal(r.outcome, 'completed');
    assert.equal(llmCalls, 1, 'factCheck must call the model once');
    assert.equal(r.tokenCost, 10, 'tokenCost = inputTokens + outputTokens');
    // The mock LLM returns ungrounded text ('no citation here') with no citation.
    // An uncited lookup must NOT become the answer — the recommendation is used,
    // tagged as an accepted recommendation, and the raw lookup text never leaks in.
    assert.equal(r.resolved[0].answer, 'rec-a');
    assert.notEqual(r.resolved[0].answer, 'no citation here');
    assert.equal(r.resolved[0].tag, 'user-accepted-recommendation');
  });

  it('a fact-check LLM error never cascades into the recorded answer', async () => {
    // factCheck catches the throw and returns { tag: 'fact-uncited', answer: <err> }.
    // The interview must discard that error text, not ledger it as the answer.
    const throwingLlm: LLMClient = {
      complete: async (): Promise<LLMResponse> => {
        throw new Error('network timeout during LLM call');
      },
    };
    const rl = new MockRl(['y']); // low-blast bulk-accept
    const r = await runGrillingInterview(
      [decision({ id: 'a', is_lookup_able: true })],
      opts(rl, throwingLlm),
    );
    assert.equal(r.outcome, 'completed');
    assert.equal(r.resolved[0].answer, 'rec-a', 'error text must not become the answer');
    assert.ok(
      !r.resolved[0].answer.includes('timeout'),
      'no fact-check error text may leak into the ledgered answer',
    );
  });

  it('tokenCost is 0 when no lookup-able decisions are present', async () => {
    const rl = new MockRl(['y']);
    const r = await runGrillingInterview([decision({ id: 'a' })], opts(rl));
    assert.equal(r.tokenCost, 0);
  });

  it('at the question cap, unresolved low-blast are auto-defaulted → completed', async () => {
    // 21 low-blast decisions; only 20 can be asked before the question cap.
    const decisions = Array.from({ length: 21 }, (_, i) =>
      decision({ id: `d${String(i).padStart(2, '0')}` }),
    );
    const rl = new MockRl(Array(20).fill('y'));
    const r = await runGrillingInterview(decisions, opts(rl));
    assert.equal(r.outcome, 'completed');
    assert.equal(r.resolved.length, 21);
    assert.equal(r.resolved.filter((d) => d.tag === 'auto-default').length, 1);
  });

  it('at the cap with an unresolved HIGH-blast decision → cancelled', async () => {
    const decisions = Array.from({ length: 21 }, (_, i) =>
      decision({ id: `d${String(i).padStart(2, '0')}`, blast_radius: i === 20 ? 'high' : 'low' }),
    );
    const rl = new MockRl(Array(20).fill('y'));
    const r = await runGrillingInterview(decisions, opts(rl));
    assert.equal(r.outcome, 'cancelled');
  });

  // The { timeout } guards these two: with a faithful MockRl (close DROPS the
  // pending question callback, like real node:readline), a regression of the
  // close-aware `ask` would HANG here instead of failing — the timeout converts
  // that hang into a fast, legible failure.
  it('Ctrl-C (readline close) cancels, returning what was settled so far', { timeout: 3000 }, async () => {
    const rl = new MockRl(['ans-a', '__CLOSE__', 'never']);
    const r = await runGrillingInterview(
      [decision({ id: 'a', blast_radius: 'high' }), decision({ id: 'b', blast_radius: 'high' })],
      opts(rl),
    );
    assert.equal(r.outcome, 'cancelled');
    assert.equal(r.resolved.length, 1, 'only the decision settled before abort');
    assert.equal(r.resolved[0].id, 'a');
  });

  it('EOF / Ctrl-D on the very first prompt cancels without hanging', { timeout: 3000 }, async () => {
    const rl = new MockRl(['__CLOSE__']);
    const r = await runGrillingInterview([decision({ id: 'a', blast_radius: 'high' })], opts(rl));
    assert.equal(r.outcome, 'cancelled');
    assert.equal(r.resolved.length, 0, 'nothing was settled before the immediate abort');
  });

  it('every resolved decision carries exactly one of the five provenance tags', async () => {
    const rl = new MockRl(['x', 'y']);
    const r = await runGrillingInterview(
      [decision({ id: 'a', blast_radius: 'high' }), decision({ id: 'b' })],
      opts(rl),
    );
    for (const d of r.resolved) assert.ok(TAGS.includes(d.tag), `bad tag ${d.tag}`);
  });
});
