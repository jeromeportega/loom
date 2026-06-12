# Epic H3 — Reconciliation Engine & Item-Level Classification

## Problem

Even with all three sources ingested, the truth requires joining them: the
$234.17 bank line IS receipt #1042 IS partially order #112-44321. Without
matching and dedup, totals double-count; without item-level classification,
"Costco" is just "Shopping." This epic is the product's core claim:
**every dollar counted once, every dollar explained.**

## Who it's for

The household's "true spend" answer. This engine is what distinguishes the
product from transaction-level budgeting apps.

## What to build

1. **Matching engine**:
   - Receipt ↔ bank line: fuzzy match on amount (exact + tip/adjustment
     tolerance), date window, merchant string similarity, card last-4 when
     available.
   - Amazon order ↔ bank line: handle split shipments (one order → several
     charges; sum-of-subsets matching within a date window). Source is the
     Amazon order CSV, not email.
   - Every match persisted with rationale text + confidence; ambiguous
     candidates go to the review queue, not auto-linked.
2. **Dedup invariant**: when a transaction has both a receipt and an order
   (from the Amazon CSV), item detail merges and the dollar is counted
   exactly once. Write the test FIRST — this is the headline invariant.
3. **Returns & refunds**: refunds are signed-negative events. A `card` refund
   reconciles against a bank CREDIT line (match it like a purchase, opposite
   sign). A `store_credit` / `gift_card` / `account_balance` refund (Costco
   Shop Card, Amazon balance) will NEVER appear on the bank — do not flag it
   as unmatched; instead post it to the `store_credit_balances` ledger.
   **Net spend = purchases − refunds**, and the true-spend rollups must use
   net, not gross. When a later purchase is partly paid from store credit,
   the bank charge is less than the receipt total — reconcile the gap against
   the store-credit ledger rather than treating it as a mismatch. Write a
   test for "refund to store credit → bank shows nothing → net spend still
   correct."
4. **Item-level classifier**: every line item → category (groceries,
   household, electronics, clothing, utilities, mortgage/rent, subscriptions,
   dining, transport, …) with one-line rationale. Recurring-pattern
   detection for fixed obligations (same merchant + amount + cadence →
   mortgage/utility/subscription). Merchant-level fallback classification
   for unmatched bank lines.
5. **True-spend rollups**: by category × month, queryable; uses NET spend
   (purchases − refunds, per item 3); reflects review-queue corrections (H4)
   when they land.
6. **In-app insight flags**: computed signals derived from the rollups,
   surfaced IN the app (review queue / true-spend view) — NOT pushed
   anywhere. Examples: "this Costco trip is 40% above your 3-month average
   for that merchant," "groceries are tracking over last month at this point
   in the cycle," "new recurring charge detected." Each flag carries the
   number and the comparison basis so it reads as insight, not noise. This is
   the "smart" surface; keep it cheap (queries over existing data).

## Done means

- Real-data demo path: ≥3 receipt↔bank matches, ≥2 Amazon-order↔bank matches
  (incl. one split-shipment), ≥1 dedup case (receipt + order + bank all
  linked, counted once).
- Dedup invariant test + matcher unit tests green.
- Every classification carries a rationale; rollups consistent with matches
  (consistency test).
- ≥1 return handled: a card refund matched to a bank credit, AND a
  store-credit refund that posts to the ledger without a bank line; net spend
  correct in both (test).
- ≥2 insight flags compute correctly on the demo household (test).

## Non-goals

- ML training/embedding pipelines — LLM + heuristics are enough today.
- **Outbound notifications of ANY kind** — no email/SMS/push/WhatsApp alerts.
  Insight flags are in-app only. (WhatsApp Business API needs Meta business
  verification measured in days-to-weeks — out of scope today; a future
  notifications module is a natural Signal-Scout proposal, not build-day
  work.)
- Full budgeting/forecasting — measurement + insight flags only, no budget
  envelopes or projections.
- Auto-applying low-confidence matches — the queue exists for a reason.
