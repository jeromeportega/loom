import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ProjectRegistry } from '../state/ProjectRegistry.js';

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'loom-reg-'));
}

describe('ProjectRegistry', () => {
  it('registers a repo and lists it', () => {
    const home = tmpDir();
    const repo = tmpDir();
    try {
      const reg = new ProjectRegistry({ path: path.join(home, 'projects.json') });
      reg.register(repo);
      const list = reg.list();
      assert.equal(list.length, 1);
      assert.equal(list[0].root, path.resolve(repo));
      assert.ok(list[0].registeredAt, 'records a timestamp');
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });

  it('deduplicates repeated registration', () => {
    const home = tmpDir();
    const repo = tmpDir();
    try {
      const reg = new ProjectRegistry({ path: path.join(home, 'projects.json') });
      reg.register(repo);
      reg.register(repo);
      reg.register(repo);
      assert.equal(reg.list().length, 1);
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });

  it('prunes a registered directory that no longer exists', () => {
    const home = tmpDir();
    const repo = tmpDir();
    const file = path.join(home, 'projects.json');
    try {
      new ProjectRegistry({ path: file }).register(repo);
      fs.rmSync(repo, { recursive: true, force: true });
      // The vanished directory is dropped — not fatal.
      assert.equal(new ProjectRegistry({ path: file }).list().length, 0);
      // ...and pruned from the file, so a second read also sees nothing.
      assert.equal(new ProjectRegistry({ path: file }).list().length, 0);
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it('treats a corrupt registry file as empty, not fatal', () => {
    const home = tmpDir();
    const file = path.join(home, 'projects.json');
    try {
      fs.writeFileSync(file, '{ this is not valid json');
      assert.deepEqual(new ProjectRegistry({ path: file }).list(), []);
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it('unregisters a repo', () => {
    const home = tmpDir();
    const repo = tmpDir();
    try {
      const reg = new ProjectRegistry({ path: path.join(home, 'projects.json') });
      reg.register(repo);
      reg.unregister(repo);
      assert.equal(reg.list().length, 0);
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });
});
