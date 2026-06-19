# Durable Worker Logs & Authoritative Log Reconnect

## The Problem

Loom workers stream output as they run, but loom never keeps that output. Two defects, both surfaced while dogfooding loom, cost operators the diagnostic record they most need:

1. **The full worker log is never persisted.** Loom maintains only a bounded rolling tail — a live buffer capped at a few thousand characters, flushed to the database. At completion, the stored value is *overwritten* with just the last couple thousand characters. The complete output a worker produced is written nowhere durable: not to the database, not to disk. Once a worker finishes, everything but the final fragment is gone.

2. **The web log pane collapses to a small window on reconnect.** The dashboard streams output diffs over server-sent events (SSE) into a per-worker log pane. Each connection holds its own in-memory tail, and the client buffer is wiped whenever the view is re-entered or the page reloads. On reconnect the server can only resend its small current tail — so after a tab goes idle or the stream drops, the pane shows only the last small window. A **client merge bug** compounds this: the resent tail either *replaces* the buffer (losing earlier content) or is *appended again* (duplicating content), depending on timing.

Together these mean an operator cannot review the complete record of what a worker did — neither after the fact nor after a routine page reload.

## Target Users

- **Primary — Loom operators debugging worker runs.** People watching epics execute in the web dashboard who need the complete, trustworthy log of a worker's output, both live and after the fact, surviving idle tabs and dropped connections.
- **Secondary — Loom maintainers dogfooding loom.** The maintainers building loom by running loom on itself, who depend on full failure logs to diagnose regressions. (Both defects were found this way.)
- **Anti-persona — Not a log aggregation / observability platform.** This is not a request for searchable, indexed, or long-retention log storage. Logs follow the existing worktree lifecycle and are not a permanent archive.

## Proposed Solution

Make worker logs **durable on disk** and make the web pane **rebuild from that durable source on every connect**.

Persist each worker's full output to a per-agent file under the loom state directory, appended as output streams. The database continues to hold the small rolling tail for fast status rendering, plus a durable length/offset pointer into the file. Files are the correct store because worker logs are append-heavy and large; a growing database blob would rewrite the entire value on every flush.

Make web reconnect authoritative: on connect, the client fetches the full log for visible workers and rebuilds the pane from it; the live SSE stream then carries only true incremental appends from a durable offset, so a reconnect resumes exactly where it left off rather than resending a tail.

## Key Capabilities

1. **Durable full log.** Append each worker's streamed output to a per-agent file under the loom state directory as it is produced; never overwrite it with the tail at completion — the file retains everything.
2. **Tail + pointer in the database.** Keep writing the small rolling tail to the database for fast status rendering, and record a durable length/offset for the full log.
3. **Full-log read path with from-offset fetch.** Serve the full persisted log for an agent, supporting a `from-offset` query so a caller can fetch only the bytes after a known offset.
4. **Authoritative reconnect in the web.** On opening or re-entering an epic view, rebuild each visible worker's pane from the full-log read path; carry only incremental appends over SSE, keyed by a durable offset.
5. **Correct client merge.** Anchor pane content to the fetched full log and extend it by true appends only — no truncation, no duplication on reconnect. Use the connection-generation signal the stream already emits to force a rebuild when the server restarts.
6. **Lifecycle-managed pruning.** Prune log files with the same lifecycle as worktrees — keep failed and blocked logs for debugging, remove done ones — behind the existing prune behavior.

## Constraints

- **Storage location is fixed.** Logs live under the loom state directory, alongside the other per-story files, covered by the existing ignore rules — never committed. Do **not** store full logs as database blobs; do **not** use the system temp directory.
- **Keep the database tail.** It is required for fast status rendering and must not be removed.
- **No guardrail weakening.** No change may relax any existing policy or guardrail.
- **Redaction is mandatory.** Reuse the existing redaction applied to streamed output so secrets do not leak into persisted logs.
- **Preserve live streaming.** Existing live-streaming behavior for an actively-watched pane must continue to work.

## Risks and Open Questions

- **Offset units must stay consistent across writer, reader, and client.** Redaction can change the byte length of output, so the persisted file, the database pointer, and the SSE append offset must all agree on what "offset" counts (post-redaction bytes). A mismatch reintroduces exactly the truncation/duplication this work aims to remove. *Resolution: define the offset as the post-redaction byte length of the file and derive all three from it.*
- **Unbounded file growth.** The file "retains everything," and no per-file size cap is specified. A pathological worker could produce a very large log before prune reclaims it. `[ASSUMPTION]` The worktree prune lifecycle is sufficient bounding and no separate size cap or rotation is required for this scope.
- **Full-log fetch cost on reconnect with many visible workers.** Rebuilding every visible pane from the read path could mean several large fetches at once. `[ASSUMPTION]` Fetching full logs for the *visible* workers only (not the whole epic) keeps this acceptable; from-offset resume avoids re-fetching on routine appends.
- **Concurrent watchers / writers.** `[ASSUMPTION]` Multiple dashboard connections may watch the same worker, and the agent process is the sole writer to its file; reads tolerate a file being actively appended. To be confirmed against the current SSE fan-out implementation.
- **Crash durability.** `[ASSUMPTION]` Output already streamed and flushed to the file before a crash is acceptable as the durability guarantee; no fsync-per-write requirement is implied.

## Success Criteria

- Each worker's full output is persisted to a per-agent file under the loom state directory and is **not truncated at completion**, while the database still holds the small rolling tail and a durable offset.
- A read path serves the full log for an agent and supports fetching **only the bytes after a given offset**.
- In the web dashboard, opening or re-entering an epic view rebuilds each worker log pane from the full log; after an idle period or a dropped connection the pane shows the **complete** log rather than a small tail, with **no truncation or duplication** on reconnect.
- Secret redaction is applied to the persisted logs.
- Full logs follow the worktree prune lifecycle (failed/blocked retained, done removed).
- The full build and test suite pass.
