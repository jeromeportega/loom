/**
 * CLI parity test — story-002-006
 *
 * Pins the pre-removal mcp__loom tool inventory as a literal list and asserts
 * each of the 23 tools maps to a real CLI command. This test IS the parity
 * oracle: it fails loudly when a mapping is missing, wrong, or a command
 * module disappears.
 *
 * Design intent (negative guard): CLI_MAPPING must remain exhaustive over
 * MCP_INVENTORY. Removing a CLI command or deleting a command module will
 * cause this test to fail at load time (missing import) or at assertion time
 * (missing/wrong mapping entry). Neither failure mode is silent.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

// ─── Phase-1 command imports — must exist post-build ─────────────────────────
import { runPullGuidance } from '../commands/pullGuidance.js';
import { runProject } from '../commands/project.js';
import { runStop } from '../commands/stop.js';
import { runPropose } from '../commands/propose.js';
import { runScanCommand } from '../commands/scan.js';
import { runStatus } from '../commands/status.js';

// ─── Remaining command imports (full 23-tool coverage) ────────────────────────
import { runGuardCheck } from '../commands/guard.js';
import { runAudit } from '../commands/audit.js';
import { runEpic } from '../commands/epic.js';
import { runApprove, runReject } from '../commands/gate.js';
import { runGuide } from '../commands/guide.js';
import { runRevert } from '../commands/revert.js';
import { runReconcile } from '../commands/reconcile.js';
import { runArchive } from '../commands/archive.js';
import { runRetry } from '../commands/retry.js';
import { runTraces } from '../commands/traces.js';
import { runDiff } from '../commands/diff.js';
import { runArtifacts } from '../commands/artifacts.js';
import { runReview } from '../commands/review.js';
import { runProjects } from '../commands/projects.js';
import { runAutonomy } from '../commands/autonomy.js';

// ─── Pre-removal mcp__loom inventory — literal, never derived ─────────────────
// This list is the source of truth for "no capability lost" across the
// epic-002 CLI parity port. It must NOT be read from the live registry file —
// it must be a hardcoded snapshot so that a renamed or removed tool fails the
// test rather than silently disappearing from coverage.
const MCP_INVENTORY: readonly string[] = [
  'loom_policy_check',
  'loom_get_status',
  'loom_get_audit_log',
  'loom_start_epic',
  'loom_approve_plan',
  'loom_reject_plan',
  'loom_stop_agent',
  'loom_stop_epic',
  'loom_guide_agent',
  'loom_pull_guidance',
  'loom_revert_epic',
  'loom_reconcile_epic',
  'loom_archive_epic',
  'loom_retry_story',
  'loom_get_decision_traces',
  'loom_get_diff',
  'loom_get_planning_artifacts',
  'loom_get_review',
  'loom_list_projects',
  'loom_get_project',
  'loom_scan_signals',
  'loom_propose',
  'loom_set_autonomy',
] as const;

// ─── Full CLI mapping ─────────────────────────────────────────────────────────
// Maps every mcp__loom tool to its canonical `loom` CLI invocation.
// MUST remain exhaustive over MCP_INVENTORY — a missing entry is caught by the
// parity assertions below (the intended negative guard).
const CLI_MAPPING: Record<string, string> = {
  loom_policy_check:           'loom guard check --command <cmd>',
  loom_get_status:             'loom status --project <root>',
  loom_get_audit_log:          'loom audit',
  loom_start_epic:             'loom epic <brief>',
  loom_approve_plan:           'loom approve <epic-id>',
  loom_reject_plan:            'loom reject <epic-id>',
  loom_stop_agent:             'loom stop <story-id>',
  loom_stop_epic:              'loom stop --epic <epic-id>',
  loom_guide_agent:            'loom guide <story-id> [message]',
  loom_pull_guidance:          'loom pull-guidance <story-id>',
  loom_revert_epic:            'loom revert <epic-id>',
  loom_reconcile_epic:         'loom reconcile <epic-id>',
  loom_archive_epic:           'loom archive <epic-id>',
  loom_retry_story:            'loom retry <story-id>',
  loom_get_decision_traces:    'loom traces',
  loom_get_diff:               'loom diff <id>',
  loom_get_planning_artifacts: 'loom artifacts <epic-id>',
  loom_get_review:             'loom review <story-id>',
  loom_list_projects:          'loom projects',
  loom_get_project:            'loom project <project-root>',
  loom_scan_signals:           'loom scan --project <root>',
  loom_propose:                'loom propose',
  loom_set_autonomy:           'loom autonomy <epic-id> <level>',
};

// ─── Phase-1 oracle ───────────────────────────────────────────────────────────
// Canonical mapping for the seven capabilities ported in epic-002. Each entry
// must exactly match the corresponding CLI_MAPPING entry — divergence means a
// Phase-1 capability regressed.
const PHASE1_ORACLE: Record<string, string> = {
  loom_pull_guidance: 'loom pull-guidance <story-id>',
  loom_get_project:   'loom project <project-root>',
  loom_stop_epic:     'loom stop --epic <epic-id>',
  loom_propose:       'loom propose',
  loom_scan_signals:  'loom scan --project <root>',
  loom_get_status:    'loom status --project <root>',
  loom_stop_agent:    'loom stop <story-id>',
};

// ─── CLI function registry ────────────────────────────────────────────────────
// Maps each mcp__loom tool to the TypeScript function that implements its CLI
// equivalent. If a command module is deleted or its export renamed, the import
// at the top of this file fails at load time — the intended loud failure.
// Tools that share one CLI command (stop_agent + stop_epic → runStop) share
// the same function reference; the options differ at call time.
const CLI_FUNCTIONS: Record<string, unknown> = {
  loom_policy_check:           runGuardCheck,
  loom_get_status:             runStatus,
  loom_get_audit_log:          runAudit,
  loom_start_epic:             runEpic,
  loom_approve_plan:           runApprove,
  loom_reject_plan:            runReject,
  loom_stop_agent:             runStop,
  loom_stop_epic:              runStop,
  loom_guide_agent:            runGuide,
  loom_pull_guidance:          runPullGuidance,
  loom_revert_epic:            runRevert,
  loom_reconcile_epic:         runReconcile,
  loom_archive_epic:           runArchive,
  loom_retry_story:            runRetry,
  loom_get_decision_traces:    runTraces,
  loom_get_diff:               runDiff,
  loom_get_planning_artifacts: runArtifacts,
  loom_get_review:             runReview,
  loom_list_projects:          runProjects,
  loom_get_project:            runProject,
  loom_scan_signals:           runScanCommand,
  loom_propose:                runPropose,
  loom_set_autonomy:           runAutonomy,
};

describe('CLI parity: pre-removal mcp__loom inventory', () => {
  it('inventory contains exactly 23 tools', () => {
    assert.equal(MCP_INVENTORY.length, 23);
  });

  it('mapping table is exhaustive over the full 23-tool inventory', () => {
    // Forward check: every inventory tool has a mapping.
    for (const tool of MCP_INVENTORY) {
      assert.ok(
        CLI_MAPPING[tool] !== undefined,
        `mcp__loom tool '${tool}' has no CLI mapping — add it to CLI_MAPPING`
      );
    }
    // Backward check: no extra entries in the mapping table.
    // If CLI_MAPPING has more entries than MCP_INVENTORY, a tool was invented
    // outside the canonical inventory — also a failure.
    const mappedCount = Object.keys(CLI_MAPPING).length;
    assert.equal(
      mappedCount,
      MCP_INVENTORY.length,
      `CLI_MAPPING has ${mappedCount} entries but MCP_INVENTORY has ${MCP_INVENTORY.length} — they must match exactly`
    );
  });

  it('every CLI mapping entry is a non-empty string starting with "loom "', () => {
    for (const [tool, cmd] of Object.entries(CLI_MAPPING)) {
      assert.ok(
        typeof cmd === 'string' && cmd.startsWith('loom '),
        `CLI_MAPPING['${tool}'] = '${String(cmd)}' — expected a string starting with 'loom '`
      );
    }
  });

  it('Phase-1 oracle contains exactly 7 entries', () => {
    assert.equal(Object.keys(PHASE1_ORACLE).length, 7);
  });

  it('all 7 Phase-1 capabilities map to their canonical CLI command', () => {
    for (const [tool, expectedCmd] of Object.entries(PHASE1_ORACLE)) {
      assert.equal(
        CLI_MAPPING[tool],
        expectedCmd,
        `Phase-1 mapping mismatch for '${tool}': expected '${expectedCmd}', got '${CLI_MAPPING[tool]}'`
      );
    }
  });

  it('every mcp__loom tool maps to an existing CLI command function', () => {
    // If any import at the top of this file failed (deleted/renamed module),
    // the test file itself fails to load — the ultimate loud failure.
    // This assertion is the runtime companion: it catches the case where the
    // import still resolves (e.g. a re-export shim) but the real function is gone.
    for (const tool of MCP_INVENTORY) {
      const fn = CLI_FUNCTIONS[tool];
      assert.equal(
        typeof fn,
        'function',
        `CLI_FUNCTIONS['${tool}'] is not a function — the backing CLI command may have been removed or renamed`
      );
    }
  });
});
