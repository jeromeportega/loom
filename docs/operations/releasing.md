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

1. Bump every workspace's `package.json` version (and the root, if any)
   to the target version. `npm version <new-version> --workspaces` will
   do them all at once.
2. Commit the bump on `main`. Tag the commit:
   `git tag v0.1.0 && git push origin v0.1.0`.
3. Build and test from a clean checkout: `npm ci && npm run build && npm test`.
4. Authenticate to npm (`npm login`) if you are not already.
5. Publish each workspace in dependency order: `core` → `web` → `loom-ai`:

   ```bash
   npm publish -w @loom-ai/core
   npm publish -w @loom-ai/web
   npm publish -w loom-ai
   ```

6. Verify with `npm view @loom-ai/core`.

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
