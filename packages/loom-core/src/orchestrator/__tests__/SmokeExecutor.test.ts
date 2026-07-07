import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runSmoke } from '../SmokeExecutor.js';
import type { CommandRunner } from '../SmokeExecutor.js';

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'loom-smoke-exec-'));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('runSmoke — pass scenario', () => {
  it('exit 0 → exitCode=0, timeoutKilled=false, durationSeconds>=0', async () => {
    const result = await runSmoke({
      command:        "node -e 'process.exit(0)'",
      worktreeCwd:    os.tmpdir(),
      timeoutMinutes: 1,
    });

    assert.equal(result.exitCode, 0);
    assert.equal(result.timeoutKilled, false);
    assert.ok(result.durationSeconds >= 0, 'durationSeconds must be non-negative');
    assert.equal(result.command, "node -e 'process.exit(0)'");
  });
});

describe('runSmoke — non-zero exit scenario', () => {
  it('exit 42 → exitCode=42, timeoutKilled=false', async () => {
    const result = await runSmoke({
      command:        "node -e 'process.exit(42)'",
      worktreeCwd:    os.tmpdir(),
      timeoutMinutes: 1,
    });

    assert.equal(result.exitCode, 42);
    assert.equal(result.timeoutKilled, false);
  });
});

describe('runSmoke — timeout-kill scenario', () => {
  it('long-running command killed after 0.01 min → timeoutKilled=true, PID no longer alive', async () => {
    const pidFile = path.join(tmpDir, 'smoke-pid.txt');
    process.env.SMOKE_EXEC_PID_FILE = pidFile;

    const started = Date.now();
    const result = await runSmoke({
      command:        "node -e 'require(\"fs\").writeFileSync(process.env.SMOKE_EXEC_PID_FILE, String(process.pid)); setTimeout(()=>{},60000)'",
      worktreeCwd:    tmpDir,
      timeoutMinutes: 0.01,
    });
    const elapsed = Date.now() - started;

    delete process.env.SMOKE_EXEC_PID_FILE;

    assert.equal(result.timeoutKilled, true);
    assert.ok(elapsed < 3000, `should complete within 3s, took ${elapsed}ms`);

    const pid = parseInt(fs.readFileSync(pidFile, 'utf8').trim(), 10);
    let alive = false;
    try {
      process.kill(pid, 0);
      alive = true;
    } catch {
      // ESRCH — process is gone, which is expected
    }
    assert.equal(alive, false, `PID ${pid} should be dead after SIGKILL`);
  });
});

describe('runSmoke — cwd isolation', () => {
  it('command runs in worktreeCwd, not process.cwd()', async () => {
    const markerFile = 'smoke-cwd-marker.txt';
    const result = await runSmoke({
      command:        `node -e 'require("fs").writeFileSync("${markerFile}", "1")'`,
      worktreeCwd:    tmpDir,
      timeoutMinutes: 1,
    });

    assert.equal(result.exitCode, 0);
    assert.ok(
      fs.existsSync(path.join(tmpDir, markerFile)),
      'marker must be created inside worktreeCwd',
    );
    assert.ok(
      !fs.existsSync(path.join(process.cwd(), markerFile)),
      'marker must NOT be in process.cwd()',
    );
  });
});

describe('runSmoke — env inheritance', () => {
  it('child process inherits parent env vars', async () => {
    process.env.TEST_SMOKE_TOKEN = 'abc';

    const result = await runSmoke({
      command:        "node -e 'process.exit(process.env.TEST_SMOKE_TOKEN === \"abc\" ? 0 : 99)'",
      worktreeCwd:    os.tmpdir(),
      timeoutMinutes: 1,
    });

    delete process.env.TEST_SMOKE_TOKEN;

    assert.equal(result.exitCode, 0, 'exitCode 0 means env var was inherited correctly');
  });
});

describe('runSmoke — never throws', () => {
  it('runner that throws synchronously → returns SmokeResult instead of propagating', async () => {
    const throwingRunner: CommandRunner = (_cmd, _cwd, _timeoutMs) => {
      throw new Error('runner exploded synchronously');
    };

    const result = await runSmoke({
      command:        'irrelevant',
      worktreeCwd:    os.tmpdir(),
      timeoutMinutes: 1,
      runner:         throwingRunner,
    });

    assert.equal(typeof result, 'object');
    assert.equal(result.exitCode, 1);
    assert.equal(result.timeoutKilled, false);
    assert.ok(result.durationSeconds >= 0);
  });

  it('runner that rejects → returns SmokeResult instead of propagating', async () => {
    const rejectingRunner: CommandRunner = (_cmd, _cwd, _timeoutMs) =>
      Promise.reject(new Error('runner rejected'));

    const result = await runSmoke({
      command:        'irrelevant',
      worktreeCwd:    os.tmpdir(),
      timeoutMinutes: 1,
      runner:         rejectingRunner,
    });

    assert.equal(result.exitCode, 1);
    assert.equal(result.timeoutKilled, false);
  });
});
