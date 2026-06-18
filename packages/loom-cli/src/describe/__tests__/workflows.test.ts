import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { WorkflowSchema } from '../schema.js';
import { WORKFLOWS } from '../workflows.js';

// Known CLI command names registered in packages/loom-cli/src/index.ts.
// Verified by reading every .command('...') call in index.ts — update this set
// if commands are added or removed. This is a one-way allow-list: every workflow
// step command must be a member, but not every member need appear in a workflow.
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
    // indexOf returns the first occurrence — assumes each of epic/approve/run
    // appears exactly once in the plan workflow steps.
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
    assert.ok(
      !commands.includes('run'),
      'retry workflow must not use "run"; the registered command for retrying is "retry"'
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
    const ids = WORKFLOWS.map((w) => w.id);
    assert.deepEqual(ids, [...new Set(ids)], 'Workflow IDs must be unique');
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
