# Build Day Rubric

Graded by a **fresh verifier subagent** with no builder context. Every item is
pass/fail with cited evidence (file path, command output tail, URL, or
audit-log row). No partial credit unless a range is stated.

**Ship threshold: 85/100 for the release section in play + ALL global items.**

## Global gate (every release) — must be 40/40

| Pts | Check | Evidence required |
|---|---|---|
| 10 | `npm run build` and `npm run test` pass on main | output tails |
| 5 | `docs/capabilities.md` updated in the release PR | diff hunk |
| 5 | Every change traceable to a loom epic | `epics/<id>/` artifacts + audit_log rows |
| 10 | Verifier reproduces the headline feature using only README/docs | steps followed, result |
| 5 | Zero policy violations in audit_log for the release window | query result |
| 5 | Tag + release notes exist | `git tag -n` |

## v2.0 Fleet Commander — /60

| Pts | Check |
|---|---|
| 15 | Public deployed URL returns 200 and renders ≥2 real epics from today with per-story agent status, branch, and review state |
| 10 | **Decision inbox**: every pending human gate across all epics in one view; approve and reject both work end-to-end from the UI (state change lands in SQLite + audit log) |
| 10 | **Autonomy dial** per epic — at minimum `full-auto` / `checkpoint` / `manual` — persisted in policy/state and actually enforced by the supervisor (prove with one epic per mode, or tests) |
| 10 | Fleet view scales: ≥2 epics running concurrently displayed without state bleed (cross-epic concurrency cap respected) |
| 10 | Live activity: streaming or near-live worker output/decision traces visible per agent |
| 5 | Read-only mode safe to share publicly (no mutation routes without token) |

## v3.0 Signal Scout — /60

| Pts | Check |
|---|---|
| 15 | Signal scanners ingest ≥3 distinct REAL sources from this repo/org (e.g., GitHub issues, failing/flaky CI or test output, TODO/FIXME scan, audit-log failure patterns) — no fabricated signals |
| 15 | **Opportunity board**: signals clustered into ranked opportunities with rationale + evidence links, persisted in SQLite, visible in mission control |
| 15 | **Auto-scoping**: selecting an opportunity (or auto-trigger above a score threshold) runs the existing planner and produces a real epic with brief/PRD/stories that passes the brief-quality gate |
| 10 | Scoped epic lands in the decision inbox for human approval — discovery NEVER auto-executes without a gate |
| 5 | At least one discovered-scoped-approved-shipped cycle completed today, end to end |

## v4.0 Flywheel — /60

| Pts | Check |
|---|---|
| 20 | Auto-retrospective runs after epic completion: distills lessons from decision traces, review findings, retry history into structured lessons (persisted) |
| 15 | Lessons change future behavior: at least one lesson becomes a skill, policy adjustment, or persona guidance injected into the NEXT epic's workers (show the injection) |
| 15 | Loom proposes its own next epic from accumulated lessons + signals, queued at the approval gate |
| 10 | The full loop demonstrated once: retro → lesson → proposal → human approval visible in mission control |

## Epic A — Review Forge (enabler, graded inside whichever release it ships with) — /20 bonus

| Pts | Check |
|---|---|
| 10 | ≥3 BMAD-derived skills run headless with zero `_bmad/` config dependency, in agentskills.io format, selectable by the skill system |
| 5 | Adversarial review + edge-case hunter wired into the worker verify phase or review loop (audit-log evidence of real use today) |
| 5 | Measurable effect cited in SESSION_LOG.md (e.g., a defect caught by the new review pass before the integration gate) |

## Session-log quality (submission artifact, not gated) — checklist

- [ ] Every human interaction logged and classified (governance gate / course correction / new information)
- [ ] Every self-caught failure logged with the catching mechanism named
- [ ] Timestamps throughout; longest unattended stretch computed at end of day
