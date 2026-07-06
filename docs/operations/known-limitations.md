# Known Limitations

Tracking deferred work and known edge cases. Each item has a deferral reason and a trigger for revisiting.

---

## State layer

**`loom status` only shows the latest agent per story**
- `AgentStore.getByStory` returns the most recent attempt, hiding retries.
- **Revisit when**: retry analytics or failure patterns become a debugging need.

---

## Policy engine

**Default policy YAML duplicates `PolicySchema` zod defaults**
- `DEFAULT_POLICY_YAML` in `loom-cli/src/commands/init.ts` is hand-written.
- **Risk**: drift when adding new policy fields. Both must be updated.
- **Revisit when**: we add the 3rd new policy field; consider generating the YAML from the zod schema.

**Pre-subcommand git flags edge case**
- `git -c user.name=foo commit ...` is parsed as flag `-c`, arg `user.name=foo`, subcommand `commit`.
- Currently works for our checks but is fragile.
- **Revisit when**: a false positive shows up in Epic 3's worker agents.

**Filesystem heuristic uses string-based path detection**
- `checkFilesystemWrite` finds path-like tokens via `startsWith('/') || startsWith('~')`. Misses paths starting with relative segments that resolve to protected areas (rare).
- **Revisit when**: we see a real-world bypass. For MVP the `rm` and program-specific checks cover the common cases.

**Read-scope enforcement applies to the Claude Code hook only, and is best-effort on the Bash channel**
- `policy.filesystem.allowed_read_root` confines worker `Read`, `Grep`, `Glob`, and the common Bash search commands (`grep`/`rg`/`find`/`cat`/`ls`) to the agent's own worktree and the resolved `allowed_read_root` (default `.`, resolved relative to the worktree at hook time — not pre-resolved at init; on by default; independent of `cross_repo.enabled`). Enforcement is via the Claude Code PreToolUse hook (`loom guard hook`); the generated `settings.json` carries only `allow` globs and no broad `deny` (a `deny` beats `allow` under `bypassPermissions` and would block in-worktree reads).
- **Bash read channel is best-effort**: the hook scopes the common file readers by their path arguments, but a determined worker can still read arbitrary paths through an interpreter (`python -c 'open("/etc/passwd")'`, `node -e`, `perl`/`ruby`), an uncovered reader, or shell redirection (`od < /etc/passwd`). These cannot be scoped by argument inspection without breaking legitimate interpreter use; fully closing the channel requires an OS-level sandbox (seccomp/landlock/container). The native `Read`/`Grep`/`Glob` tools — the actual over-scan surface — are fully hook-enforced.
- A `cursor-cli` worker does not receive the read-scope hook check — the same structural gap as write-scope enforcement documented in the Cursor CLI backend section.
- **Revisit when**: wiring read-scope enforcement into a Cursor-native hook alongside write-scope parity, or adding an OS-level sandbox to close the Bash read channel.

---

## Test environment

**Integration test cwd discovery**
- `init.test.ts` uses `__dirname` to find the built CLI. Works because tests run after build.
- **Risk**: if someone runs `node --test src/**` directly (without build), tests reference a missing path.
- **Mitigation**: the npm `test` script depends on the build script.

---

## Hook protocol

**`loom guard hook` fails open on malformed stdin**
- If the JSON payload is corrupted or stdin is empty (interactive run), the hook exits 0.
- This is intentional: we'd rather let an edge case through than break unrelated tools that share `.claude/settings.json`.
- **Trade-off**: documented; revisit if we see misuse.

---

## Planning pipeline (Epic 2)

**Prompt caching is inert for planning calls**
- Persona system blocks are flagged `cache: true` and `AnthropicClient` emits
  `cache_control: ephemeral` correctly, but the persona prompts (~500–800 tokens) are
  below Anthropic's ~1024-token minimum cacheable size, so the cache never engages.
- Not a bug — planning is only ~5 calls/run. The real caching ROI is the large shared
  context broadcast to many agents in Epic 3 and skill manifests in Epic 5.
- **Revisit when**: implementing Epic 3 worker dispatch — cache the project context.

**Concurrent planning runs can race on epic numbering**
- `Planner.nextEpicId()` reads-then-writes; two runs started together could collide on
  the epics primary key. Fails loudly (no data corruption); low likelihood.
- **Revisit when**: Epic 3/4 — wrap epic creation in a transaction or advisory lock.

**Epic YAML `status` field drifts from the DB**
- Both the epic YAML and the `epics` table carry status. The DB is the source of truth;
  the YAML value is plan-time only and goes stale after approval.
- **Applies to**: Epic 3 — the supervisor must read status from the DB, never the YAML.

**`trimToFirstHeading` only handles `#` ATX headings**
- A response opening with `##` or a Setext heading would not be trimmed. The personas
  ask for a leading `#`, so this is a safety net working as designed.

**Partial artifacts remain after a failed planning run**
- A planner failure can leave `project-brief.md` / `prd.md` on disk with no DB epics.
  Re-running `loom epic` reuses the run id and overwrites cleanly — self-healing.

---

## Story dispatch (Epic 3)

**`ClaudeCodeWorker` subprocess flow is not CI-tested**
- The `claude` spawn and the push / `gh pr create` flow only run against a real
  environment with `claude` and `gh` installed. Prompt building and result
  interpretation are unit-tested; the Supervisor is fully tested via `MockWorkerRunner`.

**A retried story reuses its old worktree**
- Re-running `loom run` after a failure creates a fresh agent record but reuses the
  existing (half-done) worktree — the worker fixes forward rather than starting clean.

**Default policy produces local branches, not PRs**
- With the default `allowed_remotes: []`, loom does not push — every story ends `done`
  with a local branch. Add your remote to `policy.git.allowed_remotes` to enable PRs.
  This is safe-by-default behaviour, not a bug.

---

## IDE integrations (Epic 6)

**The hook's absolute loom path goes stale if loom is reinstalled**
- `loom init` writes `node "<absolute dist/index.js>" guard hook` so the guardrail
  fires without `loom` on PATH. If loom is moved or reinstalled elsewhere, the path
  is stale — re-run `loom init` to refresh it.

---

## Onboarding & control (Epic 10)

**`loom stop` is graceful only — no hard abort**
- `loom stop` lets in-flight stories finish, then halts dispatch. There is no
  `loom stop --now` to kill running workers — that needs `WorkerRunner` cancellation
  and leaves half-done worktrees. Documented as a follow-up.

**The control signal assumes one supervisor per repo**
- `loom_control` is a single row; concurrent runs in the same repo share it, and each
  `run()` resets it. Single-run-per-repo is the assumption.

**`--checkpoint=story` forces concurrency 1**
- "Run one story then pause" caps concurrency at 1 — no parallelism while stepping.

**LICENSE and publishing path are unresolved**
- The repo is private. No LICENSE file is committed, and `loom-ai` is not on
  npm yet — install is from a checkout today. See `docs/RELEASING.md` for the
  open questions.

---

## Org MCP provisioning (Epic 8)

**Approved-MCP tool calls bypass the policy engine**
- The guardrail engine inspects Bash commands; MCP tool calls are not Bash. A
  provisioned MCP server's tools are not policy-checked. This is by design — the org
  registry allowlist is the trust boundary — but provisioning a server grants worker
  agents capabilities the policy engine does not see.

**The MCP registry is a local checkout, not a live fetch**
- `policy.mcp.registry` is a directory path. loom does not clone or pull it — the org
  keeps the checkout fresh (`git pull`). A live fetch would bake auth into loom.

**`loom mcp add` always picks the stdio package; there is no `loom mcp remove`**
- For a server shipping both transports, stdio wins. Removal is a manual `.mcp.json`
  edit.

---

## Eval & safety (Epic 7)

**A green `npm test` is not a quality measurement**
- The eval suite runs in CI with `MockLLMClient` — it verifies the eval *harness*, not
  loom's planning quality. Real quality measurement needs `node scripts/eval.mjs` against a real
  backend. Test count = code correctness; `node scripts/eval.mjs` = output quality.

**The skill judge is loom judging loom**
- `SkillJudge` is an LLM scoring an LLM's skill — a cheap first filter with no external
  ground truth. The real signal is the lifecycle track record (actual story outcomes).

**Skill provenance and lifecycle are per-machine**
- `skill_usage` and lifecycle metadata are per-laptop. A skill promoted on one machine
  is not promoted on another. Epic 9 (shared skill corpus) closes this.

**`node scripts/eval.mjs` is expensive**
- 6 cases × a full planner run each (~30 LLM calls, ~10–20 min). It is a periodic
  check, not a per-commit gate.

**A demoted skill cannot auto-recover; a candidate can starve**
- `disabled` skills are never re-injected. A candidate that rarely keyword-
  matches may never earn promotion. Recovery today means editing the skill
  record in `.loom/loom.db` directly or re-bundling.

---

## Skill system (Epic 5)

**Generated skills quality gate** *(resolved in Epic 7)*
- Epic 7 added the `SkillJudge` rubric gate and the lifecycle track record. Generated
  skills are no longer injectable on sight — see the Epic 7 section above.

**`SkillGenerator` works from the worker log tail, not the full command trace**
- Worker bash commands are audited into the worktree's DB, not the main DB (the Epic 3
  audit-fragmentation issue). `SkillGenerator` uses the story spec + worker summary +
  log tail instead. Adequate, but thinner than a full trace.

**`SkillSelector` uses shallow keyword matching**
- Token overlap with a stopword list — no stemming or embeddings. The interface is
  swappable for an embedding-based selector later.

**Generated-skill name collisions overwrite silently**
- Two stories yielding the same skill name → the second overwrites the first.

---

## Cursor CLI backend (Epic 13)

**The Cursor worker backend has no structural PreToolUse guardrail** *(High)*
- loom's command guardrail is a Claude Code PreToolUse hook in
  `.claude/settings.json` (`loom guard hook`). `cursor-agent` does not read that
  file, so a `worker_backend: cursor-cli` agent running `cursor-agent --force`
  executes Bash commands **without** the per-command policy check that blocks
  `rm -rf`, `git push --force`, writes to `protected_paths`, etc.
- What still protects a Cursor worker: git **worktree isolation** (it cannot see
  or touch other stories' worktrees) and the **push gate** — `allowed_remotes`
  is enforced by the `BaseCliWorker` push flow, not the hook, so a Cursor worker
  still cannot push to a disallowed remote or merge its own PR. The gap is
  *in-worktree* destructive commands.
- The Cursor *planner* (`CursorCliClient`, `--mode ask`) is read-only and not
  affected — this limitation is only the *worker*.
- **Mitigation today**: prefer `worker_backend: claude-code` for unattended
  autonomous runs; if using the Cursor worker, run under `loom run --checkpoint`
  with human review of each story's diff before it merges.
- **Revisit when**: wiring a Cursor-native hook. Cursor supports a hooks
  mechanism; `loom init` should write a Cursor hook that shells out to the same
  `loom guard hook` entrypoint, giving both backends guardrail parity. The
  guard entrypoint is already backend-agnostic (reads a command from stdin
  JSON) — only the Cursor-side hook registration is missing.

**`cursor-agent` JSON output shape is parsed defensively**
- `parseCursorJson` tries `result` / `text` / `response` / `content` / `message`
  and falls back to treating stdout as raw text. Cursor's `--output-format json`
  schema is not contractually pinned the way Claude Code's `--output-format json`
  is, so the parser is intentionally forgiving rather than strict.
- **Revisit when**: Cursor publishes a stable JSON output schema — tighten the
  parser and assert on it.

**`loom doctor` only warns when `cursor-agent` is missing**
- Cursor is an *optional* backend, so a missing `cursor-agent` is warn-level, not
  a failure. A project configured for `worker_backend: cursor-cli` with no
  `cursor-agent` installed will not fail `doctor` — it fails at run time instead.
- **Revisit when**: `doctor` could read `policy.yaml` and escalate the probe to
  required when the Cursor backend is actually selected.

---

## Multi-product orchestration (Epic 11)

**`loom status --all` opens each project's DB read-write**
- It uses `createDatabase`, which runs the (idempotent) migration — a status
  read therefore briefly takes a write lock per project. A true read-only open
  is avoided because SQLite cannot open a WAL-mode database read-only without
  write access to the `-shm` file. In practice WAL + the 5s busy timeout makes
  this invisible; a status read never corrupts or blocks a running supervisor.
- **Revisit when**: it proves contentious — add a read-only opener that
  checkpoints first.

**The GlobalLimiter heartbeat backstop is one hour**
- A crashed supervisor's slots are reclaimed immediately (its pid is dead). A
  *wedged* supervisor — alive but stuck — holds its slots until its heartbeat is
  one hour stale. The long window is deliberate: a healthy supervisor blocks on
  a worker for many minutes between heartbeats and must not have live slots
  stolen. pid-death covers the common crash; the hour covers the rare hang.

**A run blocked on the global cap polls every 1.5s**
- When the machine is at its global worker cap, a waiting run rechecks for a
  free slot every 1.5s (`globalPollMs`). It is a poll, not an event — a freed
  slot is noticed within ~1.5s, not instantly. Negligible against multi-minute
  worker runs.

**The registry stores absolute paths**
- Moving a registered repo orphans its entry (the old path no longer exists →
  pruned on the next `--all`). Re-run `loom init` in the new location to
  re-register. The registry does not track repos by identity, only by path.

---

## PR strategy & branch consolidation (Epic 17)

**`epic/<id>` branch is force-recreated on every finalize**
- Re-running `loom run` after a successful epic merge will recreate the
  `epic/<id>` branch at the captured base_sha and re-merge the story branches
  on top. The PR target stays the same. If you've already merged the epic PR
  upstream and re-run loom for any reason, the recreated branch will diverge
  from main — which is fine (`gh pr create` will refuse to create a duplicate;
  the existing PR stays in place).
- **Revisit when**: a real user hits this. The fix is "skip finalize if the
  epic is already merged upstream."

**Merge conflict fallback is per-story drop**
- When two story branches conflict during epic finalize, the conflicting story
  is dropped from the epic PR (recorded in the PR body and audit log). It is
  not retried; the story branch retains its work for manual review.

**Story branches stay local in per-epic mode**
- In `pr_strategy: per-epic` mode workers do NOT push story branches; only
  `epic/<id>` is pushed. The story-level work lives in your local worktrees +
  branches. If your laptop is lost mid-run, the durable record is the epic
  branch and PR once finalize has run.

---

## Deferred for Epic 7+ (post-MVP)

- Multi-machine agent coordination (current scope: single machine)
- Windows native support (current scope: macOS/Linux)
- Hosted dashboard (local `loom web` dashboard shipped)
- Provider abstraction (Anthropic-only for V1; LiteLLM later if needed)
- Automated PR merging (always human-merged for V1)
