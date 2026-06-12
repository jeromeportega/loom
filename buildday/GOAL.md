# /goal — Build the Home Platform Finance Module (via loom)

Paste everything below this line into /goal at kickoff, inside the NEW
product repo (loom already initialized).

---

## Mission

Build, from this empty repo, the first module of a home management platform:
an **item-level finance reconciliation engine**. It ingests bank statement
exports (Excel primary; PDF via the vision pipeline), Amazon order-history
exports (`Retail.OrderHistory.csv`), and receipt photos from big-box stores; disambiguates abbreviated receipt SKUs into real products;
reconciles all three sources so every dollar is counted once; classifies
spending at the item level; and presents a review queue + true-spend view.

You are the fleet supervisor. ALL implementation ships through loom's
pipeline: `loom epic <brief>` → plan → approval gate → parallel workers →
review → integration gate → PR. Briefs are in `buildday/briefs/` (H1–H4).
The rubric is `buildday/RUBRIC.md`. The runbook is `buildday/RUNBOOK.md`.
Read all of them first. Test data lives in the local data kit (operator
provides path) — fixtures for tests must be sanitized copies.

## Definition of done (verifiable without a human)

1. All four epics (H1–H4) merged; build + tests green on main.
2. A **fresh verifier subagent** grades the product against
   `buildday/RUBRIC.md` and it meets the threshold. Builders never grade
   their own work. Failed items become guidance or follow-up stories;
   re-run until green.
3. Deployed public URL returns 200 serving the demo household; the full path
   works there: receipt → line items → match → classification → true spend.
4. **Zero real personal financial data committed** — verifier greps both
   history and working tree for account numbers, real balances, email
   addresses beyond the operator's own.
5. `buildday/SESSION_LOG.md` current: every epic state change, every failure
   caught (naming the mechanism that caught it), every human interaction
   classified (governance gate / course correction / new information).

Floor: H1–H3 + a local demo. Target: all four + deploy. Stretch: polish epic.

## Method

1. Start **H1** and **H2** in parallel. When both land, start **H3** and
   **H4** in parallel.
2. Monitor via `loom_get_status`; steer with `loom_guide_agent` only on
   stall or drift — prefer letting review and integration gates catch
   problems. Long unattended stretches are scored: protect them.
3. After each epic: verifier grade against the relevant RUBRIC section →
   merge → log.
4. ~15:15 local time: run loom's Signal Scout against this repo and the
   product vision (home platform: chores, calendars as future modules).
   Goal: a scoped "Module 2" epic waiting at the approval gate. Do NOT
   implement it.
5. 16:15 local time: hard feature freeze. Execute RUNBOOK submission steps.

## Hard constraints

- **Greenfield**: the product is a brand-new standalone repo, 100% built
  during the event. Import or copy NO code from any prior project — in
  particular NOT the experimental email-orchestration repo. Write the `.eml`
  parser and everything else from scratch. Exported `.eml`/CSV files are
  input DATA only, never a code source. Loom is the harness (allowed prior
  tooling); it is a separate repo and the product does not depend on it at
  runtime.
- Real financial data never enters git (either repo). Data dirs gitignored
  from the first commit. Public deploy = demo household only.
- Loom invariants hold; never bypass or weaken the guard hook / policy
  engine. (It blocks `&&` chaining — run commands separately.)
- Tests green on main at all times; no force pushes; no history rewrites.
- Repos are public: no secrets, tokens, or credentials, ever.
- Budget: check loom cost roll-ups each epic; over $400 projected → finish
  in-flight work only.

## Escalation — interrupt the human ONLY for

1. Plan approvals at policy-required human gates (the product working —
   log as governance).
2. Anything destructive/irreversible outside agent worktrees.
3. A scope conflict between briefs that changes the demo path.

Everything else: decide, record rationale, continue.
