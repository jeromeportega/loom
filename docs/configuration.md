# Configuration — three-layer resolver

Loom composes one effective policy from three sources in fixed precedence
order. Each layer is optional; absent layers contribute nothing.

## Precedence (low → high)

```
team-config.yaml  ◁  policy.yaml  ◁  LOOM_* env vars
```

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

`loom_home` (the path to the team-config directory) is always read from
`policy.yaml` only — it cannot come from `team-config.yaml` (circular)
or from an env variable (the env layer loads after `loom_home` is
resolved). See [repo-only field](#repo-only-field-loom_home) below.

## Per-type merge semantics

| Field type | Strategy | Behaviour |
|---|---|---|
| **Scalar** (`string`, `number`, `boolean`, `enum`) | `scalar` | Higher layer wins; lower layers are ignored when the field is present in a higher layer |
| **Object / map** | `deep` | Keys are merged recursively; each nested field follows its own strategy; no layer can remove a key contributed by another |
| **Guard denylist** (`protected_branches`, `forbidden_flags`, `protected_paths`, `risky_paths`) | `union` | Set union across all layers — adding a layer can only grow the set, never shrink it; precedence-independent |
| **Guard allowlist** (`allowed_remotes`) | `intersect` | Set intersection across all non-empty layers — the effective set is the tightest cross-layer intersection; precedence-independent |
| **Guard boolean** (`agents_must_use_pr`) | `and` | `true` wins regardless of which layer sets it; once asserted by any layer it cannot be loosened by a higher layer |
| **Non-guard list** (all other arrays) | `replace` | Higher layer replaces the entire list from a lower layer |
| **Type conflict** | `ConfigMergeError` | When the same key path carries different structural types across layers (e.g. string in one layer, object in another), the resolver throws `ConfigMergeError` before validation runs |

### Guard list details

Guard denylists and allowlists use most-restrictive merge **regardless of
which layer contributed the value** — this is the key distinction from
ordinary precedence-based merging:

- A **denylist** (e.g. `git.protected_branches`) can only grow. A
  team-config entry cannot be removed by `policy.yaml` or by an env var.
- An **allowlist** (e.g. `git.allowed_remotes`) is the intersection of
  every non-empty layer. A `policy.yaml` entry cannot widen the set
  beyond what `team-config.yaml` permits, and an env var cannot widen
  beyond `policy.yaml`.

**Empty array = "no opinion"**: an empty list in any layer is skipped
during intersect so that a blank `LOOM_GIT_ALLOWED_REMOTES=` env var
does not collapse the allowlist to nothing. Only layers that supply at
least one element are included in the intersection.

If the intersection produces an empty result across two or more non-empty
layers, loom emits a warning (`[loom] mergeLayers: intersect at "..."
produced an empty allowlist`) because this almost certainly indicates a
misconfiguration.

### Type conflict error

When the same dotted key path carries structurally incompatible values
across layers — for example, `agents.model` is a string in `policy.yaml`
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
stripping the prefix) are **silently ignored** with a `console.warn` so a
misspelled variable does not silently corrupt configuration.

### Secrets are never mapped

`ANTHROPIC_*` variables and any key that does not start with `LOOM_` are
excluded from the env layer. API credentials flow exclusively through
`BaseCliWorker.workerEnv()` and never enter the config object.

## Repo-only field: `loom_home`

`loom_home` is read exclusively from `.loom/policy.yaml` (the repo
layer). It cannot be set via `team-config.yaml` (circular dependency —
the team-config file lives inside loom-home) or via a `LOOM_LOOM_HOME`
env variable (the env layer is loaded after `loom_home` is resolved). A
`LOOM_LOOM_HOME` variable is silently ignored by the env layer.

## Putting it together

```yaml
# <loom-home>/team-config.yaml
git:
  protected_branches: [main, release]   # denylist: always in the union
  allowed_remotes: ["github.com/acme/*"]  # allowlist: intersect with repo layer

# .loom/policy.yaml
loom_home: ~/loom-home                  # repo-only
git:
  protected_branches: [staging]         # denylist: union → [main, release, staging]
  allowed_remotes: ["github.com/acme/backend"]  # allowlist: intersect → only acme/backend
agents:
  model: claude-opus-4-8

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
  model: claude-opus-4-8     # repo wins (env did not set it)
  max_concurrent: 4          # env wins
```
