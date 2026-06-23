import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { planningPaths, planningRelPaths } from '../../src/planner/paths.js';

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

// ── Unit: planningRelPaths — legacy vs loom-home paths ───────────────────────

describe('planningRelPaths — legacy fallback (no planningRoot)', () => {
  const runId = 'epic-005';

  it('brief uses .loom/planning prefix', () => {
    const { brief } = planningRelPaths(runId);
    assert.ok(brief.startsWith('.loom/planning/'), `brief must start with .loom/planning/: ${brief}`);
    assert.ok(brief.endsWith('project-brief.md'));
  });

  it('prd uses .loom/planning prefix', () => {
    const { prd } = planningRelPaths(runId);
    assert.ok(prd.startsWith('.loom/planning/'), `prd must start with .loom/planning/: ${prd}`);
  });

  it('epicFile uses .loom/planning prefix', () => {
    const ep = planningRelPaths(runId).epicFile('epic-005');
    assert.ok(ep.startsWith('.loom/planning/'), `epicFile must start with .loom/planning/: ${ep}`);
  });
});

describe('planningRelPaths — loom-home path (planningRoot provided)', () => {
  const projectRoot = '/home/user/myproject';
  const planningRoot = '/home/user/.loom/repos/myproject-abc123/planning';
  const runId = 'epic-007';

  it('brief resolves to planningRoot via path.join(projectRoot, brief)', () => {
    const { brief } = planningRelPaths(runId, planningRoot, projectRoot);
    const resolved = path.join(projectRoot, brief);
    const expected = path.join(planningRoot, runId, 'project-brief.md');
    assert.equal(resolved, expected);
  });

  it('prd resolves to planningRoot via path.join(projectRoot, prd)', () => {
    const { prd } = planningRelPaths(runId, planningRoot, projectRoot);
    const resolved = path.join(projectRoot, prd);
    const expected = path.join(planningRoot, runId, 'prd.md');
    assert.equal(resolved, expected);
  });

  it('architecture resolves to planningRoot', () => {
    const { architecture } = planningRelPaths(runId, planningRoot, projectRoot);
    const resolved = path.join(projectRoot, architecture);
    const expected = path.join(planningRoot, runId, 'architecture.md');
    assert.equal(resolved, expected);
  });

  it('epicFile resolves to planningRoot', () => {
    const rel = planningRelPaths(runId, planningRoot, projectRoot);
    const resolved = path.join(projectRoot, rel.epicFile('epic-007'));
    const expected = path.join(planningRoot, runId, 'epics', 'epic-007.yaml');
    assert.equal(resolved, expected);
  });

  it('does not contain .loom/planning in the returned paths', () => {
    const rel = planningRelPaths(runId, planningRoot, projectRoot);
    for (const [key, val] of Object.entries(rel)) {
      if (typeof val === 'string') {
        assert.ok(
          !val.includes('.loom/planning'),
          `planningRelPaths.${key} must not contain .loom/planning when planningRoot is loom-home: ${val}`,
        );
      }
    }
  });

  it('when planningRoot IS inside projectRoot, brief resolves correctly', () => {
    // Verify that the relative-path approach works even for in-repo planningRoot.
    const inRepoRoot = path.join(projectRoot, '.loom', 'planning');
    const { brief } = planningRelPaths(runId, inRepoRoot, projectRoot);
    const resolved = path.join(projectRoot, brief);
    const expected = path.join(inRepoRoot, runId, 'project-brief.md');
    assert.equal(resolved, expected);
  });
});
