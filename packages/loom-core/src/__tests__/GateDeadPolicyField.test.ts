import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { checkDeadPolicyFields } from '../orchestrator/GateDeadPolicyField.js';
import { runFinalizeGates } from '../orchestrator/FinalizeGates.js';

// Static schema fixture location: .md fixtures are not emitted into dist by tsc,
// so resolve them from the src tree.
const FIXTURE_SCHEMA = path.resolve(
  __dirname,
  '../../src/__tests__/fixtures/dead-field/schema.yaml'
);

// Minimal policy schema YAML with fake_knob and live_knob agents fields.
const SCHEMA_YAML = `
$schema: "http://json-schema.org/draft-07/schema#"
type: object
properties:
  agents:
    type: object
    properties:
      fake_knob:
        type: string
        description: "Fictional knob — never read in production"
      live_knob:
        type: string
        description: "Fictional knob — read in at least one production file"
`.trimStart();

// Single-field schema with only fake_knob.
const SCHEMA_YAML_SINGLE = `
$schema: "http://json-schema.org/draft-07/schema#"
type: object
properties:
  agents:
    type: object
    properties:
      fake_knob:
        type: string
        description: "Fictional knob"
`.trimStart();

// ── helpers ──────────────────────────────────────────────────────────────────

function writeTmpSchema(dir: string, content: string): string {
  const schemaDir = path.join(dir, 'schemas');
  fs.mkdirSync(schemaDir, { recursive: true });
  const schemaPath = path.join(schemaDir, 'policy.schema.yaml');
  fs.writeFileSync(schemaPath, content);
  return schemaPath;
}

function writeTsSrc(dir: string, relPath: string, content: string): void {
  const abs = path.join(dir, relPath);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content);
}

// ── checkDeadPolicyFields unit tests ─────────────────────────────────────────

describe('checkDeadPolicyFields', () => {
  let tmpDir: string;
  let schemaPath: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'loom-dpf-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  // ── FR-13 scenario (a): dead field is flagged ────────────────────────────

  it('(scenario a) flags a field with zero production reads', () => {
    schemaPath = writeTmpSchema(tmpDir, SCHEMA_YAML_SINGLE);
    // No source files at all — fake_knob has zero reads.

    const result = checkDeadPolicyFields({ schemaPath, projectRoot: tmpDir });

    assert.equal(result.findings.length, 1, 'exactly one dead-field finding');
    assert.equal(result.findings[0].field, 'fake_knob');
    assert.ok(
      result.findings[0].reason.includes('defined in agents schema'),
      'reason must mention schema'
    );
  });

  // ── FR-13 scenario (b): production-read field is NOT flagged ─────────────

  it('(scenario b) does not flag a field that has a production read via dot access', () => {
    schemaPath = writeTmpSchema(tmpDir, SCHEMA_YAML_SINGLE);
    writeTsSrc(tmpDir, 'src/config.ts', 'const v = policy.agents.fake_knob;\n');

    const result = checkDeadPolicyFields({ schemaPath, projectRoot: tmpDir });

    assert.deepEqual(result.findings, [], 'no findings when field is read in production');
  });

  it('(scenario b) does not flag a field read via bracket notation with double quotes', () => {
    schemaPath = writeTmpSchema(tmpDir, SCHEMA_YAML_SINGLE);
    writeTsSrc(tmpDir, 'src/config.ts', 'const v = policy.agents["fake_knob"];\n');

    const result = checkDeadPolicyFields({ schemaPath, projectRoot: tmpDir });

    assert.deepEqual(result.findings, [], 'bracket double-quote access counts as production read');
  });

  it('(scenario b) does not flag a field read via bracket notation with single quotes', () => {
    schemaPath = writeTmpSchema(tmpDir, SCHEMA_YAML_SINGLE);
    writeTsSrc(tmpDir, 'src/config.ts', "const v = policy.agents['fake_knob'];\n");

    const result = checkDeadPolicyFields({ schemaPath, projectRoot: tmpDir });

    assert.deepEqual(result.findings, [], "bracket single-quote access counts as production read");
  });

  // ── Test-file reads do NOT count ─────────────────────────────────────────

  it('test-file reads in __tests__/ do not suppress a dead-field finding', () => {
    schemaPath = writeTmpSchema(tmpDir, SCHEMA_YAML_SINGLE);
    // Read only inside a __tests__ directory — should not count.
    writeTsSrc(tmpDir, 'src/__tests__/config.test.ts', 'const v = policy.agents.fake_knob;\n');

    const result = checkDeadPolicyFields({ schemaPath, projectRoot: tmpDir });

    assert.equal(result.findings.length, 1, '__tests__/ read must not suppress the finding');
    assert.equal(result.findings[0].field, 'fake_knob');
  });

  it('test-file reads in *.test.ts do not suppress a dead-field finding', () => {
    schemaPath = writeTmpSchema(tmpDir, SCHEMA_YAML_SINGLE);
    writeTsSrc(tmpDir, 'src/config.test.ts', 'const v = policy.agents.fake_knob;\n');

    const result = checkDeadPolicyFields({ schemaPath, projectRoot: tmpDir });

    assert.equal(result.findings.length, 1, '*.test.ts read must not suppress the finding');
  });

  it('test-file reads in *.spec.ts do not suppress a dead-field finding', () => {
    schemaPath = writeTmpSchema(tmpDir, SCHEMA_YAML_SINGLE);
    writeTsSrc(tmpDir, 'src/config.spec.ts', 'const v = policy.agents.fake_knob;\n');

    const result = checkDeadPolicyFields({ schemaPath, projectRoot: tmpDir });

    assert.equal(result.findings.length, 1, '*.spec.ts read must not suppress the finding');
  });

  it('test-file reads in fixtures/ do not suppress a dead-field finding', () => {
    schemaPath = writeTmpSchema(tmpDir, SCHEMA_YAML_SINGLE);
    writeTsSrc(tmpDir, 'src/fixtures/thing.ts', 'const v = policy.agents.fake_knob;\n');

    const result = checkDeadPolicyFields({ schemaPath, projectRoot: tmpDir });

    assert.equal(result.findings.length, 1, 'fixtures/ read must not suppress the finding');
  });

  // ── Multiple fields: one dead, one with a production read ────────────────

  it('with multiple fields, only the dead one appears in findings', () => {
    schemaPath = writeTmpSchema(tmpDir, SCHEMA_YAML);
    // Only live_knob is read in production.
    writeTsSrc(tmpDir, 'src/config.ts', 'const v = policy.agents.live_knob;\n');

    const result = checkDeadPolicyFields({ schemaPath, projectRoot: tmpDir });

    assert.equal(result.findings.length, 1, 'exactly one dead finding');
    assert.equal(result.findings[0].field, 'fake_knob', 'fake_knob must be the dead field');
    const deadFields = result.findings.map(f => f.field);
    assert.ok(!deadFields.includes('live_knob'), 'live_knob must not appear in findings');
  });

  it('no findings when all fields have a production read', () => {
    schemaPath = writeTmpSchema(tmpDir, SCHEMA_YAML);
    writeTsSrc(tmpDir, 'src/config.ts', [
      'const a = policy.agents.fake_knob;',
      'const b = policy.agents.live_knob;',
    ].join('\n'));

    const result = checkDeadPolicyFields({ schemaPath, projectRoot: tmpDir });

    assert.deepEqual(result.findings, [], 'no findings when both fields are read');
  });

  // ── Grep pattern tightness: bare word occurrence must not suppress finding ─

  it('bare word occurrence in comment does not suppress dead-field finding', () => {
    schemaPath = writeTmpSchema(tmpDir, SCHEMA_YAML_SINGLE);
    // fake_knob appears as a bare word in a comment — NOT a property access.
    writeTsSrc(tmpDir, 'src/config.ts', '// fake_knob is deprecated and will be removed\n');

    const result = checkDeadPolicyFields({ schemaPath, projectRoot: tmpDir });

    assert.equal(result.findings.length, 1, 'bare word comment must NOT suppress the finding');
    assert.equal(result.findings[0].field, 'fake_knob');
  });

  it('bare word in string literal does not suppress dead-field finding', () => {
    schemaPath = writeTmpSchema(tmpDir, SCHEMA_YAML_SINGLE);
    writeTsSrc(tmpDir, 'src/config.ts', 'const msg = "fake_knob is not supported";\n');

    const result = checkDeadPolicyFields({ schemaPath, projectRoot: tmpDir });

    assert.equal(result.findings.length, 1, 'bare string occurrence must NOT suppress the finding');
  });

  // ── scannedFields lists every field from the agents section ──────────────

  it('scannedFields lists every field from the schema agents section', () => {
    schemaPath = writeTmpSchema(tmpDir, SCHEMA_YAML);

    const result = checkDeadPolicyFields({ schemaPath, projectRoot: tmpDir });

    assert.ok(result.scannedFields.includes('fake_knob'), 'fake_knob must be in scannedFields');
    assert.ok(result.scannedFields.includes('live_knob'), 'live_knob must be in scannedFields');
    assert.equal(result.scannedFields.length, 2, 'exactly two fields in the test schema');
  });

  it('scannedFields is empty when schema has no agents section', () => {
    schemaPath = writeTmpSchema(tmpDir, '{"type":"object","properties":{}}\n');

    const result = checkDeadPolicyFields({ schemaPath, projectRoot: tmpDir });

    assert.deepEqual(result.scannedFields, []);
    assert.deepEqual(result.findings, []);
  });

  // ── durationMs is a non-negative number ──────────────────────────────────

  it('durationMs is a non-negative number', () => {
    schemaPath = writeTmpSchema(tmpDir, SCHEMA_YAML_SINGLE);

    const result = checkDeadPolicyFields({ schemaPath, projectRoot: tmpDir });

    assert.ok(typeof result.durationMs === 'number', 'durationMs must be a number');
    assert.ok(result.durationMs >= 0, 'durationMs must be non-negative');
  });

  // ── Missing / invalid schema returns empty ────────────────────────────────

  it('returns empty result when schemaPath does not exist', () => {
    const result = checkDeadPolicyFields({
      schemaPath: path.join(tmpDir, 'nonexistent.yaml'),
      projectRoot: tmpDir,
    });

    assert.deepEqual(result.findings, []);
    assert.deepEqual(result.scannedFields, []);
    assert.ok(result.durationMs >= 0);
  });

  // ── Static fixture smoke ──────────────────────────────────────────────────

  it('parses the static dead-field fixture schema correctly', () => {
    // Smoke test that the committed fixture file is a valid schema.
    const result = checkDeadPolicyFields({
      schemaPath: FIXTURE_SCHEMA,
      projectRoot: tmpDir,
    });

    assert.ok(result.scannedFields.includes('fake_knob'), 'fixture schema must define fake_knob');
    assert.ok(result.scannedFields.includes('live_knob'), 'fixture schema must define live_knob');
  });
});

// ── runFinalizeGates wiring tests ─────────────────────────────────────────────

describe('runFinalizeGates — dead-field gate wiring', () => {
  let tmpDir: string;
  let warnMessages: string[];
  const originalWarn = console.warn;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'loom-fg-dpf-'));
    warnMessages = [];
    console.warn = (...args: unknown[]) => {
      warnMessages.push(args.map(String).join(' '));
    };
  });

  afterEach(() => {
    console.warn = originalWarn;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function writeSchema(fields: string[]): void {
    const props = fields.map(f => `      ${f}:\n        type: string`).join('\n');
    const yaml = [
      '$schema: "http://json-schema.org/draft-07/schema#"',
      'type: object',
      'properties:',
      '  agents:',
      '    type: object',
      '    properties:',
      props,
    ].join('\n');
    fs.mkdirSync(path.join(tmpDir, 'schemas'), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, 'schemas', 'policy.schema.yaml'), yaml + '\n');
  }

  async function runGates(mode: 'off' | 'warn' | 'block') {
    return runFinalizeGates({
      contractRoot: tmpDir,
      treeRoot: tmpDir,
      headRef: 'HEAD',
      baseRef: 'HEAD',
      epicId: 'epic-test',
      epicDiff: '',
      mode,
      deliveredEpicIds: [],
    });
  }

  it('dead field in schema + no production read → deadFields.findings is non-empty', async () => {
    writeSchema(['fake_knob']);
    // No production source file reads fake_knob.

    const result = await runGates('warn');

    assert.ok(result.deadFields.findings.length > 0, 'dead field must appear in findings');
    assert.equal(result.deadFields.findings[0].field, 'fake_knob');
  });

  it('mode=block with dead field → hardFail=true', async () => {
    writeSchema(['fake_knob']);

    const result = await runGates('block');

    assert.ok(result.deadFields.findings.length > 0, 'finding must be non-empty');
    assert.equal(result.hardFail, true, 'block mode with dead field must set hardFail=true');
  });

  it('mode=warn with dead field → hardFail=false', async () => {
    writeSchema(['fake_knob']);

    const result = await runGates('warn');

    assert.equal(result.hardFail, false, 'warn mode must not set hardFail');
  });

  it('field with production read → deadFields.findings is empty, hardFail unaffected', async () => {
    writeSchema(['fake_knob']);
    // Write a production read so the field is live.
    fs.mkdirSync(path.join(tmpDir, 'src'), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, 'src', 'config.ts'), 'const v = p.agents.fake_knob;\n');

    const result = await runGates('block');

    assert.deepEqual(result.deadFields.findings, [], 'live field must produce no dead-field finding');
    assert.equal(result.hardFail, false, 'hardFail must not be set by this gate alone');
  });

  it('mode=off → deadFields.findings is empty regardless of schema', async () => {
    writeSchema(['fake_knob']);

    const result = await runGates('off');

    assert.deepEqual(result.deadFields.findings, [], 'mode=off must skip the gate');
    assert.equal(result.hardFail, false);
  });

  it('dead field triggers console.warn naming the field', async () => {
    writeSchema(['fake_knob']);

    await runGates('warn');

    const deadWarn = warnMessages.some(m => m.includes('fake_knob') && m.includes('[finalize]'));
    assert.ok(deadWarn, 'a console.warn naming the dead field must be emitted');
  });

  it('noCallers is always populated (stub returns empty)', async () => {
    writeSchema(['fake_knob']);

    const result = await runGates('warn');

    assert.ok('noCallers' in result, 'result must have noCallers field');
    assert.ok(Array.isArray(result.noCallers.findings), 'noCallers.findings must be an array');
  });
});
