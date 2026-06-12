---
title: "Epic 14 — Staff Engineer Review"
reviewer: Claude (Sonnet 4.6)
date: 2026-05-22
status: reviewed
---

# Epic 14 Review: pi.dev UI Surface

Reviewing `@loom-ai/pi` — the pi.dev extension: `LoomBridge`, the five slash
commands, and the live `DashboardPanel`.

Two issues were caught during the build and fixed before this review (see
"Caught and fixed"). The remaining findings are documented limitations — the
most important being that the pi runtime glue is built to the documented
contract but could not be exercised inside a running pi.

## Caught and fixed during the build

**A. The controls footer overflowed a narrow terminal.** The inline-controls
line (`[a] approve … [q] quit`) is ~78 columns. On a 50-column terminal `clip`
truncated it — and `[q] quit`, the way *out* of the panel, was the first thing
cut. Caught by the `renderDashboardLines` "every line fits the width" test.
Fixed by splitting the controls into two shorter lines (each ≤ 50 cols), which
both passes the test and is better UX on a narrow terminal.

**B. `CheckpointMode` imported from the wrong module.** `index.ts` imported the
type from `./dashboard.js`; it is defined in `./bridge.js`. A build-time
TypeScript error — fixed by correcting the import and dropping a now-redundant
cast (the value was already narrowed by a `=== 'story' || === 'epic'` guard).

## Findings — documented

### Medium

**1. The extension is not runtime-verified inside pi.**
- `@loom-ai/pi` is built against pi's documented 0.75.x extension contract
  (extensions.md / tui.md). No pi install exists in the build environment, so
  command registration, the 2s poll loop, the `ctx.ui.custom` mount, and
  keyboard dispatch are correct *to the contract* but unproven in a live pi.
- The pure core (`buildDashboardModel`, `renderDashboardLines`,
  `findLoomProject`) is unit-tested; the pi glue is the untested seam. This is
  the honest boundary of what could be delivered here — flagged in
  `docs/known-limitations.md` and `docs/testing.md` rather than papered over.

**2. The pi API contract is vendored, not imported.**
- `src/pi.ts` hand-declares the pi API surface loom-pi uses instead of
  depending on `@earendil-works/pi-coding-agent` / `pi-tui`. This keeps the
  build hermetic — a pi package change cannot break `npm run build` — but the
  vendored types can drift from pi's real contract across a pi major. The file
  cites its source doc; re-check it on a pi major bump.

**3. A detached `loom run` hides its own startup failure.**
- `LoomBridge.run()` spawns `loom run` with `stdio: 'ignore'`, detached. The
  dashboard reflects progress only through the project DB it polls — so a run
  that fails to *start* (e.g. `loom-ai` not resolvable) produces no visible
  error in the panel. Capturing the child's early exit would close this.

### Low

**4. The dashboard shows a single product.**
- `DashboardModel.project` is one string. The 014-002 acceptance criterion
  "show more than one product" depends on Epic 11's product registry, which is
  not built. The model and renderer would need to iterate `projects[]`. Built
  single-product deliberately; widening is a small change once Epic 11 lands.

**5. The panel implements pi's `Component` directly — no pi-tui widgets.**
- The spec tech-note said "use pi-tui for rendering." The panel instead
  implements pi's structural `Component` contract (`render`/`handleInput`/
  `invalidate`) and renders strings itself. Deliberate: it avoids a heavy
  dependency and keeps the build hermetic (Finding #2). The cost — keyboard
  input is limited to single printable keys, no arrow-key list navigation. A
  status-plus-controls panel does not need a `SelectList`; if richer
  interaction is wanted, add `@earendil-works/pi-tui` then.

## Downstream impact matrix

| Finding | Epic 11 (multi-product) | Epic 12 (research) | Epic 9 (shared skills) |
|---|---|---|---|
| A controls overflow (fixed) | — | — | — |
| B import (fixed) | — | — | — |
| #1 not pi-verified | a real pi smoke test should land before more pi work | — | — |
| #2 vendored types | — | — | — |
| #3 detached run | — | — | — |
| #4 single product | **directly unblocks this** — widen `DashboardModel` to `projects[]` | — | — |
| #5 Component-direct | a research/Q&A panel would reuse the same pattern | — | — |

## What's solid

- **loom-core never moved.** Epic 14 added a whole UI surface with zero changes
  to loom-core and zero to loom-mcp — the `HANDLERS` + `productionContext`
  layer was already the right seam. UI lives entirely in `@loom-ai/pi`.
- **No redundant orchestration.** This was the user's recurring worry ("did we
  write redundant feature code?"). `LoomBridge.status()` *is*
  `loom_get_status` called in-process — not a second status implementation.
  `stop` reuses `ControlStore`; `run` reuses the `loom` CLI. The extension is
  glue, not a fork of the engine.
- **Pure core, thin shell.** `buildDashboardModel` and `renderDashboardLines`
  are pure and fully tested (garbage-input tolerance included); `DashboardPanel`
  is a thin stateful wrapper that polls and delegates. The hard-to-test part is
  small by construction.
- **Graceful degradation is structural.** Every command resolves the project
  first and notifies-and-returns when there is none; the factory itself never
  throws. The extension loads cleanly in a non-loom repo.
- **In-process tool calls, not a subprocess.** Driving loom-mcp `HANDLERS`
  directly avoids spawning an MCP server and a stdio transport just to read
  status — lower latency, fewer moving parts, same logic.

## Verdict

Epic 14 is structurally sound and the build is green (247 tests). The one thing
a reader must know: the pi-facing glue is contract-correct but not pi-verified.
Recommend a real pi smoke test (load the extension, walk the five commands and
the dashboard) be the first task whenever a pi install is available — before
any further pi-surface work (e.g. an Epic 12 research panel).
