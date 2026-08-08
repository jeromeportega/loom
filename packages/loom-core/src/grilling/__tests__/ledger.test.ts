import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { persistLedger } from '../ledger.js';
import type { ResolvedDecision } from '../types.js';

function tmpLoomDir(): string {
  return mkdtempSync(path.join(tmpdir(), 'grilling-ledger-'));
}

const ONE_OF_EACH: ResolvedDecision[] = [
  { id: 'd1', text: 'A', blast_radius: 'high', answer: 'yes', tag: 'user-decided' },
  { id: 'd2', text: 'B', blast_radius: 'low', answer: 'rec', tag: 'user-accepted-recommendation' },
  { id: 'd3', text: 'C', blast_radius: 'low', answer: 'def', tag: 'auto-default' },
  { id: 'd4', text: 'D', blast_radius: 'high', answer: 'exists', tag: 'fact-cited', citation: 'src/x.ts:5' },
  { id: 'd5', text: 'E', blast_radius: 'high', answer: 'unknown', tag: 'fact-uncited' },
];

describe('persistLedger', () => {
  it('creates .loom/grilling/<runId>/ledger.md with a GFM table', async () => {
    const dir = tmpLoomDir();
    await persistLedger('run-1', ONE_OF_EACH, dir);
    const file = path.join(dir, 'grilling', 'run-1', 'ledger.md');
    assert.ok(existsSync(file));
    const body = readFileSync(file, 'utf8');
    assert.match(body, /\| Decision \| Blast \| Answer \| Tag \| Citation \|/);
    assert.match(body, /\| --- \| --- \| --- \| --- \| --- \|/);
  });

  it('renders all five provenance tags, citation only where present', async () => {
    const dir = tmpLoomDir();
    await persistLedger('run-2', ONE_OF_EACH, dir);
    const body = readFileSync(path.join(dir, 'grilling', 'run-2', 'ledger.md'), 'utf8');
    for (const tag of ['user-decided', 'user-accepted-recommendation', 'auto-default', 'fact-cited', 'fact-uncited']) {
      assert.ok(body.includes(tag), `missing tag ${tag}`);
    }
    // The citation appears exactly once — only in the fact-cited row.
    assert.equal((body.match(/src\/x\.ts:5/g) ?? []).length, 1);
    // A non-fact row's Citation cell is empty (renders as an empty padded cell).
    assert.match(body, /\| user-decided \|\s+\|/);
  });

  it('creates the file even when decisions is empty (cancelled-before-answer)', async () => {
    const dir = tmpLoomDir();
    await persistLedger('run-empty', [], dir);
    const file = path.join(dir, 'grilling', 'run-empty', 'ledger.md');
    assert.ok(existsSync(file));
    assert.match(readFileSync(file, 'utf8'), /\| Decision \| Blast/);
  });

  it('creates parent dirs recursively and overwrites on retry', async () => {
    const dir = tmpLoomDir();
    await persistLedger('run-3', ONE_OF_EACH, dir);
    await persistLedger('run-3', [ONE_OF_EACH[0]], dir); // overwrite with fewer rows
    const body = readFileSync(path.join(dir, 'grilling', 'run-3', 'ledger.md'), 'utf8');
    assert.ok(body.includes('user-decided'));
    assert.ok(!body.includes('auto-default'), 'overwrite must drop prior rows');
  });

  it('escapes pipe and newline in cell content so the table stays valid', async () => {
    const dir = tmpLoomDir();
    await persistLedger('run-4', [
      { id: 'x', text: 'a | b', blast_radius: 'low', answer: 'line1\nline2', tag: 'user-decided' },
    ], dir);
    const body = readFileSync(path.join(dir, 'grilling', 'run-4', 'ledger.md'), 'utf8');
    assert.ok(body.includes('a \\| b'), 'pipe must be escaped');
    assert.ok(!body.includes('line1\nline2'), 'newline in a cell must be flattened');
    assert.ok(body.includes('line1 line2'));
  });
});
