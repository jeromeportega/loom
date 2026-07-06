import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import yaml from 'js-yaml';
import {
  extractSymbolsFromContract,
  escapeRegexSymbol,
  checkSymbolDrift,
  runFinalizeGates,
} from '../FinalizeGates.js';
import { openDatabase, resetDatabaseForTest } from '../../state/Database.js';
import { EpicStore } from '../../state/EpicStore.js';
import { AgentStore } from '../../state/AgentStore.js';
import { EpicFinalizer } from '../EpicFinalizer.js';
import type { EpicFinalizerOptions } from '../EpicFinalizer.js';
import { IntegrationGate } from '../IntegrationGate.js';
import type { Story } from '../../types.js';
import { SharedContract } from '../SharedContract.js';

// ─── story-077-002 — FinalizeGates unit tests ────────────────────────────────

// ── extractSymbolsFromContract ───────────────────────────────────────────────

describe('extractSymbolsFromContract', () => {
  it('extracts identifiers from fenced code blocks', () => {
    const md = [
      '# Contract',
      '',
      '```typescript',
      'export type FinalizeGateMode = "off" | "warn" | "block";',
      'export function checkSymbolDrift(): void {}',
      '```',
    ].join('\n');
    const symbols = extractSymbolsFromContract(md);
    assert.ok(symbols.includes('FinalizeGateMode'), 'FinalizeGateMode must be extracted from code block');
    assert.ok(symbols.includes('checkSymbolDrift'), 'checkSymbolDrift must be extracted from code block');
  });

  it('does not extract symbols from prose only', () => {
    const md = 'The Token interface is used by every story. Use AuthToken for the new version.';
    const symbols = extractSymbolsFromContract(md);
    assert.deepEqual(symbols, [], 'prose without code formatting must yield no symbols');
  });

  it('extracts inline code spans', () => {
    const md = 'Use the `Token` interface and the `runFinalizeGates` function.';
    const symbols = extractSymbolsFromContract(md);
    assert.ok(symbols.includes('Token'), 'Token from inline span must be extracted');
    assert.ok(symbols.includes('runFinalizeGates'), 'runFinalizeGates from inline span must be extracted');
  });

  it('deduplicates symbols across multiple code blocks', () => {
    const md = [
      '```typescript',
      'function Token() {}',
      '```',
      '',
      'Some prose.',
      '',
      '```typescript',
      'function Token() {} // same name again',
      '```',
    ].join('\n');
    const symbols = extractSymbolsFromContract(md);
    const tokenOccurrences = symbols.filter(s => s === 'Token');
    assert.equal(tokenOccurrences.length, 1, 'Token must appear exactly once after deduplication');
  });

  it('returns [] for empty contract', () => {
    assert.deepEqual(extractSymbolsFromContract(''), []);
  });

  it('returns [] for whitespace-only contract', () => {
    assert.deepEqual(extractSymbolsFromContract('   \n\n   '), []);
  });
});

// ── escapeRegexSymbol ────────────────────────────────────────────────────────

describe('escapeRegexSymbol', () => {
  it('escapes special regex characters so new RegExp does not throw', () => {
    const cases = ['$emit', 'Map<K,V>', 'foo.bar', 'a+b', 'a*b', 'a?b'];
    for (const sym of cases) {
      assert.doesNotThrow(
        () => new RegExp(escapeRegexSymbol(sym)),
        `new RegExp(escapeRegexSymbol('${sym}')) must not throw`
      );
    }
  });

  it('escaped $emit matches $emit literally', () => {
    const re = new RegExp(escapeRegexSymbol('$emit'));
    assert.ok(re.test('this.$emit("event")'), '$emit must match literally');
    assert.ok(!re.test('noop'), 'must not match unrelated text');
  });

  it('escaped Map<K,V> matches Map<K,V> literally', () => {
    const re = new RegExp(escapeRegexSymbol('Map<K,V>'));
    assert.ok(re.test('const m: Map<K,V> = new Map()'), 'Map<K,V> must match literally');
    assert.ok(!re.test('const m: HashMap = new Map()'), 'must not match HashMap');
  });
});

// ── checkSymbolDrift ─────────────────────────────────────────────────────────

describe('checkSymbolDrift', () => {
  it('returns empty findings when contractSymbols is empty', () => {
    const diffs = new Map([['story-001', '+const x = 1;']]);
    const findings = checkSymbolDrift({ contractSymbols: [], contractEpicId: 'epic-001', storyDiffs: diffs });
    assert.deepEqual(findings, []);
  });

  it('detects drift when story removes a pinned symbol (renamed scenario)', () => {
    // The story renamed Token to AuthToken: removed line has Token, added line has AuthToken.
    const diff = [
      '--- a/auth.ts',
      '+++ b/auth.ts',
      '-export interface Token { id: string; }',
      '+export interface AuthToken { id: string; }',
    ].join('\n');
    const diffs = new Map([['story-001', diff]]);
    const findings = checkSymbolDrift({
      contractSymbols: ['Token'],
      contractEpicId: 'epic-001',
      storyDiffs: diffs,
    });
    assert.equal(findings.length, 1, 'one drift finding must be returned');
    assert.equal(findings[0].symbol, 'Token');
    assert.equal(findings[0].storyId, 'story-001');
    assert.equal(findings[0].contractEpicId, 'epic-001');
    assert.ok(findings[0].lineSnippet.includes('Token'), 'lineSnippet must contain the matched line');
  });

  it('enforces word-boundary: AuthToken in added lines only does not match Token', () => {
    // Diff only adds AuthToken — Token does not appear anywhere with word boundary.
    const diff = [
      '--- a/auth.ts',
      '+++ b/auth.ts',
      '+export class AuthToken implements AuthTokenBase { }',
    ].join('\n');
    const diffs = new Map([['story-001', diff]]);
    const findings = checkSymbolDrift({
      contractSymbols: ['Token'],
      contractEpicId: 'epic-001',
      storyDiffs: diffs,
    });
    assert.deepEqual(findings, [], 'AuthToken substring must not match Token with word boundary');
  });

  it('no drift when story adds the exact pinned symbol', () => {
    // Added lines contain Token as a standalone word.
    const diff = [
      '--- a/auth.ts',
      '+++ b/auth.ts',
      '+const t: Token = TokenFactory.create();',
    ].join('\n');
    const diffs = new Map([['story-001', diff]]);
    const findings = checkSymbolDrift({
      contractSymbols: ['Token'],
      contractEpicId: 'epic-001',
      storyDiffs: diffs,
    });
    assert.deepEqual(findings, [], 'story using the exact symbol must produce no findings');
  });

  it('no drift when symbol not in diff at all', () => {
    const diff = [
      '--- a/utils.ts',
      '+++ b/utils.ts',
      '+export function helper(): void {}',
    ].join('\n');
    const diffs = new Map([['story-001', diff]]);
    const findings = checkSymbolDrift({
      contractSymbols: ['Token'],
      contractEpicId: 'epic-001',
      storyDiffs: diffs,
    });
    assert.deepEqual(findings, [], 'symbol absent from diff must produce no findings');
  });

  it('no drift when symbol survives in context lines after its definition is removed', () => {
    // Removes the Token definition but Token still appears as an unchanged context line
    // (e.g. a usage in the same hunk). Without context-line awareness this produces a
    // false-positive finding.
    const diff = [
      '--- a/auth.ts',
      '+++ b/auth.ts',
      '@@ -1,3 +1,2 @@',
      '-export interface Token { id: string; }',
      '+// definition moved to shared package',
      ' const t: Token = TokenFactory.create();',  // context line — Token survives
    ].join('\n');
    const diffs = new Map([['story-001', diff]]);
    const findings = checkSymbolDrift({
      contractSymbols: ['Token'],
      contractEpicId: 'epic-001',
      storyDiffs: diffs,
    });
    assert.deepEqual(findings, [], 'Token surviving in context lines must produce no drift finding');
  });

  it('only story-A gets a finding when story-B uses the symbol correctly', () => {
    const driftDiff = [
      '-export interface Token { }',
      '+export interface AuthToken { }',
    ].join('\n');
    const noDriftDiff = '+const t: Token = Token.create();';
    const diffs = new Map([
      ['story-A', driftDiff],
      ['story-B', noDriftDiff],
    ]);
    const findings = checkSymbolDrift({
      contractSymbols: ['Token'],
      contractEpicId: 'epic-001',
      storyDiffs: diffs,
    });
    assert.equal(findings.length, 1, 'exactly one finding for story-A');
    assert.equal(findings[0].storyId, 'story-A');
  });
});

// ── runFinalizeGates policy wiring ───────────────────────────────────────────

describe('runFinalizeGates — policy wiring', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'loom-fgates-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function writeContract(epicId: string, content: string): void {
    SharedContract.write(tmpDir, epicId, content);
  }

  function makeDriftyStoryDiffs(symbol: string): Map<string, string> {
    const diff = [
      `--- a/src.ts`,
      `+++ b/src.ts`,
      `-export interface ${symbol} { }`,
      `+export interface Auth${symbol} { }`,
    ].join('\n');
    return new Map([['story-001', diff]]);
  }

  it('mode=off returns all-empty findings and hardFail=false', async () => {
    writeContract('epic-001', '```typescript\nexport interface Token { }\n```');
    const result = await runFinalizeGates({
      projectRoot: tmpDir,
      epicId: 'epic-001',
      epicDiff: '',
      storyDiffs: makeDriftyStoryDiffs('Token'),
      mode: 'off',
      deliveredEpicIds: [],
    });
    assert.deepEqual(result.symbolDrift, []);
    assert.deepEqual(result.undocumentedEnvVars, []);
    assert.deepEqual(result.regressions, []);
    assert.equal(result.hardFail, false);
  });

  it('mode=warn: findings returned but hardFail=false', async () => {
    writeContract('epic-001', '```typescript\nexport interface Token { }\n```');
    const result = await runFinalizeGates({
      projectRoot: tmpDir,
      epicId: 'epic-001',
      epicDiff: '',
      storyDiffs: makeDriftyStoryDiffs('Token'),
      mode: 'warn',
      deliveredEpicIds: [],
    });
    assert.ok(result.symbolDrift.length > 0, 'warn mode must still return findings');
    assert.equal(result.hardFail, false, 'warn mode must not set hardFail');
  });

  it('mode=block with findings: hardFail=true', async () => {
    writeContract('epic-001', '```typescript\nexport interface Token { }\n```');
    const result = await runFinalizeGates({
      projectRoot: tmpDir,
      epicId: 'epic-001',
      epicDiff: '',
      storyDiffs: makeDriftyStoryDiffs('Token'),
      mode: 'block',
      deliveredEpicIds: [],
    });
    assert.ok(result.symbolDrift.length > 0, 'block mode must return findings');
    assert.equal(result.hardFail, true, 'block mode with findings must set hardFail=true');
  });

  it('mode=block with zero findings: hardFail=false', async () => {
    writeContract('epic-001', '```typescript\nexport interface Token { }\n```');
    // Story correctly uses Token.
    const cleanDiffs = new Map([['story-001', '+const t: Token = Token.create();']]);
    const result = await runFinalizeGates({
      projectRoot: tmpDir,
      epicId: 'epic-001',
      epicDiff: '',
      storyDiffs: cleanDiffs,
      mode: 'block',
      deliveredEpicIds: [],
    });
    assert.equal(result.symbolDrift.length, 0);
    assert.equal(result.hardFail, false, 'block mode with no findings must NOT set hardFail');
  });

  it('empty contract produces no drift findings regardless of diff content', async () => {
    // No contract file written — SharedContract.read returns null.
    const result = await runFinalizeGates({
      projectRoot: tmpDir,
      epicId: 'epic-no-contract',
      epicDiff: '',
      storyDiffs: makeDriftyStoryDiffs('Token'),
      mode: 'block',
      deliveredEpicIds: [],
    });
    assert.deepEqual(result.symbolDrift, [], 'absent contract must yield no drift findings');
    assert.equal(result.hardFail, false);
  });
});

// ── Integration smoke: EpicFinalizer propagates hardFail → status='gated' ────

describe('EpicFinalizer integration smoke — hardFail propagates to gated result', () => {
  let repo: string;

  function gitc(args: string[], cwd = repo): string {
    return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
  }

  function greenGate(): IntegrationGate {
    return new IntegrationGate({
      testCommand: 'noop',
      runner: () => ({ exitCode: 0, output: 'ok', timedOut: false, durationMs: 1 }),
    });
  }

  function storyObj(id: string): Story {
    return {
      id,
      title: `Story ${id}`,
      description: 'Do the thing.',
      acceptance_criteria: ['it works'],
      estimated_complexity: 'small',
      dependencies: [],
    };
  }

  function seedEpic(epicId: string, stories: Story[]): void {
    const epicYaml = {
      epic_id: epicId,
      title: `Epic ${epicId}`,
      status: 'planned',
      priority: 'must-have',
      prd_ref: 'x',
      requirements: ['FR-1'],
      stories,
    };
    const rel = `.loom/planning/${epicId}/epics/${epicId}.yaml`;
    const abs = path.join(repo, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, yaml.dump(epicYaml));
    const db = openDatabase(path.join(repo, '.loom'));
    const store = new EpicStore(db);
    store.create(epicId, epicYaml.title, rel);
    store.updateStatus(epicId, 'approved');
  }

  beforeEach(() => {
    resetDatabaseForTest();
    repo = fs.mkdtempSync(path.join(os.tmpdir(), 'loom-fgsmoke-'));
    gitc(['init', '-q']);
    gitc(['config', 'user.email', 'test@loom.dev']);
    gitc(['config', 'user.name', 'Loom Test']);
    gitc(['config', 'commit.gpgsign', 'false']);
    // Seed a file with Token so the story can remove it.
    fs.writeFileSync(path.join(repo, 'src.ts'), 'export interface Token { id: string; }\n');
    gitc(['add', '.']);
    gitc(['commit', '-q', '-m', 'initial']);
  });

  afterEach(() => {
    resetDatabaseForTest();
    fs.rmSync(repo, { recursive: true, force: true });
  });

  it('runFinalizeGates hardFail propagates to { status: gated } in finalize()', async () => {
    const storyId = 'story-001-001';
    const epicId = 'epic-001';
    seedEpic(epicId, [storyObj(storyId)]);

    const db = openDatabase(path.join(repo, '.loom'));
    const epicStore = new EpicStore(db);
    const agentStore = new AgentStore(db);

    // Set base_sha to current HEAD.
    epicStore.updateBaseSha(epicId, gitc(['rev-parse', 'HEAD']));

    // Create the story branch that RENAMES Token to AuthToken (drift).
    gitc(['checkout', '-b', `story/${storyId}`]);
    fs.writeFileSync(
      path.join(repo, 'src.ts'),
      'export interface AuthToken { id: string; }\n'
    );
    gitc(['add', 'src.ts']);
    gitc(['commit', '-q', '-m', `${storyId}: rename Token to AuthToken`]);
    gitc(['checkout', '-']);

    // Mark the story as done so finalize merges it.
    const agent = agentStore.create(epicId, storyId, storyId);
    agentStore.updateStatus(agent.id, 'done');

    // Write the contract pinning Token.
    SharedContract.write(repo, epicId, '```typescript\nexport interface Token { id: string; }\n```');

    const opts: EpicFinalizerOptions = {
      projectRoot: repo,
      db,
      allowedRemotes: [],          // no remote → no push, but we expect gated before that
      prStrategy: 'per-epic',
      gate: greenGate(),
      integrationGate: 'block',   // this drives the finalize gates mode too
      pushBranch: () => ({ ok: true, output: 'pushed' }),
      openPr: () => 'https://example.com/pull/1',
    };

    const result = await new EpicFinalizer(opts).finalize(epicId);

    assert.equal(
      result.status,
      'gated',
      'hardFail from symbol drift must propagate to status=gated'
    );
  });
});
