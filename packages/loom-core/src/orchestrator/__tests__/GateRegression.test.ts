import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { checkCrossEpicRegressions } from '../GateRegression.js';
import { runFinalizeGates } from '../FinalizeGates.js';
import { SharedContract } from '../SharedContract.js';
import { openDatabase, resetDatabaseForTest } from '../../state/Database.js';
import { EpicStore } from '../../state/EpicStore.js';

// ─── story-077-004 — GateRegression unit tests ───────────────────────────────

// ── checkCrossEpicRegressions — core behaviour ───────────────────────────────

describe('checkCrossEpicRegressions', () => {
  it('returns [] when priorContracts is empty', () => {
    const result = checkCrossEpicRegressions({
      epicDiff: '-export interface UserRecord { id: string; }',
      storyDiffs: new Map(),
      priorContracts: new Map(),
    });
    assert.deepEqual(result, []);
  });

  it('returns [] when no diffs are provided (epicDiff and storyDiffs both empty)', () => {
    const result = checkCrossEpicRegressions({
      epicDiff: '',
      storyDiffs: new Map(),
      priorContracts: new Map([['epic-001', ['UserRecord']]]),
    });
    assert.deepEqual(result, []);
  });

  it('regression found: epicDiff removes a prior-contract symbol', () => {
    const result = checkCrossEpicRegressions({
      epicDiff: [
        '--- a/models.ts',
        '+++ b/models.ts',
        '-export interface UserRecord { id: string; }',
        '+// deleted in this epic',
      ].join('\n'),
      storyDiffs: new Map(),
      priorContracts: new Map([['epic-A', ['UserRecord']]]),
    });
    assert.equal(result.length, 1, 'one finding expected');
    assert.equal(result[0].symbol, 'UserRecord');
    assert.equal(result[0].priorEpicId, 'epic-A');
    assert.ok(result[0].lineSnippet.includes('UserRecord'), 'lineSnippet must reference the removed line');
  });

  it('no regression: epicDiff only adds or modifies the prior symbol', () => {
    const result = checkCrossEpicRegressions({
      epicDiff: [
        '--- a/models.ts',
        '+++ b/models.ts',
        '+export interface UserRecord { id: string; email: string; }',
      ].join('\n'),
      storyDiffs: new Map(),
      priorContracts: new Map([['epic-A', ['UserRecord']]]),
    });
    assert.deepEqual(result, [], 'adding the symbol must not produce a regression finding');
  });

  it('no regression: symbol appears only in + lines of a story diff', () => {
    const result = checkCrossEpicRegressions({
      epicDiff: '',
      storyDiffs: new Map([
        ['story-001', '+export function UserRecord(): UserRecord { return {} as UserRecord; }'],
      ]),
      priorContracts: new Map([['epic-A', ['UserRecord']]]),
    });
    assert.deepEqual(result, [], 'symbol in added lines only must not produce a finding');
  });

  it('regression found: story diff removes a prior-contract symbol', () => {
    const diff = [
      '--- a/models.ts',
      '+++ b/models.ts',
      '-export interface UserRecord { id: string; }',
      '+// removed for refactor',
    ].join('\n');
    const result = checkCrossEpicRegressions({
      epicDiff: '',
      storyDiffs: new Map([['story-007', diff]]),
      priorContracts: new Map([['epic-A', ['UserRecord']]]),
    });
    assert.equal(result.length, 1);
    assert.equal(result[0].symbol, 'UserRecord');
    assert.equal(result[0].priorEpicId, 'epic-A');
    assert.equal(result[0].storyId, 'story-007');
    assert.ok(result[0].lineSnippet.includes('UserRecord'));
  });

  it('multiple prior epics: only the epic-A finding is returned when epic-B has no regression', () => {
    const removedDiff = [
      '-export interface UserRecord { id: string; }',
      '+// renamed',
    ].join('\n');
    const result = checkCrossEpicRegressions({
      epicDiff: '',
      storyDiffs: new Map([['story-001', removedDiff]]),
      priorContracts: new Map([
        ['epic-A', ['UserRecord']],   // removed → regression
        ['epic-B', ['PaymentRecord']], // not in diff → no regression
      ]),
    });
    assert.equal(result.length, 1, 'only one finding expected');
    assert.equal(result[0].priorEpicId, 'epic-A');
    assert.equal(result[0].symbol, 'UserRecord');
  });

  it('word-boundary: removing AuthToken does not match prior symbol Token', () => {
    const diff = [
      '--- a/auth.ts',
      '+++ b/auth.ts',
      '-export class AuthToken implements AuthTokenBase {}',
      '+export class SessionToken {}',
    ].join('\n');
    const result = checkCrossEpicRegressions({
      epicDiff: '',
      storyDiffs: new Map([['story-001', diff]]),
      priorContracts: new Map([['epic-A', ['Token']]]),
    });
    assert.deepEqual(result, [], 'AuthToken substring must not match bare Token');
  });

  it('word-boundary: prior symbol Token does match a line that removes Token exactly', () => {
    const diff = [
      '-export interface Token { id: string; }',
      '+// deleted in refactor',
    ].join('\n');
    const result = checkCrossEpicRegressions({
      epicDiff: '',
      storyDiffs: new Map([['story-001', diff]]),
      priorContracts: new Map([['epic-A', ['Token']]]),
    });
    assert.equal(result.length, 1, 'bare Token removal must produce a finding');
    assert.equal(result[0].symbol, 'Token');
  });

  it('no regression when symbol survives in context lines after its definition is removed', () => {
    const diff = [
      '--- a/models.ts',
      '+++ b/models.ts',
      '-export interface UserRecord { id: string; }',
      '+// definition moved to shared',
      ' const u: UserRecord = load();',  // context line — symbol survives
    ].join('\n');
    const result = checkCrossEpicRegressions({
      epicDiff: '',
      storyDiffs: new Map([['story-001', diff]]),
      priorContracts: new Map([['epic-A', ['UserRecord']]]),
    });
    assert.deepEqual(result, [], 'symbol in context lines must suppress the regression finding');
  });
});

// ── runFinalizeGates — regression gate policy wiring ─────────────────────────

describe('runFinalizeGates — regression gate policy modes', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'loom-rg-policy-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function makePriorContract(epicId: string, symbol: string): void {
    SharedContract.write(
      tmpDir,
      epicId,
      `\`\`\`typescript\nexport interface ${symbol} { id: string; }\n\`\`\``
    );
  }

  function makeRegressionStoryDiffs(symbol: string): Map<string, string> {
    return new Map([
      [
        'story-001',
        [
          `--- a/models.ts`,
          `+++ b/models.ts`,
          `-export interface ${symbol} { id: string; }`,
          `+// removed`,
        ].join('\n'),
      ],
    ]);
  }

  it('mode=off: returns [] regressions and hardFail=false even with a real regression', async () => {
    makePriorContract('prior-epic', 'UserRecord');
    const result = await runFinalizeGates({
      projectRoot: tmpDir,
      epicId: 'current-epic',
      epicDiff: '',
      storyDiffs: makeRegressionStoryDiffs('UserRecord'),
      mode: 'off',
      deliveredEpicIds: ['prior-epic'],
    });
    assert.deepEqual(result.regressions, []);
    assert.equal(result.hardFail, false);
  });

  it('mode=warn with regression: regressions returned but hardFail=false', async () => {
    makePriorContract('prior-epic', 'UserRecord');
    const result = await runFinalizeGates({
      projectRoot: tmpDir,
      epicId: 'current-epic',
      epicDiff: '',
      storyDiffs: makeRegressionStoryDiffs('UserRecord'),
      mode: 'warn',
      deliveredEpicIds: ['prior-epic'],
    });
    assert.ok(result.regressions.length > 0, 'warn mode must return regression findings');
    assert.equal(result.regressions[0].symbol, 'UserRecord');
    assert.equal(result.regressions[0].priorEpicId, 'prior-epic');
    assert.equal(result.hardFail, false, 'warn mode must not set hardFail');
  });

  it('mode=block with regression: regressions returned and hardFail=true', async () => {
    makePriorContract('prior-epic', 'UserRecord');
    const result = await runFinalizeGates({
      projectRoot: tmpDir,
      epicId: 'current-epic',
      epicDiff: '',
      storyDiffs: makeRegressionStoryDiffs('UserRecord'),
      mode: 'block',
      deliveredEpicIds: ['prior-epic'],
    });
    assert.ok(result.regressions.length > 0, 'block mode must return findings');
    assert.equal(result.hardFail, true, 'block mode with findings must set hardFail=true');
  });

  it('mode=block with no regression: hardFail=false', async () => {
    makePriorContract('prior-epic', 'UserRecord');
    // Story adds UserRecord rather than removing it — no regression.
    const cleanDiffs = new Map([['story-001', '+const u: UserRecord = load();']]);
    const result = await runFinalizeGates({
      projectRoot: tmpDir,
      epicId: 'current-epic',
      epicDiff: '',
      storyDiffs: cleanDiffs,
      mode: 'block',
      deliveredEpicIds: ['prior-epic'],
    });
    assert.deepEqual(result.regressions, []);
    assert.equal(result.hardFail, false, 'block mode with no findings must not set hardFail');
  });
});

// ── Integration smoke: EpicStore.listByStatus('done') filters in-flight epics ─

describe('EpicStore.listByStatus("done") — delivered-only contract filtering', () => {
  let tmpDir: string;

  beforeEach(() => {
    resetDatabaseForTest();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'loom-rg-epic-'));
  });

  afterEach(() => {
    resetDatabaseForTest();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('listByStatus("done") returns only done epics; in_progress epic excluded', () => {
    const db = openDatabase(path.join(tmpDir, '.loom'));
    const epicStore = new EpicStore(db);

    epicStore.create('epic-done', 'Delivered Epic', '.loom/epics/epic-done.yaml');
    epicStore.updateStatus('epic-done', 'done');

    epicStore.create('epic-inflight', 'In-Flight Epic', '.loom/epics/epic-inflight.yaml');
    epicStore.updateStatus('epic-inflight', 'in_progress');

    const deliveredIds = epicStore.listByStatus('done').map(r => r.id);
    assert.deepEqual(deliveredIds, ['epic-done'], 'only the done epic must be returned');
  });

  it('runFinalizeGates checks only done-epic contracts, not in_progress-epic contracts', async () => {
    const db = openDatabase(path.join(tmpDir, '.loom'));
    const epicStore = new EpicStore(db);

    epicStore.create('epic-done', 'Delivered Epic', '.loom/epics/epic-done.yaml');
    epicStore.updateStatus('epic-done', 'done');

    epicStore.create('epic-inflight', 'In-Flight Epic', '.loom/epics/epic-inflight.yaml');
    epicStore.updateStatus('epic-inflight', 'in_progress');

    // Write contracts: done epic has UserRecord, in_progress epic has RunningSymbol.
    SharedContract.write(
      tmpDir,
      'epic-done',
      '```typescript\nexport interface UserRecord { id: string; }\n```'
    );
    SharedContract.write(
      tmpDir,
      'epic-inflight',
      '```typescript\nexport interface RunningSymbol { value: number; }\n```'
    );

    // Story diff removes BOTH UserRecord and RunningSymbol.
    const storyDiffs = new Map([
      [
        'story-001',
        [
          '-export interface UserRecord { id: string; }',
          '-export interface RunningSymbol { value: number; }',
        ].join('\n'),
      ],
    ]);

    // Use only the delivered (done) epic IDs, as the EpicFinalizer does.
    const deliveredEpicIds = epicStore.listByStatus('done').map(r => r.id);
    const result = await runFinalizeGates({
      projectRoot: tmpDir,
      epicId: 'current-epic',
      epicDiff: '',
      storyDiffs,
      mode: 'warn',
      deliveredEpicIds,
    });

    const regressionSymbols = result.regressions.map(r => r.symbol);
    assert.ok(
      regressionSymbols.includes('UserRecord'),
      'UserRecord from done epic must produce a regression finding'
    );
    assert.ok(
      !regressionSymbols.includes('RunningSymbol'),
      'RunningSymbol from in_progress epic must NOT produce a regression finding'
    );
  });
});
