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
4. **Error** — exits 1 with:
   ```
   loom is not initialized in this directory and no loom project is registered. Run `loom init` first.
   ```

The resolved project root is printed to stdout at startup so you can confirm
which project is being served.

## Federated list view

Regardless of which project root was resolved, the web UI list view always
federates across **every loom-init'ed repo on the machine**, grouped by
project name (current project first). The resolved project root determines
which state database backs the server; the UI queries each registered project
for its epic list.

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
