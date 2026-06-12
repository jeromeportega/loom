---
title: "Live agent guidance — course-correcting headless workers mid-spawn"
status: accepted
research_type: technical
date: 2026-06-01
author: loom
spike_completed: 2026-06-02
---

# Live agent guidance — course-correcting headless workers mid-spawn

## Research overview

Loom already supports operator → worker steering via `loom_guide_agent`, which
appends a markdown entry to `.loom/guidance/<story-id>.md`. The worker reads
that file when its prompt is built — at story-start and on every
block-and-revise revision (see
[`packages/loom-core/src/orchestrator/workerPrompt.ts:67-80`](https://github.com/jeromeportega/loom/blob/main/packages/loom-core/src/orchestrator/workerPrompt.ts)
and [`BaseCliWorker.run` / `runReviewPassUnsafe`](https://github.com/jeromeportega/loom/blob/main/packages/loom-core/src/orchestrator/BaseCliWorker.ts)).
The pickup boundary is therefore **per-spawn**: a worker that is mid-tool-call
will not see new guidance until either the current spawn exits or a revision
spawn begins.

This document investigates every plausible mechanism for shrinking the pickup
latency from "per-revision" (which today is often the entire wall-clock
lifetime of a story) to "between tool calls" (seconds). Each candidate is
scored on feasibility inside loom's current code, latency, safety, backend
compatibility, operator UX, and unit-test surface. The recommendation is at
the end.

## Problem statement

**Today's loop (per-revision).** Operator sends a `loom_guide_agent` call.
`OperatorGuidance.add()` appends a timestamped block to
`.loom/guidance/<story-id>.md` and writes one audit row (file:
[`OperatorGuidance.ts:54-76`](https://github.com/jeromeportega/loom/blob/main/packages/loom-core/src/orchestrator/OperatorGuidance.ts)).
The worker subprocess does **not** notice. When `BaseCliWorker.run` (or a
re-prompt inside `runReviewPassUnsafe`) calls `buildWorkerPrompt(..., {
includeOperatorGuidance: true })`, the file is read and prepended as a
priority block — only then does the worker see the new instruction. In
practice "mid-story" guidance is invisible until the worker either finishes
its current spawn naturally, fails review and is re-prompted, or is SIGTERM'd
and restarted (which discards the in-flight tool work).

**Desired loop (mid-spawn).** While the worker is in the middle of writing
code, the operator types "actually, also handle the auth case". Within
seconds the worker incorporates that into its next tool call — without losing
the current conversation context, the current diff, or the worktree state.

**Constraint that makes this hard.** Workers in loom are not loom-controlled
chat loops. They are headless invocations of foreign CLIs (`claude`,
`cursor-agent`) launched via `child_process.spawn` with the prompt written to
stdin and stdin closed
([`BaseCliWorker.spawnAgent`, lines 375-452](https://github.com/jeromeportega/loom/blob/main/packages/loom-core/src/orchestrator/BaseCliWorker.ts)).
Loom owns the subprocess pid and parses its stdout line-by-line; it does
**not** own the agent's conversation state, its tool-call cadence, or its
model context. Any mid-spawn signal must travel through whatever surface the
underlying CLI exposes.

## Sub-questions

1. What surfaces do the upstream CLIs expose for accepting an additional
   instruction without restarting the agent?
2. Where in `BaseCliWorker` would a "guidance changed" signal land, and what
   would it need to push into?
3. Can the worker prompt itself be modified so the worker pulls guidance on
   its own cadence (between tool calls) without supervisor cooperation?
4. What is the minimum change that produces meaningful latency improvement,
   and what is the eventual destination?
5. How does each candidate degrade for the `cursor-cli` and `anthropic-api`
   backends (which today only differ from `claude-cli` at the spawn surface)?

## Upstream surface map

Three backends matter (`packages/loom-core/src/orchestrator/workerFactory.ts`
selects between them):

| Backend | Stream-in surface | Stream-out surface | Notes |
|---|---|---|---|
| **`claude-cli`** (default) | `--input-format stream-json` accepts a JSONL stream of user messages on stdin until EOF | `--output-format stream-json --verbose` emits one JSON event per line, including `result`, `assistant`, `system` types | `--include-partial-messages` adds incremental deltas; `--replay-user-messages` echoes stdin user messages back on stdout for ack. Verified via `claude --help` on the local install (`/opt/homebrew/bin/claude`). |
| **`cursor-cli`** | None. `cursor-agent -p` reads a single prompt from argv or stdin and exits. `--stream-partial-output` only governs output. | `--output-format stream-json --stream-partial-output` (output only) | Verified via `cursor-agent --help`. No equivalent of `--input-format stream-json`. |
| **`anthropic-api`** | `client.messages.create` is request/response. `client.messages.stream` returns a `MessageStream` with `.abort()` (`node_modules/@anthropic-ai/sdk/lib/MessageStream.d.ts:41`) and an `AbortController` (line 22). Mid-stream injection of a new user message is not supported by the API. | SSE deltas via the SDK's stream | Loom's `AnthropicClient` (`packages/loom-core/src/llm/AnthropicClient.ts`) currently only uses non-streaming `messages.create`. |

The single most important finding for this research: **the `claude` CLI
already supports realtime streaming input**. The flag `--input-format
stream-json` is explicitly documented as "realtime streaming input" in the
CLI's own `--help` output. That is the **upstream-sanctioned mid-spawn
injection surface**. None of the workarounds below need to exist for the
default backend if we adopt this flag.

## Candidate mechanisms

Each candidate is evaluated against the same axes. Sources are file:line
references inside loom or upstream CLI help text reproduced above.

### Candidate 1 — File-watch + soft interrupt (worker-side)

The worker is modified to re-check `.loom/guidance/<story-id>.md` between
turns and, when the file's mtime is newer than the last read, the supervisor
injects a synthetic user-message into the worker's input stream.

- **Feasibility.** Requires the worker to expose a between-turns hook. Today
  there is none — `BaseCliWorker.spawnAgent` writes the prompt and closes
  stdin (line 450-451). Either (a) the worker must be rebuilt to keep stdin
  open and inject on demand, or (b) the operator-side polling pushes the
  guidance to the worker via whatever mechanism the worker has — which loops
  back to candidates 2/4/5.
- **Latency.** Bounded by the supervisor's poll interval; ~1-2 s achievable.
- **Safety.** Re-reading a markdown file is safe; the prompt structure already
  treats guidance as a "PRIORITY" block (`workerPrompt.ts:73-78`).
- **Backend compatibility.** `claude-cli` ✔ via `--input-format stream-json`;
  `cursor-cli` ✘ (no input-streaming surface); `anthropic-api` partial —
  abort + re-issue, not true injection.
- **Operator UX.** Same as today: `loom_guide_agent` returns the file path.
  Confirmation that the worker actually saw it would require an echo from the
  worker (claude-cli has `--replay-user-messages` for exactly this case).
- **Test surface.** Replace the polling clock with an injectable function;
  fake the watched file via temp dir; assert injected message lands.

**Verdict.** Useful as the *supervisor* side of a streaming-stdin scheme but
not viable as a self-contained mechanism — it has nowhere to push to without
candidate 4.

### Candidate 2 — MCP channel the worker polls (`loom_pull_guidance`)

A new MCP tool exposed to the worker (via the existing `.mcp.json` loom
registers in `loom init`) that long-polls for new guidance. The worker calls
it between meaningful actions; the tool returns immediately if there is
guidance, or holds for N seconds.

- **Feasibility.** Easy on the loom side — a new handler beside `guideAgent`
  in `packages/loom-mcp/src/tools/handlers.ts`. The hard part is *prompt
  discipline*: the worker prompt must instruct the agent to call this tool
  periodically. Self-imposed periodicity in an LLM is brittle. Workers will
  forget, especially deep in a tool-call chain.
- **Latency.** Operator-typed → worker-seen ≤ poll interval + the worker's
  willingness to call the tool. Without periodicity guarantees this can be
  arbitrarily long.
- **Safety.** Polling is a state read; no risk to worktree.
- **Backend compatibility.** All three. MCP is the shared substrate.
- **Operator UX.** Same as today, plus the worker can be instructed to ack
  via a follow-on tool call ("I read the guidance and will incorporate X").
- **Test surface.** Pure unit test against the MCP handler; the worker side
  is prompt-only.

**Verdict.** A complement, not a substitute, to candidates 4 / 5. As a
standalone mechanism it depends entirely on the model's compliance with the
"call this tool every N actions" instruction — exactly the property that
breaks down in tool-use loops where the agent gets focused.

### Candidate 3 — Signal-based interrupt (SIGUSR1 to the worker pid)

Operator sends SIGUSR1 (or SIGHUP) to the worker pid (which loom already
records via `Supervisor.onPid` → `agents.worker_pid`). The worker installs a
signal handler that flushes the guidance file into the next prompt boundary.

- **Feasibility.** Loom does not own the worker process — `claude` and
  `cursor-agent` do. Loom cannot install a signal handler inside them. The
  CLIs themselves do not document any handler for SIGUSR1 (verified via
  `claude --help`; none mentioned).
- **Latency.** N/A — there is no handler to deliver to.
- **Safety.** Sending an unmodeled signal to a foreign CLI risks termination.
  Claude Code's documented behavior on SIGTERM is "exit"; SIGUSR1 default
  action on POSIX is also terminate.
- **Backend compatibility.** None.
- **Verdict.** Not viable. Loom does not own the binary; signals cannot be
  repurposed inside someone else's CLI.

### Candidate 4 — Subprocess stdin injection (claude streaming input)

Loom keeps the worker's stdin open and writes additional JSONL user-message
events whenever `.loom/guidance/<story-id>.md` changes (or on an explicit
`loom_guide_agent` invocation). The `claude` CLI consumes them via
`--input-format stream-json` and incorporates them into the live
conversation.

- **Feasibility.** Requires three changes in `BaseCliWorker`:
  1. Pass `--input-format stream-json` and write the initial prompt as a
     JSONL user message rather than raw text.
  2. Hold stdin open after the initial write (today
     `BaseCliWorker.spawnAgent` calls `child.stdin.end()` immediately —
     line 451). Track when the agent finishes naturally (the `result` event
     in `parseStreamLine`) to close stdin at the right time.
  3. Expose a `pushUserMessage(text)` method (or a callback on
     `WorkerAssignment`) that the supervisor can drive from a file watcher
     on `.loom/guidance/<story-id>.md` or from an event the
     `loom_guide_agent` MCP handler emits via the existing in-process event
     bus (`Supervisor.opts.onWorkerEvent`).
- **Latency.** Subprocess-pipe write + claude's between-turn event loop.
  Realistically sub-second under typical load; bounded by the agent's
  current operation (a long `Bash` invocation has to finish before the
  user message is processed by the agent, but it queues into the
  conversation immediately).
- **Safety.** No worktree mutation. No risk to audit log — the existing
  `OperatorGuidance.add()` already logs. The injected message is a
  conversation-level event; it does not bypass the policy engine because
  the worker still issues tool calls via Bash and those still go through
  the `loom guard hook`.
- **Backend compatibility.**
  - `claude-cli` — supported and documented (`--input-format stream-json`).
  - `cursor-cli` — **not supported**. Fall back to the existing
    per-revision pickup for this backend. The doc must call this out so
    operators on Cursor know the new latency only helps `claude-cli`
    workers.
  - `anthropic-api` — would require migrating `AnthropicClient` to use
    `messages.stream` and implementing append-on-next-turn (the SDK
    supports `.abort()` but not message injection; a clean abort + resume
    with the appended message in a fresh `messages.stream` call is
    possible but loses the in-flight assistant turn).
- **Operator UX.** Two improvements over today:
  1. The `loom_guide_agent` response can report which workers received the
     message (`pushUserMessage` returns synchronously).
  2. With `--replay-user-messages`, the worker echoes the message back on
     stdout, which the existing trace pipeline (`ClaudeCodeWorker.parseStreamLine`,
     lines 78-117) can record as a `kind: 'guidance_acknowledged'` trace
     visible in `loom_get_decision_traces`.
- **Test surface.** Subclass `BaseCliWorker` in tests (the spawn function
  is `protected` — line 354 — explicitly so tests can stub it). Replace
  the child process with a `PassThrough` pair, assert that
  `pushUserMessage` writes a valid JSONL line, and that the stream-json
  parser would treat it as a user-message event. The existing
  `OperatorGuidance.test.ts` is the right starting fixture.

**Verdict.** The **lowest-latency, upstream-sanctioned, behavior-preserving**
mechanism for the default backend. The CLI was designed for this.

### Candidate 5 — Provider-side interruption (Anthropic SDK abort + resume)

For the `anthropic-api` backend only: the supervisor calls
`MessageStream.abort()` on the in-flight stream, captures whatever the
assistant produced up to that point, then issues a new `messages.stream`
request with the captured history plus the operator's message appended as
the next user turn.

- **Feasibility.** Requires migrating `AnthropicClient` from `messages.create`
  to `messages.stream` (one of the two surfaces is exposed in
  `messages.d.ts:22-24`). Loom's current usage in `AnthropicClient.complete()`
  has no streaming code path. Doable in ~50 lines.
- **Latency.** Network round-trip to abort + re-issue. ~1-3 s.
- **Safety.** Partial assistant output is discarded; if the assistant was
  mid-tool-call the tool call result is lost. Worktree mutations from
  already-completed tool calls are intact.
- **Backend compatibility.** `anthropic-api` only.
- **Operator UX.** Same as candidate 4.
- **Test surface.** Stub `MessageStream`; assert abort + re-issue carries the
  injected user turn.

**Verdict.** Necessary if the operator wants live steering on the API
backend. Lower priority than 4 because most users today run `claude-cli`.

### Candidate 6 — Worker rebuilt as a long-lived event loop

Replace the one-shot worker model with a long-lived agent process loom owns
end-to-end. The worker is a node process inside loom that drives the
Anthropic SDK (or the `claude` CLI in interactive mode) and pulls operator
messages off an in-process queue between tool calls.

- **Feasibility.** Highest refactor cost. The `WorkerRunner` interface
  (`packages/loom-core/src/orchestrator/WorkerRunner.ts:143-145`) is built
  around a single `run(assignment)` promise. Subclasses
  (`ClaudeCodeWorker`, `CursorAgentWorker`) inherit from `BaseCliWorker`
  which assumes a one-shot subprocess. Moving to a long-lived event loop
  would touch every test that fixtures a worker, the supervisor's
  dispatch, and the watchdog (which today depends on the same one-shot
  shape — `Supervisor.ts:493-503`).
- **Latency.** Optimal — bounded only by the agent's between-turn cadence.
- **Safety.** Worktree-isolation guarantees still hold (the worker runs
  inside the worktree). Audit-log invariants need re-verification.
- **Backend compatibility.** Re-implements the world from scratch; in
  practice means the API backend gets priority and the CLI backends
  become wrappers around interactive-mode invocations (`claude` without
  `-p`, parsing the same `stream-json`).
- **Operator UX.** Best of any candidate.
- **Test surface.** Largest. The whole supervisor + worker contract changes.

**Verdict.** The eventual destination if loom decides operator-in-the-loop is
a core feature. Today, the cost is out of proportion to the operator pain
that motivates this research.

### Candidate 7 — Other mechanisms surveyed

- **Named pipe / FIFO between supervisor and worker.** Reduces to candidate
  4's stdin scheme without claude's documented support. The same data flow,
  but without the upstream-sanctioned input format, means the worker has
  no protocol for incorporating the message. Not viable without candidate
  2's MCP-tool prompt-side support.
- **Unix domain socket.** Same shape as FIFO; same conclusion.
- **SQLite trigger / notify.** SQLite has no built-in notify (no
  `LISTEN/NOTIFY`); polling is the only consumer mechanism. Equivalent to
  candidate 1 with a different storage backend, but worse: the worker would
  need to query SQLite, which means giving it a Bash command that talks to
  `.loom/loom.db` — a policy-engine-visible action that adds noise.
- **Notification file the worker tails.** Variant of candidate 1, no
  improvement over the existing markdown file.
- **Inject via the `loom_guide_agent` MCP tool itself, server-side.** The
  MCP server (`packages/loom-mcp`) is in-process with the supervisor (both
  share the same SQLite). Today the handler only writes the file. A small
  refactor could have the handler emit an in-process event the supervisor
  consumes — which is the *operator-side* of candidate 4 (push into stdin
  on event, not on file-watch poll). This is preferred over file-watching
  for the recommended path because it avoids the polling interval entirely.

## Comparison matrix

| Candidate | claude-cli | cursor-cli | anthropic-api | Latency | Refactor cost | Owns risk |
|---|---|---|---|---|---|---|
| 1. File-watch + soft interrupt | ✔ (with #4) | ✘ | partial | seconds | low | low |
| 2. MCP `loom_pull_guidance` | ✔ | ✔ | ✔ | model-dependent | low | medium (compliance) |
| 3. SIGUSR1 to worker pid | ✘ | ✘ | ✘ | N/A | N/A | N/A |
| 4. **Stdin injection (stream-json)** | ✔ (native) | ✘ | partial | sub-second | medium | low |
| 5. SDK abort + resume | ✘ | ✘ | ✔ | seconds | medium | medium (lost turn) |
| 6. Long-lived agent process | ✔ | ✔ | ✔ | optimal | high | high |
| 7a. Named pipe / FIFO | needs #2 | needs #2 | needs #2 | sub-second | medium | medium |
| 7b. SQLite trigger | needs #2 | needs #2 | needs #2 | seconds | low | low |

## Recommendation

### Smallest viable change (ship soon)

**Combine candidate 4 (stdin injection for `claude-cli`) with the
event-driven operator side of 7's last bullet — and use candidate 2 as the
explicit cross-backend fallback.**

Concretely:

1. **`BaseCliWorker` learns a `pushUserMessage(text)` hook.** Default
   implementation is a no-op (so `cursor-cli` keeps today's per-revision
   behavior with zero change). `ClaudeCodeWorker` overrides it by writing a
   `{"type":"user","message":{...}}` JSONL line to the held-open child stdin.
   The corresponding CLI args become `--input-format stream-json
   --output-format stream-json --verbose --include-partial-messages
   --replay-user-messages`.
2. **`BaseCliWorker.spawnAgent` stops calling `stdin.end()` immediately.**
   Instead, the initial prompt is written as one stream-json user message,
   stdin stays open, and we close it when the agent emits its terminal
   `result` event (which we already parse in
   `ClaudeCodeWorker.parseStreamLine` lines 67-76).
3. **The `loom_guide_agent` MCP handler emits an in-process event** the
   `Supervisor` consumes. The supervisor looks up the live worker for that
   `story_id` (already tracked in `agents.worker_pid`, plus we add a runtime
   map of `agentId → WorkerRunner`) and calls `pushUserMessage`. If the
   worker's backend does not support it (cursor-cli), the handler falls
   back to today's file-only behavior and the response message says so
   explicitly — preserving operator expectations.
4. **The acknowledgment loop comes for free.** With
   `--replay-user-messages`, the worker echoes the message back as a
   `type: 'user'` event on stdout; we record it as a new decision trace
   (`kind: 'guidance_received'`, `rationale: <message>`). This is the
   first time the operator gets confirmation the worker actually saw the
   guidance mid-spawn — surfaced in the existing dashboard via
   `loom_get_decision_traces`.
5. **Update `docs/capabilities.md` Execution table** — the existing
   `loom_guide_agent` row gains a "Mid-spawn delivery (claude-cli only)"
   note. Add a row to "What loom does NOT do" until cursor-cli has a
   matching surface.

This change is bounded: ~150 lines in `BaseCliWorker.ts` +
`ClaudeCodeWorker.ts`, a handler tweak in `packages/loom-mcp`, and one new
event on the supervisor. Tests are subclass-and-stub against the existing
`spawnAgent` seam (already `protected` for this purpose). No new packages,
no new policy knobs.

A sketch of the worker-side hook:

```typescript
// BaseCliWorker.ts — added to the class
protected pushUserMessage?(text: string): boolean;

// ClaudeCodeWorker.ts — override
private childStdin?: NodeJS.WritableStream;

protected pushUserMessage(text: string): boolean {
  if (!this.childStdin || this.childStdin.writableEnded) return false;
  const line = JSON.stringify({
    type: 'user',
    message: { role: 'user', content: text },
  }) + '\n';
  return this.childStdin.write(line);
}

// In a modified spawnAgent: stash stdin instead of ending it.
this.childStdin = child.stdin;
this.childStdin.write(initialUserMessageJsonl); // not the raw prompt
// closed on the terminal `result` event in parseStreamLine
```

### Longer-term arc

- **Candidate 5 (SDK abort + resume)** ships when the `anthropic-api`
  backend graduates from optional to first-class. The migration from
  `messages.create` to `messages.stream` inside `AnthropicClient` is
  pre-requisite for any streaming feature and should land alongside this
  recommendation as a low-risk refactor.
- **Candidate 2 (`loom_pull_guidance` MCP tool)** is the right fallback for
  `cursor-cli` until cursor exposes streaming input. Implementing it is
  cheap on the loom side; the operator UX cost is the worker forgetting to
  poll, which we mitigate by adding "When you have completed any tool call,
  consider calling `loom_pull_guidance`" to the worker prompt **only for
  cursor backends** — a backend-conditional prompt addition keeps the
  baseline byte-identical for claude-cli.
- **Candidate 6 (long-lived agent)** is the destination if and only if
  operator-in-the-loop becomes a defining property of loom. Today's
  positioning is "two human touchpoints" (brief + approval); inserting a
  third (live steering as a primary mode) is a strategy decision that
  belongs to a separate doc.

## Risks and open questions

- **Stream-json conversation framing.** The exact JSONL shape claude expects
  for a follow-on user message in `--input-format stream-json` is not
  documented in `--help`; the recommendation assumes the obvious
  `{"type":"user","message":{...}}` shape (mirroring the stream-json output
  format) but the implementation PR must verify against the CLI's actual
  parser. A 30-minute spike — write a JSONL line to a held-open stdin,
  observe the `result` event — would confirm.
- **Token accounting.** Each injected message is a new turn; cumulative
  usage already tracked via `parseUsage` in
  `ClaudeCodeWorker.parseStreamLine` (lines 67-76). The per-story budget
  gate (`budgetTokensPerStory`, `BaseCliWorker.spawnAgent` lines 397-404)
  remains correct without change.
- **Watchdog interaction.** `WorkerWatchdog` (`WorkerWatchdog.ts`) kills
  the worker after `killSec` seconds with zero edit-class tool calls. An
  injected guidance message that nudges the worker into an edit resets the
  spiral but the watchdog clock does not reset. Acceptable for v1 (the
  edit-count condition is what matters), but a future story might want
  "operator guidance bumps the killSec".
- **PR-comment surface.** Mid-spawn guidance is not yet visible on the PR
  the worker opens. The PR body is built in `BaseCliWorker.prBody`
  (line 569-580) from the story spec only. A small follow-up: if guidance
  was applied, include "Operator guidance applied during this run" with a
  link to the audit row.

## Confidence and source notes

- All file:line citations refer to `main` at the time of writing.
- `claude --help` and `cursor-agent --help` were run against the local
  installs (`/opt/homebrew/bin/claude`, `/opt/homebrew/bin/cursor-agent`)
  to verify the streaming-input surface claims. Reproducible with
  `claude --help | grep input-format` and `cursor-agent --help | grep
  input-format` (only claude returns a hit).
- The Anthropic SDK version pinned in `node_modules/@anthropic-ai/sdk/package.json`
  is `0.27.3`. `MessageStream.d.ts` exposes both `controller: AbortController`
  and `abort(): void` (verified file:line).
- The `OperatorGuidance` write path and prompt injection point are
  fully covered by `packages/loom-core/src/__tests__/OperatorGuidance.test.ts`,
  which is the right fixture-style template for the new mid-spawn injection
  tests.

## Spike findings (2026-06-02)

The 30-minute upstream-protocol spike landed under
`scripts/manual/spike-claude-streamjson.mjs`. All four risks flagged
in the v1 plan resolved cleanly:

1. **JSONL shape works as documented.** Writing
   `{"type":"user","message":{"role":"user","content":"<text>"}}\n` to
   the held-open stdin of `claude -p --input-format stream-json
   --output-format stream-json --verbose --include-partial-messages
   --replay-user-messages` produced a turn for each line. Both the
   initial prompt and a mid-spawn second message were consumed; total
   round-trip from push to second `result` was ~1.3s on the local
   install (Sonnet equivalent — the spike happened to route to
   `claude-opus-4-7` per the session config).

2. **Replay echo is `string` content, not array.** The
   `--replay-user-messages` echo arrives as a `type: 'user'` event with
   `message.content` typed as a bare string. The
   `parseStreamLine` `guidance_received` branch should treat string as
   the primary case; an array-of-content-blocks branch is defensive
   coverage only.

3. **System-prompt cache survives mid-spawn injection.** First-turn
   usage: `cache_read=18030, cache_creation=13407`. Second-turn usage
   (after mid-spawn push): `cache_read=31437, cache_creation=25`. Only
   25 new cache-creation tokens vs. the prior turn's 13407 — the
   prefix is intact. Winston's prompt-cache invariant (review note S4)
   is satisfied.

4. **No new `parseStreamLine` branches needed beyond `type:'user'`.**
   The flags `--include-partial-messages` and `--verbose` introduce
   `system/status`, `rate_limit_event`, and `stream_event` (wrapping
   `message_start` / `content_block_*` deltas). All correctly fall
   through to the existing `return {}` default in
   `ClaudeCodeWorker.parseStreamLine` (lines 119-124). Confirmed by
   the spike's event-type enumeration.

The spike output is at `/tmp/loom-spike-<timestamp>.json` for any
future re-run.

## Methodology

This research used the `bmad-technical-research` skill's discipline: explicit
sub-questions, exhaustive candidate enumeration, comparison axes shared
across candidates, and a recommendation that ties the smallest viable change
to a longer-term arc. The collaboration model in the skill is interactive
(`[C] Continue` gates between steps); this session ran under Auto Mode and
collapsed the gates while preserving the discipline. The skill's six-step
template (scope → tech overview → integration patterns → architecture →
implementation → synthesis) was used as a structuring checklist rather than
a literal section-per-step layout, because the question is concrete and
loom-specific — broad market scans would have diluted the recommendation.
