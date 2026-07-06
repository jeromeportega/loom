# Runbook — `loom review`

`loom review <story-id>` shows the block-and-revise review outcome for a
completed story: status, findings grouped by severity, and the reviewer's
markdown summary.

## Output format

**Text output** (default):

```
  <story-id> — review: <status>

  FINDINGS
  ────────
  [blocking]
    <file>:<line> — <message>
      suggestion: <suggestion>    ← only when non-null

  [medium]
    <file> — <message>            ← line segment omitted when null

  [low]
    ...

  [info]
    ...

  <reviewer markdown summary>
```

The `FINDINGS` block is injected between the story-status header and the
summary. Severity groups appear only when that severity has at least one
finding. When there are zero findings, the `FINDINGS` section is omitted
entirely and only the header and summary appear.

**JSON output** (`--json`):

```json
{
  "story_id": "story-001-003",
  "review_status": "approved",
  "review_summary": "...",
  "findings": [
    {
      "severity": "blocking",
      "file": "src/foo.ts",
      "line": 42,
      "message": "Missing null check",
      "suggestion": "Add a null guard before accessing .value"
    }
  ]
}
```

- `findings` is always an array; never omitted even when empty.
- The `suggestion` key is omitted entirely when null (not set to `null`).
- Severity values: `blocking` | `medium` | `low` | `info`.

## Exit codes

| Code | Meaning |
|---|---|
| 0 | Review data shown |
| 1 | Story not found or loom not initialized |

## When no review has been recorded

If `review_strategy` is off or the worker has not yet finished, `loom
review` prints a one-line notice (text) or emits `review_status: null` with
an empty `findings: []` array (JSON).

## Related commands

- `loom diff <story-id>` — the worker's diff.
- `loom status` — per-story status overview including `(revise N)` tag.
- `loom audit --story <id>` — full structured audit trail.
