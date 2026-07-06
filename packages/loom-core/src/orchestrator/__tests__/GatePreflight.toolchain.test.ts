import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {
  resolveGatePlan,
  type GatePreflightOptions,
  type GateStep,
} from '../GatePreflight.js';

// ─── Fixtures ─────────────────────────────────────────────────────────────

const REAL_PKG = JSON.stringify({ scripts: { test: 'node --test' } });
const NEXT_PKG = JSON.stringify({ scripts: { test: 'node --test' }, dependencies: { next: '14.0.0' } });
const NEXT_DEV_PKG = JSON.stringify({ scripts: { test: 'node --test' }, devDependencies: { next: '14.0.0' } });

/** Probe factory backed by a basename→content map; no disk involved. */
function fakeFs(files: Record<string, string>): GatePreflightOptions {
  const byName = (p: string): string | undefined => files[path.basename(p)];
  return {
    fileExists: (p) => byName(p) !== undefined,
    fileReader: (p) => byName(p) ?? null,
  };
}

const noFiles: GatePreflightOptions = { fileExists: () => false, fileReader: () => null };

function findStep(steps: GateStep[], name: string): GateStep | undefined {
  return steps.find((s) => s.name === name);
}

// ─── TypeScript / tsc detection ───────────────────────────────────────────

describe('toolchain detection — typecheck:tsc', () => {
  it('tsconfig.json present → appends typecheck:tsc with correct command and cwd', () => {
    const plan = resolveGatePlan('/repo', fakeFs({ 'package.json': REAL_PKG, 'tsconfig.json': '{}' }));
    const step = findStep(plan.steps, 'typecheck:tsc');
    assert.ok(step, 'typecheck:tsc step should be present');
    assert.equal(step.kind, 'typecheck');
    assert.equal(step.command, 'npx --no-install tsc --noEmit');
    assert.equal(step.cwd, plan.cwd, 'toolchain step cwd must equal plan.cwd (project root)');
  });

  it('no tsconfig.json → no typecheck:tsc step', () => {
    const plan = resolveGatePlan('/repo', fakeFs({ 'package.json': REAL_PKG }));
    assert.equal(findStep(plan.steps, 'typecheck:tsc'), undefined);
  });
});

// ─── Next.js detection ────────────────────────────────────────────────────

describe('toolchain detection — build:next via config file', () => {
  for (const cfg of ['next.config.js', 'next.config.mjs', 'next.config.ts', 'next.config.cjs']) {
    it(`${cfg} present → appends build:next`, () => {
      const plan = resolveGatePlan('/repo', fakeFs({ 'package.json': REAL_PKG, [cfg]: 'module.exports = {}' }));
      const step = findStep(plan.steps, 'build:next');
      assert.ok(step, `build:next step should be present when ${cfg} exists`);
      assert.equal(step.kind, 'build');
      assert.equal(step.command, 'npx --no-install next build');
      assert.equal(step.cwd, plan.cwd);
    });
  }
});

describe('toolchain detection — build:next via package.json dependency', () => {
  it('next in dependencies → appends build:next even without next.config', () => {
    const plan = resolveGatePlan('/repo', fakeFs({ 'package.json': NEXT_PKG }));
    const step = findStep(plan.steps, 'build:next');
    assert.ok(step, 'build:next should be present when next is in dependencies');
    assert.equal(step.command, 'npx --no-install next build');
    assert.equal(step.cwd, plan.cwd);
  });

  it('next in devDependencies → appends build:next', () => {
    const plan = resolveGatePlan('/repo', fakeFs({ 'package.json': NEXT_DEV_PKG }));
    const step = findStep(plan.steps, 'build:next');
    assert.ok(step, 'build:next should be present when next is in devDependencies');
  });

  it('package.json without next dependency and no next.config → no build:next', () => {
    const plan = resolveGatePlan('/repo', fakeFs({ 'package.json': REAL_PKG }));
    assert.equal(findStep(plan.steps, 'build:next'), undefined);
  });
});

// ─── Go detection ─────────────────────────────────────────────────────────

describe('toolchain detection — build:go', () => {
  it('go.mod present → appends build:go with correct command and cwd', () => {
    const plan = resolveGatePlan('/repo', fakeFs({ Makefile: 'build:\n\tgo build\ntest:\n\tgo test ./...\n', 'go.mod': 'module example\n' }));
    const step = findStep(plan.steps, 'build:go');
    assert.ok(step, 'build:go step should be present');
    assert.equal(step.kind, 'build');
    assert.equal(step.command, 'go build ./...');
    assert.equal(step.cwd, plan.cwd);
  });

  it('no go.mod → no build:go step', () => {
    const plan = resolveGatePlan('/repo', fakeFs({ 'package.json': REAL_PKG }));
    assert.equal(findStep(plan.steps, 'build:go'), undefined);
  });
});

// ─── Rust detection ───────────────────────────────────────────────────────

describe('toolchain detection — build:cargo', () => {
  it('Cargo.toml present → appends build:cargo with correct command and cwd', () => {
    const plan = resolveGatePlan('/repo', fakeFs({ Makefile: 'test:\n\tcargo test\n', 'Cargo.toml': '[package]\nname = "foo"\n' }));
    const step = findStep(plan.steps, 'build:cargo');
    assert.ok(step, 'build:cargo step should be present');
    assert.equal(step.kind, 'build');
    assert.equal(step.command, 'cargo build');
    assert.equal(step.cwd, plan.cwd);
  });

  it('no Cargo.toml → no build:cargo step', () => {
    const plan = resolveGatePlan('/repo', fakeFs({ 'package.json': REAL_PKG }));
    assert.equal(findStep(plan.steps, 'build:cargo'), undefined);
  });
});

// ─── Additive multi-toolchain composition (FR-3) ─────────────────────────

describe('toolchain detection — additive multi-toolchain (FR-3)', () => {
  it('TS + Go → steps = [unit, typecheck:tsc, build:go]', () => {
    const plan = resolveGatePlan('/repo', fakeFs({
      'package.json': REAL_PKG,
      'tsconfig.json': '{}',
      'go.mod': 'module example\n',
    }));
    assert.equal(plan.source, 'auto-detected');
    const names = plan.steps.map((s) => s.name);
    assert.deepEqual(names, ['unit', 'typecheck:tsc', 'build:go']);
  });

  it('all four toolchains → fixed order: unit, typecheck:tsc, build:next, build:go, build:cargo', () => {
    const plan = resolveGatePlan('/repo', fakeFs({
      'package.json': REAL_PKG,
      'tsconfig.json': '{}',
      'next.config.js': 'module.exports = {}',
      'go.mod': 'module example\n',
      'Cargo.toml': '[package]\nname = "foo"\n',
    }));
    const names = plan.steps.map((s) => s.name);
    assert.deepEqual(names, ['unit', 'typecheck:tsc', 'build:next', 'build:go', 'build:cargo']);
  });

  it('TS + Next + Go + Rust → all four toolchain steps appended independently', () => {
    const plan = resolveGatePlan('/repo', fakeFs({
      'package.json': REAL_PKG,
      'tsconfig.json': '{}',
      'next.config.mjs': 'export default {}',
      'go.mod': 'module example\n',
      'Cargo.toml': '[package]\nname = "foo"\n',
    }));
    assert.equal(plan.steps.length, 5, 'should have unit + 4 toolchain steps');
  });
});

// ─── Negative — no toolchain signals ─────────────────────────────────────

describe('toolchain detection — no signals (negative)', () => {
  it('npm package with no toolchain signals → only the unit step', () => {
    const plan = resolveGatePlan('/repo', fakeFs({ 'package.json': REAL_PKG }));
    assert.equal(plan.steps.length, 1);
    assert.equal(plan.steps[0].name, 'unit');
  });

  it('completely empty signals → source:none, steps=[]', () => {
    const plan = resolveGatePlan('/repo', noFiles);
    assert.deepEqual(plan.steps, []);
    assert.equal(plan.source, 'none');
  });
});

// ─── FR-1 reuse: detection uses injected probes, not real fs ─────────────

describe('toolchain detection — probe injection (FR-1)', () => {
  it('fileExists calls are made for toolchain signals (proves probes are used)', () => {
    const checkedPaths: string[] = [];
    const opts: GatePreflightOptions = {
      fileExists: (p) => {
        checkedPaths.push(path.basename(p));
        if (path.basename(p) === 'package.json') return true;
        if (path.basename(p) === 'tsconfig.json') return true;
        return false;
      },
      fileReader: (p) => {
        if (path.basename(p) === 'package.json') return REAL_PKG;
        return null;
      },
    };
    resolveGatePlan('/repo', opts);
    assert.ok(checkedPaths.includes('tsconfig.json'), 'tsconfig.json must be probed via injected fileExists');
    assert.ok(checkedPaths.includes('go.mod'), 'go.mod must be probed via injected fileExists');
    assert.ok(checkedPaths.includes('Cargo.toml'), 'Cargo.toml must be probed via injected fileExists');
  });

  it('detection never touches real disk when probes are injected', () => {
    // If probes were ignored and real fs was used, no tsconfig.json would be
    // found at '/nonexistent-root' — the injected probe forces detection.
    const plan = resolveGatePlan('/nonexistent-root', fakeFs({
      'package.json': REAL_PKG,
      'tsconfig.json': '{}',
      'go.mod': 'module example\n',
    }));
    const names = plan.steps.map((s) => s.name);
    assert.ok(names.includes('typecheck:tsc'), 'tsc step detected via probe, not real disk');
    assert.ok(names.includes('build:go'), 'go step detected via probe, not real disk');
  });
});

// ─── cwd separation (FR-5) ────────────────────────────────────────────────

describe('toolchain detection — cwd anchoring (FR-5)', () => {
  it('unit step cwd equals plan.cwd', () => {
    const plan = resolveGatePlan('/repo', fakeFs({
      'package.json': REAL_PKG,
      'tsconfig.json': '{}',
    }));
    const unit = findStep(plan.steps, 'unit');
    assert.ok(unit);
    assert.equal(unit.cwd, plan.cwd);
  });

  it('all toolchain steps cwd equals plan.cwd (project root)', () => {
    const plan = resolveGatePlan('/repo', fakeFs({
      'package.json': REAL_PKG,
      'tsconfig.json': '{}',
      'next.config.js': 'module.exports = {}',
      'go.mod': 'module example\n',
      'Cargo.toml': '[package]\nname = "foo"\n',
    }));
    for (const step of plan.steps.filter((s) => s.name !== 'unit')) {
      assert.equal(step.cwd, plan.cwd, `${step.name} cwd must be project root`);
    }
  });
});

// ─── Override branch suppresses toolchain detection ───────────────────────

describe('toolchain detection — override branch suppression', () => {
  it('testCommand set → no toolchain steps even with tsconfig.json present', () => {
    let existsCalls = 0;
    const plan = resolveGatePlan('/repo', {
      testCommand: 'my-test-runner',
      fileExists: () => { existsCalls++; return true; },
      fileReader: () => '{}',
    });
    assert.equal(plan.source, 'configured');
    assert.equal(plan.steps.length, 1);
    assert.equal(plan.steps[0].name, 'unit');
    assert.equal(existsCalls, 0, 'fileExists must never be called in override branch');
  });
});
