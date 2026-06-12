import fs from 'node:fs';
import path from 'node:path';
import yaml from 'js-yaml';
import { z } from 'zod';
import { loomHome } from '../state/paths.js';

/**
 * One skill source: a git repo loom syncs into
 * `~/.loom/skills/shared/<name>/`. The PAT is referenced by env-var
 * name only; loom never reads, prompts for, or commits the token
 * value. The auth type is open-ended (only `github_pat` today) so
 * future auth backends slot in without a schema break.
 */
const AuthSchema = z.object({
  type: z.literal('github_pat'),
  env_var: z
    .string()
    .min(1, 'auth.env_var must name the environment variable holding the PAT'),
});

const SourceSchema = z.object({
  /**
   * Lowercase, hyphenated. Doubles as the directory name under
   * `~/.loom/skills/shared/<name>/`, so path-unsafe characters are
   * rejected here rather than producing confusing fs errors later.
   */
  name: z
    .string()
    .regex(
      /^[a-z0-9][a-z0-9-]*$/,
      'name must be lowercase letters, digits, and hyphens (start with letter or digit)',
    ),
  url: z.string().url('url must be a valid HTTPS/SSH git URL'),
  /** Branch to sync from. Defaults to `main` when omitted. */
  branch: z.string().min(1).default('main'),
  /**
   * SHA pin — the "lock file" entry. Empty string before the first
   * sync; populated automatically by `loom skills sync` when it
   * resolves the branch HEAD for the first time.
   */
  pinned_sha: z.string().default(''),
  auth: AuthSchema,
  /** Optional glob filters limiting which skills load from this source. */
  include: z.array(z.string()).optional(),
  exclude: z.array(z.string()).optional(),
});

const SourcesConfigSchema = z.object({
  sources: z.array(SourceSchema).default([]),
});

export type SkillSourceEntry = z.infer<typeof SourceSchema>;

/**
 * Loader + accessor for `~/.loom/sources.yaml` — the operator's
 * declaration of which skill repos loom syncs.
 *
 * Lifecycle:
 *   - `SourcesConfig.load()` reads the file. A missing file is
 *     treated as "no sources configured" (returns an empty config
 *     so `loom skills sync` is a clean no-op). A malformed file
 *     throws — silent ignore would lose updates the operator made.
 *   - `list()`, `get(name)` are the read API.
 *   - Writer for pin updates lands in story-cloud-002 with the sync
 *     command; this module is read-only for story-cloud-001.
 */
export class SourcesConfig {
  constructor(
    private readonly entries: SkillSourceEntry[],
    public readonly file: string,
  ) {}

  /** Default path: `<loomHome>/sources.yaml`. */
  static defaultPath(): string {
    return path.join(loomHome(), 'sources.yaml');
  }

  /**
   * Reads + validates the sources file. Missing file → empty config.
   * Malformed YAML or schema violation throws a descriptive Error.
   */
  static load(opts: { path?: string } = {}): SourcesConfig {
    const file = opts.path ?? SourcesConfig.defaultPath();
    if (!fs.existsSync(file)) {
      return new SourcesConfig([], file);
    }
    const raw = fs.readFileSync(file, 'utf8');
    let parsed: unknown;
    try {
      parsed = yaml.load(raw);
    } catch (err) {
      throw new Error(`sources.yaml is not valid YAML: ${(err as Error).message}`);
    }
    if (parsed == null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error(`sources.yaml must be a YAML object with a 'sources:' key`);
    }
    const result = SourcesConfigSchema.safeParse(parsed);
    if (!result.success) {
      throw new Error(
        `sources.yaml failed validation: ${result.error.issues
          .map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`)
          .join('; ')}`,
      );
    }
    // Reject duplicate source names — they'd silently collide on the
    // shared mirror path `~/.loom/skills/shared/<name>/`.
    const seen = new Set<string>();
    for (const s of result.data.sources) {
      if (seen.has(s.name)) {
        throw new Error(`duplicate source name '${s.name}' in sources.yaml`);
      }
      seen.add(s.name);
    }
    return new SourcesConfig(result.data.sources, file);
  }

  list(): SkillSourceEntry[] {
    return [...this.entries];
  }

  get(name: string): SkillSourceEntry | undefined {
    return this.entries.find((s) => s.name === name);
  }

  /**
   * True when at least one source is configured. `loom skills sync`
   * uses this to short-circuit with a friendly "nothing to sync"
   * message rather than running the empty loop.
   */
  isEmpty(): boolean {
    return this.entries.length === 0;
  }
}
