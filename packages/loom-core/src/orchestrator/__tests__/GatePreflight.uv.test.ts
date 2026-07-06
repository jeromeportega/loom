import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {
  resolveGatePlan,
  type GatePreflightOptions,
  type GateStep,
} from '../GatePreflight.js';

// ─── Fixtures ─────────────────────────────────────────────────────────────

// Probe factory keyed on full absolute paths (same pattern as toolchain.test.ts).
function fakeFs(root: string, files: Record<string, string>): GatePreflightOptions {
  const map: Record<string, string> = {};
  for (const [k, v] of Object.entries(files)) {
    map[path.join(root, k)] = v;
  }
  return {
    fileExists: (p) => p in map,
    fileReader: (p) => map[p] ?? null,
  };
}

// pyproject.toml that triggers pytest detection without any uv signals.
const PLAIN_PYTEST_PYPROJECT = '[tool.pytest.ini_options]\ntestpaths = ["tests"]\n';

// pyproject.toml with [tool.uv] — triggers both pytest detection and uv detection.
const UV_PYPROJECT =
  '[tool.uv]\ndev-dependencies = ["pytest"]\n\n[tool.pytest.ini_options]\ntestpaths = ["tests"]\n';

// pyproject.toml with [tool.uv.workspace] — triggers the --all-packages variant.
const UV_WORKSPACE_PYPROJECT =
  '[tool.uv]\ndev-dependencies = ["pytest"]\n\n[tool.uv.workspace]\nmembers = ["packages/*"]\n\n[tool.pytest.ini_options]\ntestpaths = ["tests"]\n';

// npm package with a real test script (for non-pytest cross-check).
const REAL_NPM_PKG = JSON.stringify({ scripts: { test: 'node --test' } });

function findStep(steps: GateStep[], name: string): GateStep | undefined {
  return steps.find((s) => s.name === name);
}

// ─── FR-6: uv.lock signal → uv run pytest ─────────────────────────────────

describe('uv detection — uv.lock present (FR-6)', () => {
  it('uv.lock alongside pytest.ini → unit command is uv run pytest', () => {
    const plan = resolveGatePlan('/repo', fakeFs('/repo', {
      'pytest.ini': '[pytest]\n',
      'uv.lock': 'version = 1\n',
    }));
    const unit = findStep(plan.steps, 'unit');
    assert.ok(unit, 'unit step must be present');
    assert.equal(unit.command, 'uv run pytest');
  });

  it('uv.lock with pyproject.toml (no [tool.uv.workspace]) → uv run pytest, not --all-packages', () => {
    const plan = resolveGatePlan('/repo', fakeFs('/repo', {
      'pyproject.toml': PLAIN_PYTEST_PYPROJECT,
      'uv.lock': 'version = 1\n',
    }));
    const unit = findStep(plan.steps, 'unit');
    assert.ok(unit);
    assert.equal(unit.command, 'uv run pytest');
  });
});

// ─── FR-6: [tool.uv] table → uv run pytest ────────────────────────────────

describe('uv detection — [tool.uv] section in pyproject.toml (FR-6)', () => {
  it('[tool.uv] present, no uv.lock → unit command is uv run pytest', () => {
    const plan = resolveGatePlan('/repo', fakeFs('/repo', {
      'pyproject.toml': UV_PYPROJECT,
    }));
    const unit = findStep(plan.steps, 'unit');
    assert.ok(unit);
    assert.equal(unit.command, 'uv run pytest');
  });

  it('[tool.uv] present with uv.lock → unit command is still uv run pytest', () => {
    const plan = resolveGatePlan('/repo', fakeFs('/repo', {
      'pyproject.toml': UV_PYPROJECT,
      'uv.lock': 'version = 1\n',
    }));
    const unit = findStep(plan.steps, 'unit');
    assert.ok(unit);
    assert.equal(unit.command, 'uv run pytest');
  });
});

// ─── FR-7: [tool.uv.workspace] table → uv run --all-packages pytest ───────

describe('uv detection — [tool.uv.workspace] section (FR-7)', () => {
  it('[tool.uv.workspace] present → unit command is uv run --all-packages pytest', () => {
    const plan = resolveGatePlan('/repo', fakeFs('/repo', {
      'pyproject.toml': UV_WORKSPACE_PYPROJECT,
    }));
    const unit = findStep(plan.steps, 'unit');
    assert.ok(unit);
    assert.equal(unit.command, 'uv run --all-packages pytest');
  });

  it('[tool.uv.workspace] + uv.lock → --all-packages variant (workspace takes precedence)', () => {
    const plan = resolveGatePlan('/repo', fakeFs('/repo', {
      'pyproject.toml': UV_WORKSPACE_PYPROJECT,
      'uv.lock': 'version = 1\n',
    }));
    const unit = findStep(plan.steps, 'unit');
    assert.ok(unit);
    assert.equal(unit.command, 'uv run --all-packages pytest');
  });

  it('[tool.uv.workspace] alone (no plain [tool.uv]) → --all-packages variant wins', () => {
    const workspaceOnlyPyproject =
      '[tool.uv.workspace]\nmembers = ["packages/*"]\n\n[tool.pytest.ini_options]\ntestpaths = ["tests"]\n';
    const plan = resolveGatePlan('/repo', fakeFs('/repo', {
      'pyproject.toml': workspaceOnlyPyproject,
    }));
    const unit = findStep(plan.steps, 'unit');
    assert.ok(unit);
    assert.equal(unit.command, 'uv run --all-packages pytest');
  });
});

// ─── FR-1 boundary: non-uv Python repos unchanged ─────────────────────────

describe('uv detection — negative / FR-1 boundary', () => {
  it('plain pyproject.toml with pytest section, no uv signals → bare pytest', () => {
    const plan = resolveGatePlan('/repo', fakeFs('/repo', {
      'pyproject.toml': PLAIN_PYTEST_PYPROJECT,
    }));
    const unit = findStep(plan.steps, 'unit');
    assert.ok(unit);
    assert.equal(unit.command, 'pytest');
  });

  it('pytest.ini only (no uv.lock, no pyproject.toml) → bare pytest', () => {
    const plan = resolveGatePlan('/repo', fakeFs('/repo', {
      'pytest.ini': '[pytest]\n',
    }));
    const unit = findStep(plan.steps, 'unit');
    assert.ok(unit);
    assert.equal(unit.command, 'pytest');
  });

  it('npm project with uv.lock present → npm test (uv does not affect non-pytest unit)', () => {
    const plan = resolveGatePlan('/repo', fakeFs('/repo', {
      'package.json': REAL_NPM_PKG,
      'uv.lock': 'version = 1\n',
    }));
    const unit = findStep(plan.steps, 'unit');
    assert.ok(unit);
    assert.equal(unit.command, 'npm test');
  });

  it('npm project with [tool.uv] in pyproject.toml → npm test (non-pytest unit is unchanged)', () => {
    const plan = resolveGatePlan('/repo', fakeFs('/repo', {
      'package.json': REAL_NPM_PKG,
      'pyproject.toml': UV_PYPROJECT,
    }));
    const unit = findStep(plan.steps, 'unit');
    assert.ok(unit);
    assert.equal(unit.command, 'npm test');
  });
});

// ─── ADR-5: uv rewrite stays kind:'unit', composes with toolchain steps ───

describe('uv detection — ADR-5: still a unit step, layers with toolchain steps', () => {
  it('uv Python + tsconfig → [unit(uv run pytest), typecheck:tsc]', () => {
    const plan = resolveGatePlan('/repo', fakeFs('/repo', {
      'pyproject.toml': UV_PYPROJECT,
      'tsconfig.json': '{}',
    }));
    assert.equal(plan.source, 'auto-detected');
    const names = plan.steps.map((s) => s.name);
    assert.deepEqual(names, ['unit', 'typecheck:tsc']);
    const unit = findStep(plan.steps, 'unit');
    assert.ok(unit);
    assert.equal(unit.kind, 'unit');
    assert.equal(unit.command, 'uv run pytest');
  });

  it('uv workspace + tsconfig → [unit(uv run --all-packages pytest), typecheck:tsc]', () => {
    const plan = resolveGatePlan('/repo', fakeFs('/repo', {
      'pyproject.toml': UV_WORKSPACE_PYPROJECT,
      'tsconfig.json': '{}',
    }));
    const names = plan.steps.map((s) => s.name);
    assert.deepEqual(names, ['unit', 'typecheck:tsc']);
    const unit = findStep(plan.steps, 'unit');
    assert.ok(unit);
    assert.equal(unit.kind, 'unit');
    assert.equal(unit.command, 'uv run --all-packages pytest');
  });

  it('uv Python + uv.lock → unit step is still kind:unit with name:unit', () => {
    const plan = resolveGatePlan('/repo', fakeFs('/repo', {
      'pytest.ini': '[pytest]\n',
      'uv.lock': 'version = 1\n',
    }));
    const unit = findStep(plan.steps, 'unit');
    assert.ok(unit);
    assert.equal(unit.kind, 'unit');
    assert.equal(unit.name, 'unit');
  });
});

// ─── Probe injection (same signal-based path, no TOML parser) ─────────────

describe('uv detection — probe injection (FR-1: same probe path, no TOML parser)', () => {
  it('uv.lock detection uses injected fileExists probe', () => {
    const existsPaths: string[] = [];
    const opts: GatePreflightOptions = {
      fileExists: (p) => {
        existsPaths.push(path.basename(p));
        return path.basename(p) === 'pytest.ini' || path.basename(p) === 'uv.lock';
      },
      fileReader: () => null,
    };
    resolveGatePlan('/repo', opts);
    assert.ok(existsPaths.includes('uv.lock'), 'uv.lock must be probed via injected fileExists');
  });

  it('pyproject.toml content is read via injected fileReader for uv table detection', () => {
    const readPaths: string[] = [];
    const opts: GatePreflightOptions = {
      fileExists: (p) => ['pyproject.toml'].includes(path.basename(p)),
      fileReader: (p) => {
        readPaths.push(path.basename(p));
        if (path.basename(p) === 'pyproject.toml') return UV_PYPROJECT;
        return null;
      },
    };
    resolveGatePlan('/repo', opts);
    assert.ok(readPaths.includes('pyproject.toml'), 'pyproject.toml must be read via injected fileReader');
  });
});
