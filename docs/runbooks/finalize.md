# Finalize Correctness Gates Runbook

How to interpret and respond to the three correctness gates that run during `loom finalize`.

---

## Overview

After the integration gate (build/test suite) passes, loom runs three additional semantic
checks on the assembled epic diff before opening the PR. These checks catch interface
drift and undocumented changes that the build suite cannot see:

| Gate | What it catches |
|---|---|
| **contract-symbol drift** | A story silently changed a symbol agreed in the epic's shared contract |
| **undocumented env-var** | A new `process.env.VAR` reference was added without a `.env.example` entry |
| **cross-epic regression** | A symbol pinned by a prior delivered epic's contract was removed or renamed |

All three gates share the `policy.agents.integration_gate` knob (`off` / `warn` / `block`,
default `warn`). A gate finding never withholds the PR by itself — the *policy mode* does:

| Mode | Effect when a finding is present |
|---|---|
| `off` | All three gates are skipped entirely — no checks, no findings |
| `warn` (default) | Findings printed to stderr; PR still opens |
| `block` | PR withheld; epic flipped to `in_progress`; audit rows record finding counts |

When `block` triggers, the note printed to the operator is:

```
Finalize gates BLOCKED epic/<id>: symbol-drift=N, undoc-env-var=N, regression=N.
Fix and re-run, or set policy.agents.integration_gate=warn to land regardless.
```

---

## Gate 1: Contract-symbol drift

**What it checks:** every symbol pinned in this epic's shared contract
(`.loom/contract/<epic-id>.md`) is still present somewhere in the assembled diff. Symbols
are extracted from fenced code blocks and inline code spans only — plain prose is ignored.

**When it fires:** a story changed, removed, or renamed an identifier that the Architect's
shared contract committed to in this same epic. This usually means a story diverged from
the agreed interface without updating the contract.

**Audit action:** `epic_finalize_symbol_drift` with `{ count: N }`.

**Diagnostic format** (emitted to stderr per finding):

```
[finalize] symbol drift: 'MyInterface' (contract: epic-042) in story-042-003 — -export interface MyInterface {
```

**How to fix:** either update the contract to match what was actually built, or revise the
story diff to match the contract. If the drift is intentional, update the contract first
(`epics/<id>/architecture.md`) and re-run.

---

## Gate 2: Undocumented env-var

**What it checks:** every new `process.env.VAR` reference introduced in the assembled diff
has a corresponding entry in `.env.example` at the project root.

**`.env.example`-absent behavior:** when `.env.example` does not exist in the project root,
this gate is **automatically skipped** (returns zero findings). A warning is emitted:

```
[finalize] .env.example not found at <path> — skipping undocumented env-var gate
```

No action is needed unless your project deliberately documents environment variables — in
that case, create `.env.example` at the repo root.

**Audit action:** `epic_finalize_undoc_env_var` with `{ count: N }`.

**Diagnostic format** (emitted to stderr per finding):

```
[finalize] undocumented env var: DATABASE_URL (src/db/client.ts) — +  const url = process.env.DATABASE_URL;
```

**How to fix:** add the variable to `.env.example` with a placeholder value and a comment
explaining its purpose. Example:

```bash
# Connection string for the primary database
DATABASE_URL=postgres://localhost:5432/myapp
```

---

## Gate 3: Cross-epic regression

**What it checks:** symbols pinned in the contracts of all previously `done` epics still
exist in the assembled diff. A symbol is "removed" when it appears as a deletion (`-` line)
in any story diff without a corresponding addition.

**When it fires:** the current epic removed or renamed an identifier that a prior epic's
shared contract committed to. This breaks the implicit interface between epics — downstream
epics built against that symbol will fail.

**Audit action:** `epic_finalize_regression` with `{ count: N }`.

**Diagnostic format** (emitted to stderr per finding):

```
[finalize] regression: 'runFinalizeGates' removed in story-077-003 (prior contract: epic-077) — -export async function runFinalizeGates(
```

**How to fix:** either restore the removed symbol (add a deprecation wrapper if needed)
or update the prior epic's contract to reflect the new name. If the rename is intentional,
update all consuming callers first, then let the gate pass.

---

## Policy control

All three gates are controlled by a single policy knob:

```yaml
# .loom/policy.yaml
agents:
  integration_gate: warn   # off | warn | block
```

To land regardless of gate findings (emergency bypass):

```yaml
agents:
  integration_gate: warn
```

To enforce strict correctness and block any finding from landing:

```yaml
agents:
  integration_gate: block
```

To skip all correctness checks entirely:

```yaml
agents:
  integration_gate: off
```

> **Note:** `integration_gate: off` skips both the build/test suite AND all three finalize
> correctness gates. Use `warn` if you want the build suite to run but gate findings to be
> advisory only.

---

## Reading the audit log

After a finalize run, inspect finding counts via:

```bash
loom audit | grep 'epic_finalize_'
```

Each row records the epic id and `{ count: N }`. A count of `0` means the gate ran clean.

---

## Related

- [Integration branch runbook](integration-branch.md) — rolling integration branch and lag warnings
- [`docs/capabilities.md`](../capabilities.md) — full capability reference, including the Finalize correctness gates row
