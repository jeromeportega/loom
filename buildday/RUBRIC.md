# Build Day Rubric — Finance Module

Graded by a **fresh verifier subagent** with no builder context, inside the
product repo. Every item pass/fail with cited evidence (file path, command
output tail, URL, screenshot, or audit-log row). No partial credit unless a
range is stated.

**Ship threshold: ALL global gates + ≥85/100 on milestones.**

## Global gates — must be 30/30

| Pts | Check | Evidence |
|---|---|---|
| 8 | Build + `npm test` (Vitest) green on main — fast/deterministic, gate-safe; `npm run e2e` (Playwright golden path) green as the final smoke | output tails for both |
| 8 | Every change traceable to a loom epic (planning artifacts + audit_log rows in the loom state) | epic IDs + queries |
| 8 | **Privacy**: no real account numbers, balances, or third-party PII anywhere in git history or working tree of either repo | grep/scan commands run + results |
| 6 | SESSION_LOG.md current, timestamped, interventions classified | file review |

## Milestones — /100

### M1 — Foundation & Ingestion (15)

| Pts | Check |
|---|---|
| 6 | Bank statement import: a real exported Excel (`.xlsx`) loads; transactions persisted with normalized merchant/date/amount (credits vs. debits handled) |
| 6 | Amazon order parsing: real `Retail.OrderHistory.csv` parsed into orders with per-shipment line items (incl. returns rows) |
| 3 | Monorepo structured as the home platform with finance as module #1; data dirs gitignored from first commit |

### M2 — Receipt Vision (20)

| Pts | Check |
|---|---|
| 8 | Receipt photo → structured extraction: store, date, total, line items (SKU + abbreviated description + price) |
| 8 | SKU disambiguation: abbreviated names resolved to canonical product + category with confidence score; verified against ≥5 real receipts, ≥80% of line items correctly resolved (verifier hand-checks a sample) |
| 4 | Low-confidence items flagged for the review queue, not silently guessed |

### M3 — Reconciliation & Classification (30)

| Pts | Check |
|---|---|
| 10 | Receipt ↔ bank-line matching (fuzzy amount/date/merchant) demonstrated on real data; matched pairs persisted with rationale |
| 8 | Amazon-order ↔ bank-line matching demonstrated (split-shipment: one order → several charges); a transaction covered by both receipt and order export is deduplicated — **every dollar counted exactly once** (test proves it) |
| 8 | Item-level classifier: line items categorized (groceries / household / electronics / utilities / mortgage / subscriptions / …) with rationale; merchant-level fallback when no item data exists |
| 4 | True-spend rollup by category queryable and consistent with the underlying matches (test) |

### M4 — Experience & Deploy (20)

| Pts | Check |
|---|---|
| 8 | **Review queue** (the UI centerpiece): unmatched / low-confidence items presented inbox-style; confirm/correct actions persist and corrections are reflected in rollups |
| 6 | Public deployed URL returns 200 serving the demo household; full path works there end to end |
| 4 | True-spend view renders item-level category breakdown |
| 2 | Demo household contains zero real sensitive data |

### M5 — Fleet & roadmap evidence (15)

| Pts | Check |
|---|---|
| 6 | ≥2 epics ran concurrently with ≥2 parallel workers each at some point (loom status history / audit log) |
| 5 | Signal Scout proposal: a scoped "Module 2" epic (e.g., chore generation) sits at the approval gate, discovered and scoped by loom — NOT implemented |
| 4 | ≥1 failure caught by an automated mechanism (review agent, integration gate, verifier, test) and fixed without human prompting — cited from SESSION_LOG.md + audit log |

## Session-log quality (submission artifact) — checklist

- [ ] Every human interaction logged + classified (governance gate / course correction / new information)
- [ ] Every self-caught failure logged with the catching mechanism named
- [ ] Longest unattended stretch computed at end of day
- [ ] Total: epics, stories, PRs, agent count, spend
