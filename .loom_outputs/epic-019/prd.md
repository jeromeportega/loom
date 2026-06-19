# Durable Worker Logs & Authoritative Log Reconnect

## Overview

Loom workers stream output as they run, but loom never durably keeps that output: the database holds only a bounded rolling tail that is *overwritten* with the last few thousand characters at completion, so the complete record is lost the moment a worker finishes. Compounding this, the web dashboard's per-worker log pane collapses to a small window on reconnect — each SSE connection holds its own in-memory tail, the client buffer is wiped on view re-entry or reload, and a client merge bug either truncates or duplicates the resent tail. This work persists each worker's full output to a per-agent file under the loom state directory and makes the web pane rebuild authoritatively from that durable source on every connect, with the live SSE stream carrying only true incremental appends from a durable offset.

## Goals

1. **No log is ever lost.** Each worker's complete output is persisted to disk and is never truncated at completion. Success metric: after any completed worker run, the persisted file contains 100% of the streamed (post-redaction) output, not just the final tail.
2. **Reconnect shows the complete log, correctly.** After an idle tab or dropped connection, the web pane displays the full log with no truncation and no duplication. Success metric: re-entering an epic view or reloading the page yields a pane byte-identical to the persisted full log.
3. **Live streaming and fast status rendering are preserved.** The database tail still drives status views and the actively-watched pane still updates live. Success metric: no regression in live-stream latency or status rendering versus current behavior.

## User Stories

- **Must** — As a loom operator debugging a worker run, I want to open or re-enter an epic view and see the complete log of each visible worker, so that I can review everything the worker did rather than just the last small window.
- **Must** — As a loom operator whose tab went idle or whose connection dropped, I want the log pane to rebuild to the full log with no missing or duplicated lines, so that I can trust what I'm reading.
- **Must** — As a loom maintainer dogfooding loom, I want a worker's full output to survive after the worker finishes, so that I can diagnose failures from the complete record after the fact.
- **Should** — As a loom operator, I want secrets kept out of the persisted logs, so that durable storage does not become a leak vector.

## Functional Requirements

- **FR-1** — Append each worker's streamed output to a per-agent file under the loom state directory as it is produced. The file is never overwritten with the tail at completion; it retains the complete output.
- **FR-2** — Continue writing the small rolling tail to the database for fast status rendering, and additionally record a durable length/offset pointer into the full-log file.
- **FR-3** — Define the durable offset as the **post-redaction byte length** of the file; the writer, the database pointer, and the SSE append offset all derive from this single definition.
- **FR-4** — Apply the existing streamed-output redaction to data before it is written to the persisted file, so the file contains no secrets.
- **FR-5** — Provide a read path that serves the full persisted log for an agent and supports a `from-offset` query, returning only the bytes after the supplied offset.
- **FR-6** — On opening or re-entering an epic view (or on page reload), the web client fetches the full log for each **visible** worker via the read path and rebuilds that worker's pane from it.
- **FR-7** — After the initial rebuild, the live SSE stream carries only true incremental appends keyed by the durable offset, so a reconnect resumes from the last known offset rather than resending a tail.
- **FR-8** — The client anchors pane content to the fetched full log and extends it by appends only — no truncation, no duplication. It uses the connection-generation signal the stream already emits to force a full rebuild when the server restarts.
- **FR-9** — Prune full-log files under the existing worktree prune lifecycle: retain logs for failed and blocked workers for debugging, remove logs for done workers.

## Non-Functional Requirements

- **NFR-1 (Storage location)** — Full logs are stored under the loom state directory alongside other per-story files, covered by existing ignore rules so they are never committed. They are not stored as database blobs and not placed in the system temp directory.
- **NFR-2 (Redaction)** — Persisted logs reuse the existing redaction path; no new or weaker redaction is introduced.
- **NFR-3 (No guardrail weakening)** — No change relaxes any existing policy or guardrail.
- **NFR-4 (Durability semantics)** — Output already streamed and flushed to the file before a crash is the durability guarantee; no fsync-per-write is required.
- **NFR-5 (Concurrent access)** — The agent process is the sole writer to its file; multiple dashboard connections may read the same worker's file concurrently, and reads tolerate a file being actively appended.

## Epics

- **Epic 1 — Durable Worker Logs & Authoritative Log Reconnect.** Persist full worker output to per-agent files (writer, offset pointer, redaction), expose a from-offset read path, and make the web pane rebuild authoritatively on connect with correct incremental merge and lifecycle-managed pruning. This is a single cohesive shipping unit spanning the core writer/persistence layer, the read path, and the web reconnect logic.

## Out of Scope

- Searchable, indexed, or long-retention log storage — this is not a log aggregation or observability platform; logs follow the worktree lifecycle and are not a permanent archive.
- A per-file size cap or log rotation. `[ASSUMPTION]` The worktree prune lifecycle is sufficient bounding for this scope.
- Fetching full logs for all workers in an epic on reconnect; only **visible** workers are rebuilt. `[ASSUMPTION]` This plus from-offset resume keeps reconnect cost acceptable.
- fsync-per-write or other stronger crash-durability guarantees beyond flushed output (per NFR-4).
