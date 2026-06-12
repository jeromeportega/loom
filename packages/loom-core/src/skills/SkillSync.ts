import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { loomHome } from '../state/paths.js';
import { SourcesConfig, type SkillSourceEntry } from './SourcesConfig.js';

export interface SkillSyncOptions {
  /** Override the SourcesConfig instance — defaults to SourcesConfig.load(). */
  config?: SourcesConfig;
  /**
   * Override the mirror root. Defaults to `<loomHome>/skills/shared`.
   * Each source clones to `<mirrorRoot>/<name>/`.
   */
  mirrorRoot?: string;
  /** Override the git binary. Defaults to 'git'. Lets tests stub. */
  gitBin?: string;
  /**
   * Override the env reader. Default reads `process.env`. Lets tests
   * inject fixtures without polluting the real environment.
   */
  env?: (name: string) => string | undefined;
  /** Progress sink. Defaults to console.log. */
  onProgress?: (line: string) => void;
}

export interface SyncResult {
  name: string;
  /**
   * - 'updated' — mirror moved from oldSha to newSha
   * - 'unchanged' — already at the pinned SHA, nothing to do
   * - 'first-sync' — initial clone, pin captured for future runs
   * - 'error' — failed; see error
   */
  status: 'updated' | 'unchanged' | 'first-sync' | 'error';
  /** Previous SHA at the local mirror (empty on first sync). */
  oldSha: string;
  /** Resolved target SHA (the pin, or the branch HEAD if --update). */
  newSha: string;
  /** Mirror directory on disk (always set, even on error). */
  mirrorDir: string;
  /** Error message when status === 'error'. */
  error?: string;
}

export interface SyncReport {
  /** Per-source results in source-order. */
  results: SyncResult[];
  /** Pin updates that need to be written back to sources.yaml. */
  pinUpdates: { name: string; sha: string }[];
}

/**
 * Pulls every configured skill source into `~/.loom/skills/shared/<name>/`
 * and fast-forwards to its pinned SHA. The PAT is read from each source's
 * `auth.env_var` at sync time only — never persisted, never logged,
 * never written to git's credential helper.
 *
 * Behavior summary:
 *   - First sync (no .git yet): clone via authenticated HTTPS into the
 *     mirror dir; if `pinned_sha` is empty, capture the current branch
 *     HEAD as the new pin; otherwise fast-forward to the pin.
 *   - Subsequent sync: `git fetch` into the existing mirror, fast-forward
 *     to the pin (or to branch HEAD when `--update` is passed).
 *   - All git calls go through execFileSync with the PAT only in the
 *     `--config http.extraHeader` flag (in-memory, never written to a
 *     git config file).
 */
export class SkillSync {
  private readonly config: SourcesConfig;
  private readonly mirrorRoot: string;
  private readonly gitBin: string;
  private readonly readEnv: (name: string) => string | undefined;
  private readonly log: (line: string) => void;

  constructor(opts: SkillSyncOptions = {}) {
    this.config = opts.config ?? SourcesConfig.load();
    this.mirrorRoot = opts.mirrorRoot ?? path.join(loomHome(), 'skills', 'shared');
    this.gitBin = opts.gitBin ?? 'git';
    this.readEnv = opts.env ?? ((n) => process.env[n]);
    this.log = opts.onProgress ?? ((l) => console.log(l));
  }

  /**
   * Sync every configured source. `update: true` advances each source's
   * pin to its branch HEAD; otherwise the pin is the target.
   */
  sync(opts: { update?: boolean } = {}): SyncReport {
    fs.mkdirSync(this.mirrorRoot, { recursive: true });
    const results: SyncResult[] = [];
    const pinUpdates: { name: string; sha: string }[] = [];

    for (const source of this.config.list()) {
      const result = this.syncOne(source, opts.update === true);
      results.push(result);
      // First-sync captures a pin; --update advances an existing pin.
      // Both warrant a writeback. Errored or unchanged sources don't.
      const captured = result.status === 'first-sync';
      const advanced =
        result.status === 'updated' && opts.update === true && result.newSha !== source.pinned_sha;
      if ((captured || advanced) && result.newSha) {
        pinUpdates.push({ name: source.name, sha: result.newSha });
      }
    }
    return { results, pinUpdates };
  }

  /** Sync a single source. Public for tests; the main entry is sync(). */
  syncOne(source: SkillSourceEntry, update: boolean): SyncResult {
    const mirrorDir = path.join(this.mirrorRoot, source.name);
    const pat = this.readEnv(source.auth.env_var);
    if (!pat) {
      return {
        name: source.name,
        status: 'error',
        oldSha: '',
        newSha: '',
        mirrorDir,
        error:
          `PAT env var "${source.auth.env_var}" is unset — set it in your shell ` +
          `or 1Password/envrc and re-run sync.`,
      };
    }

    try {
      const exists = fs.existsSync(path.join(mirrorDir, '.git'));
      // Compose authenticated URL only in memory — never written to a
      // git config, never logged.
      const authedUrl = injectPat(source.url, pat);

      if (!exists) {
        this.git(['clone', '--branch', source.branch, authedUrl, mirrorDir]);
        // After clone, HEAD is origin/branch. The pin is either empty (first
        // sync — capture it) or set (fast-forward to it).
        const branchHead = this.gitInDir(mirrorDir, ['rev-parse', 'HEAD']).trim();
        if (source.pinned_sha === '' || update) {
          this.log(`    ${source.name}: first sync, pin captured at ${short(branchHead)}`);
          return {
            name: source.name,
            status: 'first-sync',
            oldSha: '',
            newSha: branchHead,
            mirrorDir,
          };
        }
        // Pin already set in sources.yaml — checkout that SHA.
        this.gitInDir(mirrorDir, ['checkout', '--detach', source.pinned_sha]);
        this.log(`    ${source.name}: cloned and checked out ${short(source.pinned_sha)}`);
        return {
          name: source.name,
          status: 'updated',
          oldSha: '',
          newSha: source.pinned_sha,
          mirrorDir,
        };
      }

      // Existing mirror — fetch latest, then move HEAD.
      const oldSha = this.gitInDir(mirrorDir, ['rev-parse', 'HEAD']).trim();
      this.gitInDirWithAuth(mirrorDir, source.url, pat, ['fetch', '--quiet', 'origin', source.branch]);

      let targetSha: string;
      if (update) {
        // Advance pin to current branch HEAD.
        targetSha = this.gitInDir(mirrorDir, ['rev-parse', `origin/${source.branch}`]).trim();
      } else if (source.pinned_sha === '') {
        // Existing mirror but pin never set — treat like first-sync.
        targetSha = this.gitInDir(mirrorDir, ['rev-parse', `origin/${source.branch}`]).trim();
        this.gitInDir(mirrorDir, ['checkout', '--detach', targetSha]);
        this.log(`    ${source.name}: pin captured at ${short(targetSha)}`);
        return {
          name: source.name,
          status: 'first-sync',
          oldSha,
          newSha: targetSha,
          mirrorDir,
        };
      } else {
        targetSha = source.pinned_sha;
      }

      if (targetSha === oldSha) {
        this.log(`    ${source.name}: unchanged at ${short(oldSha)}`);
        return {
          name: source.name,
          status: 'unchanged',
          oldSha,
          newSha: oldSha,
          mirrorDir,
        };
      }

      this.gitInDir(mirrorDir, ['checkout', '--detach', targetSha]);
      this.log(
        `    ${source.name}: ${short(oldSha)} -> ${short(targetSha)}${update ? ' (--update)' : ''}`,
      );
      return {
        name: source.name,
        status: 'updated',
        oldSha,
        newSha: targetSha,
        mirrorDir,
      };
    } catch (err) {
      const msg = scrubPat((err as Error).message, pat);
      return {
        name: source.name,
        status: 'error',
        oldSha: '',
        newSha: '',
        mirrorDir,
        error: msg,
      };
    }
  }

  private git(args: string[]): string {
    return execFileSync(this.gitBin, args, { encoding: 'utf8' });
  }

  private gitInDir(dir: string, args: string[]): string {
    return execFileSync(this.gitBin, args, { cwd: dir, encoding: 'utf8' });
  }

  /**
   * Run a git command against a remote that requires auth — without
   * touching `~/.git-credentials`. The PAT is injected via a one-shot
   * `-c credential.helper=` override paired with a remote URL rewrite.
   * The PAT never lands in `.git/config`.
   */
  private gitInDirWithAuth(dir: string, originalUrl: string, pat: string, args: string[]): string {
    const authedUrl = injectPat(originalUrl, pat);
    // The url.<base>.insteadOf trick: remap the un-authed URL to the authed
    // one for the duration of THIS git invocation only. -c is per-process.
    const cfg = [
      '-c',
      'credential.helper=',
      '-c',
      `url.${authedUrl}.insteadOf=${originalUrl}`,
    ];
    return execFileSync(this.gitBin, [...cfg, ...args], { cwd: dir, encoding: 'utf8' });
  }
}

/**
 * Compose an HTTPS git URL with the operator's PAT in-memory. Uses the
 * `oauth2:<TOKEN>@host` form which both github.com and GitHub Enterprise accept.
 * SSH URLs are passed through unchanged (they don't carry PATs).
 */
function injectPat(url: string, pat: string): string {
  if (url.startsWith('https://')) {
    // https://host/path → https://oauth2:<pat>@host/path
    return url.replace(/^https:\/\//, `https://oauth2:${pat}@`);
  }
  return url;
}

/** Defensive scrub: never let the PAT leak through an error message. */
function scrubPat(s: string, pat: string): string {
  if (!pat) return s;
  return s.split(pat).join('***');
}

function short(sha: string): string {
  return sha.slice(0, 7);
}

/**
 * Rewrites the `pinned_sha:` value for a named source in-place,
 * preserving comments and the rest of the file. When the source block
 * doesn't yet contain a `pinned_sha:` line, one is inserted right after
 * the `name:` line at the matching indentation. Returns the new file
 * contents so the caller can choose whether to write or echo.
 */
export function updatePinInPlace(
  fileContents: string,
  sourceName: string,
  newSha: string,
): string {
  const lines = fileContents.split('\n');
  const out: string[] = [];
  let inTarget = false;
  let targetIndent = '';
  let pinReplaced = false;
  let pinInserted = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // A new source entry — anchored to the dash-name pattern.
    const nameMatch = line.match(/^(\s*)-\s+name:\s*['"]?([a-z0-9][a-z0-9-]*)['"]?\s*$/);
    if (nameMatch) {
      // Leaving the previous target? If we never saw a pinned_sha line
      // for it, we'll insert one before this new entry.
      if (inTarget && !pinReplaced && !pinInserted) {
        out.push(`${targetIndent}  pinned_sha: "${newSha}"`);
        pinInserted = true;
      }
      inTarget = nameMatch[2] === sourceName;
      targetIndent = nameMatch[1];
      out.push(line);
      continue;
    }

    // Inside the target block — look for an existing pinned_sha to replace.
    if (inTarget && !pinReplaced) {
      const pinMatch = line.match(/^(\s*)pinned_sha:\s*/);
      if (pinMatch) {
        out.push(`${pinMatch[1]}pinned_sha: "${newSha}"`);
        pinReplaced = true;
        continue;
      }
    }

    out.push(line);
  }

  // End-of-file fallthrough: if the target was the last source and had
  // no pinned_sha, append one inside its block.
  if (inTarget && !pinReplaced && !pinInserted) {
    // Find the last line that belonged to the target block by scanning
    // backwards for the matching `- name:` and inserting after it.
    for (let i = out.length - 1; i >= 0; i--) {
      const m = out[i].match(/^(\s*)-\s+name:\s*['"]?([a-z0-9][a-z0-9-]*)['"]?\s*$/);
      if (m && m[2] === sourceName) {
        out.splice(i + 1, 0, `${m[1]}  pinned_sha: "${newSha}"`);
        break;
      }
    }
  }

  return out.join('\n');
}
