/**
 * Unit tests for resolveIntakeRouting — advisory branch (story-045-002, AC3, AC4).
 *
 * Key cases:
 *  - off  → returns undefined regardless of classification
 *  - advisory + ok:true  → prints type/size/confidence/rationale and returns EffectiveRouting
 *  - advisory + ok:false → returns undefined (legacy path)
 *  - advisory is non-blocking: never reads stdin
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough, Writable } from 'node:stream';
import { resolveIntakeRouting } from '../intake/resolveIntakeRouting.js';
import type { IntakeClassificationResult } from '../intake/recordIntakeClassification.js';

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Feed fixed lines to readline as a readable stream (for confirm-path tests). */
function makeInput(...lines: string[]): NodeJS.ReadableStream {
  const pt = new PassThrough();
  for (const line of lines) pt.write(line + '\n');
  pt.end();
  return pt;
}

/** Capture writes to a Writable and return the full string. */
function captureStream(): { stream: Writable; get: () => string } {
  let buf = '';
  const stream = new Writable({
    write(chunk: Buffer | string, _enc, cb) {
      buf += chunk.toString();
      cb();
    },
  });
  return { stream, get: () => buf };
}

/** A stub AuditLog that does nothing (advisory doesn't call it). */
const NOOP_AUDIT = { record: () => undefined } as unknown as Parameters<typeof resolveIntakeRouting>[0]['audit'];

const OK_CLASSIFICATION: IntakeClassificationResult = {
  ok: true,
  verdict: {
    type:       'feature',
    size:       'story',
    confidence: 'high',
    rationale:  'This is a small, self-contained addition.',
  },
};

const FAIL_CLASSIFICATION: IntakeClassificationResult = {
  ok:     false,
  reason: 'timeout',
  detail: 'triage call exceeded 30000ms',
};

// ── level: off ────────────────────────────────────────────────────────────────

describe('resolveIntakeRouting — level: off', () => {
  it('returns undefined for a successful classification', async () => {
    const result = await resolveIntakeRouting({
      classification: OK_CLASSIFICATION,
      level: 'off',
      isTTY: false,
      audit: NOOP_AUDIT,
      epicId: 'epic-001',
    });
    assert.equal(result, undefined);
  });

  it('returns undefined for a failed classification', async () => {
    const result = await resolveIntakeRouting({
      classification: FAIL_CLASSIFICATION,
      level: 'off',
      isTTY: false,
      audit: NOOP_AUDIT,
      epicId: 'epic-001',
    });
    assert.equal(result, undefined);
  });
});

// ── level: advisory + ok:false ────────────────────────────────────────────────

describe('resolveIntakeRouting — level: advisory, classification failed', () => {
  it('returns undefined when ok:false — legacy path, never a partial route', async () => {
    const result = await resolveIntakeRouting({
      classification: FAIL_CLASSIFICATION,
      level: 'advisory',
      isTTY: false,
      audit: NOOP_AUDIT,
      epicId: 'epic-001',
    });
    assert.equal(result, undefined);
  });

  it('prints nothing when classification failed', async () => {
    const { stream, get } = captureStream();
    await resolveIntakeRouting({
      classification: FAIL_CLASSIFICATION,
      level: 'advisory',
      isTTY: false,
      audit: NOOP_AUDIT,
      epicId: 'epic-001',
      out: stream,
    });
    assert.equal(get(), '', 'must not print anything when classification failed');
  });
});

// ── level: advisory + ok:true ─────────────────────────────────────────────────

describe('resolveIntakeRouting — level: advisory, classification succeeded (AC3)', () => {
  it('returns EffectiveRouting with source:classifier', async () => {
    const result = await resolveIntakeRouting({
      classification: OK_CLASSIFICATION,
      level: 'advisory',
      isTTY: false,
      audit: NOOP_AUDIT,
      epicId: 'epic-001',
    });

    assert.ok(result !== undefined, 'must return EffectiveRouting for advisory + ok:true');
    assert.equal(result.type,       'feature');
    assert.equal(result.size,       'story');
    assert.equal(result.confidence, 'high');
    assert.equal(result.source,     'classifier');
  });

  it('prints type to the injected out stream (AC3)', async () => {
    const { stream, get } = captureStream();
    await resolveIntakeRouting({
      classification: OK_CLASSIFICATION,
      level: 'advisory',
      isTTY: false,
      audit: NOOP_AUDIT,
      epicId: 'epic-001',
      out: stream,
    });
    assert.ok(get().includes('feature'), 'output must contain the type');
  });

  it('prints size to the injected out stream (AC3)', async () => {
    const { stream, get } = captureStream();
    await resolveIntakeRouting({
      classification: OK_CLASSIFICATION,
      level: 'advisory',
      isTTY: false,
      audit: NOOP_AUDIT,
      epicId: 'epic-001',
      out: stream,
    });
    assert.ok(get().includes('story'), 'output must contain the size');
  });

  it('prints confidence to the injected out stream (AC3)', async () => {
    const { stream, get } = captureStream();
    await resolveIntakeRouting({
      classification: OK_CLASSIFICATION,
      level: 'advisory',
      isTTY: false,
      audit: NOOP_AUDIT,
      epicId: 'epic-001',
      out: stream,
    });
    assert.ok(get().includes('high'), 'output must contain the confidence');
  });

  it('prints rationale to the injected out stream (AC3)', async () => {
    const { stream, get } = captureStream();
    await resolveIntakeRouting({
      classification: OK_CLASSIFICATION,
      level: 'advisory',
      isTTY: false,
      audit: NOOP_AUDIT,
      epicId: 'epic-001',
      out: stream,
    });
    assert.ok(
      get().includes('This is a small, self-contained addition.'),
      'output must contain the rationale text'
    );
  });

  it('prints before returning (classification displayed before planning begins, AC3)', async () => {
    let printedBeforeReturn = false;
    const { stream, get } = captureStream();

    // We verify ordering by checking that output exists immediately after the
    // await resolves (the function is non-blocking, so it must print and return).
    await resolveIntakeRouting({
      classification: OK_CLASSIFICATION,
      level: 'advisory',
      isTTY: false,
      audit: NOOP_AUDIT,
      epicId: 'epic-001',
      out: stream,
    });
    printedBeforeReturn = get().length > 0;

    assert.ok(printedBeforeReturn, 'classification surface must be printed before returning');
  });
});

// ── Non-blocking: advisory must never consume stdin (AC4) ─────────────────────

describe('resolveIntakeRouting — advisory is non-blocking (AC4, NFR-2)', () => {
  it('advisory returns without reading stdin — stub stdin to throw if read', async () => {
    // Replace process.stdin.read with a throwing stub for the duration of this test.
    const originalRead = process.stdin.read.bind(process.stdin);
    let stdinRead = false;
    process.stdin.read = (): null => {
      stdinRead = true;
      throw new Error('resolveIntakeRouting must not read from stdin');
    };

    try {
      await resolveIntakeRouting({
        classification: OK_CLASSIFICATION,
        level: 'advisory',
        isTTY: true, // even when isTTY=true the advisory path must not block
        audit: NOOP_AUDIT,
        epicId: 'epic-001',
      });
    } finally {
      process.stdin.read = originalRead;
    }

    assert.ok(!stdinRead, 'advisory must not read from stdin (non-blocking, NFR-2)');
  });
});

// ── level: confirm + isTTY:false — non-interactive degrade (AC4) ─────────────
//
// When no interactive terminal is available, the confirm path warns loudly and
// degrades to advisory so headless/CI planning is never stalled (ADR-004).

describe('resolveIntakeRouting — level: confirm, isTTY:false (AC4, NFR-2)', () => {
  it('returns EffectiveRouting with source:classifier (advisory-equivalent)', async () => {
    const result = await resolveIntakeRouting({
      classification: OK_CLASSIFICATION,
      level:   'confirm',
      isTTY:   false,
      audit:   NOOP_AUDIT,
      epicId:  'epic-001',
    });
    assert.ok(result !== undefined, 'degrade must return EffectiveRouting for ok:true classification');
    assert.equal(result.type,       'feature');
    assert.equal(result.size,       'story');
    assert.equal(result.confidence, 'high');
    assert.equal(result.source,     'classifier');
  });

  it('returns undefined when classification failed (ok:false) — legacy path', async () => {
    const result = await resolveIntakeRouting({
      classification: FAIL_CLASSIFICATION,
      level:   'confirm',
      isTTY:   false,
      audit:   NOOP_AUDIT,
      epicId:  'epic-001',
    });
    assert.equal(result, undefined);
  });

  it('prints the full classification surface (type, size, confidence, rationale)', async () => {
    const { stream, get } = captureStream();
    await resolveIntakeRouting({
      classification: OK_CLASSIFICATION,
      level:   'confirm',
      isTTY:   false,
      audit:   NOOP_AUDIT,
      epicId:  'epic-001',
      out:     stream,
    });
    const output = get();
    assert.ok(output.includes('feature'),   'output must contain type');
    assert.ok(output.includes('story'),     'output must contain size');
    assert.ok(output.includes('high'),      'output must contain confidence');
    assert.ok(output.includes('This is a small, self-contained addition.'), 'output must contain rationale');
  });

  it('prints a visible loud warning so the degrade is non-silent', async () => {
    const { stream, get } = captureStream();
    await resolveIntakeRouting({
      classification: OK_CLASSIFICATION,
      level:   'confirm',
      isTTY:   false,
      audit:   NOOP_AUDIT,
      epicId:  'epic-001',
      out:     stream,
    });
    assert.ok(
      get().includes('[warn]') || get().includes('warn'),
      'confirm degrade must emit a visible warning (non-silent degrade, AC4)',
    );
  });
});

// ── level: confirm + isTTY:true — interactive path (AC1, AC2, AC3) ────────────
//
// The operator is prompted to accept or override. The returned EffectiveRouting
// reflects the decision; confidence is always the classifier's.

describe('resolveIntakeRouting — level: confirm, isTTY:true (AC1, AC2, AC3)', () => {
  it('accepted verdict routes with source:classifier', async () => {
    const { stream: out } = captureStream();
    const result = await resolveIntakeRouting({
      classification: OK_CLASSIFICATION,
      level:   'confirm',
      isTTY:   true,
      audit:   NOOP_AUDIT,
      epicId:  'epic-001',
      input:   makeInput('a'),
      out,
    });
    assert.ok(result !== undefined);
    assert.equal(result.source,     'classifier');
    assert.equal(result.type,       'feature');
    assert.equal(result.size,       'story');
    assert.equal(result.confidence, 'high');
  });

  it('overridden type reaches EffectiveRouting with source:operator-override (AC2, AC3)', async () => {
    const { stream: out } = captureStream();
    const result = await resolveIntakeRouting({
      classification: OK_CLASSIFICATION,
      level:   'confirm',
      isTTY:   true,
      audit:   NOOP_AUDIT,
      epicId:  'epic-001',
      // 'o' = override; 'bug' = new type; '' = keep size
      input:   makeInput('o', 'bug', ''),
      out,
    });
    assert.ok(result !== undefined);
    assert.equal(result.source,     'operator-override');
    assert.equal(result.type,       'bug');
    assert.equal(result.size,       'story');
  });

  it('overridden size reaches EffectiveRouting with source:operator-override (AC2, AC3)', async () => {
    const { stream: out } = captureStream();
    const result = await resolveIntakeRouting({
      classification: OK_CLASSIFICATION,
      level:   'confirm',
      isTTY:   true,
      audit:   NOOP_AUDIT,
      epicId:  'epic-001',
      // 'o' = override; '' = keep type; 'epic' = new size
      input:   makeInput('o', '', 'epic'),
      out,
    });
    assert.ok(result !== undefined);
    assert.equal(result.source,     'operator-override');
    assert.equal(result.type,       'feature');
    assert.equal(result.size,       'epic');
  });

  it('confidence is the classifier verdict — not operator-editable (AC2)', async () => {
    const { stream: out } = captureStream();
    const result = await resolveIntakeRouting({
      classification: OK_CLASSIFICATION,
      level:   'confirm',
      isTTY:   true,
      audit:   NOOP_AUDIT,
      epicId:  'epic-001',
      input:   makeInput('o', 'bug', 'epic'),
      out,
    });
    assert.ok(result !== undefined);
    // Even though type+size were overridden, confidence is the classifier's
    assert.equal(result.confidence, 'high', 'confidence must reflect the classifier, not operator input');
  });
});

// ── NFR-2: only confirm blocks — off and advisory never invoke readline ────────

describe('resolveIntakeRouting — off and advisory never read stdin (NFR-2, AC5)', () => {
  it('off returns without reading stdin (isTTY:true)', async () => {
    const originalRead = process.stdin.read.bind(process.stdin);
    let stdinRead = false;
    process.stdin.read = (): null => { stdinRead = true; return null; };
    try {
      await resolveIntakeRouting({
        classification: OK_CLASSIFICATION,
        level:   'off',
        isTTY:   true,
        audit:   NOOP_AUDIT,
        epicId:  'epic-001',
      });
    } finally {
      process.stdin.read = originalRead;
    }
    assert.ok(!stdinRead, 'off path must not read stdin');
  });

  it('advisory returns without reading stdin (isTTY:true)', async () => {
    const originalRead = process.stdin.read.bind(process.stdin);
    let stdinRead = false;
    process.stdin.read = (): null => { stdinRead = true; return null; };
    try {
      await resolveIntakeRouting({
        classification: OK_CLASSIFICATION,
        level:   'advisory',
        isTTY:   true,
        audit:   NOOP_AUDIT,
        epicId:  'epic-001',
      });
    } finally {
      process.stdin.read = originalRead;
    }
    assert.ok(!stdinRead, 'advisory path must not read stdin (non-blocking, NFR-2)');
  });
});
