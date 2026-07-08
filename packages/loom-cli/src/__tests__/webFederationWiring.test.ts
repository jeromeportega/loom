import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runWeb } from '../commands/web.js';
import type { CreateAppOptions } from '@loom-ai/web';

// Regression guard for the epic-085 federation defect: runWeb must BUILD the
// unified registry and PASS it to createApp. The original bug was that runWeb
// called createApp without a unifiedRegistry, so every consumer silently fell
// back to the single machine registry and the federated repo list was dead —
// while all 51 registry tests passed because they injected the registry by hand.
//
// This test drives the REAL runWeb→createApp composition (a spy that CAPTURES the
// opts, not a mock that discards them) and asserts a repo registered under the
// active loom_home actually reaches createApp.

describe('runWeb — federation wiring (epic-085 regression)', () => {
  let activeHome: string;
  let prevLoomHome: string | undefined;

  beforeEach(() => {
    activeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'loom-active-home-'));
    // A repo registered ONLY in the active loom_home — must surface via the union.
    fs.writeFileSync(
      path.join(activeHome, 'projects.json'),
      JSON.stringify({ projects: [{ root: '/federated/repo-x', registeredAt: '2020-01-01T00:00:00Z' }] })
    );
    prevLoomHome = process.env.LOOM_HOME;
    process.env.LOOM_HOME = activeHome; // active loom_home leg (highest precedence)
  });

  afterEach(() => {
    if (prevLoomHome === undefined) delete process.env.LOOM_HOME;
    else process.env.LOOM_HOME = prevLoomHome;
    fs.rmSync(activeHome, { recursive: true, force: true });
  });

  it('builds a unifiedRegistry and passes it to createApp with the active-home repo', async () => {
    let captured: CreateAppOptions | undefined;
    await runWeb(
      { noOpen: true },
      {
        // No current project — exercises the launch-from-anywhere path too.
        _resolveWebRoot: () => null,
        // Capture (do not discard) what runWeb passes — the seam the bug lived in.
        _createApp: (o: CreateAppOptions) => {
          captured = o;
          return {} as never;
        },
        _listen: async () => 0,
      } as never
    );

    assert.ok(captured, 'createApp was invoked');
    assert.ok(
      captured!.unifiedRegistry instanceof Map,
      'runWeb must build and pass a unifiedRegistry (was undefined in the defect)'
    );
    assert.ok(
      [...captured!.unifiedRegistry!.keys()].includes('/federated/repo-x'),
      'a repo registered only under the active loom_home must appear in the unified registry'
    );
  });
});
