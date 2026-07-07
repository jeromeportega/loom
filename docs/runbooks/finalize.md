# Finalize Correctness Gates Runbook

How to interpret and respond to the three correctness gates that run during `loom finalize`.

---

## Overview

After the integration gate (build/test suite) passes, loom runs three additional semantic
checks before opening the PR. These catch interface drift and undocumented changes that the
build suite cannot see:

| Gate | What it catches | Can block? |
|---|---|---|
| **contract-symbol drift** | A symbol this epic's shared contract pins is missing from the delivered code | No — advisory |
| **undocumented env-var** | A new `process.env.VAR` reference was added without a `.env.example` entry | **Yes** |
| **cross-epic regression** | A symbol a prior delivered epic pinned was present before this epic and is gone after | No — advisory |

**Presence is tested against the integrated git tree, not against a diff.** A symbol counts as
"present" if it appears — as a whole word — anywhere in the epic's integrated tree, including
files this epic never touched. This is deliberate: a contract symbol is only violated when it
is absent from the *entire delivered codebase*, not merely from one story's diff. Contracts are
read from the real repo root (`.loom/contract/<epic-id>.md`), even under rolling integration
where the gate runs in a separate integration worktree.

### Advisory vs. blocking

Only the **undocumented-env-var** gate can withhold a PR. It is an exact set-membership test
(a var the code reads that is not in `.env.example`, minus an ambient-var allowlist), so its
findings are trustworthy enough to block.

The **contract-symbol drift** and **cross-epic regression** gates are heuristics over
prose-heavy markdown contracts. They are genuinely useful signals but carry a non-zero
false-positive rate, so they are **always advisory** — printed for the operator but never a
hard-fail, regardless of policy mode. This prevents a mis-extracted prose word from blocking
a correct epic.

| `policy.agents.integration_gate` | env-var gate | drift / regression gates |
|---|---|---|
| `off` | skipped | skipped |
| `warn` (default) | findings printed; PR opens | findings printed; PR opens |
| `block` | **PR withheld** if any finding; epic → `in_progress` | findings printed; PR still opens |

When the env-var gate blocks, the note printed to the operator is:

```
Finalize gates BLOCKED epic/<id>: symbol-drift=N, undoc-env-var=N, regression=N.
Fix and re-run, or set policy.agents.integration_gate=warn to land regardless.
```

(The `symbol-drift`/`regression` counts are shown for context, but only `undoc-env-var` drives
the block.)

---

## Gate 1: Contract-symbol drift (advisory)

**What it checks:** every symbol pinned in this epic's shared contract
(`.loom/contract/<epic-id>.md`) is still present, as a whole word, somewhere in the integrated
tree. Symbols are extracted from fenced code blocks and inline code spans only, and are further
narrowed to "significant" identifiers — mixed-case (`PascalCase`/`camelCase`) or
`UPPER_SNAKE`-with-underscore. Bare lowercase words (`when`, `state`) and bare all-caps prose
labels (`OWNER`, `LAYER`) are ignored, because in a markdown contract they are almost always
prose, not named seams.

**When it fires:** a pinned identifier the Architect committed to no longer exists anywhere in
the delivered code — usually because a story renamed or dropped it without updating the
contract.

**Audit action:** `epic_finalize_symbol_drift` with `{ count: N }`.

**Diagnostic format** (emitted to stderr per finding):

```
[finalize] contract drift: pinned symbol 'MyInterface' (contract: epic-042) is not present in the integrated tree — it may have been renamed or dropped
```

**How to fix:** either update the contract to match what was actually built, or restore the
pinned name. If the rename is intentional, update the contract (`epics/<id>/architecture.md`)
and re-run. Because this gate is advisory, an unfixed finding never blocks the PR — but it is
worth resolving so the contract stays honest for downstream epics.

---

## Gate 2: Undocumented env-var (blocking)

**What it checks:** every new `process.env.VAR` reference introduced in the assembled diff has
a corresponding entry in `.env.example` at the project root. Ambient system/CI variables
(`PATH`, `NODE_ENV`, `CI`, `HOME`, …) are allow-listed and never flagged.

**`.env.example`-absent behavior:** when `.env.example` does not exist in the project root, this
gate is **automatically skipped** (returns zero findings). A notice is emitted:

```
[finalize] .env.example not found at <path> — skipping undocumented env-var gate
```

No action is needed unless your project deliberately documents environment variables — in that
case, create `.env.example` at the repo root.

**Audit action:** `epic_finalize_undoc_env_var` with `{ count: N }`.

**Diagnostic format** (emitted to stderr per finding):

```
[finalize] undocumented env var: DATABASE_URL (src/db/client.ts) — not documented in .env.example
```

**How to fix:** add the variable to `.env.example` with a placeholder value and a comment
explaining its purpose. Example:

```bash
# Connection string for the primary database
DATABASE_URL=postgres://localhost:5432/myapp
```

---

## Gate 3: Cross-epic regression (advisory)

**What it checks:** symbols pinned in the contracts of all previously `done` epics that were
present in the tree **before** this epic (at the epic's base commit) but are **gone after** it
(at the integrated head). "Present-before, absent-after" attributes the removal to this epic and
ignores churn — a symbol that was merely moved or reformatted is still present at head and is
not flagged. In-flight (non-`done`) epics' contracts are not checked.

**When it fires:** the current epic removed or renamed an identifier that a prior delivered
epic's shared contract committed to — breaking the implicit interface between epics.

**Audit action:** `epic_finalize_regression` with `{ count: N }`.

**Diagnostic format** (emitted to stderr per finding):

```
[finalize] cross-epic regression: 'runFinalizeGates' (pinned by epic-077) was present before this epic but is gone from the integrated tree
```

**How to fix:** either restore the removed symbol (add a deprecation wrapper if needed) or, if
the rename is intentional, update all consuming callers and the prior epic's contract. Advisory
only — it never blocks — but a genuine regression is worth resolving before it reaches a
downstream epic.

---

## Policy control

All three gates are controlled by a single policy knob (shared with the build/test gate):

```yaml
# .loom/policy.yaml
agents:
  integration_gate: warn   # off | warn | block
```

- `warn` (default) — build suite runs; all gate findings are advisory; the PR always opens.
- `block` — the build suite and the **undocumented-env-var** gate can withhold the PR; drift
  and regression findings remain advisory.
- `off` — skips the build/test suite AND all three finalize gates entirely.

> **Note:** there is no separate knob to make drift/regression blocking. They are advisory by
> design until the contract format is structured enough to extract symbols without
> false positives.

---

## Reading the audit log

After a finalize run, inspect finding counts via:

```bash
loom audit | grep 'epic_finalize_'
```

Each row records the epic id and `{ count: N }`. A count of `0` means the gate ran clean.

---

## Path-scoped integration gate (`test_commands`)

When `policy.agents.test_commands` is set, the integration gate selects and runs
entries based on which files changed in the epic:

```yaml
# .loom/policy.yaml
agents:
  test_commands:
    - name: api-tests
      command: "npm test --workspace packages/api"
      paths:
        - "packages/api/**"
    - name: web-tests
      command: "npm test --workspace packages/web"
      paths:
        - "packages/web/**"
```

**Selection:** each entry is evaluated against the epic's changed file list
(`git diff --name-only` from the epic base commit to the integrated HEAD). An
entry is selected when at least one changed file matches at least one of the
entry's glob patterns (repo-root-relative paths, minimatch default options:
`dot=false`, `nocase=false`). When the git base cannot be resolved, all entries
run unconditionally.

**Execution order:** selected entries run sequentially in declaration order. All
run to completion — there is no fail-fast. Unselected entries are skipped and
do not contribute a failure.

**Per-entry result reporting:** each entry produces an individual result record —
name, command, status (`passed` | `failed` | `skipped`), exit code, stdout tail,
and duration — stored in the `epic_integration_gate` audit row as the `steps`
field (`loom audit` surfaces this row; `detail.steps[]` contains per-entry
results). The overall gate fails when any selected entry exits non-zero;
all-skipped counts as a pass.

**Precedence:** `test_command` (singular) takes precedence over `test_commands`
when both are set. An empty `test_commands: []` falls through to auto-detection.

**`loom doctor` preflight:** `loom doctor` checks that every `test_commands`
entry's lead binary resolves on the gate's PATH before dispatch — the same PATH
the integration gate inherits. Missing binaries are reported as advisory failures
(`required: false`).

---

## Smoke gate

After the three correctness gates pass (or are skipped), loom runs the **smoke gate** — a
quick command on the integrated worktree to verify the merged code still starts, routes, or
behaves correctly. It is not a substitute for the build/test suite in the integration gate;
it is a lightweight last check that the final assembled artifact is viable.

### Finalize sequence

```
merge story branches
  ↓
integration gate (build / test suite)
  ↓
correctness gates (symbol drift · env-var · regression)
  ↓
smoke gate  ←── this section
  ↓
review phase → push → open PR
```

### Command resolution

When `integration_gate` is not `off`, loom resolves the smoke command in priority order:

1. `policy.agents.smoke_command` (when set to a non-empty string)
2. `package.json scripts.smoke` → `"npm run smoke"`
3. `package.json scripts.verify` → `"npm run verify"`
4. `null` — step is silently skipped; finalize continues

When the resolver returns `null` (no command found), no audit entry is written.

### Gate-mode behavior table

| `integration_gate` | smoke command resolved? | smoke exits 0 | Result |
|---|---|---|---|
| `off` | (not called) | — | Step skipped; no audit entry |
| `warn` or `block` | `null` | — | Step silently skipped; finalize continues |
| `warn` | yes | yes | Audit entry written (`allowed=1`); finalize continues |
| `warn` | yes | no / timeout | Audit entry written (`allowed=0`); failure annotated to output; PR still opens |
| `block` | yes | yes | Audit entry written (`allowed=1`); finalize continues |
| `block` | yes | no / timeout | Audit entry written (`allowed=0`); epic set to `in_progress`; PR **withheld**; `SmokeGateError` thrown |

### Timeout

The default wall-clock budget is **15 minutes**, controlled by `policy.agents.smoke_timeout_minutes`
(positive integer). On timeout, loom sends **SIGKILL** directly to the entire process group
(no SIGTERM grace period). The `timeout_killed: true` flag appears in the audit detail and in
the `SmokeGateError` message when this fires.

### Policy configuration

```yaml
# .loom/policy.yaml
agents:
  smoke_command: "npm run smoke"    # optional; overrides auto-detection
  smoke_timeout_minutes: 15         # default; positive integer
  integration_gate: block           # off | warn | block — governs smoke gate mode
```

### Audit row

Every completed smoke run (pass or fail) writes a `smoke_gate` row to the audit log:

```
action:      smoke_gate
command:     <the resolved command string>
allowed:     1 (pass) | 0 (fail)
detail:
  exit_code:        <integer>
  duration_seconds: <float>
  timeout_killed:   true | false
  gate_mode:        "block" | "warn"
```

Inspect via:

```bash
loom audit | grep smoke_gate
```

### `loom doctor` preflight

`loom doctor` runs `smokeDoctorCheck` after the existing gate-runnable check. It resolves the
smoke command (using the same resolver) and reports whether the lead binary is found on PATH:

- **`pass` / `detail: "none resolved"`** — no smoke command detected; the step will be skipped.
- **`pass` / `detail: "<cmd> — binary '<bin>' (found on PATH)"`** — command detected; binary present.
- **`warn` / `detail: "<cmd> — binary '<bin>' NOT found on PATH"`** — command detected; binary missing.
  Install the missing binary or override `smoke_command` in `policy.yaml`.

The check is advisory (`required: false`) — it never makes `loom doctor` exit non-zero on its own.

### Recovery: smoke gate blocked in `block` mode

When the smoke gate blocks a finalize:

1. The epic status is set back to `in_progress` with a note like
   `"smoke gate failed: exit 1"` (or `"(timed out)"`).
2. No PR is opened.
3. Fix the root cause of the smoke failure (the command in `smoke_command` or the
   auto-detected one from `package.json`).
4. Re-run:
   ```bash
   loom finalize --resume <epic-id>
   ```
   The resume path re-merges only phases that remain, which in practice means it re-runs the
   smoke gate (and push + PR if smoke passes).
5. To bypass smoke entirely for this recovery, set `integration_gate: warn` in `policy.yaml`
   before running `loom finalize --resume` — the re-read late-bound policy will pick it up.

---

## Related

- [Integration branch runbook](integration-branch.md) — rolling integration branch and lag warnings
- [`docs/capabilities.md`](../capabilities.md) — full capability reference, including the Finalize correctness gates row and Smoke gate row
