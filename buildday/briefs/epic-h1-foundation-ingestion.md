# Epic H1 — Foundation & Ingestion

## Problem

Household spending truth is scattered across three sources that never meet:
bank transactions (opaque totals), online order records (item detail, no
settlement — e.g. Amazon's order-history export), and paper receipts (item
detail, offline). Before anything can be reconciled, all three need a common
home and reliable ingestion.

## Who it's for

Households who want item-level truth about spending. First module of a
larger home management platform (future modules: chores, shared calendars —
NOT in scope).

## Stack (decided — do not re-litigate; H4 inherits this)

- **Next.js (App Router) + TypeScript** — UI, API route handlers, and the
  receipt-vision job all live in one deployable app.
- **Tailwind CSS** + **shadcn/ui** (Radix-based, Tailwind-styled,
  copy-into-repo components) for the UI, plus the official **`geist` font**
  (Geist Sans/Mono via `geist/font`) for the Vercel-native look. Rationale:
  shadcn components live in-repo and are the most LLM-legible component
  system, maximizing autonomous build velocity. NOTE: there is NO installable
  official Geist *component* library — the official `geist` package is the
  font only, and the community `@geist-ui/core` is being archived in favor of
  Tailwind. Do not depend on either as a component lib; Geist font + Tailwind
  + shadcn/ui is the supported path.
- **Data: libSQL / Turso** (SQLite-compatible, so SQLite idioms carry over)
  for Vercel-friendly persistence — Vercel serverless has NO durable disk, so
  on-disk `better-sqlite3` is forbidden here. (If long-running vision job
  queues become necessary, the fallback is Railway/Fly + a volume; flag it,
  don't switch unilaterally.)
- **Deploy: Vercel**, public URL.

## What to build

1. **Platform scaffold (greenfield)**: a Next.js monorepo structured as the
   home platform with `modules/finance` as module #1, Tailwind + shadcn/ui +
   geist font configured, libSQL client wired up. This is a brand-new
   standalone repo — import/copy NO code from any prior project (NOT the
   email-orchestration repo); write everything, including the `.eml` parser,
   from scratch. Data directories (`data/`, raw uploads) gitignored in the
   FIRST commit — real financial data must never be committable.
2. **Framework-agnostic core**: all business logic (ingestion, parsing,
   matching, classification) lives in a `modules/finance/core` library with
   NO Next.js/React imports — pure TypeScript, called by Next route handlers.
   This keeps the engine extractable into a standalone API later (mobile,
   other home-platform modules) without paying a two-service cost today.
3. **Source-adapter interface (design for the long tail, don't build it
   all)**: define a single `SourceAdapter` contract that normalizes any input
   into the common order/receipt/transaction model. The UNIVERSAL adapters —
   the ones that scale to any retailer (Walmart, Sam's, Target, HEB, …)
   without a bespoke integration — are document-upload based: receipt image,
   PDF, `.eml`, and CSV/export-file. Retailer- or API-specific adapters
   (Amazon CSV, a future Costco scraper) are OPTIONAL implementations behind
   the same interface, never the foundation. Disambiguation defaults to a
   generic LLM resolver; per-retailer SKU dictionaries are optional caches
   that plug in, not requirements. Today: ship the interface + the
   upload/CSV/.eml adapters; stub the retailer-API slot.
4. **Data model**: households; accounts; `transactions` (bank lines);
   `orders` + `order_items` (from the Amazon CSV; optional `.eml` later);
   `receipts` +
   `receipt_items` (from vision, populated by H2); `matches` (cross-source
   links with rationale + confidence); `categories`. **Returns as
   first-class**: `returns`/`refunds` are signed events (negative line
   items) with a `refund_destination` enum — `card` (appears on the bank
   statement as a credit), `store_credit` / `gift_card` / `account_balance`
   (Costco Shop Card, Amazon balance — does NOT appear on the bank). Add a
   `store_credit_balances` ledger, since a refund to store credit becomes a
   balance that later partially pays a purchase (so that future purchase
   won't fully hit the bank either). H3 consumes all of this.
5. **Bank statement importer**: PRIMARY format is **Excel** (`.xlsx`/`.xls`,
   via SheetJS) — the operator's bank only exports Excel or PDF, and Excel is
   structured and deterministic. Also accept CSV (trivial superset, handy for
   tests and other banks). Handle header-row detection, date/amount
   normalization (incl. Excel serial dates), merchant string cleanup,
   credits vs. debits (refunds are credits). Idempotent re-import (no
   duplicates). **PDF is an OPTIONAL secondary adapter**: route the statement
   PDF through the same Claude vision/LLM extraction used for receipts (H2),
   emit the same transaction model, flag low-confidence rows to the review
   queue. PDF is fragile (table layout) — Excel is the dependable demo path;
   only build PDF if time allows. Both formats flow through the
   `SourceAdapter` interface (item 3).
6. **Order ingestion**: parse Amazon's `Retail.OrderHistory.1.csv` (self-serve
   "Request My Data" export) into orders + per-shipment line items — this is
   THE order path for the demo; it yields per-shipment subtotals (for the
   "one order → multiple bank charges" beat) AND returns/refund rows, all
   file-based, no live auth. Flows through the `SourceAdapter` interface
   (item 3). NOTE: `.eml` order-email parsing is an OPTIONAL Tier-0 adapter
   for the long tail of non-Amazon online merchants — NOT required for build
   day (Amazon CSV + receipts already cover the demo). Only add the `.eml`
   adapter if H1 finishes with time to spare; otherwise leave the slot
   stubbed behind the interface.
7. **Fixtures**: sanitized copies of real samples for tests (fake account
   numbers, real structure), including ≥1 return/refund case. Seed script for
   a synthetic "demo household."

## Done means

- A real bank Excel export and a real Amazon order CSV ingest cleanly via CLI
  or script.
- Schema supports H2/H3 needs (shared contract with those epics).
- Tests (Vitest): importer normalization, parser extraction, idempotency, +
  integration that imports the real ingest route/service against a fresh
  libSQL test DB. Suite green.
- Tests written first from the acceptance criteria above (red → green).
- No real data in git; `.gitignore` proves it from commit #1.

## Non-goals

- Plaid/bank APIs, live Gmail/IMAP — file-based ingestion only today.
- Receipt parsing (H2), matching (H3), UI (H4).
- Auth/multi-tenancy — single household today, schema allows more later.
