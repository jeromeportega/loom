/**
 * Integration tests: Planner writes planning scratch under planningRoot (AC1/AC4).
 *
 * Verifies that when PlannerOptions.planningRoot is provided, all artifact files
 * (project-brief.md, prd.md, architecture.md, epic YAML) land under planningRoot
 * and nothing is written under projectRoot/.loom/planning/.
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDatabase, resetDatabaseForTest } from '../../state/Database.js';
import { MockLLMClient } from '../../llm/MockLLMClient.js';
import type { LLMRequest } from '../../llm/LLMClient.js';
import { Planner } from '../Planner.js';

function makeResponder(req: LLMRequest): string {
  const last = req.messages[req.messages.length - 1].content;
  if (last.includes('Produce the project brief') || last.includes('brief to analyze')) {
    return '# Test Project\n\n## Goal\nTest the path re-rooting.';
  }
  if (last.includes('Headless task A: produce the PRD')) {
    return '# Test PRD\n\n## Goals\nRe-root planning scratch.\n\n## Functional Requirements\nFR-1: files in loom-home.';
  }
  if (last.includes('Headless task B: produce the epic')) {
    return (
      '```json\n' +
      JSON.stringify({
        epics: [
          {
            epic_id: 'epic-001',
            title: 'Path re-rooting epic',
            priority: 'must-have',
            prd_ref: 'placeholder',
            requirements: ['FR-1'],
            stories: [
              {
                id: 'story-001-001',
                title: 'Re-root paths',
                description: 'Move planning scratch to loom-home.',
                acceptance_criteria: ['Files exist in loom-home'],
                estimated_complexity: 'small',
                dependencies: [],
              },
            ],
          },
        ],
      }) +
      '\n```'
    );
  }
  if (last.includes('Headless task A: produce the architecture')) {
    return '# Architecture\n\n## Overview\nSimple.';
  }
  if (last.includes('Headless task B: produce per-story')) {
    return '```json\n' + JSON.stringify({ tech_notes: { 'story-001-001': 'Use path module.' } }) + '\n```';
  }
  throw new Error(`[planningPaths test] Unexpected LLM message: ${last.slice(0, 80)}`);
}

describe('Planner — writes scratch under planningRoot, not under projectRoot/.loom (AC1/AC4)', () => {
  let projectRoot: string;
  let planningRoot: string;

  before(async () => {
    resetDatabaseForTest();
    projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'loom-reroottest-'));
    planningRoot = path.join(projectRoot, 'loom-home', 'repos', 'my-repo', 'planning');

    const db = openDatabase(path.join(projectRoot, '.loom'));
    await new Planner({
      projectRoot,
      planningRoot,
      llm: new MockLLMClient(makeResponder),
      model: 'mock-model',
      db,
    }).run('Test path re-rooting for planning scratch.');
  });

  after(() => {
    resetDatabaseForTest();
    fs.rmSync(projectRoot, { recursive: true, force: true });
  });

  it('writes project-brief.md under planningRoot/epic-001/', () => {
    assert.ok(
      fs.existsSync(path.join(planningRoot, 'epic-001', 'project-brief.md')),
      'project-brief.md must be under planningRoot',
    );
  });

  it('writes prd.md under planningRoot/epic-001/', () => {
    assert.ok(
      fs.existsSync(path.join(planningRoot, 'epic-001', 'prd.md')),
      'prd.md must be under planningRoot',
    );
  });

  it('writes architecture.md under planningRoot/epic-001/', () => {
    assert.ok(
      fs.existsSync(path.join(planningRoot, 'epic-001', 'architecture.md')),
      'architecture.md must be under planningRoot',
    );
  });

  it('writes epic YAML under planningRoot/epic-001/epics/', () => {
    assert.ok(
      fs.existsSync(path.join(planningRoot, 'epic-001', 'epics', 'epic-001.yaml')),
      'epic YAML must be under planningRoot',
    );
  });

  it('writes NO scratch files under projectRoot/.loom/planning/ (AC4)', () => {
    const inRepoPlanning = path.join(projectRoot, '.loom', 'planning');
    assert.ok(
      !fs.existsSync(inRepoPlanning),
      `.loom/planning must not exist when planningRoot is elsewhere: ${inRepoPlanning}`,
    );
  });
});
