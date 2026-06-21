import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { AutoResumeCounter } from '../AutoResumeCounter.js';

describe('AutoResumeCounter — default-absent', () => {
  it('returns 0 for any storyId before any record call', () => {
    const counter = new AutoResumeCounter();
    assert.equal(counter.attemptsFor('story-A'), 0);
    assert.equal(counter.attemptsFor('story-B'), 0);
    assert.equal(counter.attemptsFor(''), 0);
  });
});

describe('AutoResumeCounter — increment & return', () => {
  it('record returns 1 on first call and 2 on second; attemptsFor reflects each', () => {
    const counter = new AutoResumeCounter();

    const first = counter.record('story-A');
    assert.equal(first, 1, 'first record returns 1');
    assert.equal(counter.attemptsFor('story-A'), 1, 'attemptsFor reflects after first record');

    const second = counter.record('story-A');
    assert.equal(second, 2, 'second record returns 2');
    assert.equal(counter.attemptsFor('story-A'), 2, 'attemptsFor reflects after second record');
  });
});

describe('AutoResumeCounter — per-story isolation', () => {
  it("recording story-A does not affect story-B's count", () => {
    const counter = new AutoResumeCounter();
    counter.record('story-A');
    counter.record('story-A');
    assert.equal(counter.attemptsFor('story-B'), 0, "story-B count is unaffected by story-A's records");
  });

  it('each story tracks its own count independently', () => {
    const counter = new AutoResumeCounter();
    counter.record('story-A');
    counter.record('story-B');
    counter.record('story-B');
    assert.equal(counter.attemptsFor('story-A'), 1);
    assert.equal(counter.attemptsFor('story-B'), 2);
  });
});

describe('AutoResumeCounter — run-scope reset (no shared static state)', () => {
  it('a fresh AutoResumeCounter for the same storyId starts at 0', () => {
    const counter1 = new AutoResumeCounter();
    counter1.record('story-X');
    counter1.record('story-X');
    assert.equal(counter1.attemptsFor('story-X'), 2);

    const counter2 = new AutoResumeCounter();
    assert.equal(counter2.attemptsFor('story-X'), 0, 'new instance starts fresh — no shared state');
  });

  it('mutating a second instance does not affect the first', () => {
    const a = new AutoResumeCounter();
    const b = new AutoResumeCounter();
    a.record('story-Y');
    assert.equal(b.attemptsFor('story-Y'), 0, 'instances are fully isolated');
  });
});
