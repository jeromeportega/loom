# Epic H4 — Experience & Deploy

## Problem

The engine's output needs a human surface — and the competition needs a
live URL. The centerpiece is a **reconciliation review queue** (inbox
metaphor): the human confirms or corrects what the engine wasn't sure
about, and the system gets visibly better. This is a control surface, NOT
a dashboard product — charts are secondary.

## Who it's for

The household operator: five minutes of review a week instead of an hour
of spreadsheet archaeology. (Also: the judges, via the public demo URL.)

## Stack (inherited from H1 — do not change)

Next.js (App Router) + TypeScript, **Tailwind CSS** + **shadcn/ui**
components for every surface, with the official **`geist` font** for the
Vercel-native look, libSQL/Turso for data, deployed on **Vercel**. (There is
no installable official Geist component library — see H1. Use shadcn/ui, not
`@geist-ui/core`.)

## What to build

1. **Review queue** (the centerpiece): inbox-style list of items needing
   judgment — low-confidence SKU resolutions, ambiguous matches, unmatched
   transactions, flagged receipts. Actions: confirm / correct (pick category,
   pick match candidate, edit resolution) / dismiss. Corrections persist,
   update the SKU dictionary and rollups, and disappear from the queue.
   Build it with shadcn/ui table/list/badge/dialog components + Tailwind.
2. **True-spend view**: item-level category breakdown by month; drill from
   category → items → source evidence (receipt image region, Amazon order
   row, bank line). Evidence linking is the trust moment — keep it.
3. **Receipt drop**: upload a receipt photo in the UI → H2 pipeline →
   results appear (live demo moment).
4. **Demo household + deploy**: seed script builds the curated demo
   household (publishable receipts, synthetic bank lines that match them).
   Public mode is read-only + demo data; mutations need a token.
   **Deployment is an orchestration step performed by the agent running loom
   (from the authenticated interactive session), NOT a worker story** — keep
   the Vercel token out of worker worktrees. Action = scripted CLI
   (`vercel --prod` / `vercel.json`), the deterministic reproducible
   artifact. Verify = a `curl` 200 smoke test; diagnose failures via the
   Vercel MCP (build logs / status / env). Cloudflared/ngrok tunnel to a
   local instance is the only fallback if Vercel deploy fights back.

## Done means

- Full path works on the deployed URL: drop receipt → line items → match →
  classify → queue → confirm → rollup updates.
- Queue actions persist and propagate — **Vitest integration against the real
  route handlers** (the anti-stub "built AND wired" test, not a fixture app).
- Public URL returns 200, serves ONLY demo-household data, no mutation
  routes without token.
- One **Playwright** golden-path E2E (receipt → items → confirm → rollup) under
  `npm run e2e` (NOT in the `npm test` gate) + a `curl` deploy smoke (→ 200,
  asserts demo data).
- Tests written first from the acceptance criteria above (red → green).

## Non-goals

- Mobile app, auth/accounts, multi-household UI.
- Chores/calendar modules — Signal Scout proposes Module 2; nobody builds it
  today.
- Chart libraries / analytics polish — the queue and the evidence drill-down
  are the demo.
