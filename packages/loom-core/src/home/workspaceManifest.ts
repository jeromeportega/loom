import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import yaml from 'js-yaml';
import { z } from 'zod';
import { computeRepoSlug } from './repoSlug.js';
import { withDirLock } from './dirLock.js';

// ─── Types & schema ───────────────────────────────────────────────────────────

export interface ManifestEntry {
  slug: string;               // computeRepoSlug().slug — canonical identity & primary key
  path: string;               // fs.realpathSync(projectRoot)
  remote_url: string | null;  // computeRepoSlug().remoteUrl
  primary?: boolean;          // at most one entry true per manifest
}

export interface WorkspaceManifest {
  version: 1;
  repos: ManifestEntry[];     // slug unique across the array — no two entries share a slug
}

const ManifestEntrySchema = z.object({
  slug: z.string().min(1),
  path: z.string().min(1),
  // Accept omitted field (hand-edited manifests) and coerce to null.
  remote_url: z.string().nullable().optional().default(null),
  primary: z.boolean().optional(),
});

export const WorkspaceManifestSchema = z.object({
  version: z.literal(1),
  repos: z.array(ManifestEntrySchema).default([]),
});

// ─── API ──────────────────────────────────────────────────────────────────────

/** Absolute path to the manifest file. */
export function manifestPath(loomHome: string): string {
  return path.join(loomHome, 'workspace.yaml');
}

/** Read + Zod-validate. Returns { version: 1, repos: [] } if the file is absent. */
export function readManifest(loomHome: string): WorkspaceManifest {
  const p = manifestPath(loomHome);
  let raw: unknown;
  try {
    raw = yaml.load(fs.readFileSync(p, 'utf8'));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return { version: 1, repos: [] };
    }
    throw err;
  }
  return WorkspaceManifestSchema.parse(raw ?? {});
}

/**
 * Idempotently register a repo by its canonical slug.
 * Computes identity via computeRepoSlug(projectRoot). If no entry with that slug
 * exists, appends one and persists under the manifest lock; if present, returns the
 * existing entry unchanged (no-op write). Returns the resolved entry either way.
 */
export function registerRepo(loomHome: string, projectRoot: string): ManifestEntry {
  return withDirLock(loomHome, '.manifest.lock', () => {
    const manifest = readManifest(loomHome);
    const { slug, remoteUrl } = computeRepoSlug(projectRoot);

    const existing = manifest.repos.find(r => r.slug === slug);
    if (existing) return existing;

    const realPath = (() => {
      try { return fs.realpathSync(projectRoot); } catch { return projectRoot; }
    })();

    const entry: ManifestEntry = {
      slug,
      path: realPath,
      remote_url: remoteUrl,
    };

    const updated: WorkspaceManifest = {
      version: 1,
      repos: [...manifest.repos, entry],
    };

    // Persist via temp-file-then-rename for atomicity.
    const p = manifestPath(loomHome);
    const tmp = `${p}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
    fs.writeFileSync(tmp, yaml.dump(updated, { lineWidth: 120, noRefs: true }), 'utf8');
    try {
      fs.renameSync(tmp, p);
    } catch (err) {
      try { fs.unlinkSync(tmp); } catch { /* best-effort cleanup */ }
      throw err;
    }

    return entry;
  });
}
