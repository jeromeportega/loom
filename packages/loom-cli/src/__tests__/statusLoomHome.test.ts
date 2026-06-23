/**
 * Tests for loom-home path surfacing in `loom status` (story-051).
 *
 * AC1 — `loom status` prints a loom-home line near the top with the resolved path.
 * AC2 — The displayed path equals what resolveLoomHomePath returns (default sibling heuristic).
 * AC3 — A `policy.loom_home` override is reflected in the displayed line.
 * AC4 — When the loom-home directory does not exist, the line includes the "will be created" note.
 * AC5 — When the loom-home directory exists, no "will be created" note appears.
 * AC6 — `--json` output includes `loom_home` as an additive optional field.
 * AC7 — Existing `JsonStatus` shape (`epics: [...]`) is preserved (backward compat).
 */
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { resolveLoomHomePath } from '@loom-ai/core';
import { runStatus } from '../commands/status.js';

let repo: string;
let realRepo: string;

beforeEach(() => {
  repo = fs.mkdtempSync(path.join(os.tmpdir(), 'loom-status-loom-home-'));
  // On macOS, mkdtemp may return /var/... while fs.realpathSync gives /private/var/...
  // Use the resolved path so our expectations match what resolveLoomHomePath sees.
  realRepo = fs.realpathSync(repo);
  fs.mkdirSync(path.join(repo, '.loom'), { recursive: true });
});

afterEach(() => {
  fs.rmSync(repo, { recursive: true, force: true });
});

function captureStatus(options: Parameters<typeof runStatus>[0]): string {
  const lines: string[] = [];
  const orig = console.log;
  console.log = (...args: unknown[]): void => {
    lines.push(args.map(String).join(' '));
  };
  try {
    runStatus(options);
  } finally {
    console.log = orig;
  }
  return lines.join('\n');
}

describe('loom status — loom-home line (text output)', () => {
  it('[AC1][AC2] prints loom-home line with the resolved sibling-heuristic path', () => {
    // No policy.yaml — default heuristic applies: sibling of projectRoot named 'loom-home'
    fs.writeFileSync(path.join(repo, '.loom', 'policy.yaml'), 'version: 1\n');
    const expected = resolveLoomHomePath(realRepo, {});
    const out = captureStatus({ projectRoot: realRepo });
    assert.ok(
      out.includes(`loom-home: ${expected}`),
      `Expected loom-home line with path '${expected}' in output:\n${out}`
    );
  });

  it('[AC3] reflects policy.loom_home override in the displayed path', () => {
    const override = path.join(os.tmpdir(), 'my-custom-loom-home');
    fs.writeFileSync(
      path.join(repo, '.loom', 'policy.yaml'),
      `version: 1\nloom_home: ${override}\n`
    );
    const out = captureStatus({ projectRoot: realRepo });
    assert.ok(
      out.includes(`loom-home: ${override}`),
      `Expected loom-home line to show override '${override}':\n${out}`
    );
    // Must not show the default sibling path
    const defaultPath = resolveLoomHomePath(realRepo, {});
    assert.ok(
      !out.includes(`loom-home: ${defaultPath}`),
      `Must not show default sibling path '${defaultPath}' when override is set:\n${out}`
    );
  });

  it('[AC3] reflects tilde-expanded policy.loom_home override', () => {
    fs.writeFileSync(
      path.join(repo, '.loom', 'policy.yaml'),
      `version: 1\nloom_home: ~/my-loom-home\n`
    );
    // Use resolveLoomHomePath to derive the expected path so we pin the same function under test.
    const expectedPath = resolveLoomHomePath(realRepo, { loom_home: '~/my-loom-home' });
    const out = captureStatus({ projectRoot: realRepo });
    assert.ok(
      out.includes(`loom-home: ${expectedPath}`),
      `Expected tilde-expanded path '${expectedPath}' in output:\n${out}`
    );
  });

  it('[AC4] appends "will be created on first use" note when loom-home does not exist', () => {
    // Use a loom_home override pointing to a path that is guaranteed not to exist.
    const nonExistentPath = path.join(repo, 'nonexistent-loom-home-dir');
    assert.ok(!fs.existsSync(nonExistentPath), 'Pre-condition: must not exist');
    fs.writeFileSync(
      path.join(repo, '.loom', 'policy.yaml'),
      `version: 1\nloom_home: ${nonExistentPath}\n`
    );
    const out = captureStatus({ projectRoot: realRepo });
    assert.ok(
      out.includes('will be created on first use'),
      `Expected "will be created on first use" note when loom-home is absent:\n${out}`
    );
    assert.ok(
      out.includes(nonExistentPath),
      `Expected the nonexistent path to appear in output:\n${out}`
    );
  });

  it('[AC5] no "will be created" note when loom-home directory exists', () => {
    const override = fs.mkdtempSync(path.join(os.tmpdir(), 'existing-loom-home-'));
    try {
      fs.writeFileSync(
        path.join(repo, '.loom', 'policy.yaml'),
        `version: 1\nloom_home: ${override}\n`
      );
      const out = captureStatus({ projectRoot: realRepo });
      assert.ok(
        !out.includes('will be created on first use'),
        `Must NOT show "will be created" note when loom-home already exists:\n${out}`
      );
    } finally {
      fs.rmSync(override, { recursive: true, force: true });
    }
  });

  it('[AC1] loom-home line appears before the epic/story tree', () => {
    fs.writeFileSync(path.join(repo, '.loom', 'policy.yaml'), 'version: 1\n');
    const out = captureStatus({ projectRoot: realRepo });
    const homeIdx = out.indexOf('loom-home:');
    // The "No epics found" line (or epic tree) should come after the loom-home line.
    const treeIdx = out.indexOf('No epics found');
    if (treeIdx !== -1) {
      assert.ok(
        homeIdx < treeIdx,
        `loom-home line (idx ${homeIdx}) must appear before epic tree (idx ${treeIdx}):\n${out}`
      );
    }
    assert.ok(homeIdx !== -1, `loom-home line must be present in output:\n${out}`);
  });

  it('[regression] no crash when policy.yaml is absent', () => {
    // Do not write policy.yaml — status must tolerate a missing file and use the default heuristic.
    const out = captureStatus({ projectRoot: realRepo });
    const expected = resolveLoomHomePath(realRepo, {});
    assert.ok(
      out.includes(`loom-home: ${expected}`),
      `Expected default loom-home path when policy.yaml is absent:\n${out}`
    );
  });
});

describe('loom status --json — loom-home field (additive)', () => {
  it('[AC6] --json output includes loom_home field with resolved path', () => {
    fs.writeFileSync(path.join(repo, '.loom', 'policy.yaml'), 'version: 1\n');
    const expected = resolveLoomHomePath(realRepo, {});
    const out = captureStatus({ json: true, projectRoot: realRepo });
    const payload = JSON.parse(out) as { epics: unknown[]; loom_home?: string };
    assert.equal(
      payload.loom_home,
      expected,
      `JSON payload.loom_home must equal '${expected}', got '${payload.loom_home}'`
    );
  });

  it('[AC6] --json loom_home reflects policy.loom_home override', () => {
    const override = path.join(os.tmpdir(), 'json-loom-home-override');
    fs.writeFileSync(
      path.join(repo, '.loom', 'policy.yaml'),
      `version: 1\nloom_home: ${override}\n`
    );
    const out = captureStatus({ json: true, projectRoot: realRepo });
    const payload = JSON.parse(out) as { epics: unknown[]; loom_home?: string };
    assert.equal(
      payload.loom_home,
      override,
      `JSON loom_home must reflect override '${override}', got '${payload.loom_home}'`
    );
  });

  it('[AC7] --json output still contains epics array (backward compat)', () => {
    fs.writeFileSync(path.join(repo, '.loom', 'policy.yaml'), 'version: 1\n');
    const out = captureStatus({ json: true, projectRoot: realRepo });
    const payload = JSON.parse(out) as { epics: unknown[] };
    assert.ok(
      Array.isArray(payload.epics),
      `JSON payload must still have epics array:\n${out}`
    );
  });

  it('[regression] --all --json does not include loom_home field', () => {
    // --all mode deliberately omits per-project loom_home to avoid ambiguity.
    const out = captureStatus({ all: true, json: true });
    const payload = JSON.parse(out) as Record<string, unknown>;
    assert.ok(
      !('loom_home' in payload),
      `JSON payload must NOT include loom_home in --all mode:\n${out}`
    );
  });
});
