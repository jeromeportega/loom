import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import matter from 'gray-matter';
import { SourcesConfig, type SkillSourceEntry } from './SourcesConfig.js';
import { stripLoomInternalMetadata } from './spec.js';
import { SkillUsageStore } from '../state/SkillUsageStore.js';
import type { AuditLog } from '../state/AuditLog.js';

export interface SkillProposerOptions {
  /** Defaults to SourcesConfig.load(). */
  sourcesConfig?: SourcesConfig;
  /** Where SkillGenerator writes candidates. Defaults to ~/.loom/skills/generated/. */
  generatedDir?: string;
  /** Override the git binary. */
  gitBin?: string;
  /**
   * Custom PR creator — receives the cloned target dir + branch + title +
   * body. Returns the PR URL. Default invokes `gh pr create`. Lets tests
   * stub without a real GitHub roundtrip.
   */
  prCreator?: (ctx: {
    repoDir: string;
    head: string;
    title: string;
    body: string;
  }) => string;
  /** Env reader override (tests). */
  env?: (name: string) => string | undefined;
  /** SkillUsageStore for embedding evidence in the PR body. Best-effort. */
  usageStore?: SkillUsageStore;
  /** AuditLog for recording proposal actions. Best-effort. */
  audit?: AuditLog;
  onProgress?: (line: string) => void;
}

export interface ProposeArgs {
  candidateName: string;
  /** Required only when sources.yaml has more than one source. */
  sourceName?: string;
  /** When true, the proposer builds the branch + body but does not push or open the PR. */
  dryRun?: boolean;
  /**
   * Set to true when the auto-propose pipeline triggers this. Surfaces in
   * the PR body header so a human reviewer knows there was no operator
   * sanity-check before submission.
   */
  autoProposed?: boolean;
  /**
   * Free-form epic / story context the caller can supply for the PR body
   * (e.g. "produced in epic-001 by story-001-003"). The proposer also
   * pulls the SkillUsageStore track record by candidate name; this is
   * additional narrative.
   */
  context?: string;
}

export interface ProposeResult {
  candidateName: string;
  sourceName: string;
  status: 'proposed' | 'dry-run' | 'error';
  /** Local branch name on the cloned target repo. */
  branch?: string;
  /** PR URL on the target source repo when status === 'proposed'. */
  url?: string;
  /** Resolved PR body — useful in dry-run for the operator to inspect. */
  body?: string;
  error?: string;
}

/**
 * Files a generated candidate from ~/.loom/skills/generated/<name>/ as a
 * PR against its target source's repo. Mirrors SkillSync's PAT handling:
 * the token is read from the source's auth.env_var at runtime, injected
 * into the clone URL in-memory via `-c url.X.insteadOf=Y`, and never lands
 * in .git/config or ~/.git-credentials. The proposer never auto-merges —
 * the PR is the human gate.
 */
export class SkillProposer {
  private readonly config: SourcesConfig;
  private readonly generatedDir: string;
  private readonly gitBin: string;
  private readonly readEnv: (name: string) => string | undefined;
  private readonly prCreator: NonNullable<SkillProposerOptions['prCreator']>;
  private readonly usageStore?: SkillUsageStore;
  private readonly audit?: AuditLog;
  private readonly log: (line: string) => void;

  constructor(opts: SkillProposerOptions = {}) {
    this.config = opts.sourcesConfig ?? SourcesConfig.load();
    this.generatedDir =
      opts.generatedDir ?? path.join(os.homedir(), '.loom', 'skills', 'generated');
    this.gitBin = opts.gitBin ?? 'git';
    this.readEnv = opts.env ?? ((n) => process.env[n]);
    this.prCreator = opts.prCreator ?? defaultPrCreator;
    this.usageStore = opts.usageStore;
    this.audit = opts.audit;
    this.log = opts.onProgress ?? ((l) => console.log(l));
  }

  propose(args: ProposeArgs): ProposeResult {
    const { candidateName } = args;
    const candidateDir = path.join(this.generatedDir, candidateName);
    if (!fs.existsSync(path.join(candidateDir, 'SKILL.md'))) {
      return error(
        candidateName,
        args.sourceName ?? '',
        `No candidate at ${candidateDir}. Run loom to generate one first, or check the name.`,
      );
    }

    // Source resolution — require explicit --source when ambiguous.
    const sources = this.config.list();
    if (sources.length === 0) {
      return error(
        candidateName,
        '',
        'No skill sources configured. Create ~/.loom/sources.yaml first.',
      );
    }
    let target: SkillSourceEntry;
    if (args.sourceName) {
      const found = this.config.get(args.sourceName);
      if (!found) {
        return error(
          candidateName,
          args.sourceName,
          `No source named "${args.sourceName}" in sources.yaml. Configured: ${sources
            .map((s) => s.name)
            .join(', ')}.`,
        );
      }
      target = found;
    } else if (sources.length === 1) {
      target = sources[0];
    } else {
      return error(
        candidateName,
        '',
        `Multiple sources configured (${sources
          .map((s) => s.name)
          .join(', ')}); pass --source <name> to disambiguate.`,
      );
    }

    const pat = this.readEnv(target.auth.env_var);
    if (!pat && !args.dryRun) {
      return error(
        candidateName,
        target.name,
        `PAT env var "${target.auth.env_var}" is unset — set it before running propose, ` +
          `or use --dry-run to compose the PR body without pushing.`,
      );
    }

    // Compose the PR body up-front — same shape for dry-run and real.
    const body = this.composeBody(candidateName, candidateDir, target.name, args);

    if (args.dryRun) {
      this.log(`    ${candidateName}: dry-run, no clone or push (body composed for inspection).`);
      this.audit?.record({
        action: 'skill_propose',
        command: candidateName,
        allowed: true,
        detail: { source: target.name, dry_run: true, auto: args.autoProposed === true },
      });
      return {
        candidateName,
        sourceName: target.name,
        status: 'dry-run',
        body,
      };
    }

    // Clone, copy, commit, push, gh pr create — wrap in try/catch so any
    // git failure surfaces as a structured error rather than blowing up the
    // CLI / orchestrator.
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'loom-propose-'));
    const branch = `propose/${candidateName}-${nowStamp()}`;
    try {
      this.gitWithAuth(tmpRoot, target.url, pat!, [
        'clone',
        '--depth',
        '50',
        '--branch',
        target.branch,
        target.url,
        tmpRoot,
      ]);
      this.gitIn(tmpRoot, ['checkout', '-b', branch]);

      // Copy the candidate dir into <repo>/skills/<name>/, overwriting any
      // existing skill of the same name (reviewers see the change clearly
      // in the PR diff).
      const destDir = path.join(tmpRoot, 'skills', candidateName);
      fs.mkdirSync(path.dirname(destDir), { recursive: true });
      copyDirRecursive(candidateDir, destDir);

      // Strip the local-only lifecycle metadata before commit — the
      // candidate / active / disabled state is loom-internal, not part
      // of a published skill.
      sanitizeSkillFrontmatter(path.join(destDir, 'SKILL.md'));

      this.gitIn(tmpRoot, ['add', path.join('skills', candidateName)]);
      this.gitIn(tmpRoot, ['-c', 'user.email=loom@example.com', '-c', 'user.name=loom', 'commit', '-m',
        `propose: ${candidateName}${args.autoProposed ? ' (auto-proposed)' : ''}`,
      ]);

      this.gitWithAuth(tmpRoot, target.url, pat!, ['push', '-u', 'origin', branch]);

      const url = this.prCreator({
        repoDir: tmpRoot,
        head: branch,
        title: `propose: skill "${candidateName}"${args.autoProposed ? ' (auto)' : ''}`,
        body,
      });

      this.log(`    ${candidateName} → ${target.name}: ${url}`);
      this.audit?.record({
        action: 'skill_propose',
        command: candidateName,
        allowed: true,
        detail: {
          source: target.name,
          branch,
          url,
          auto: args.autoProposed === true,
        },
      });

      return {
        candidateName,
        sourceName: target.name,
        status: 'proposed',
        branch,
        url,
        body,
      };
    } catch (err) {
      const msg = scrubPat((err as Error).message, pat ?? '');
      this.audit?.record({
        action: 'skill_propose',
        command: candidateName,
        allowed: false,
        detail: {
          source: target.name,
          error: msg,
          auto: args.autoProposed === true,
        },
      });
      return {
        candidateName,
        sourceName: target.name,
        status: 'error',
        branch,
        body,
        error: msg,
      };
    } finally {
      // Best-effort cleanup — a leftover temp dir is non-fatal.
      try {
        fs.rmSync(tmpRoot, { recursive: true, force: true });
      } catch {
        // intentionally swallowed
      }
    }
  }

  /**
   * Compose the PR body. Mirrors the four review questions in
   * loom-skills `skills/README.md` so the reviewer has them to hand
   * without context-switching to the docs repo.
   */
  private composeBody(
    name: string,
    candidateDir: string,
    sourceName: string,
    args: ProposeArgs,
  ): string {
    const lines: string[] = [];
    if (args.autoProposed) {
      lines.push('## :robot: Auto-proposed by loom');
      lines.push('');
      lines.push(
        'This PR was filed automatically when the candidate cleared ' +
          '`agents.skill_auto_propose_min_judge_score`. No operator ' +
          'sanity-check before submission — the human gate is *this PR*.',
      );
    } else {
      lines.push('## Proposed by operator');
      lines.push('');
      lines.push('Filed via `loom skills propose`.');
    }
    lines.push('');
    lines.push(`**Target source:** \`${sourceName}\``);
    lines.push(`**Candidate path (local):** \`~/.loom/skills/generated/${name}/\``);
    if (args.context) {
      lines.push(`**Context:** ${args.context}`);
    }
    lines.push('');

    // Pull the candidate's description from frontmatter and the first ~30
    // lines of body so reviewers see what they're being asked to publish.
    try {
      const raw = fs.readFileSync(path.join(candidateDir, 'SKILL.md'), 'utf8');
      const parsed = matter(raw);
      const desc = (parsed.data.description as string | undefined) ?? '';
      lines.push('## Description');
      lines.push('');
      lines.push(desc || '(no description)');
      lines.push('');
      const preview = parsed.content
        .split('\n')
        .slice(0, 30)
        .join('\n')
        .trim();
      if (preview.length > 0) {
        lines.push('## Body preview (first 30 lines)');
        lines.push('');
        lines.push('```markdown');
        lines.push(preview);
        lines.push('```');
        lines.push('');
      }
    } catch {
      lines.push('_(could not read SKILL.md to preview body)_');
      lines.push('');
    }

    // Empirical evidence — pull the candidate's track record from the
    // SkillUsageStore when available.
    if (this.usageStore) {
      const tr = this.usageStore.trackRecord(name);
      lines.push('## Evidence (local track record)');
      lines.push('');
      if (tr.injected === 0) {
        lines.push(
          '_(none yet — candidate generated but not injected into any subsequent story locally)_',
        );
      } else {
        lines.push(
          `Injected ${tr.injected} time${tr.injected === 1 ? '' : 's'} locally: ` +
            `${tr.succeeded} succeeded / ${tr.failed} failed.`,
        );
      }
      lines.push('');
    }

    // Review questions — mirror loom-skills `skills/README.md`.
    lines.push('## Review questions');
    lines.push('');
    lines.push(
      '1. What problem does this skill solve that the bundled / existing skills do not?',
    );
    lines.push(
      '2. What is the smallest brief that should trigger this skill (so the description is accurate)?',
    );
    lines.push(
      '3. Was this skill empirically validated locally before proposing (see Evidence section)?',
    );
    lines.push(
      '4. Did the worker do something measurably different with this skill vs without?',
    );

    return lines.join('\n');
  }

  private gitIn(dir: string, args: string[]): string {
    return execFileSync(this.gitBin, args, { cwd: dir, encoding: 'utf8' });
  }

  private gitWithAuth(
    dir: string,
    originalUrl: string,
    pat: string,
    args: string[],
  ): string {
    const authedUrl = injectPat(originalUrl, pat);
    const cfg = [
      '-c',
      'credential.helper=',
      '-c',
      `url.${authedUrl}.insteadOf=${originalUrl}`,
    ];
    return execFileSync(this.gitBin, [...cfg, ...args], {
      cwd: dir,
      encoding: 'utf8',
    });
  }
}

function defaultPrCreator(ctx: {
  repoDir: string;
  head: string;
  title: string;
  body: string;
}): string {
  const out = execFileSync(
    'gh',
    ['pr', 'create', '--head', ctx.head, '--title', ctx.title, '--body', ctx.body],
    { cwd: ctx.repoDir, encoding: 'utf8' },
  );
  const httpLine = out
    .trim()
    .split('\n')
    .find((l) => l.startsWith('http'));
  return httpLine ?? out.trim();
}

function error(candidateName: string, sourceName: string, msg: string): ProposeResult {
  return { candidateName, sourceName, status: 'error', error: msg };
}

function injectPat(url: string, pat: string): string {
  if (url.startsWith('https://')) {
    return url.replace(/^https:\/\//, `https://oauth2:${pat}@`);
  }
  return url;
}

function scrubPat(s: string, pat: string): string {
  if (!pat) return s;
  return s.split(pat).join('***');
}

function nowStamp(): string {
  const d = new Date();
  const pad = (n: number, w = 2): string => String(n).padStart(w, '0');
  return (
    d.getUTCFullYear() +
    pad(d.getUTCMonth() + 1) +
    pad(d.getUTCDate()) +
    '-' +
    pad(d.getUTCHours()) +
    pad(d.getUTCMinutes()) +
    pad(d.getUTCSeconds())
  );
}

/**
 * Recursive copy that survives without fs.cp (older Node) and skips
 * symlinks (defensive — a candidate skill should not contain them, but
 * silently following them would be a footgun).
 */
function copyDirRecursive(src: string, dest: string): void {
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    if (entry.isSymbolicLink()) continue;
    const from = path.join(src, entry.name);
    const to = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      copyDirRecursive(from, to);
    } else if (entry.isFile()) {
      fs.copyFileSync(from, to);
    }
  }
}

/**
 * Strip loom-internal metadata from the candidate's SKILL.md before it
 * lands in the published skill repo. The actual key list lives in
 * `spec.ts` next to {@link LOOM_INTERNAL_METADATA_KEYS} so the proposer
 * and the conformance test never drift on which keys are loom-local.
 */
function sanitizeSkillFrontmatter(file: string): void {
  if (!fs.existsSync(file)) return;
  const parsed = matter(fs.readFileSync(file, 'utf8'));
  const data = parsed.data as Record<string, unknown>;
  const meta = stripLoomInternalMetadata(
    (data.metadata as Record<string, unknown> | undefined) ?? {},
  );
  if (Object.keys(meta).length > 0) {
    data.metadata = meta;
  } else {
    delete data.metadata;
  }
  fs.writeFileSync(file, matter.stringify(parsed.content, data));
}
