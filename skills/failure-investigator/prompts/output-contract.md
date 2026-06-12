# failure-investigator — output contract

This is the machine-facing half of the skill. The headless investigator is
invoked with a single `FailurePayload` and must respond with a single
`Investigation` JSON object and nothing else — no preamble, no markdown fence,
no trailing commentary. The orchestrator validates the response against the
`Investigation` zod schema (`packages/loom-core/src/findings/investigation.ts`)
and rejects anything that does not parse.

## Required shape

```json
{
  "grade": "strong",
  "hypothesis": "The diff renamed getUser -> fetchUser but left a call site.",
  "hint": "Update the remaining getUser(...) call at auth.ts:42 to fetchUser(...).",
  "evidence_refs": [
    "auth.ts:42",
    "stderr: TypeError: getUser is not a function"
  ]
}
```

## Field rules

- `grade` — one of `strong`, `weak`, `contradictory`. Nothing else.
- `hypothesis` — non-empty, one sentence, evidence-first.
- `hint` — present and non-empty **iff** `grade === "strong"`; omit it otherwise.
  The schema's refine rejects a `strong` grade without a `hint`, and a retry is
  only as useful as this instruction, so make it concrete and actionable.
- `evidence_refs` — every claim's source. `path:line` (CWD-relative, no leading
  slash) for code; `stderr: <fragment>` or `diff: <hunk>` for payload excerpts.
  May be empty only when the grade is `weak` for lack of any usable evidence.

## Grade → router dispatch (do not restate in the output, just calibrate to it)

| grade | router decision | when |
| --- | --- | --- |
| `strong` | retry-with-hint | Confirmed/Deduced cause + an actionable fix you'd bet on. |
| `weak` | surface-to-operator | Only hypothesized, thin evidence, or a data gap. |
| `contradictory` | stop-epic | Evidence undercuts itself or the premise; a retry can't resolve it. |

Never inflate a `weak` finding to `strong` to force an auto-retry: the honest
grade is what keeps the deterministic router trustworthy.
