# Use cases

Four pathways through loom. Pick the one closest to your work.

---

## 1. Add a feature

The canonical case. A brief, a plan, parallel workers, one PR.

```bash
loom epic "Add a REST endpoint to the audit-log service that returns
            paginated entries, filterable by date range and actor, with tests."
loom approve epic-001
loom run --checkpoint epic
```

**What loom produces**: one PR titled `epic/epic-001: <title>` with the
brief, PRD, architecture, and story-level commits preserved on the epic
branch. Stories run in parallel up to `policy.agents.max_concurrent`.

**When to use**: most net-new feature work. A single brief gives you
roughly one epic with 3–6 stories.

---

## 2. Fix a bug

A focused, smaller-scope brief. Loom plans it as one epic with 1–3 stories.

```bash
loom epic "Fix the off-by-one in PaginationCursor.advance() — it skips
            the last row when offset+limit equals page size. Add the
            missing regression test."
loom approve epic-002
loom run --checkpoint story    # tighter checkpoint for a fix
```

**When to use**: any defect with a clear repro. The tighter `--checkpoint
story` pauses between stories so you can review each commit before the
next worker dispatches — useful when you don't yet trust loom with
your bug-fix taste.

---

## 3. Refactor (scoped)

```bash
loom epic "Refactor the notification module: replace the ad-hoc callback
            handlers with a single typed event bus. Migrate all four
            existing call sites. Tests must keep passing."
loom approve epic-003
loom run --checkpoint epic
```

**When to use**: a scoped refactor with a clear before/after. Loom's
default planning preference is **ONE epic**; refactors should plan as
one cohesive unit, not be split into per-call-site stories unless the
brief explicitly says so.

---

## 4. Multi-product (different config per repo)

One machine, many loom repos.

```bash
# In each repo:
loom init
# Configure that repo's .loom/policy.yaml — e.g. different worker_backend,
# different allowed_remotes, different review_strategy.

# Aggregated status across every loom repo on the machine:
loom status --all
```

A per-machine config (`~/.loom/config.json`) caps total worker concurrency
across all repos, so two product teams don't exhaust your Claude session
at the same time:

```json
{
  "global_max_concurrent": 4
}
```

**When to use**: a developer working across multiple products, or an org
where loom is deployed per repo with team-specific policies (e.g.,
mobile team disables PRs entirely; platform team requires
`review_strategy: 'block-and-revise'`).

---

## Bringing in prior context

Loom's brief is the only planning input. If you have prior architecture
decisions, research, or a delivered epic to anchor the new work, paste
the relevant excerpts directly into the brief. Past epics' artifacts
live under `.loom_outputs/<epic-id>/` (brief, PRD, architecture, epic
YAML) — open them, lift what matters, fold it into the new brief's
constraints.

The same goes for mockups: chat clients (Claude Code, Cursor) that accept
pasted images can translate the image into prose themselves before
calling `loom_start_epic`. The brief reaching loom is always text.

---

## Choosing a checkpoint

Regardless of pathway, the `--checkpoint` flag is your trust dial:

| Checkpoint | Behavior | When |
|---|---|---|
| `story` | Pause after every story | First few epics; bug fixes you want to inspect closely |
| `epic` (default for new users) | Pause after each epic | Default once you trust the system |
| none | Complete every approved epic | Daily driver once you've calibrated |

Loosen as confidence grows. Never the other direction: if a run surprises
you, drop back to `--checkpoint story` until you trust it again.

## What loom intentionally won't do

- **Push to protected branches.** The policy engine blocks this at the
  command level. Agents open PRs; you merge.
- **Read or store credential values.** When provisioning MCP servers,
  loom writes secrets as `${REFERENCES}` and tells you which env vars
  to set.
- **Plan multi-epic decomposition for one-paragraph briefs.** The PM
  persona defaults to **one epic**. A brief that genuinely spans
  separable shipping units produces multiple epics; everything else
  stays one. ([Why.](../testing/planning-eval.md#over-decomposition))
