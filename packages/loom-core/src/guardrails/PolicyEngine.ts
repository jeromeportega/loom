import path from 'node:path';
import os from 'node:os';
import { minimatch } from 'minimatch';
import { PolicySchema, type Policy, type PolicyCheckResult } from '../types.js';
import { parseCommand } from './CommandParser.js';
import { resolveEffectiveConfig } from '../config/resolveEffectiveConfig.js';

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
    const { policy } = resolveEffectiveConfig({ loomdir, projectRoot, env: opts?.env });
    return new PolicyEngine(policy);
  }

  static defaultPolicy(): Policy {
    return PolicySchema.parse({});
  }

  get policyData(): Policy {
    return this.policy;
  }

  check(rawCommand: string): PolicyCheckResult {
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
          'No allowed_remotes configured in policy.yaml — all remote pushes are blocked',
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
