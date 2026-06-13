# Opus 4.8 Build Day — Runbook (Hybrid Plan)

**The play:** loom (pre-built to v2/v3 this week — see `preweek/PLAN.md`) is
the harness. On build day, a loom agent fleet builds a NEW product from a
standing start: the **finance/reconciliation module** of a subscription home
management platform. Mission control governs the fleet; Signal Scout
proposes "Module 2" in the afternoon as the roadmap beat.

**The product pitch (use these words):** "Your bank says Costco, $234.17 —
what did you actually buy?" It is an **intelligent parsing loop for ambiguous
bank-statement entries**: it resolves each cryptic line into item-level truth
by reconciling receipts and order data against it, classifying, flagging what
it's unsure of, and learning from your corrections. Never "budgeting app,"
never lead with charts; the subject of every sentence is the ambiguous bank
line, not the image or the dashboard.

## Competition framing — non-negotiable

- **Banned-list adjacency**: "Image Analyzers" and "dashboard as main
  feature" are prohibited. Hold these four demo disciplines: (1) the subject
  of every sentence is the **ambiguous bank entry** and how the loop resolves
  it; (2) receipt/PDF vision appears ONLY as *evidence the loop pulls in*,
  never demoed standalone as "AI reads an image"; (3) open the UI on the
  **review queue** (interactive triage), never on a chart; (4) the true-spend
  view stays secondary. The main feature is the governed parse→reconcile→
  verify→learn loop — not a visualization, not an image reader.
- **Attribution / Greenfield**: loom = prior tooling, the harness (allowed:
  "bring your product"). The finance product is a BRAND-NEW standalone repo
  created at kickoff — 100% greenfield, 100% build-day work. It imports NO
  code from any prior project: specifically NOT the experimental email-
  orchestration repo. The `.eml` parser, ingestion, everything is written
  fresh during the event. Exported `.eml`/CSV files are input DATA, not code.
  Keeping the build cleanly greenfield (no prior-work entanglement) is what
  makes "everything you see was built today" trivially true and demoable.
  Both repos (loom harness + finance product) public at submission.
  **Pre-week practice happens in THROWAWAY scratch repos, never the
  submission repo** — let loom build a practice finance app, learn where it
  breaks, then throw the code away. Learnings carry forward through briefs +
  loom improvements + memory, NOT code. The submission repo stays empty until
  kickoff.
- **Privacy**: real personal financial data is NEVER committed to any repo.
  Public deploy serves the curated demo household; real data appears only in
  the recorded video, run locally. `.gitignore` for data dirs ships in the
  first scaffold commit.
- **Scope discipline**: chores, calendars, billing/subscriptions are pitch
  material only. Zero build-day code for them — Signal Scout *proposing*
  Module 2 is how the roadmap gets demoed.

## Day-of order of operations

| Time | Action |
|---|---|
| 9:00–10:15 | Check in. Claim credits. Verify: `loom doctor`, data kit on disk, deploy account logged in, `gh` authed. |
| 10:15 | Create the product repo (public). Copy `buildday/GOAL.md`, `RUBRIC.md`, `briefs/` into it. `loom init` there. |
| 10:30 | **Kickoff.** `/goal` with GOAL.md. Answer the model's questions. Hands off. |
| 10:35 | Fleet starts **H1 (Foundation & Ingestion)** + **H2 (Receipt Vision)** in parallel. Approve plans at the gate (governance, logged). Mission control on the second screen all day. |
| ~12:30 | H1 + H2 land (verifier-graded). Start **H3 (Reconciliation & Classification)** + **H4 (Experience & Deploy)**. |
| 1:00 | Lunch while the fleet runs. Mid-day screenshot of mission control with 2 epics in flight. |
| ~14:45 | H3 + H4 land. Deploy live URL with demo household. End-to-end check: receipt photo → line items → matched → classified → true spend. |
| ~15:15 | **Signal Scout beat**: point loom v3 at the day-old product repo + product brief. It surfaces opportunities and scopes "Module 2: chore generation" to the approval gate. Record this moment. |
| 15:30–16:10 | Polish pass through loom only (one targeted epic or guidance): demo-path bugs, review-queue UX. |
| 16:15 | **Feature freeze.** Verify: URL 200, tests green, no real data in either repo (`git grep` for account numbers), SESSION_LOG.md complete with interventions classified. |
| 16:20–16:50 | Record 1-minute video. Submit: product repo, loom repo, live URL, GOAL.md (brief), RUBRIC.md, session log. |
| 5:00 | **Submit.** Nothing new after 4:15. |

## Demo video beats (60 seconds)

1. (0–8s) Hook: bank statement on screen — "Costco. $234.17. What did I
   actually buy?"
2. (8–25s) Receipt photo → 14 line items, `KS ORG EVOO` disambiguated to a
   real product → matched to the bank line → item-level true-spend by
   category. Then the Amazon beat: one order's per-shipment rows reconcile
   against the multiple "AMZN Mktp" charges it became — counted once.
3. (25–38s) The reveal: "This repo was empty at 10:30 this morning." Mission
   control: epics, agents, branches, gates. "I approved N decisions. The
   fleet did the rest."
4. (38–50s) Signal Scout: "Nobody asked it to — loom scoped Module 2,
   chores, and queued it for my approval." Show the gate.
5. (50–60s) "First module of a home OS. One human, a governed agent fleet."

## Demo data path — three sources, NO email needed

The demo runs on three file-based sources; email is intentionally NOT one of
them (Amazon CSV + receipts already cover online + in-store).

1. **Bank export (Excel)** — the spine. Every other source reconciles against
   it. (PDF statement optional, via the vision pipeline.)
2. **Receipt photos** — the vision/disambiguation wow + all in-store
   purchases (Costco, Target, …).
3. **Amazon order CSV** (`Retail.OrderHistory.1.csv`) — online purchases,
   item-level, with per-shipment rows AND returns/refund rows.

**The Amazon reconciliation beat (on-camera):** one Amazon order
(`112-44321`, 3 shipments) appears in the bank export as three separate
"AMZN Mktp US*…" charges on different dates. The engine groups the
per-shipment CSV rows, matches them to the three charges (sum-of-subsets
within a date window), and shows: one order, three charges, item-level
detail, **counted once**. If that order also appears on a scanned receipt,
the dedup merges them — "explained, not double-counted."

**Self-correction beat (no email required):** keep one low-quality receipt
photo and one ambiguous bank line in the kit — the app flags them to the
review queue rather than guessing, demonstrating the verifier behavior live.

**`.eml` is optional, post-demo:** the architecture supports an `.eml` Tier-0
adapter for long-tail non-Amazon online merchants, but it is NOT built or
shown on build day. (For reference, the reason it'd be file-based not live
Gmail: test-mode Gmail OAuth tokens expire every 7 days and restricted scopes
need a multi-week Google review.)

## Failure playbook

- Worker stalls → `loom_guide_agent` once, then `loom retry` (resume). Log it.
- Receipt vision accuracy poor → narrow demo to the 3 best receipts; queue
  flags low-confidence honestly (that's the product working).
- H3 overruns → ship receipt↔bank matching only; Amazon-order↔bank becomes a
  flagged TODO in the queue. Still demos.
- Deploy fights back → cloudflared/ngrok tunnel to local. Still a live URL.
- Loom itself misbehaves → fix forward via a loom epic in the loom repo if
  trivial; otherwise drop to direct Claude Code on the product repo and log
  the intervention honestly. A shipped product beats a pure log.
- Credits: check loom cost roll-ups hourly; below $100 remaining, finish
  in-flight only.

## Fallback

If pre-week slips and loom v2 didn't ship: revert to the original
loom-builds-loom plan using `preweek/` briefs + rubric as the day's targets
(that directory is the complete original kit).
