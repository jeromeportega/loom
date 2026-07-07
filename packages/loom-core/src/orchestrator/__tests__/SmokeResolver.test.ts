import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PolicySchema } from '../../types.js';
import { resolveSmokeCommand } from '../SmokeResolver.js';

const defaultPolicy = PolicySchema.parse({});

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'loom-smoke-resolver-'));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('resolveSmokeCommand — resolution paths', () => {
  it('returns explicit smoke_command without reading package.json', async () => {
    const policy = PolicySchema.parse({ agents: { smoke_command: 'node healthcheck.js' } });
    const result = await resolveSmokeCommand(tmpDir, policy);
    assert.equal(result, 'node healthcheck.js');
  });

  it('returns "npm run smoke" when package.json has scripts.smoke', async () => {
    fs.writeFileSync(
      path.join(tmpDir, 'package.json'),
      JSON.stringify({ scripts: { smoke: 'jest --smoke' } }),
    );
    const result = await resolveSmokeCommand(tmpDir, defaultPolicy);
    assert.equal(result, 'npm run smoke');
  });

  it('returns "npm run verify" when package.json has scripts.verify but not scripts.smoke', async () => {
    fs.writeFileSync(
      path.join(tmpDir, 'package.json'),
      JSON.stringify({ scripts: { verify: 'jest' } }),
    );
    const result = await resolveSmokeCommand(tmpDir, defaultPolicy);
    assert.equal(result, 'npm run verify');
  });

  it('returns null when package.json has neither script', async () => {
    fs.writeFileSync(
      path.join(tmpDir, 'package.json'),
      JSON.stringify({ scripts: { test: 'jest' } }),
    );
    const result = await resolveSmokeCommand(tmpDir, defaultPolicy);
    assert.equal(result, null);
  });

  it('returns null when no package.json exists at project root', async () => {
    const result = await resolveSmokeCommand(tmpDir, defaultPolicy);
    assert.equal(result, null);
  });

  it('returns "npm run smoke" when package.json has both smoke and verify (smoke wins)', async () => {
    fs.writeFileSync(
      path.join(tmpDir, 'package.json'),
      JSON.stringify({ scripts: { smoke: 'jest --smoke', verify: 'jest' } }),
    );
    const result = await resolveSmokeCommand(tmpDir, defaultPolicy);
    assert.equal(result, 'npm run smoke');
  });

  it('returns policy value when smoke_command set and package.json also has scripts.smoke', async () => {
    const policy = PolicySchema.parse({ agents: { smoke_command: 'node healthcheck.js' } });
    fs.writeFileSync(
      path.join(tmpDir, 'package.json'),
      JSON.stringify({ scripts: { smoke: 'jest --smoke' } }),
    );
    const result = await resolveSmokeCommand(tmpDir, policy);
    assert.equal(result, 'node healthcheck.js');
  });
});
