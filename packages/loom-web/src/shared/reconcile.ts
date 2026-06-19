/**
 * Pure offset-anchored log reconcile for SSE output events.
 *
 * The server streams worker log appends as absolute-offset events:
 *   { from: number, bytes: string }
 * where `from` is the durable byte offset at which `bytes` begins.
 *
 * The client tracks `clientOffset` (the byte length of content already shown
 * in the pane, seeded from X-Log-Length on the initial full-log fetch). When
 * an output event arrives this function determines what, if anything, to append.
 *
 * Return values:
 *   { gap: true }  — `from > clientOffset`; caller must refetch the full log
 *   { gap: false, append: string, newOffset: number }
 *       — safe append; `append` is the new bytes to add to the pane,
 *         `newOffset` is the updated client offset
 */
export type ReconcileResult =
  | { gap: true }
  | { gap: false; append: string; newOffset: number };

export function reconcileOutput(
  event: { from: number; bytes: string },
  clientOffset: number
): ReconcileResult {
  const { from, bytes } = event;
  if (from > clientOffset) {
    return { gap: true };
  }
  const overlap = clientOffset - from;
  const append = bytes.slice(overlap);
  const newOffset = from + bytes.length;
  return { gap: false, append, newOffset };
}
