# Runbook — `loom status`

`loom status` prints an at-a-glance view of all epics and their stories,
including live progress for running agents.

## Running-story line format

```
  <icon> <story-id> — <title>  (<elapsed>)  [(retry N)]  [(revise N)]  [<model>]
```

Tags on a running-story line (all optional, in order):

| Tag | When shown | Meaning |
|---|---|---|
| `(retry N)` | retry count ≥ 1 | Story has been retried N times |
| `(revise N)` | `revise_round` ≥ 1 | Story is undergoing block-and-revise review: the reviewer found blockers and the worker is on revision pass N |
| `[<model>]` | always | Model being used by this worker |

The `(revise N)` tag is driven by the `revise_round` field on the agent
record. It appears **after** `(retry N)` and **before** the model tag.
`revise_round` is incremented by the Supervisor each time the
`CodeReviewAgent` finds blocking findings and re-prompts the worker.

## Useful flags

| Flag | Effect |
|---|---|
| `--watch` | Re-render every few seconds until interrupted |
| `--epic <id>` | Scope to a single epic |
| `--all` | Aggregate across every loom-init'ed repo on the machine |
| `--archived` | Include archived runs (hidden by default) |
| `--json` | Machine-readable output; all tags appear as structured fields |

## JSON fields for the revise-round tag

In `--json` output the running agent record includes:

```json
{
  "revise_round": 2
}
```

The field is `0` when no revisions have occurred. It is part of the agent
record returned by `AgentStore.getByStory`.

## Related commands

- `loom review <story-id>` — the reviewer's findings and summary.
- `loom audit --story <id>` — full structured audit trail.
- `loom retry <story-id>` — manually re-dispatch a failed/blocked story.
