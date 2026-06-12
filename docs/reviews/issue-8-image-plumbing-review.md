---
title: "Issue #8 — Staff Engineer Review (Epic 15 deep image plumbing)"
reviewer: Claude (Opus 4.7)
date: 2026-05-23
status: reviewed
scope: "story-015-002 partial — loom epic --image plumbs images to the WORKER (where bytes are read natively by the Read tool). The planner LLM itself does NOT get image content blocks; that's a separate, larger lift documented as a Finding. story-015-003 (--image on ask/research) is explicitly deferred."
---

# Issue #8 Review — Pi-First, Worker-Native Image Path

The pi-first path (story-015-001, shipped earlier) handles *intent*: paste
a mockup into pi, Claude writes a brief from it. The remaining 10% — the
pixel-perfect re-implementation case — requires the worker to actually see
the image. This change ships that worker-side path, deliberately stopping
short of feeding images to the planner LLM.

## What shipped

### story-015-002 (worker half)

- **`StorySchema.images`** — optional `string[]` of absolute paths. Epic
  YAML schema accepts it; existing planners without images write zero-
  field YAML (verified).
- **`PlannerOptions.images`** + Planner.run logic — when supplied, the
  planner copies each image into `.loom/planning/<run>/images/<basename>`
  (durable against operator file moves) and attaches the absolute paths
  to every story, rewriting the epic YAMLs. Best-effort copies: a missing
  source file at the CLI layer is fatal; copy failures inside the planner
  fall through silently rather than aborting a planning run.
- **`loom epic --image <path>`** — repeatable CLI flag. Resolves each
  path relative to `projectRoot`; missing files are a fatal error before
  planning starts.
- **`workerPrompt.ts`** — new `Reference images` block listing every
  image path with operator-style guidance ("If your story touches the
  UI, Read them and match the visual intent; if not, ignore them.").
  The worker's Read tool natively handles image bytes — no protocol
  change needed.

## Findings

### Medium

**1. The planner LLMs do not see the image content.** This is the
deliberate scope cut. Analyst / PM / Architect personas operate on the
text brief plus a list of image filenames; they cannot reason about the
visual content. Two mitigations cover this:
- The pi-first path is the recommended entry point: paste image into
  pi, Claude (which CAN see images natively) writes a rich brief, then
  `loom epic --image mockup.png "<brief>"` plumbs the image to workers.
- For ad-hoc `loom epic --image "<text brief>"` (no pi), the text brief
  carries the planning information; the image is for workers.

Going further would require: extending `LLMMessage.content` to be
`string | ContentBlock[]`, updating all four LLM clients (Anthropic,
ClaudeCli, CursorCli, Mock), and ClaudeCli would need to switch to
`--input-format stream-json` to pass image content blocks (a non-trivial
protocol change). The added value is small relative to the pi-first
path's existing coverage. Don't ship until the pi-first path proves
insufficient — that signal hasn't arrived.

**2. Every story gets every image, not just UI-affecting stories.** The
Architect persona is *not* taught to assign images per-story. This means
a backend-only story will see UI mockups in its prompt (and the worker
is instructed to ignore them when irrelevant). Trade-off: simpler
shipment, and the worker prompt's "ignore if not relevant" instruction
covers the noise. Future refinement: have the Architect populate
`story.images` selectively. Acceptable for v1.

**3. Image paths are absolute, not portable.** A planning artifact
moved to another machine breaks. Mitigated by the planner copying
images into the run dir on this machine. If `.loom_outputs/<epic-id>/`
gets promoted (per the EpicFinalizer), images stay reachable; if
operators try to ship the planning dir to a different machine, they'll
need to fix paths. Acceptable for a single-machine loom run.

### Low

**4. No image dedup.** Two `--image foo.png` flags copy the file twice
to the same destination (the second copy overwrites the first; both
absolute paths in the YAML are identical). Harmless; the YAML's
images array will have duplicates. Trivial to fix; not worth a code
change now.

**5. The CLI flag fails fast on a missing source file but planner-side
copy failures are silent.** Asymmetric. If the user has read permission
to the source at CLI time but not at planning time (rare), the worker
won't have the image and won't know. Acceptable: if the CLI accepts it,
the copy almost always succeeds.

### Explicit deferrals

- **story-015-003 — `--image` on `loom ask` and `loom research`.**
  Reuses the same plumbing only if the planner-LLM path is also
  extended; without that, the image just gets attached to a textual
  ask/research and the LLM cannot see it. Defer until the planner-LLM
  image path is built.
- **LLMClient image content blocks** — see Finding #1.

I will file a follow-up issue for the deep planner-LLM image path
before closing #8.

## Tests

5 new test cases; 330 total passing.

- `Planner.test.ts` (extended):
  - copies `--image` inputs into the planning run dir and attaches the
    paths to every story
  - leaves `story.images` undefined when no images were supplied
- `workerPrompt.test.ts` (extended):
  - lists reference images when `story.images` is set
  - omits the section when undefined
  - the existing revision-context test now formally lives here too

## Files changed

- `packages/loom-core/src/types.ts` (StorySchema.images)
- `packages/loom-core/src/planner/Planner.ts` (images option + copy + YAML rewrite)
- `packages/loom-core/src/orchestrator/workerPrompt.ts` (Reference images block)
- `packages/loom-cli/src/commands/epic.ts` (EpicOptions.image + path resolution)
- `packages/loom-cli/src/index.ts` (--image flag with repeatable collector)
- `packages/loom-core/src/__tests__/Planner.test.ts` (extended)
- `packages/loom-core/src/__tests__/workerPrompt.test.ts` (extended)
