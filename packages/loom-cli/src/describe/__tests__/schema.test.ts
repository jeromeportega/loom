import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import {
  CommandDescriptionSchema,
  PositionalArgSchema,
  OptionFlagSchema,
  WorkflowSchema,
  ManifestSchema,
} from '../schema.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeCompleteSpec(): z.infer<typeof CommandDescriptionSchema> {
  return {
    name: 'status',
    summary: 'Show the current state of all epics and stories',
    whenToUse: 'Use to check which stories are running, blocked, or done.',
    arguments: [],
    options: [
      {
        name: '--json',
        type: 'boolean',
        description: 'Emit machine-readable JSON',
        changesOutputShape: true,
      },
    ],
    output: {
      text: 'Human-readable table of epics and stories',
      json: { supported: true, shape: '{ epics: Epic[] }' },
    },
    examples: [
      { command: 'loom status', description: 'Show all epics in table form' },
      { command: 'loom status --json', description: 'Emit JSON payload' },
    ],
    exitCodes: [
      { code: 0, meaning: 'Success' },
      { code: 1, meaning: 'No loom project found' },
    ],
    errors: ['No .loom directory found — run loom init first'],
    relationships: { prerequisites: ['init'], nextSteps: ['run', 'approve'] },
  };
}

// ---------------------------------------------------------------------------
// CommandDescriptionSchema — happy path
// ---------------------------------------------------------------------------

describe('CommandDescriptionSchema — complete spec passes', () => {
  it('accepts a fully populated spec', () => {
    const result = CommandDescriptionSchema.safeParse(makeCompleteSpec());
    assert.equal(result.success, true, JSON.stringify(!result.success && result.error));
  });

  it('relationships defaults to empty arrays when omitted', () => {
    const spec = makeCompleteSpec();
    const { relationships: _r, ...rest } = spec;
    void _r;
    const result = CommandDescriptionSchema.safeParse(rest);
    assert.equal(result.success, true);
    if (result.success) {
      assert.deepEqual(result.data.relationships, { prerequisites: [], nextSteps: [] });
    }
  });
});

// ---------------------------------------------------------------------------
// CommandDescriptionSchema — examples constraint (min 1)
// ---------------------------------------------------------------------------

describe('CommandDescriptionSchema — examples must be non-empty', () => {
  it('fails when examples is an empty array', () => {
    const result = CommandDescriptionSchema.safeParse({ ...makeCompleteSpec(), examples: [] });
    assert.equal(result.success, false);
    if (!result.success) {
      const msg = result.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('\n');
      assert.match(msg, /examples/, 'error path must mention examples');
    }
  });

  it('fails when examples key is absent', () => {
    const spec = makeCompleteSpec();
    const { examples: _e, ...rest } = spec;
    void _e;
    const result = CommandDescriptionSchema.safeParse(rest);
    assert.equal(result.success, false);
  });
});

// ---------------------------------------------------------------------------
// CommandDescriptionSchema — exitCodes constraint (min 1)
// ---------------------------------------------------------------------------

describe('CommandDescriptionSchema — exitCodes must be non-empty', () => {
  it('fails when exitCodes is an empty array', () => {
    const result = CommandDescriptionSchema.safeParse({ ...makeCompleteSpec(), exitCodes: [] });
    assert.equal(result.success, false);
    if (!result.success) {
      const msg = result.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('\n');
      assert.match(msg, /exitCodes/, 'error path must mention exitCodes');
    }
  });

  it('fails when exitCodes key is absent', () => {
    const spec = makeCompleteSpec();
    const { exitCodes: _ec, ...rest } = spec;
    void _ec;
    const result = CommandDescriptionSchema.safeParse(rest);
    assert.equal(result.success, false);
  });
});

// ---------------------------------------------------------------------------
// CommandDescriptionSchema — summary boundary (5–100 chars)
// ---------------------------------------------------------------------------

describe('CommandDescriptionSchema — summary boundaries', () => {
  it('fails when summary is shorter than 5 chars', () => {
    const result = CommandDescriptionSchema.safeParse({ ...makeCompleteSpec(), summary: 'Run' });
    assert.equal(result.success, false);
  });

  it('fails when summary is longer than 100 chars', () => {
    const long = 'a'.repeat(101);
    const result = CommandDescriptionSchema.safeParse({ ...makeCompleteSpec(), summary: long });
    assert.equal(result.success, false);
  });

  it('passes when summary is exactly 5 chars', () => {
    const result = CommandDescriptionSchema.safeParse({ ...makeCompleteSpec(), summary: 'abcde' });
    assert.equal(result.success, true);
  });

  it('passes when summary is exactly 100 chars', () => {
    const result = CommandDescriptionSchema.safeParse({
      ...makeCompleteSpec(),
      summary: 'a'.repeat(100),
    });
    assert.equal(result.success, true);
  });
});

// ---------------------------------------------------------------------------
// OptionFlagSchema — name regex and changesOutputShape
// ---------------------------------------------------------------------------

describe('OptionFlagSchema — name regex', () => {
  function validFlag() {
    return { name: '--json', type: 'boolean' as const, description: 'Emit JSON', changesOutputShape: true };
  }

  it('passes --json', () => {
    assert.equal(OptionFlagSchema.safeParse(validFlag()).success, true);
  });

  it('passes --epic', () => {
    assert.equal(OptionFlagSchema.safeParse({ ...validFlag(), name: '--epic' }).success, true);
  });

  it('passes --epic-id', () => {
    assert.equal(OptionFlagSchema.safeParse({ ...validFlag(), name: '--epic-id' }).success, true);
  });

  it('fails -j (short flag)', () => {
    assert.equal(OptionFlagSchema.safeParse({ ...validFlag(), name: '-j' }).success, false);
  });

  it('fails json (no dashes)', () => {
    assert.equal(OptionFlagSchema.safeParse({ ...validFlag(), name: 'json' }).success, false);
  });

  it('fails --Bad (uppercase)', () => {
    assert.equal(OptionFlagSchema.safeParse({ ...validFlag(), name: '--Bad' }).success, false);
  });

  it('fails when changesOutputShape is omitted', () => {
    const { changesOutputShape: _c, ...rest } = validFlag();
    void _c;
    assert.equal(OptionFlagSchema.safeParse(rest).success, false);
  });
});

// ---------------------------------------------------------------------------
// PositionalArgSchema — enum type carries values; non-enum omits
// ---------------------------------------------------------------------------

describe('PositionalArgSchema — enum/values invariant', () => {
  const base = { name: 'format', required: false, description: 'Output format' };

  it('enum type with values passes', () => {
    const result = PositionalArgSchema.safeParse({ ...base, type: 'enum', values: ['json', 'text'] });
    assert.equal(result.success, true);
  });

  it('enum type without values fails', () => {
    const result = PositionalArgSchema.safeParse({ ...base, type: 'enum' });
    assert.equal(result.success, false);
  });

  it('enum type with empty values fails', () => {
    const result = PositionalArgSchema.safeParse({ ...base, type: 'enum', values: [] });
    assert.equal(result.success, false);
  });

  it('string type without values passes', () => {
    const result = PositionalArgSchema.safeParse({ ...base, type: 'string' });
    assert.equal(result.success, true);
  });

  it('string type with values fails (values only for enum)', () => {
    const result = PositionalArgSchema.safeParse({ ...base, type: 'string', values: ['a'] });
    assert.equal(result.success, false);
  });
});

// ---------------------------------------------------------------------------
// WorkflowSchema
// ---------------------------------------------------------------------------

describe('WorkflowSchema', () => {
  function validWorkflow() {
    return {
      id: 'plan',
      goal: 'Plan and approve an epic from a brief',
      steps: [
        { command: 'epic', why: 'Runs the planning personas to produce the epic' },
        { command: 'approve', why: 'Operator approves the plan before dispatch' },
      ],
    };
  }

  it('accepts a valid workflow', () => {
    assert.equal(WorkflowSchema.safeParse(validWorkflow()).success, true);
  });

  it('id regex: plan passes', () => {
    assert.equal(WorkflowSchema.safeParse(validWorkflow()).success, true);
  });

  it('id regex: Plan fails (uppercase)', () => {
    const result = WorkflowSchema.safeParse({ ...validWorkflow(), id: 'Plan' });
    assert.equal(result.success, false);
  });

  it('id regex: 1plan fails (starts with digit)', () => {
    const result = WorkflowSchema.safeParse({ ...validWorkflow(), id: '1plan' });
    assert.equal(result.success, false);
  });

  it('id regex: approve-all passes (hyphen allowed)', () => {
    const result = WorkflowSchema.safeParse({ ...validWorkflow(), id: 'approve-all' });
    assert.equal(result.success, true);
  });

  it('fails when steps is empty', () => {
    const result = WorkflowSchema.safeParse({ ...validWorkflow(), steps: [] });
    assert.equal(result.success, false);
  });
});

// ---------------------------------------------------------------------------
// ManifestSchema
// ---------------------------------------------------------------------------

describe('ManifestSchema', () => {
  function validManifest(): z.infer<typeof ManifestSchema> {
    return {
      loomVersion: '5.0.0',
      source: 'live-commander-registry',
      commands: [makeCompleteSpec()],
      workflows: [
        {
          id: 'plan',
          goal: 'Plan an epic',
          steps: [{ command: 'epic', why: 'Runs planners' }],
        },
      ],
    };
  }

  it('accepts a valid manifest', () => {
    assert.equal(ManifestSchema.safeParse(validManifest()).success, true);
  });

  it('fails when commands is empty', () => {
    const result = ManifestSchema.safeParse({ ...validManifest(), commands: [] });
    assert.equal(result.success, false);
  });

  it('fails when workflows is empty', () => {
    const result = ManifestSchema.safeParse({ ...validManifest(), workflows: [] });
    assert.equal(result.success, false);
  });

  it('fails when source is not the literal value', () => {
    const result = ManifestSchema.safeParse({ ...validManifest(), source: 'manual' });
    assert.equal(result.success, false);
  });
});

// ---------------------------------------------------------------------------
// ZodError formatting — PMAgent.ts:140 pattern
// ---------------------------------------------------------------------------

describe('ZodError formatting — path-qualified messages', () => {
  it('a spec missing examples yields a path-qualified error message', () => {
    const spec = makeCompleteSpec();
    const { examples: _e, ...rest } = spec;
    void _e;
    const result = CommandDescriptionSchema.safeParse(rest);
    assert.equal(result.success, false);
    if (!result.success) {
      const formatted = result.error.issues
        .map((i) => `${i.path.join('.')}: ${i.message}`)
        .join('\n');
      assert.ok(
        formatted.includes('examples'),
        `Expected path-qualified message to contain 'examples', got: ${formatted}`
      );
    }
  });

  it('a spec missing exitCodes yields a path-qualified error mentioning exitCodes', () => {
    const spec = makeCompleteSpec();
    const { exitCodes: _ec, ...rest } = spec;
    void _ec;
    const result = CommandDescriptionSchema.safeParse(rest);
    assert.equal(result.success, false);
    if (!result.success) {
      const formatted = result.error.issues
        .map((i) => `${i.path.join('.')}: ${i.message}`)
        .join('\n');
      assert.ok(
        formatted.includes('exitCodes'),
        `Expected path-qualified message to contain 'exitCodes', got: ${formatted}`
      );
    }
  });

  it('empty examples array: formatted error contains path + array length message', () => {
    const result = CommandDescriptionSchema.safeParse({ ...makeCompleteSpec(), examples: [] });
    assert.equal(result.success, false);
    if (!result.success) {
      const formatted = result.error.issues
        .map((i) => `${i.path.join('.')}: ${i.message}`)
        .join('\n');
      assert.match(formatted, /examples/);
      // The message should explain the constraint, not just the path
      assert.match(formatted, /1/);
    }
  });
});

// ---------------------------------------------------------------------------
// YAML mirror exists with the correct header
// ---------------------------------------------------------------------------

describe('YAML mirror — schemas/cli-description.schema.yaml', () => {
  // __dirname at runtime: dist/describe/__tests__ — 5 levels up reaches repo root
  const SCHEMA_PATH = path.resolve(
    __dirname,
    '../../../../../schemas/cli-description.schema.yaml'
  );

  it('the file exists', () => {
    assert.ok(fs.existsSync(SCHEMA_PATH), `Expected ${SCHEMA_PATH} to exist`);
  });

  it('starts with the convention header identifying zod as source of truth', () => {
    const content = fs.readFileSync(SCHEMA_PATH, 'utf8');
    assert.match(content, /zod/, 'header must mention zod as source of truth');
    assert.match(content, /source of truth/, 'header must use the phrase "source of truth"');
  });

  it('declares draft-07 schema URI', () => {
    const content = fs.readFileSync(SCHEMA_PATH, 'utf8');
    assert.match(content, /draft-07/, 'must declare JSON Schema draft-07');
  });
});
