/**
 * Anti-dead-code wiring proof for runtime reroute (epic-095 reroute rework).
 *
 * The original epic-095 shipped the reroute feature DARK: `run.ts` never set
 * `pmAgent`, so a LOOM_TOO_BIG / cap-killed story never reached the PM — the
 * 694-line test suite passed only because it injected PMAgent STUBS into the
 * Supervisor directly. This suite guards the PRODUCTION path: it asserts that
 * `runRun` (the only production Supervisor construction) actually constructs a
 * real `ReroutePMAgent` and threads it into both the supervisor and worker opts,
 * and that the worker prompt gains the LOOM_TOO_BIG emit block. If any of that
 * wiring is removed, this goes red — the exact test whose absence let the dead
 * code ship.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

// Assert against the SOURCE of the production entrypoint (not a stub-injected
// Supervisor), because "does this fire in production?" is a property of run.ts's
// wiring, and the dead-code bug was precisely that this wiring did not exist.
// Compiled test lives at dist/__tests__/; the production source is at src/commands/run.ts.
const RUN_TS = path.resolve(__dirname, '../../src/commands/run.ts');

describe('runtime reroute — production wiring (anti-dead-code)', () => {
  const src = fs.readFileSync(RUN_TS, 'utf8');

  it('run.ts constructs a real ReroutePMAgent', () => {
    assert.match(src, /new ReroutePMAgent\(/, 'run.ts must construct a ReroutePMAgent');
    assert.match(src, /ReroutePMAgent/, 'ReroutePMAgent must be imported');
  });

  it('run.ts threads the reroute PM into the supervisor as pmAgent', () => {
    assert.match(src, /pmAgent:\s*reroutePmAgent/, 'supervisorOpts must pass pmAgent: reroutePmAgent');
  });

  it('run.ts enables the LOOM_TOO_BIG worker prompt via rerouteEnabled', () => {
    assert.match(src, /rerouteEnabled\s*=\s*reroutePmAgent\s*!==\s*undefined/, 'rerouteEnabled derived from PM construction');
    assert.match(src, /rerouteEnabled,/, 'workerOpts must receive rerouteEnabled');
  });

  it('reroute PM construction is best-effort (does not crash the run when unavailable)', () => {
    // The construction must sit in a try/catch so a missing session degrades to
    // pre-feature behavior rather than aborting `loom run`.
    const idx = src.indexOf('new ReroutePMAgent(');
    const window = src.slice(Math.max(0, idx - 200), idx);
    assert.match(window, /try\s*\{/, 'ReroutePMAgent construction must be inside a try block');
  });
});
