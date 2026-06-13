# Build-Day Auth & Permissions Checklist

Complete ALL of this **before** kickoff so the agent runs unattended without
prompting or auth failures mid-loop. Two safety layers stay in force even with
broad permissions: loom's structural guard (blocks destructive commands +
worker pushes to protected branches) and the PR-merge gate. So "full
permissions for package + deploy commands" is safe — the guard still stops
`rm -rf` of protected paths, force-push to main, etc.

## A. Version control — GitHub

- [ ] `gh auth login` — authenticated as the account that owns both repos.
      Scopes: **`repo`** (read/write, PRs) and **`workflow`** (if CI exists).
- [ ] `gh auth status` shows logged in; `git push` works (HTTPS via gh, or an
      SSH key added to the account).
- [ ] **Both repos PUBLIC** at submission: the loom harness repo, and the
      finance **submission repo** (created at kickoff — greenfield).
- [ ] **PR-merge rights, no required reviews.** The driving agent merges epic
      PRs with `gh pr merge <n> --squash`. If `main` has branch protection
      requiring reviews/CI, the agent can't self-merge — for the hackathon
      repo, either disable required reviews OR grant the account admin
      (admin-merge). Loom's guard already blocks *worker* pushes to `main`;
      keeping `main` protected on GitHub is fine **as long as the driving
      account can merge PRs**.
- [ ] `git config user.name` / `user.email` set (clean commit attribution).

## B. Package & build commands (full permissions)

- [ ] Node **20+** + npm installed (`node -v`, `npm -v`).
- [ ] **Claude Code allowlist** so the agent never prompts mid-run. Add to the
      submission repo's `.claude/settings.json` (see snippet at bottom):
      `Bash(npm:*)`, `Bash(npx:*)`, `Bash(node:*)`, `Bash(git:*)`,
      `Bash(gh:*)`, `Bash(vercel:*)`, plus `Read`, `Edit`, `Write`. Do NOT
      blanket-allow `Bash(*)` — keep the guard's safety net meaningful.
- [ ] Loom guard policy (`.loom/policy.yaml`) permits the build toolchain in
      worker worktrees (it allows `npm ci`/`test`/`build`, `git`, etc. by
      default and forbids the dangerous ones — leave that intact).
- [ ] `test_command: "npm ci && npm test"` set in `.loom/policy.yaml` so the
      integration gate installs the worktree's workspace links first (prevents
      the stale-dist false-fail).

## C. Deployment — Vercel

- [ ] `vercel login` — authenticated; Vercel account + a project for the app.
- [ ] Non-interactive deploy works: project linked (`vercel link`) and/or a
      `VERCEL_TOKEN` exported so `vercel --prod` runs without prompts.
- [ ] **Vercel MCP** added in the submission repo (operator-side diagnostics):
      `claude mcp add -s project --transport http vercel https://mcp.vercel.com`
      (`-s project` writes a committable `.mcp.json`; OAuth on first use).
- [ ] If using **libSQL/Turso**: DB provisioned; connection string + auth token
      in **Vercel env vars** (NOT committed). Local dev uses `file:` so tests
      run offline.

## D. Claude Code & model

- [ ] Permission mode set for unattended operation (allowlisted commands run
      without prompts; destructive ops still gated). The allowlist in (B) is
      what makes this safe rather than a blanket bypass.
- [ ] **Opus 4.8** selected as the model; the event's **$500 API credits** /
      API key configured and active (24h expiry — claim day-of).
- [ ] `buildday/DRIVER.md` ready to paste; `GOAL.md`, `RUNBOOK.md`,
      `RUBRIC.md`, `briefs/` copied into the submission repo.

## E. Secrets & data hygiene (do NOT skip)

- [ ] **No tokens/keys committed** — gh token, `VERCEL_TOKEN`, Turso token,
      Anthropic key all live in env / local config, never in git.
- [ ] `.gitignore` (commit #1) covers `.env*`, `data/`, raw uploads, local DB
      files.
- [ ] **Real financial data never committed**; the public deploy serves the
      curated demo household only. Real data appears only in the
      locally-recorded video.

---

## `.claude/settings.json` snippet (submission repo)

```json
{
  "permissions": {
    "allow": [
      "Bash(npm:*)",
      "Bash(npx:*)",
      "Bash(node:*)",
      "Bash(git:*)",
      "Bash(gh:*)",
      "Bash(vercel:*)",
      "Read",
      "Edit",
      "Write"
    ]
  }
}
```

Tune the exact command-scoping with the `update-config` / `fewer-permission-
prompts` skills if you want tighter rules. Keep deny-by-default for anything
not listed so loom's guard + the prompt remain the backstop for destructive
actions.
