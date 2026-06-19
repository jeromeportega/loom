/**
 * Pure offset-anchored log reconcile for SSE output events.
 *
 * The server streams worker log appends as absolute-offset events:
 *   { from: number, bytes: string, byteLength: number }
 * where `from` is the durable byte offset at which `bytes` begins and
 * `byteLength` is the UTF-8 byte length of `bytes` (NOT JS .length, which
 * counts UTF-16 code units and diverges for multi-byte characters).
 *
 * The client tracks `clientOffset` (the byte length of content already shown
 * in the pane, seeded from X-Log-Length on the initial full-log fetch). When
 * an output event arrives this function determines what, if anything, to append.
 *
 * Return values:
 *   { gap: true }  — `from > clientOffset`; caller must refetch the full log
 *   { gap: false, append: string, newOffset: number }
 *       — safe append; `append` is the new bytes to add to the pane,
 *         `newOffset` is the updated client offset (never regresses below clientOffset)
 */
export type ReconcileResult =
  | { gap: true }
  | { gap: false; append: string; newOffset: number };

export function reconcileOutput(
  event: { from: number; bytes: string; byteLength: number },
  clientOffset: number
): ReconcileResult {
  const { from, bytes, byteLength } = event;
  if (from > clientOffset) {
    return { gap: true };
  }
  const overlapBytes = clientOffset - from;
  // byte-accurate slice: `from`/`clientOffset` are UTF-8 byte offsets, so we
  // must slice by byte position, not JS character index, which diverges for
  // any multi-byte character (e.g. '…' is 1 JS char but 3 UTF-8 bytes).
  // TextEncoder/TextDecoder are used instead of Buffer so this function is
  // environment-agnostic (works in both Node.js tests and the browser).
  const append = new TextDecoder().decode(new TextEncoder().encode(bytes).subarray(overlapBytes));
  // Clamp: when from + byteLength < clientOffset the event covers only
  // already-displayed bytes; returning a regressed newOffset would cause the
  // caller to treat the next SSE event as a gap and trigger a spurious refetch.
  const newOffset = Math.max(from + byteLength, clientOffset);
  return { gap: false, append, newOffset };
}
