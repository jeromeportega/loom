# Standalone Story Identity: Present Standalone Stories as Stories, Not One-Story Epics

## The Problem

When loom intake routing classifies incoming work as a standalone story, the underlying record is already correct — it is a parentless standalone story, and `loom status` presents it that way (`Story story-NNN`). But the story still leaks its **epic-prefixed run id** (`epic-NNN`) and **one-story-epic framing** in several user-facing surfaces:

- The `loom weave` command summary prints `epic-NNN` as the run and `N epic(s), 1 stories`.
- The `approve` and `run` commands are invoked with the `epic-NNN` id.
- The finalize pull request title reads `epic-NNN: …`.
- Status lines say things like `Epics processed: epic-NNN`.

The result is an internally inconsistent product: the same piece of work is a "story" in one place and an "epic" in another. The operator is asked to reason about, approve, run, and review a "story" that the tooling repeatedly labels as an epic.

**Root cause:** `loom weave` reserves an epic id *before* classification. When routing then decides the work is a standalone story, it repurposes that already-reserved epic row as the standalone story while keeping the `epic-NNN` id. The identity is never reconciled to read as a story.

## Target Users

- **Primary — loom operators running intake routing.** Engineers who submit briefs through `loom weave` with `intake_routing` enabled and expect routed standalone stories to read coherently as stories across the commands they type and the summaries they read.
- **Secondary — PR reviewers.** Anyone reading the finalize PR title in GitHub; today they see `epic-NNN` for what is conceptually a single story.
- **Anti-persona — the full-epic-pipeline operator.** A user whose effective size *is* an epic must see **no change**: `epic-NNN` ids and `N epic(s)` framing are correct and expected for them. Likewise, operators running with `intake_routing` off must observe byte-identical behavior to today. This work must not "fix" their experience, because it is not broken.

## Proposed Solution

Make the standalone-story identity consistent across every user-facing surface so that a routed standalone story reads as `story-NNN` — never as `epic-NNN` or `1 epic, 1 story` — everywhere the operator sees, types, or reviews it.

The reconciliation of the pre-classification epic reservation is an **architect's-choice** design decision. Candidate approaches named in the brief:

1. Allocate a **story-prefixed id** on the standalone routing path (avoid reserving an epic id at all once classification lands on standalone).
2. **Rename the reserved row** to a story identity on the standalone branch.
3. Apply a **presentation mapping** from the reserved epic id to a story-facing id at each surface.

The constraint that bounds the choice: the operator must never see a standalone story labeled `epic-NNN` or `1 epic, 1 story`, while the full-epic and `intake_routing`-off paths remain untouched.

## Key Capabilities

1. **Weave summary** presents a routed standalone story as a story — e.g. `Standalone story: story-NNN` — not `N epic(s), 1 stories`.
2. **`approve` and `run`** operate on the standalone story via an id that reads as a story.
3. **Finalize PR title** uses `story-NNN` framing instead of `epic-NNN: …`.
4. **Status lines** ("epics processed" style) name the standalone story as a story.
5. **`loom status`** continues to present the standalone story exactly as it does today.
6. **Identity reconciliation** of the pre-classification epic reservation so the standalone identity reads as a story end-to-end.
7. **Preserved behavior** for the standalone story's dispatch, single-PR finalize, and provenance — all of which already work.

## Constraints

- **Full epic pipeline unchanged.** When effective size is epic, `epic-NNN` ids and `N epic(s)` framing remain.
- **`intake_routing` off ⇒ byte-identical** to today's behavior, proven by tests.
- **No guardrail weakened.** Policy, branch protection, and worktree isolation invariants stay intact.
- **Preserve what works** on the standalone path: dispatch, single-PR finalize, provenance, and the current `loom status` presentation.
- **Docs + drift check.** Update user-facing docs for any changed id or wording, and pass the capabilities drift check (per the repo's standing rule that `docs/capabilities.md` stays current).
- **Scope discipline.** This is an identity/presentation-consistency fix, not a redesign of intake routing or the epic/story data model beyond what reconciling the reservation requires.

## Risks and Open Questions

- **Reconciliation approach is unresolved by design.** The choice between new-id allocation, row rename, and presentation mapping has different blast radii. `[ASSUMPTION]` A presentation-only mapping is the lowest-risk change but risks leaving the stored id as `epic-NNN`, which could resurface in logs, audit entries, or future surfaces; an id reallocation is cleaner but touches more of the dispatch/finalize path. The architect should weigh this explicitly.
- **Hidden surfaces.** The brief enumerates weave summary, approve/run, PR title, and status lines. `[ASSUMPTION]` Other surfaces may also echo the run id — e.g. audit log entries, traces, the web dashboard, diff/artifacts output, and provenance records. Whether these must also read `story-NNN`, or may retain the internal id, is an open question. Provenance is explicitly to be *preserved*, which may imply the original reserved id is retained internally even if presentation changes.
- **Id-collision / allocation semantics.** `[ASSUMPTION]` If a story-prefixed id is allocated on the standalone path, it must not collide with story ids minted inside real epics, and the reserved epic id must be released or otherwise not orphan-counted.
- **Branch and worktree naming.** `[ASSUMPTION]` If id reconciliation changes the canonical id, downstream branch names, worktree paths, or PR head refs derived from it may shift; this must not break the single-PR finalize or re-introduce lingering-worktree issues.
- **Operator-typed ids during transition.** If an operator has already seen/recorded an `epic-NNN` id before this change, will the old id still resolve, or only the new `story-NNN`? Backward-compatibility of `approve`/`run` lookups is unspecified.

## Success Criteria

A change is done when all of the following hold:

1. A routed standalone story is presented as `story-NNN` — and **never** as `epic-NNN` or `N epic(s), 1 stories` — across the `loom weave` summary, the `approve` and `run` commands, the finalize PR title, and status messages.
2. `loom status` still presents the standalone story as a standalone story, unchanged from today.
3. The pre-classification epic reservation is reconciled so the standalone identity reads as a story.
4. The full epic pipeline is unchanged, and the `intake_routing=off` path is byte-identical to today — both proven by tests.
5. Tests cover the standalone presentation across the weave summary, `approve`/`run`, and the PR title.
6. No guardrail is weakened; dispatch, single-PR finalize, and provenance on the standalone path are preserved.
7. Docs are updated for any changed user-facing id or wording, and the capabilities drift check passes.
8. The full build and test suite pass.
