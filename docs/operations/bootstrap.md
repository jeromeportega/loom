# How loom was bootstrapped

loom was planned using a structured Analyst → PM → Architect persona
workflow — the same shape loom itself runs at runtime. The bootstrap
was intentionally recursive: the system was planned with the methodology
it automates.

## What happened

1. A persona-based planning toolkit was installed into this repo to
   provide the initial Analyst / PM / Architect personas and their
   workflow templates.
2. Those personas (Mary, John, Winston) produced the project brief,
   PRD, and architecture — preserved under `_bmad-output/` and `docs/`.
3. Those artifacts became the original epics in `epics/`, which loom
   was then built against.

## What loom inherited vs. what's its own

The loom binary **does not depend on the bootstrap toolkit at runtime.**
Loom ships its own planning personas in `packages/loom-core/personas/`
(analyst, pm, architect, worker, skill-extractor). The personas were
seeded from the upstream templates and then heavily tuned for headless
operation — most notably, the over-decomposition fix landed via the
planning-eval discipline ([Run 3 in the testing runbook](../testing/runbook.md#run-3)).

The bootstrap scaffolding (`_bmad/`) is gitignored. Reproducing it locally:

```bash
npx bmad-method@6.7.1 install --directory . --modules bmm --tools claude-code,cursor
```

The planning artifacts produced during the bootstrap
(`_bmad-output/planning-artifacts/`, the original `docs/architecture.md`,
the first epics under `epics/`) **are** committed — they're the
historical record of how loom was designed.
