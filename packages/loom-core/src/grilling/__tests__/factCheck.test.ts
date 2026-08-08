import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import type { LLMClient, LLMRequest, LLMResponse } from '../../llm/LLMClient.js';
import { EMPTY_USAGE } from '../../llm/LLMClient.js';
import { factCheck } from '../factCheck.js';

// ── MockLLMClient ─────────────────────────────────────────────────────────────

class MockLLMClient implements LLMClient {
  readonly requests: LLMRequest[] = [];
  private queue: Array<string | Error>;

  constructor(responses: Array<string | Error>) {
    this.queue = [...responses];
  }

  async complete(req: LLMRequest): Promise<LLMResponse> {
    this.requests.push(req);
    const next = this.queue.shift();
    if (next === undefined) throw new Error('MockLLMClient: no more scripted responses');
    if (next instanceof Error) throw next;
    return {
      text: next,
      model: req.model,
      stopReason: 'end_turn',
      usage: { ...EMPTY_USAGE, requestCount: 1 },
    };
  }

  get lastRequest(): LLMRequest | undefined {
    return this.requests[this.requests.length - 1];
  }
}

// ── Fixtures ──────────────────────────────────────────────────────────────────

const MODEL = 'claude-haiku-4-5-20251001';

// Relative path used in mock responses; must be created under repoRoot in tests that need it.
const EXISTING_REL_PATH = 'packages/loom-core/src/brief/types.ts';
const EXISTING_CITATION = `${EXISTING_REL_PATH}:12`;

let repoRoot: string;

before(() => {
  repoRoot = mkdtempSync(path.join(tmpdir(), 'loom-factcheck-test-'));
});

after(() => {
  rmSync(repoRoot, { recursive: true, force: true });
});

function ensureFile(relPath: string): void {
  const abs = path.join(repoRoot, relPath);
  mkdirSync(path.dirname(abs), { recursive: true });
  writeFileSync(abs, '// stub\n');
}

// ── Tag-assignment tests ──────────────────────────────────────────────────────

describe('factCheck — fact-cited: file exists and citation matches', () => {
  it('returns fact-cited when response contains a valid file:line and file exists', async () => {
    ensureFile(EXISTING_REL_PATH);
    const mock = new MockLLMClient([`The type is defined in ${EXISTING_CITATION}.`]);
    const result = await factCheck('Where is BriefRefinement defined?', repoRoot, mock, MODEL);
    assert.equal(result.tag, 'fact-cited');
    assert.equal(result.citation, EXISTING_CITATION);
    assert.ok(typeof result.answer === 'string' && result.answer.length > 0);
  });
});

describe('factCheck — fact-uncited: file:line present but file missing', () => {
  it('returns fact-uncited when the cited file does not exist under repoRoot', async () => {
    const missingCitation = 'packages/loom-core/src/grilling/nonexistent.ts:5';
    const mock = new MockLLMClient([`See ${missingCitation} for details.`]);
    const result = await factCheck('Where is X defined?', repoRoot, mock, MODEL);
    assert.equal(result.tag, 'fact-uncited');
    assert.equal(result.citation, undefined);
  });
});

describe('factCheck — fact-uncited: no file:line pattern in response', () => {
  it('returns fact-uncited for a plain prose answer with no citation', async () => {
    const mock = new MockLLMClient(['The answer is forty-two.']);
    const result = await factCheck('What is the answer?', repoRoot, mock, MODEL);
    assert.equal(result.tag, 'fact-uncited');
    assert.equal(result.citation, undefined);
  });
});

describe('factCheck — multiple matches: only first match is used', () => {
  it('evaluates only the first file:line match when multiple are present', async () => {
    const firstRelPath = 'packages/multi/first.ts';
    const secondRelPath = 'packages/multi/second.ts';
    ensureFile(firstRelPath);
    // second.ts does NOT exist — confirms we only checked the first
    const response = `See ${firstRelPath}:10 or ${secondRelPath}:20 for reference.`;
    const mock = new MockLLMClient([response]);
    const result = await factCheck('Multiple citations?', repoRoot, mock, MODEL);
    assert.equal(result.tag, 'fact-cited');
    assert.equal(result.citation, `${firstRelPath}:10`);
  });

  it('returns fact-uncited when first match file is missing even if a later file exists', async () => {
    const firstRelPath = 'packages/multi/ghost.ts';
    // Use a distinct path (second-b.ts) so this test's ensureFile call does not
    // interfere with the sibling test that expects second.ts to be absent.
    const secondRelPath = 'packages/multi/second-b.ts';
    ensureFile(secondRelPath);
    const response = `See ${firstRelPath}:1 or ${secondRelPath}:20.`;
    const mock = new MockLLMClient([response]);
    const result = await factCheck('Order matters?', repoRoot, mock, MODEL);
    assert.equal(result.tag, 'fact-uncited');
    assert.equal(result.citation, undefined);
  });
});

// ── nonAgentic flag contract ──────────────────────────────────────────────────

describe('factCheck — agentic mode: nonAgentic must be undefined', () => {
  it('calls llm.complete() without the nonAgentic field (tools ENABLED)', async () => {
    const mock = new MockLLMClient(['No citation here.']);
    await factCheck('Any question?', repoRoot, mock, MODEL);
    const req = mock.lastRequest;
    assert.ok(req !== undefined, 'complete() must have been called');
    assert.equal(
      req.nonAgentic,
      undefined,
      'nonAgentic must be undefined so tools remain enabled for repo reads',
    );
  });
});

// ── error handling ────────────────────────────────────────────────────────────

describe('factCheck — LLM error: returns fact-uncited without rethrowing', () => {
  it('catches a thrown error and returns fact-uncited with the error message', async () => {
    const errorMessage = 'network timeout during LLM call';
    const mock = new MockLLMClient([new Error(errorMessage)]);
    let threw = false;
    let result;
    try {
      result = await factCheck('Will this throw?', repoRoot, mock, MODEL);
    } catch {
      threw = true;
    }
    assert.equal(threw, false, 'factCheck must not rethrow LLM errors');
    assert.ok(result !== undefined);
    assert.equal(result.tag, 'fact-uncited');
    assert.equal(result.answer, errorMessage);
    assert.equal(result.citation, undefined);
  });
});

// ── Regex boundary cases ──────────────────────────────────────────────────────

describe('factCheck — regex boundary: .ts without :line does not match', () => {
  it('returns fact-uncited when response mentions a .ts file with no line number', async () => {
    const mock = new MockLLMClient(['See types.ts for the interface definition.']);
    const result = await factCheck('Where is the interface?', repoRoot, mock, MODEL);
    assert.equal(result.tag, 'fact-uncited');
    assert.equal(result.citation, undefined);
  });
});

describe('factCheck — regex boundary: line zero is rejected', () => {
  it('returns fact-uncited for foo.ts:0 even when the file exists (line 0 is invalid)', async () => {
    const relPath = 'packages/boundary/zero.ts';
    ensureFile(relPath);
    const mock = new MockLLMClient([`Defined at ${relPath}:0.`]);
    const result = await factCheck('Line zero?', repoRoot, mock, MODEL);
    assert.equal(result.tag, 'fact-uncited');
    assert.equal(result.citation, undefined);
  });

  it('returns fact-uncited for foo.ts:0 when the file does not exist', async () => {
    const mock = new MockLLMClient(['Defined at packages/boundary/missing.ts:0.']);
    const result = await factCheck('Line zero missing?', repoRoot, mock, MODEL);
    assert.equal(result.tag, 'fact-uncited');
    assert.equal(result.citation, undefined);
  });
});

// ── Path traversal guard ──────────────────────────────────────────────────────

describe('factCheck — path traversal: citations outside repoRoot are rejected', () => {
  it('returns fact-uncited when citation uses ../ to escape repoRoot', async () => {
    const mock = new MockLLMClient(['See ../../etc/passwd.ts:1 for details.']);
    const result = await factCheck('Traversal via ../?', repoRoot, mock, MODEL);
    assert.equal(result.tag, 'fact-uncited');
    assert.equal(result.citation, undefined);
  });

  it('returns fact-uncited when citation resolves to an absolute path outside repoRoot', async () => {
    // Use a path that looks relative but resolves outside — confirm containment check fires.
    // (Absolute paths that escape repoRoot after path.resolve are rejected.)
    const mock = new MockLLMClient(['See packages/../../../tmp/evil.ts:1.']);
    const result = await factCheck('Absolute escape?', repoRoot, mock, MODEL);
    assert.equal(result.tag, 'fact-uncited');
    assert.equal(result.citation, undefined);
  });

  it('returns fact-uncited when LLM injects an absolute path such as /etc/passwd.ts:1', async () => {
    // path.resolve(repoRoot, '/etc/passwd.ts') ignores repoRoot entirely, so
    // the containment check (startsWith(root + sep)) correctly rejects it.
    const mock = new MockLLMClient(['See /etc/passwd.ts:1 for details.']);
    const result = await factCheck('Absolute injection?', repoRoot, mock, MODEL);
    assert.equal(result.tag, 'fact-uncited');
    assert.equal(result.citation, undefined);
  });
});

// ── fact-cited never appears without a verifiable citation ───────────────────

describe('factCheck — fact-cited tag integrity', () => {
  it('never sets fact-cited without a citation field', async () => {
    // Scenarios that must NOT produce fact-cited
    const uncitedScenarios: Array<string | Error> = [
      'No citation here.',
      'types.ts has the answer.',
      'packages/foo/bar.ts no colon',
    ];
    for (const scenario of uncitedScenarios) {
      const mock = new MockLLMClient([scenario]);
      const result = await factCheck('Q?', repoRoot, mock, MODEL);
      assert.equal(
        result.tag,
        'fact-uncited',
        `expected fact-uncited for scenario: ${String(scenario)}`,
      );
      assert.equal(result.citation, undefined);
    }
  });

  it('sets citation field when tag is fact-cited', async () => {
    // A scenario that DOES produce fact-cited — verify the citation field is present.
    ensureFile(EXISTING_REL_PATH);
    const mock = new MockLLMClient([`See ${EXISTING_CITATION} for details.`]);
    const result = await factCheck('Q?', repoRoot, mock, MODEL);
    assert.equal(result.tag, 'fact-cited');
    assert.ok(result.citation !== undefined, 'fact-cited tag must always have a citation field');
    assert.equal(result.citation, EXISTING_CITATION);
  });
});
