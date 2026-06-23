import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { planningPaths } from '../../src/planner/paths.js';

// ── Unit: planningPaths re-rooting (AC1) ─────────────────────────────────────

describe('planningPaths — builds paths under planningRoot, not <projectRoot>/.loom/planning', () => {
  const planningRoot = '/tmp/loom-home/repos/my-repo-a1b2c3d4/planning';
  const runId = 'epic-003';

  it('runDir === path.join(planningRoot, runId)', () => {
    const { runDir } = planningPaths(planningRoot, runId);
    assert.equal(runDir, path.join(planningRoot, runId));
  });

  it('epicsDir === path.join(planningRoot, runId, "epics")', () => {
    const { epicsDir } = planningPaths(planningRoot, runId);
    assert.equal(epicsDir, path.join(planningRoot, runId, 'epics'));
  });

  it('brief === path.join(planningRoot, runId, "project-brief.md")', () => {
    const { brief } = planningPaths(planningRoot, runId);
    assert.equal(brief, path.join(planningRoot, runId, 'project-brief.md'));
  });

  it('prd === path.join(planningRoot, runId, "prd.md")', () => {
    const { prd } = planningPaths(planningRoot, runId);
    assert.equal(prd, path.join(planningRoot, runId, 'prd.md'));
  });

  it('architecture === path.join(planningRoot, runId, "architecture.md")', () => {
    const { architecture } = planningPaths(planningRoot, runId);
    assert.equal(architecture, path.join(planningRoot, runId, 'architecture.md'));
  });

  it('epicFile(epicId) === path.join(planningRoot, runId, "epics", "<epicId>.yaml")', () => {
    const { epicFile } = planningPaths(planningRoot, runId);
    assert.equal(epicFile('epic-003'), path.join(planningRoot, runId, 'epics', 'epic-003.yaml'));
  });

  it('none of the returned paths contain .loom/planning', () => {
    const paths = planningPaths(planningRoot, runId);
    for (const [key, val] of Object.entries(paths)) {
      if (typeof val === 'string') {
        assert.ok(
          !val.includes('.loom/planning'),
          `planningPaths.${key} must not contain .loom/planning: ${val}`,
        );
      }
    }
  });
});
