# Runbook — `loom web`

`loom web` launches a localhost-only web dashboard. It resolves which loom
project to serve automatically — you do not need to be in the project
directory.

## Quick start

```bash
loom web              # from any directory — auto-resolves the project
loom web --port 9000  # bind a specific port
loom web --read-only  # public GET routes; mutations require the write token
```

## Project root resolution

`loom web` determines which project to serve using this order (first match
wins):

1. **CWD is an initialized project** — `<cwd>/.loom/policy.yaml` exists →
   serve the current directory.
2. **ProjectRegistry has entries** — `ProjectRegistry.list()` returns at
   least one registered project → serve `projects[0].root` (the first
   registered project).
3. **Machine config** — `~/.loom/config.json` has a `project_root` field
   pointing to an initialized repo → serve that root.
4. **No-project mode** — server starts with no current project resolved.
   Current-project routes return 204 (no content); the repo list view still
   shows all registered repos normally. No error is printed; startup succeeds.

The resolved project root (or `(none) — federated view across all registered
repos` in no-project mode) is printed to stdout at startup so you can confirm
which project is being served.

## Active loom_home resolution

The *active loom_home* is the registry directory loom uses for federation and
self-heal writes. It is resolved in this order (first match wins):

1. **`LOOM_HOME` env var** — if set, this path is used as-is.
2. **`policy.loom_home` from the served project** — if a current project was
   resolved and its `.loom/policy.yaml` sets `loom_home`, that path is used.
3. **Machine default** — `~/.loom` (the default loom home directory).

When no current project is resolved (no-project mode), step 2 is skipped and
the resolution falls through to step 1 or step 3.

## Federated list view

The repo list view federates entries from **two registry sources**, merged at
startup:

1. **Machine-default registry** — `~/.loom/projects.json` (entries loaded
   first as the base layer).
2. **Active loom_home registry** — `<active-loom_home>/projects.json` (entries
   overlaid on top; active-loom_home wins on conflict when the same project
   root appears in both).

If the resolved current project is absent from both registries, it is
force-included in the in-memory list **and** written back to the active
loom_home registry (`<active-loom_home>/projects.json`) so subsequent runs
find it there automatically. This self-heal write is best-effort: any
filesystem error is silently swallowed and never causes startup to fail.

The resolved project root determines which state database backs the server;
the UI queries each registered project for its epic list.

## Options

| Flag | Description |
|---|---|
| `--port <n>` | Port to bind (default 8765; searches up to +20 if taken) |
| `--no-open` | Don't auto-open the browser after starting |
| `--read-only` | GET routes require no token; mutations still require the write token. Also enabled by `LOOM_WEB_READONLY=1`. |

## Auth

A random token is generated on each launch. It is printed to stdout and
embedded in the URL fragment:

```
  Open: http://127.0.0.1:<port>/#token=<token>
```

The server is bound to `127.0.0.1` only (never `0.0.0.0`). The token
defends against rogue same-machine processes reading session state.

## Operator sensitivity note

Even in `--read-only` mode the SSE stream emits `log_tail` worker output,
cost figures, branch names, and PR URLs. Treat the URL as internal-only
unless those fields are safe to expose.

## Related commands

- `loom status` — CLI equivalent of the web list view.
- `loom init` — register a repo so it appears in the ProjectRegistry.
- `loom projects` — list every registered project on the machine.
