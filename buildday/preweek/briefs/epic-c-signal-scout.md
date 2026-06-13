# Epic C — Signal Scout: loom finds its own work (v3.0)

## Problem

Loom is briefing-in, work-out: a human must notice a problem, write a brief,
and start an epic. The next leap is discovery — loom continuously scans
signals, identifies opportunities, and scopes them into ready-to-approve
epics. The human's job shifts from "write briefs" to "approve direction."

## Who it's for

Fleet commanders who want loom proposing work, and teams whose backlog
signal is scattered across issues, CI, and code comments.

## What to build

A discovery pipeline in `packages/loom-core` (new `signals/` module) +
surfacing in mission control:

1. **Signal scanners** (pluggable interface; ship ≥3 real ones):
   - GitHub issues/PR comments on this repo (`gh` CLI is available).
   - Test/CI health: failing or flaky tests, integration-gate failures from
     recent runs.
   - Code debt: TODO/FIXME/HACK scan with file/age context.
   - Loom introspection: audit_log + retry patterns (e.g., recurring worker
     failures = a tooling opportunity).
   Signals persist to SQLite with source, evidence link, timestamp.
2. **Opportunity engine** — cluster related signals into opportunities,
   scored (impact/effort/confidence) with written rationale. Persisted,
   ranked, displayed as an opportunity board in mission control.
3. **Auto-scoping** — "Scope this" (or auto-trigger above a threshold) feeds
   the opportunity + evidence into the existing planner pipeline
   (BriefRefiner → Mary → John → Winston) producing a real epic that passes
   the brief-quality gate.
4. **Governance invariant** — a scoped epic ALWAYS lands at the human
   approval gate in the decision inbox. Discovery never self-executes.

## Done means

- ≥3 scanners produce real signals from this repo today (no fixtures in the
  demo path).
- Opportunity board live in deployed mission control with rationale +
  evidence links.
- One full cycle today: signal → opportunity → scoped epic → human approval →
  shipped through the normal pipeline.
- Tests for scanner interface, clustering, and the never-auto-execute
  invariant; `docs/capabilities.md` updated (and move the relevant "what loom
  does NOT do" entry).

## Non-goals

- Slack/Jira/telemetry connectors (interface should accommodate them later;
  do not build them today).
- Web crawling or external market research.
- Auto-approval of discovered work — explicitly forbidden.
