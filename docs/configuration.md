# Configuration — three-layer resolver

Loom composes one effective policy from three sources in fixed precedence
order. Each layer is optional; absent layers contribute nothing.

## Precedence (low → high)

```
team-config.yaml  ◁  policy.yaml  ◁  LOOM_* env vars
```

In plain language:

> **loom-home team config (base)  ←  target-repo policy.yaml (override)  ←  env vars (secrets / final override)**

A value from a higher-precedence source overrides the same field from a
lower-precedence source, subject to the per-type merge semantics below.
Guard fields are the exception: they merge most-restrictively
**independent of precedence** (see table).

## Layer locations

| Layer | File | Purpose |
|---|---|---|
| **team** | `<loom-home>/team-config.yaml` | Organisation-wide defaults shared across every repo |
| **repo** | `.loom/policy.yaml` | Per-repo overrides; the primary operator config file |
| **env** | `LOOM_<SECTION>_<KEY>` env variables | CI/CD or per-deployment overrides; highest precedence |

`loom_home` (the path to the team-config directory) is read for **path
resolution** from `.loom/policy.yaml` only — it cannot come from
`team-config.yaml` (circular: the team-config file lives inside loom-home)
and `LOOM_LOOM_HOME` cannot redirect where loom looks for `team-config.yaml`
(the env layer loads after `loom_home` is already resolved). See
[repo-only field](#repo-only-field-loom_home) below.

## Per-type merge semantics

| Field type | Strategy | Behaviour |
|---|---|---|
| **Scalar** (`string`, `number`, `boolean`, `enum`) | `scalar` | Higher layer wins; lower layers are ignored when the field is present in a higher layer |
| **Object / map** | `deep` | Keys are merged recursively; each nested field follows its own strategy; no layer can remove a key contributed by another |
| **Guard denylist** (`protected_branches`, `forbidden_flags`, `protected_paths`, `risky_paths`) | `union` | Set union across all layers — adding a layer can only grow the set, never shrink it; precedence-independent |
| **Guard allowlist** (`allowed_remotes`) | `intersect` | Set intersection across all non-empty layers — the effective set is the tightest cross-layer intersection; precedence-independent |
| **Guard boolean** (`agents_must_use_pr`) | `and` | `true` wins regardless of which layer sets it; once asserted by any layer it cannot be loosened by a higher layer. `false` is only effective when no other layer has set the field to `true`. If no layer sets it, the schema default (`false`) applies. |
| **Non-guard list** (all other arrays) | `replace` | Higher layer replaces the entire list from a lower layer |
| **Type conflict** | `ConfigMergeError` | When the same key path carries different structural types across layers (e.g. string in one layer, object in another), the resolver throws `ConfigMergeError` before validation runs |

### Guard list details

Guard denylists and allowlists use most-restrictive merge **regardless of
which layer contributed the value** — this is the key distinction from
ordinary precedence-based merging:

- A **denylist** (e.g. `git.protected_branches`) can only grow. A
  team-config entry cannot be removed by `.loom/policy.yaml` or by an env var.
- An **allowlist** (e.g. `git.allowed_remotes`) is the intersection of
  every non-empty layer. A `.loom/policy.yaml` entry cannot widen the set
  beyond what `team-config.yaml` permits, and an env var cannot widen
  beyond `.loom/policy.yaml`.

**Empty array = "no opinion"**: an empty list in any layer is skipped
during intersect so that a blank `LOOM_GIT_ALLOWED_REMOTES=` env var
does not collapse the allowlist to nothing. Only layers that supply at
least one element are included in the intersection.

If the intersection produces an empty result across two or more non-empty
layers, loom emits a warning:

```
[loom] mergeLayers: intersect at "git.allowed_remotes" produced an empty allowlist —
no element is permitted by all configured layers. All operations restricted by this
field will be blocked. Check that every layer's value for "git.allowed_remotes"
shares at least one common entry.
```

An empty effective `allowed_remotes` list means **all remote pushes are blocked** —
the guard engine treats it as a full deny (no remote is whitelisted). This is the
most-restrictive outcome and is almost certainly a misconfiguration when it arises
from a non-empty intersection collapsing to zero.

### Type conflict error

When the same dotted key path carries structurally incompatible values
across layers — for example, `agents.model` is a string in `.loom/policy.yaml`
but an object in `team-config.yaml` — the merge engine throws
`ConfigMergeError` before `PolicySchema.parse` is reached:

```
Config merge conflict at "agents.model": team=map, repo=scalar
```

The error names every contributing layer and its structural kind
(`scalar`, `map`, or `list`) so the operator can identify which file to
fix.

### Schema defaults

`PolicySchema` defaults are applied **exactly once**, after all layers are
merged into a single tree. A default value is never injected
per-layer — absent fields receive defaults only at the final parse step.
This means a layer that sets a field to `null` or omits it entirely does
not force the default into the merged tree; the default is applied only
when no layer contributed a value.

A layer that sets a field to `null` is treated as **absent** — it neither
forces the default into the merged tree nor clears a value contributed by a
lower-precedence layer. `null` cannot be used as an override sentinel to
remove a lower-layer value; it is simply ignored during the merge.

## Env variable naming convention

```
LOOM_<SECTION>_<FIELD>
```

The `LOOM_` prefix is stripped and the remainder is lowercased and split
at underscores to identify the policy path. Ambiguous underscores (a
field name that itself contains underscores, such as
`agents.max_concurrent`) are resolved by matching the **longest valid
`PolicySchema` path** — `LOOM_AGENTS_MAX_CONCURRENT` maps to
`agents.max_concurrent`, not `agents_max.concurrent`.

### Examples

| Env variable | Policy path | Notes |
|---|---|---|
| `LOOM_AGENTS_MODEL` | `agents.model` | String — passed through as-is |
| `LOOM_AGENTS_MAX_CONCURRENT` | `agents.max_concurrent` | Integer — coerced from string |
| `LOOM_GIT_PROTECTED_BRANCHES` | `git.protected_branches` | Guard denylist — comma-separated (`main,release`) or JSON array (`["main","release"]`) |
| `LOOM_GIT_ALLOWED_REMOTES` | `git.allowed_remotes` | Guard allowlist — same list formats |
| `LOOM_GIT_AGENTS_MUST_USE_PR` | `git.agents_must_use_pr` | Guard boolean — `true` or `false` |
| `LOOM_FILESYSTEM_PROTECTED_PATHS` | `filesystem.protected_paths` | Guard denylist |

### Value coercion

| Target type | Accepted formats |
|---|---|
| `boolean` | `"true"` or `"false"` (case-sensitive) |
| `number` | Any finite numeric string |
| `array` | Comma-separated string (`a,b,c`) or valid JSON array (`["a","b","c"]`) |
| `string` / `enum` | Passed through as-is; validated by `PolicySchema` after merge |

Unmappable keys (those that do not match any `PolicySchema` path after
stripping the prefix) are ignored with a `console.warn` so a misspelled
variable does not silently corrupt configuration.

### Secrets are never mapped

`ANTHROPIC_*` variables and any key that does not start with `LOOM_` are
excluded from the env layer. API credentials flow exclusively through
`BaseCliWorker.workerEnv()` and never enter the config object.

## Repo-only field: `loom_home`

`loom_home` **path resolution** uses only the repo layer. The resolver
reads `loom_home` from `.loom/policy.yaml` in step 2 of
`resolveEffectiveConfig`, before the team layer or env layer is loaded,
so neither `team-config.yaml` (circular dependency) nor a
`LOOM_LOOM_HOME` env variable can redirect where loom looks for
`team-config.yaml`.

Note: `LOOM_LOOM_HOME` is a valid `LOOM_*` key — the env layer maps it
to the `loom_home` field in the merged policy tree just like any other
env override. The value lands in the final policy object but has no
effect on path resolution, which was already fixed in step 2.

## Putting it together

```yaml
# <loom-home>/team-config.yaml
git:
  protected_branches: [main, release]             # denylist: always in the union
  allowed_remotes: ["github.com/acme/backend"]    # allowlist: exact-string match with repo layer

# .loom/policy.yaml
loom_home: ~/loom-home                            # repo-only
git:
  protected_branches: [staging]                   # denylist: union → [main, release, staging]
  allowed_remotes: ["github.com/acme/backend"]    # allowlist: intersect → only acme/backend
agents:
  max_concurrent: 2                               # example scalar
  # model: ...  # omitted — defaults to the latest Claude models (see policy.agents.model)

# CI environment
LOOM_AGENTS_MAX_CONCURRENT=4            # scalar: overrides agents.max_concurrent
LOOM_GIT_PROTECTED_BRANCHES=hotfix      # denylist union → [main, release, staging, hotfix]
```

Effective result:

```yaml
git:
  protected_branches: [main, release, staging, hotfix]  # union of all layers
  allowed_remotes: ["github.com/acme/backend"]           # intersection (tightest)
agents:
  max_concurrent: 4          # env wins
```

## Validating your configuration

After editing any layer, run:

```
loom guard check <command>
```

This command evaluates `<command>` against the **fully-resolved** effective
policy (all three layers merged and validated). It exits non-zero if the
command is forbidden. This is the structural gate loom enforces at runtime —
the same one that blocks workers from running unsafe commands. Use it to
confirm that guard-list changes (new `protected_branches`, updated
`allowed_remotes`, etc.) took effect exactly as expected before dispatching
a run.

---

## Convenience aliases

Two knobs accept the literal string `on` as a convenience alias for their
most-permissive named value:

| Knob | `on` maps to | Full value set |
|---|---|---|
| `agents.qa_planning` | `advisory` | `off`, `advisory` |
| `agents.integration_branch` | `rolling` | `off`, `rolling` |

The alias is resolved at parse time by a `z.preprocess` step before Zod
validation runs — the canonical value (`advisory`, `rolling`) is what all
downstream code sees. `on` never appears after validation. This makes
`qa_planning: on` and `qa_planning: advisory` byte-identical in effect.

---

## `agents.max_concurrent` — no upper cap, soft advisory

`agents.max_concurrent` accepts any integer ≥ 1. The previous upper cap was
removed. When the configured value exceeds `max(1, cpuCount − 2)` — two
cores below the machine's detected CPU count, reserved for the OS and the
loom supervisor — loom emits a **soft advisory** at the start of `loom run`:

```
policy.agents.max_concurrent (N) exceeds the recommended ceiling of M for this machine (K CPUs). Running more concurrent workers than available cores can degrade performance. Consider lowering max_concurrent to M or fewer.
```

The advisory is informational only — the configured value is **never
modified**. To silence it, lower `max_concurrent` to the recommended
threshold in your `.loom/policy.yaml`. The threshold is computed at runtime from
`os.cpus().length` and may differ between machines.

---

## Policy validation error format

When `.loom/policy.yaml` fails Zod validation (at `PolicyEngine.load` time or
during `loom doctor`), each invalid field is reported as a four-line block:

```
Field:      agents.max_concurrent
Received:   -1
Constraint: integer >= 1
Fix:        Set agents.max_concurrent to a value of at least 1.
```

`Received:` is always populated. For numeric knobs that fail a `min` or
`max` constraint, Zod does not expose the raw value on the issue object
directly; loom extracts it from the **pre-parse config tree** via path
lookup, so the error always reflects the operator's actual input rather than
reporting `undefined`.
