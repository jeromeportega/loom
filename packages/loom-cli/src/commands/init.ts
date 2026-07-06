import type { CommandDescription } from '../describe/schema.js';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { openDatabase, ProjectRegistry, bundledSkillsDir, missingPolicyKeys, PolicyEngine, prepareRepoState, resolveLoomHomePath, registerRepo } from '@loom-ai/core';

const LOOM_DIR = '.loom';
const CLAUDE_SETTINGS = '.claude/settings.json';
const CLAUDE_SKILLS_DIR = '.claude/skills';
const CURSOR_RULES_DIR = '.cursor/rules';
const VSCODE_SETTINGS = '.vscode/settings.json';

/**
 * Absolute path to this loom CLI's entry script. `process.argv[1]` resolves
 * even through the npm `bin` symlink, so the hook and MCP commands loom writes
 * keep working regardless of whether `loom` is on PATH.
 */
function loomScriptPath(): string {
  return process.argv[1];
}

export function runInit(options: { cursor?: boolean; yes?: boolean }): void {
  const projectRoot = process.cwd();
  const loomDir = path.join(projectRoot, LOOM_DIR);

  // ─── .loom/ directory ───────────────────────────────────────────────────
  fs.mkdirSync(loomDir, { recursive: true });
  fs.mkdirSync(path.join(loomDir, 'worktrees'), { recursive: true });

  // ─── policy.yaml ─────────────────────────────────────────────────────────
  // Never rewrite an existing policy.yaml — it carries the user's tuned knobs +
  // comments (js-yaml drops comments on a round-trip, so an in-place merge would
  // mangle it). Instead always refresh the documented policy.example.yaml and
  // report any knobs added since the user's file was written.
  const policyPath = path.join(loomDir, 'policy.yaml');
  if (!fs.existsSync(policyPath)) {
    fs.writeFileSync(policyPath, DEFAULT_POLICY_YAML);
    console.log('  created  .loom/policy.yaml');
  } else {
    console.log('  exists   .loom/policy.yaml (preserved)');
  }
  const exampleResult = writePolicyExample(loomDir);
  console.log(`  ${exampleResult}  .loom/policy.example.yaml`);
  reportPolicyDrift(loomDir);

  // ─── SQLite DB ────────────────────────────────────────────────────────────
  // Route through prepareRepoState so the DB is created/opened at the
  // canonical loom-home location (ADR-006 / story-053). prepareRepoState is
  // idempotent: it migrates a legacy .loom/loom.db on the first call and is
  // a cheap no-op thereafter. openDatabase then creates the DB if absent or
  // opens the existing one (schema migrations are additive — no data loss).
  let initPolicy: { loom_home?: string } = {};
  try { initPolicy = PolicyEngine.load(loomDir).policyData; } catch { /* tolerate pre-existing minimal policy */ }
  const { namespaceDir } = prepareRepoState(projectRoot, initPolicy);
  const dbExisted = fs.existsSync(path.join(namespaceDir, 'loom.db'));
  openDatabase(namespaceDir);
  console.log(
    dbExisted
      ? '  exists   loom-home database (schema migrated in place; data preserved)'
      : '  created  loom-home database'
  );

  // ─── machine-level project registry ──────────────────────────────────────
  // Records this repo so `loom status --all` can aggregate across products.
  // Registration is a convenience — a failure here must not fail `loom init`.
  try {
    new ProjectRegistry().register(projectRoot);
  } catch (err) {
    console.log(`  (skipped project registry: ${(err as Error).message})`);
  }

  // ─── workspace manifest (committed source of truth) ──────────────────────
  // Distinct from the machine-local ProjectRegistry (ADR-005). registerRepo is
  // idempotent — re-running loom init is a no-op. A failure here must not fail
  // `loom init` (same defensive pattern as ProjectRegistry above).
  try {
    registerRepo(resolveLoomHomePath(projectRoot, initPolicy), projectRoot);
  } catch (err) {
    console.log(`  (skipped workspace manifest: ${(err as Error).message})`);
  }

  // ─── .gitignore additions ─────────────────────────────────────────────────
  ensureGitignore(projectRoot);
  warnTrackedLocalFiles(projectRoot);

  // ─── Claude Code: hook, CLAUDE.md, slash commands ─────────────────────────
  writeClaudeHook(projectRoot);
  writeClaudeMd(projectRoot);
  writeSlashCommands(projectRoot);
  writeUxDesignerSlashCommand(projectRoot);

  // ─── IDE excludes for .loom/worktrees and .loom/integration ──────────────
  // Each running story / rolling-integration epic is a full git worktree
  // inside the repo; VS Code / Cursor auto-detect each as a separate git
  // repository and index every file, causing "too many active changes"
  // warnings + indexing pressure on multi-epic runs.
  writeVscodeExcludes(projectRoot);

  // ─── Cursor IDE rules (optional) ─────────────────────────────────────────
  if (options.cursor) {
    writeCursorConfig(projectRoot);
  }

  console.log('\n  loom initialized. Run `loom epic "<your brief>"` to start.\n');
}

function writeClaudeHook(projectRoot: string): void {
  const settingsPath = path.join(projectRoot, CLAUDE_SETTINGS);
  fs.mkdirSync(path.dirname(settingsPath), { recursive: true });

  let settings: Record<string, unknown> = {};
  if (fs.existsSync(settingsPath)) {
    try {
      settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8')) as Record<string, unknown>;
    } catch {
      // malformed JSON — start fresh
    }
  }

  // The hook reads Claude Code's PreToolUse JSON from stdin. We invoke loom by
  // ABSOLUTE path (node "<dist/index.js>" guard hook) rather than the bare
  // `loom` command — so the guardrail fires even when `loom` is not on the
  // worker's PATH. Re-run `loom init` if loom is reinstalled elsewhere.
  const hookCommand = `node "${loomScriptPath()}" guard hook`;
  const hook = {
    matcher: 'Bash',
    hooks: [{ type: 'command', command: hookCommand }],
  };

  const hooks = (settings.hooks ?? {}) as Record<string, unknown[]>;
  const preToolUse = (hooks.PreToolUse ?? []) as unknown[];

  // Idempotent: skip only if the *loom* hook is already there
  const alreadyAdded = preToolUse.some((h) => {
    if (typeof h !== 'object' || h === null) return false;
    const entry = h as { matcher?: unknown; hooks?: unknown[] };
    if (entry.matcher !== 'Bash' || !Array.isArray(entry.hooks)) return false;
    return entry.hooks.some(
      (inner) =>
        typeof inner === 'object' &&
        inner !== null &&
        typeof (inner as { command?: unknown }).command === 'string' &&
        ((inner as { command: string }).command).includes('guard hook')
    );
  });

  if (!alreadyAdded) {
    preToolUse.push(hook);
    hooks.PreToolUse = preToolUse;
    settings.hooks = hooks;
    fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + '\n');
    console.log('  updated  .claude/settings.json (PreToolUse hook)');
  } else {
    console.log('  exists   .claude/settings.json loom hook (skipped)');
  }
}

/** Writes a CLAUDE.md describing the loom workflow, if the repo has none. */
function writeClaudeMd(projectRoot: string): void {
  const claudeMdPath = path.join(projectRoot, 'CLAUDE.md');
  if (fs.existsSync(claudeMdPath)) {
    console.log('  exists   CLAUDE.md (skipped)');
    return;
  }
  fs.writeFileSync(claudeMdPath, CLAUDE_MD_CONTENT);
  console.log('  created  CLAUDE.md');
}

/** Writes the loom slash-command skills into .claude/skills/. */
function writeSlashCommands(projectRoot: string): void {
  for (const [name, body] of Object.entries(SLASH_COMMANDS)) {
    const dir = path.join(projectRoot, CLAUDE_SKILLS_DIR, name);
    const file = path.join(dir, 'SKILL.md');
    if (fs.existsSync(file)) continue;
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(file, body);
  }
  console.log('  created  .claude/skills/loom-* (slash commands)');
}

/**
 * Installs the loom UX-designer persona as a Claude Code slash command. Most
 * bundled skills are auto-discovered by the SkillStore (loom injects them
 * into the planner and workers); the UX-designer is *also* exposed as a slash
 * command so a developer can invoke it interactively in Claude Code or Cursor.
 */
function writeUxDesignerSlashCommand(projectRoot: string): void {
  const srcDir = bundledSkillsDir();
  if (!srcDir) return;
  const srcFile = path.join(srcDir, 'loom-ux-designer', 'SKILL.md');
  if (!fs.existsSync(srcFile)) return;
  const destFile = path.join(projectRoot, CLAUDE_SKILLS_DIR, 'loom-ux-designer', 'SKILL.md');
  if (fs.existsSync(destFile)) return;
  fs.mkdirSync(path.dirname(destFile), { recursive: true });
  fs.copyFileSync(srcFile, destFile);
  console.log('  created  .claude/skills/loom-ux-designer (slash command)');
}

/**
 * Writes/merges `.vscode/settings.json` so VS Code / Cursor ignores
 * `.loom/worktrees/**` and `.loom/integration/**` — every story / rolling
 * integration epic is a full git worktree, and without these excludes the
 * IDE indexes every copy + warns about "too many active changes" on the
 * sibling repos. Only adds keys loom owns; merges into any existing settings.
 */
function writeVscodeExcludes(projectRoot: string): void {
  const settingsPath = path.join(projectRoot, VSCODE_SETTINGS);
  fs.mkdirSync(path.dirname(settingsPath), { recursive: true });

  let settings: Record<string, unknown> = {};
  if (fs.existsSync(settingsPath)) {
    try {
      settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8')) as Record<string, unknown>;
    } catch {
      // Malformed JSON: SKIP, don't overwrite. The previous "start fresh"
      // path silently destroyed the user's entire VS Code settings on a
      // mid-edit / mid-merge-conflict file. Leave the file alone and let
      // the operator fix the JSON, then re-run `loom init` to add excludes.
      console.log(
        '  warning  .vscode/settings.json is malformed — skipping loom excludes. ' +
          'Fix the JSON and re-run `loom init`.'
      );
      return;
    }
  }

  const loomExcludes: Record<string, true> = {
    '**/.loom/worktrees': true,
    '**/.loom/integration': true,
  };

  // For each exclusion-shaped setting, merge loom's entries in. Don't
  // overwrite user-set keys — only add ours when missing.
  const excludeKeys = [
    'files.exclude',
    'files.watcherExclude',
    'search.exclude',
    'python.analysis.exclude',
  ];
  let changed = false;
  for (const key of excludeKeys) {
    const existing = (settings[key] as Record<string, unknown> | undefined) ?? {};
    const next = { ...existing };
    for (const [k, v] of Object.entries(loomExcludes)) {
      if (!(k in next)) {
        next[k] = v;
        changed = true;
      }
    }
    settings[key] = next;
  }

  // Turn off auto-detection of repos inside worktree dirs (Cursor honors this).
  if (settings['git.autoRepositoryDetection'] !== false) {
    settings['git.autoRepositoryDetection'] = false;
    changed = true;
  }

  if (changed) {
    fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + '\n');
    console.log('  updated  .vscode/settings.json (loom worktree excludes)');
  } else {
    console.log('  exists   .vscode/settings.json loom excludes (skipped)');
  }
}

function writeCursorConfig(projectRoot: string): void {
  fs.mkdirSync(path.join(projectRoot, CURSOR_RULES_DIR), { recursive: true });
  const rulesPath = path.join(projectRoot, CURSOR_RULES_DIR, 'loom.mdc');
  if (!fs.existsSync(rulesPath)) {
    fs.writeFileSync(rulesPath, CURSOR_RULES_CONTENT);
    console.log('  created  .cursor/rules/loom.mdc');
  }
}

/** Markers framing the loom-managed section in a repo's .gitignore. */
const GITIGNORE_BEGIN = '# >>> loom-managed (edit BELOW or ABOVE these markers; this block is regenerated) >>>';
const GITIGNORE_END = '# <<< loom-managed <<<';

/** Patterns ignored by default. Edit your .gitignore outside the markers to override. */
const LOOM_IGNORE_BLOCK = [
  '# Local-only state (per machine, never useful to check in):',
  '.loom/loom.db*',
  '.loom/worktrees/',
  '',
  '# Generated planning working directory — the EpicFinalizer promotes the',
  '# final brief / PRD / architecture / epic.yaml for each *delivered* epic',
  '# into .loom_outputs/<epic-id>/ (committed to the epic branch), so the',
  '# .loom/planning/ working files do not need to be tracked.',
  '.loom/planning/',
  '',
  '# Worker scratch space — probes, exploratory scripts, investigation',
  '# notes. The worker prompt directs agents to write scratch here so it',
  '# does not pollute the PR diff.',
  '.loom/scratch/',
  '',
  '# Regenerated every `loom init` as living docs for policy.yaml knobs:',
  '.loom/policy.example.yaml',
  '',
  '# Per-machine integration files (paths bake in your local install; regenerable via `loom init`):',
  '.claude/settings.json',
  '.claude/skills/loom-*/',
  '.mcp.json',
  '.cursor/mcp.json',
  '.cursor/rules/loom.mdc',
];

/** The full loom-managed block, with markers. */
function loomIgnoreSection(): string {
  return [
    GITIGNORE_BEGIN,
    '# To track something loom ignores by default (e.g. share planning artifacts),',
    '# add the negation OUTSIDE these markers — patterns later in .gitignore win.',
    '# Example: a line  `!.loom/planning/`  below this block keeps plans tracked.',
    '',
    ...LOOM_IGNORE_BLOCK,
    GITIGNORE_END,
  ].join('\n');
}

/**
 * Writes (or regenerates) the loom-managed block in the repo's .gitignore.
 * The block is delimited by markers; any content the user adds outside the
 * markers is preserved. Patterns inside the block are rewritten on every init.
 */
function ensureGitignore(projectRoot: string): void {
  const gitignorePath = path.join(projectRoot, '.gitignore');
  const existing = fs.existsSync(gitignorePath)
    ? fs.readFileSync(gitignorePath, 'utf8')
    : '';
  const section = loomIgnoreSection();

  const beginIdx = existing.indexOf(GITIGNORE_BEGIN);
  const endIdx = existing.indexOf(GITIGNORE_END);

  let next: string;
  if (beginIdx !== -1 && endIdx !== -1 && endIdx > beginIdx) {
    // Replace the existing block in place.
    const before = existing.slice(0, beginIdx);
    const after = existing.slice(endIdx + GITIGNORE_END.length);
    next = before + section + after;
  } else {
    // Append a fresh block.
    const sep = existing.length === 0 || existing.endsWith('\n') ? '' : '\n';
    const trailing = existing.length === 0 ? '' : '\n';
    next = existing + sep + trailing + section + '\n';
  }

  if (next !== existing) {
    fs.writeFileSync(gitignorePath, next);
    console.log('  updated  .gitignore (loom-managed section)');
  }
}

/** The paths loom ignores by default — for the "already tracked" warning. */
const TRACKED_CHECK_PATHS = [
  '.loom/loom.db',
  '.loom/loom.db-wal',
  '.loom/loom.db-shm',
  '.loom/worktrees',
  '.loom/planning',
  '.loom/research',
  '.claude/settings.json',
  '.claude/skills',
  '.mcp.json',
  '.cursor/mcp.json',
  '.cursor/rules/loom.mdc',
];

/**
 * Warns if files loom now ignores are already tracked by git. .gitignore does
 * not affect tracked files, so anything previously committed keeps getting
 * committed silently. Surface it so the user can untrack and clean up.
 */
function warnTrackedLocalFiles(projectRoot: string): void {
  let out: string;
  try {
    out = execFileSync('git', ['ls-files', ...TRACKED_CHECK_PATHS], {
      cwd: projectRoot,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
  } catch {
    // Not a git repo, or git not on PATH — nothing to check.
    return;
  }
  // Drop any .claude/skills/* that are NOT loom-* (user-authored skills stay).
  const tracked = out
    .trim()
    .split('\n')
    .filter(Boolean)
    .filter((f) => {
      if (f.startsWith('.claude/skills/') && !f.startsWith('.claude/skills/loom-')) {
        return false;
      }
      return true;
    });
  if (tracked.length === 0) return;
  console.log('');
  console.log('  WARNING: these files are already tracked by git but are now ignored:');
  for (const f of tracked) console.log(`    ${f}`);
  console.log('  .gitignore does not ignore tracked files. To untrack, run:');
  console.log(`    git rm -r --cached ${tracked.join(' ')}`);
  console.log('  then commit. Future runs will not check them in.');
}

const CLAUDE_MD_CONTENT = `# Loom

This repo uses **loom** — an autonomous agentic engineering system. Drive it
through its CLI: each command runs fresh, prints to stdout, and supports \`--json\`
for machine-readable output (no persistent server to watch).

## Workflow

1. \`loom epic "<brief>"\` — plan an epic (Analyst → PM → Architect personas).
2. Review the plan under \`.loom/planning/<run-id>/\` (or \`loom artifacts <epic-id>\`).
3. \`loom approve <epic-id>\` — release it for execution.
4. \`loom run\` — dispatch story agents, each in an isolated git worktree.
5. \`loom status --json\` — track progress and PR links.

## Inspecting a run (all support --json)

- \`loom status\` — epics + per-story status and PR links.
- \`loom diff <story|epic-id>\` — the diff for a story or epic.
- \`loom review <story-id>\` — the reviewer verdict + summary.
- \`loom artifacts <epic-id>\` — brief / PRD / architecture / epic YAML.
- \`loom audit [--story <id>]\` / \`loom traces --story <id>\` — audit log + worker reasoning.

## Guardrails

A PreToolUse hook checks every Bash command against \`.loom/policy.yaml\`. Destructive
commands (force push, \`git reset --hard\`, deleting protected paths, command chaining)
are blocked at the OS level. Work with the guardrails — never try to bypass them.
`;

const slashCommand = (name: string, description: string, body: string): string =>
  `---\nname: ${name}\ndescription: ${description}\n---\n\n${body}\n`;

const SLASH_COMMANDS: Record<string, string> = {
  'loom-epic': slashCommand(
    'loom-epic',
    'Plan a new epic with loom from a one-paragraph brief.',
    '# /loom-epic\n\nThe user wants to plan an epic. Ask them for a one-paragraph\n' +
      'brief if they have not given one, then run `loom epic "<brief>"`. When planning\n' +
      'finishes, summarise the epics and remind the user to review the plan and run\n' +
      '`/loom-approve`.'
  ),
  'loom-status': slashCommand(
    'loom-status',
    'Show the status of loom epics and their story agents.',
    '# /loom-status\n\nRun `loom status --json` and present the epic and per-story\n' +
      'status clearly, including any PR links.'
  ),
  'loom-approve': slashCommand(
    'loom-approve',
    'Approve a planned loom epic, releasing it for execution.',
    '# /loom-approve\n\nConfirm which epic the user means, then run\n' +
      '`loom approve <epic-id>`. Approve only releases the epic for execution — it does\n' +
      'not dispatch workers. Tell the user to run `loom run <epic-id>` to dispatch the\n' +
      'story agents.'
  ),
};

export const DEFAULT_POLICY_YAML = `# Loom Policy — committed to git, shared with the whole team
# See schemas/policy.schema.yaml for full documentation

git:
  # Glob patterns for allowed push destinations.
  # Empty list (default) = all remote pushes blocked.
  # Example: ["git@github.com:myorg/*", "https://github.com/myorg/*"]
  allowed_remotes: []

  # Branches agents cannot push to directly (must open a PR)
  protected_branches:
    - main
    - master

  # git flags that are always blocked regardless of other settings
  forbidden_flags:
    - "--force"
    - "--force-with-lease"
    - "--hard"

  # Require agents to open PRs instead of pushing directly
  agents_must_use_pr: true

filesystem:
  # Paths agents cannot write to or delete
  protected_paths:
    - "~/.ssh"
    - "~/.aws"
    - "~/.gnupg"
    - "/etc"
    - "/usr"
    - "/bin"
    - "/sbin"
    - ".git"

  # Root directory agents are allowed to write within (default: project root)
  allowed_write_root: "."

  # Root directory agents may read/search within (default: project root)
  allowed_read_root: "."

agents:
  # Max number of story agents running simultaneously
  max_concurrent: 5

  # Each story agent runs in its own git worktree
  worktree_isolation: true

  # Agents open PRs but cannot merge them — human reviews required
  require_human_pr_merge: true

  # LLM backend for planning and skill generation. Both are session-based
  # (no API key, no API billing) and use the developer's existing login.
  #   claude-cli — session-based via the Claude Code login.
  #   cursor-cli — session-based via the Cursor login.
  llm_backend: "claude-cli"

  # Worker backend — which agent CLI implements stories:
  #   claude-code — story agents run via the claude CLI.
  #   cursor-cli  — story agents run via Cursor's cursor-agent CLI.
  worker_backend: "claude-code"

  # PR strategy — one PR per epic by default, instead of one PR per story:
  #   per-epic   — workers commit locally; the EpicFinalizer merges all story
  #                branches into epic/<id> and opens ONE PR per epic. (default)
  #   per-story  — legacy: each worker opens its own PR (N PRs per epic).
  #   both       — story PRs AND an epic PR. Useful for transition / paranoia.
  pr_strategy: "per-epic"

  # Claude model for story execution agents
  model: "claude-sonnet-4-6"

  # Claude model for the planning personas (Analyst, PM, Architect) — Opus 4.7
  # by default, because the planning step benefits most from deeper reasoning.
  planning_model: "claude-opus-4-7"

  # Model id for the cursor-cli backend (Cursor uses its own ids, e.g. sonnet-4).
  # loom always targets a specific model and never uses Cursor MAX mode.
  cursor_model: "sonnet-4"

  # Claude model for post-story skill generation (cost-optimized)
  skill_gen_model: "claude-haiku-4-5-20251001"

  # Worker review pass (Epic 18 story-018-002). Runs the CodeReviewAgent on
  # the worker's diff before the PR opens.
  #   off              — no review pass
  #   comment          — review runs; findings attach as a PR comment (default)
  #   block-and-revise — blockers re-prompt the worker (up to review_max_passes)
  review_strategy: "comment"

  # Max worker revision passes under block-and-revise before loom stops and
  # marks the story blocked (replaces the old hardcoded cap of 2). Lower it to
  # forcefully limit review cost; 0 = review once, never re-prompt.
  review_max_passes: 2

  # Adaptive cost control. When 'on' (default), loom sizes the expensive steps
  # (reviewer count, verify-phase spawn, skill-gen) per story from cheap signals
  # — a triage call, the worker's self-assessment, and heuristics — never
  # exceeding the static flags above (the ceiling rule). 'off' runs every
  # enabled step on every story (today's behavior).
  adaptive_cost: "on"

  # Cheap model for the per-story triage rating (one call/story: risk + complexity).
  triage_model: "claude-haiku-4-5-20251001"

  # Globs that force the heavy review tier when a story touches them, regardless
  # of confidence — a safety floor for sensitive surface area.
  risky_paths:
    - "**/auth/**"
    - "**/migrations/**"
    - "**/payment/**"
    - "**/payments/**"
    - "**/.github/workflows/**"

  # Wall-clock bound (in minutes) for the reviewer subprocess. The legacy
  # hardcoded 10-min timeout silently shipped large story diffs unreviewed
  # (e.g. story-007-003 in the multi-epic shared-client run); raise this
  # if your repo has sizable diffs.
  review_timeout_minutes: 10

  # Brief-quality threshold (0-10). Every \`loom epic\` runs the BriefRefiner
  # before the planner; briefs scoring below this are refused with a
  # structured critique so you can tighten the prompt. Pass --force (CLI) or
  # force: true (loom_start_epic) to override the gate for a single
  # invocation — the refiner still runs and its critique is audit-logged
  # (brief_gate_forced) before planning. It's a per-run escape hatch, not a
  # disable switch. Only the threshold is tunable here. Default 6.
  # Setting 0 disables the gate (the SWE-bench harness does this).
  min_brief_quality_score: 6

  # Operator guidance side-channel. When 'on', the worker prompt includes
  # the contents of .loom/guidance/<story-id>.md if the file exists, treating
  # it as priority instructions from the operator. Required for the
  # \`loom guide\` CLI to actually reach workers — default 'off' so the
  # baseline worker prompt is unchanged.
  #   off — guidance file is written but workers never read it (default)
  #   on  — workers read .loom/guidance/<story-id>.md at story-start + revisions
  operator_guidance: "off"

  # Integration gate — after the EpicFinalizer merges every story branch onto
  # epic/<id>, run the build/test suite on the INTEGRATED tree before opening
  # the PR. Catches cross-story regressions that each story's own tests miss,
  # plus stories dropped by a merge conflict.
  #   off   — never run the gate
  #   warn  — run it; annotate the PR + audit on failure but still open it (default)
  #   block — on failure, withhold the PR and flip the epic back to in_progress
  integration_gate: "warn"
  # Explicit gate command. Unset = auto-detect (npm test / make test / pytest).
  # loom never auto-installs deps; encode it here if needed, e.g. "npm ci && npm test".
  # The gate's wall-clock bound is an engineering decision and is not tunable here.
  # test_command: "npm test"

  # Architect shared-contract injection. When 'on' (the v0.5.0 default),
  # Winston emits an epic-wide contract at plan time (shared interfaces/types
  # + a per-story file-ownership map) and every worker prompt for the epic
  # is prefixed with it — so parallel story agents agree on the seams and
  # don't edit each other's files. Default flipped to 'on' after the multi-
  # epic shared-client run: sibling stories appending to one client file
  # caused rolling-merge conflicts on every multi-story epic.
  # Costs one extra planning call per run; 'off' keeps the worker prompt
  # byte-identical to the bench baseline.
  #   on  — emit + inject the shared contract (default)
  #   off — no contract pass
  shared_contract: "on"

  # Cross-story context notes. When 'on', loom writes a short "what I built" note
  # to .loom/context/<story-id>.md when a story succeeds (and integrates, under
  # the rolling branch) and appends each dependent worker's prompt with its
  # dependencies' notes — the upstream decisions and files touched. A pure
  # telemetry render (zero extra LLM tokens); 'off' keeps the prompt byte-identical.
  #   off — no notes written or injected (default)
  #   on  — write a note on success, inject dependency notes into dependents
  context_notes: "off"

  # QA test planning. When 'advisory', a QA persona (Tessa) runs after the
  # architect at plan time and writes a risk-based test_plan onto every story
  # (test levels + happy/error/edge cases + the verification bar); each worker
  # prompt then carries its story's plan so agents build tests-first against an
  # explicit definition of "verified". Costs one extra planning call per run;
  # 'off' keeps the worker prompt byte-identical.
  #   off      — no QA pass (default)
  #   advisory — emit + inject per-story test plans
  qa_planning: "off"

  # Intake classification routing. Before planning, loom classifies the brief
  # (feature / bug / chore, story / epic). This knob controls whether the
  # verdict changes the planning path or is observe-only.
  #   off      — classifier runs observe-only; planner is byte-identical to baseline (default)
  #   advisory — route automatically: size=story → StandaloneStoryAgent (skips PM+Architect)
  #   confirm  — like advisory but prompts the operator to confirm or override first
  intake_routing: "off"

  # Rolling integration branch. When 'rolling', loom keeps a live epic/<id>
  # branch: workers branch from its tip and each story is merged back as it
  # completes, so parallel agents build on real integrated code instead of
  # colliding at the end. A conflicting merge blocks that story (work stays on
  # story/<id>) instead of being silently dropped. Requires pr_strategy=per-epic.
  #   off     — branch from first dependency; big-bang merge at finalize (default)
  #   rolling — live epic branch with incremental merge-back
  integration_branch: "off"

  # Bounded integrator (needs integration_branch=rolling). When 'on', a story
  # whose merge-back conflicts is handed to a bounded agent that resolves the
  # conflict; loom commits the merge and re-runs the gate, integrating the story
  # only if the gate is green — otherwise it rolls back and blocks the story
  # (never a silent drop). The resolve+gate attempt cap is engine-tuned.
  #   off — a conflict blocks the story immediately (default)
  #   on  — try gate-verified auto-resolution before blocking
  integrator: "off"

  # Per-story token budget (Epic 16 story-016-005). Uncomment to enforce.
  # When the worker's cumulative usage crosses this, the subprocess is killed
  # and the story marked failed with "budget exhausted". Requires a backend
  # that emits inflight usage (currently only claude-code via stream-json).
  # budget_tokens_per_story: 200000

  # Self-learning toggle. The skill loop (extract -> judge -> candidate ->
  # lifecycle) is loom's highest-leverage feature, but every story spends an
  # LLM call on it. Cost-conscious teams can switch this off.
  #   on      — extract a skill after every successful story (default)
  #   off     — never run extraction
  #   sampled — run every Nth successful story (engine-tuned sample)
  skill_generation: "on"

mcp:
  # Path to a checkout of your org's approved-MCP registry — a directory of
  # servers/<name>/server.json files. Unset = \`loom mcp\` is disabled.
  # Example: registry: "/Users/me/checkouts/awesome-mcp"
  registry: ""
`;

const POLICY_EXAMPLE = 'policy.example.yaml';

/**
 * (Re)writes `.loom/policy.example.yaml` from the current template — always up to
 * date, never touches the user's tuned policy.yaml. Returns 'created'|'updated'.
 */
export function writePolicyExample(loomDir: string): 'created' | 'updated' {
  const examplePath = path.join(loomDir, POLICY_EXAMPLE);
  const existed = fs.existsSync(examplePath);
  fs.writeFileSync(examplePath, DEFAULT_POLICY_YAML);
  return existed ? 'updated' : 'created';
}

/**
 * Notifies about policy knobs that ship a default but are absent from the user's
 * policy.yaml (added since it was generated). Shared by `loom init` and
 * `loom doctor`; no-op when the file is current. The file still works — the zod
 * schema applies defaults at load — so this is a discoverability aid, not an error.
 */
export function reportPolicyDrift(loomDir: string): void {
  const missing = missingPolicyKeys(loomDir, DEFAULT_POLICY_YAML);
  if (missing.length === 0) return;
  console.log('');
  console.log(`  ${missing.length} new policy knob(s) since your .loom/policy.yaml was written:`);
  for (const m of missing) {
    console.log(`    - ${m.path}  (default: ${JSON.stringify(m.default)})`);
  }
  console.log('  Your policy.yaml still works (defaults apply). Copy what you want to');
  console.log(`  tune from .loom/${POLICY_EXAMPLE}.`);
}

const CURSOR_RULES_CONTENT = `---
description: "Loom agentic engineering system — workflow and guardrail context"
globs: ["**/*.ts", "**/*.js", "**/*.py", "epics/**", ".loom/**"]
alwaysApply: false
---

# Loom Workflow

This repo uses **loom** for autonomous epic execution. Before running any command:

1. Call \`loom_policy_check(command)\` via MCP to validate it is allowed.
2. Never push directly to main/master — always create a PR.
3. Work only in your assigned story branch and worktree.
4. After completing a story, call \`gh pr create\` to open a PR.

## Loom MCP Tools Available

- \`loom_start_epic\` — start a planning pipeline from a brief
- \`loom_approve_plan\` — approve the generated plan and start execution
- \`loom_get_status\` — check epic and agent status
- \`loom_policy_check\` — validate a command before running it
- \`loom_get_audit_log\` — inspect what an agent has done

## Protected Paths

Never write to: ~/.ssh, ~/.aws, ~/.gnupg, /etc, /usr, .git

## Capabilities page must stay current

When you add, remove, or meaningfully change a user-visible feature, update \`docs/capabilities.md\` in the same PR. That page is the single source of truth for what loom does today — GitHub release notes alone are insufficient. New CLI subcommand → add a row. New MCP tool → add a row noting both CLI and MCP forms. New user-visible policy knob → add a row. Capability previously listed under "What loom does NOT do" now ships → move it into the appropriate table and delete its NOT-do entry.
`;

export const spec: CommandDescription = {
  name: 'init',
  summary: 'Initialize loom in the current git repo',
  whenToUse: 'Run once in a project root to create the .loom/ directory, policy.yaml, and Claude Code hooks. Safe to re-run; never overwrites an existing policy.yaml.',
  arguments: [],
  options: [
    { name: '--cursor', type: 'boolean', description: 'Also write .cursor/rules/loom.mdc for Cursor IDE integration', changesOutputShape: false },
    { name: '--yes', type: 'boolean', description: 'Skip confirmation prompts', changesOutputShape: false },
  ],
  output: { text: 'Progress messages for each file created and next steps' },
  examples: [
    { command: 'loom init', description: 'Initialize loom with interactive prompts' },
    { command: 'loom init --cursor --yes', description: 'Initialize without prompts and add Cursor IDE support' },
  ],
  exitCodes: [
    { code: 0, meaning: 'Initialized successfully' },
    { code: 1, meaning: 'Not a git repository or initialization error' },
  ],
  errors: ['Not a git repository — run `git init` first'],
  relationships: { prerequisites: [], nextSteps: ['doctor', 'epic'] },
};
