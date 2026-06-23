import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { defaultRemote, gitSafe, remoteUrl } from '../orchestrator/git.js';
import type { Provenance } from './types.js';

const ARTIFACT_MAP: Array<{ key: keyof ArtifactSources; dest: string }> = [
  { key: 'brief', dest: 'project-brief.md' },
  { key: 'prd', dest: 'prd.md' },
  { key: 'architecture', dest: 'architecture.md' },
  { key: 'epicYaml', dest: 'epic.yaml' },
];

type ArtifactSources = {
  brief?: string;
  prd?: string;
  architecture?: string;
  epicYaml?: string;
};

function sanitizeName(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function computeRepoSlug(projectRoot: string): { slug: string; remoteUrlValue: string | null } {
  const remote = defaultRemote(projectRoot);
  const url = remote ? remoteUrl(projectRoot, remote) : null;
  const hashInput = url ?? projectRoot;
  const hash = crypto.createHash('sha256').update(hashInput).digest('hex').slice(0, 8);
  const name = sanitizeName(path.basename(projectRoot));
  return { slug: `${name}-${hash}`, remoteUrlValue: url };
}

export function routeArtifacts(input: {
  loomHomePath: string;
  projectRoot: string;
  epicId: string;
  runId: string;
  artifactSources: ArtifactSources;
  clock?: () => string;
}): { artifactDir: string; relDir: string; provenance: Provenance } {
  const { loomHomePath, projectRoot, epicId, runId, artifactSources } = input;
  const now = input.clock ? input.clock() : new Date().toISOString();

  const { slug, remoteUrlValue } = computeRepoSlug(projectRoot);

  const relDir = path.join('repos', slug, epicId);
  const artifactDir = path.join(loomHomePath, relDir);
  fs.mkdirSync(artifactDir, { recursive: true });

  for (const { key, dest } of ARTIFACT_MAP) {
    const src = artifactSources[key];
    if (src !== undefined && fs.existsSync(src)) {
      fs.copyFileSync(src, path.join(artifactDir, dest));
    }
  }

  const headRes = gitSafe(projectRoot, ['rev-parse', 'HEAD']);
  const target_head_sha = headRes.ok && headRes.output.length > 0 ? headRes.output : null;

  const provenance: Provenance = {
    loom_home_schema: 1,
    target_repo: {
      name: path.basename(projectRoot),
      path: projectRoot,
      remote_url: remoteUrlValue,
      slug,
    },
    epic_id: epicId,
    run_id: runId,
    target_head_sha,
    created_at: now,
  };

  fs.writeFileSync(
    path.join(artifactDir, 'provenance.json'),
    JSON.stringify(provenance, null, 2),
    'utf8',
  );

  return { artifactDir, relDir, provenance };
}
