/**
 * Unit tests for the pure offset-anchored log reconcile function.
 *
 * reconcileOutput({from, bytes}, clientOffset) is the highest-risk surface in
 * the client rewrite: it replaces the fragile `chunk.startsWith(prev)` heuristic
 * with a provably correct overlap-slice / gap-detect implementation.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { reconcileOutput } from '../shared/reconcile.js';

/** Helper: build an event object with the correct byteLength for a string. */
function evt(from: number, bytes: string): { from: number; bytes: string; byteLength: number } {
  return { from, bytes, byteLength: Buffer.byteLength(bytes, 'utf8') };
}

describe('reconcileOutput — append with no overlap', () => {
  it('pure append: from === clientOffset, all bytes are new', () => {
    const result = reconcileOutput(evt(10, 'hello'), 10);
    assert.ok(result.gap === false);
    if (result.gap) return;
    assert.equal(result.append, 'hello');
    assert.equal(result.newOffset, 15); // 10 + 5
  });

  it('empty bytes at clientOffset: no-op append', () => {
    const result = reconcileOutput(evt(5, ''), 5);
    assert.ok(result.gap === false);
    if (result.gap) return;
    assert.equal(result.append, '');
    assert.equal(result.newOffset, 5);
  });

  it('first event from zero with full content', () => {
    const result = reconcileOutput(evt(0, 'line1\nline2\n'), 0);
    assert.ok(result.gap === false);
    if (result.gap) return;
    assert.equal(result.append, 'line1\nline2\n');
    assert.equal(result.newOffset, 12);
  });
});

describe('reconcileOutput — overlap trim (from < clientOffset)', () => {
  it('partial overlap: trims prefix, appends remainder', () => {
    // Server resent from=3, clientOffset=8 → overlap=5 chars ('hello'), new='world'
    const result = reconcileOutput(evt(3, 'helloworld'), 8);
    assert.ok(result.gap === false);
    if (result.gap) return;
    assert.equal(result.append, 'world');
    assert.equal(result.newOffset, 13); // 3 + 10
  });

  it('exact resend: from=0, bytes=already known content → empty append', () => {
    // Client already has 'abcdef', server resends from 0
    const result = reconcileOutput(evt(0, 'abcdef'), 6);
    assert.ok(result.gap === false);
    if (result.gap) return;
    assert.equal(result.append, '');
    assert.equal(result.newOffset, 6); // 0 + 6
  });

  it('full-overlap resend with tail extension: trims to only new part', () => {
    // clientOffset=10, server resends from=5 with 10 bytes (5 known + 5 new)
    const result = reconcileOutput(evt(5, '1234567890'), 10);
    assert.ok(result.gap === false);
    if (result.gap) return;
    assert.equal(result.append, '67890'); // slice(5)
    assert.equal(result.newOffset, 15); // 5 + 10
  });

  it('overlap covers all bytes — nothing to append, offset clamped to clientOffset', () => {
    // clientOffset=5 is already past the end of this event's range (from=0, byteLength=3).
    // newOffset must clamp to 5 (not regress to 3) so the next SSE event whose
    // `from=5` is not mistaken for a gap and does not trigger a spurious refetch.
    const result = reconcileOutput(evt(0, 'abc'), 5);
    assert.ok(result.gap === false);
    if (result.gap) return;
    assert.equal(result.append, '');
    assert.equal(result.newOffset, 5); // Math.max(0+3, 5) = 5, not 3
  });

  it('multi-byte UTF-8: overlap slice aligns on byte boundary, not char boundary', () => {
    // '…' (U+2026 HORIZONTAL ELLIPSIS) is 1 JS char but 3 UTF-8 bytes (0xE2 0x80 0xA6).
    // from=0, clientOffset=3 (3 bytes already shown = '…'), bytes='…abc'
    // overlap=3 bytes → append='abc', newOffset=6
    const bytes = '…abc'; // '…abc': 3+3=6 UTF-8 bytes, 4 JS chars
    const result = reconcileOutput(evt(0, bytes), 3);
    assert.ok(result.gap === false);
    if (result.gap) return;
    assert.equal(result.append, 'abc');
    assert.equal(result.newOffset, 6); // 0 + Buffer.byteLength('…abc') = 6
  });
});

describe('reconcileOutput — gap detection (from > clientOffset)', () => {
  it('gap: from > clientOffset → {gap: true}', () => {
    const result = reconcileOutput(evt(20, 'new data'), 10);
    assert.ok(result.gap === true);
  });

  it('gap at zero: clientOffset=0, from=5 → {gap: true}', () => {
    const result = reconcileOutput(evt(5, 'data'), 0);
    assert.ok(result.gap === true);
  });

  it('no gap: from === clientOffset is NOT a gap', () => {
    const result = reconcileOutput(evt(7, 'x'), 7);
    assert.ok(result.gap === false);
  });
});

describe('reconcileOutput — byte-identical after sequence of appends', () => {
  it('sequential appends reconstruct the full log exactly', () => {
    const fullLog = 'line1\nline2\nline3\n';
    let pane = '';
    let clientOffset = 0;

    // Simulate chunked SSE delivery (non-overlapping)
    const chunks = [
      { from: 0, bytes: 'line1\n' },
      { from: 6, bytes: 'line2\n' },
      { from: 12, bytes: 'line3\n' },
    ];

    for (const chunk of chunks) {
      const result = reconcileOutput(evt(chunk.from, chunk.bytes), clientOffset);
      assert.ok(result.gap === false);
      if (result.gap) break;
      pane += result.append;
      clientOffset = result.newOffset;
    }

    assert.equal(pane, fullLog);
    assert.equal(clientOffset, Buffer.byteLength(fullLog, 'utf8'));
  });

  it('overlapping resends do not duplicate content', () => {
    // Server resends some bytes the client already has (tail overlap scenario)
    let pane = 'hello ';
    let clientOffset = 6;

    // Server sends from=3 with 'lo world' (first 3 chars are already shown)
    const result = reconcileOutput(evt(3, 'lo world'), clientOffset);
    assert.ok(result.gap === false);
    if (result.gap) return;
    pane += result.append;
    clientOffset = result.newOffset;

    assert.equal(pane, 'hello world');
    assert.equal(clientOffset, 11);
  });

  it('multiline log built from multiple overlapping events equals persisted file', () => {
    const persisted = 'alpha\nbeta\ngamma\n';
    let pane = '';
    let clientOffset = 0;

    // First event: first two lines (no overlap)
    const r1 = reconcileOutput(evt(0, 'alpha\nbeta\n'), clientOffset);
    assert.ok(!r1.gap);
    if (!r1.gap) { pane += r1.append; clientOffset = r1.newOffset; }

    // Second event resent from 5 with overlap + new bytes
    const r2 = reconcileOutput(evt(5, '\nbeta\ngamma\n'), clientOffset);
    assert.ok(!r2.gap);
    if (!r2.gap) { pane += r2.append; clientOffset = r2.newOffset; }

    assert.equal(pane, persisted);
    assert.equal(clientOffset, persisted.length);
  });
});
