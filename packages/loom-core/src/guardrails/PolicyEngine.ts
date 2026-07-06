import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import { minimatch } from 'minimatch';
import { PolicySchema, type Policy, type PolicyCheckResult } from '../types.js';
import { parseCommand, type ParsedCommand } from './CommandParser.js';
import { resolveEffectiveConfig } from '../config/resolveEffectiveConfig.js';
import { listWorkspaceRoots } from '../retrieval/ManifestResolver.js';
import { CROSS_REPO_RULES } from '../retrieval/types.js';
import type { AuditLog } from '../state/AuditLog.js';

/** Context the caller provides so the cross-repo guard can enforce workspace boundaries. */
export interface WorktreeContext {
  /** Agent's own worktree root — canonicalized absolute path, no trailing slash. */
  worktreeRoot: string;
  /** Loom home directory containing the workspace manifest. */
  loomHome: string;
  /**
   * Audit logger — required by invariant #5: every guard refusal must be recorded
   * before returning. Use an AuditLog instance (real or spy in tests); do not omit.
   */
  audit: AuditLog;
}

/**
 * Context for read-scope enforcement. Parallel to WorktreeContext but carries
 * no workspace/cross-repo manifest — read scoping is independent of cross_repo.enabled.
 */
export interface ReadScopeContext {
  /** Agent's own worktree, canonicalized, no trailing slash. In the hook: process.cwd(). */
  worktreeRoot: string;
  /** Resolved allowed_read_root (absolute, canonicalized). Defaults to repo root. */
  readRoot: string;
  /** Audit logger — every denial recorded before return (invariant #5). */
  audit: AuditLog;
  /** Attributes the audit row when known. */
  agentId?: string;
}

export class PolicyEngine {
  private policy: Policy;

  constructor(policy: Policy) {
    this.policy = policy;
  }

  static load(
    loomdir: string,
    opts?: { projectRoot?: string; env?: NodeJS.ProcessEnv },
  ): PolicyEngine {
    const projectRoot = opts?.projectRoot ?? path.dirname(loomdir);
    // env defaults to process.env so existing single-arg call sites inherit
    // real env vars; pass opts.env: {} for hermetic tests.
    const { policy } = resolveEffectiveConfig({ loomdir, projectRoot, env: opts?.env ?? process.env });
    return new PolicyEngine(policy);
  }

  static defaultPolicy(): Policy {
    return PolicySchema.parse({});
  }

  get policyData(): Policy {
    return this.policy;
  }

  check(rawCommand: string, ctx?: WorktreeContext): PolicyCheckResult {
    // Pre-check: reject shell metacharacters that would let an agent chain
    // forbidden operations behind an allowed first command (e.g.
    // `git status; git push --force` or `eval "rm -rf ~/.ssh"`).
    // Agents should issue separate Bash calls instead of chaining.
    const metaResult = this.checkShellMetacharacters(rawCommand);
    if (!metaResult.allowed) return metaResult;

    const wrapperResult = this.checkWrapperPrograms(rawCommand);
    if (!wrapperResult.allowed) return wrapperResult;

    const cmd = parseCommand(rawCommand);

    if (cmd.program === 'git') {
      const gitResult = this.checkGit(cmd, rawCommand);
      if (!gitResult.allowed) return gitResult;
    }

    if (cmd.program === 'rm') {
      const rmResult = this.checkRm(cmd, rawCommand);
      if (!rmResult.allowed) return rmResult;
    }

    const fsResult = this.checkFilesystemWrite(rawCommand);
    if (!fsResult.allowed) return fsResult;

    // Cross-repo structural guard — enforced whenever the caller provides
    // workspace context.  Independent of all prior checks so it cannot be
    // bypassed by shaping the command differently.
    if (ctx !== undefined) {
      const crossResult = this.checkCrossRepoAccess(cmd, ctx);
      if (!crossResult.allowed) return crossResult;
    }

    return { allowed: true };
  }

  /**
   * Enforce cross-repo access rules structurally, independent of model output.
   *
   * Three invariants:
   *   USE_RETRIEVAL  — raw read programs into a registered sibling root are denied;
   *                    agents must use `loom retrieve` instead.
   *   OUT_OF_WORKSPACE — any path resolving outside [own worktree ∪ workspace roots]
   *                      is denied regardless of the program.
   *   READ_ONLY      — write operations resolving outside the agent's own worktree
   *                    are denied; sibling repos are read-only.
   *
   * Returns {allowed:true} immediately when cross_repo.enabled is false.
   * Every refusal is logged to ctx.audit before returning (invariant #5).
   */
  checkCrossRepoAccess(cmd: ParsedCommand, ctx: WorktreeContext): PolicyCheckResult {
    if (!this.policy.cross_repo.enabled) return { allowed: true };

    // Canonicalize own worktree: follow symlinks (e.g. macOS /var → /private/var).
    let ownWorktree: string;
    try {
      ownWorktree = fs.realpathSync(ctx.worktreeRoot);
    } catch {
      ownWorktree = ctx.worktreeRoot;
    }

    let siblingRoots: string[];
    try {
      siblingRoots = listWorkspaceRoots(ctx.loomHome);
    } catch {
      // Fail closed: if the manifest is unreadable, treat as no siblings.
      siblingRoots = [];
    }
    // Exclude own worktree from the sibling list. Registered repos that are
    // ancestor directories of ownWorktree (nested-repo topology) are also
    // excluded from siblings so they don't trigger USE_RETRIEVAL on own-worktree
    // paths; those ancestor roots do remain in allRoots for OUT_OF_WORKSPACE.
    // Invariant: workspace repos are never nested parents of an agent worktree
    // in normal loom usage. Tested in crossRepoAccess.test.ts.
    const siblings = siblingRoots.filter(
      r => r !== ownWorktree && !ownWorktree.startsWith(r + path.sep),
    );

    const candidates = extractArgPaths(cmd.argv, ownWorktree);

    // ── Rule 1: raw read into a registered sibling root → USE_RETRIEVAL ──────
    // Scripting interpreters (python -c, node -e, etc.) are intentionally
    // absent here; they must be blocked by the forbidden_programs policy list
    // because detecting their path arguments requires per-interpreter parsing
    // beyond the scope of this guard.
    const RAW_READ_PROGRAMS = new Set(['cat', 'head', 'tail', 'less', 'grep', 'find']);
    if (RAW_READ_PROGRAMS.has(cmd.program)) {
      for (const [p, resolved] of candidates) {
        for (const sib of siblings) {
          if (isUnder(resolved, sib)) {
            const result: PolicyCheckResult = {
              allowed: false,
              rule: CROSS_REPO_RULES.USE_RETRIEVAL,
              reason: `Raw read of "${p}" into registered sibling repo is not permitted — use "loom retrieve" to access cross-repo content`,
            };
            ctx.audit.record({
              action: 'guard_denied',
              command: cmd.argv.join(' '),
              allowed: false,
              policy_rule: result.rule,
              detail: { reason: result.reason },
            });
            return result;
          }
        }
      }
    }

    // ── Rule 2: path outside [worktree ∪ workspace roots] → OUT_OF_WORKSPACE ─
    const allRoots = [ownWorktree, ...siblings];
    for (const [p, resolved] of candidates) {
      const inWorkspace = allRoots.some(root => isUnder(resolved, root));
      if (!inWorkspace) {
        const result: PolicyCheckResult = {
          allowed: false,
          rule: CROSS_REPO_RULES.OUT_OF_WORKSPACE,
          reason: `Path "${p}" (resolved: "${resolved}") is outside the workspace — only paths within registered repositories are permitted`,
        };
        ctx.audit.record({
          action: 'guard_denied',
          command: cmd.argv.join(' '),
          allowed: false,
          policy_rule: result.rule,
          detail: { reason: result.reason },
        });
        return result;
      }
    }

    // ── Rule 3: write outside own worktree → READ_ONLY ───────────────────────
    const GIT_WRITE_SUBCMDS = new Set([
      'commit', 'push', 'add', 'reset', 'rebase', 'merge', 'cherry-pick',
      'revert', 'tag', 'stash', 'apply', 'am', 'rm', 'mv', 'checkout',
      'restore', 'switch', 'worktree', 'clean', 'bisect',
    ]);
    const WRITE_PROGRAMS = new Set([
      'cp', 'mv', 'touch', 'tee', 'truncate', 'install', 'rsync', 'ln', 'dd',
      'rm', 'mkdir', 'chmod', 'chown',
      // sed: covered here when -i is present; the forbidden_programs list handles
      // sed without -i for any cross-repo path (not parseable without flag awareness).
    ]);
    // Find the effective git subcommand: the first element of cmd.args that is
    // not an absolute/home path (those are -C values, not the verb). This avoids
    // false positives on `git log commit..HEAD /sibling` where 'commit..HEAD' ≠ 'commit'
    // and `git log` is a read operation whose first bare arg is 'log'.
    const gitEffectiveSubcmd = cmd.args.find(a => !a.startsWith('/') && !a.startsWith('~'));
    const isGitWrite =
      cmd.program === 'git' && GIT_WRITE_SUBCMDS.has(gitEffectiveSubcmd ?? '');
    const isWriteOp = WRITE_PROGRAMS.has(cmd.program) || isGitWrite;

    if (isWriteOp) {
      for (const [p, resolved] of candidates) {
        if (!isUnder(resolved, ownWorktree)) {
          const result: PolicyCheckResult = {
            allowed: false,
            rule: CROSS_REPO_RULES.READ_ONLY,
            reason: `Write to "${p}" (resolved: "${resolved}") is outside the agent's own worktree — cross-repo writes are not permitted`,
          };
          ctx.audit.record({
            action: 'guard_denied',
            command: cmd.argv.join(' '),
            allowed: false,
            policy_rule: result.rule,
            detail: { reason: result.reason },
          });
          return result;
        }
      }
    }

    return { allowed: true };
  }

  /**
   * Reject commands containing shell metacharacters that would defeat per-command
   * policy evaluation. Pipes (`|`) and redirection (`>`, `<`) are allowed because
   * the filesystem heuristic scans the full raw command for protected paths.
   * Fd-duplication forms (`2>&1`, `>&2`, `&>file`, …) are stripped before the
   * backgrounding check so their `&` doesn't trigger a false positive.
   */
  private checkShellMetacharacters(raw: string): PolicyCheckResult {
    // Strip quoted regions so metacharacters inside string literals (e.g.
    // `git commit -m "fix: x && y"`) don't trigger false positives.
    const stripped = stripRedirectionForms(stripQuoted(raw));

    const blockers: Array<[RegExp, string]> = [
      [/;/, 'semicolon command chaining'],
      [/&&/, '&& command chaining'],
      [/\|\|/, '|| command chaining'],
      [/`/, 'backtick command substitution'],
      [/\$\(/, '$() command substitution'],
      [/(?<!&)&(?!&)/, '& backgrounding'],
    ];

    for (const [re, label] of blockers) {
      if (re.test(stripped)) {
        return {
          allowed: false,
          rule: 'shell.metacharacters',
          reason: `${label} is not permitted — issue commands separately so each can be policy-checked`,
        };
      }
    }
    return { allowed: true };
  }

  /**
   * Reject programs that wrap arbitrary shell strings (bash -c, eval, etc.)
   * because the wrapped command would not pass through our parser.
   */
  private checkWrapperPrograms(raw: string): PolicyCheckResult {
    const cmd = parseCommand(raw);
    const wrappers = new Set(['bash', 'sh', 'zsh', 'ash', 'dash', 'eval', 'exec', 'env']);
    if (wrappers.has(cmd.program)) {
      // `env VAR=value cmd` is benign if cmd itself is benign, but parsing that
      // properly is out of scope for MVP. Block all wrapper programs uniformly
      // and let the agent invoke the target program directly.
      return {
        allowed: false,
        rule: 'shell.wrapper_program',
        reason: `"${cmd.program}" wraps an arbitrary command — invoke the target program directly so its arguments can be policy-checked`,
      };
    }
    return { allowed: true };
  }

  private checkGit(
    cmd: ReturnType<typeof parseCommand>,
    raw: string
  ): PolicyCheckResult {
    const { forbidden_flags, allowed_remotes, agents_must_use_pr } =
      this.policy.git;

    // Block forbidden flags (--force, --force-with-lease, --hard, etc.)
    for (const flag of cmd.flags) {
      // Normalise --flag=value → --flag
      const normalised = flag.split('=')[0];
      if (forbidden_flags.includes(normalised)) {
        return {
          allowed: false,
          rule: 'git.forbidden_flags',
          reason: `git flag "${normalised}" is not permitted by policy`,
        };
      }
    }

    // Block direct push to protected branches or non-allowed remotes
    if (cmd.subcommand === 'push') {
      if (agents_must_use_pr) {
        // Check remote URL — positional args after 'push': [remote, refspec]
        const remote = cmd.args[1]; // e.g. "origin", a URL, or undefined
        if (remote && this.isRemoteUrl(remote)) {
          const result = this.checkRemoteUrl(remote);
          if (!result.allowed) return result;
        } else if (remote) {
          // named remote — we can't resolve URLs at policy-check time; allow
          // (git itself will enforce the remote URL's permissions)
        }

        // Check if pushing to a protected branch via refspec
        const refspec = cmd.args[2];
        if (refspec) {
          const dest = refspec.includes(':') ? refspec.split(':')[1] : refspec;
          for (const branch of this.policy.git.protected_branches) {
            if (minimatch(dest, branch)) {
              return {
                allowed: false,
                rule: 'git.protected_branches',
                reason: `Direct push to protected branch "${dest}" is not permitted; open a PR instead`,
              };
            }
          }
        }
      }
    }

    return { allowed: true };
  }

  private checkRm(
    cmd: ReturnType<typeof parseCommand>,
    _raw: string
  ): PolicyCheckResult {
    const { protected_paths, allowed_write_root } = this.policy.filesystem;
    const resolvedRoot = path.resolve(allowed_write_root);

    for (const arg of cmd.args) {
      const resolved = this.resolvePath(arg);

      // Check against protected paths
      for (const protectedPath of protected_paths) {
        const resolvedProtected = this.resolvePath(protectedPath);
        if (resolved === resolvedProtected || resolved.startsWith(resolvedProtected + path.sep)) {
          return {
            allowed: false,
            rule: 'filesystem.protected_paths',
            reason: `Deletion of "${arg}" (${resolved}) is not permitted — path is protected`,
          };
        }
      }

      // Enforce allowed_write_root
      if (!resolved.startsWith(resolvedRoot + path.sep) && resolved !== resolvedRoot) {
        return {
          allowed: false,
          rule: 'filesystem.allowed_write_root',
          reason: `Deletion of "${arg}" is outside the allowed write root "${resolvedRoot}"`,
        };
      }
    }

    return { allowed: true };
  }

  private checkFilesystemWrite(raw: string): PolicyCheckResult {
    const { protected_paths } = this.policy.filesystem;
    const resolved_protected = protected_paths.map((p) => this.resolvePath(p));

    // Simple heuristic: look for path-like tokens in the command
    // that match protected paths. Not exhaustive but covers common cases.
    const tokens = raw.split(/\s+/);
    for (const token of tokens) {
      if (!token.startsWith('/') && !token.startsWith('~')) continue;
      const resolved = this.resolvePath(token);
      for (const rp of resolved_protected) {
        if (resolved === rp || resolved.startsWith(rp + path.sep)) {
          return {
            allowed: false,
            rule: 'filesystem.protected_paths',
            reason: `Access to "${token}" (${resolved}) is not permitted — path is protected`,
          };
        }
      }
    }
    return { allowed: true };
  }

  private checkRemoteUrl(url: string): PolicyCheckResult {
    const { allowed_remotes } = this.policy.git;
    if (allowed_remotes.length === 0) {
      return {
        allowed: false,
        rule: 'git.allowed_remotes',
        reason:
          'No allowed_remotes configured in the effective policy — all remote pushes are blocked',
      };
    }
    for (const pattern of allowed_remotes) {
      if (minimatch(url, pattern)) return { allowed: true };
    }
    return {
      allowed: false,
      rule: 'git.allowed_remotes',
      reason: `Remote URL "${url}" does not match any allowed_remotes pattern`,
    };
  }

  private isRemoteUrl(s: string): boolean {
    return s.startsWith('http') || s.startsWith('git@') || s.startsWith('ssh://');
  }

  private resolvePath(p: string): string {
    if (p.startsWith('~')) {
      return path.resolve(os.homedir(), p.slice(2));
    }
    return path.resolve(p);
  }

  /**
   * Canonicalizes targetPath (fs.realpathSync → path.resolve fallback) and
   * admits it iff it is under worktreeRoot or readRoot — never their common
   * parent. Runs regardless of cross_repo.enabled. Every denial is logged to
   * ctx.audit before returning.
   *
   * Note: realpathSync only follows symlinks for paths that exist on disk. A
   * not-yet-created path falls back to path.resolve (lexical normalization) —
   * acceptable for a read control.
   */
  checkReadScope(targetPath: string, ctx: ReadScopeContext): PolicyCheckResult {
    const base = ctx.worktreeRoot;
    const resolved = resolveArg(targetPath === '' ? '.' : targetPath, base);

    if (isUnder(resolved, ctx.worktreeRoot) || isUnder(resolved, ctx.readRoot)) {
      return { allowed: true };
    }

    const result: PolicyCheckResult = {
      allowed: false,
      rule: 'filesystem.allowed_read_root',
      reason: `Path "${targetPath}" (resolved: "${resolved}") is outside the allowed read scope — must be under worktree "${ctx.worktreeRoot}" or read root "${ctx.readRoot}"`,
    };
    ctx.audit.record({
      agent_id: ctx.agentId,
      action: 'read_scope_denied',
      command: `read ${targetPath}`,
      allowed: false,
      policy_rule: 'filesystem.allowed_read_root',
      detail: {
        tool: 'read',
        requestedPath: targetPath,
        resolvedPath: resolved,
        reason: result.reason,
        worktreeRoot: ctx.worktreeRoot,
        readRoot: ctx.readRoot,
      },
    });
    return result;
  }

  /**
   * Extracts path args from a parsed command for the enumerated readers
   * (grep, rg, find, cat, ls) and applies checkReadScope to each.
   * Returns the first denial, else { allowed: true }.
   * Runs regardless of cross_repo.enabled.
   */
  checkReadScopeCommand(command: string, ctx: ReadScopeContext): PolicyCheckResult {
    const READ_TOOLS = new Set(['grep', 'rg', 'find', 'cat', 'ls']);
    const cmd = parseCommand(command);

    if (!READ_TOOLS.has(cmd.program)) {
      return { allowed: true };
    }

    const candidates = extractArgPaths(cmd.argv, ctx.worktreeRoot);
    for (const [original, resolved] of candidates) {
      if (!isUnder(resolved, ctx.worktreeRoot) && !isUnder(resolved, ctx.readRoot)) {
        const result: PolicyCheckResult = {
          allowed: false,
          rule: 'filesystem.allowed_read_root',
          reason: `Path "${original}" (resolved: "${resolved}") is outside the allowed read scope — must be under worktree "${ctx.worktreeRoot}" or read root "${ctx.readRoot}"`,
        };
        ctx.audit.record({
          agent_id: ctx.agentId,
          action: 'read_scope_denied',
          command,
          allowed: false,
          policy_rule: 'filesystem.allowed_read_root',
          detail: {
            tool: cmd.program,
            requestedPath: original,
            resolvedPath: resolved,
            reason: result.reason,
            worktreeRoot: ctx.worktreeRoot,
            readRoot: ctx.readRoot,
          },
        });
        return result;
      }
    }

    return { allowed: true };
  }
}

/**
 * Replaces the contents of single- and double-quoted strings with placeholders
 * so the caller can scan for shell metacharacters without false positives from
 * literal text in `git commit -m "feat: a && b"`.
 */
function stripQuoted(input: string): string {
  let out = '';
  let i = 0;
  while (i < input.length) {
    const ch = input[i];
    if (ch === '\\' && i + 1 < input.length) {
      out += '__'; // collapse escaped char to safe placeholder
      i += 2;
      continue;
    }
    if (ch === "'" || ch === '"') {
      const quote = ch;
      i++;
      while (i < input.length && input[i] !== quote) {
        if (input[i] === '\\' && i + 1 < input.length) i++;
        i++;
      }
      i++; // closing quote
      out += '""'; // placeholder
      continue;
    }
    out += ch;
    i++;
  }
  return out;
}

/**
 * Replaces fd-duplication/redirection tokens (`2>&1`, `>&2`, `n<&m`, `2>&-`,
 * `<&-`, `&>file`, `&>>file`) with a metacharacter-free placeholder so the
 * backgrounding check doesn't false-positive on their `&`. Closed set only:
 * each form must stand alone as a token (start-of-string or whitespace on the
 * left; whitespace or end-of-string on the right for the fd-dup forms).
 * Anything outside these forms keeps its `&` and stays blocked — fail-safe
 * over completeness.
 */
function stripRedirectionForms(input: string): string {
  const forms: RegExp[] = [
    /(?<=^|\s)\d*>&\d+(?=\s|$)/g,
    /(?<=^|\s)\d*<&\d+(?=\s|$)/g,
    /(?<=^|\s)\d*>&-(?=\s|$)/g,
    /(?<=^|\s)\d*<&-(?=\s|$)/g,
    /(?<=^|\s)&>>?/g,
  ];
  let out = input;
  for (const re of forms) {
    out = out.replace(re, ' ');
  }
  return out;
}

// ── Cross-repo guard helpers ─────────────────────────────────────────────────

/** True when `resolved` is equal to `root` or is a direct descendant. */
function isUnder(resolved: string, root: string): boolean {
  return resolved === root || resolved.startsWith(root + path.sep);
}

/**
 * Resolve a path argument to its canonical absolute form.
 * Follows symlinks via realpathSync when the path exists; falls back to
 * path.resolve (normalizes `..` without a filesystem call) for non-existent
 * paths (write destinations that don't yet exist).
 */
function resolveArg(p: string, base: string): string {
  let normalized: string;
  if (p.startsWith('~/')) {
    normalized = path.join(os.homedir(), p.slice(2));
  } else if (p === '~') {
    normalized = os.homedir();
  } else {
    normalized = path.resolve(base, p);
  }
  try {
    return fs.realpathSync(normalized);
  } catch {
    return normalized;
  }
}

/**
 * Extract path candidates from the command argv (skipping argv[0], the
 * program itself).  Every non-flag token is resolved unconditionally so that
 * traversals like `src/../../sibling/` and `./../../outside/` are caught even
 * though they start with an innocuous directory component.  Flags (tokens
 * starting with `-`) are excluded because they are option names, not paths.
 *
 * The rule checks in checkCrossRepoAccess decide whether each resolved path
 * is inside a sibling root, inside the workspace, or outside the workspace —
 * tokens that resolve inside own worktree pass all three rules unchanged.
 *
 * Returns pairs of [original token, resolved absolute path].
 */
function extractArgPaths(argv: string[], base: string): Array<[string, string]> {
  return argv.slice(1)
    .filter(t => !t.startsWith('-'))
    .map(t => [t, resolveArg(t, base)]);
}
