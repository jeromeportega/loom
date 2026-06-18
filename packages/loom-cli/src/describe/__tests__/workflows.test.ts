import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { WorkflowSchema } from '../schema.js';
import { WORKFLOWS } from '../workflows.js';

// Known CLI command names registered in packages/loom-cli/src/index.ts.
// Dynamic import is not feasible because index.ts calls program.parse() at module
// level. Keep this set in sync manually — every .command('...') call on the top-level
// program or subcommand parents in src/index.ts lines 49-441 must be reflected here.
// Subcommand paths use space-separated form: 'guard check', 'mcp list', 'mcp add'.
// Update this set when commands are added or removed from index.ts.
// NOTE: 'mcp', 'mcp list', 'mcp add' provision org-registry MCP servers and are
// still present in v5+ (distinct from the loom MCP server removed in v5.0.0).
const KNOWN_CLI_COMMANDS = new Set([
  'doctor',
  'init',
  'guard',
  'guard check',
  'guard hook',
  'status',
  'epic',
  'approve',
  'reject',
  'archive',
  'unarchive',
  'run',
  'retry',
  'web',
  'stop',
  'guide',
  'revert',
  'reconcile',
  'diff',
  'review',
  'artifacts',
  'traces',
  'audit',
  'autonomy',
  'projects',
  'pull-guidance',
  'project',
  'mcp',
  'mcp list',
  'mcp add',
  'scan',
  'opportunities',
  'propose',
]);

const REQUIRED_WORKFLOW_IDS = ['plan', 'approve', 'run', 'status', 'retry', 'reconcile'];

// ---------------------------------------------------------------------------
// Schema validation
// ---------------------------------------------------------------------------

describe('WORKFLOWS — schema validation', () => {
  it('WORKFLOWS is a non-empty array', () => {
    assert.ok(Array.isArray(WORKFLOWS), 'WORKFLOWS must be an array');
    assert.ok(WORKFLOWS.length > 0, 'WORKFLOWS must not be empty');
  });

  it('each workflow validates against WorkflowSchema', () => {
    for (const workflow of WORKFLOWS) {
      const result = WorkflowSchema.safeParse(workflow);
      assert.ok(
        result.success,
        `Workflow "${workflow.id}" failed schema validation: ${
          !result.success
            ? result.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')
            : ''
        }`
      );
    }
  });
});

// ---------------------------------------------------------------------------
// Six-task coverage
// ---------------------------------------------------------------------------

describe('WORKFLOWS — six-task coverage', () => {
  it('contains all six required workflow ids', () => {
    const ids = new Set(WORKFLOWS.map((w) => w.id));
    for (const required of REQUIRED_WORKFLOW_IDS) {
      assert.ok(ids.has(required), `Missing required workflow id: "${required}"`);
    }
  });
});

// ---------------------------------------------------------------------------
// plan → approve → run chain
// ---------------------------------------------------------------------------

describe('WORKFLOWS — plan → approve → run chain', () => {
  it('plan workflow exists and includes epic, approve, run as ordered steps', () => {
    const planWorkflow = WORKFLOWS.find((w) => w.id === 'plan');
    assert.ok(planWorkflow, 'plan workflow must exist');

    const commands = planWorkflow.steps.map((s) => s.command);
    // Guard that no step command repeats before using indexOf for ordering.
    assert.equal(
      new Set(commands).size,
      commands.length,
      'plan workflow must not repeat step commands'
    );
    const epicIdx = commands.indexOf('epic');
    const approveIdx = commands.indexOf('approve');
    const runIdx = commands.indexOf('run');

    assert.ok(epicIdx !== -1, 'plan workflow must include an "epic" step');
    assert.ok(approveIdx !== -1, 'plan workflow must include an "approve" step');
    assert.ok(runIdx !== -1, 'plan workflow must include a "run" step');
    assert.ok(epicIdx < approveIdx, '"epic" step must come before "approve" step');
    assert.ok(approveIdx < runIdx, '"approve" step must come before "run" step');
  });
});

// ---------------------------------------------------------------------------
// Referential integrity — every workflow step command must be in KNOWN_CLI_COMMANDS
// (one-way: extra entries in KNOWN_CLI_COMMANDS that no workflow uses are harmless)
// ---------------------------------------------------------------------------

describe('WORKFLOWS — referential integrity', () => {
  it('every steps[].command is a registered CLI command name', () => {
    for (const workflow of WORKFLOWS) {
      for (const step of workflow.steps) {
        assert.ok(
          KNOWN_CLI_COMMANDS.has(step.command),
          `Workflow "${workflow.id}" step command "${step.command}" is not a registered CLI command`
        );
      }
    }
  });

  it('retry workflow uses "retry" (not "run --retry" or any other variant)', () => {
    const retryWorkflow = WORKFLOWS.find((w) => w.id === 'retry');
    assert.ok(retryWorkflow, 'retry workflow must exist');
    const commands = retryWorkflow.steps.map((s) => s.command);
    assert.ok(
      commands.includes('retry'),
      `retry workflow must use command name "retry"; got: ${JSON.stringify(commands)}`
    );
  });

  it('reconcile workflow uses "reconcile" (not "fix" or any other variant)', () => {
    const reconcileWorkflow = WORKFLOWS.find((w) => w.id === 'reconcile');
    assert.ok(reconcileWorkflow, 'reconcile workflow must exist');
    const commands = reconcileWorkflow.steps.map((s) => s.command);
    assert.ok(
      commands.includes('reconcile'),
      `reconcile workflow must use command name "reconcile"; got: ${JSON.stringify(commands)}`
    );
  });
});

// ---------------------------------------------------------------------------
// Structural invariants
// ---------------------------------------------------------------------------

describe('WORKFLOWS — structural invariants', () => {
  it('workflow IDs are unique', () => {
    const seen = new Set<string>();
    for (const w of WORKFLOWS) {
      assert.ok(!seen.has(w.id), `Duplicate workflow id: "${w.id}"`);
      seen.add(w.id);
    }
  });

  it('workflow goals are unique', () => {
    const seen = new Set<string>();
    for (const w of WORKFLOWS) {
      assert.ok(!seen.has(w.goal), `Duplicate workflow goal in "${w.id}": "${w.goal}"`);
      seen.add(w.goal);
    }
  });

  it('each workflow has at least one step', () => {
    for (const workflow of WORKFLOWS) {
      assert.ok(
        workflow.steps.length >= 1,
        `Workflow "${workflow.id}" must have at least one step`
      );
    }
  });

  it('each workflow has a non-empty goal', () => {
    for (const workflow of WORKFLOWS) {
      assert.ok(
        workflow.goal.trim().length > 0,
        `Workflow "${workflow.id}" must have a non-empty goal`
      );
    }
  });

  it('each workflow step has a non-empty why', () => {
    for (const workflow of WORKFLOWS) {
      for (const step of workflow.steps) {
        assert.ok(
          step.why.trim().length > 0,
          `Workflow "${workflow.id}" step "${step.command}" must have a non-empty why`
        );
      }
    }
  });
});
