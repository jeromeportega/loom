import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { PersonaLoader } from '../planner/PersonaLoader.js';

describe('PersonaLoader', () => {
  it('lists the three planning personas', () => {
    assert.deepEqual(PersonaLoader.available(), ['analyst', 'pm', 'architect']);
  });

  it('loads the analyst persona with required frontmatter', () => {
    const p = PersonaLoader.load('analyst');
    assert.equal(p.id, 'analyst');
    assert.equal(p.name, 'Mary');
    assert.equal(p.title, 'Business Analyst');
    assert.equal(p.handsOffTo, 'pm');
    assert.ok(p.icon.length > 0);
    assert.ok(p.role.length > 0);
  });

  it('loads the pm persona', () => {
    const p = PersonaLoader.load('pm');
    assert.equal(p.name, 'John');
    assert.equal(p.handsOffTo, 'architect');
  });

  it('loads the architect persona with null hand-off', () => {
    const p = PersonaLoader.load('architect');
    assert.equal(p.name, 'Winston');
    assert.equal(p.handsOffTo, null);
  });

  it('builds a system prompt that embeds the persona body', () => {
    const p = PersonaLoader.load('analyst');
    assert.ok(p.systemPrompt.includes('Mary'));
    assert.ok(p.systemPrompt.includes('Business Analyst'));
    // The headless task instructions must be present
    assert.ok(p.systemPrompt.includes('Headless task'));
  });

  it('pm persona prompt describes both PRD and epic-breakdown tasks', () => {
    const p = PersonaLoader.load('pm');
    assert.ok(p.systemPrompt.includes('Headless task A'));
    assert.ok(p.systemPrompt.includes('Headless task B'));
    assert.ok(p.systemPrompt.includes('epic_id'));
  });

  it('architect persona prompt describes architecture and tech_notes tasks', () => {
    const p = PersonaLoader.load('architect');
    assert.ok(p.systemPrompt.includes('architecture'));
    assert.ok(p.systemPrompt.includes('tech_notes'));
  });

  it('loads the QA persona (Tessa), opt-in and outside the default pipeline', () => {
    const p = PersonaLoader.load('qa');
    assert.equal(p.id, 'qa');
    assert.equal(p.name, 'Tessa');
    assert.equal(p.handsOffTo, null);
    assert.ok(p.systemPrompt.includes('test_plan'));
    // Opt-in: not part of the Analyst→PM→Architect pipeline that available() lists.
    assert.ok(!PersonaLoader.available().includes('qa'));
  });
});
