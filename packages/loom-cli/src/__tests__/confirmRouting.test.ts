/**
 * Unit tests for confirmRouting (story-045-003, AC1, AC2).
 *
 * All tests drive node:readline over an injected input stream — no real TTY.
 * The injected `out` stream captures all output (prompts + validation messages).
 *
 * Key cases:
 *  - accept → {decision:'accepted', type, size} matching classifier verdict
 *  - override type only → decision:'overridden', type changed, size unchanged
 *  - override size only → decision:'overridden', size changed, type unchanged
 *  - override both → decision:'overridden' with both new values
 *  - invalid enum rejected/re-prompted — only known tokens reach the return value
 *  - confidence and rationale are NOT editable (not prompted, not in return value)
 *  - classification surface printed to out (type, size, confidence, rationale)
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough, Writable } from 'node:stream';
import { confirmRouting } from '../intake/confirmRouting.js';
import type { IntakeVerdict } from '@loom-ai/core';

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Feed fixed lines to readline as a readable stream. */
function makeInput(...lines: string[]): NodeJS.ReadableStream {
  const pt = new PassThrough();
  for (const line of lines) pt.write(line + '\n');
  pt.end();
  return pt;
}

/** Capture all writes to a Writable and expose them as a string. */
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

const BASE_VERDICT: IntakeVerdict = {
  type:       'feature',
  size:       'story',
  confidence: 'high',
  rationale:  'Self-contained feature addition.',
};

// ── Accept path ───────────────────────────────────────────────────────────────

describe('confirmRouting — accept (AC1, AC2)', () => {
  it('returns decision:accepted with classifier type/size when operator types "a"', async () => {
    const result = await confirmRouting(BASE_VERDICT, {
      input: makeInput('a'),
      out:   captureStream().stream,
    });
    assert.equal(result.decision, 'accepted');
    assert.equal(result.type,     'feature');
    assert.equal(result.size,     'story');
  });

  it('accepts on empty input (pressing enter)', async () => {
    const result = await confirmRouting(BASE_VERDICT, {
      input: makeInput(''),
      out:   captureStream().stream,
    });
    assert.equal(result.decision, 'accepted');
    assert.equal(result.type,     'feature');
    assert.equal(result.size,     'story');
  });

  it('accepts on "accept" (full word)', async () => {
    const result = await confirmRouting(BASE_VERDICT, {
      input: makeInput('accept'),
      out:   captureStream().stream,
    });
    assert.equal(result.decision, 'accepted');
  });

  it('accepts on "y"', async () => {
    const result = await confirmRouting(BASE_VERDICT, {
      input: makeInput('y'),
      out:   captureStream().stream,
    });
    assert.equal(result.decision, 'accepted');
  });
});

// ── Override paths (AC2) ──────────────────────────────────────────────────────

describe('confirmRouting — override type only (AC2)', () => {
  it('returns decision:overridden with new type and unchanged size', async () => {
    // 'o' = choose override; 'bug' = new type; '' = keep size
    const result = await confirmRouting(BASE_VERDICT, {
      input: makeInput('o', 'bug', ''),
      out:   captureStream().stream,
    });
    assert.equal(result.decision, 'overridden');
    assert.equal(result.type,     'bug');
    assert.equal(result.size,     'story');   // unchanged
  });
});

describe('confirmRouting — override size only (AC2)', () => {
  it('returns decision:overridden with new size and unchanged type', async () => {
    // 'o' = choose override; '' = keep type; 'epic' = new size
    const result = await confirmRouting(BASE_VERDICT, {
      input: makeInput('o', '', 'epic'),
      out:   captureStream().stream,
    });
    assert.equal(result.decision, 'overridden');
    assert.equal(result.type,     'feature');  // unchanged
    assert.equal(result.size,     'epic');
  });
});

describe('confirmRouting — override both type and size (AC2)', () => {
  it('returns decision:overridden with both values changed', async () => {
    // 'o' = choose override; 'chore' = new type; 'epic' = new size
    const result = await confirmRouting(BASE_VERDICT, {
      input: makeInput('o', 'chore', 'epic'),
      out:   captureStream().stream,
    });
    assert.equal(result.decision, 'overridden');
    assert.equal(result.type,     'chore');
    assert.equal(result.size,     'epic');
  });
});

// ── Enum boundary / injection guard (AC2) ─────────────────────────────────────

describe('confirmRouting — invalid enum rejected and re-prompted (AC2)', () => {
  it('rejects an invalid type and re-prompts until a valid value is given', async () => {
    // 'o' = override; 'BADTYPE' = invalid; 'bug' = valid type; '' = keep size
    const { stream: out, get: getOut } = captureStream();
    const result = await confirmRouting(BASE_VERDICT, {
      input: makeInput('o', 'BADTYPE', 'bug', ''),
      out,
    });
    assert.equal(result.type, 'bug', 'must accept the second valid entry');
    assert.ok(
      getOut().includes('BADTYPE'),
      'must echo back the rejected value in the error message',
    );
  });

  it('rejects an invalid size and re-prompts until a valid value is given', async () => {
    // 'o' = override; '' = keep type; 'BADSIZE' = invalid; 'epic' = valid size
    const { stream: out, get: getOut } = captureStream();
    const result = await confirmRouting(BASE_VERDICT, {
      input: makeInput('o', '', 'BADSIZE', 'epic'),
      out,
    });
    assert.equal(result.size, 'epic', 'must accept the second valid entry');
    assert.ok(
      getOut().includes('BADSIZE'),
      'must echo back the rejected value in the error message',
    );
  });

  it('only valid enum tokens reach the return value — no out-of-enum value escapes', async () => {
    // Stress: several invalid entries before a valid one
    const result = await confirmRouting(BASE_VERDICT, {
      input: makeInput('o', 'feature-new', 'EPIC', '', ''),
      out:   captureStream().stream,
    });
    const VALID_TYPES = ['feature', 'bug', 'chore'];
    const VALID_SIZES = ['story', 'epic'];
    assert.ok(VALID_TYPES.includes(result.type), `type '${result.type}' must be a valid enum value`);
    assert.ok(VALID_SIZES.includes(result.size), `size '${result.size}' must be a valid enum value`);
  });
});

// ── Confidence and rationale are NOT editable (AC2) ───────────────────────────

describe('confirmRouting — confidence and rationale not editable (AC2)', () => {
  it('never prompts for confidence — output contains no confidence override prompt', async () => {
    const { stream: out, get: getOut } = captureStream();
    await confirmRouting(BASE_VERDICT, {
      input: makeInput('o', 'bug', 'epic'),
      out,
    });
    assert.ok(
      !getOut().toLowerCase().includes('override confidence'),
      'must not prompt to override confidence',
    );
  });

  it('never prompts for rationale — output contains no rationale override prompt', async () => {
    const { stream: out, get: getOut } = captureStream();
    await confirmRouting(BASE_VERDICT, {
      input: makeInput('o', 'bug', 'epic'),
      out,
    });
    assert.ok(
      !getOut().toLowerCase().includes('override rationale'),
      'must not prompt to override rationale',
    );
  });

  it('return value contains no confidence or rationale field', async () => {
    const result = await confirmRouting(BASE_VERDICT, {
      input: makeInput('a'),
      out:   captureStream().stream,
    });
    // TypeScript already enforces this at compile time, but check at runtime too.
    assert.ok(!('confidence' in result), 'return value must not include confidence');
    assert.ok(!('rationale'  in result), 'return value must not include rationale');
  });
});

// ── Classification surface printed (AC1) ──────────────────────────────────────

describe('confirmRouting — prints classification surface (AC1)', () => {
  it('prints type to out', async () => {
    const { stream: out, get: getOut } = captureStream();
    await confirmRouting(BASE_VERDICT, { input: makeInput('a'), out });
    assert.ok(getOut().includes('feature'), 'must print type');
  });

  it('prints size to out', async () => {
    const { stream: out, get: getOut } = captureStream();
    await confirmRouting(BASE_VERDICT, { input: makeInput('a'), out });
    assert.ok(getOut().includes('story'), 'must print size');
  });

  it('prints confidence to out', async () => {
    const { stream: out, get: getOut } = captureStream();
    await confirmRouting(BASE_VERDICT, { input: makeInput('a'), out });
    assert.ok(getOut().includes('high'), 'must print confidence');
  });

  it('prints rationale to out', async () => {
    const { stream: out, get: getOut } = captureStream();
    await confirmRouting(BASE_VERDICT, { input: makeInput('a'), out });
    assert.ok(
      getOut().includes('Self-contained feature addition.'),
      'must print rationale',
    );
  });
});
