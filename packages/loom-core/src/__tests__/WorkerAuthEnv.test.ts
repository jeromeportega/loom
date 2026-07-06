import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { ClaudeCodeWorker } from '../orchestrator/ClaudeCodeWorker.js';

/**
 * Exposes the protected `workerEnv()` so we can assert the auth-stripping
 * behaviour of policy.agents.worker_auth without spawning a real CLI.
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
class TestableWorker extends ClaudeCodeWorker {
  exposeWorkerEnv(): NodeJS.ProcessEnv {
    return (this as any).workerEnv();
  }
}
/* eslint-enable @typescript-eslint/no-explicit-any */

describe('worker spawn env — policy.agents.worker_auth', () => {
  const priorKey = process.env.ANTHROPIC_API_KEY;
  const priorToken = process.env.ANTHROPIC_AUTH_TOKEN;

  beforeEach(() => {
    process.env.ANTHROPIC_API_KEY = 'sk-test-credits-key';
    process.env.ANTHROPIC_AUTH_TOKEN = 'tok-test';
  });

  afterEach(() => {
    if (priorKey === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = priorKey;
    if (priorToken === undefined) delete process.env.ANTHROPIC_AUTH_TOKEN;
    else process.env.ANTHROPIC_AUTH_TOKEN = priorToken;
  });

  it("'session' strips ANTHROPIC_API_KEY and ANTHROPIC_AUTH_TOKEN from the worker env", () => {
    const env = new TestableWorker({ workerAuth: 'session' }).exposeWorkerEnv();
    assert.equal(env.ANTHROPIC_API_KEY, undefined);
    assert.equal(env.ANTHROPIC_AUTH_TOKEN, undefined);
    // Other env is preserved so the worker still finds PATH etc.
    assert.equal(env.PATH, process.env.PATH);
    // The parent process keeps its key (we strip a copy, not the live env).
    assert.equal(process.env.ANTHROPIC_API_KEY, 'sk-test-credits-key');
  });

  it("'inherit' (default) leaves the API key in place", () => {
    const env = new TestableWorker().exposeWorkerEnv();
    assert.equal(env.ANTHROPIC_API_KEY, 'sk-test-credits-key');
    assert.equal(env.ANTHROPIC_AUTH_TOKEN, 'tok-test');
  });

  it("explicit 'inherit' returns a copy with LOOM_WORKER_CONTEXT injected (not process.env itself)", () => {
    const env = new TestableWorker({ workerAuth: 'inherit' }).exposeWorkerEnv();
    // story-075-005: workerEnv() always returns a copy so LOOM_WORKER_CONTEXT can
    // be injected without mutating the parent process.env.
    assert.notEqual(env, process.env, 'must return a copy, not the live process.env reference');
    assert.equal(env.LOOM_WORKER_CONTEXT, '1', 'copy must carry the worker context marker');
    // Original env is unmodified.
    assert.equal(process.env.LOOM_WORKER_CONTEXT, undefined, 'process.env must not be mutated');
  });
});
