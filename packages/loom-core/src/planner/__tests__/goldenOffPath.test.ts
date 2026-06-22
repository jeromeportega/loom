/**
 * Golden/snapshot test: intake_routing:off path byte-identity (story-047-005).
 *
 * Proves that Planner.run() with routing:undefined (the intake_routing:off path)
 * always takes the full epic pipeline (Analyst → PM → Architect) and produces
 * YAML output byte-identical to a committed frozen reference, independent of
 * brief size. This is the proof artifact for NFR-1.
 *
 * Nondeterministic fields excluded from comparison:
 *   - DB-level timestamps (created_at, updated_at) — not in the YAML
 *   - Token/usage counts — not in the YAML
 *   - Run IDs — deterministic here because resetDatabaseForTest() ensures the
 *     first run always gets epic-001 (DB is empty → nextEpicId = epic-001)
 *
 * LLM is fully stubbed; no real calls are made.
 *
 * Coexistence proof (AC4): this test runs with the story-047-001 StorySchema
 * regex relaxation and the story-047-002 StandaloneStoryAgent already present.
 * If those changes had altered the off-path code path, the byte-identity
 * assertions below would fail.
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDatabase, resetDatabaseForTest } from '../../state/Database.js';
import { MockLLMClient } from '../../llm/MockLLMClient.js';
import type { LLMRequest } from '../../llm/LLMClient.js';
import { Planner } from '../Planner.js';
import { planningPaths } from '../paths.js';

// Snapshot committed to source tree. Written on first run; compared on every
// subsequent run. To regenerate after an intentional off-path pipeline change,
// delete this file and re-run the tests — the new output is written automatically.
const SNAPSHOT_FILE = path.resolve(
  __dirname,
  '../../../src/planner/__tests__/__snapshots__/off-path-epic-yaml.snap'
);

// ── Fixed mock LLM responses (routing:undefined → Analyst → PM → Architect) ───

const ANALYST_BRIEF_RESP =
  '# Auth Project\n\n## The Problem\nUsers cannot authenticate.';
const PM_PRD_RESP =
  '# Auth PRD\n\n## Goals\nShip a login system.\n\n## Functional Requirements\nFR-1: users can log in.';
const ARCH_DOC_RESP =
  '# Auth Architecture\n\n## Architecture Philosophy\nFavor simplicity.';

function makeEpicsResp(epicId: string): string {
  const num = epicId.slice(5);
  return (
    '```json\n' +
    JSON.stringify({
      epics: [
        {
          epic_id: epicId,
          title: 'Authentication epic',
          priority: 'must-have',
          prd_ref: 'placeholder',
          requirements: ['FR-1'],
          stories: [
            {
              id: `story-${num}-001`,
              title: 'Login form',
              description: 'Implement login form with email and password.',
              acceptance_criteria: ['Form renders', 'Submit sends credentials'],
              estimated_complexity: 'small',
              dependencies: [],
            },
            {
              id: `story-${num}-002`,
              title: 'Auth service',
              description: 'Implement backend authentication service.',
              acceptance_criteria: ['Service validates credentials'],
              estimated_complexity: 'medium',
              dependencies: [`story-${num}-001`],
            },
          ],
        },
      ],
    }) +
    '\n```'
  );
}

function makeTechNotesResp(userMsg: string): string {
  const ids = [...userMsg.matchAll(/"id":\s*"(story-[\d-]+)"/g)].map((m) => m[1]);
  const notes: Record<string, string> = {};
  for (const id of ids) notes[id] = `Tech notes for ${id}: use the auth module.`;
  return '```json\n' + JSON.stringify({ tech_notes: notes }) + '\n```';
}

function offPathResponder(req: LLMRequest): string {
  const last = req.messages[req.messages.length - 1].content;
  if (last.includes('brief to analyze') || last.includes('Produce the project brief document')) {
    return ANALYST_BRIEF_RESP;
  }
  if (last.includes('Headless task A: produce the PRD')) return PM_PRD_RESP;
  if (last.includes('Headless task B: produce the epic')) {
    const m = last.match(/starting at "(epic-\d+)"/);
    return makeEpicsResp(m?.[1] ?? 'epic-001');
  }
  if (last.includes('Headless task A: produce the architecture')) return ARCH_DOC_RESP;
  if (last.includes('Headless task B: produce per-story')) return makeTechNotesResp(last);
  throw new Error(`[goldenOffPath] Unexpected LLM message: ${last.slice(0, 80)}`);
}

/** Read the final epic YAML written by the Planner for a given run. */
function readEpicYaml(projectRoot: string, runId: string): string {
  return fs.readFileSync(planningPaths(projectRoot, runId).epicFile(runId), 'utf8');
}

/** Run Planner.run() with routing:undefined in a clean, isolated environment. */
async function runOffPath(brief: string): Promise<{
  runId: string;
  yamlContent: string;
  projectRoot: string;
}> {
  resetDatabaseForTest();
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'loom-golden-off-'));
  const db = openDatabase(path.join(tmpDir, '.loom'));
  const result = await new Planner({
    projectRoot: tmpDir,
    llm: new MockLLMClient(offPathResponder),
    model: 'mock-model',
    db,
    // routing is intentionally absent — this is the intake_routing:off path
  }).run(brief);
  const yamlContent = readEpicYaml(tmpDir, result.runId);
  return { runId: result.runId, yamlContent, projectRoot: tmpDir };
}

/** Load the snapshot, writing it on first run. */
function loadOrWriteSnapshot(content: string): string {
  if (!fs.existsSync(SNAPSHOT_FILE)) {
    fs.mkdirSync(path.dirname(SNAPSHOT_FILE), { recursive: true });
    fs.writeFileSync(SNAPSHOT_FILE, content, 'utf8');
  }
  return fs.readFileSync(SNAPSHOT_FILE, 'utf8');
}

// ── Brief fixtures (story-sized vs epic-sized) ─────────────────────────────────

const SHORT_BRIEF = 'Add login form with email and password fields.';

const LONG_BRIEF = [
  '# Authentication System Brief',
  '',
  'We need a complete authentication system for our web application.',
  'This includes a login form, password reset, and session management.',
  'The system must integrate with our existing user database.',
  'Security requirements: rate limiting, CSRF protection, bcrypt hashing.',
  'Priority: must-have for Q1 release. Target: 1 engineer, 2-week sprint.',
].join('\n');

// ── Test suite ─────────────────────────────────────────────────────────────────

describe('Golden/snapshot — intake_routing:off path byte-identity (story-047-005)', () => {
  let shortRun: Awaited<ReturnType<typeof runOffPath>>;
  let longRun: Awaited<ReturnType<typeof runOffPath>>;
  let snapshotRef: string;

  before(async () => {
    // Each call to runOffPath resets the DB, so both get epic-001 as runId.
    shortRun = await runOffPath(SHORT_BRIEF);
    longRun = await runOffPath(LONG_BRIEF);
    // Establish (or load) the frozen reference using the short-brief output.
    snapshotRef = loadOrWriteSnapshot(shortRun.yamlContent);
  });

  after(() => {
    resetDatabaseForTest();
    fs.rmSync(shortRun.projectRoot, { recursive: true, force: true });
    fs.rmSync(longRun.projectRoot, { recursive: true, force: true });
  });

  // ── AC1/AC2: byte-identity ─────────────────────────────────────────────────

  it('[byte-identity] short brief off-path YAML matches frozen reference (AC1)', () => {
    assert.equal(
      shortRun.yamlContent,
      snapshotRef,
      'off-path YAML (short brief) differs from snapshot. ' +
        'Delete off-path-epic-yaml.snap and re-run to regenerate after an intentional change.'
    );
  });

  it('[byte-identity] epic-sized brief off-path YAML matches same frozen reference (AC1, size-independence)', () => {
    // routing:undefined routes BOTH sizes through the same full epic pipeline.
    // With the mock returning identical responses, both produce identical YAML —
    // proving that brief size is irrelevant on the off-path.
    assert.equal(
      longRun.yamlContent,
      snapshotRef,
      'off-path YAML (epic-sized brief) differs from snapshot — ' +
        'size must not affect the off-path pipeline'
    );
  });

  it('[byte-identity] short and epic-sized briefs produce identical YAML (size-independence proof)', () => {
    assert.equal(
      shortRun.yamlContent,
      longRun.yamlContent,
      'off-path output must be byte-identical regardless of brief size'
    );
  });

  // ── AC3: determinism ────────────────────────────────────────────────────────

  it('[determinism] a second independent run produces the same YAML as the snapshot (AC3)', async () => {
    const thirdRun = await runOffPath(SHORT_BRIEF);
    try {
      assert.equal(
        thirdRun.yamlContent,
        snapshotRef,
        'off-path must be deterministic — repeated runs must match the snapshot'
      );
    } finally {
      resetDatabaseForTest();
      fs.rmSync(thirdRun.projectRoot, { recursive: true, force: true });
    }
  });

  // ── Drift trip-wire ─────────────────────────────────────────────────────────

  it('[drift] altered off-path output is detected (trip-wire sanity check)', async () => {
    // Prove the assertion bites: a deliberately different PM output must produce
    // YAML that does NOT match the snapshot.
    resetDatabaseForTest();
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'loom-golden-drift-'));
    try {
      const db = openDatabase(path.join(tmpDir, '.loom'));

      const driftResponder = (req: LLMRequest): string => {
        const last = req.messages[req.messages.length - 1].content;
        if (
          last.includes('brief to analyze') ||
          last.includes('Produce the project brief document')
        ) {
          return ANALYST_BRIEF_RESP;
        }
        if (last.includes('Headless task A: produce the PRD')) return PM_PRD_RESP;
        if (last.includes('Headless task B: produce the epic')) {
          const m = last.match(/starting at "(epic-\d+)"/);
          const epicId = m?.[1] ?? 'epic-001';
          const num = epicId.slice(5);
          // DELIBERATE CHANGE: different title triggers drift detection
          return (
            '```json\n' +
            JSON.stringify({
              epics: [
                {
                  epic_id: epicId,
                  title: 'DRIFT TITLE — intentional mismatch for trip-wire',
                  priority: 'must-have',
                  prd_ref: 'placeholder',
                  requirements: ['FR-1'],
                  stories: [
                    {
                      id: `story-${num}-001`,
                      title: 'Only story',
                      description: 'Altered output.',
                      acceptance_criteria: ['differs'],
                      estimated_complexity: 'small',
                      dependencies: [],
                    },
                  ],
                },
              ],
            }) +
            '\n```'
          );
        }
        if (last.includes('Headless task A: produce the architecture')) return ARCH_DOC_RESP;
        if (last.includes('Headless task B: produce per-story')) return makeTechNotesResp(last);
        throw new Error(`[drift] Unexpected message: ${last.slice(0, 80)}`);
      };

      const result = await new Planner({
        projectRoot: tmpDir,
        llm: new MockLLMClient(driftResponder),
        model: 'mock-model',
        db,
      }).run(SHORT_BRIEF);

      const driftYaml = readEpicYaml(tmpDir, result.runId);

      assert.notEqual(
        driftYaml,
        snapshotRef,
        'drift trip-wire failed: deliberately altered output unexpectedly matched the snapshot'
      );
    } finally {
      resetDatabaseForTest();
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  // ── AC4: coexistence ────────────────────────────────────────────────────────

  it('[coexistence] off-path YAML contains no standalone markers (AC4)', () => {
    // story-047-001 added STANDALONE_KIND='standalone' and story-047-002 added
    // StandaloneStoryAgent. Neither must affect the off-path (routing:undefined).
    assert.ok(
      !snapshotRef.includes('standalone'),
      'off-path reference YAML must not contain any standalone markers'
    );
    assert.ok(
      !shortRun.yamlContent.includes('standalone'),
      'off-path YAML (short brief) must not contain standalone markers'
    );
  });

  it('[coexistence] off-path runId is a normal epic-NNN id, not a story-NNN id (AC4)', () => {
    // Standalone path produces story-NNN as the surfaced id; off-path must not.
    assert.ok(
      shortRun.runId.startsWith('epic-'),
      `off-path runId must be epic-NNN, got: ${shortRun.runId}`
    );
    assert.ok(
      longRun.runId.startsWith('epic-'),
      `off-path runId must be epic-NNN, got: ${longRun.runId}`
    );
  });
});
