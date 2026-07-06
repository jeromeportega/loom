import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import yaml from 'js-yaml';
import {
  extractSymbolsFromContract,
  symbolsPresentInTree,
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

// ─── story-077-002 — FinalizeGates unit tests (tree-presence rework) ─────────
//
// The gates test whether a contract-pinned symbol is present anywhere in the
// integrated git tree — NOT whether a diff line removed it. This eliminates the
// two false-positive classes the diff-grep original had: (a) prose words pinned
// from code fences, and (b) a symbol flagged as "removed" when it is alive in an
// untouched file the diff never showed.

// ── git repo helper ──────────────────────────────────────────────────────────

function makeGitRepo(): { root: string; git: (args: string[]) => string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'loom-fgtree-'));
  const git = (args: string[]) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
  git(['init', '-q']);
  git(['config', 'user.email', 'test@loom.dev']);
  git(['config', 'user.name', 'Loom Test']);
  git(['config', 'commit.gpgsign', 'false']);
  return { root, git };
}

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

  it('drops lowercase prose words that appear inside code fences (significance filter)', () => {
    // A fence that mixes real identifiers with English words from comments/strings.
    const md = [
      '```typescript',
      '// when the team has finished, set the root state',
      'const team = getTeamRoster();',
      '```',
    ].join('\n');
    const symbols = extractSymbolsFromContract(md);
    for (const junk of ['when', 'team', 'has', 'root', 'state']) {
      assert.ok(!symbols.includes(junk), `lowercase prose word '${junk}' must NOT be pinned`);
    }
    assert.ok(symbols.includes('getTeamRoster'), 'camelCase identifier must still be pinned');
  });

  it('keeps UPPER_SNAKE env-var / constant style names', () => {
    const md = '```\nconst x = process.env.AUTH_TOKEN_ID;\n```';
    const symbols = extractSymbolsFromContract(md);
    assert.ok(symbols.includes('AUTH_TOKEN_ID'), 'UPPER_SNAKE name must be pinned');
  });

  it('deduplicates symbols across multiple code blocks', () => {
    const md = [
      '```typescript',
      'function TokenFn() {}',
      '```',
      '',
      'Some prose.',
      '',
      '```typescript',
      'function TokenFn() {} // same name again',
      '```',
    ].join('\n');
    const symbols = extractSymbolsFromContract(md);
    assert.equal(symbols.filter(s => s === 'TokenFn').length, 1, 'must appear once after dedup');
  });

  it('returns [] for empty / whitespace-only contract', () => {
    assert.deepEqual(extractSymbolsFromContract(''), []);
    assert.deepEqual(extractSymbolsFromContract('   \n\n   '), []);
  });
});

// ── symbolsPresentInTree ─────────────────────────────────────────────────────

describe('symbolsPresentInTree', () => {
  let repo: ReturnType<typeof makeGitRepo>;

  beforeEach(() => {
    repo = makeGitRepo();
    fs.writeFileSync(
      path.join(repo.root, 'auth.ts'),
      'export interface AuthToken { id: string; }\nexport const SESSION_KEY = "s";\n'
    );
    repo.git(['add', '.']);
    repo.git(['commit', '-q', '-m', 'init']);
  });

  afterEach(() => {
    fs.rmSync(repo.root, { recursive: true, force: true });
  });

  it('returns the empty set for no symbols', () => {
    assert.deepEqual([...symbolsPresentInTree(repo.root, 'HEAD', [])!], []);
  });

  it('reports a present symbol', () => {
    const present = symbolsPresentInTree(repo.root, 'HEAD', ['AuthToken', 'SESSION_KEY']);
    assert.ok(present!.has('AuthToken'));
    assert.ok(present!.has('SESSION_KEY'));
  });

  it('does not report an absent symbol', () => {
    const present = symbolsPresentInTree(repo.root, 'HEAD', ['Nonexistent']);
    assert.ok(!present!.has('Nonexistent'));
    assert.equal(present!.size, 0);
  });

  it('enforces word boundaries — Token is absent even though AuthToken is present', () => {
    const present = symbolsPresentInTree(repo.root, 'HEAD', ['Token']);
    assert.ok(!present!.has('Token'), 'Token must not match inside AuthToken');
  });

  it('returns null on a bad ref (skip-the-gate signal), not a false "all absent"', () => {
    const present = symbolsPresentInTree(repo.root, 'no-such-ref', ['AuthToken']);
    assert.equal(present, null, 'a git error must surface as null, not an empty present-set');
  });
});

// ── checkSymbolDrift (present-set based) ─────────────────────────────────────

describe('checkSymbolDrift', () => {
  it('returns empty findings when contractSymbols is empty', () => {
    assert.deepEqual(
      checkSymbolDrift({ contractSymbols: [], contractEpicId: 'epic-001', presentSymbols: new Set() }),
      []
    );
  });

  it('flags a pinned symbol absent from the tree (renamed or dropped)', () => {
    const findings = checkSymbolDrift({
      contractSymbols: ['Token'],
      contractEpicId: 'epic-001',
      presentSymbols: new Set(['AuthToken']), // Token was renamed to AuthToken
    });
    assert.equal(findings.length, 1);
    assert.equal(findings[0].symbol, 'Token');
    assert.equal(findings[0].contractEpicId, 'epic-001');
  });

  it('does not flag a pinned symbol that is present', () => {
    const findings = checkSymbolDrift({
      contractSymbols: ['Token'],
      contractEpicId: 'epic-001',
      presentSymbols: new Set(['Token', 'AuthToken']),
    });
    assert.deepEqual(findings, []);
  });

  it('flags only the absent symbols in a mixed set', () => {
    const findings = checkSymbolDrift({
      contractSymbols: ['Alpha', 'Beta', 'Gamma'],
      contractEpicId: 'epic-001',
      presentSymbols: new Set(['Beta']),
    });
    assert.deepEqual(findings.map(f => f.symbol).sort(), ['Alpha', 'Gamma']);
  });
});

// ── runFinalizeGates policy wiring (real git tree) ───────────────────────────

describe('runFinalizeGates — policy wiring', () => {
  let repo: ReturnType<typeof makeGitRepo>;
  let baseSha: string;

  // Seed a tree whose head has AuthToken but NOT Token — so a contract pinning
  // Token is a genuine drift (the symbol is absent from the whole tree).
  beforeEach(() => {
    repo = makeGitRepo();
    fs.writeFileSync(path.join(repo.root, 'src.ts'), 'export interface AuthToken {}\n');
    repo.git(['add', '.']);
    repo.git(['commit', '-q', '-m', 'init']);
    baseSha = repo.git(['rev-parse', 'HEAD']);
  });

  afterEach(() => {
    fs.rmSync(repo.root, { recursive: true, force: true });
  });

  function run(mode: 'off' | 'warn' | 'block', epicId = 'epic-001') {
    return runFinalizeGates({
      contractRoot: repo.root,
      treeRoot: repo.root,
      headRef: 'HEAD',
      baseRef: baseSha,
      epicId,
      epicDiff: '',
      mode,
      deliveredEpicIds: [],
    });
  }

  it('mode=off returns all-empty findings and hardFail=false', async () => {
    SharedContract.write(repo.root, 'epic-001', '```typescript\nexport interface Token {}\n```');
    const result = await run('off');
    assert.deepEqual(result.symbolDrift, []);
    assert.equal(result.hardFail, false);
  });

  it('mode=warn: drift finding returned but hardFail=false', async () => {
    SharedContract.write(repo.root, 'epic-001', '```typescript\nexport interface Token {}\n```');
    const result = await run('warn');
    assert.ok(result.symbolDrift.some(f => f.symbol === 'Token'), 'Token drift must be reported');
    assert.equal(result.hardFail, false, 'warn must not hard-fail');
  });

  it('mode=block: symbol drift is ADVISORY — finding present but hardFail=false', async () => {
    // Drift is a heuristic over prose-heavy contracts; it must never withhold a
    // PR on its own. Only the precise env-var gate hard-fails (see GateEnvVar).
    SharedContract.write(repo.root, 'epic-001', '```typescript\nexport interface Token {}\n```');
    const result = await run('block');
    assert.ok(result.symbolDrift.some(f => f.symbol === 'Token'), 'drift finding still reported');
    assert.equal(result.hardFail, false, 'symbol drift alone must NOT hard-fail');
  });

  it('mode=block with zero findings: hardFail=false (pinned symbol is present)', async () => {
    // Contract pins AuthToken, which IS present in the tree → no drift.
    SharedContract.write(repo.root, 'epic-001', '```typescript\nexport interface AuthToken {}\n```');
    const result = await run('block');
    assert.equal(result.symbolDrift.length, 0);
    assert.equal(result.hardFail, false);
  });

  it('absent contract produces no drift findings', async () => {
    const result = await run('block', 'epic-no-contract');
    assert.deepEqual(result.symbolDrift, []);
    assert.equal(result.hardFail, false);
  });

  it('reads the contract from contractRoot, not treeRoot (rolling-mode wrong-root regression)', async () => {
    // Simulate rolling integration: the contract lives under the REAL repo root,
    // while the integrated tree is a *separate* worktree that does not carry the
    // untracked .loom/contract file. The pre-fix code read the contract from the
    // worktree (treeRoot) and silently found nothing → zero findings forever.
    const contractRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'loom-fgcontract-'));
    try {
      SharedContract.write(contractRoot, 'epic-001', '```typescript\nexport interface Token {}\n```');
      const result = await runFinalizeGates({
        contractRoot,           // contract here …
        treeRoot: repo.root,    // … tree grepped here (Token absent)
        headRef: 'HEAD',
        baseRef: baseSha,
        epicId: 'epic-001',
        epicDiff: '',
        mode: 'block',
        deliveredEpicIds: [],
      });
      assert.ok(
        result.symbolDrift.some(f => f.symbol === 'Token'),
        'contract must be read from contractRoot even when treeRoot lacks it'
      );
    } finally {
      fs.rmSync(contractRoot, { recursive: true, force: true });
    }
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
    // Seed a source file plus a .env.example that does NOT document the secret
    // the story will introduce — so the (blocking) env-var gate fires.
    fs.writeFileSync(path.join(repo, 'src.ts'), 'export const x = 1;\n');
    fs.writeFileSync(path.join(repo, '.env.example'), 'DOCUMENTED_VAR=\n');
    gitc(['add', '.']);
    gitc(['commit', '-q', '-m', 'initial']);
  });

  afterEach(() => {
    resetDatabaseForTest();
    fs.rmSync(repo, { recursive: true, force: true });
  });

  it('env-var hardFail propagates to { status: gated } in finalize()', async () => {
    const storyId = 'story-001-001';
    const epicId = 'epic-001';
    seedEpic(epicId, [storyObj(storyId)]);

    const db = openDatabase(path.join(repo, '.loom'));
    const epicStore = new EpicStore(db);
    const agentStore = new AgentStore(db);

    epicStore.updateBaseSha(epicId, gitc(['rev-parse', 'HEAD']));

    // Story branch reads an env var absent from .env.example → env-var gate fires.
    gitc(['checkout', '-b', `story/${storyId}`]);
    fs.writeFileSync(
      path.join(repo, 'src.ts'),
      'export const secret = process.env.UNDOCUMENTED_SECRET;\n'
    );
    gitc(['add', 'src.ts']);
    gitc(['commit', '-q', '-m', `${storyId}: read UNDOCUMENTED_SECRET`]);
    gitc(['checkout', '-']);

    const agent = agentStore.create(epicId, storyId, storyId);
    agentStore.updateStatus(agent.id, 'done');

    const opts: EpicFinalizerOptions = {
      projectRoot: repo,
      db,
      allowedRemotes: [],
      prStrategy: 'per-epic',
      gate: greenGate(),
      integrationGate: 'block', // drives the finalize gates mode too
      pushBranch: () => ({ ok: true, output: 'pushed' }),
      openPr: () => 'https://example.com/pull/1',
    };

    const result = await new EpicFinalizer(opts).finalize(epicId);

    assert.equal(
      result.status,
      'gated',
      'hardFail from the undocumented-env-var gate must propagate to status=gated'
    );
  });
});
