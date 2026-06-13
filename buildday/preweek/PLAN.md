# Pre-Week Plan — Build loom to v2/v3 before Build Day

**Context (read this cold):** Jerome is entering the Claude Fable 5 Build Day
hackathon. Strategy is the HYBRID plan: this week, loom builds loom up to
v2.0 (Fleet Commander) and ideally v3.0 (Signal Scout), dogfooding its own
pipeline. On build day, loom is the *harness* (allowed prior work) and the
build target is a NEW product: the finance/reconciliation module of a home
management platform (see `../briefs/`). Judges score the build-day work;
this week's loom work is preparation, not demo material.

## Releases to ship this week (in order)

| Priority | Epic | Brief | Outcome |
|---|---|---|---|
| 1 — first | Epic A: Review Forge | `briefs/epic-a-review-forge.md` | BMAD skills ported headless; better unattended review for everything after |
| 2 — non-negotiable | Epic B: Fleet Commander | `briefs/epic-b-fleet-commander.md` | **v2.0**: decision inbox, autonomy dial, fleet board, deployable read-only mission control |
| 3 — strongly wanted | Epic C: Signal Scout | `briefs/epic-c-signal-scout.md` | **v3.0**: signal scanners → opportunity board → auto-scoped epics at the approval gate. Powers the build-day "Module 2" demo beat |
| 4 — optional | Epic D: Flywheel | `briefs/epic-d-flywheel.md` | **v4.0**: auto-retrospectives + lessons. Only if the week goes fast |
| 5 — cleanup | Epic E: BMAD removal | `briefs/epic-e-bmad-removal.md` | Prune vendored `bmad-*` skills now that loom relies on its own. Run AFTER Review Forge reviewers are confirmed wired (epic-002 / PR #4) |

Acceptance for each release: `RUBRIC.md` in this directory (85/100 + all
global gates, graded by a fresh verifier subagent). Tag releases
(`v2.0.0`, `v3.0.0`).

## Method

Every change ships through loom itself: `loom epic <brief>` → review plan →
approve → `loom run` → review gate → integration gate → PR → merge. Use
`loom status --watch` / MCP tools to monitor; `loom guide` only when a worker
stalls. Keep CLAUDE.md invariants (structural policy engine, capabilities.md
updated in the same PR, audit logging, prompt caching, agentskills.io
format). The loom guard hook blocks `&&` chaining — run commands separately.

## Autonomy / TDD config (so the day needs few clarification stops)

Goal: the model self-corrects to "done" without asking. Two levers —
configure both pre-week and prove them in practice runs:

- **Day policy** (already-supported knobs): `phases=on` (worker splits
  implement→verify), `qa_planning` on (Tessa emits risk-based test specs per
  story), `integration_gate=block`, review `block-and-revise`. The passing
  test suite is the verifier that lets a worker stop on its own.
- **Test-FIRST worker** (small loom tweak): bias the Amelia worker persona /
  worker-prompt to derive tests from the story's acceptance criteria, commit
  them red, then implement to green — not test-after. Land + verify this in
  pre-week so it's battle-tested before the day.
- **Briefs as the test spec**: every story carries *executable* acceptance
  criteria ("done = these assertions pass"). This kills *verification* stops;
  brief completeness (no `ready:false` open questions at the gate) kills
  *input* stops. Both matter.

## Suggested cadence (relative days; event date = D-0)

- **D-7 → D-5**: Epic A, then Epic B (can overlap once A's plan is approved).
  Ship + deploy v2.0. Deploy target = Vercel (CLI + optional operator MCP);
  cloudflared tunnel fallback.
- **D-4 → D-2**: Epic C. Ship v3.0. Verify Signal Scout end-to-end on the
  loom repo itself (signal → opportunity → scoped epic → approval gate).
- **D-1 (freeze day)**: NO new loom features. Full dry run: `loom init` in a
  throwaway repo, run a toy epic end-to-end, confirm mission control shows it
  and Signal Scout scans it. Assemble the build-day data kit (below). Tag
  final pre-event state.

## Build-day data kit (assemble by D-1)

Real data, zero API approvals needed on the day:

- [ ] **Bank**: export 2–3 months of transactions as **Excel** (`.xlsx`) from
      the bank portal (the only formats available are Excel or PDF; Excel is
      the reliable path). Optionally grab a PDF statement too, to exercise the
      optional PDF-via-vision adapter.
- [ ] **Receipts**: photograph 10–20 real big-box receipts (Costco, Target,
      etc.). Mark which ones are OK to publish in the public demo.
- [ ] **Amazon (primary)**: request the order-history export via Amazon
      Privacy Central ("Request My Data" → Your Orders); usually ready in
      hours. Use `Retail.OrderHistory.1.csv` — it has per-shipment, per-item
      rows (Shipment Item Subtotal, Total Owed, Ship Date, Payment Instrument
      Type) that match Amazon's per-shipment bank charges. Do this a few days
      early in case it's slow.
- [ ] **(OPTIONAL) Order emails (.eml)**: NOT needed for the demo — Amazon
      CSV + receipts cover online + in-store. Only export a few `.eml` files
      if you want to exercise the optional long-tail adapter. If used, they
      are INPUT DATA ONLY; the parser is written from scratch (greenfield
      rule: `buildday/GOAL.md` + `RUNBOOK.md`), never imported from a prior
      project.
- [ ] **Privacy split**: decide the curated "demo household" dataset
      (publishable receipts + synthetic-but-realistic bank lines) for the
      public URL, vs. real data shown only in the recorded video. Real
      personal financial data is NEVER committed to any repo.
- [ ] `gh` authenticated; product name chosen (working placeholder in briefs:
      "the home platform").
- [ ] **Vercel ready**: account + **Vercel CLI** logged in (required — this is
      the deploy path). **Vercel MCP** is an optional operator diagnostic
      (logs/status/env); it's available because the *agent running loom* does
      the deploy from your interactive session, not a headless worker. Add it
      in the submission repo at kickoff with:
      `claude mcp add -s project --transport http vercel https://mcp.vercel.com`
      (`-s project` writes a committable `.mcp.json` → reproducible; OAuth on
      first use, no secret in config). Deploy is an orchestration step the
      loom-driving agent runs (scripted `vercel --prod`), NOT a worker story —
      keep the Vercel token out of worker worktrees.

## Handoff notes for whoever (whatever) runs this week

- Loom repo state when this plan was written: v1 complete (19 CLI commands,
  19 MCP tools, 97 test files, 17 self-delivered epics, `npm run build` /
  `npm run test` green). Web dashboard already has federated status,
  approve/stop/retry, SSE streams — Epic B extends, not rewrites.
- BMAD skill audit (for Epic A): top headless candidates are
  bmad-review-adversarial-general and bmad-review-edge-case-hunter (nearly
  ready), bmad-investigate (strip user-waits), bmad-distillator (nearly
  ready), bmad-retrospective (extract ONLY automated lesson-synthesis).
  All depend on `_bmad/scripts/resolve_customization.py` +
  `_bmad/bmm/config.yaml` — ports must remove that dependency entirely.
- Build-day kit lives in `../` (RUNBOOK.md, GOAL.md, RUBRIC.md, briefs/).
  If the week slips and v2.0 doesn't ship, the fallback is the original
  loom-builds-loom plan: run Epics B/C live at the event using this
  directory's briefs and rubric as the day's targets.
