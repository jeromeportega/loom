# Releasing loom

Loom is a TypeScript monorepo published to the **npm registry**. Publishing
is manual today (no CI pipeline); the steps below cut a release by hand.

End-state install:

```bash
npm install -g loom-ai
loom doctor
```

`loom` must be on the user's PATH — worker agents invoke it for their
guardrail hook.

---

## Publishable packages

| Package | npm name | Purpose |
|---|---|---|
| `packages/loom-core` | `@loom-ai/core` | Orchestration engine |
| `packages/loom-web` | `@loom-ai/web` | Local web dashboard |
| `packages/loom-cli` | `loom-ai` | The `loom` CLI (depends on the others) |

Workers reach loom via the CLI; the local web dashboard (`loom web`) is the
visibility surface.

---

## Cutting a release

Loom's guard blocks direct pushes to `main`, so releases use a PR-merge flow.
The `loom release` command handles the branch, bump, commit, push, and PR in
one step — this flow works inside any loom-managed repo without disabling
guardrails.

### Prerequisites

Run from a clean `main` branch (nothing uncommitted, no untracked files
that should not be in the release):

```bash
git checkout main
git pull origin main
git status   # should show "nothing to commit, working tree clean"
```

For Step 4 (npm publish) you also need an npm session:

```bash
npm whoami   # should show your npm username; run npm login if not authenticated
```

### Step 1 — open the release PR

```bash
loom release <version>
```

For example:

```bash
loom release 5.3.0
# or
loom release v5.3.0   # leading v is stripped automatically
```

`loom release` does exactly this, in order:

1. Runs `scripts/bump-versions.mjs <version>` to bump every workspace
   `package.json` (root + `packages/*/package.json`) to the target version.
2. Creates a `release/v<version>` branch (e.g. `release/v5.3.0`).
3. Stages only the bumped `package.json` files and commits
   `chore(release): v<version>`.
4. Pushes `release/v<version>` to `origin` (guard-compatible — not a
   protected branch, no `--force` flag).
5. Opens a PR against `main` titled `chore(release): v<version>`.

The command prints the PR URL on success.

### Step 2 — build, test, and merge

Before merging the PR, verify from a clean checkout:

```bash
npm ci && npm run build && npm test
```

Merge the PR when green. Note the merge commit SHA — you need it in the next
step.

### Step 3 — tag the merge commit (post-merge operator step)

After the PR is merged, tag the merge commit and push the tag. Use the
SHA noted in Step 2 directly — do **not** resolve `origin/main` at tag
time, since another commit could land between your merge and the `fetch`:

```bash
git fetch origin
git tag v<version> <merge-sha>   # <merge-sha> from the GitHub merge confirmation
git push origin v<version>
```

For example, if the merge SHA shown on GitHub was `a1b2c3d`:

```bash
git fetch origin
git tag v5.3.0 a1b2c3d
git push origin v5.3.0
```

If you did not note the SHA during the merge, retrieve it with:

```bash
git fetch origin && git log --merges origin/main -1 --format=%H
```

Tag pushes to `origin` pass the guard — `v<version>` is not a protected
branch, and no `--force` flag is used.

### Step 4 — documentation review

Before publishing to npm, review narrative and operational docs for accuracy
at this release:

- [ ] **Narrative docs** (`README.md`, `docs/index.md`,
  `docs/getting-started/index.md`) — verify phrasing matches current
  behaviour; remove any superseded claims.
- [ ] **Operational docs** (`docs/operations/`) — confirm commands, flags,
  and runbook steps still match the shipped code.
- [ ] **Capabilities page** (`docs/capabilities.md`) — confirm the command
  and policy-knob tables reflect what ships in this version.

> **Automated README/index drift flag — deferred.**
> Extending `checkCapabilitiesCoverage()` to auto-flag narrative/prose drift
> was evaluated; the function is token-exact and cannot judge prose accuracy,
> so the automated flag is deferred. This checklist item is the required minimum.

### Step 5 — npm publish

Authenticate to npm (`npm login`) if you are not already, then publish each
workspace in dependency order:

```bash
npm publish -w @loom-ai/core
npm publish -w @loom-ai/web
npm publish -w loom-ai
```

Verify with `npm view @loom-ai/core`.

If publish fails partway (e.g. `core` published but `loom-ai` errored), do
not retry the same version — bump to the next patch version and re-cut.
Republishing the same version is rejected by npm.

---

## Local "publish-like" dry runs

To exercise the pack step without uploading:

```bash
npm run build
npm pack -w @loom-ai/core   # writes a .tgz; inspect what would be published
```

The `files` field in each `package.json` controls what ships — only
`dist/` (and `personas/` / `eval-cases/` for core) should be inside the
tarball.

---

## Why a PR instead of a direct push?

The loom guard (`loom guard hook`) blocks direct pushes to `main` and
`master` — that path is reserved for PRs. `release/v*` branches are
explicitly permitted, so the `loom release` flow works inside any
loom-managed repo without touching policy.
