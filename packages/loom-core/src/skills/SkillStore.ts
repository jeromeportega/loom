import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import fg from 'fast-glob';
import { minimatch } from 'minimatch';
import matter from 'gray-matter';
import { SourcesConfig, type SkillSourceEntry } from './SourcesConfig.js';

/**
 * Where a skill manifest came from:
 *   - bundled — ships with @loom-ai/core
 *   - project — checked-in at `<projectRoot>/.loom/skills/`
 *   - global — hand-authored at `~/.loom/skills/`
 *   - generated — written by the SkillGenerator under generated/
 *   - shared — pulled by `loom skills sync` from a sources.yaml entry;
 *     the source's name appears on the manifest as shareSourceName.
 */
export type SkillSource = 'bundled' | 'project' | 'global' | 'generated' | 'shared';

/**
 * Resolves loom's bundled skills directory — the default skill library that
 * ships with @loom-ai/core. Returns null if it cannot be located.
 */
export function bundledSkillsDir(): string | null {
  // At runtime __dirname is <pkg>/dist/skills; skills/ ships at <pkg>/skills.
  const candidates = [
    path.resolve(__dirname, '../../skills'),
    path.resolve(__dirname, '../skills'),
  ];
  return candidates.find((dir) => fs.existsSync(dir)) ?? null;
}

/**
 * Lifecycle of a generated skill:
 *  - candidate: unproven — injected only as a canary (spare slots)
 *  - active:    trusted — always eligible for injection
 *  - disabled:  demoted — never injected
 * Hand-authored (project/global) skills are always reported 'active'.
 */
export type SkillLifecycle = 'candidate' | 'active' | 'disabled';

export interface SkillManifest {
  name: string;
  description: string;
  metadata: Record<string, unknown>;
  source: SkillSource;
  lifecycle: SkillLifecycle;
  /** Absolute path to the skill's SKILL.md file. */
  file: string;
  /**
   * For source === 'shared', the name of the sources.yaml entry this
   * skill was pulled from (e.g. 'loom-skills'). Undefined for every
   * other source.
   */
  shareSourceName?: string;
}

export interface SkillStoreOptions {
  projectRoot: string;
  /** Global skills root. Default: ~/.loom/skills. Injected in tests. */
  globalSkillsDir?: string;
  /**
   * Bundled skills root — loom's default skill library. Defaults to the dir
   * shipped with @loom-ai/core. Pass an empty dir in tests to isolate.
   */
  bundledSkillsDir?: string;
  /**
   * Shared mirror root — where `loom skills sync` writes per-source
   * subdirectories. Defaults to `~/.loom/skills/shared`. Injected in tests.
   */
  sharedMirrorRoot?: string;
  /**
   * The sources.yaml config that enumerates shared sources (and their
   * include / exclude filters). Defaults to `SourcesConfig.load()`, which
   * returns an empty config when sources.yaml doesn't exist — so installs
   * without any shared config are unaffected. Inject in tests to control
   * which sources discovery iterates.
   */
  sourcesConfig?: SourcesConfig;
}

/**
 * Discovers and loads agentskills.io-format skills. Skills live as
 * `<root>/<skill-name>/SKILL.md` under three roots:
 *   - `<projectRoot>/.loom/skills/`  — checked-in, team-shared (source: project)
 *   - `~/.loom/skills/`              — per-machine (source: global)
 *   - the dir bundled with @loom-ai/core — loom's defaults (source: bundled)
 * Skills written by the SkillGenerator land in `~/.loom/skills/generated/`
 * (source: generated).
 *
 * On a name clash, precedence is project > global > bundled — a project skill
 * overrides loom's bundled default of the same name.
 *
 * `discover()` reads only frontmatter (progressive disclosure); `load()` reads
 * a skill's full body on demand.
 */
export class SkillStore {
  private projectSkillsDir: string;
  private globalSkillsDir: string;
  private bundledDir: string | null;
  private sharedMirrorRoot: string;
  private sources: SkillSourceEntry[];

  constructor(opts: SkillStoreOptions) {
    this.projectSkillsDir = path.join(opts.projectRoot, '.loom', 'skills');
    this.globalSkillsDir =
      opts.globalSkillsDir ?? path.join(os.homedir(), '.loom', 'skills');
    this.bundledDir = opts.bundledSkillsDir ?? bundledSkillsDir();
    this.sharedMirrorRoot =
      opts.sharedMirrorRoot ?? path.join(os.homedir(), '.loom', 'skills', 'shared');
    // SourcesConfig.load returns an empty config when sources.yaml is
    // absent, so this is safe to call on every install — installs without
    // shared skills simply have nothing to enumerate.
    const config = opts.sourcesConfig ?? safeLoadSources();
    this.sources = config.list();
  }

  /** Returns manifests for every valid skill. Invalid SKILL.md files are skipped. */
  discover(): SkillManifest[] {
    const manifests: SkillManifest[] = [];
    const seen = new Set<string>();

    // Precedence on a name clash: project > global > shared > bundled.
    // Project skills come from the consuming repo (most explicit); global
    // is per-machine hand-curated; shared is org-curated; bundled is loom
    // defaults. Earlier roots win.
    const roots: Array<[string, SkillSource]> = [
      [this.projectSkillsDir, 'project'],
      [this.globalSkillsDir, 'global'],
    ];

    for (const [root, baseSource] of roots) {
      if (!fs.existsSync(root)) continue;
      const files = fg.sync('**/SKILL.md', { cwd: root, absolute: true });
      for (const file of files) {
        const manifest = parseManifest(file, root, baseSource);
        if (manifest && !seen.has(manifest.name)) {
          seen.add(manifest.name);
          manifests.push(manifest);
        }
      }
    }

    // Shared sources are enumerated in sources.yaml order. Per-source
    // include / exclude globs are applied at discovery — a skill the
    // operator excluded never appears in the catalog.
    for (const source of this.sources) {
      const sourceDir = path.join(this.sharedMirrorRoot, source.name);
      if (!fs.existsSync(sourceDir)) continue;
      const files = fg.sync('**/SKILL.md', { cwd: sourceDir, absolute: true });
      for (const file of files) {
        const manifest = parseManifest(file, sourceDir, 'shared');
        if (!manifest) continue;
        if (!matchesFilters(manifest.name, source)) continue;
        if (seen.has(manifest.name)) continue;
        manifest.shareSourceName = source.name;
        seen.add(manifest.name);
        manifests.push(manifest);
      }
    }

    if (this.bundledDir && fs.existsSync(this.bundledDir)) {
      const files = fg.sync('**/SKILL.md', { cwd: this.bundledDir, absolute: true });
      for (const file of files) {
        const manifest = parseManifest(file, this.bundledDir, 'bundled');
        if (manifest && !seen.has(manifest.name)) {
          seen.add(manifest.name);
          manifests.push(manifest);
        }
      }
    }

    return manifests;
  }

  /** Returns a skill's full SKILL.md body (instructions), or null if not found. */
  load(name: string): string | null {
    const manifest = this.discover().find((m) => m.name === name);
    if (!manifest) return null;
    const raw = fs.readFileSync(manifest.file, 'utf8');
    return matter(raw).content.trim();
  }

  /** Where the SkillGenerator writes new skills. */
  generatedDir(): string {
    return path.join(this.globalSkillsDir, 'generated');
  }
}

function parseManifest(
  file: string,
  root: string,
  baseSource: SkillSource
): SkillManifest | null {
  let data: Record<string, unknown>;
  try {
    data = matter(fs.readFileSync(file, 'utf8')).data as Record<string, unknown>;
  } catch {
    return null;
  }
  const name = data.name;
  const description = data.description;
  if (typeof name !== 'string' || name.length === 0) return null;
  if (typeof description !== 'string' || description.length === 0) return null;

  // Within the global root, skills under generated/ are SkillGenerator output.
  const underGenerated = path
    .relative(root, file)
    .split(path.sep)
    .includes('generated');
  const source: SkillSource =
    baseSource === 'global' && underGenerated ? 'generated' : baseSource;

  const metadata = (data.metadata as Record<string, unknown>) ?? {};

  return {
    name,
    description,
    metadata,
    source,
    lifecycle: lifecycleOf(source, metadata),
    file,
  };
}

/**
 * Hand-authored skills (project/global/shared/bundled) are always 'active'.
 * Generated skills carry their lifecycle in metadata.lifecycle, defaulting
 * to 'candidate'.
 */
function lifecycleOf(
  source: SkillSource,
  metadata: Record<string, unknown>
): SkillLifecycle {
  if (source !== 'generated') return 'active';
  const lc = metadata.lifecycle;
  return lc === 'active' || lc === 'disabled' ? lc : 'candidate';
}

/**
 * Match a skill name against a source's include / exclude globs. Exclude
 * wins over include. An empty (or absent) include set means "include all";
 * an absent exclude set means "exclude nothing." Matches use minimatch so
 * `loom-*` and `**\/python-*` both work the same way the policy engine
 * already treats glob patterns.
 */
function matchesFilters(name: string, source: SkillSourceEntry): boolean {
  if (source.exclude && source.exclude.some((p) => minimatch(name, p))) {
    return false;
  }
  if (source.include && source.include.length > 0) {
    return source.include.some((p) => minimatch(name, p));
  }
  return true;
}

/**
 * Wrap SourcesConfig.load so a malformed sources.yaml doesn't crash every
 * SkillStore caller. Discovery just skips shared sources when the config
 * is unreadable — the operator already gets a real error from `loom
 * skills sync` which is where they'd notice the breakage.
 */
function safeLoadSources(): SourcesConfig {
  try {
    return SourcesConfig.load();
  } catch {
    return new SourcesConfig([], '');
  }
}
