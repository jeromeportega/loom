# Epic H2 — Receipt Vision & SKU Disambiguation

## Problem

Big-box receipts hold the only item-level record of in-store spending, but
they're photos of thermal paper covered in abbreviations: `KS ORG EVOO
2CT`, `GV WHL MLK`, SKU numbers, multi-buy discounts, tax lines. Banks see
one opaque total. Turning a receipt photo into trustworthy structured line
items is the hard, differentiating capability of this product.

## Who it's for

Anyone who shops at Costco/Target/Walmart and wants to know what the
$234.17 actually was.

## What to build

1. **Extraction pipeline**: receipt photo → structured record: store, date,
   total, tax, payment hint (last-4 if printed), and line items (SKU,
   abbreviated description, quantity, unit price, line price, discounts).
   Use Claude vision (Anthropic SDK is available; prompt-cache the system
   prompt). Must tolerate imperfect photos: skew, glare, crumple.
2. **SKU disambiguation**: abbreviated description (+ SKU + store context) →
   canonical product name + category, each with a confidence score.
   Maintain a persistent **SKU dictionary** (store, SKU, abbreviation →
   resolution) so repeat items resolve instantly and the system visibly
   learns; new resolutions append to it.
3. **Honest uncertainty**: line items below a confidence threshold are
   flagged `needs_review` for H4's queue — never silently guessed.
   Arithmetic check: line items + tax − discounts must reconcile to the
   printed total; mismatches flag the whole receipt.
4. **Storage**: writes `receipts` / `receipt_items` per H1's schema (shared
   contract; stub the tables if H1 hasn't landed).

## Done means

- ≥5 real receipt photos from the data kit process end-to-end.
- ≥80% of line items correctly resolved on those receipts (build a small
  accuracy harness with expected outputs; verifier hand-checks a sample).
- Arithmetic validation works (test with a deliberately corrupted fixture).
- Tests green; only publishable receipts in fixtures.

## Non-goals

- Live camera capture / mobile app — file upload is enough today.
- Non-receipt documents (invoices, statements).
- Product image lookup or external product APIs (no API approvals today).
