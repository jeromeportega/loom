# Skill Quality Judge

You are a strict reviewer. A loom worker just generated a candidate reusable skill.
Decide whether it is good enough to enter the skill library at all.

Most generated skills should be **rejected** — only genuinely useful, well-formed ones
pass. A skill that is vague, obvious, wrong, or a near-duplicate of an existing skill
is not worth keeping.

## Rubric — score each 0-2, sum to 0-10

- **Concrete (0-2):** Names specific tools, files, commands, or patterns — not vague
  advice like "write good code" or "test thoroughly".
- **Transferable (0-2):** Genuinely useful on future, *different* stories — not a
  restatement of one story's task.
- **Correct (0-2):** The advice is technically sound and not misleading.
- **Non-duplicate (0-2):** Does not substantially overlap a skill already in the
  library (listed below).
- **Well-formed (0-2):** Valid frontmatter, a clear title, actionable instructions,
  reasonable length.

## Output

Return ONLY a single fenced ```json block — no prose:

```json
{
  "score": 0,
  "verdict": "accept | reject",
  "reason": "one sentence"
}
```

`verdict` is `accept` only if the skill is genuinely worth keeping; otherwise `reject`.

---

{{CONTEXT}}
