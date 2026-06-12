---
title: "Epic 13 — Staff Engineer Review"
reviewer: Claude (Sonnet 4.6)
date: 2026-05-22
status: reviewed
---

# Epic 13 Review: Cursor CLI Backend

Reviewing the Cursor backend — `CursorCliClient` (planner), `CursorAgentWorker`
(story execution), the `BaseCliWorker` extraction, and backend selection
(`llm_backend` / `worker_backend` / `modelFor`).

One real bug was caught while writing this review and fixed before sign-off (see
"Caught and fixed"). The headline finding is a guardrail-parity gap that is
documented and has a clear mitigation, not a blocker.

## Caught and fixed during the build

**A. The planner sent Claude model ids to `cursor-agent`.** With
`llm_backend: cursor-cli`, the planner was still wired to
`policy.agents.planning_model` — a Claude id (`claude-sonnet-4-6`) — and passed
it straight into `cursor-agent --model`. Cursor uses its own model ids
(`sonnet-4`), so the planner would have failed (or silently fallen back) on
every Cursor-backend run. The same mismatch hit skill generation
(`skill_gen_model` → a Claude Haiku id). Fixed by adding `modelFor(policy, role)`
in `llm/factory.ts`: when the backend is `cursor-cli` it returns `cursor_model`
for every role; otherwise the role-specific Claude id. All four call sites
(`epic.ts`, `run.ts`, `eval.ts`, MCP `startEpic`/`approvePlan`) now route
through it. This is the kind of cross-cutting wiring bug that a single-backend
unit test never surfaces — it only appears when the two model-id namespaces
collide.

## Findings — documented

### High

**1. The Cursor worker backend has no structural PreToolUse guardrail.**
- loom's command guardrail is a Claude Code PreToolUse hook
  (`loom guard hook` in `.claude/settings.json`). `cursor-agent` does not read
  that file, so a `worker_backend: cursor-cli` agent running
  `cursor-agent --force --trust` executes Bash **without** the per-command
  policy check (`rm -rf`, `git push --force`, writes to `protected_paths`).
- This is not "Cursor is unsafe" — two of the three guardrail layers still hold:
  worktree isolation (the Cursor worker cannot touch other stories' worktrees)
  and the push gate (`allowed_remotes` is enforced in `BaseCliWorker`, not the
  hook, so a Cursor worker still cannot push to a disallowed remote or self-merge
  a PR). What is missing is *Layer 2* — in-worktree destructive-command
  interception.
- The Cursor *planner* (`--mode ask`) is read-only and unaffected.
- Mitigation: prefer `worker_backend: claude-code` for unattended runs; run the
  Cursor worker under `loom run --checkpoint` with human diff review.
- Fix path: Cursor supports a hooks mechanism. `loom init` should register a
  Cursor hook that shells out to the *same* `loom guard hook` entrypoint — that
  entrypoint is already backend-agnostic (reads a command from stdin JSON), so
  only the Cursor-side registration is missing. This is a real follow-up, not a
  spec footnote — recommend it lands before the Cursor worker is advertised as
  a peer of the Claude worker. Tracked in `docs/known-limitations.md`.

### Medium

**2. `cursor-agent` JSON output is parsed defensively, not contractually.**
- `parseCursorJson` tries `result` / `text` / `response` / `content` / `message`
  and falls back to raw stdout. Claude Code's `--output-format json` schema is
  stable enough to parse strictly (`parseClaudeJson` does); Cursor's is not
  pinned, so the parser is deliberately forgiving. A Cursor release that renames
  its output field would degrade silently to "raw stdout" rather than erroring.
- Acceptable for now — raw stdout is still usable planner output — but it means
  a Cursor output-schema change fails quiet. Revisit if Cursor publishes a
  stable schema.

### Low

**3. `loom doctor` only warns when `cursor-agent` is absent.**
- Cursor is optional, so a missing `cursor-agent` is warn-level. A project
  configured for `worker_backend: cursor-cli` with no `cursor-agent` installed
  passes `doctor` and fails at run time instead. `doctor` could read
  `policy.yaml` and escalate the probe to required when the Cursor backend is
  actually selected.

## Downstream impact matrix

| Finding | Epic 14 (pi.dev UI) | Epic 11 (multi-product) |
|---|---|---|
| A model-id mismatch (fixed) | — | — |
| #1 Cursor worker guardrail gap | UI must surface which worker backend is active so a reviewer knows whether Layer 2 is on | a multi-product run mixing backends inherits the weakest guardrail per product |
| #2 defensive JSON parse | — | — |
| #3 doctor warn-only | onboarding panel should show the effective backend + its prereq state | — |

## What's solid

- **The `BaseCliWorker` extraction removed duplication instead of adding it.**
  This was the explicit risk the user flagged ("did we write redundant feature
  code?"). The answer here is no: the shared run flow (worktree spawn, commit
  counting, PR open, remote gating, log tail) lives once in `BaseCliWorker`;
  `ClaudeCodeWorker` and `CursorAgentWorker` are each ~15 lines — just
  `binary()` and `agentArgs()`. Adding a third CLI worker later is a subclass,
  not a copy-paste.
- **The `LLMClient` seam paid for itself.** `CursorCliClient` slotted in beside
  `ClaudeCliClient` / `AnthropicClient` / `MockLLMClient` with no change to the
  planner — the seam designed in Epic 1/2 absorbed a whole new backend.
- **The no-API-billing constraint is honored on both Cursor paths.** Planner and
  worker both run session-based `cursor-agent` — no API key, no API expenditure.
  `anthropic-api` remains the only opt-in billed path.
- **Never MAX mode.** `agentArgs()` always passes an explicit `--model`; there is
  no `--max` flag anywhere. The constraint is structural, not a prompt reminder.
- **`modelFor` keeps the two model-id namespaces from leaking.** Claude ids and
  Cursor ids never cross now — the resolution happens once, at the factory.

## Verdict

Epic 13 is sound and the build is green (237 tests). Finding #1 is the one to
act on: the Cursor worker is safe *enough* to ship behind a checkpoint, but it
is not yet a guardrail-equal peer of the Claude worker. Recommend the Cursor
hook registration is scheduled as the first follow-up after the current epic
queue, and that `worker_backend: claude-code` stays the default until then —
which it is.
