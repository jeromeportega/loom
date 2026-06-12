# Viability Research — Finance Reconciliation Module

Researched 2026-06-12. Bottom line: **viable, and the demo data path needs
zero API approvals.** The hard reconciliation problem is solvable with data
sources you can pull yourself today.

## Data sources — verdict per source

### Amazon order history — VIABLE (best surprise)
- **No official consumer order API.** SP-API is sellers-only and now costs
  ~$1,400/yr + per-GET-call fees (effective 2026). PA-API is affiliate
  product data, not your orders. Knot API exists but is enterprise B2B
  (cardholder→merchant linking), not same-week indie-accessible.
- **The winning route: "Request My Data" → `Retail.OrderHistory.1.csv`.**
  Self-serve from Amazon Privacy Central; usually ready in hours. Columns
  include: Order ID, Order Date, **Unit Price, Shipping Charge, Total Owed,
  Shipment Item Subtotal (+ tax), Ship Date, Payment Instrument Type,
  Shipment Status,** ASIN, Product Name, Quantity. That is **per-shipment,
  per-item** data — exactly what's needed to match Amazon's per-shipment bank
  charges. No category field (that's OUR classifier's value-add).
- Hackathon move: export the CSV beforehand, parse it. No live integration.

### Costco — VIABLE two ways
- **Digital path:** costco.com → "Orders & Returns" → in-warehouse shows
  itemized receipts (item #, description) for up to 2 years; members can opt
  into digital receipts at checkout. No public API, but the data is
  retrievable for your own account.
- **Photo path (the differentiator):** receipt photo → Claude vision → item
  numbers + abbreviated names → disambiguate. No clean public Costco
  item-number→name DB exists; disambiguation leans on LLM + the digital
  receipt descriptions + Barcode Spider/Costco's own item lookup.
- Hackathon move: demo the photo→items→classify pipeline (the wow); use the
  online digital receipt as ground-truth to validate accuracy.

### Bank transactions — VIABLE, several fast paths
- **Plaid:** NEW free **Trial plan** (since 2026-04-15) — real production
  data, up to 10 Items, $0. Sandbox is instant. Best "real bank data today"
  with a brand name judges know.
- **Teller.io:** 100 free live connections, indie-friendly, fast setup.
  Good alternative; access method can break on bank changes (have a fallback).
- **SimpleFIN Bridge:** $15/yr, read-only, daily refresh — purpose-built for
  personal-finance tools. Cheapest durable option for the real product.
- **File export (THE demo path):** the operator's bank exports only **Excel
  or PDF** (no CSV). Use **Excel (`.xlsx`)** as the guaranteed demo path —
  structured, parsed deterministically with SheetJS, no live connection on
  stage. **PDF** is an optional secondary handled by the same Claude vision
  pipeline as receipts (fragile table layout — keep it a bonus, not the
  critical path). CSV still accepted for other banks/tests.

### Order/confirmation emails — VIABLE as files, NOT as live Gmail
- Gmail API in "Testing" mode revokes refresh tokens after **7 days** for
  external users, and restricted Gmail scopes need Google's CASA security
  review (weeks, costly) to go to Production. So **live Gmail OAuth is wrong
  for a hackathon and painful for an early product.**
- Hackathon move: export order emails as `.eml` files and parse those. Same
  result, no auth fragility.

## Receipt OCR fallbacks (if LLM vision underperforms)
- **Taggun** — cheap (~$4/mo tier), strong grocery line-item extraction.
- **Veryfi** — best-in-class, pricey (~$500/mo), ~1s/receipt, pre-trained.
- **Mindee** — 14-day trial, deep-learning line items.
- Plan A stays Claude vision (it's the build-during-hackathon story); keep
  Taggun key in pocket as the accuracy fallback for the demo receipts.

## Coverage & onboarding model (product strategy)

The retailer list is effectively infinite, so coverage is tiered, not
all-or-nothing. Principle: **bank is the backbone; item-level enrichment is
progressive** (graceful degradation — never "connect everything or it's
useless").

- **Tier 0 — universal, zero setup:** upload a receipt photo / PDF / `.eml` /
  CSV. Works for ANY retailer immediately via the generic `SourceAdapter` +
  LLM disambiguation. Friction is per-capture; coverage is unlimited.
- **Tier 1 — connect once, the spine:** bank connection (Plaid/Teller). The
  complete spend skeleton everything reconciles against. The one connection
  worth asking every user for.
- **Tier 2 — connect once per retailer, optional:** Amazon data export,
  Costco digital receipts, etc. One-time, then item-level detail flows
  automatically for that retailer (no more photographing its receipts).

Returns wrinkle that this must respect: refunds to store credit / gift card /
account balance (Costco Shop Card, Amazon balance) never touch the bank, so
the bank backbone alone undercounts returns — Tier 0/2 item data is what
makes net spend correct. (Modeled in H1 `returns` + `store_credit_balances`,
reconciled in H3.)

Build day: all tiers demoed via files; live "connect once" flows are
post-hackathon.

## Stack & deploy (DECIDED)
- **Next.js (App Router, TypeScript)** — UI + API routes + vision job in one
  deployable app.
- **Tailwind CSS** + **shadcn/ui** components + official **`geist` font** for
  all surfaces. IMPORTANT: there is no installable official Geist *component*
  library — the `geist` npm package is the font only, and the community
  `@geist-ui/core` is being archived (its maintainers point to Tailwind). So
  the supported, agent-legible path is Geist font + Tailwind + shadcn/ui
  (Radix-based, copy-into-repo, the most LLM-legible component system).
- **libSQL / Turso** for data (SQLite-compatible — keeps the agents' SQLite
  fluency from loom's better-sqlite3 work) and **Vercel-friendly**.
  **Vercel + on-disk SQLite is a trap** — serverless has no persistent
  filesystem; `better-sqlite3` files don't survive. Don't do it.
- **Deploy: Vercel**, public URL. Fallback only if Vercel fights back:
  Railway/Fly + a volume (also the right move if long-running vision job
  queues are needed, since Vercel function timeouts make 20-30s vision calls
  awkward).
- Receipt vision = a route handler / job calling the Anthropic SDK (prompt-
  cache the extraction system prompt, per loom invariant habits).

## Net assessment
Every leg of the reconciliation thesis has a real, self-serve data source:
Amazon CSV (per-shipment), Costco digital+photo, bank via Plaid-trial or
CSV, emails via .eml. The genuinely novel/hard part — fusing them so every
dollar is counted once and classified at item level — is exactly the part
loom's agents build during the event. Nothing gates on an approval that
takes longer than the hackathon.
